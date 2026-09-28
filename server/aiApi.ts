/**
 * API "AI kịch bản" (Vite dev server, chỉ localhost):
 *
 *   GET  /api/ai/status                      đã cấu hình key chưa, model, ngôn ngữ có giọng đọc
 *   POST /api/ai/story   {prompt, languages, seconds, scenes?} → bản nháp kịch bản (chưa dựng gì; scenes bỏ trống = AI tự chọn số cảnh)
 *   POST /api/ai/revise  {draftId, story, instruction, languages} → bản nháp mới theo góp ý
 *   PUT  /api/ai/drafts/:id {story}           lưu chỉnh sửa tay của người duyệt
 *   GET  /api/ai/drafts                       các bản nháp gần đây
 *   POST /api/ai/approve {draftId, story, languages, format}   → DUYỆT: tạo project + TTS + kiểm tra + render
 *   GET  /api/ai/job                          tiến độ job duyệt gần nhất
 *   POST /api/ai/job/cancel
 *
 * Chỉ khi người dùng bấm duyệt mới chạy các bước tiếp theo (project, giọng đọc, render).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { buildStory } from "../src/ai/buildScene";
import { castable, characterStyle, checkStory, FORMATS, LANG_CODES, LANGUAGES, RequestedCharacterSchema, type Format, type Lang, type RequestedCharacter, type Story } from "../src/ai/story";
import { findAsset, type Registry } from "../src/schemas/asset.schema";
import { MovieSchema, movieTimeline } from "../src/movie/movie";
import { resolveScene } from "../src/tts/resolveScene";
import { validateScene } from "../src/validation/validateScene";
import { aiConfigured, AiError } from "./ai/deepseek";
import { generateStory, reviseStory } from "./ai/storyGenerator";
import { readRegistry } from "./assets/importAsset";
import { createPiperTts } from "./tts/piperTts";

const ROOT = resolve(import.meta.dirname, "..");
const DRAFTS = join(ROOT, "storage", "ai", "drafts");
const DRAFT_ID = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------- HTTP

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error("Dữ liệu quá lớn");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

// ---------------------------------------------------------------- bản nháp

interface Draft {
  id: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  tokens?: number;
  story: Story;
  /** Lịch sử góp ý đã gửi cho AI. */
  revisions: string[];
  /** Nhân vật người dùng đã chọn khi tạo (không có = AI tự chọn). */
  cast?: RequestedCharacter[];
  approved?: { at: string; projects: string[] };
}

