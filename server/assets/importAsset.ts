/**
 * Lõi import asset dùng chung cho CLI (`npm run asset:add`) và giao diện Thư viện (upload).
 *
 *   - FBX → GLB (tools/bin/FBX2glTF.exe hoặc FBX2GLTF_PATH); glTF/GLB đọc trực tiếp
 *   - Bỏ tiền tố tên clip ("Armature|Walk" → "Walk"), dedup + prune
 *   - Liệt kê clip, chọn defaultClip, sinh clipAliases (khớp đúng trước, dự phòng sau)
 *   - Ghi public/assets/<characters|props|environments>/<id>.glb + upsert registry.json
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";
import { buildAliases, stripClipPrefixes } from "../../src/assets/clipAliases";
import { AssetEntrySchema, COMMERCIAL_LICENSES, RegistrySchema, type AssetEntry, type Registry } from "../../src/schemas/asset.schema";

export const ROOT = resolve(import.meta.dirname, "../..");
export const ASSETS_DIR = join(ROOT, "public", "assets");
export const REGISTRY_FILE = join(ASSETS_DIR, "registry.json");

export type ImportableType = "character" | "prop" | "environment";
const FOLDER: Record<ImportableType, string> = { character: "characters", prop: "props", environment: "environments" };
const ID = /^[a-z0-9][a-z0-9_]*$/;
/** Cạnh lớn nhất của texture sau khi import (px). */
const MAX_TEXTURE = Number(process.env.MAX_TEXTURE ?? 1024);

export interface ImportOptions {
  type: ImportableType;
  /** Bỏ trống → prefix + tên file dạng snake_case. */
  id?: string;
  prefix?: string;
  name?: string;
  height?: number;
  /** Hệ số tỷ lệ khi không đặt height. */
  scale?: number;
  headingOffset?: number;
  /** Thêm vào nhãn tự đoán từ tên file. */
  tags?: string[];
  pack?: string;
  license: string;
  author: string;
  source: string;
  attribution?: boolean;
  dryRun?: boolean;
}

export interface ImportResult {
  entry: AssetEntry;
  fallbacks: string[];
  warnings: string[];
}

/** Nhãn tự đoán từ tên file (tiếng Anh, theo quy ước đặt tên của các gói phổ biến). */
const TAG_RULES: [RegExp, string][] = [
  // "tree"/"pine" chỉ ở đầu từ hoặc viết hoa kiểu camel ("PalmTree") – tránh "Street_Lantern", "Porcupine".
  [/(^|[^A-Za-z])(tree|pine)|Tree|Pine|TREE|PINE/, "tree"],
  [/birch|palm|willow|oak|maple|trunk/i, "tree"],
  [/bush|shrub|hedge/i, "bush"],
  [/rock|stone|boulder|pebble|cliff/i, "rock"],
  [/flower|tulip|rose|daisy|sunflower|lily/i, "flower"],
  [/grass|clover|fern|reed|weed/i, "grass"],
  [/plant|leaf|leaves|ivy|vine/i, "plant"],
  [/mushroom/i, "mushroom"],
  [/cactus/i, "cactus"],
  [/log|stump|wood|branch|twig/i, "wood"],
  [/fence|gate/i, "fence"],
  [/house|barn|mill|silo|shed|tower|building|stable|well|hut/i, "building"],
  [/crop|wheat|corn|carrot|pumpkin|tomato|potato|cabbage|lettuce|eggplant/i, "crop"],
  [/dino|rex|raptor|saurus|triceratops|stego|velo|parasaur|trike|apato/i, "dinosaur"],
  [/fish|shark|whale|dolphin|octopus|squid|turtle|crab|manta|puffer/i, "sea"],
  [/monster|alien|goblin|slime|ghost|blob|demon/i, "monster"],
  [/(^|[_ -])(wo)?man([_ -]|\d|$)|female|(^|[_ -])male|boy|girl|character|human|people/i, "human"],
];

export function guessTags(name: string, type: ImportableType): string[] {
  const tags = new Set<string>([type]);
  for (const [re, tag] of TAG_RULES) if (re.test(name)) tags.add(tag);
  return [...tags];
}

