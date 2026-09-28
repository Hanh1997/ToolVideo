import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAudioFilter, buildEncodeArgs, duckExpression, parseLoudnessMeasure } from "../cli/ffmpeg";
import { wavDuration } from "../server/tts/piperTts";
import { computeAudioSegments, computeDucking, duckGainAt } from "../src/engine/AudioTimeline";
import { activeSubtitle, buildSrt } from "../src/engine/Subtitles";
import { needsResolve, resolveScene, type Synthesize } from "../src/tts/resolveScene";
import { validateScene } from "../src/validation/validateScene";
import { registry } from "./helpers";

const root = resolve(import.meta.dirname, "..");
const hello = JSON.parse(readFileSync(resolve(root, "projects/demo-robot-hello/scene.json"), "utf8")) as Record<string, unknown>;

/** TTS giả: 0.1s mỗi ký tự, không đụng tới Piper. */
const calls: string[] = [];
const fakeTts: Synthesize = async ({ text, rate }) => {
  calls.push(text);
  return { file: `tts/${text.length}.wav`, duration: Math.round(text.length * 0.1 * (1 / rate) * 1000) / 1000, cached: false };
};

async function resolved(raw: unknown = hello) {
  const r = await resolveScene(raw, registry, fakeTts);
  expect(r.issues).toEqual([]);
  const v = validateScene(r.scene, registry);
  if (!v.ok) throw new Error(JSON.stringify(v.issues, null, 2));
  return v.scene;
}

describe("resolveScene", () => {
  it("needsResolve nhận ra dialogue / sync / duration auto", () => {
    expect(needsResolve(hello)).toBe(true);
    expect(needsResolve({ meta: { duration: 5 }, actions: [] })).toBe(false);
    expect(needsResolve({ meta: { duration: "auto" } })).toBe(true);
  });

  it("start 'after' nối sau câu trước + gap, dùng rate mặc định của giọng", async () => {
    const s = await resolved();
    const [l1, l2, l3] = s.dialogue;
    const rate = registry.assets.find((a) => a.id === "voice_vi_female")!.defaultRate!;
    expect(l1!.rate).toBe(rate);
    expect(l2!.start).toBeCloseTo(l1!.start + l1!.duration + 0.5, 3);
    expect(l3!.start).toBeCloseTo(l2!.start + l2!.duration + 0.6, 3);
  });

  it("action sync: start/duration theo câu thoại (offset, pad)", async () => {
    const s = await resolved();
    const l1 = s.dialogue[0]!;
    const wave = s.actions.find((a) => a.id === "anim_wave")!;
    expect(wave.start).toBeCloseTo(l1.start - 0.3, 3);
    expect(wave.duration).toBeCloseTo(l1.duration + 0.2 + 0.3, 3);
  });

  it("audio sync at:end → phát ngay khi câu kết thúc", async () => {
    const s = await resolved();
    const l3 = s.dialogue[2]!;
    expect(s.audio.find((a) => a.id === "sfx_end")!.start).toBeCloseTo(l3.start + l3.duration + 0.1, 3);
  });

  it("duration auto: không tính camera, camera bị cắt ở cuối video", async () => {
    const s = await resolved();
    const cam = s.actions.find((a) => a.id === "cam_close")!;
    expect(cam.start + cam.duration).toBeCloseTo(s.meta.duration, 3);
    const chime = s.audio.find((a) => a.id === "sfx_end")!;
    expect(s.meta.duration).toBeCloseTo(Math.ceil((chime.start + 1.6 + 1.5) * 10) / 10, 3);
  });

  it("after trỏ tới câu không tồn tại → DialogueOrder", async () => {
    const raw = { ...hello, dialogue: [{ id: "x", text: "a", start: { after: "nope" } }] };
    const r = await resolveScene(raw, registry, fakeTts);
    expect(r.issues.map((i) => i.code)).toContain("DialogueOrder");
  });

  it("sync tới câu không tồn tại → TargetNotFound", async () => {
    const raw = { ...hello, actions: [{ id: "a", type: "animation", target: "robot", clip: "Wave", sync: { line: "zzz" } }] };
    const r = await resolveScene(raw, registry, fakeTts);
    expect(r.issues.map((i) => i.code)).toContain("TargetNotFound");
  });

  it("giọng không có / sai loại → AssetNotFound / AssetTypeMismatch", async () => {
    const bad = (voice: string) => ({ ...hello, dialogue: [{ id: "x", text: "a", start: 0, voice }] });
    expect((await resolveScene(bad("voice_en"), registry, fakeTts)).issues.map((i) => i.code)).toContain("AssetNotFound");
    expect((await resolveScene(bad("music_happy"), registry, fakeTts)).issues.map((i) => i.code)).toContain("AssetTypeMismatch");
  });

  it("TTS lỗi → TtsFailed", async () => {
    const failing: Synthesize = () => Promise.reject(new Error("boom"));
    const r = await resolveScene(hello, registry, failing);
    expect(r.issues.map((i) => i.code)).toContain("TtsFailed");
  });

  it("không sửa object đầu vào", async () => {
    const copy = structuredClone(hello);
    await resolveScene(hello, registry, fakeTts);
    expect(hello).toEqual(copy);
  });
});

