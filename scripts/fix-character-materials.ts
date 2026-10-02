/**
 * Sửa vật liệu nhân vật nhập từ FBX bị lệch:
 *   - char_q_* (Quaternius): vật liệu "Skin" gần như đen (0.013) → mặt / tay tối thui. Đặt tông da tự nhiên
 *     (xen kẽ 3 tông theo thứ tự tên file, tất định).
 *   - Nhân vật có metallic > 0 (mặc định khi chuyển FBX → glTF): không có môi trường phản chiếu nên da / áo xỉn tối
 *     → metallic 0.
 *
 *   npx tsx scripts/fix-character-materials.ts          (ghi đè public/assets/characters/*.glb; git giữ bản gốc)
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../public/assets/characters");
/** Tông da (sRGB) → đổi sang tuyến tính khi ghi baseColorFactor. */
const SKIN_TONES = [
  [0.96, 0.8, 0.69],
  [0.89, 0.69, 0.55],
  [0.78, 0.57, 0.42],
];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const files = readdirSync(DIR).filter((f) => f.startsWith("char_") && f.endsWith(".glb")).sort();
let q = 0;
for (const f of files) {
  const doc = await io.read(resolve(DIR, f));
  const changes: string[] = [];
  for (const m of doc.getRoot().listMaterials()) {
    if (f.startsWith("char_q_") && /^skin$/i.test(m.getName())) {
      const [r, g, b] = m.getBaseColorFactor();
      if (Math.max(r!, g!, b!) < 0.05) {
        const tone = SKIN_TONES[q % SKIN_TONES.length]!;
        m.setBaseColorFactor([...tone.map(toLinear), 1] as [number, number, number, number]);
        changes.push(`Skin → sRGB ${tone.join(",")}`);
      }
    }
    if (m.getMetallicFactor() > 0 && !m.getMetallicRoughnessTexture()) {
      changes.push(`${m.getName()} metallic ${m.getMetallicFactor().toFixed(2)} → 0`);
      m.setMetallicFactor(0);
    }
  }
  if (f.startsWith("char_q_")) q++;
  if (!changes.length) continue;
  await io.write(resolve(DIR, f), doc);
  console.log(`✓ ${f}: ${[...new Set(changes)].join("; ")}`);
}
