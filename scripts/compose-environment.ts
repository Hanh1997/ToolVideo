/**
 * Ghép bối cảnh (environment GLB) từ các đạo cụ trong Registry theo một file layout.
 *
 *   npm run env:compose -- environments/forest.layout.json
 *
 * Layout:
 * {
 *   "id": "env_forest", "name": "Rừng", "seed": 7,
 *   "ground": { "size": 120, "color": "#6fb05a" },
 *   "path":   { "width": 3.2, "from": -30, "to": 40, "color": "#d8b77a" },      // lối đi dọc trục Z tại x = 0
 *   "place":  [ { "asset": "prop_n_common_tree_1", "position": { "x": 5, "z": 3 }, "heading": 30, "scale": 1.2 } ],
 *             // anchor "center": position = tâm đáy của món (xoay quanh tâm) – hợp đồ nội thất có gốc ở góc; y = đặt lên bàn / kệ
 *   "floors": [ { "x": 0, "z": 0, "w": 10, "d": 8, "color": "#c8955f" } ],        // sàn trong nhà (trên nền)
 *   "scatter":[ { "tags": ["tree"], "pack": "…", "count": 80, "area": { "x": [-40, 40], "z": [-35, 45] },
 *                 "clearPath": 4.5, "minDistance": 2.5, "scale": [0.8, 1.3] } ]
 * }
 *
 * Mỗi đạo cụ được chuẩn hóa như trong engine (height / scale, chân chạm y = 0).
 * Các lượt đặt cùng một đạo cụ dùng chung mesh (instancing theo node) → file nhỏ.
 * Kết quả: public/assets/environments/<id>.glb + mục registry (type environment).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Document, NodeIO, type Node, type Scene } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, getBounds, mergeDocuments, prune } from "@gltf-transform/functions";
import { z } from "zod";
import { AssetEntrySchema, type AssetEntry } from "../src/schemas/asset.schema";
import { ASSETS_DIR, readRegistry, writeRegistry } from "../server/assets/importAsset";

const Vec = z.object({ x: z.number(), z: z.number() });
const Range = z.tuple([z.number(), z.number()]);
const LayoutSchema = z.object({
  id: z.string().regex(/^env_[a-z0-9_]+$/),
  name: z.string(),
  description: z.string().optional(),
  seed: z.number().int().default(1),
  ground: z.object({ size: z.number().positive().default(120), color: z.string().default("#7fbf5a") }).default({ size: 120, color: "#7fbf5a" }),
  path: z.object({ width: z.number().positive(), from: z.number(), to: z.number(), color: z.string().default("#d8b77a") }).optional(),
  /** Ao / hồ: đĩa nước phẳng + viền bờ. */
  ponds: z
    .array(z.object({ x: z.number(), z: z.number(), radius: z.number().positive(), color: z.string().default("#4f9fcf"), shore: z.string().default("#8a7a55") }))
    .default([]),
  /** Vùng trống (không rải đạo cụ) – chỗ nhân vật đứng, họp… */
  clearings: z.array(z.object({ x: z.number(), z: z.number(), radius: z.number().positive() })).default([]),
  place: z
    .array(
      z.object({
        asset: z.string(),
        position: Vec,
        heading: z.number().default(0),
        scale: z.number().positive().default(1),
        /** "corner" = gốc toạ độ của model (mặc định), "center" = tâm hình chiếu đáy. */
        anchor: z.enum(["corner", "center"]).default("corner"),
        /** Nâng lên (m) – đặt đồ lên bàn, kệ, tủ. */
        y: z.number().default(0),
      }),
    )
    .default([]),
  /** Sàn (hình chữ nhật phẳng, nằm trên nền) – phòng trong nhà. */
  floors: z.array(z.object({ x: z.number(), z: z.number(), w: z.number().positive(), d: z.number().positive(), color: z.string() })).default([]),
  scatter: z
    .array(
      z.object({
        tags: z.array(z.string()).min(1),
        /** Chỉ lấy đạo cụ thuộc gói này (tùy chọn). */
        pack: z.string().optional(),
        /** Chỉ lấy đạo cụ có id chứa một trong các chuỗi này (tùy chọn). */
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).default([]),
        count: z.number().int().positive(),
        area: z.object({ x: Range, z: Range }),
        /** Nửa bề rộng vùng tránh quanh lối đi (x = 0). */
        clearPath: z.number().min(0).default(0),
        /** Khoảng cách tối thiểu tới các món đã rải trong cùng nhóm. */
        minDistance: z.number().min(0).default(0),
        scale: Range.default([0.85, 1.15]),
        /** Cho phép rải trong ao / vùng trống (vd. rác trôi trên mặt ao). */
        allowInBlocked: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Xếp theo lưới (luống ngô, hàng rào…): mỗi ô chọn ngẫu nhiên trong các asset. */
  grid: z
    .array(
      z.object({
        assets: z.array(z.string()).min(1),
        origin: Vec,
        rows: z.number().int().positive(),
        cols: z.number().int().positive(),
        spacing: Vec,
        heading: z.number().default(0),
        jitter: z.number().min(0).default(0),
        scale: Range.default([1, 1]),
      }),
    )
    .default([]),
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToLinear(hex: string): [number, number, number, number] {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return [lin[0]!, lin[1]!, lin[2]!, 1];
}

const layoutFile = process.argv[2];
if (!layoutFile) {
  console.error("Cách dùng: npm run env:compose -- <layout.json>");
  process.exit(2);
}
const layout = LayoutSchema.parse(JSON.parse(await readFile(resolve(process.cwd(), layoutFile), "utf8")));
const registry = await readRegistry();
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene(layout.id);
const rand = rng(layout.seed);

// ----------------------------------------------------------------- nền + lối đi
function flatQuad(name: string, cx: number, cz: number, w: number, d: number, y: number, color: string): Node {
  const hw = w / 2;
  const hd = d / 2;
  const pos = doc
    .createAccessor()
    .setType("VEC3")
    .setBuffer(buffer)
    .setArray(new Float32Array([cx - hw, y, cz - hd, cx + hw, y, cz - hd, cx + hw, y, cz + hd, cx - hw, y, cz + hd]));
  const nor = doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]));
  const idx = doc.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Uint16Array([0, 2, 1, 0, 3, 2]));
  const mat = doc.createMaterial(name).setBaseColorFactor(hexToLinear(color)).setRoughnessFactor(0.95).setMetallicFactor(0);
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("NORMAL", nor).setIndices(idx).setMaterial(mat);
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
}

