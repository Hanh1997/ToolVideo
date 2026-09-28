/**
 * Batch: template + dữ liệu (CSV/JSON, mỗi dòng một video) → N video.
 *
 *   npm run batch -- templates/kids-lesson                       # dùng templates/kids-lesson/data.csv
 *   npm run batch -- templates/kids-lesson data.csv --formats 16x9,9x16 --concurrency 2
 *   npm run batch -- templates/kids-lesson --only hoc-dem --dry-run
 *
 * Mỗi dòng → một project thật trong projects/<template>-<id>/ (mở được trong Editor để duyệt/sửa).
 * Video → batches/<template>/videos/<id>_<format>.mp4 (+ .srt, .render.json, .ATTRIBUTIONS.txt).
 * Video không đổi (cùng scene + thông số) được bỏ qua; --force để render lại.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseCsv } from "../src/template/csv";
import { instantiate, TemplateSchema, type Template } from "../src/template/template";
import { createRenderEnv, parseQualityMode, parseRendererMode, prepareScene, RenderFailure, renderScene, ROOT, writeFailureRecord, type PreparedScene } from "./renderJob";

const log = (msg: string) => console.log(`[batch] ${msg}`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    formats: { type: "string" },
    concurrency: { type: "string", default: "2" },
    only: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    out: { type: "string" },
    fps: { type: "string" },
    crf: { type: "string" },
    browser: { type: "string", default: "chromium" },
    renderer: { type: "string" },
    /** auto (mặc định: high nếu GPU, standard nếu CPU) | high | standard. Hoặc biến AC_QUALITY. */
    quality: { type: "string" },
  },
});

const templateArg = positionals[0];
if (!templateArg) {
  console.error("Cách dùng: npm run batch -- <thư mục template> [data.csv|data.json] [--formats 16x9,9x16] [--concurrency 2] [--only id1,id2] [--dry-run] [--force]");
  process.exit(2);
}

type JobStatus = "Completed" | "Skipped" | "Failed" | "Cancelled" | "Invalid" | "Ready";

interface JobResult {
  row: string;
  format: string;
  project: string;
  status: JobStatus;
  duration?: number;
  output?: string;
  elapsedSeconds?: number;
  error?: string;
}

async function loadData(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  if (extname(file).toLowerCase() === ".json") {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(`${file}: cần một mảng object`);
    return data as Record<string, unknown>[];
  }
  return parseCsv(text);
}

