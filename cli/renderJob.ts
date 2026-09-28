/**
 * Lõi render dùng chung cho `npm run render` (1 project) và `npm run batch` (nhiều video).
 *
 *   createRenderEnv()  → 1 Vite dev server + 1 Chromium, tái sử dụng cho mọi job
 *   prepareScene()     → resolve (TTS, sync, duration auto) + validate, KHÔNG cần trình duyệt
 *   renderScene()      → frame (trang Chromium riêng) → loudnorm → phụ đề → FFmpeg → MP4
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { computeAudioSegments, computeDucking, type AudioSegment, type Ducking } from "../src/engine/AudioTimeline";
import { buildSrt } from "../src/engine/Subtitles";
import { RegistrySchema, type Registry } from "../src/schemas/asset.schema";
import type { SceneScript } from "../src/schemas/scene.schema";
import type { RenderLoadResult, RenderQuality } from "../src/render/types";
import { needsResolve, resolveScene, type Synthesize } from "../src/tts/resolveScene";
import { collectAttributions, validateScene } from "../src/validation/validateScene";
import { createPiperTts } from "../server/tts/piperTts";
import { buildEncodeArgs, buildLoudnessMeasureArgs, frameFileName, parseLoudnessMeasure, runFfmpeg, type EncodeAudio } from "./ffmpeg";

export const ROOT = resolve(import.meta.dirname, "..");
const ASSETS_DIR = join(ROOT, "public", "assets");
const FRAME_TIMEOUT_MS = 30_000;
/** Tăng khi đổi pipeline render để vô hiệu cơ chế bỏ qua video không đổi. */
const RENDER_VERSION = 4;

export type RenderStatus = "Pending" | "Processing" | "Completed" | "Failed" | "Cancelled";

export interface RenderRecord {
  id: string;
  project: string;
  status: RenderStatus;
  progress: number;
  currentFrame: number;
  totalFrames: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  output: string;
  /** Hash của scene đã resolve + thông số → bỏ qua khi render lại mà không đổi gì. */
  sceneHash?: string;
  gpu?: string;
  audioTracks: number;
  dialogueLines: number;
  loudness?: { target: number; measuredI: number } | { target: null };
  error?: { code: string; message: string; issues?: unknown[] };
  /** Chỉ có ở movie: từng cảnh (mốc thời gian trong phim, clip có dùng lại cache hay không). */
  scenes?: { id: string; start: number; duration: number; transition: string; cached: boolean }[];
  startedAt: string;
  completedAt?: string;
  elapsedSeconds?: number;
}

export class RenderFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
  }
}

export type Logger = (msg: string) => void;

export interface RenderEnv {
  registry: Registry;
  tts: Synthesize;
  /** Mở trình duyệt khi cần (job đầu tiên), dùng chung cho các job sau. */
  browser(): Promise<{ browser: Browser; baseUrl: string }>;
  /** Chất lượng hậu kỳ thực tế (auto → high nếu GPU, standard nếu CPU). */
  quality(): Promise<RenderQuality>;
  close(): Promise<void>;
}

export async function loadRegistryFile(): Promise<Registry> {
  return RegistrySchema.parse(JSON.parse(await readFile(join(ASSETS_DIR, "registry.json"), "utf8")));
}

/** auto = thử GPU, không được thì dùng CPU; gpu = bắt buộc GPU; cpu = SwiftShader (phần mềm, chậm nhưng chạy mọi nơi). */
export type RendererMode = "auto" | "gpu" | "cpu";
export const RENDERER_MODES: readonly RendererMode[] = ["auto", "gpu", "cpu"];

const CPU_ARGS = ["--ignore-gpu-blocklist", "--enable-webgl", "--enable-unsafe-swiftshader"];

/** Backend ANGLE dùng GPU thật theo hệ điều hành. */
function gpuArgs(): string[] {
  const angle = process.platform === "win32" ? "d3d11" : process.platform === "darwin" ? "metal" : "gl";
  return ["--use-angle=" + angle, "--enable-gpu", "--ignore-gpu-blocklist", "--enable-webgl"];
}