export function snake(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function fbxToGlb(file: string, outDir: string): string {
  const bin = process.env.FBX2GLTF_PATH ?? join(ROOT, "tools", "bin", process.platform === "win32" ? "FBX2glTF.exe" : "FBX2glTF");
  if (!existsSync(bin)) throw new Error(`Không có FBX2glTF (${bin}). Tải: https://github.com/facebookincubator/FBX2glTF/releases`);
  const out = join(outDir, basename(file, extname(file)));
  const r = spawnSync(bin, ["--binary", "--input", file, "--output", out], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`FBX2glTF lỗi: ${(r.stderr || r.stdout).slice(-800)}`);
  return `${out}.glb`;
}

export async function readRegistry(): Promise<Registry> {
  return RegistrySchema.parse(JSON.parse(await readFile(REGISTRY_FILE, "utf8")));
}

export async function writeRegistry(registry: Registry): Promise<void> {
  await writeFile(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Import một hoặc nhiều file (cùng tùy chọn). Registry chỉ được ghi khi tất cả thành công. */
export async function importAssets(files: string[], o: ImportOptions): Promise<ImportResult[]> {
  if (files.length > 1 && o.id) throw new Error("id chỉ dùng cho 1 file; nhiều file thì dùng prefix");
  const folder = FOLDER[o.type];
  if (!folder) throw new Error(`Loại asset không hợp lệ: ${String(o.type)}`);

  const registry = await readRegistry();
  const tmp = await mkdtemp(join(tmpdir(), "ac-asset-"));
  const results: ImportResult[] = [];
  const pending: { path: string; data: Uint8Array }[] = [];
  try {
    for (const src of files) {
      const ext = extname(src).toLowerCase();
      if (![".fbx", ".gltf", ".glb"].includes(ext)) throw new Error(`${basename(src)}: chỉ hỗ trợ .fbx, .gltf, .glb`);
      const stem = basename(src, extname(src));
      const id = o.id ?? `${o.prefix ?? (o.type === "character" ? "char_" : `${o.type}_`)}${snake(stem)}`;
      if (!ID.test(id)) throw new Error(`id "${id}" chỉ gồm chữ thường, số, '_'`);
      const existing = registry.assets.find((a) => a.id === id);
      if (existing && existing.type !== o.type) throw new Error(`id "${id}" đã dùng cho asset loại ${existing.type}`);

      const doc = await io.read(ext === ".fbx" ? fbxToGlb(src, tmp) : src);
      const root = doc.getRoot();
      // "Armature|Walk" → "Walk"; "Swim.001" (đuôi trùng tên của Blender) → "Swim".
      for (const anim of root.listAnimations()) anim.setName(anim.getName().split("|").pop()!.trim().replace(/\.\d{3}$/, ""));
      const anims = root.listAnimations();
      stripClipPrefixes(anims.map((a) => a.getName())).forEach((n, i) => anims[i]!.setName(n));
      // Bản Poly Pizza chứa mỗi clip 2 lần ("Walk" + "AnimalArmature|Walk") → giữ bản đầu.
      const clipNames = new Set<string>();
      for (const anim of root.listAnimations()) {
        if (clipNames.has(anim.getName())) anim.dispose();
        else clipNames.add(anim.getName());
      }
      await doc.transform(dedup(), prune());
      // Nén texture: tối đa MAX_TEXTURE px, WebP (gói "stylized" có normal map 4K PNG ~20 MB/ảnh).
      if (root.listTextures().length) {
        await doc.transform(textureCompress({ encoder: sharp, targetFormat: "webp", resize: [MAX_TEXTURE, MAX_TEXTURE], quality: 82 }));
      }
      const clips = root.listAnimations().map((a) => a.getName());
      const warnings: string[] = [];
      if (o.type === "character" && clips.length === 0) warnings.push("không có animation – nhân vật sẽ đứng yên");
      if (root.listMeshes().length === 0) warnings.push("không có mesh nào");

      const { aliases, fallbacks } = o.type === "character" ? buildAliases(clips) : { aliases: {}, fallbacks: [] };
      if (o.type === "character" && !aliases.idle && clips.length) warnings.push(`không có clip Idle – dùng "${clips[0]}" làm mặc định`);
      const file = `${folder}/${id}.glb`;
      const entry = AssetEntrySchema.parse({
        id,
        type: o.type,
        name: o.name?.trim() || stem.replace(/_/g, " "),
        file,
        height: o.height,
        scale: o.height ? undefined : o.scale,
        headingOffset: o.headingOffset ?? 0,
        tags: [...new Set([...guessTags(stem, o.type), ...(o.tags ?? [])])],
        pack: o.pack,
        ...(o.type === "character" ? { defaultClip: aliases.idle ?? clips[0], clips, clipAliases: aliases } : {}),
        ...(o.type === "character" && aliases.walk
          ? { suggestedSpeed: { [aliases.walk]: 1.2, ...(aliases.run && aliases.run !== aliases.walk ? { [aliases.run]: 3.2 } : {}) } }
          : {}),
        rootMotion: "none",
        license: o.license,
        author: o.author,
        source: o.source,
        commercialUse: COMMERCIAL_LICENSES.has(o.license),
        attributionRequired: o.attribution === true || o.license !== "CC0-1.0",
      });

      pending.push({ path: join(ASSETS_DIR, file), data: await io.writeBinary(doc) });
      const idx = registry.assets.findIndex((a) => a.id === id);
      if (idx >= 0) registry.assets[idx] = entry;
      else registry.assets.push(entry);
      results.push({ entry, fallbacks, warnings });
    }

    if (!o.dryRun) {
      for (const p of pending) {
        await mkdir(join(ASSETS_DIR, folder), { recursive: true });
        await writeFile(p.path, p.data);
      }
      await writeRegistry(registry);
    }
    return results;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Sửa thông tin hiển thị / chuẩn hóa của asset (không đổi file, id, clip). */
export const EDITABLE_FIELDS = ["name", "height", "scale", "tags", "headingOffset", "license", "author", "source", "attributionRequired", "defaultClip", "holdHeight", "holdPoints"] as const;

export async function updateAsset(id: string, patch: Record<string, unknown>): Promise<AssetEntry> {
  const registry = await readRegistry();
  const idx = registry.assets.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error(`Không có asset "${id}"`);
  const current = registry.assets[idx]!;
  const next: Record<string, unknown> = { ...current };
  for (const k of EDITABLE_FIELDS) if (k in patch) next[k] = patch[k] === null ? undefined : patch[k];
  if (typeof next.license === "string") next.commercialUse = COMMERCIAL_LICENSES.has(next.license);
  if (typeof next.defaultClip === "string" && !current.clips.includes(next.defaultClip)) throw new Error(`Clip "${next.defaultClip}" không có`);
  const entry = AssetEntrySchema.parse(next);
  registry.assets[idx] = entry;
  await writeRegistry(registry);
  return entry;
}
