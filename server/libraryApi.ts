/**
 * API cho giao diện Thư viện (chạy trong Vite dev server, chỉ localhost):
 *
 *   GET    /api/videos                      danh sách video (projects/*\/renders, batches/*\/videos)
 *   GET    /api/videos/thumb?path=          ảnh thu nhỏ (FFmpeg, cache storage/thumbs)
 *   GET    /api/videos/vtt?path=            phụ đề WebVTT từ .srt
 *   DELETE /api/videos?path=                xóa video + file kèm (.srt, .render.json, .ATTRIBUTIONS.txt)
 *   POST   /api/open-folder {path}          mở thư mục chứa file trong Explorer/Finder
 *   GET    /media/<path>                    phát/tải file (hỗ trợ Range để tua video)
 *
 *   POST   /api/assets/import?...           upload .glb/.gltf/.fbx (body thô, header X-Filename)
 *   PATCH  /api/assets/:id                  sửa tên, chiều cao, hướng, license…
 *   POST   /api/tts/preview {voice,text}    nghe thử giọng đọc
 *
 *   GET    /api/templates                   template + dữ liệu CSV + báo cáo batch
 *   PUT    /api/templates/:id/data          lưu dữ liệu CSV
 *   POST   /api/batch                       chạy batch (1 job tại một thời điểm)
 *   GET    /api/batch/current               trạng thái + log + báo cáo
 *   POST   /api/batch/cancel
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { findAsset } from "../src/schemas/asset.schema";
import { parseCsv, parseCsvRows } from "../src/template/csv";
import { TemplateSchema } from "../src/template/template";
import type { Synthesize } from "../src/tts/resolveScene";
import { runFfmpeg } from "../cli/ffmpeg";
import { importAssets, readRegistry, updateAsset, type ImportableType } from "./assets/importAsset";
import { contentType, parseRange, safeResolve, srtToVtt, toCsv, toPosix } from "./libraryUtils";
import { createPiperTts } from "./tts/piperTts";

const ROOT = resolve(import.meta.dirname, "..");
const MEDIA_DIRS = ["projects", "batches"] as const;
const THUMBS = join(ROOT, "storage", "thumbs");
const UPLOADS = join(ROOT, "storage", "uploads");
const MAX_UPLOAD = 200 * 1024 * 1024;

// ---------------------------------------------------------------- tiện ích HTTP

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: message });
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`File quá lớn (> ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString("utf8")) as T;
}

function handler(fn: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    fn(req, res, url)
      .then((handled) => {
        if (handled === false) next();
      })
      .catch((err: unknown) => {
        if (!res.headersSent) fail(res, 500, err instanceof Error ? err.message : String(err));
      });
  };
}

// ---------------------------------------------------------------- video

export interface VideoEntry {
  path: string;
  name: string;
  source: { kind: "project" | "batch"; id: string };
  project?: string;
  status: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  sizeBytes?: number;
  modifiedAt: string;
  elapsedSeconds?: number;
  hasSubtitles: boolean;
  error?: string;
  exists: boolean;
  loudness?: number;
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function collectVideos(): Promise<VideoEntry[]> {
  const places: { dir: string; kind: "project" | "batch"; id: string }[] = [];
  for (const p of await listDir(join(ROOT, "projects"))) places.push({ dir: join(ROOT, "projects", p, "renders"), kind: "project", id: p });
  for (const b of await listDir(join(ROOT, "batches"))) places.push({ dir: join(ROOT, "batches", b, "videos"), kind: "batch", id: b });

  const out: VideoEntry[] = [];
  for (const place of places) {
    const files = await listDir(place.dir);
    const bases = new Set<string>();
    for (const f of files) {
      if (f.endsWith(".mp4")) bases.add(f.slice(0, -4));
      else if (f.endsWith(".render.json")) bases.add(f.slice(0, -".render.json".length));
    }
    for (const base of bases) {
      const mp4 = join(place.dir, `${base}.mp4`);
      const exists = files.includes(`${base}.mp4`);
      let record: Record<string, unknown> = {};
      try {
        record = JSON.parse(await readFile(join(place.dir, `${base}.render.json`), "utf8")) as Record<string, unknown>;
      } catch {
        // video không có render.json (vd. render thủ công)
      }
      // Bỏ các render.json lỗi cũ khi đã có video thành công khác cùng tên.
      if (!exists && record.status !== "Failed" && record.status !== "Processing") continue;
      const st = exists ? await stat(mp4) : undefined;
      const err = record.error as { code?: string; message?: string } | undefined;
      const loud = record.loudness as { measuredI?: number } | undefined;
      out.push({
        path: toPosix(join(place.dir, `${base}.mp4`).slice(ROOT.length + 1)),
        name: base,
        source: { kind: place.kind, id: place.id },
        project: typeof record.project === "string" ? record.project : place.kind === "project" ? place.id : undefined,
        status: exists ? String(record.status ?? "Completed") : String(record.status ?? "Failed"),
        width: typeof record.width === "number" ? record.width : undefined,
        height: typeof record.height === "number" ? record.height : undefined,
        fps: typeof record.fps === "number" ? record.fps : undefined,
        duration: typeof record.duration === "number" && record.duration > 0 ? record.duration : undefined,
        sizeBytes: st?.size,
        modifiedAt: (st?.mtime ?? new Date(String(record.completedAt ?? Date.now()))).toISOString(),
        elapsedSeconds: typeof record.elapsedSeconds === "number" ? record.elapsedSeconds : undefined,
        hasSubtitles: files.includes(`${base}.srt`),
        error: err ? `${err.code ?? ""}: ${err.message ?? ""}` : undefined,
        exists,
        loudness: loud?.measuredI,
      });
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function thumbnail(abs: string): Promise<string> {
  const st = await stat(abs);
  const key = createHash("sha1").update(`${abs}|${st.mtimeMs}|${st.size}`).digest("hex").slice(0, 20);
  const out = join(THUMBS, `${key}.jpg`);
  if (!existsSync(out)) {
    await mkdir(THUMBS, { recursive: true });
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", "1.5", "-i", abs, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out]).catch(
      // Video ngắn hơn 1.5s → lấy frame đầu.
      () => runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", abs, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out]),
    );
  }
  return out;
}

async function serveFile(req: IncomingMessage, res: ServerResponse, abs: string, download = false): Promise<void> {
  const st = await stat(abs);
  res.setHeader("Content-Type", contentType(extname(abs)));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");
  if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`);
  const range = parseRange(req.headers.range, st.size);
  if (req.headers.range && !range) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${st.size}`);
    res.end();
    return;
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range[0]}-${range[1]}/${st.size}`);
    res.setHeader("Content-Length", String(range[1] - range[0] + 1));
    createReadStream(abs, { start: range[0], end: range[1] }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(st.size));
    createReadStream(abs).pipe(res);
  }
}

function openFolder(abs: string): void {
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: false };
  if (process.platform === "win32") spawn("explorer.exe", [`/select,${abs}`], opts).unref();
  else if (process.platform === "darwin") spawn("open", ["-R", abs], opts).unref();
  else spawn("xdg-open", [dirname(abs)], opts).unref();
}

// ---------------------------------------------------------------- batch job

interface BatchJob {
  id: string;
  template: string;
  args: string[];
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  log: string[];
  child?: ChildProcess;
}

let job: BatchJob | undefined;

function startBatch(template: string, opts: { formats?: string[]; only?: string[]; force?: boolean; dryRun?: boolean; concurrency?: number }): BatchJob {
  const args = [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "batch.ts"), join("templates", template)];
  if (opts.formats?.length) args.push("--formats", opts.formats.join(","));
  if (opts.only?.length) args.push("--only", opts.only.join(","));
  if (opts.force) args.push("--force");
  if (opts.dryRun) args.push("--dry-run");
  args.push("--concurrency", String(Math.min(4, Math.max(1, opts.concurrency ?? 2))));

  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
  const j: BatchJob = { id: randomUUID().slice(0, 8), template, args: args.slice(2), status: "running", startedAt: new Date().toISOString(), log: [], child };
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim() || /Frame \d+\//.test(line)) continue;
      j.log.push(line);
      if (j.log.length > 400) j.log.splice(0, j.log.length - 400);
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("close", (code) => {
    j.exitCode = code;
    j.finishedAt = new Date().toISOString();
    if (j.status === "running") j.status = code === 0 ? "completed" : "failed";
    j.child = undefined;
  });
  return j;
}

async function readReport(template: string, dryRun = false): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(ROOT, "batches", template, dryRun ? "report.dry-run.json" : "report.json"), "utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- plugin

export function libraryApi(): Plugin {
  let tts: Synthesize | undefined;
  return {
    name: "autocartoon-library-api",
    configureServer(server) {
      const use = (path: string, fn: Parameters<typeof handler>[0]) => server.middlewares.use(path, handler(fn));

      use("/media", async (req, res, url) => {
        if (req.method !== "GET" && req.method !== "HEAD") return false;
        const abs = safeResolve(ROOT, decodeURIComponent(url.pathname.replace(/^\//, "")), MEDIA_DIRS);
        if (!abs || !existsSync(abs)) return fail(res, 404, "Không tìm thấy file");
        await serveFile(req, res, abs, url.searchParams.has("download"));
      });

      use("/api/videos", async (req, res, url) => {
        const rel = url.searchParams.get("path") ?? "";
        if (url.pathname === "/" && req.method === "GET") return send(res, 200, await collectVideos());
        const abs = safeResolve(ROOT, rel, MEDIA_DIRS);
        if (!abs || !abs.endsWith(".mp4")) return fail(res, 400, "Đường dẫn video không hợp lệ");
        if (url.pathname === "/thumb" && req.method === "GET") {
          if (!existsSync(abs)) return fail(res, 404, "Không có video");
          return serveFile(req, res, await thumbnail(abs));
        }
        if (url.pathname === "/vtt" && req.method === "GET") {
          const srt = abs.replace(/\.mp4$/, ".srt");
          if (!existsSync(srt)) return fail(res, 404, "Không có phụ đề");
          res.setHeader("Content-Type", "text/vtt; charset=utf-8");
          return res.end(srtToVtt(await readFile(srt, "utf8")));
        }
        if (url.pathname === "/" && req.method === "DELETE") {
          const base = abs.slice(0, -4);
          const removed: string[] = [];
          for (const ext of [".mp4", ".srt", ".render.json", ".ATTRIBUTIONS.txt"]) {
            if (existsSync(base + ext)) {
              await rm(base + ext);
              removed.push(basename(base + ext));
            }
          }
          return send(res, 200, { removed });
        }
        return false;
      });

      use("/api/open-folder", async (req, res) => {
        if (req.method !== "POST") return false;
        const { path } = await readJson<{ path: string }>(req);
        const abs = safeResolve(ROOT, path, MEDIA_DIRS);
        if (!abs || !existsSync(abs)) return fail(res, 404, "Không tìm thấy file");
        openFolder(abs);
        send(res, 200, { ok: true });
      });

      use("/api/assets", async (req, res, url) => {
        if (url.pathname === "/import" && req.method === "POST") {
          const filename = basename(decodeURIComponent(String(req.headers["x-filename"] ?? "")));
          const ext = extname(filename).toLowerCase();
          if (![".glb", ".gltf", ".fbx"].includes(ext)) return fail(res, 400, "Chỉ nhận file .glb, .gltf (nhúng dữ liệu) hoặc .fbx");
          const q = url.searchParams;
          const author = q.get("author")?.trim();
          const source = q.get("source")?.trim();
          if (!author || !source) return fail(res, 400, "Cần nhập tác giả và nguồn (để ghi công / kiểm tra license)");
          const dir = join(UPLOADS, randomUUID().slice(0, 8));
          await mkdir(dir, { recursive: true });
          const file = join(dir, filename.replace(/[^\w.-]+/g, "_"));
          try {
            await writeFile(file, await readBody(req, MAX_UPLOAD));
            const [result] = await importAssets([file], {
              type: (q.get("type") ?? "character") as ImportableType,
              id: q.get("id")?.trim() || undefined,
              name: q.get("name") ?? undefined,
              height: q.get("height") ? Number(q.get("height")) : undefined,
              headingOffset: q.get("headingOffset") ? Number(q.get("headingOffset")) : 0,
              license: q.get("license") ?? "CC0-1.0",
              author,
              source,
            });
            return send(res, 200, result);
          } catch (err) {
            return fail(res, 400, err instanceof Error ? err.message : String(err));
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (id && req.method === "PATCH") {
          try {
            return send(res, 200, await updateAsset(id, await readJson<Record<string, unknown>>(req)));
          } catch (err) {
            return fail(res, 400, err instanceof Error ? err.message : String(err));
          }
        }
        return false;
      });

      use("/api/tts/preview", async (req, res) => {
        if (req.method !== "POST") return false;
        const { voice, text, rate } = await readJson<{ voice: string; text: string; rate?: number }>(req);
        const registry = await readRegistry();
        const v = findAsset(registry, voice);
        if (!v || v.type !== "voice") return fail(res, 400, `Không có giọng "${voice}"`);
        if (!text?.trim() || text.length > 500) return fail(res, 400, "Nhập 1–500 ký tự");
        tts ??= createPiperTts();
        const r = await tts({ text: text.trim(), voice: v, rate: rate ?? v.defaultRate ?? 1 });
        send(res, 200, { url: `/assets/${r.file}`, duration: r.duration, cached: r.cached });
      });

      use("/api/templates", async (req, res, url) => {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 0 && req.method === "GET") {
          const list = [];
          for (const dir of await listDir(join(ROOT, "templates"))) {
            try {
              const t = TemplateSchema.parse(JSON.parse(await readFile(join(ROOT, "templates", dir, "template.json"), "utf8")));
              const csvPath = join(ROOT, "templates", dir, "data.csv");
              const text = existsSync(csvPath) ? await readFile(csvPath, "utf8") : "";
              const rows = parseCsv(text);
              const columns = (parseCsvRows(text)[0] ?? []).map((c) => c.trim()).filter(Boolean);
              list.push({
                id: t.id,
                dir,
                name: t.name,
                description: t.description,
                params: t.params,
                formats: Object.fromEntries(Object.entries(t.formats).map(([k, f]) => [k, { width: f.width, height: f.height }])),
                columns: columns.length ? columns : ["id", ...Object.keys(t.params)],
                rows,
                report: await readReport(t.id),
              });
            } catch (err) {
              list.push({ id: dir, dir, name: dir, error: err instanceof Error ? err.message : String(err) });
            }
          }
          return send(res, 200, list);
        }
        if (parts.length === 2 && parts[1] === "data" && req.method === "PUT") {
          const dir = parts[0]!;
          if (!/^[a-z0-9-]+$/.test(dir) || !existsSync(join(ROOT, "templates", dir, "template.json"))) return fail(res, 404, "Không có template");
          const { columns, rows } = await readJson<{ columns: string[]; rows: Record<string, string>[] }>(req);
          if (!Array.isArray(columns) || !columns.includes("id")) return fail(res, 400, "Cần cột id");
          await writeFile(join(ROOT, "templates", dir, "data.csv"), toCsv(columns, rows), "utf8");
          return send(res, 200, { ok: true, rows: rows.length });
        }
        return false;
      });

      use("/api/batch", async (req, res, url) => {
        if (url.pathname === "/" && req.method === "POST") {
          if (job?.status === "running") return fail(res, 409, "Đang có batch chạy – chờ xong hoặc hủy");
          const body = await readJson<{ template: string; formats?: string[]; only?: string[]; force?: boolean; dryRun?: boolean; concurrency?: number }>(req);
          if (!/^[a-z0-9-]+$/.test(body.template ?? "") || !existsSync(join(ROOT, "templates", body.template, "template.json"))) {
            return fail(res, 404, "Không có template");
          }
          job = startBatch(body.template, body);
          return send(res, 200, { id: job.id });
        }
        if (url.pathname === "/current" && req.method === "GET") {
          if (!job) return send(res, 200, null);
          const { child: _child, ...rest } = job;
          return send(res, 200, { ...rest, report: await readReport(job.template, job.args.includes("--dry-run")) });
        }
        if (url.pathname === "/cancel" && req.method === "POST") {
          if (job?.status !== "running" || !job.child) return fail(res, 409, "Không có batch đang chạy");
          job.status = "cancelled";
          job.child.kill();
          return send(res, 200, { ok: true });
        }
        return false;
      });
    },
  };
}