async function saveDraft(d: Draft): Promise<void> {
  await mkdir(DRAFTS, { recursive: true });
  await writeFile(join(DRAFTS, `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`, "utf8");
}

async function loadDraft(id: string): Promise<Draft | undefined> {
  if (!DRAFT_ID.test(id)) return undefined;
  try {
    return JSON.parse(await readFile(join(DRAFTS, `${id}.json`), "utf8")) as Draft;
  } catch {
    return undefined;
  }
}

function newDraftId(): string {
  return `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
}

function parseLanguages(v: unknown): Lang[] {
  const list = Array.isArray(v) ? v.filter((l): l is Lang => typeof l === "string" && (LANG_CODES as string[]).includes(l)) : [];
  if (!list.length) throw new Error("Chọn ít nhất một ngôn ngữ");
  return [...new Set(list)];
}

/** Nhân vật người dùng chọn (tối đa 6, phải là nhân vật AI dùng được). Rỗng = để AI chọn. */
function parseCast(v: unknown, registry: Registry): RequestedCharacter[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("cast phải là danh sách nhân vật");
  const allowed = new Set(castable(registry).map((a) => a.id));
  const cast = v.map((c) => RequestedCharacterSchema.parse(c)).map((c) => ({ asset: c.asset, ...(c.name ? { name: c.name } : {}) }));
  if (cast.length > 6) throw new Error("Chọn tối đa 6 nhân vật");
  const bad = cast.find((c) => !allowed.has(c.asset));
  if (bad) throw new Error(`"${bad.asset}" không phải nhân vật dùng được cho AI`);
  return cast.length ? cast : undefined;
}

/** Ngôn ngữ có giọng đọc trong Registry. */
async function voicedLanguages(): Promise<Lang[]> {
  const reg = await readRegistry();
  return LANG_CODES.filter((l) => reg.assets.some((a) => a.type === "voice" && a.id.startsWith(`voice_${l}_`)));
}

// ---------------------------------------------------------------- job duyệt → render

type ItemStatus = "pending" | "preparing" | "rendering" | "completed" | "failed" | "cancelled";

interface JobItem {
  lang: Lang;
  project: string;
  status: ItemStatus;
  progress: number;
  duration?: number;
  /** Số khung cảnh (chỉ khi là movie). */
  scenes?: number;
  output?: string;
  error?: string;
}

interface AiJob {
  id: string;
  draftId: string;
  title: string;
  format: Format;
  status: "running" | "completed" | "failed" | "cancelled";
  items: JobItem[];
  log: string[];
  startedAt: string;
  finishedAt?: string;
  child?: ChildProcess;
  cancelled?: boolean;
}

let job: AiJob | undefined;

function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "story"
  );
}

function runRender(j: AiJob, item: JobItem): Promise<void> {
  return new Promise((done) => {
    const args = [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "cli", "render.ts"), join("projects", item.project)];
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
    j.child = child;
    let sceneOf: { k: number; n: number } | undefined;
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        // Movie: "Cảnh k/n" rồi frame của từng cảnh → quy về tiến độ cả phim.
        const scene = /Cảnh (\d+)\/(\d+) /.exec(line);
        if (scene) sceneOf = { k: Number(scene[1]) - 1, n: Number(scene[2]) };
        const frame = /Frame (\d+)\/(\d+) \((\d+)%\)/.exec(line);
        if (frame) {
          const pct = Number(frame[3]);
          item.progress = sceneOf ? Math.round(((sceneOf.k + pct / 95) / sceneOf.n) * 90) : pct;
          continue;
        }
        const ok = /✓ Xong: (.+?\.mp4)/.exec(line);
        if (ok) {
          const abs = isAbsolute(ok[1]!) ? ok[1]! : resolve(ROOT, ok[1]!);
          item.output = relative(ROOT, abs).split("\\").join("/"); // /media/<đường dẫn tương đối>
        }
        j.log.push(`[${item.lang}] ${line}`);
        if (j.log.length > 300) j.log.splice(0, j.log.length - 300);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => {
      j.child = undefined;
      if (j.cancelled) item.status = "cancelled";
      else if (code === 0) {
        item.status = "completed";
        item.progress = 100;
      } else {
        item.status = "failed";
        item.error ??= j.log.filter((l) => l.startsWith(`[${item.lang}]`) && l.includes("✗")).at(-1) ?? `render thoát mã ${code}`;
      }
      done();
    });
  });
}

async function runJob(j: AiJob, story: Story): Promise<void> {
  const registry = await readRegistry();
  const tts = createPiperTts();
  const log = (m: string) => j.log.push(m);
  for (const item of j.items) {
    if (j.cancelled) {
      item.status = "cancelled";
      continue;
    }
    try {
      // 1. Dựng scene + giọng đọc + kiểm tra (trước khi tốn thời gian render).
      item.status = "preparing";
      log(`[${item.lang}] Dựng scene, tạo giọng đọc ${LANGUAGES[item.lang].label}…`);
      const built = buildStory(story, item.lang, registry, { format: j.format });
      const drafts = built.kind === "scene" ? [{ id: "", raw: built.scene }] : built.scenes.map((sc) => ({ id: sc.id, raw: sc.scene }));
      const durations: number[] = [];
      for (const d of drafts) {
        const at = d.id ? `cảnh "${d.id}": ` : "";
        const resolved = await resolveScene(d.raw, registry, tts);
        if (resolved.issues.length) throw new Error(at + resolved.issues.map((i) => `${i.code}: ${i.message}`).join("; "));
        const v = validateScene(resolved.scene, registry);
        if (!v.ok) throw new Error(at + v.issues.slice(0, 5).map((i) => `${i.code}: ${i.message}`).join("; "));
        durations.push(v.scene.meta.duration);
      }
      const dir = join(ROOT, "projects", item.project);
      await mkdir(dir, { recursive: true });
      // Duyệt lại cùng bản nháp: dọn bản cũ (render.ts ưu tiên movie.json nếu có).
      await rm(join(dir, "movie.json"), { force: true });
      await rm(join(dir, "scene.json"), { force: true });
      await rm(join(dir, "scenes"), { recursive: true, force: true });
      if (built.kind === "scene") {
        item.duration = durations[0];
        await writeFile(join(dir, "scene.json"), `${JSON.stringify(built.scene, null, 2)}\n`, "utf8");
      } else {
        const movie = MovieSchema.parse(built.movie);
        const { timeline, issues } = movieTimeline(
          movie.scenes.map((e, i) => ({ id: e.id, duration: durations[i]!, transition: e.transition })),
          movie.meta.fps,
        );
        if (issues.length) throw new Error(issues.map((i) => i.message).join("; "));
        item.duration = timeline.duration;
        item.scenes = built.scenes.length;
        await mkdir(join(dir, "scenes"), { recursive: true });
        for (const sc of built.scenes) await writeFile(join(dir, sc.file), `${JSON.stringify(sc.scene, null, 2)}\n`, "utf8");
        await writeFile(join(dir, "movie.json"), `${JSON.stringify(built.movie, null, 2)}\n`, "utf8");
      }
      await writeFile(join(dir, "story.json"), `${JSON.stringify(story, null, 2)}\n`, "utf8");
      await writeFile(
        join(dir, "project.json"),
        `${JSON.stringify({ id: item.project, name: story.title[item.lang], description: story.summary[item.lang], commercial: false, source: { kind: "ai", draft: j.draftId, lang: item.lang } }, null, 2)}\n`,
        "utf8",
      );
      log(`[${item.lang}] ✓ ${item.scenes ? `${item.scenes} cảnh` : "Scene"} hợp lệ (${item.duration}s) → projects/${item.project}`);
      if (j.cancelled) {
        item.status = "cancelled";
        continue;
      }
      // 2. Render.
      item.status = "rendering";
      await runRender(j, item);
    } catch (err) {
      item.status = "failed";
      item.error = err instanceof Error ? err.message : String(err);
      log(`[${item.lang}] ✗ ${item.error}`);
    }
  }
  j.finishedAt = new Date().toISOString();
  j.status = j.cancelled ? "cancelled" : j.items.every((i) => i.status === "completed") ? "completed" : "failed";
}

// ---------------------------------------------------------------- plugin

export function aiApi(): Plugin {
  return {
    name: "autocartoon-ai-api",
    configureServer(server) {
      server.middlewares.use("/api/ai", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = async (): Promise<unknown> => {
          const p = url.pathname;
          if (p === "/status" && req.method === "GET") {
            return send(res, 200, { configured: aiConfigured(), model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro", languages: await voicedLanguages(), formats: Object.keys(FORMATS) });
          }
          if (p === "/story" && req.method === "POST") {
            const body = await readJson<{ prompt?: string; languages?: unknown; seconds?: number; scenes?: number; cast?: unknown }>(req);
            const prompt = (body.prompt ?? "").trim();
            if (prompt.length < 5) return send(res, 400, { error: "Prompt quá ngắn" });
            const languages = parseLanguages(body.languages);
            const registry = await readRegistry();
            const cast = parseCast(body.cast, registry);
            const r = await generateStory(registry, { prompt, languages, seconds: Math.min(180, Math.max(15, Number(body.seconds) || 45)), scenes: Number(body.scenes) || undefined, cast });
            const now = new Date().toISOString();
            const draft: Draft = { id: newDraftId(), prompt, createdAt: now, updatedAt: now, model: r.model, tokens: r.tokens, story: r.story, revisions: [], ...(cast ? { cast } : {}) };
            await saveDraft(draft);
            return send(res, 200, draft);
          }
          if (p === "/revise" && req.method === "POST") {
            const body = await readJson<{ draftId?: string; story?: unknown; instruction?: string; languages?: unknown }>(req);
            const draft = await loadDraft(body.draftId ?? "");
            if (!draft) return send(res, 404, { error: "Không có bản nháp" });
            const registry = await readRegistry();
            const { story } = checkStory(body.story ?? draft.story, registry);
            const current = story ?? draft.story;
            // Nhân vật do người dùng chọn / đổi (có thể khác phong cách) → không ép cùng phong cách khi sửa.
            const mixed = new Set(current.characters.map((c) => characterStyle(findAsset(registry, c.asset)))).size > 1;
            const r = await reviseStory(registry, current, body.instruction ?? "", parseLanguages(body.languages ?? draft.story.languages), !draft.cast && !mixed);
            Object.assign(draft, { story: r.story, updatedAt: new Date().toISOString(), tokens: (draft.tokens ?? 0) + r.tokens });
            draft.revisions.push(body.instruction ?? "");
            await saveDraft(draft);
            return send(res, 200, draft);
          }
          if (p.startsWith("/drafts/") && req.method === "PUT") {
            const draft = await loadDraft(p.slice("/drafts/".length));
            if (!draft) return send(res, 404, { error: "Không có bản nháp" });
            const { story, issues } = checkStory((await readJson<{ story?: unknown }>(req)).story, await readRegistry());
            if (!story) return send(res, 400, { error: "Kịch bản không hợp lệ", issues });
            Object.assign(draft, { story, updatedAt: new Date().toISOString() });
            await saveDraft(draft);
            return send(res, 200, draft);
          }
          if (p === "/drafts" && req.method === "GET") {
            const files = existsSync(DRAFTS) ? (await readdir(DRAFTS)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 20) : [];
            const list = [];
            for (const f of files) {
              const d = await loadDraft(f.slice(0, -5));
              if (d) list.push({ id: d.id, prompt: d.prompt, title: d.story.title[d.story.languages[0]!], languages: d.story.languages, updatedAt: d.updatedAt, approved: d.approved });
            }
            return send(res, 200, list);
          }
          if (p.startsWith("/drafts/") && req.method === "GET") {
            const draft = await loadDraft(p.slice("/drafts/".length));
            return draft ? send(res, 200, draft) : send(res, 404, { error: "Không có bản nháp" });
          }
          if (p === "/approve" && req.method === "POST") {
            if (job?.status === "running") return send(res, 409, { error: "Đang dựng video khác – chờ xong hoặc hủy" });
            const body = await readJson<{ draftId?: string; story?: unknown; languages?: unknown; format?: string }>(req);
            const draft = await loadDraft(body.draftId ?? "");
            if (!draft) return send(res, 404, { error: "Không có bản nháp" });
            const { story, issues } = checkStory(body.story ?? draft.story, await readRegistry());
            if (!story) return send(res, 400, { error: "Kịch bản không hợp lệ", issues });
            const languages = parseLanguages(body.languages).filter((l) => story.languages.includes(l));
            if (!languages.length) return send(res, 400, { error: "Ngôn ngữ đã chọn không có trong kịch bản" });
            const format: Format = body.format === "9x16" ? "9x16" : "16x9";
            const base = `ai-${slugify(story.title.en ?? story.title[story.languages[0]!]!)}-${draft.id.slice(-4)}`;
            const items: JobItem[] = languages.map((lang) => ({ lang, project: `${base}-${lang}${format === "9x16" ? "-9x16" : ""}`, status: "pending", progress: 0 }));
            job = { id: randomUUID().slice(0, 8), draftId: draft.id, title: story.title[languages[0]!]!, format, status: "running", items, log: [], startedAt: new Date().toISOString() };
            Object.assign(draft, { story, updatedAt: new Date().toISOString(), approved: { at: new Date().toISOString(), projects: items.map((i) => i.project) } });
            await saveDraft(draft);
            void runJob(job, story);
            return send(res, 200, { id: job.id });
          }
          if (p === "/job" && req.method === "GET") {
            if (!job) return send(res, 200, null);
            const { child: _c, ...rest } = job;
            return send(res, 200, rest);
          }
          if (p === "/job/cancel" && req.method === "POST") {
            if (job?.status !== "running") return send(res, 409, { error: "Không có job đang chạy" });
            job.cancelled = true;
            job.child?.kill();
            return send(res, 200, { ok: true });
          }
          return next();
        };
        route().catch((err: unknown) => {
          const status = err instanceof AiError ? 502 : 400;
          send(res, status, { error: err instanceof Error ? err.message : String(err) });
        });
      });
    },
  };
}
