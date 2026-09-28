import { describe, expect, it } from "vitest";
import { registry, resolvedDemo } from "./helpers";
import { validateScene, type SceneErrorCode } from "../src/validation/validateScene";

const demo = await resolvedDemo("demo-robot-park");

function codes(input: unknown): SceneErrorCode[] {
  const r = validateScene(input, registry);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

function withActions(extra: unknown[]): unknown {
  return { ...demo, actions: [...(demo.actions as unknown[]), ...extra] };
}

describe("validateScene", () => {
  it("scene demo hợp lệ", () => {
    const r = validateScene(demo, registry);
    if (!r.ok) console.error(r.issues);
    expect(r.ok).toBe(true);
  });

  it("thiếu trường → InvalidSchema", () => {
    expect(codes({ ...demo, meta: undefined })).toContain("InvalidSchema");
  });

  it("kích thước lẻ → InvalidSchema", () => {
    expect(codes({ ...demo, meta: { ...(demo.meta as object), width: 1281 } })).toContain("InvalidSchema");
  });

  it("animation Flying → AnimationNotFound", () => {
    expect(codes(withActions([{ id: "fly", type: "animation", target: "robot", start: 11, duration: 0.5, clip: "Flying" }]))).toContain(
      "AnimationNotFound",
    );
  });

  it("asset lạ → AssetNotFound", () => {
    expect(codes({ ...demo, environment: { asset: "env_mars" } })).toContain("AssetNotFound");
  });

  it("dùng prop làm character → AssetTypeMismatch", () => {
    const chars = [{ id: "robot", asset: "prop_log", position: { x: 0, y: 0, z: 0 } }];
    expect(codes({ ...demo, characters: chars })).toContain("AssetTypeMismatch");
  });

  it("action trỏ nhân vật không tồn tại → TargetNotFound", () => {
    expect(codes(withActions([{ id: "x", type: "jump", target: "cat", start: 0, duration: 1 }]))).toContain("TargetNotFound");
  });

  it("hai move chồng thời gian → ActionOverlap", () => {
    expect(codes(withActions([{ id: "x", type: "move", target: "robot", start: 1, duration: 1, direction: "left", speed: 1 }]))).toContain(
      "ActionOverlap",
    );
  });

  it("jump được chồng với move", () => {
    expect(codes(withActions([{ id: "x", type: "jump", target: "robot", start: 1, duration: 0.5 }]))).toEqual([]);
  });

  it("vượt quá thời lượng → ActionOutOfRange", () => {
    expect(codes(withActions([{ id: "x", type: "jump", target: "robot", start: 11.8, duration: 1 }]))).toContain("ActionOutOfRange");
  });

  it("trùng id → DuplicateId", () => {
    expect(codes(withActions([{ id: "anim_run", type: "jump", target: "robot", start: 2, duration: 0.5 }]))).toContain("DuplicateId");
  });

  it("turn thiếu heading/by → InvalidSchema", () => {
    expect(codes(withActions([{ id: "x", type: "turn", target: "robot", start: 11, duration: 0.5 }]))).toContain("InvalidSchema");
  });

  it("project thương mại + asset không cho phép → LicenseViolation", () => {
    const reg = { ...registry, assets: registry.assets.map((a) => (a.id === "prop_log" ? { ...a, commercialUse: false } : a)) };
    const r = validateScene({ ...demo, meta: { ...(demo.meta as object), commercial: true } }, reg);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("LicenseViolation");
  });
});
