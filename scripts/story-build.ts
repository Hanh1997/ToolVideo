/**
 * Dựng project từ kịch bản story.json (như nút "Duyệt" trong tab AI, không cần UI / không gọi AI):
 * kiểm tra kịch bản → dựng scene / movie → giọng đọc (Piper) → kiểm tra scene → ghi projects/<id>/.
 *
 *   npm run story:build -- projects/cung-nhau-don-rac/story.json            (project = thư mục chứa story.json)
 *   npm run story:build -- my-story.json --project ten-phim [--lang vi] [--format 9x16] [--resolution 1080p]
 *   rồi: npm run render -- projects/<id>
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildStory } from "../src/ai/buildScene";
import { checkStory, FPS_OPTIONS, LANG_CODES, LOUDNESS, RESOLUTIONS, type Format, type Lang } from "../src/ai/story";
import { MovieSchema, movieTimeline } from "../src/movie/movie";
import { resolveScene } from "../src/tts/resolveScene";
import { validateScene } from "../src/validation/validateScene";
import { readRegistry } from "../server/assets/importAsset";
import { createPiperTts } from "../server/tts/piperTts";

const ROOT = resolve(import.meta.dirname, "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    lang: { type: "string" },
    format: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "string" },
    loudness: { type: "string" },
  },
});
const file = positionals[0];
if (!file) throw new Error("Cần đường dẫn story.json");

const registry = await readRegistry();
const { story, issues } = checkStory(JSON.parse(await readFile(file, "utf8")), registry);
if (!story) {
  for (const i of issues) console.error(`✗ ${i.path}: ${i.message}`);
  process.exit(1);
}
const lang = (values.lang ?? story.languages[0]) as Lang;
if (!LANG_CODES.includes(lang) || !story.languages.includes(lang)) throw new Error(`Ngôn ngữ "${lang}" không có trong kịch bản`);
const format: Format = values.format === "9x16" ? "9x16" : "16x9";
const project = values.project ?? basename(dirname(resolve(file)));
const dir = join(ROOT, "projects", project);

const built = buildStory(story, lang, registry, {
  format,
  resolution: values.resolution && values.resolution in RESOLUTIONS ? (values.resolution as keyof typeof RESOLUTIONS) : "720p",
  fps: FPS_OPTIONS.find((f) => f === Number(values.fps)) ?? 30,
  loudness: values.loudness && values.loudness in LOUDNESS ? (values.loudness as keyof typeof LOUDNESS) : "web",
  titles: true,
});
const tts = createPiperTts();
const drafts = built.kind === "scene" ? [{ id: "", raw: built.scene }] : built.scenes.map((sc) => ({ id: sc.id, raw: sc.scene }));
const durations: number[] = [];
for (const d of drafts) {
  const at = d.id ? `cảnh "${d.id}": ` : "";
  console.log(`${at || "scene: "}giọng đọc + kiểm tra…`);
  const resolved = await resolveScene(d.raw, registry, tts);
  if (resolved.issues.length) throw new Error(at + resolved.issues.map((i) => `${i.code}: ${i.message}`).join("; "));
  const v = validateScene(resolved.scene, registry);
  if (!v.ok) throw new Error(at + v.issues.slice(0, 5).map((i) => `${i.code}: ${i.message}`).join("; "));
  durations.push(v.scene.meta.duration);
}

await mkdir(dir, { recursive: true });
await rm(join(dir, "movie.json"), { force: true });
await rm(join(dir, "scene.json"), { force: true });
await rm(join(dir, "scenes"), { recursive: true, force: true });
let duration: number;
if (built.kind === "scene") {
  duration = durations[0]!;
  await writeFile(join(dir, "scene.json"), `${JSON.stringify(built.scene, null, 2)}\n`, "utf8");
} else {
  const movie = MovieSchema.parse(built.movie);
  const { timeline, issues: ti } = movieTimeline(movie.scenes.map((e, i) => ({ id: e.id, duration: durations[i]!, transition: e.transition })), movie.meta.fps);
  if (ti.length) throw new Error(ti.map((i) => i.message).join("; "));
  duration = timeline.duration;
  await mkdir(join(dir, "scenes"), { recursive: true });
  for (const sc of built.scenes) await writeFile(join(dir, sc.file), `${JSON.stringify(sc.scene, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "movie.json"), `${JSON.stringify(built.movie, null, 2)}\n`, "utf8");
}
if (resolve(file) !== join(dir, "story.json")) await writeFile(join(dir, "story.json"), `${JSON.stringify(story, null, 2)}\n`, "utf8");
await writeFile(
  join(dir, "project.json"),
  `${JSON.stringify({ id: project, name: story.title[lang], description: story.summary[lang], commercial: false, source: { kind: "story", lang } }, null, 2)}\n`,
  "utf8",
);
console.log(`✓ ${built.kind === "movie" ? `${built.scenes.length} cảnh` : "Scene"} hợp lệ (${duration}s) → projects/${project}`);
console.log(`  render: npm run render -- projects/${project}`);

process.exit(0); // Piper giữ tiến trình con – thoát hẳn khi xong
