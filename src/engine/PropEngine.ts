import { isPropAction, type Action, type HoldPoint, type PropAction, type SceneCharacter, type SceneProp, type Vec3 } from "../schemas/scene.schema";
import { headingToVector } from "./math";
import { evaluateTransform } from "./MovementEngine";

/** Đặt xuống không chỉ định vị trí: trước mặt người cầm bao xa (mét). */
export const DROP_DISTANCE = 0.55;

export interface PropState {
  visible: boolean;
  /** Đang được cầm: vị trí do điểm cầm của nhân vật quyết định (tính trong SceneEngine). */
  holder?: { character: string; point: HoldPoint };
  /** Vị trí trên mặt đất khi không ai cầm. */
  position: Vec3;
  heading: number;
}

/** Sự kiện của một đồ vật theo thứ tự thời gian (cùng thời điểm: giữ thứ tự trong scene). */
export function propEvents(actions: readonly Action[], propId: string): PropAction[] {
  return actions
    .map((a, i) => ({ a, i }))
    .filter((x): x is { a: PropAction; i: number } => isPropAction(x.a) && x.a.target === propId)
    .sort((x, y) => x.a.start - y.a.start || x.i - y.i)
    .map((x) => x.a);
}

/**
 * Trạng thái đồ vật tại t – hàm thuần của (prop, nhân vật, actions, t) như evaluateTransform.
 * Sự kiện có hiệu lực từ đúng thời điểm `start`.
 */
export function evaluateProp(prop: SceneProp, characters: readonly SceneCharacter[], actions: readonly Action[], t: number): PropState {
  const state: PropState = { visible: prop.visible, position: { ...prop.position }, heading: prop.heading };
  for (const e of propEvents(actions, prop.id)) {
    if (e.start > t) break;
    switch (e.type) {
      case "show":
        state.visible = true;
        break;
      case "hide":
        state.visible = false;
        break;
      case "attach":
        state.holder = { character: e.to, point: e.point };
        break;
      case "drop": {
        const holder = state.holder && characters.find((c) => c.id === state.holder!.character);
        if (e.at) {
          state.position = { ...e.at };
        } else if (holder) {
          const tr = evaluateTransform(holder, actions, e.start);
          const v = headingToVector(tr.heading);
          state.position = { x: tr.position.x + v.x * DROP_DISTANCE, y: 0, z: tr.position.z + v.z * DROP_DISTANCE };
          state.heading = tr.heading + prop.heading;
        }
        state.holder = undefined;
        break;
      }
    }
  }
  return state;
}
