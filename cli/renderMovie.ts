/**
 * Render movie (nhiều khung cảnh → một MP4):
 *
 *   loadMovie()     → đọc movie.json + scene của từng cảnh
 *   prepareMovie()  → resolve/validate từng scene (TTS…) + tính mốc thời gian, chuyển cảnh
 *   renderMovie()   → mỗi cảnh một clip chỉ có hình (cache theo hash, trong renders/.clips)
 *                     → FFmpeg ghép clip (cut / fade / dissolve) + audio toàn phim + phụ đề gộp
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { computeDucking } from "../src/engine/AudioTimeline";
import { formatSrt } from "../src/engine/Subtitles";
import { findAsset } from "../src/schemas/asset.schema";
import {
  applyMovieDefaults,
  MovieSchema,
  movieAudioSegments,
  movieSubtitleCues,
  movieTimeline,
  type Movie,
  type MovieTimeline,
} from "../src/movie/movie";
import { collectAttributions } from "../src/validation/validateScene";
import { buildMovieEncodeArgs, runFfmpeg } from "./ffmpeg";
import {
  checkAudioFiles,
  mixAudio,
  prepareScene,
  RenderFailure,
  renderScene,
  ROOT,
  type Logger,
  type PreparedScene,
  type RenderEnv,
  type RenderRecord,
  type SceneOverrides,
} from "./renderJob";

/** Clip trung gian gần như không mất chất lượng (được encode lại một lần khi ghép). */
const CLIP_CRF = 12;
const CLIP_PRESET = "veryfast";

export interface LoadedMovie {
  movie: Movie;
  /** Scene thô (chưa resolve) của từng cảnh, cùng thứ tự với movie.scenes. */
  scenes: unknown[];
}

export async function loadMovie(projectDir: string): Promise<LoadedMovie> {
  const raw: unknown = JSON.parse(await readFile(join(projectDir, "movie.json"), "utf8"));
  return parseMovie(raw, projectDir);
}

export async function parseMovie(raw: unknown, projectDir: string): Promise<LoadedMovie> {
  const parsed = MovieSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ code: "InvalidSchema", message: i.message, path: i.path.join(".") }));
    throw new RenderFailure("InvalidMovie", issues.map((i) => `${i.message} @ ${i.path}`).join("\n"), issues);
  }
  const movie = parsed.data;
  const root = resolve(projectDir);
  const scenes = await Promise.all(
    movie.scenes.map(async (entry, i) => {
      if (entry.scene) return entry.scene;
      const file = resolve(root, entry.file!);
      if (file !== root && !file.startsWith(root + sep)) {
        throw new RenderFailure("InvalidMovie", `Cảnh "${entry.id}": file phải nằm trong thư mục project (scenes.${i}.file)`);
      }
      try {
        return JSON.parse(await readFile(file, "utf8")) as unknown;
      } catch (err) {
        throw new RenderFailure("InvalidMovie", `Cảnh "${entry.id}": không đọc được ${entry.file} (${err instanceof Error ? err.message : String(err)})`);
      }
    }),
  );
  return { movie, scenes };
}

export interface PreparedMovie {
  movie: Movie;
  scenes: PreparedScene[];
  timeline: MovieTimeline;
}

/** Resolve + validate mọi cảnh (lỗi gắn tiền tố "scenes.<id>") rồi tính timeline. */
export async function prepareMovie(env: RenderEnv, loaded: LoadedMovie, overrides: SceneOverrides = {}, log: Logger = () => undefined): Promise<PreparedMovie> {
  const movie: Movie = { ...loaded.movie, meta: { ...loaded.movie.meta, ...definedOnly(overrides) } };
  const scenes: PreparedScene[] = [];
  const issues: { code: string; message: string; path?: string }[] = [];
  for (const [i, entry] of movie.scenes.entries()) {
    try {
      scenes.push(await prepareScene(env, applyMovieDefaults(loaded.scenes[i], movie, entry), {}, (m) => log(`[${entry.id}] ${m}`)));
    } catch (err) {
      if (!(err instanceof RenderFailure)) throw err;
      const list = (err.issues as { code: string; message: string; path?: string }[] | undefined) ?? [{ code: err.code, message: err.message }];
      issues.push(...list.map((x) => ({ ...x, path: `scenes.${entry.id}${x.path ? `.${x.path}` : ""}` })));
    }
  }
  if (issues.length) throw new RenderFailure("InvalidMovie", issues.map((i) => `${i.code}: ${i.message} @ ${i.path}`).join("\n"), issues);

  const { timeline, issues: timingIssues } = movieTimeline(
    movie.scenes.map((e, i) => ({ id: e.id, duration: scenes[i]!.scene.meta.duration, transition: e.transition })),
    movie.meta.fps,
  );
  if (timingIssues.length) throw new RenderFailure("InvalidMovie", timingIssues.map((i) => `${i.code}: ${i.message}`).join("\n"), timingIssues);
  const audioIssue = movie.audio.find((t) => findAsset(env.registry, t.asset)?.type !== "audio");
  if (audioIssue) throw new RenderFailure("InvalidMovie", `Audio "${audioIssue.id}": "${audioIssue.asset}" không phải asset audio`);
  return { movie, scenes, timeline };
}

function definedOnly(o: SceneOverrides): Partial<Movie["meta"]> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Movie["meta"]>;
}

export interface MovieRenderOptions {
  projectId: string;
  output: string;
  crf?: number;
  keepFrames?: boolean;
  isCancelled?: () => boolean;
  log?: Logger;
}