describe("validate dialogue", () => {
  it("hai câu cùng người nói chồng nhau → DialogueOverlap", async () => {
    const s = await resolved();
    const lines = s.dialogue.map((l, i) => (i === 1 ? { ...l, start: s.dialogue[0]!.start + 0.1 } : l));
    const r = validateScene({ ...s, dialogue: lines }, registry);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("DialogueOverlap");
  });

  it("câu vượt thời lượng → DialogueOutOfRange", async () => {
    const s = await resolved();
    const r = validateScene({ ...s, meta: { ...s.meta, duration: 2 } }, registry);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("DialogueOutOfRange");
  });

  it("speaker không tồn tại → TargetNotFound", async () => {
    const s = await resolved();
    const r = validateScene({ ...s, dialogue: [{ ...s.dialogue[0]!, speaker: "cat" }] }, registry);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("TargetNotFound");
  });
});

describe("subtitles", () => {
  it("SRT đúng định dạng thời gian và thứ tự", async () => {
    const s = await resolved();
    const srt = buildSrt(s);
    expect(srt.startsWith("1\n00:00:00,600 --> ")).toBe(true);
    expect(srt).toContain("Xin chào các bạn nhỏ!");
    expect(srt.match(/-->/g)).toHaveLength(3);
  });

  it("activeSubtitle theo thời gian", async () => {
    const s = await resolved();
    expect(activeSubtitle(s, 0.1)).toBeUndefined();
    expect(activeSubtitle(s, s.dialogue[1]!.start + 0.01)?.id).toBe("l2");
  });
});

describe("ducking", () => {
  it("nhạc giảm khi có thoại, về 1 khi hết; gộp các câu gần nhau", async () => {
    const s = await resolved();
    const segs = computeAudioSegments(s, registry);
    expect(segs.filter((x) => x.kind === "voice")).toHaveLength(3);
    const d = computeDucking(s, segs)!;
    // Khoảng cách giữa các câu (0.5s, 0.6s) không nhỏ hơn 2·ramp (0.5s) → không gộp.
    expect(d.intervals).toHaveLength(3);
    const l1 = s.dialogue[0]!;
    expect(duckGainAt(d, l1.start + 0.5)).toBeCloseTo(0.3);
    expect(duckGainAt(d, 0)).toBe(1);
    expect(duckGainAt(d, l1.start - 0.125)).toBeCloseTo(0.65);
  });

  it("biểu thức FFmpeg khớp duckGainAt tại các điểm mẫu", async () => {
    const s = await resolved();
    const d = computeDucking(s, computeAudioSegments(s, registry))!;
    const expr = duckExpression(d);
    // Đánh giá biểu thức FFmpeg bằng JS (chỉ dùng clip/min/max/+-*/).
    const evalAt = (t: number) =>
      Function("t", "clip", "min", "max", `return ${expr};`)(
        t,
        (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)),
        Math.min,
        Math.max,
      ) as number;
    for (let t = 0; t < s.meta.duration; t += 0.137) expect(evalAt(t)).toBeCloseTo(duckGainAt(d, t), 6);
  });

  it("không có nhạc nền → không ducking", async () => {
    const s = await resolved();
    const noMusic = { ...s, audio: s.audio.filter((a) => a.kind !== "music") };
    expect(computeDucking(noMusic, computeAudioSegments(noMusic, registry))).toBeUndefined();
  });

  it("filter: ducking chỉ áp cho music, có loudnorm 2 pass, phụ đề mềm", async () => {
    const s = await resolved();
    const segments = computeAudioSegments(s, registry);
    const ducking = computeDucking(s, segments);
    const measured = { input_i: "-20.1", input_tp: "-3.2", input_lra: "4.0", input_thresh: "-30.5", target_offset: "0.2" };
    const f = buildAudioFilter({ segments, duration: s.meta.duration, ducking, loudness: -14, measured });
    expect(f.match(/volume=eval=frame/g)).toHaveLength(1);
    expect(f).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-20.1");
    expect(f).toContain("linear=true");
    const args = buildEncodeArgs({
      framesDir: "f",
      fps: 30,
      output: "o.mp4",
      audio: { segments, duration: s.meta.duration, assetsDir: "a", ducking, loudness: -14, measured },
      subtitlesFile: "o.srt",
    });
    expect(args[args.indexOf("-c:s") + 1]).toBe("mov_text");
    expect(args).toContain(`${segments.length + 1}:s`);
  });

  it("đọc kết quả đo loudnorm từ stderr", () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1] \n{\n"input_i" : "-16.30",\n"input_tp" : "-2.10",\n"input_lra" : "3.40",\n"input_thresh" : "-26.60",\n"output_i" : "-14.0",\n"target_offset" : "0.10"\n}\n`;
    expect(parseLoudnessMeasure(stderr)).toEqual({ input_i: "-16.30", input_tp: "-2.10", input_lra: "3.40", input_thresh: "-26.60", target_offset: "0.10" });
  });
});

describe("wavDuration", () => {
  it("đọc độ dài từ header WAV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-"));
    const rate = 22050;
    const n = rate * 2; // 2 giây mono 16-bit
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(n * 2, 40);
    const file = join(dir, "a.wav");
    writeFileSync(file, buf);
    expect(await wavDuration(file)).toBe(2);
  });
});