export function parseRendererMode(v: string | undefined): RendererMode {
  const mode = (v ?? process.env.AC_RENDERER ?? "auto").toLowerCase();
  if (!(RENDERER_MODES as readonly string[]).includes(mode)) throw new RenderFailure("RenderSetupFailed", `--renderer phải là ${RENDERER_MODES.join(" | ")} (nhận "${mode}")`);
  return mode as RendererMode;
}

/** Tên bộ render WebGL mà trình duyệt thực sự dùng (SwiftShader = CPU). */
async function webglRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return "";
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
  } finally {
    await page.close();
  }
}

export const isSoftwareRenderer = (name: string) => !name || /swiftshader|llvmpipe|software/i.test(name);

async function launchBrowser(launch: (args: string[]) => Promise<Browser>, mode: RendererMode, log: Logger): Promise<{ browser: Browser; gpu: boolean }> {
  if (mode !== "cpu") {
    try {
      const b = await launch(gpuArgs());
      const name = await webglRenderer(b);
      if (!isSoftwareRenderer(name)) {
        log(`Render bằng GPU: ${name}`);
        return { browser: b, gpu: true };
      }
      await b.close();
      if (mode === "gpu") throw new RenderFailure("RenderSetupFailed", `Không dùng được GPU (WebGL: ${name || "không có"}). Chạy lại với --renderer cpu`);
      log("Không có GPU cho WebGL → render bằng CPU");
    } catch (err) {
      if (mode === "gpu" || err instanceof RenderFailure) throw err;
      log(`Không mở được trình duyệt GPU (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) → render bằng CPU`);
    }
  }
  const b = await launch(CPU_ARGS);
  if (mode === "cpu") log("Render bằng CPU (SwiftShader)");
  return { browser: b, gpu: false };
}

export type QualityMode = "auto" | RenderQuality;

export function parseQualityMode(v: string | undefined): QualityMode {
  const q = (v ?? process.env.AC_QUALITY ?? "auto").toLowerCase();
  if (!["auto", "high", "standard"].includes(q)) throw new RenderFailure("RenderSetupFailed", `--quality phải là auto | high | standard (nhận "${q}")`);
  return q as QualityMode;
}

