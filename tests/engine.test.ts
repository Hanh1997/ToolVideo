import { describe, expect, it } from "vitest";
import { evaluateAnimation } from "../src/engine/AnimationEngine";
import { evaluateCamera } from "../src/engine/CameraEngine";
import { evaluateTransform, type CharacterTransform } from "../src/engine/MovementEngine";
import { formatTime, frameTime, totalFrames } from "../src/engine/time";
import { ActionSchema, SceneScriptSchema, type Action, type SceneCharacter } from "../src/schemas/scene.schema";

const char: SceneCharacter = { id: "c", asset: "char_robot", position: { x: 0, y: 0, z: 0 }, heading: 0, scale: 1 };
const act = (a: unknown): Action => ActionSchema.parse(a);
const close = (v: number, expected: number) => expect(v).toBeCloseTo(expected, 5);

describe("time", () => {
  it("10s × 30fps = 300 frame", () => expect(totalFrames(10, 30)).toBe(300));
  it("1s × 30fps = 30 frame", () => expect(totalFrames(1, 30)).toBe(30));
  it("frame 3 @30fps = 0.1s", () => close(frameTime(3, 30), 0.1));
  it("format", () => expect(formatTime(3.25)).toBe("00:03.250"));
});

describe("MovementEngine", () => {
  const walk = act({ id: "m", type: "move", target: "c", start: 0, duration: 4, direction: "forward", speed: 2 });

  it("forward đi theo +Z khi heading 0", () => {
    const tr = evaluateTransform(char, [walk], 2);
    close(tr.position.x, 0);
    close(tr.position.z, 4);
  });

  it("dừng lại sau khi action kết thúc", () => {
    close(evaluateTransform(char, [walk], 10).position.z, 8);
  });

  it("left = quay +90° rồi đi theo +X", () => {
    const left = act({ id: "l", type: "move", target: "c", start: 0, duration: 1, direction: "left", speed: 1 });
    const tr = evaluateTransform(char, [left], 1);
    close(tr.position.x, 1);
    close(tr.heading, 90);
  });

  it("backward lùi, không quay người", () => {
    const back = act({ id: "b", type: "move", target: "c", start: 0, duration: 1, direction: "backward", speed: 1 });
    const tr = evaluateTransform(char, [back], 1);
    close(tr.position.z, -1);
    close(tr.heading, 0);
  });

  it("forward sau turn đi theo hướng mới", () => {
    const actions = [
      act({ id: "t", type: "turn", target: "c", start: 0, duration: 1, by: 90 }),
      act({ id: "m", type: "move", target: "c", start: 1, duration: 2, direction: "forward", speed: 1 }),
    ];
    const tr = evaluateTransform(char, actions, 3);
    close(tr.position.x, 2);
    close(tr.position.z, 0);
  });

  it("turn heading tuyệt đối đi đường ngắn nhất", () => {
    const tr = evaluateTransform({ ...char, heading: 170 }, [act({ id: "t", type: "turn", target: "c", start: 0, duration: 1, heading: -170 })], 1);
    close(tr.heading, 190);
  });

  it("moveTo tới đúng điểm cuối", () => {
    const tr = evaluateTransform(char, [act({ id: "m", type: "moveTo", target: "c", start: 1, duration: 2, to: { x: 3, z: 4 } })], 3);
    close(tr.position.x, 3);
    close(tr.position.z, 4);
  });

  it("path tốc độ đều theo độ dài cung", () => {
    const path = act({ id: "p", type: "path", target: "c", start: 0, duration: 2, points: [{ x: 0, z: 2 }, { x: 2, z: 2 }] });
    const mid = evaluateTransform(char, [path], 1);
    close(mid.position.x, 0);
    close(mid.position.z, 2);
    const end = evaluateTransform(char, [path], 2);
    close(end.position.x, 2);
    close(end.heading, 90);
  });

  it("jump đạt đỉnh ở giữa, về mặt đất khi kết thúc", () => {
    const jump = act({ id: "j", type: "jump", target: "c", start: 1, duration: 1, height: 0.8 });
    close(evaluateTransform(char, [jump], 1.5).position.y, 0.8);
    close(evaluateTransform(char, [jump], 2).position.y, 0);
  });

  it("tất định: kết quả không phụ thuộc thứ tự seek", () => {
    const a = evaluateTransform(char, [walk], 3.3);
    evaluateTransform(char, [walk], 0.5);
    const b = evaluateTransform(char, [walk], 3.3);
    expect(b).toEqual(a);
  });
});

