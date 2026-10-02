import type { Document } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Kích thước chiếm chỗ của nhân vật (xem AssetEntry.footprint): bounding box của model, chuẩn hóa theo `height`
 * (hoặc × `scale`), xoay theo `headingOffset` để "front" luôn là phía mặt nhân vật (+Z trong engine).
 */
export function computeFootprint(doc: Document, opts: { height?: number; scale?: number; headingOffset?: number }) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return undefined;
  const { min, max } = getBounds(scene);
  const sizeY = max[1]! - min[1]!;
  if (!(sizeY > 0)) return undefined;
  const s = opts.height ? opts.height / sizeY : (opts.scale ?? 1);
  const a = ((opts.headingOffset ?? 0) * Math.PI) / 180;
  let front = -Infinity;
  let back = -Infinity;
  let side = 0;
  for (const x of [min[0]!, max[0]!]) {
    for (const z of [min[2]!, max[2]!]) {
      // Xoay quanh trục Y như model.rotation.y = headingOffset.
      const rx = x * Math.cos(a) + z * Math.sin(a);
      const rz = -x * Math.sin(a) + z * Math.cos(a);
      front = Math.max(front, rz * s);
      back = Math.max(back, -rz * s);
      side = Math.max(side, Math.abs(rx) * s);
    }
  }
  return { front: r3(Math.max(0, front)), back: r3(Math.max(0, back)), side: r3(side) };
}