export async function createRenderEnv(options: { browser?: string; renderer?: RendererMode; quality?: QualityMode; log?: Logger } = {}): Promise<RenderEnv> {
  const registry = await loadRegistryFile();
  const tts = createPiperTts();
  const mode = options.renderer ?? parseRendererMode(undefined);
  const log = options.log ?? (() => undefined);
  const qualityMode = options.quality ?? parseQualityMode(undefined);
  let started: Promise<{ server: ViteDevServer; browser: Browser; baseUrl: string; gpu: boolean }> | undefined;

  const start = async () => {
    const server = await createServer({
      root: ROOT,
      configFile: join(ROOT, "vite.config.ts"),
      logLevel: "error",
      server: { port: 5190, strictPort: false, host: "127.0.0.1" },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new RenderFailure("RenderSetupFailed", "Không khởi động được dev server");
    const channel = !options.browser || options.browser === "chromium" ? undefined : options.browser;
    const launch = (args: string[]) => chromium.launch({ channel, headless: true, args });

    try {
      const launched = await launchBrowser(launch, mode, log);
      return { server, browser: launched.browser, gpu: launched.gpu, baseUrl };
    } catch (err) {
      await server.close().catch(() => undefined);
      throw err;
    }
  };

  return {
    registry,
    tts,
    async browser() {
      started ??= start();
      const { browser, baseUrl } = await started;
      return { browser, baseUrl };
    },
    async quality() {
      if (qualityMode !== "auto") return qualityMode;
      started ??= start();
      return (await started).gpu ? "high" : "standard";
    },
    async close() {
      if (!started) return;
      const s = await started.catch(() => undefined);
      await s?.browser.close().catch(() => undefined);
      await s?.server.close().catch(() => undefined);
    },
  };
}

export interface SceneOverrides {
  width?: number;
  height?: number;
  fps?: number;
}

export interface PreparedScene {
  /** JSON đã resolve (gửi vào trang render). */
  input: unknown;
  scene: SceneScript;
  synthesized: number;
}

/** Resolve + validate. Ném RenderFailure("InvalidSceneScript") kèm danh sách lỗi. */
export async function prepareScene(env: RenderEnv, raw: unknown, overrides: SceneOverrides = {}, log: Logger = () => undefined): Promise<PreparedScene> {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const meta = { ...((obj.meta as Record<string, unknown> | undefined) ?? {}) };
  if (overrides.width) meta.width = overrides.width;
  if (overrides.height) meta.height = overrides.height;
  if (overrides.fps) meta.fps = overrides.fps;

  let input: unknown = { ...obj, meta };
  let synthesized = 0;
  if (needsResolve(input)) {
    const resolved = await resolveScene(input, env.registry, env.tts);
    if (resolved.issues.length) {
      throw new RenderFailure("InvalidSceneScript", resolved.issues.map((i) => `${i.code}: ${i.message}${i.path ? ` @ ${i.path}` : ""}`).join("\n"), resolved.issues);
    }
    input = resolved.scene;
    synthesized = resolved.synthesized;
    if (synthesized) log(`TTS: ${synthesized} câu sinh mới`);
  }

  const validated = validateScene(input, env.registry);
  if (!validated.ok) {
    throw new RenderFailure("InvalidSceneScript", validated.issues.map((i) => `${i.code}: ${i.message}${i.path ? ` @ ${i.path}` : ""}`).join("\n"), validated.issues);
  }
  return { input, scene: validated.scene, synthesized };
}

export interface RenderOptions {
  projectId: string;
  /** Đường dẫn MP4 đầu ra; record = <base>.render.json, phụ đề = <base>.srt. */
  output: string;
  crf?: number;
  keepFrames?: boolean;
  /** Bỏ qua nếu đã render thành công với cùng scene + thông số. */
  skipUnchanged?: boolean;
  /** Chỉ xuất hình (clip của một cảnh trong movie): bỏ audio, phụ đề mềm, attributions. */
  videoOnly?: boolean;
  preset?: string;
  isCancelled?: () => boolean;
  onFrame?: (current: number, total: number) => void;
  log?: Logger;
}

export interface RenderOutcome {
  record: RenderRecord;
  skipped: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderFailure("RenderTimeout", `${what} quá ${ms / 1000}s`)), ms);
    }),
  ]);
}

export function sceneHash(prepared: PreparedScene, crf: number | undefined, variant?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: RENDER_VERSION, crf: crf ?? null, variant: variant ?? null, scene: prepared.scene }))
    .digest("hex")
    .slice(0, 16);
}

export async function checkAudioFiles(segments: readonly AudioSegment[]): Promise<void> {
  for (const seg of segments) {
    await access(join(ASSETS_DIR, seg.file)).catch(() => {
      throw new RenderFailure("AssetLoadFailed", `Không tìm thấy file audio ${seg.file} (track "${seg.id}")`);
    });
  }
}