describe("AnimationEngine", () => {
  const durations = { Idle: 2, Walking: 1, Running: 0.5 };
  const actions = [
    act({ id: "w", type: "animation", target: "c", start: 0, duration: 2, clip: "Walking" }),
    act({ id: "r", type: "animation", target: "c", start: 2, duration: 2, clip: "Running", fade: 0.5 }),
  ];

  it("clip đúng theo thời gian, loop theo mod", () => {
    const s = evaluateAnimation(actions, "c", 1.25, "Idle", durations);
    expect(s).toHaveLength(1);
    expect(s[0]!.clip).toBe("Walking");
    close(s[0]!.time, 0.25);
  });

  it("crossfade: tổng weight = 1", () => {
    const s = evaluateAnimation(actions, "c", 2.25, "Idle", durations);
    expect(s.map((x) => x.clip)).toEqual(["Walking", "Running"]);
    close(s.reduce((sum, x) => sum + x.weight, 0), 1);
    close(s[1]!.weight, 0.5);
  });

  it("khoảng trống → defaultClip", () => {
    const s = evaluateAnimation(actions, "c", 5, "Idle", durations);
    expect(s).toEqual([{ clip: "Idle", time: 1, weight: 1 }]);
  });

  it("không loop thì giữ frame cuối", () => {
    const once = [act({ id: "j", type: "animation", target: "c", start: 0, duration: 3, clip: "Running", loop: false })];
    expect(evaluateAnimation(once, "c", 2, undefined, durations)[0]!.time).toBeLessThan(0.5);
  });
});

describe("CameraEngine", () => {
  const scene = SceneScriptSchema.parse({
    version: 1,
    meta: { name: "t", duration: 10, fps: 30, width: 640, height: 360 },
    environment: { asset: "env" },
    characters: [char],
    camera: { mode: "follow", target: "c", offset: { x: 0, y: 2, z: -5 } },
    actions: [{ id: "cam", type: "camera", start: 5, duration: 2, shot: { mode: "fixed", position: { x: 1, y: 2, z: 3 }, lookAt: { x: 0, y: 0, z: 0 } } }],
  });
  const transforms = new Map<string, CharacterTransform>([["c", { position: { x: 10, y: 0, z: 20 }, heading: 90 }]]);

  it("follow = target + offset", () => {
    const cam = evaluateCamera(scene, 1, transforms);
    expect(cam.position).toEqual({ x: 10, y: 2, z: 15 });
    expect(cam.lookAt).toEqual({ x: 10, y: 1, z: 20 });
  });

  it("camera action ghi đè shot mặc định", () => {
    expect(evaluateCamera(scene, 6, transforms).position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("relative offset xoay theo heading", () => {
    const rel = { ...scene, camera: { ...scene.camera, relative: true } } as typeof scene;
    const cam = evaluateCamera(rel, 1, transforms);
    close(cam.position.x, 5);
    close(cam.position.z, 20);
  });
});

describe("camera: blend + move", async () => {
  const { evaluateCamera } = await import("../src/engine/CameraEngine");
  const { SceneScriptSchema } = await import("../src/schemas/scene.schema");
  const scene = SceneScriptSchema.parse({
    version: 1,
    meta: { name: "cam", duration: 10, fps: 30, width: 640, height: 360 },
    environment: { asset: "env_park" },
    characters: [],
    camera: { mode: "fixed", position: { x: 0, y: 1, z: -10 }, lookAt: { x: 0, y: 1, z: 0 } },
    actions: [
      { id: "a", type: "camera", start: 0, duration: 4, shot: { mode: "fixed", position: { x: 0, y: 1, z: -10 }, lookAt: { x: 0, y: 1, z: 0 } }, move: { dolly: 0.5 } },
      { id: "b", type: "camera", start: 4, duration: 4, shot: { mode: "fixed", position: { x: 10, y: 1, z: 0 }, lookAt: { x: 0, y: 1, z: 0 } }, blend: 2 },
    ],
  });
  const none = new Map();

  it("dolly: tiến dần tới điểm nhìn theo ease, hết shot gần hơn 50%", () => {
    expect(evaluateCamera(scene, 0, none).position.z).toBeCloseTo(-10, 6);
    expect(evaluateCamera(scene, 2, none).position.z).toBeCloseTo(-7.5, 6);
    expect(evaluateCamera(scene, 3.9999, none).position.z).toBeCloseTo(-5, 3);
  });

  it("blend: bắt đầu từ camera cũ, giữa chừng nội suy, hết blend đúng shot mới", () => {
    const start = evaluateCamera(scene, 4, none).position;
    expect(start.z).toBeCloseTo(-5, 2);
    const mid = evaluateCamera(scene, 5, none).position;
    expect(mid.x).toBeCloseTo(5, 2);
    expect(evaluateCamera(scene, 6.5, none).position).toEqual({ x: 10, y: 1, z: 0 });
  });
});

describe("AssetLoader: model thiếu pháp tuyến", async () => {
  const THREE = await import("three");
  const { fixMissingNormals } = await import("../src/engine/AssetLoader");
  it("tính bổ sung pháp tuyến (hậu kỳ AO cần) và bỏ qua mesh đã có", () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const withNormals = new THREE.BoxGeometry();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()), new THREE.Mesh(withNormals, new THREE.MeshStandardMaterial()));
    expect(fixMissingNormals(root)).toBe(1);
    expect(g.getAttribute("normal")).toBeDefined();
    expect(fixMissingNormals(root)).toBe(0);
  });
});
