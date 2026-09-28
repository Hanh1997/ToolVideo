/**
 * Thêm nhân vật / đạo cụ / bối cảnh vào thư viện asset.
 *
 *   npm run asset:add -- path/to/Cat.fbx --id char_cat --name "Mèo" --height 0.6 --author "Quaternius" --source <url>
 *   npm run asset:add -- a.gltf b.gltf --prefix char_q_ --height 1.3 --author Quaternius --source <url>
 *   npm run asset:add -- model.glb --type prop --id prop_table --height 0.8 --dry-run
 *
 * Lõi xử lý: server/assets/importAsset.ts (dùng chung với giao diện Thư viện).
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { importAssets, type ImportableType } from "../server/assets/importAsset";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: "string", default: "character" },
    id: { type: "string" },
    prefix: { type: "string" },
    name: { type: "string" },
    height: { type: "string" },
    scale: { type: "string" },
    tags: { type: "string" },
    pack: { type: "string" },
    "heading-offset": { type: "string", default: "0" },
    license: { type: "string", default: "CC0-1.0" },
    author: { type: "string" },
    source: { type: "string" },
    attribution: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

if (positionals.length === 0 || !values.author || !values.source) {
  console.error("Cách dùng: npm run asset:add -- <file.fbx|.gltf|.glb> [...] --author <tác giả> --source <nguồn> [--id id | --prefix char_] [--height m] [--type character|prop|environment]");
  process.exit(2);
}

try {
  const results = await importAssets(
    positionals.map((p) => resolve(process.cwd(), p)),
    {
      type: values.type as ImportableType,
      id: values.id,
      prefix: values.prefix,
      name: values.name,
      height: values.height ? Number(values.height) : undefined,
      scale: values.scale ? Number(values.scale) : undefined,
      tags: values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      pack: values.pack,
      headingOffset: Number(values["heading-offset"]),
      license: values.license!,
      author: values.author,
      source: values.source,
      attribution: values.attribution,
      dryRun: values["dry-run"],
    },
  );
  for (const { entry, fallbacks, warnings } of results) {
    console.log(
      `✓ ${entry.id.padEnd(28)} ${String(entry.clips.length).padStart(2)} clip · chuẩn: ${Object.keys(entry.clipAliases).join(",") || "-"}` +
        (fallbacks.length ? ` · dự phòng: ${fallbacks.join(", ")}` : ""),
    );
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
  }
  console.log(values["dry-run"] ? "(dry-run: không ghi file)" : `Đã cập nhật registry.json (${results.length} asset)`);
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
