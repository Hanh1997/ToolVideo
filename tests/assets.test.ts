import { describe, expect, it } from "vitest";
import { buildAliases } from "../src/assets/clipAliases";
import { findAsset, resolveClip } from "../src/schemas/asset.schema";
import { validateScene } from "../src/validation/validateScene";
import { registry } from "./helpers";

describe("tên clip chuẩn", () => {
  it("khớp đúng tên trước, dự phòng sau", () => {
    const { aliases, fallbacks } = buildAliases(["Idle", "Walk", "Run", "Victory", "Armature"]);
    expect(aliases).toMatchObject({ idle: "Idle", walk: "Walk", run: "Run", victory: "Victory", wave: "Victory" });
    expect(fallbacks).toContain("wave→Victory");
    expect(aliases).not.toHaveProperty("sit");
  });

  it("không phân biệt hoa thường và -/_ (Kenney), giữ tên clip thật", () => {
    const { aliases } = buildAliases(["static", "idle", "walk", "gesture-positive"]);
    expect(aliases).toMatchObject({ idle: "idle", walk: "walk", yes: "gesture-positive" });
  });

  it("cá: bơi thường → idle/swim, bơi nhanh → run", () => {
    const { aliases } = buildAliases(["Attack", "Death", "Swimming_Fast", "Swimming_Normal"]);
    expect(aliases).toMatchObject({ idle: "Swimming_Normal", swim: "Swimming_Normal", run: "Swimming_Fast" });
  });

  it("robot: walk → Walking, wave → Wave (không dự phòng)", () => {
    const robot = findAsset(registry, "char_robot")!;
    expect(resolveClip(robot, "walk")).toBe("Walking");
    expect(resolveClip(robot, "wave")).toBe("Wave");
    expect(resolveClip(robot, "Walking")).toBe("Walking");
    expect(resolveClip(robot, "fly")).toBeUndefined();
  });

  it("mọi nhân vật trong Registry: alias trỏ tới clip có thật, có idle", () => {
    for (const a of registry.assets.filter((x) => x.type === "character")) {
      for (const [std, real] of Object.entries(a.clipAliases)) expect(a.clips, `${a.id}.${std}`).toContain(real);
      expect(resolveClip(a, "idle"), a.id).toBeDefined();
    }
  });

  it("validator chấp nhận tên chuẩn, báo lỗi clip mà nhân vật không có", () => {
    const scene = (clip: string) => ({
      version: 1,
      meta: { name: "t", duration: 2, fps: 30, width: 640, height: 360 },
      environment: { asset: "env_park" },
      characters: [{ id: "p", asset: "char_pig", position: { x: 0, y: 0, z: 0 } }],
      camera: { mode: "fixed", position: { x: 0, y: 1, z: -3 }, lookAt: { x: 0, y: 0, z: 0 } },
      actions: [{ id: "a", type: "animation", target: "p", start: 0, duration: 1, clip }],
    });
    expect(validateScene(scene("jump"), registry).ok).toBe(true);
    const r = validateScene(scene("walk"), registry); // heo chỉ có Idle + Jump
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("AnimationNotFound");
  });
});

describe("bỏ tiền tố tên clip", () => {
  it("tiền tố chung của nhân vật", async () => {
    const { stripClipPrefixes } = await import("../src/assets/clipAliases");
    expect(stripClipPrefixes(["Man_Idle", "Man_Walk", "Man_Run", "Man_Sitting"])).toEqual(["Idle", "Walk", "Run", "Sitting"]);
    // Clip lạc tiền tố (lỗi trong gói) vẫn được bỏ nếu phần sau là tên quen thuộc.
    expect(stripClipPrefixes(["Apatosaurus_Idle", "Apatosaurus_Walk", "Stegosaurus_Death"])).toEqual(["Idle", "Walk", "Death"]);
    // Tên clip thật dạng Walk_Carry không bị cắt nhầm.
    expect(stripClipPrefixes(["Idle", "Walk", "Walk_Carry", "Run", "Run_Carry"])).toEqual(["Idle", "Walk", "Walk_Carry", "Run", "Run_Carry"]);
  });
});

describe("nhãn tự đoán từ tên file", () => {
  it("tree/pine chỉ ở đầu từ hoặc camelCase", async () => {
    const { guessTags } = await import("../server/assets/importAsset");
    for (const n of ["Tree_1", "PalmTree", "tree_default", "Pine_2", "BigTree2", "DeadBirch_3"]) expect(guessTags(n, "prop")).toContain("tree");
    for (const n of ["Street_Lantern", "Porcupine"]) expect(guessTags(n, "prop")).not.toContain("tree");
  });
});