function csvCell(v: unknown): string {
  const s = v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Dry-run ghi báo cáo riêng để không ghi đè kết quả render thật. */
const REPORT = process.argv.includes("--dry-run") ? "report.dry-run" : "report";

async function writeReport(dir: string, template: Template, results: JobResult[], startedAt: number): Promise<void> {
  const summary = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  await writeFile(
    join(dir, `${REPORT}.json`),
    `${JSON.stringify({ template: template.id, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), summary, jobs: results }, null, 2)}\n`,
    "utf8",
  );
  const header = ["row", "format", "status", "duration", "output", "project", "elapsedSeconds", "error"] as const;
  const lines = [header.join(","), ...results.map((r) => header.map((k) => csvCell(r[k])).join(","))];
  // BOM để Excel mở đúng tiếng Việt.
  await writeFile(join(dir, `${REPORT}.csv`), `﻿${lines.join("\r\n")}\r\n`, "utf8");
}

const started = Date.now();
const templateDir = resolve(process.cwd(), templateArg);
const template = TemplateSchema.parse(JSON.parse(await readFile(join(templateDir, "template.json"), "utf8")));
const dataFile = resolve(process.cwd(), positionals[1] ?? join(templateArg, "data.csv"));
const formats = values.formats ? values.formats.split(",").map((f) => f.trim()) : Object.keys(template.formats);
for (const f of formats) {
  if (!template.formats[f]) {
    console.error(`[batch] Template không có định dạng "${f}". Có: ${Object.keys(template.formats).join(", ")}`);
    process.exit(2);
  }
}
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : undefined;
const batchDir = resolve(process.cwd(), values.out ?? join("batches", template.id));
const videosDir = join(batchDir, "videos");
const concurrency = Math.max(1, Number(values.concurrency) || 1);

let cancelled = false;
process.on("SIGINT", () => {
  cancelled = true;
  log("Đang hủy (chờ các frame đang render)…");
});

const env = await createRenderEnv({ browser: values.browser, renderer: parseRendererMode(values.renderer), quality: parseQualityMode(values.quality), log });
const results: JobResult[] = [];
let exitCode = 0;

try {
  const rows = await loadData(dataFile);
  log(`Template "${template.name}" · ${rows.length} dòng dữ liệu · định dạng: ${formats.join(", ")}`);
  await mkdir(videosDir, { recursive: true });

  // 1. Dòng dữ liệu → project + scene (chưa render). Lỗi dòng nào ghi nhận dòng đó.
  const jobs: { row: string; format: string; project: string; prepared: PreparedScene; output: string }[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const inst = instantiate(template, row, index, env.registry);
    if (only && !only.has(inst.rowId)) continue;
    const project = `${template.id}-${inst.rowId}`;
    for (const w of inst.issues.filter((i) => i.level === "warning")) log(`⚠ ${inst.rowId}: ${w.message}`);

    const errors = inst.issues.filter((i) => i.level === "error");
    if (seen.has(inst.rowId)) errors.push({ level: "error", code: "InvalidRowId", message: `id "${inst.rowId}" bị trùng` });
    seen.add(inst.rowId);
    if (errors.length) {
      for (const f of formats) results.push({ row: inst.rowId, format: f, project, status: "Invalid", error: errors.map((e) => e.message).join("; ") });
      log(`✗ ${inst.rowId}: ${errors.map((e) => e.message).join("; ")}`);
      continue;
    }

    // Project thật để duyệt/sửa trong Editor (scene theo định dạng đầu tiên).
    const projectDir = join(ROOT, "projects", project);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "scene.json"), `${JSON.stringify(inst.scenes[formats[0]!], null, 2)}\n`, "utf8");
    await writeFile(
      join(projectDir, "project.json"),
      `${JSON.stringify({ id: project, name: `${template.name}: ${String(inst.values.title ?? inst.rowId)}`, template: template.id, row: inst.rowId, params: inst.values }, null, 2)}\n`,
      "utf8",
    );

    for (const f of formats) {
      const output = join(videosDir, `${inst.rowId}_${f}.mp4`);
      try {
        const prepared = await prepareScene(env, inst.scenes[f], { fps: values.fps ? Number(values.fps) : undefined });
        if (f === formats[0]) await writeFile(join(projectDir, "scene.resolved.json"), `${JSON.stringify(prepared.input, null, 2)}\n`, "utf8");
        jobs.push({ row: inst.rowId, format: f, project, prepared, output });
        log(`✓ ${inst.rowId} [${f}] hợp lệ – ${prepared.scene.meta.duration}s, ${prepared.scene.dialogue.length} câu thoại${prepared.synthesized ? `, TTS mới ${prepared.synthesized}` : ""}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ row: inst.rowId, format: f, project, status: "Invalid", error: message.replaceAll("\n", "; ") });
        await writeFailureRecord(project, output, err instanceof RenderFailure ? err : new RenderFailure("InvalidSceneScript", message));
        log(`✗ ${inst.rowId} [${f}]: ${message}`);
      }
    }
  }

  // 2. Render song song (mỗi worker một trang Chromium, dùng chung trình duyệt).
  if (values["dry-run"]) {
    for (const j of jobs) results.push({ row: j.row, format: j.format, project: j.project, status: "Ready", duration: j.prepared.scene.meta.duration });
    log(`Dry run: ${jobs.length} video sẵn sàng render, không render.`);
  } else if (jobs.length) {
    log(`Render ${jobs.length} video, ${concurrency} luồng…`);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (!cancelled) {
        const job = jobs[next++];
        if (!job) return;
        const tag = `${job.row} [${job.format}]`;
        const { record, skipped } = await renderScene(env, job.prepared, {
          projectId: job.project,
          output: job.output,
          crf: values.crf ? Number(values.crf) : undefined,
          skipUnchanged: !values.force,
          isCancelled: () => cancelled,
          log: (m) => log(`  ${tag} ${m}`),
        });
        done++;
        const status: JobStatus = skipped ? "Skipped" : record.status === "Completed" ? "Completed" : record.status === "Cancelled" ? "Cancelled" : "Failed";
        results.push({
          row: job.row,
          format: job.format,
          project: job.project,
          status,
          duration: job.prepared.scene.meta.duration,
          output: relative(ROOT, job.output).replaceAll("\\", "/"),
          elapsedSeconds: skipped ? 0 : record.elapsedSeconds,
          error: record.error ? `${record.error.code}: ${record.error.message}` : undefined,
        });
        log(`${status === "Completed" ? "✓" : status === "Skipped" ? "=" : "✗"} (${done}/${jobs.length}) ${tag} ${status}${skipped ? " (không đổi)" : ` ${record.elapsedSeconds}s`}`);
        await writeReport(batchDir, template, results, started);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  }
} catch (err) {
  exitCode = 1;
  console.error(`[batch] ✗ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await env.close();
}

results.sort((a, b) => a.row.localeCompare(b.row) || a.format.localeCompare(b.format));
await writeReport(batchDir, template, results, started);
const count = (s: JobStatus) => results.filter((r) => r.status === s).length;
log(
  `Kết quả: ${count("Completed")} xong · ${count("Skipped")} bỏ qua (không đổi) · ${count("Ready")} sẵn sàng · ` +
    `${count("Invalid")} lỗi dữ liệu · ${count("Failed")} lỗi render · ${count("Cancelled")} hủy – ${Math.round((Date.now() - started) / 1000)}s`,
);
log(`Báo cáo: ${relative(ROOT, join(batchDir, `${REPORT}.csv`))}`);
if (results.some((r) => r.status === "Invalid" || r.status === "Failed" || r.status === "Cancelled")) exitCode = 1;
process.exit(exitCode);
