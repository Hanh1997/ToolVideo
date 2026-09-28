import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Synthesize, TtsRequest, TtsResult } from "../../src/tts/resolveScene";
import { runFfmpeg } from "../../cli/ffmpeg";
import { envelopeFromPcm } from "../../src/engine/Speech";

const ROOT = resolve(import.meta.dirname, "../..");
/** Tăng khi đổi cách sinh để vô hiệu cache cũ. */
const CACHE_VERSION = 1;

export interface PiperOptions {
  piperBin?: string;
  voicesDir?: string;
  /** Thư mục cache (nằm trong public/assets để preview phát được). */
  cacheDir?: string;
  /** Tiền tố đường dẫn tương đối với /assets/ tương ứng cacheDir. */
  assetPrefix?: string;
  timeoutMs?: number;
  /** Số tiến trình Piper chạy song song (mỗi tiến trình nạp model ~60MB). */
  concurrency?: number;
}

export function defaultPiperBin(): string {
  if (process.env.PIPER_BIN) return process.env.PIPER_BIN;
  return process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "piper.exe") : join(ROOT, ".venv", "bin", "piper");
}

/** Độ dài WAV PCM (giây) từ header: kích thước chunk data / byteRate. */
export async function wavDuration(path: string): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path} không phải WAV`);
    let byteRate = 0;
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(offset + 16);
      if (id === "data") {
        if (!byteRate) throw new Error(`${path}: thiếu chunk fmt`);
        return Math.round((size / byteRate) * 1000) / 1000;
      }
      offset += 8 + size + (size % 2);
    }
    throw new Error(`${path}: không tìm thấy chunk data`);
  } finally {
    await fh.close();
  }
}

/** Envelope độ to của WAV PCM 16-bit (trộn về mono) – xem envelopeFromPcm. */
export async function wavEnvelope(path: string): Promise<number[]> {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return [];
  let channels = 1;
  let rate = 22050;
  let bits = 16;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      if (bits !== 16) return [];
      const frames = Math.floor(Math.min(size, buf.length - offset - 8) / (2 * channels));
      const pcm = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += buf.readInt16LE(offset + 8 + (i * channels + c) * 2);
        pcm[i] = v / channels / 32768;
      }
      return envelopeFromPcm(pcm, rate);
    }
    offset += 8 + size + (size % 2);
  }
  return [];
}

function cacheKey(req: TtsRequest): string {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    provider: req.voice.provider,
    model: req.voice.file,
    speaker: req.voice.speaker ?? 0,
    pitch: req.voice.pitch ?? 0,
    rate: req.rate,
    text: req.text.normalize("NFC").trim(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    // PYTHONUTF8: Piper đọc file văn bản UTF-8 đúng trên Windows.
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Piper quá ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được Piper (${bin}): ${err.message}. Cài: python -m venv .venv && .venv/Scripts/pip install piper-tts`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`Piper thoát mã ${String(code)}: ${stderr.trim()}`));
    });
  });
}

/**
 * TTS offline bằng Piper. Cache theo hash(text + giọng + tốc độ): đã sinh một lần thì
 * mọi lần render sau dùng lại đúng file → video tái lập được (Piper tự thân không tất định).
 */
export function createPiperTts(options: PiperOptions = {}): Synthesize {
  const bin = options.piperBin ?? defaultPiperBin();
  const voicesDir = options.voicesDir ?? join(ROOT, "tools", "tts-voices");
  const cacheDir = options.cacheDir ?? join(ROOT, "public", "assets", "tts");
  const prefix = options.assetPrefix ?? "tts/";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const inflight = new Map<string, Promise<TtsResult>>();
  let running = 0;
  const queue: (() => void)[] = [];
  const limit = Math.max(1, options.concurrency ?? 2);
  const acquire = () =>
    new Promise<void>((ok) => {
      if (running < limit) {
        running++;
        ok();
      } else queue.push(() => { running++; ok(); });
    });
  const release = () => {
    running--;
    queue.shift()?.();
  };

  return (req) => {
    if (req.voice.provider !== "piper") return Promise.reject(new Error(`Provider "${String(req.voice.provider)}" chưa hỗ trợ`));
    const key = cacheKey(req);
    const existing = inflight.get(key);
    if (existing) return existing;

    const job = (async (): Promise<TtsResult> => {
      const name = `${key}.wav`;
      const out = join(cacheDir, name);
      if (existsSync(out)) return { file: prefix + name, duration: await wavDuration(out), envelope: await wavEnvelope(out), cached: true };

      const model = join(voicesDir, req.voice.file);
      if (!existsSync(model)) throw new Error(`Không có model giọng ${model}`);
      await mkdir(cacheDir, { recursive: true });
      const textFile = join(cacheDir, `${key}.txt`);
      const tmp = join(cacheDir, `${key}.tmp.wav`);
      await writeFile(textFile, req.text.normalize("NFC").trim(), "utf8");
      try {
        const args = ["-m", model, "-i", textFile, "-f", tmp, "--length-scale", String(Math.round((1 / req.rate) * 1000) / 1000)];
        if (req.voice.speaker !== undefined) args.push("-s", String(req.voice.speaker));
        await acquire();
        try {
          await run(bin, args, timeoutMs);
        } finally {
          release();
        }
        const pitch = req.voice.pitch ?? 0;
        if (pitch !== 0) {
          // Đổi cao độ, giữ nguyên tốc độ nói (rubberband). Formant dịch theo → giọng hoạt hình.
          const factor = Math.round(2 ** (pitch / 12) * 10000) / 10000;
          await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", tmp, "-af", `rubberband=pitch=${factor}:pitchq=quality`, "-c:a", "pcm_s16le", out]);
        } else {
          await rename(tmp, out);
        }
        // Lưu văn bản gốc cạnh file để tra cứu.
        await writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ text: req.text, voice: req.voice.id, rate: req.rate, pitch: req.voice.pitch ?? 0 }, null, 2));
      } finally {
        await rm(textFile, { force: true });
        await rm(tmp, { force: true });
      }
      return { file: prefix + name, duration: await wavDuration(out), envelope: await wavEnvelope(out), cached: false };
    })().finally(() => inflight.delete(key));

    inflight.set(key, job);
    return job;
  };
}

/** Đọc Registry từ đĩa (dùng cho CLI và dev server). */
export async function readRegistryFile(): Promise<unknown> {
  return JSON.parse(await readFile(join(ROOT, "public", "assets", "registry.json"), "utf8"));
}
