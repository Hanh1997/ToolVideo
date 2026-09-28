import { isMotionAction, type Action, type MotionAction, type SceneCharacter, type Vec3 } from "../schemas/scene.schema";
import { headingToVector, lerp, shortestAngleDelta, smoothstep, vectorToHeading } from "./math";

export interface CharacterTransform {
  position: Vec3;
  /** độ; 0 = nhìn về +Z */
  heading: number;
}

/** Thời gian xoay người khi action đổi hướng đột ngột (giây). */
const FACE_BLEND = 0.2;
const MOVE_OFFSET: Record<string, number> = { forward: 0, left: 90, right: -90, backward: 180 };

function faceBlend(from: number, to: number, elapsed: number, duration: number): number {
  const delta = shortestAngleDelta(from, to);
  const blend = Math.min(FACE_BLEND, duration);
  if (blend <= 0 || elapsed >= blend) return from + delta;
  return from + delta * smoothstep(elapsed / blend);
}

/**
 * Trạng thái vị trí/hướng của nhân vật tại thời điểm t.
 * Hàm thuần: chỉ phụ thuộc (character, actions, t) → seek tùy ý, render tất định.
 */
export function evaluateTransform(character: SceneCharacter, actions: readonly Action[], t: number): CharacterTransform {
  let x = character.position.x;
  let z = character.position.z;
  let heading = character.heading;

  const motions = actions
    .filter((a): a is MotionAction => isMotionAction(a) && a.target === character.id)
    .sort((a, b) => a.start - b.start);

  for (const a of motions) {
    if (t <= a.start) break;
    const elapsed = Math.min(t - a.start, a.duration);
    const p = elapsed / a.duration;
    const h0 = heading;

    switch (a.type) {
      case "move": {
        const dir = h0 + (MOVE_OFFSET[a.direction] ?? 0);
        const v = headingToVector(dir);
        x += v.x * a.speed * elapsed;
        z += v.z * a.speed * elapsed;
        const face = a.face ?? a.direction !== "backward";
        if (face) heading = faceBlend(h0, dir, elapsed, a.duration);
        break;
      }
      case "moveTo": {
        const dx = a.to.x - x;
        const dz = a.to.z - z;
        if (a.face && Math.hypot(dx, dz) > 1e-6) {
          heading = faceBlend(h0, vectorToHeading(dx, dz), elapsed, a.duration);
        }
        x += dx * p;
        z += dz * p;
        break;
      }
      case "path": {
        const pts = [{ x, z }, ...a.points];
        const lengths: number[] = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
          const len = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
          lengths.push(len);
          total += len;
        }
        if (total < 1e-9) break;
        const speed = total / a.duration;
        let remaining = total * p;
        let segHeading = h0;
        for (let i = 0; i < lengths.length; i++) {
          const len = lengths[i]!;
          if (len < 1e-9) continue;
          const from = pts[i]!;
          const to = pts[i + 1]!;
          const prevHeading = segHeading;
          segHeading = vectorToHeading(to.x - from.x, to.z - from.z);
          if (remaining <= len || i === lengths.length - 1) {
            const s = Math.min(remaining / len, 1);
            x = lerp(from.x, to.x, s);
            z = lerp(from.z, to.z, s);
            if (a.face) heading = faceBlend(prevHeading, segHeading, (s * len) / speed, a.duration);
            break;
          }
          remaining -= len;
        }
        break;
      }
      case "turn": {
        const delta = a.by ?? shortestAngleDelta(h0, a.heading ?? h0);
        heading = h0 + delta * smoothstep(p);
        break;
      }
    }
  }

  let y = character.position.y;
  for (const a of actions) {
    if (a.type !== "jump" || a.target !== character.id) continue;
    if (t > a.start && t < a.start + a.duration) {
      const p = (t - a.start) / a.duration;
      y += a.height * 4 * p * (1 - p);
    }
  }

  return { position: { x, y, z }, heading };
}
