/**
 * Tính lại footprint (kích thước chiếm chỗ) cho mọi nhân vật trong Registry từ file .glb.
 *
 *   npx tsx scripts/asset-footprint.ts            # ghi registry
 *   npx tsx scripts/asset-footprint.ts --dry-run  # chỉ in
 */
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { computeFootprint } from "../server/assets/footprint";
import { ASSETS_DIR, readRegistry, writeRegistry } from "../server/assets/importAsset";

const dry = process.argv.includes("--dry-run");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const registry = await readRegistry();
let n = 0;
for (const a of registry.assets) {
  if (a.type !== "character") continue;
  const fp = computeFootprint(await io.read(join(ASSETS_DIR, a.file)), a);
  if (!fp) continue;
  a.footprint = fp;
  n++;
  console.log(`${a.id.padEnd(32)} front ${fp.front}  back ${fp.back}  side ${fp.side}`);
}
if (!dry) await writeRegistry(registry);
console.log(`${dry ? "(dry-run) " : ""}✓ ${n} nhân vật`);
