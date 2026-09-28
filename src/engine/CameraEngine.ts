import type { CameraAction, CameraMove, CameraShot, SceneScript, Vec3 } from "../schemas/scene.schema";
import type { CharacterTransform } from "./MovementEngine";
import { DEG, lerp, smoothstep } from "./math";

export interface CameraState {
  position: Vec3;
  lookAt: Vec3;
  fov: number;
}

/** Camera action đang chạy tại t (action bắt đầu muộn nhất chứa t). */
export function activeCameraAction(scene: SceneScript, t: number): CameraAction | undefined {
  let found: CameraAction | undefined;
  for (const a of scene.actions) {
    if (a.type === "camera" && t >= a.start && t < a.start + a.duration && (!found || a.start >= found.start)) found = a;
  }
  return found;
}

export function activeShot(scene: SceneScript, t: number): CameraShot {
  return activeCameraAction(scene, t)?.shot ?? scene.camera;
}

function shotState(shot: CameraShot, transforms: ReadonlyMap<string, CharacterTransform>): CameraState {
  if (shot.mode === "fixed") {
    return { position: { ...shot.position }, lookAt: { ...shot.lookAt }, fov: shot.fov };
  }
  const target = transforms.get(shot.target);
  const base = target?.position ?? { x: 0, y: 0, z: 0 };
  let ox = shot.offset.x;
  let oz = shot.offset.z;
  if (shot.relative && target) {
    const h = target.heading * DEG;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    [ox, oz] = [ox * cos + oz * sin, -ox * sin + oz * cos];
  }
  return {
    position: { x: base.x + ox, y: base.y + shot.offset.y, z: base.z + oz },
    lookAt: {
      x: base.x + shot.lookAtOffset.x,
      y: base.y + shot.lookAtOffset.y,
      z: base.z + shot.lookAtOffset.z,
    },
    fov: shot.fov,
  };
}

/** Dolly / pan / rise theo tiến độ p (0..1, đã ease). */
function applyMove(s: CameraState, move: CameraMove, p: number): CameraState {
  const dx = s.position.x - s.lookAt.x;
  const dz = s.position.z - s.lookAt.z;
  const a = move.pan * DEG * p;
  const k = 1 - move.dolly * p;
  const rx = (dx * Math.cos(a) + dz * Math.sin(a)) * k;
  const rz = (-dx * Math.sin(a) + dz * Math.cos(a)) * k;
  const ry = (s.position.y - s.lookAt.y) * k + move.rise * p;
  return { ...s, position: { x: s.lookAt.x + rx, y: s.lookAt.y + ry, z: s.lookAt.z + rz } };
}

const mix = (a: CameraState, b: CameraState, w: number): CameraState => ({
  position: { x: lerp(a.position.x, b.position.x, w), y: lerp(a.position.y, b.position.y, w), z: lerp(a.position.z, b.position.z, w) },
  lookAt: { x: lerp(a.lookAt.x, b.lookAt.x, w), y: lerp(a.lookAt.y, b.lookAt.y, w), z: lerp(a.lookAt.z, b.lookAt.z, w) },
  fov: lerp(a.fov, b.fov, w),
});

/**
 * Camera tại t: shot của action đang chạy (+ chuyển động chậm), chuyển mượt từ camera ngay trước action nếu có `blend`.
 * Hàm thuần của (scene, t, transforms) → tất định.
 */
export function evaluateCamera(scene: SceneScript, t: number, transforms: ReadonlyMap<string, CharacterTransform>, depth = 0): CameraState {
  const action = activeCameraAction(scene, t);
  if (!action) return shotState(scene.camera, transforms);
  let state = shotState(action.shot, transforms);
  if (action.move) state = applyMove(state, action.move, smoothstep((t - action.start) / action.duration));
  if (action.blend > 0 && t < action.start + action.blend && depth < 8) {
    const before = evaluateCamera(scene, Math.max(0, action.start - 1e-4), transforms, depth + 1);
    state = mix(before, state, smoothstep((t - action.start) / action.blend));
  }
  return state;
}