scene.addChild(flatQuad("ground", 0, 0, layout.ground.size, layout.ground.size, 0, layout.ground.color));
layout.floors.forEach((f, i) => scene.addChild(flatQuad(`floor_${i}`, f.x, f.z, f.w, f.d, 0.004, f.color)));
if (layout.path) {
  const len = layout.path.to - layout.path.from;
  scene.addChild(flatQuad("path", 0, (layout.path.from + layout.path.to) / 2, layout.path.width, len, 0.01, layout.path.color));
}

function disc(name: string, cx: number, cz: number, r: number, y: number, color: string, segments = 40): Node {
  const pos: number[] = [cx, y, cz];
  const nor: number[] = [0, 1, 0];
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    // Mép hơi gợn cho tự nhiên (tất định).
    const rr = r * (1 + 0.06 * Math.sin(a * 3 + cx) + 0.04 * Math.cos(a * 5 + cz));
    pos.push(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr);
    nor.push(0, 1, 0);
    idx.push(0, 1 + ((i + 1) % segments), 1 + i);
  }
  const acc = (type: "VEC3" | "SCALAR", arr: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) => doc.createAccessor().setType(type).setBuffer(buffer).setArray(arr);
  // Mặt nước bóng hơn bờ (phản chiếu bầu trời) – vẫn là vật liệu PBR thường, không cần shader riêng.
  const water = name.startsWith("pond");
  const mat = doc
    .createMaterial(name)
    .setBaseColorFactor(hexToLinear(color))
    .setRoughnessFactor(water ? 0.08 : 0.9)
    .setMetallicFactor(water ? 0.35 : 0);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", acc("VEC3", new Float32Array(pos)))
    .setAttribute("NORMAL", acc("VEC3", new Float32Array(nor)))
    .setIndices(acc("SCALAR", new Uint16Array(idx)))
    .setMaterial(mat);
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
}

