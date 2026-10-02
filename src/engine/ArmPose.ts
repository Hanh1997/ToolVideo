import * as THREE from "three";
import type { Action, ArmPose, PoseAction } from "../schemas/scene.schema";
import { smoothstep } from "./math";

/**
 * Động tác tay (action "pose") cho nhân vật có xương tay (UpperArm/LowerArm…), cộng lên trên hoạt ảnh đang chạy:
 *   hug      – hai tay vươn ra trước, khép vào trong, cẳng tay ôm vòng
 *   reach    – hai tay đưa ra trước, hơi thấp (trao / nhận đồ)
 *   highfive – tay phải giơ cao về phía trước
 *   pat      – tay phải đưa ra trước, nhịp lên xuống (vỗ vai)
 *
 * Hướng tay tính trong không gian thế giới theo hướng nhân vật (trước / ngang / lên) → không phụ thuộc trục xương
 * của từng model. Model không có xương tay (Kenney khối vuông) → bỏ qua (động tác nhún vẫn diễn).
 */

export interface ArmBones {
  upper: THREE.Object3D;
  lower?: THREE.Object3D;
  /** Điểm cuối cẳng tay (bàn tay / con của cẳng tay) – đo hướng cẳng tay. */
  end?: THREE.Object3D;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const UPPER = { l: ["UpperArm.L", "Arm.L", "LeftArm", "mixamorigLeftArm", "upperarm_l"], r: ["UpperArm.R", "Arm.R", "RightArm", "mixamorigRightArm", "upperarm_r"] };
const LOWER = { l: ["LowerArm.L", "ForeArm.L", "LeftForeArm", "mixamorigLeftForeArm", "lowerarm_l"], r: ["LowerArm.R", "ForeArm.R", "RightForeArm", "mixamorigRightForeArm", "lowerarm_r"] };

function find(model: THREE.Object3D, names: readonly string[]): THREE.Object3D | undefined {
  const all: THREE.Object3D[] = [];
  model.traverse((o) => all.push(o));
  for (const n of names.map(norm)) {
    const hit = all.find((o) => norm(o.name) === n);
    if (hit) return hit;
  }
  return undefined;
}

/** Dò hai tay (cần cả cánh tay lẫn cẳng tay để biết hướng tay). */
export function findArms(model: THREE.Object3D): ArmBones[] {
  const arms: ArmBones[] = [];
  for (const side of ["l", "r"] as const) {
    const upper = find(model, UPPER[side]);
    const lower = find(model, LOWER[side]);
    if (!upper || !lower) continue;
    const end = lower.children.find((c) => (c as THREE.Bone).isBone) ?? undefined;
    arms.push({ upper, lower, end });
  }
  return arms;
}

/** Động tác tay đang diễn tại t + độ đậm (vào / ra mượt 0.3 s). */
export function evaluatePose(actions: readonly Action[], target: string, t: number): { pose: ArmPose; weight: number; local: number } | undefined {
  for (const a of actions) {
    if (a.type !== "pose" || a.target !== target) continue;
    const local = t - a.start;
    if (local < 0 || local > a.duration) continue;
    const ramp = Math.min(0.3, a.duration / 2);
    return { pose: (a as PoseAction).pose, weight: smoothstep(Math.min(local / ramp, (a.duration - local) / ramp)), local };
  }
  return undefined;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Quaternion();

/** Xoay `bone` (trong hệ thế giới) để đoạn bone → `tip` chỉ theo `want`, đậm `w`. */
function aim(bone: THREE.Object3D, tip: THREE.Object3D, want: THREE.Vector3, w: number): void {
  if (!bone.parent) return;
  const from = bone.getWorldPosition(tmpA);
  const cur = tip.getWorldPosition(tmpB).sub(from);
  if (cur.lengthSq() < 1e-8) return;
  cur.normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(cur, want.clone().normalize());
  delta.slerp(new THREE.Quaternion(), 1 - w);
  const world = bone.getWorldQuaternion(tmpQ);
  const parent = bone.parent.getWorldQuaternion(tmpP).invert();
  bone.quaternion.copy(parent.multiply(delta.multiply(world)));
  bone.updateMatrixWorld(true);
}

/** Áp động tác tay; `root` = gốc nhân vật (đã đặt vị trí + hướng), `headingDeg` = hướng nhìn. */
export function applyArmPose(root: THREE.Object3D, arms: readonly ArmBones[], pose: ArmPose, weight: number, local: number, headingDeg: number): void {
  if (!arms.length || weight <= 0) return;
  root.updateMatrixWorld(true);
  const h = (headingDeg * Math.PI) / 180;
  const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  const lat = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); // bên trái nhân vật
  const up = new THREE.Vector3(0, 1, 0);
  const center = root.getWorldPosition(new THREE.Vector3());
  for (const arm of arms) {
    // s = +1: tay trái, -1: tay phải (theo vị trí vai so với thân).
    const s = arm.upper.getWorldPosition(new THREE.Vector3()).sub(center).dot(lat) >= 0 ? 1 : -1;
    const right = s < 0;
    let upperDir: THREE.Vector3 | undefined;
    let lowerDir: THREE.Vector3 | undefined;
    switch (pose) {
      case "hug":
        upperDir = fwd.clone().addScaledVector(lat, -s * 0.2).addScaledVector(up, 0.1);
        lowerDir = fwd.clone().multiplyScalar(0.35).addScaledVector(lat, -s * 1);
        break;
      case "reach":
        upperDir = fwd.clone().addScaledVector(lat, s * 0.1).addScaledVector(up, -0.35);
        lowerDir = fwd.clone().addScaledVector(up, -0.05);
        break;
      case "highfive":
        if (right) {
          upperDir = up.clone().addScaledVector(fwd, 0.45).addScaledVector(lat, s * 0.2);
          lowerDir = up.clone().addScaledVector(fwd, 0.25);
        }
        break;
      case "pat":
        if (right) {
          const bob = 0.18 * Math.sin(local * Math.PI * 2 * 3.3);
          upperDir = fwd.clone().addScaledVector(up, 0.25 + bob).addScaledVector(lat, -s * 0.2);
          lowerDir = fwd.clone().addScaledVector(up, -0.2 + bob);
        }
        break;
    }
    if (upperDir && arm.lower) aim(arm.upper, arm.lower, upperDir, weight);
    if (lowerDir && arm.lower && arm.end) aim(arm.lower, arm.end, lowerDir, weight);
  }
}