/** Chuẩn bị audio để encode: đo độ to (loudnorm pass 1) nếu có mục tiêu LUFS; ghi kết quả vào record. */
export async function mixAudio(
  segments: AudioSegment[],
  duration: number,
  ducking: Ducking | undefined,
  target: number | null,
  record: RenderRecord,
  log: Logger,
): Promise<EncodeAudio> {
  const audio: EncodeAudio = { segments, duration, assetsDir: ASSETS_DIR, ducking };
  if (segments.length && target !== null) {
    try {
      const measured = parseLoudnessMeasure(await runFfmpeg(buildLoudnessMeasureArgs({ ...audio, loudness: target })));
      audio.loudness = target;
      audio.measured = measured;
      record.loudness = { target, measuredI: Number(measured.input_i) };
      log(`Độ to: ${measured.input_i} LUFS → ${target} LUFS`);
    } catch (err) {
      log(`Bỏ qua chuẩn hóa độ to: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    record.loudness = { target: null };
  }
  return audio;
}

/** Render một scene đã prepare. Không ném lỗi: trạng thái nằm trong record (Completed/Failed/Cancelled). */
export async function renderScene(env: RenderEnv, prepared: PreparedScene, o: RenderOptions): Promise<RenderOutcome> {
  const log = o.log ?? (() => undefined);
  const { scene } = prepared;
  const base = o.output.replace(/\.mp4$/i, "");
  const recordPath = `${base}.render.json`;
  const quality = await env.quality();
  const hash = sceneHash(prepared, o.crf, `${quality}${o.videoOnly ? `:video:${o.preset ?? ""}` : ""}`);

  if (o.skipUnchanged) {
    try {
      const prev = JSON.parse(await readFile(recordPath, "utf8")) as RenderRecord;
      await access(o.output);
      if (prev.status === "Completed" && prev.sceneHash === hash) return { record: prev, skipped: true };
    } catch {
      // chưa có bản render trước
    }
  }

  const started = Date.now();
  const renderId = new Date(started).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const framesDir = join(ROOT, "storage", "temp", `${o.projectId.replace(/[/]/g, "-")}_${renderId}_${randomUUID().slice(0, 8)}`);
  const record: RenderRecord = {
    id: renderId,
    project: o.projectId,
    status: "Pending",
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    width: scene.meta.width,
    height: scene.meta.height,
    fps: scene.meta.fps,
    duration: scene.meta.duration,
    output: relative(ROOT, o.output).replaceAll("\\", "/"),
    sceneHash: hash,
    audioTracks: 0,
    dialogueLines: scene.dialogue.length,
    startedAt: new Date(started).toISOString(),
  };

  await mkdir(dirname(o.output), { recursive: true });
  let lastSave = 0;
  const save = async (force = false) => {
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  };
  await save(true);

  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    // Audio: đoạn phát + kiểm tra file tồn tại trước khi render frame.
    const audioSegments = o.videoOnly ? [] : computeAudioSegments(scene, env.registry);
    await checkAudioFiles(audioSegments);
    record.audioTracks = audioSegments.length;

    const { browser, baseUrl } = await env.browser();
    page = await browser.newPage({ viewport: { width: scene.meta.width, height: scene.meta.height }, deviceScaleFactor: 1 });
    page.on("pageerror", (err) => log(`Lỗi trang: ${err.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") log(`Console: ${m.text()}`);
    });
    await page.goto(new URL("render.html", baseUrl).href);
    await page.waitForFunction(() => window.__AC_READY__ === true, undefined, { timeout: 60_000 });

    const loaded = await withTimeout(
      page.evaluate(([s, q]) => window.__AC_RENDER__!.load(s, { quality: q }), [prepared.input, quality] as const) as Promise<RenderLoadResult>,
      120_000,
      "Load scene",
    );
    if (!loaded.ok) {
      throw new RenderFailure("InvalidSceneScript", loaded.issues.map((i) => `${i.code}: ${i.message}`).join("\n"), loaded.issues);
    }
    record.status = "Processing";
    record.totalFrames = loaded.totalFrames;
    record.gpu = loaded.gpu;
    await save(true);
    log(`${scene.meta.width}x${scene.meta.height} @${scene.meta.fps}fps, ${loaded.totalFrames} frame · WebGL: ${loaded.gpu}`);

    // Frame với fixed timestep.
    await mkdir(framesDir, { recursive: true });
    const frameStart = Date.now();
    const writes: Promise<void>[] = [];
    for (let i = 0; i < loaded.totalFrames; i++) {
      if (o.isCancelled?.()) throw new RenderFailure("Cancelled", "Người dùng hủy");
      const b64 = await withTimeout(page.evaluate((idx) => window.__AC_RENDER__!.renderFrame(idx), i), FRAME_TIMEOUT_MS, `Frame ${i + 1}`);
      writes.push(writeFile(join(framesDir, frameFileName(i)), Buffer.from(b64, "base64")));
      if (writes.length >= 16) await Promise.all(writes.splice(0));
      record.currentFrame = i + 1;
      o.onFrame?.(i + 1, loaded.totalFrames);
      record.progress = Math.round(((i + 1) / loaded.totalFrames) * 95);
      await save();
      if ((i + 1) % 60 === 0 || i + 1 === loaded.totalFrames) {
        const rate = (i + 1) / ((Date.now() - frameStart) / 1000);
        log(`Frame ${i + 1}/${loaded.totalFrames} (${record.progress}%) – ${rate.toFixed(1)} frame/s`);
      }
    }
    await Promise.all(writes);
    await page.close();
    page = undefined;

    if (o.videoOnly) {
      await runFfmpeg(buildEncodeArgs({ framesDir, fps: scene.meta.fps, output: o.output, crf: o.crf, preset: o.preset }));
    } else {
      // Audio: ducking + chuẩn hóa độ to (loudnorm 2 pass).
      const audio = await mixAudio(audioSegments, scene.meta.duration, computeDucking(scene, audioSegments), scene.mix.loudness, record, log);

      // Phụ đề: .srt cạnh MP4 + track phụ đề mềm.
      let subtitlesFile: string | undefined;
      if (scene.dialogue.some((l) => l.subtitle)) {
        subtitlesFile = `${base}.srt`;
        await writeFile(subtitlesFile, buildSrt(scene), "utf8");
      }

      await runFfmpeg(buildEncodeArgs({ framesDir, fps: scene.meta.fps, output: o.output, crf: o.crf, preset: o.preset, audio, subtitlesFile }));
      await writeFile(`${base}.ATTRIBUTIONS.txt`, `${collectAttributions(scene, env.registry).join("\n")}\n`, "utf8");
    }

    record.status = "Completed";
    record.progress = 100;
  } catch (err) {
    const code = err instanceof RenderFailure ? err.code : err instanceof Error && "code" in err ? String(err.code) : "RenderFailed";
    record.status = code === "Cancelled" ? "Cancelled" : "Failed";
    record.error = { code, message: err instanceof Error ? err.message : String(err), issues: err instanceof RenderFailure ? err.issues : undefined };
  } finally {
    await page?.close().catch(() => undefined);
    record.completedAt = new Date().toISOString();
    record.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
    await save(true).catch(() => undefined);
    if (!o.keepFrames) await rm(framesDir, { recursive: true, force: true });
    else log(`Giữ frame tại ${framesDir}`);
  }
  return { record, skipped: false };
}

/** Ghi render.json trạng thái Failed khi lỗi xảy ra trước khi render (vd. scene không hợp lệ). */
export async function writeFailureRecord(projectId: string, output: string, err: unknown): Promise<RenderRecord> {
  const now = new Date().toISOString();
  const record: RenderRecord = {
    id: now.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19),
    project: projectId,
    status: "Failed",
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    width: 0,
    height: 0,
    fps: 0,
    duration: 0,
    output: relative(ROOT, output).replaceAll("\\", "/"),
    audioTracks: 0,
    dialogueLines: 0,
    error: {
      code: err instanceof RenderFailure ? err.code : "RenderFailed",
      message: err instanceof Error ? err.message : String(err),
      issues: err instanceof RenderFailure ? err.issues : undefined,
    },
    startedAt: now,
    completedAt: now,
    elapsedSeconds: 0,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output.replace(/\.mp4$/i, "")}.render.json`, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}
