import { describe, expect, it } from "vitest";
import { envelopeFromPcm, evaluatePerformance, LIPSYNC_RATE, speechLevel } from "../src/engine/Speech";
import { SceneScriptSchema } from "../src/schemas/scene.schema";

describe("envelope giọng nói", () => {
  it("im lặng → 0, có tiếng → gần 1, đúng số mẫu theo LIPSYNC_RATE", () => {
    const rate = 16000;
    const pcm = new Float32Array(rate); // 1 giây: nửa đầu im lặng, nửa sau sóng sin
    for (let i = rate / 2; i < rate; i++) pcm[i] = 0.5 * Math.sin((i / rate) * 2 * Math.PI * 220);
    const env = envelopeFromPcm(pcm, rate);
    expect(env).toHaveLength(LIPSYNC_RATE);
    expect(env[2]).toBe(0);
    expect(env[20]).toBeGreaterThan(0.9);
  });

  it("speechLevel nội suy envelope, 0 ngoài câu", () => {
    const line = { id: "a", text: "x", start: 1, duration: 0.2, file: "f.wav", voice: "v", rate: 1, volume: 1, subtitle: true, emotion: "neutral" as const, lipsync: [0, 1, 0, 1, 0] };
    expect(speechLevel(line, 0.5)).toBe(0);
    expect(speechLevel(line, 1 + 1 / LIPSYNC_RATE)).toBeCloseTo(1, 6);
    expect(speechLevel(line, 1 + 0.5 / LIPSYNC_RATE)).toBeCloseTo(0.5, 6);
    expect(speechLevel(line, 1.3)).toBe(0);
  });
});

describe("diễn khi nói", () => {
  const scene = SceneScriptSchema.parse({
    version: 1,
    meta: { name: "t", duration: 10, fps: 30, width: 640, height: 360 },
    environment: { asset: "env_park" },
    characters: ["a", "b", "c"].map((id, i) => ({ id, asset: "char_k_animal_fox", position: { x: i, y: 0, z: 0 } })),
    camera: { mode: "fixed", position: { x: 0, y: 1, z: 5 }, lookAt: { x: 0, y: 0, z: 0 } },
    actions: [],
    dialogue: [
      { id: "l1", speaker: "a", text: "xin chào", start: 1, duration: 1, file: "f.wav", voice: "v" },
      { id: "l2", text: "người dẫn chuyện", start: 2.5, duration: 1, file: "g.wav", voice: "v" },
      { id: "l3", speaker: "c", text: "chào bạn", start: 6, duration: 1, file: "h.wav", voice: "v" },
    ],
  });

  it("người nói có mức nói, người nghe nhìn về người nói (chuyển mượt)", () => {
    const p = evaluatePerformance(scene, 1.5);
    expect(p.get("a")!.talk).toBeGreaterThan(0);
    // Người nói quay một phần về người đáp lời kế tiếp (c).
    expect(p.get("a")!.lookAt).toEqual({ character: "c", weight: 0.6 });
    expect(p.get("b")!.lookAt).toEqual({ character: "a", weight: 1 });
    expect(evaluatePerformance(scene, 1.05).get("b")!.lookAt!.weight).toBeLessThan(1);
  });

  it("trước câu đầu không ai nhìn; lời dẫn chuyện không đổi hướng nhìn; hết giữ thì thôi nhìn", () => {
    expect(evaluatePerformance(scene, 0.5).get("b")!.lookAt).toBeUndefined();
    // l2 là người dẫn chuyện → vẫn nhìn người vừa nói (a) trong LOOK_HOLD
    expect(evaluatePerformance(scene, 2.6).get("b")!.lookAt?.character).toBe("a");
    expect(evaluatePerformance(scene, 5).get("b")!.lookAt).toBeUndefined();
    expect(evaluatePerformance(scene, 6.5).get("a")!.lookAt?.character).toBe("c");
  });

  it("người nói quay về người được nói với (to), người nghe gật đầu và lây cảm xúc", () => {
    const sc = SceneScriptSchema.parse({
      ...scene,
      dialogue: [
        { id: "l1", speaker: "a", to: "b", text: "vui quá", emotion: "happy", start: 1, duration: 3, file: "f.wav", voice: "v" },
        { id: "l2", speaker: "c", text: "ừ", start: 5, duration: 1, file: "g.wav", voice: "v" },
      ],
    });
    expect(evaluatePerformance(sc, 2).get("a")!.lookAt?.character).toBe("b");
    const nods = Array.from({ length: 60 }, (_, i) => evaluatePerformance(sc, 1 + i * 0.05).get("b")!.nod ?? 0);
    expect(Math.max(...nods)).toBeGreaterThan(3);
    expect(evaluatePerformance(sc, 1.1).get("b")!.emotion).toBeUndefined(); // phản ứng trễ một nhịp
    expect(evaluatePerformance(sc, 2.5).get("b")!.emotion).toMatchObject({ kind: "happy" });
    expect(evaluatePerformance(sc, 2.5).get("b")!.emotion!.weight).toBeLessThan(0.6);
  });
});
