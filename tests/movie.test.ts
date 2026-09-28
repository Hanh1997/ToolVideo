import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMovieEncodeArgs, buildMovieVideoFilter } from "../cli/ffmpeg";
import { SceneScriptSchema, type SceneScript } from "../src/schemas/scene.schema";
import { applyMovieDefaults, MovieSchema, movieAudioSegments, movieSubtitleCues, movieTimeline, type Transition } from "../src/movie/movie";
import { validateScene } from "../src/validation/validateScene";
import { fakeTts, registry } from "./helpers";
import { resolveScene } from "../src/tts/resolveScene";

const cut: Transition = { type: "cut", duration: 0.6 };
const fade = (duration: number): Transition => ({ type: "fade", duration });
const dissolve = (duration: number): Transition => ({ type: "dissolve", duration });

function scene(duration: number, extra: Partial<SceneScript> = {}): SceneScript {
  return SceneScriptSchema.parse({
    version: 1,
    meta: { name: "s", duration, fps: 30, width: 640, height: 360 },
    environment: { asset: "env_park" },
    characters: [],
    camera: { mode: "fixed", position: { x: 0, y: 1, z: 5 }, lookAt: { x: 0, y: 0, z: 0 } },
    actions: [],
    ...extra,
  });
}

describe("movieTimeline", () => {
  it("cut nối liền, fade/dissolve chồng đúng thời gian chuyển cảnh", () => {
    const { timeline, issues } = movieTimeline(
      [
        { id: "a", duration: 5, transition: dissolve(1) },
        { id: "b", duration: 4, transition: cut },
        { id: "c", duration: 6, transition: fade(0.5) },
      ],
      30,
    );
    expect(issues).toEqual([]);
    expect(timeline.scenes.map((s) => s.start)).toEqual([0, 5, 8.5]);
    // Cảnh đầu luôn là cut dù khai báo dissolve.
    expect(timeline.scenes[0]!.transition).toEqual({ type: "cut", duration: 0 });
    expect(timeline.scenes[2]!.transition).toEqual({ type: "fade", duration: 0.5 });
    expect(timeline.duration).toBe(14.5);
  });

  it("làm tròn độ dài theo frame", () => {
    const { timeline } = movieTimeline([{ id: "a", duration: 1.01, transition: cut }], 30);
    expect(timeline.scenes[0]!.frames).toBe(30);
    expect(timeline.scenes[0]!.duration).toBe(1);
  });

  it("báo lỗi chuyển cảnh dài hơn cảnh và id trùng", () => {
    const { issues } = movieTimeline(
      [
        { id: "a", duration: 3, transition: cut },
        { id: "a", duration: 1, transition: dissolve(0.8) },
        { id: "c", duration: 3, transition: fade(0.8) },
      ],
      30,
    );
    expect(issues.map((i) => i.code).sort()).toEqual(["DuplicateId", "TransitionTooLong"]);
  });
});

