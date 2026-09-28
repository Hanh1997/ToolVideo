import { describe, expect, it } from "vitest";
import { registry, resolvedDemo } from "./helpers";
import { buildAudioFilter, buildEncodeArgs } from "../cli/ffmpeg";
import { computeAudioSegments, segmentFileTime, segmentGainAt } from "../src/engine/AudioTimeline";
import { SceneScriptSchema } from "../src/schemas/scene.schema";
import { validateScene, type SceneErrorCode } from "../src/validation/validateScene";

const demo = await resolvedDemo("demo-robot-park");

function sceneWith(audio: unknown[]) {
  return SceneScriptSchema.parse({ ...demo, audio, dialogue: [] });
}

function codes(audio: unknown[]): SceneErrorCode[] {
  const r = validateScene({ ...demo, audio, dialogue: [] }, registry);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe("computeAudioSegments", () => {
  it("sfx không loop: dài bằng file", () => {
    const [seg] = computeAudioSegments(sceneWith([{ id: "a", kind: "sfx", asset: "sfx_chime", start: 2 }]), registry);
    expect(seg).toMatchObject({ start: 2, end: 3.6, offset: 0, loop: false });
  });

  it("loop không có duration: kéo tới cuối video", () => {
    const [seg] = computeAudioSegments(sceneWith([{ id: "m", kind: "music", asset: "music_happy", start: 1, loop: true }]), registry);
    expect(seg!.end).toBe(12);
  });

  it("cắt ở cuối video", () => {
    const [seg] = computeAudioSegments(sceneWith([{ id: "a", kind: "sfx", asset: "sfx_chime", start: 11 }]), registry);
    expect(seg!.end).toBe(12);
  });

  it("trimStart làm ngắn đoạn không loop", () => {
    const [seg] = computeAudioSegments(sceneWith([{ id: "a", kind: "sfx", asset: "sfx_chime", start: 0, trimStart: 1 }]), registry);
    expect(seg!.end).toBeCloseTo(0.6);
    expect(seg!.offset).toBe(1);
  });

  it("duration không vượt độ dài file khi không loop", () => {
    const [seg] = computeAudioSegments(sceneWith([{ id: "a", kind: "sfx", asset: "sfx_boing", start: 0, duration: 5 }]), registry);
    expect(seg!.end).toBe(0.5);
  });

  it("fade in/out và vị trí trong file khi loop", () => {
    const [seg] = computeAudioSegments(
      sceneWith([{ id: "m", kind: "music", asset: "music_happy", start: 0, loop: true, volume: 0.5, fadeIn: 1, fadeOut: 2 }]),
      registry,
    );
    expect(segmentGainAt(seg!, 0.5)).toBeCloseTo(0.25);
    expect(segmentGainAt(seg!, 5)).toBeCloseTo(0.5);
    expect(segmentGainAt(seg!, 11)).toBeCloseTo(0.25);
    expect(segmentGainAt(seg!, 12)).toBe(0);
    expect(segmentFileTime(seg!, 9)).toBeCloseTo(1); // file 8s lặp
  });
});

describe("validate audio", () => {
  it("demo hợp lệ", () => expect(codes(demo.audio as unknown[])).toEqual([]));
  it("asset lạ → AssetNotFound", () => expect(codes([{ id: "a", kind: "sfx", asset: "sfx_bark", start: 0 }])).toContain("AssetNotFound"));
  it("dùng GLB làm audio → AssetTypeMismatch", () =>
    expect(codes([{ id: "a", kind: "sfx", asset: "prop_log", start: 0 }])).toContain("AssetTypeMismatch"));
  it("bắt đầu sau khi video kết thúc → AudioOutOfRange", () =>
    expect(codes([{ id: "a", kind: "sfx", asset: "sfx_boing", start: 12 }])).toContain("AudioOutOfRange"));
  it("trimStart quá độ dài file → AudioOutOfRange", () =>
    expect(codes([{ id: "a", kind: "sfx", asset: "sfx_boing", start: 0, trimStart: 1 }])).toContain("AudioOutOfRange"));
  it("trùng id → DuplicateId", () =>
    expect(
      codes([
        { id: "a", kind: "sfx", asset: "sfx_boing", start: 0 },
        { id: "a", kind: "sfx", asset: "sfx_land", start: 1 },
      ]),
    ).toContain("DuplicateId"));
});

describe("ffmpeg audio", () => {
  const segments = computeAudioSegments(
    sceneWith([
      { id: "m", kind: "music", asset: "music_happy", start: 0, loop: true, volume: 0.4, fadeOut: 1.5 },
      { id: "s", kind: "sfx", asset: "sfx_boing", start: 7 },
    ]),
    registry,
  );

  it("filter: delay theo ms, fade out đúng vị trí, mix + pad", () => {
    const f = buildAudioFilter({ segments, duration: 12 });
    expect(f).toContain("[1:a]atrim=start=0:duration=12");
    expect(f).toContain("afade=t=out:st=10.5:d=1.5");
    expect(f).toContain("[2:a]");
    expect(f).toContain("adelay=delays=7000:all=1");
    expect(f).toContain("amix=inputs=2:normalize=0");
    expect(f).toContain("apad=whole_dur=12[aout]");
  });

  it("args: loop dùng -stream_loop, map video + audio, cắt đúng thời lượng", () => {
    const args = buildEncodeArgs({ framesDir: "f", fps: 30, output: "o.mp4", audio: { segments, duration: 12, assetsDir: "assets" } });
    expect(args.indexOf("-stream_loop")).toBeLessThan(args.indexOf("-filter_complex"));
    expect(args).toContain("[aout]");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-t") + 1]).toBe("12");
  });

  it("không có audio → không có audio args", () => {
    const args = buildEncodeArgs({ framesDir: "f", fps: 30, output: "o.mp4", audio: { segments: [], duration: 12, assetsDir: "a" } });
    expect(args).not.toContain("-filter_complex");
    expect(args).not.toContain("-c:a");
  });
});
