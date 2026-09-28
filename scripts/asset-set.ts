/**
 * Sửa hàng loạt chiều cao / tỷ lệ asset trong registry (không đổi file GLB).
 *
 *   npm run asset:set -- <<'EOF'
 *   prop_pz_cow        height=1.5      # đặt chiều cao (m), bỏ scale
 *   prop_kn_*          scale=4.5       # mọi id bắt đầu bằng prop_kn_
 *   prop_kn_flower_*   holdHeight=0.3  # chiều cao khi nhân vật cầm/ngậm
 *   EOF
 *
 * Mỗi dòng: <id | tiền tố*> height=<m> | scale=<x> | holdHeight=<m>. Dòng trống và phần sau "#" bị bỏ qua.
 */
import { readFileSync } from "node:fs";
import { readRegistry, updateAsset } from "../server/assets/importAsset";

const lines = readFileSync(0, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
const ids = (await readRegistry()).assets.map((a) => a.id);
let changed = 0;
let failed = 0;
for (const line of lines) {
  const [pattern, kv] = line.split(/\s+/);
  const m = /^(height|scale|holdHeight)=([\d.]+)$/.exec(kv ?? "");
  if (!pattern || !m) {
    console.error(`✗ dòng không hợp lệ: ${line}`);
    failed++;
    continue;
  }
  const value = Number(m[2]);
  const patch = m[1] === "holdHeight" ? { holdHeight: value } : m[1] === "height" ? { height: value, scale: null } : { scale: value, height: null };
  const targets = pattern.endsWith("*") ? ids.filter((id) => id.startsWith(pattern.slice(0, -1))) : [pattern];
  if (!targets.length) console.error(`⚠ ${pattern}: không khớp asset nào`);
  for (const id of targets) {
    try {
      await updateAsset(id, patch);
      changed++;
    } catch (e) {
      console.error(`✗ ${id}: ${(e as Error).message}`);
      failed++;
    }
  }
}
console.log(`✓ đã sửa ${changed} asset${failed ? `, ${failed} lỗi` : ""}`);
process.exitCode = failed ? 1 : 0;