describe("movie audio & phụ đề", () => {
  const timelineOf = (scenes: SceneScript[], transitions: Transition[]) =>
    movieTimeline(
      scenes.map((s, i) => ({ id: `s${i}`, duration: s.meta.duration, transition: transitions[i]! })),
      30,
    ).timeline;

  it("dời audio theo cảnh, fade ở biên chuyển cảnh, nhạc chung chạy hết phim", () => {
    const a = scene(4, { audio: [{ id: "m", kind: "music", asset: "music_happy", start: 0, loop: true, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] });
    const b = scene(4, { audio: [{ id: "x", kind: "sfx", asset: "sfx_chime", start: 1, loop: false, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] });
    const timeline = timelineOf([a, b], [cut, dissolve(1)]);
    const movieAudio = MovieSchema.shape.audio.parse([{ id: "bgm", kind: "music", asset: "music_happy", start: 0, loop: true }]);
    const segs = movieAudioSegments({ audio: movieAudio }, [a, b], timeline, registry);

    const m = segs.find((s) => s.id === "s0/m")!;
    expect([m.start, m.end, m.fadeOut]).toEqual([0, 4, 1]);
    const x = segs.find((s) => s.id === "s1/x")!;
    expect(x.start).toBe(4); // cảnh 2 bắt đầu ở 3s (chồng 1s) + 1s
    expect(x.fadeIn).toBe(0); // không chạm biên cảnh
    const bgm = segs.find((s) => s.id === "bgm")!;
    expect([bgm.start, bgm.end]).toEqual([0, 7]);
  });

  it("phụ đề gộp theo mốc thời gian phim", async () => {
    const raw = {
      version: 1,
      meta: { name: "s", duration: "auto", fps: 30, width: 640, height: 360 },
      environment: { asset: "env_park" },
      characters: [{ id: "g", asset: "char_q_casual2_female", position: { x: 0, y: 0, z: 0 }, voice: "voice_vi_female" }],
      camera: { mode: "fixed", position: { x: 0, y: 1, z: 5 }, lookAt: { x: 0, y: 0, z: 0 } },
      actions: [],
      dialogue: [{ id: "l1", speaker: "g", text: "Xin chào các bạn", start: 0.5 }],
    };
    const r = await resolveScene(raw, registry, fakeTts);
    const v = validateScene(r.scene, registry);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const s = v.scene;
    const timeline = timelineOf([s, s], [cut, fade(0.5)]);
    const cues = movieSubtitleCues([s, s], timeline);
    expect(cues).toHaveLength(2);
    expect(cues[1]!.start).toBeCloseTo(timeline.scenes[1]!.start + 0.5, 6);
  });
});

describe("movie schema", () => {
  it("demo-movie-journey hợp lệ; mỗi cảnh cần file hoặc scene", () => {
    const raw: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, "../projects/demo-movie-journey/movie.json"), "utf8"));
    const movie = MovieSchema.parse(raw);
    expect(movie.scenes.map((s) => s.transition.type)).toEqual(["cut", "fade", "dissolve"]);
    const bad = MovieSchema.safeParse({ ...movie, scenes: [{ id: "x" }] });
    expect(bad.success).toBe(false);
  });

  it("applyMovieDefaults áp kích thước/fps/phụ đề của movie", () => {
    const movie = MovieSchema.parse({
      version: 1,
      meta: { name: "M", fps: 24, width: 720, height: 1280 },
      scenes: [{ id: "a", scene: {} }],
      subtitles: { burnIn: true, size: 0.06, position: "top", showSpeaker: true },
    });
    const out = applyMovieDefaults({ meta: { name: "A", duration: 3, fps: 30, width: 1280, height: 720 } }, movie, movie.scenes[0]!);
    expect(out.meta).toMatchObject({ name: "A", duration: 3, fps: 24, width: 720, height: 1280 });
    expect(out.subtitles).toMatchObject({ position: "top" });
  });
});

describe("movie ffmpeg", () => {
  it("cut → concat, fade → fadeblack, dissolve → fade với offset tích lũy", () => {
    const f = buildMovieVideoFilter(
      [
        { file: "a.mp4", duration: 5, transition: { type: "cut", duration: 0 } },
        { file: "b.mp4", duration: 4, transition: { type: "dissolve", duration: 1 } },
        { file: "c.mp4", duration: 3, transition: { type: "cut", duration: 0 } },
        { file: "d.mp4", duration: 3, transition: { type: "fade", duration: 0.5 } },
      ],
      30,
    );
    expect(f).toContain("[c0][c1]xfade=transition=fade:duration=1:offset=4[v1]");
    expect(f).toContain("[v1][c2]concat=n=2:v=1:a=0[v2]");
    expect(f).toContain("[v2][c3]xfade=transition=fadeblack:duration=0.5:offset=10.5[vout]");
  });

  it("một clip vẫn ra [vout]; audio đánh số input sau các clip", () => {
    const args = buildMovieEncodeArgs({
      clips: [{ file: "a.mp4", duration: 2, transition: { type: "cut", duration: 0 } }],
      fps: 30,
      output: "out.mp4",
      audio: {
        segments: [{ id: "m", kind: "music", file: "audio/m.mp3", fileDuration: 8, start: 0, end: 2, offset: 0, loop: false, volume: 1, fadeIn: 0, fadeOut: 0 }],
        duration: 2,
        assetsDir: "assets",
      },
    });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[c0]null[vout]");
    expect(filter).toContain("[1:a]atrim");
    expect(args).toContain("[aout]");
    expect(args.at(-1)).toBe("out.mp4");
  });
});
