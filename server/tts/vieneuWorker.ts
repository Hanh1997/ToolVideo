import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

/**
 * Tiến trình VieNeu-TTS chạy nền (tools/vieneu/server.py, Python trong .venv): nạp model một lần,
 * đọc lần lượt từng câu (model ~0.5 GB – một tiến trình cho cả phiên).
 */

const ROOT = resolve(import.meta.dirname, "../..");

export function defaultPython(): string {
  if (process.env.VIENEU_PYTHON) return process.env.VIENEU_PYTHON;
  return process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
}

export class VieneuWorker {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private stderr = "";

  constructor(private readonly python = defaultPython()) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((ok, fail) => {
      const child = spawn(this.python, [join(ROOT, "tools", "vieneu", "server.py")], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      this.child = child;
      child.stderr!.on("data", (d: Buffer) => {
        this.stderr = (this.stderr + d.toString()).slice(-3000);
      });
      child.on("error", (err) => fail(new Error(`Không chạy được VieNeu (${this.python}): ${err.message}. Cài: .venv/Scripts/pip install vieneu`)));
      child.on("close", (code) => {
        const err = new Error(`VieNeu thoát (mã ${String(code)}): ${this.stderr.trim().split("\n").slice(-5).join(" | ")}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.child = undefined;
        this.ready = undefined;
        fail(err);
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (!line.startsWith("@@")) return;
        let msg: { id?: string; ok?: boolean; error?: string };
        try {
          msg = JSON.parse(line.slice(2));
        } catch {
          return;
        }
        if (msg.id === "ready") return ok();
        const p = msg.id ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id!);
        if (msg.ok) p.resolve();
        else p.reject(new Error(`VieNeu: ${msg.error ?? "lỗi không rõ"}`));
      });
    });
    return this.ready;
  }

  /** Đọc `text` bằng giọng mẫu `voice` → WAV 48 kHz tại `out`. */
  async synthesize(text: string, voice: string, out: string, seed: number, timeoutMs: number): Promise<void> {
    await this.start();
    const id = String(++this.seq);
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`VieNeu quá ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          ok();
        },
        reject: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.child!.stdin!.write(`${JSON.stringify({ id, text, voice, out, seed })}\n`);
    });
  }

  close(): void {
    this.child?.stdin?.end();
    this.child?.kill();
  }
}
