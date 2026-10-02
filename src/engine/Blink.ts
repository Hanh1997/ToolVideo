import * as THREE from "three";
import type { Emotion } from "../schemas/scene.schema";
import { clamp, smoothstep } from "./math";

/**
 * Chớp mắt cho nhân vật có mắt vẽ trên bề mặt (Kenney khối vuông, mắt hạt đen…), không cần sửa model:
 *   findEyes   – dò hai mắt: cụm tam giác trắng/tối trên cùng một mặt phẳng, không vắt qua giữa mặt, đối xứng trái–phải
 *   Eyelids    – mỗi mắt một "mí": bản sao đúng hình các tam giác của mắt, dùng chính material của mặt với UV trỏ vào
 *                ô màu da ngay trên mắt (khớp màu + ánh sáng), kéo từ mép trên xuống; kèm viền mi tối ở mép dưới
 *   eyeClosure – độ nhắm 0..1 tại t: chớp tự nhiên (tất định theo id), thỉnh thoảng chớp đôi, nheo theo cảm xúc
 */

// ---------------------------------------------------------------- nhịp chớp (hàm thuần)

/** Số giả ngẫu nhiên 0..1 tất định theo (id, k). */
function hash01(id: string, k: number): number {
  let h = 2166136261 ^ k;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const CLOSE = 0.07;
const HOLD = 0.04;
const OPEN = 0.12;
const BLINK = CLOSE + HOLD + OPEN;

/** Một cái chớp bắt đầu tại 0: 0 → 1 → 0. */
function blinkShape(local: number): number {
  if (local <= 0 || local >= BLINK) return 0;
  if (local < CLOSE) return smoothstep(local / CLOSE);
  if (local < CLOSE + HOLD) return 1;
  return 1 - smoothstep((local - CLOSE - HOLD) / OPEN);
}

/** Sụp mí theo cảm xúc (0..1): buồn, giận. Vui không nheo (mí kéo từ trên xuống trông như cau mày). Ngạc nhiên, sợ: mở to, gần như không chớp. */
const EMOTION_LID: Record<Emotion, number> = { neutral: 0, happy: 0, sad: 0.35, angry: 0.3, surprised: 0, scared: 0 };

/** Độ nhắm mắt 0..1 của nhân vật `id` tại t (cảm xúc hiện tại + độ đậm tuỳ chọn). */
export function eyeClosure(id: string, t: number, emotion?: { kind: Emotion; weight: number }): number {
  // Chớp đầu sau 0.4–2 s, rồi cách nhau 2.2–5 s; 18% là chớp đôi.
  let at = 0.4 + hash01(id, 0) * 1.6;
  let blink = 0;
  for (let k = 1; at <= t + BLINK && k < 10000; k++) {
    blink = Math.max(blink, blinkShape(t - at));
    if (hash01(id, k * 7 + 3) < 0.18) blink = Math.max(blink, blinkShape(t - at - BLINK - 0.08));
    at += 2.2 + hash01(id, k) * 2.8;
  }
  const w = emotion?.weight ?? 0;
  const lid = emotion ? EMOTION_LID[emotion.kind] * w : 0;
  // Mở to (ngạc nhiên / sợ): chớp nhẹ đi.
  const wide = emotion && (emotion.kind === "surprised" || emotion.kind === "scared") ? 1 - 0.8 * w : 1;
  return clamp(lid + (1 - lid) * blink * wide, 0, 1);
}

// ---------------------------------------------------------------- dò mắt trên model

interface Tri {
  mesh: THREE.Mesh;
  /** 3 đỉnh trong hệ toạ độ của mesh. */
  local: THREE.Vector3[];
  /** 3 đỉnh trong hệ toạ độ model (tư thế nghỉ). */
  world: THREE.Vector3[];
  normal: THREE.Vector3;
  /** Màu sRGB 0..1. */
  rgb: [number, number, number];
  /** UV trung bình (có texture). */
  uv?: [number, number];
  material: THREE.Material;
  kind: "light" | "dark" | "other";
}

export interface EyeSpot {
  mesh: THREE.Mesh;
  /** Tâm, pháp tuyến, trục ngang / dọc của mắt và nửa kích thước – trong hệ toạ độ của mesh. */
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  halfW: number;
  halfH: number;
  /** Màu da quanh mắt (sRGB 0..1). */
  skin: [number, number, number];
  /** Material của vùng da quanh mắt + UV của ô màu da (nếu có texture). */
  skinMaterial: THREE.Material;
  skinUV?: [number, number];
  /** Các tam giác của mắt (3 đỉnh / tam giác) trong khung mắt: x = ngang, y = lên (tâm = 0), z = pháp tuyến. */
  shape: THREE.Vector3[];
}

type Sampler = (u: number, v: number) => [number, number, number] | undefined;

/** Đọc điểm ảnh của texture (chỉ trong trình duyệt; Node/test → undefined). */
function textureSampler(tex: THREE.Texture | null | undefined): Sampler | undefined {
  const img = tex?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  if (!img || !img.width || !img.height) return undefined;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
    else if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      ctx = c.getContext("2d");
    }
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    const flip = tex!.flipY;
    return (u, v) => {
      const x = clamp(Math.floor((((u % 1) + 1) % 1) * width), 0, width - 1);
      const vv = ((v % 1) + 1) % 1;
      const y = clamp(Math.floor((flip ? 1 - vv : vv) * height), 0, height - 1);
      const o = (y * width + x) * 4;
      return [data[o]! / 255, data[o + 1]! / 255, data[o + 2]! / 255];
    };
  } catch {
    return undefined;
  }
}

