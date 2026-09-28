import { describe, expect, it } from "vitest";
import { DROP_DISTANCE, evaluateProp } from "../src/engine/PropEngine";
import { SceneScriptSchema } from "../src/schemas/scene.schema";
import { validateScene } from "../src/validation/validateScene";
import { registry } from "./helpers";

const base = {
  version: 1,
  meta: { name: "props", duration: 10, fps: 30, width: 640, height: 360 },
  environment: { asset: "env_park" },
  characters: [{ id: "kit", asset: "char_k_animal_fox", position: { x: 0, y: 0, z: 0 }, heading: 90 }],
  props: [
    { id: "rose", asset: "prop_kn_flower_red_a", position: { x: 1, y: 0, z: 0 } },
    { id: "gift", asset: "prop_kn_flower_red_a", position: { x: 2, y: 0, z: 0 }, visible: false },
  ],
  camera: { mode: "fixed", position: { x: 0, y: 1, z: 5 }, lookAt: { x: 0, y: 0, z: 0 } },
  actions: [
    { id: "go", type: "moveTo", target: "kit", start: 0, duration: 2, to: { x: 3, z: 0 } },
    { id: "take", type: "attach", target: "rose", to: "kit", start: 1 },
    { id: "put", type: "drop", target: "rose", start: 4 },
    { id: "appear", type: "show", target: "gift", start: 5 },
    { id: "vanish", type: "hide", target: "gift", start: 6 },
  ],
};

describe("PropEngine", () => {
  const scene = SceneScriptSchema.parse(base);
  const [rose, gift] = scene.props;

  it("attach từ đúng thời điểm start, trước đó nằm yên", () => {
    expect(evaluateProp(rose!, scene.characters, scene.actions, 0.99).holder).toBeUndefined();
    expect(evaluateProp(rose!, scene.characters, scene.actions, 1).holder).toEqual({ character: "kit", point: "auto" });
  });

  it("drop không có `at`: đặt xuống trước mặt người cầm", () => {
    const st = evaluateProp(rose!, scene.characters, scene.actions, 5);
    expect(st.holder).toBeUndefined();
    // kit đứng ở (3, 0), nhìn +X (heading 90)
    expect(st.position.x).toBeCloseTo(3 + DROP_DISTANCE, 6);
    expect(st.position.z).toBeCloseTo(0, 6);
  });

  it("visible mặc định từ props, show/hide theo thời gian", () => {
    expect(evaluateProp(gift!, scene.characters, scene.actions, 4).visible).toBe(false);
    expect(evaluateProp(gift!, scene.characters, scene.actions, 5.5).visible).toBe(true);
    expect(evaluateProp(gift!, scene.characters, scene.actions, 7).visible).toBe(false);
  });

  it("validator: đồ vật / người nhận không tồn tại; sự kiện đồ vật không tính chồng thời gian", () => {
    expect(validateScene(base, registry).ok).toBe(true);
    const bad = structuredClone(base);
    bad.actions.push({ id: "x1", type: "attach", target: "ghost", to: "kit", start: 1 } as never, { id: "x2", type: "attach", target: "gift", to: "nobody", start: 1 } as never);
    const r = validateScene(bad, registry);
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(["actions.5.target", "actions.6.to"]);
  });
});
