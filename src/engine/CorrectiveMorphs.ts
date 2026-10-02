import * as THREE from "three";
import { clamp } from "./math";

/**
 * Shape key chỉnh vai (corrective) – nhân vật gốc đúc liền một lớp da (scripts/blender/gen_character.py,
 * shoulder_correctives): shoulderUpL / shoulderUpR làm phẳng khối cơ delta dồn lên ở bả vai khi giơ tay cao.
 *
 * Mỗi khung (sau khi đã áp hoạt ảnh): đo góc nâng cánh tay so với tư thế gốc (tay buông) trong hệ toạ độ của ngực
 * → không phụ thuộc nhân vật đang cúi / nghiêng; tay dưới ~70° = 0, quá vai (~150°) = 1, chuyển mượt ở giữa.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const DEG = Math.PI / 180;
const START = 70 * DEG;
const FULL = 150 * DEG;

interface Side {
  slots: { influences: number[]; index: number }[];
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  /** Hướng cánh tay ở tư thế gốc, trong hệ toạ độ của chest. */
  rest: THREE.Vector3;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _inv = new THREE.Matrix4();

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export class CorrectiveMorphs {
  private constructor(
    private readonly chest: THREE.Object3D,
    private readonly sides: Side[],
  ) {}

  /** Gọi ở tư thế gốc (trước khi chạy hoạt ảnh). Model không có key chỉnh vai → undefined. */
  static find(model: THREE.Object3D): CorrectiveMorphs | undefined {
    const nodes = new Map<string, THREE.Object3D>();
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      if (!nodes.has(norm(o.name))) nodes.set(norm(o.name), o);
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) meshes.push(m);
    });
    const chest = nodes.get("chest");
    if (!chest) return undefined;
    model.updateMatrixWorld(true);
    const sides: Side[] = [];
    for (const s of ["L", "R"]) {
      const slots = meshes.flatMap((m) => {
        const index = m.morphTargetDictionary![`shoulderUp${s}`];
        return index === undefined ? [] : [{ influences: m.morphTargetInfluences!, index }];
      });
      const upper = nodes.get(norm(`UpperArm${s}`));
      const lower = nodes.get(norm(`LowerArm${s}`));
      if (!slots.length || !upper || !lower) continue;
      sides.push({ slots, upper, lower, rest: armDir(chest, upper, lower, new THREE.Vector3()) });
    }
    return sides.length ? new CorrectiveMorphs(chest, sides) : undefined;
  }

  /** Cập nhật theo tư thế hiện tại của xương (cần matrixWorld mới). */
  update(): void {
    for (const side of this.sides) {
      const dir = armDir(this.chest, side.upper, side.lower, _b);
      const w = smooth01((dir.angleTo(side.rest) - START) / (FULL - START));
      for (const s of side.slots) s.influences[s.index] = w;
    }
  }
}

/** Hướng cánh tay trên (vai → khuỷu) trong hệ toạ độ của chest. */
function armDir(chest: THREE.Object3D, upper: THREE.Object3D, lower: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(out);
  out.sub(_a);
  _inv.copy(chest.matrixWorld).invert();
  return out.transformDirection(_inv);
}
