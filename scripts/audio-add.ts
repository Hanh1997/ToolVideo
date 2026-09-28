/**
 * Thêm file âm thanh (wav/ogg/mp3) vào thư viện: chép vào public/assets/audio/<thư mục>, đo thời lượng bằng ffprobe,
 * ghi vào Registry. Nhiều file cùng loại → id = tiền tố + số thứ tự (engine chọn ngẫu nhiên tất định, vd. bước chân).
 *
 *   npm run audio:add -- a.ogg b.ogg --prefix sfx_step_grass_ --tags footstep,grass --dir kenney \
 *       --pack "Kenney · Impact Sounds" --author Kenney --source https://kenney.nl/assets/impact-sounds
 *   npm run audio:add -- song.ogg --id music_calm --name "Nhạc nhẹ nhàng" --tags music,calm
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ffmpegPath } from "../cli/ffmpeg";
import { AssetEntrySchema, COMMERCIAL_LICENSES } from "../src/schemas/asset.schema";
import { readRegistry, writeRegistry } from "../server/assets/importAsset";

const ROOT = resolve(import.meta.dirname, "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    prefix: { type: "string" },
    name: { type: "string" },
    tags: { type: "string", default: "" },
    dir: { type: "string", default: "" },
    pack: { type: "string" },
    license: { type: "string", default: "CC0-1.0" },
    author: { type: "string", default: "Unknown" },
    source: { type: "string", default: "local" },
    attribution: { type: "boolean", default: false },
  },
});

function probeDuration(file: string): Promise<number> {
  const bin = ffmpegPath().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
  return new Promise((ok, fail) => {
    const p = spawn(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", fail);
    p.on("close", (code) => {
      const v = Number(out.trim());
      if (code === 0 && v > 0) ok(Math.round(v * 1000) / 1000);
      else fail(new Error(`ffprobe không đọc được ${file}`));
    });
  });
}

if (!positionals.length || (!values.id && !values.prefix) || (values.id && positionals.length > 1)) {
  console.error("Cách dùng: npm run audio:add -- <file...> (--id <id> | --prefix <tiền tố>) [--tags a,b --dir kenney --pack ... --author ... --source ...]");
  process.exit(2);
}

const registry = await readRegistry();
const tags = values.tags.split(",").map((t) => t.trim()).filter(Boolean);
const outDir = join(ROOT, "public", "assets", "audio", values.dir);
await mkdir(outDir, { recursive: true });
let added = 0;
for (const [i, src] of positionals.entries()) {
  const id = values.id ?? `${values.prefix}${i}`;
  const file = `${id}${extname(src).toLowerCase()}`;
  await copyFile(resolve(src), join(outDir, file));
  const entry = AssetEntrySchema.parse({
    id,
    type: "audio",
    name: values.name ?? basename(src, extname(src)),
    file: ["audio", values.dir, file].filter(Boolean).join("/"),
    duration: await probeDuration(join(outDir, file)),
    tags: ["audio", ...tags],
    pack: values.pack,
    license: values.license,
    author: values.author,
    source: values.source,
    commercialUse: COMMERCIAL_LICENSES.has(values.license),
    attributionRequired: values.attribution,
  });
  const at = registry.assets.findIndex((a) => a.id === id);
  if (at >= 0) registry.assets[at] = entry;
  else registry.assets.push(entry);
  added++;
  console.log(`✓ ${id}  ${entry.duration}s  ← ${basename(src)}`);
}
await writeRegistry(registry);
console.log(`✓ ${added} audio`);