function classify([r, g, b]: [number, number, number]): Tri["kind"] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = max > 0 ? (max - min) / max : 0;
  if (luma > 0.8 && sat < 0.15) return "light";
  if (luma < 0.38) return "dark";
  return "other";
}

function collectTris(model: THREE.Object3D): Tri[] {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const tris: Tri[] = [];
  const samplers = new Map<THREE.Material, Sampler | undefined>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
    const index = g.index;
    const count = index ? index.count : pos.count;
    const toModel = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      if (!mat) continue;
      if (!samplers.has(mat)) samplers.set(mat, textureSampler(mat.map));
      const sample = samplers.get(mat);
      if (mat.map && !sample) continue; // có texture nhưng không đọc được (Node) → bỏ qua
      const base = (mat.color ?? new THREE.Color(1, 1, 1)).clone().convertLinearToSRGB();
      for (let i = grp.start; i + 2 < grp.start + grp.count && i + 2 < count; i += 3) {
        const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
        const local = ids.map((v) => new THREE.Vector3().fromBufferAttribute(pos, v));
        const world = local.map((p) => p.clone().applyMatrix4(toModel));
        const normal = new THREE.Vector3().subVectors(world[1]!, world[0]!).cross(new THREE.Vector3().subVectors(world[2]!, world[0]!));
        if (normal.lengthSq() < 1e-14) continue;
        normal.normalize();
        let rgb: [number, number, number] = [base.r, base.g, base.b];
        let tuv: [number, number] | undefined;
        if (uv) {
          tuv = [(uv.getX(ids[0]!) + uv.getX(ids[1]!) + uv.getX(ids[2]!)) / 3, (uv.getY(ids[0]!) + uv.getY(ids[1]!) + uv.getY(ids[2]!)) / 3];
          const c = sample?.(tuv[0], tuv[1]);
          if (c) rgb = [c[0] * base.r, c[1] * base.g, c[2] * base.b];
        }
        tris.push({ mesh, local, world, normal, rgb, uv: tuv, material: mat, kind: classify(rgb) });
      }
    }
  });
  return tris;
}

const keyOf = (p: THREE.Vector3) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;