layout.ponds.forEach((p, i) => {
  scene.addChild(disc(`shore_${i}`, p.x, p.z, p.radius * 1.18, 0.012, p.shore));
  scene.addChild(disc(`pond_${i}`, p.x, p.z, p.radius, 0.022, p.color));
});

/** Điểm (x, z) có nằm trong ao / vùng trống không (cộng thêm lề m). */
function blocked(x: number, zPos: number, margin: number): boolean {
  return (
    layout.ponds.some((p) => Math.hypot(x - p.x, zPos - p.z) < p.radius * 1.2 + margin) ||
    layout.clearings.some((c) => Math.hypot(x - c.x, zPos - c.z) < c.radius + margin)
  );
}

// ----------------------------------------------------------------- mẫu đạo cụ (nạp 1 lần / asset)
interface Template {
  asset: AssetEntry;
  roots: Node[];
  scale: number;
  yOffset: number;
  radius: number;
  /** Tâm hình chiếu đáy (đã nhân tỷ lệ) trong hệ của model. */
  cx: number;
  cz: number;
}
const templates = new Map<string, Template>();

async function template(asset: AssetEntry): Promise<Template> {
  const hit = templates.get(asset.id);
  if (hit) return hit;
  const src = await io.read(join(ASSETS_DIR, asset.file));
  const srcScene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0];
  if (!srcScene) throw new Error(`${asset.id}: không có scene`);
  const box = getBounds(srcScene);
  const sizeY = box.max[1] - box.min[1];
  const s = asset.height && sizeY > 0 ? asset.height / sizeY : (asset.scale ?? 1);
  const map = mergeDocuments(doc, src);
  const mergedScene = map.get(srcScene) as Scene;
  // Giữ node gốc làm "mẫu" (không nằm trong scene nào), bỏ scene nguồn.
  const roots = mergedScene.listChildren();
  for (const r of roots) mergedScene.removeChild(r);
  mergedScene.dispose();
  // Buffer của tài liệu nguồn → dùng buffer chung.
  for (const acc of doc.getRoot().listAccessors()) acc.setBuffer(buffer);
  const radius = (Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) * s) / 2;
  const t: Template = { asset, roots, scale: s, yOffset: -box.min[1] * s, radius, cx: ((box.min[0] + box.max[0]) / 2) * s, cz: ((box.min[2] + box.max[2]) / 2) * s };
  templates.set(asset.id, t);
  return t;
}

/** Bản sao cây node dùng CHUNG mesh/material (instancing). */
function cloneTree(n: Node): Node {
  const c = doc.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
  const mesh = n.getMesh();
  if (mesh) c.setMesh(mesh);
  for (const ch of n.listChildren()) c.addChild(cloneTree(ch));
  return c;
}

let placed = 0;
function put(t: Template, x: number, zPos: number, headingDeg: number, extraScale: number, anchor: "corner" | "center" = "corner", lift = 0): void {
  const s = t.scale * extraScale;
  const h = (headingDeg + t.asset.headingOffset) * (Math.PI / 180);
  if (anchor === "center") {
    // Dời gốc để tâm đáy (đã xoay) rơi đúng vào (x, z).
    const ox = t.cx * extraScale;
    const oz = t.cz * extraScale;
    x -= ox * Math.cos(h) + oz * Math.sin(h);
    zPos -= -ox * Math.sin(h) + oz * Math.cos(h);
  }
  const holder = doc
    .createNode(`${t.asset.id}_${placed++}`)
    .setTranslation([x, t.yOffset * extraScale + lift, zPos])
    .setRotation([0, Math.sin(h / 2), 0, Math.cos(h / 2)])
    .setScale([s, s, s]);
  for (const r of t.roots) holder.addChild(cloneTree(r));
  scene.addChild(holder);
}

function propsFor(rule: z.infer<typeof LayoutSchema>["scatter"][number]): AssetEntry[] {
  return registry.assets.filter(
    (a) =>
      a.type === "prop" &&
      rule.tags.some((t) => a.tags.includes(t)) &&
      (!rule.pack || a.pack === rule.pack) &&
      (!rule.include || rule.include.some((s) => a.id.includes(s))) &&
      !rule.exclude.some((s) => a.id.includes(s)),
  );
}