/** Render movie. Không ném lỗi: trạng thái nằm trong record (Completed/Failed/Cancelled). */
export async function renderMovie(env: RenderEnv, pm: PreparedMovie, o: MovieRenderOptions): Promise<RenderRecord> {
  const log = o.log ?? (() => undefined);
  const { movie, timeline } = pm;
  const { width, height, fps } = movie.meta;
  const base = o.output.replace(/\.mp4$/i, "");
  const recordPath = `${base}.render.json`;
  const clipsDir = join(dirname(o.output), ".clips");
  const started = Date.now();
  const totalFrames = timeline.scenes.reduce((n, s) => n + s.frames, 0);

  const record: RenderRecord = {
    id: new Date(started).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19),
    project: o.projectId,
    status: "Processing",
    progress: 0,
    currentFrame: 0,
    totalFrames,
    width,
    height,
    fps,
    duration: timeline.duration,
    output: relative(ROOT, o.output).replaceAll("\\", "/"),
    audioTracks: 0,
    dialogueLines: pm.scenes.reduce((n, s) => n + s.scene.dialogue.length, 0),
    scenes: timeline.scenes.map((s) => ({ id: s.id, start: s.start, duration: s.duration, transition: s.transition.type, cached: false })),
    startedAt: new Date(started).toISOString(),
  };
  await mkdir(clipsDir, { recursive: true });
  let lastSave = 0;
  const save = async (force = false) => {
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  };
  await save(true);

  try {
    const segments = movieAudioSegments(movie, pm.scenes.map((s) => s.scene), timeline, env.registry);
    await checkAudioFiles(segments);
    record.audioTracks = segments.length;

    // 1. Clip hình của từng cảnh.
    const clips: string[] = [];
    let doneFrames = 0;
    for (const [i, prepared] of pm.scenes.entries()) {
      const t = timeline.scenes[i]!;
      const clip = join(clipsDir, `${t.id}_${width}x${height}_${fps}.mp4`);
      log(`Cảnh ${i + 1}/${pm.scenes.length} "${t.id}" (${prepared.scene.environment.asset}, ${t.duration}s)`);
      const { record: clipRecord, skipped } = await renderScene(env, prepared, {
        projectId: `${o.projectId}/${t.id}`,
        output: clip,
        crf: CLIP_CRF,
        preset: CLIP_PRESET,
        videoOnly: true,
        skipUnchanged: true,
        keepFrames: o.keepFrames,
        isCancelled: o.isCancelled,
        onFrame: (current) => {
          record.currentFrame = doneFrames + current;
          record.progress = Math.round((record.currentFrame / totalFrames) * 90);
          void save();
        },
        log: (m) => log(`[${t.id}] ${m}`),
      });
      if (clipRecord.status !== "Completed") {
        const err = clipRecord.error ?? { code: "RenderFailed", message: clipRecord.status };
        throw new RenderFailure(err.code, `Cảnh "${t.id}": ${err.message}`, err.issues);
      }
      if (skipped) log(`[${t.id}] Không đổi – dùng lại clip đã render`);
      record.scenes![i]!.cached = skipped;
      record.gpu ??= clipRecord.gpu;
      doneFrames += t.frames;
      record.currentFrame = doneFrames;
      record.progress = Math.round((doneFrames / totalFrames) * 90);
      await save(true);
      clips.push(clip);
    }
    if (o.isCancelled?.()) throw new RenderFailure("Cancelled", "Người dùng hủy");

    // 2. Audio toàn phim + phụ đề gộp.
    log(`Ghép ${clips.length} cảnh → ${timeline.duration}s`);
    const audio = await mixAudio(segments, timeline.duration, computeDucking(movie, segments), movie.mix.loudness, record, log);
    const cues = movieSubtitleCues(pm.scenes.map((s) => s.scene), timeline);
    let subtitlesFile: string | undefined;
    if (cues.length) {
      subtitlesFile = `${base}.srt`;
      await writeFile(subtitlesFile, formatSrt(cues), "utf8");
    }

    // 3. Ghép.
    await runFfmpeg(
      buildMovieEncodeArgs({
        clips: clips.map((file, i) => ({ file, duration: timeline.scenes[i]!.duration, transition: timeline.scenes[i]!.transition })),
        fps,
        output: o.output,
        crf: o.crf,
        audio,
        subtitlesFile,
      }),
    );

    const attributions = new Set(pm.scenes.flatMap((s) => collectAttributions(s.scene, env.registry)));
    for (const track of movie.audio) {
      const a = findAsset(env.registry, track.asset);
      if (a) attributions.add(`${a.name} – ${a.author} – ${a.license} – ${a.source}`);
    }
    await writeFile(`${base}.ATTRIBUTIONS.txt`, `${[...attributions].join("\n")}\n`, "utf8");

    record.status = "Completed";
    record.progress = 100;
  } catch (err) {
    const code = err instanceof RenderFailure ? err.code : err instanceof Error && "code" in err ? String(err.code) : "RenderFailed";
    record.status = code === "Cancelled" ? "Cancelled" : "Failed";
    record.error = { code, message: err instanceof Error ? err.message : String(err), issues: err instanceof RenderFailure ? err.issues : undefined };
  } finally {
    record.completedAt = new Date().toISOString();
    record.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
    await save(true).catch(() => undefined);
  }
  return record;
}

/** Bản đã resolve của cả movie (scene inline) – để tái lập / kiểm tra. */
export function resolvedMovieJson(pm: PreparedMovie): unknown {
  return { ...pm.movie, scenes: pm.movie.scenes.map((e, i) => ({ id: e.id, transition: e.transition, scene: pm.scenes[i]!.input })) };
}