/** Dò hai mắt của model (đã chuẩn hoá tỷ lệ, chưa đặt vào cảnh). Không tìm được cặp rõ ràng → []. */
export function findEyes(model: THREE.Object3D): EyeSpot[] {
  const tris = collectTris(model);
  if (!tris.length) return [];
  const box = new THREE.Box3();
  for (const t of tris) for (const p of t.world) box.expandByPoint(p);
  const size = box.getSize(new THREE.Vector3());
  const height = size.y || 1;
  const midX = (box.min.x + box.max.x) / 2;
  const eps = 0.012 * height;

  // Nhóm theo mặt phẳng (pháp tuyến + khoảng cách), chỉ mặt đứng (mắt không nằm trên đỉnh / đáy).
  const planes = new Map<string, Tri[]>();
  for (const t of tris) {
    if (Math.abs(t.normal.y) > 0.5) continue;
    const d = t.normal.dot(t.world[0]!);
    const key = `${Math.round(t.normal.x * 10)},${Math.round(t.normal.z * 10)},${Math.round(d / eps)}`;
    const list = planes.get(key) ?? [];
    list.push(t);
    planes.set(key, list);
  }

  interface Blob { tris: Tri[]; box: THREE.Box3; center: THREE.Vector3; normal: THREE.Vector3; plane: Tri[] }
  const blobs: Blob[] = [];
  for (const plane of planes.values()) {
    const cand = plane.filter((t) => t.kind !== "other");
    // Cụm liên thông theo đỉnh chung.
    const parent = cand.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const owner = new Map<string, number>();
    cand.forEach((t, i) => {
      for (const p of t.world) {
        const k = keyOf(p);
        const j = owner.get(k);
        if (j === undefined) owner.set(k, i);
        else parent[find(i)] = find(j);
      }
    });
    const groups = new Map<number, Tri[]>();
    cand.forEach((t, i) => {
      const r = find(i);
      groups.set(r, [...(groups.get(r) ?? []), t]);
    });
    for (const g of groups.values()) {
      if (!g.some((t) => t.kind === "dark")) continue; // mắt phải có con ngươi / hạt mắt tối
      const b = new THREE.Box3();
      for (const t of g) for (const p of t.world) b.expandByPoint(p);
      const s = b.getSize(new THREE.Vector3());
      const c = b.getCenter(new THREE.Vector3());
      // Không vắt qua giữa mặt (mũi, miệng), không quá to (mảng lông), không quá nhỏ.
      if (b.min.x < midX - eps && b.max.x > midX + eps) continue;
      const span = Math.max(s.x, s.y, s.z);
      if (span > 0.32 * height || span < 0.02 * height) continue;
      if (c.y < box.min.y + 0.2 * height) continue; // chân
      const n = new THREE.Vector3();
      for (const t of g) n.add(t.normal);
      blobs.push({ tris: g, box: b, center: c, normal: n.normalize(), plane });
    }
  }

  // Ghép cặp đối xứng trái–phải; chọn cặp cao nhất (mắt ở trên mũi / miệng).
  let best: [Blob, Blob] | undefined;
  for (const a of blobs) {
    if (a.center.x <= midX) continue;
    for (const b of blobs) {
      if (b.center.x >= midX) continue;
      const mirror = new THREE.Vector3(2 * midX - b.center.x, b.center.y, b.center.z);
      if (mirror.distanceTo(a.center) > 0.05 * height) continue;
      const sa = a.box.getSize(new THREE.Vector3());
      const sb = b.box.getSize(new THREE.Vector3());
      if (Math.abs(sa.y - sb.y) > 0.3 * Math.max(sa.y, sb.y) + eps) continue;
      if (!best || a.center.y > best[0].center.y) best = [a, b];
    }
  }
  if (!best) return [];
  return best.map((b) => toSpot(b.tris, b.normal, b.plane)).filter((s): s is EyeSpot => s !== undefined);
}

/** Cụm tam giác mắt (hệ model) → hình chữ nhật trong hệ của mesh + màu da quanh mắt. */
function toSpot(eye: Tri[], normalModel: THREE.Vector3, plane: Tri[]): EyeSpot | undefined {
  const mesh = eye[0]!.mesh;
  const pts = eye.flatMap((t) => t.local);
  const n = new THREE.Vector3();
  for (const t of eye) {
    const ln = new THREE.Vector3().subVectors(t.local[1]!, t.local[0]!).cross(new THREE.Vector3().subVectors(t.local[2]!, t.local[0]!));
    if (ln.lengthSq() > 0) n.add(ln.normalize());
  }
  if (n.lengthSq() < 1e-10) return undefined;
  n.normalize();
  // "Lên" của thế giới (model đang đứng thẳng lúc nạp) trong hệ mesh, chiếu lên mặt phẳng mắt.
  const upModel = new THREE.Vector3(0, 1, 0).transformDirection(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  const up = upModel.sub(n.clone().multiplyScalar(upModel.dot(n)));
  if (up.lengthSq() < 1e-8) return undefined;
  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, n).normalize();
  const c0 = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, front = -Infinity;
  for (const p of pts) {
    const d = p.clone().sub(c0);
    minR = Math.min(minR, d.dot(right));
    maxR = Math.max(maxR, d.dot(right));
    minU = Math.min(minU, d.dot(up));
    maxU = Math.max(maxU, d.dot(up));
    front = Math.max(front, d.dot(n));
  }
  const center = c0.clone().addScaledVector(right, (minR + maxR) / 2).addScaledVector(up, (minU + maxU) / 2).addScaledVector(n, front);
  // Da: tam giác "khác" (không trắng/tối) cùng mặt phẳng, gần điểm ngay trên mép mắt nhất.
  const eyeBox = new THREE.Box3();
  for (const t of eye) for (const p of t.world) eyeBox.expandByPoint(p);
  const above = new THREE.Vector3((eyeBox.min.x + eyeBox.max.x) / 2, eyeBox.max.y + 0.15 * (eyeBox.max.y - eyeBox.min.y), (eyeBox.min.z + eyeBox.max.z) / 2);
  let skinTri: Tri | undefined;
  let bestD = Infinity;
  for (const t of plane) {
    if (t.kind !== "other") continue;
    const c = t.world[0]!.clone().add(t.world[1]!).add(t.world[2]!).multiplyScalar(1 / 3);
    const d = c.distanceTo(above);
    if (d < bestD) [bestD, skinTri] = [d, t];
  }
  if (!skinTri) return undefined;
  void normalModel;
  const shape = pts.map((p) => {
    const d = p.clone().sub(center);
    return new THREE.Vector3(d.dot(right), d.dot(up), d.dot(n));
  });
  return {
    mesh,
    center,
    normal: n,
    right,
    up,
    halfW: (maxR - minR) / 2,
    halfH: (maxU - minU) / 2,
    skin: skinTri.rgb,
    skinMaterial: skinTri.material,
    skinUV: skinTri.uv,
    shape,
  };
}