for (const p of layout.place) {
  const asset = registry.assets.find((a) => a.id === p.asset);
  if (!asset) throw new Error(`place: không có asset "${p.asset}"`);
  put(await template(asset), p.position.x, p.position.z, p.heading, p.scale, p.anchor, p.y);
}

for (const g of layout.grid) {
  const pool: AssetEntry[] = g.assets.map((id) => {
    const a = registry.assets.find((x) => x.id === id);
    if (!a) throw new Error(`grid: không có asset "${id}"`);
    return a;
  });
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const asset = pool[Math.floor(rand() * pool.length)]!;
      const x = g.origin.x + c * g.spacing.x + (rand() - 0.5) * g.jitter;
      const zPos = g.origin.z + r * g.spacing.z + (rand() - 0.5) * g.jitter;
      const k = g.scale[0] + rand() * (g.scale[1] - g.scale[0]);
      put(await template(asset), x, zPos, g.heading + (rand() - 0.5) * g.jitter * 20, k);
    }
  }
  console.log(`  lưới ${g.rows}×${g.cols} [${g.assets.length} mẫu]`);
}

for (const rule of layout.scatter) {
  const pool = propsFor(rule);
  if (pool.length === 0) throw new Error(`scatter [${rule.tags.join(",")}]: không có đạo cụ phù hợp`);
  const taken: { x: number; z: number; r: number }[] = [];
  let made = 0;
  for (let attempt = 0; made < rule.count && attempt < rule.count * 30; attempt++) {
    const x = rule.area.x[0] + rand() * (rule.area.x[1] - rule.area.x[0]);
    const zPos = rule.area.z[0] + rand() * (rule.area.z[1] - rule.area.z[0]);
    const asset = pool[Math.floor(rand() * pool.length)]!;
    const k = rule.scale[0] + rand() * (rule.scale[1] - rule.scale[0]);
    const heading = rand() * 360;
    const t = await template(asset);
    const r = t.radius * k;
    if (layout.path && Math.abs(x) < rule.clearPath + r * 0.5 && zPos > layout.path.from - 2 && zPos < layout.path.to + 2) continue;
    if (!rule.allowInBlocked && blocked(x, zPos, r * 0.5)) continue;
    if (taken.some((o) => Math.hypot(o.x - x, o.z - zPos) < Math.max(rule.minDistance, (o.r + r) * 0.6))) continue;
    taken.push({ x, z: zPos, r });
    put(t, x, zPos, heading, k);
    made++;
  }
  console.log(`  rải [${rule.tags.join(",")}] ${made}/${rule.count} từ ${pool.length} mẫu`);
}

// Dọn scene mặc định thừa, gộp dữ liệu trùng, bỏ phần không dùng.
doc.getRoot().setDefaultScene(scene);
for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
await doc.transform(dedup(), prune());

const file = `environments/${layout.id}.glb`;
await io.write(join(ASSETS_DIR, file), doc);

const used = [...templates.values()].map((t) => t.asset);
const packs = [...new Set(used.map((a) => a.pack ?? a.author))];
const entry = AssetEntrySchema.parse({
  id: layout.id,
  type: "environment",
  name: layout.name,
  file,
  headingOffset: 0,
  tags: ["environment", ...new Set(used.flatMap((a) => a.tags).filter((t) => t !== "prop"))],
  pack: "AutoCartoon · ghép từ đạo cụ",
  license: used.every((a) => a.license === "CC0-1.0") ? "CC0-1.0" : "CC-BY-4.0",
  author: `AutoCartoon (ghép từ: ${packs.join("; ")})`,
  source: `scripts/compose-environment.ts + ${layoutFile.replaceAll("\\", "/")}`,
  commercialUse: used.every((a) => a.commercialUse),
  attributionRequired: used.some((a) => a.attributionRequired),
});
const idx = registry.assets.findIndex((a) => a.id === entry.id);
if (idx >= 0) registry.assets[idx] = entry;
else registry.assets.push(entry);
await writeRegistry(registry);
console.log(`✓ ${file}: ${placed} đạo cụ, ${templates.size} mẫu`);