// ---------------------------------------------------------------- mí mắt

/** Bản sao hình mắt, mỗi frame "kẹp" đỉnh vào dải [lo, hi] theo trục lên → chỉ còn phần mắt nằm trong dải. */
class ClippedShape {
  readonly mesh: THREE.Mesh;
  private readonly pos: THREE.BufferAttribute;

  constructor(
    private readonly shape: readonly THREE.Vector3[],
    material: THREE.Material,
    uv: [number, number] | undefined,
  ) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(shape.length * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.pos);
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(shape.flatMap(() => [0, 0, 1])), 3));
    // Mọi đỉnh cùng một UV = ô màu da của texture → cùng màu, cùng ánh sáng với mặt.
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(shape.flatMap(() => uv)), 2));
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = "eyelid";
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  clip(lo: number, hi: number, z: number): void {
    this.shape.forEach((p, i) => this.pos.setXYZ(i, p.x, clamp(p.y, lo, hi), p.z + z));
    this.pos.needsUpdate = true;
  }
}

export class Eyelids {
  private readonly lids: { lid: ClippedShape; lash: ClippedShape; spot: EyeSpot }[] = [];
  /** Khung đặt tại tâm từng mắt (x = ngang, y = lên, z = hướng ra ngoài) – có thể chuyển sang xương đầu. */
  readonly frames: THREE.Group[] = [];

  constructor(spots: readonly EyeSpot[]) {
    for (const spot of spots) {
      const src = spot.skinMaterial as THREE.MeshStandardMaterial;
      // Có texture + UV: dùng lại chính material của mặt. Không: màu da lấy mẫu, cùng độ nhám.
      const reuse = !!src.map && !!spot.skinUV;
      const lidMat = reuse
        ? src
        : new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(spot.skin[0], spot.skin[1], spot.skin[2], THREE.SRGBColorSpace), roughness: src.roughness ?? 1, metalness: src.metalness ?? 0 });
      const k = 0.28;
      const lashMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(spot.skin[0] * k, spot.skin[1] * k, spot.skin[2] * k, THREE.SRGBColorSpace), roughness: 1 });
      const frame = new THREE.Group();
      frame.name = "eye";
      frame.position.copy(spot.center);
      frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(spot.right, spot.up, spot.normal));
      spot.mesh.add(frame);
      const lid = new ClippedShape(spot.shape, lidMat, reuse ? spot.skinUV : undefined);
      const lash = new ClippedShape(spot.shape, lashMat, undefined);
      frame.add(lid.mesh, lash.mesh);
      this.frames.push(frame);
      this.lids.push({ lid, lash, spot });
    }
  }

  get count(): number {
    return this.lids.length;
  }

  /** Độ nhắm 0 (mở) .. 1 (nhắm hẳn). */
  set(closure: number): void {
    const c = clamp(closure, 0, 1);
    for (const { lid, lash, spot } of this.lids) {
      const visible = c > 0.02;
      lid.mesh.visible = lash.mesh.visible = visible;
      if (!visible) continue;
      const h = 2 * spot.halfH;
      const lift = h * 0.015; // nhô trước mắt một chút, tránh z-fighting
      const top = spot.halfH + 0.01 * h;
      const edge = top - c * 1.02 * h;
      lid.clip(edge, top, lift);
      // Viền mi: dải tối mảnh ngay mép dưới mí, dày hơn khi nhắm hẳn.
      const lashH = h * (0.04 + 0.06 * c);
      lash.clip(edge - lashH * 0.5, edge + lashH * 0.5, lift * 1.6);
    }
  }
}
