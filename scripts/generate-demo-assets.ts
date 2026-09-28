/**
 * Sinh asset demo low-poly (tự tạo → CC0): bối cảnh công viên + khúc gỗ.
 * Chạy: npm run assets:generate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// GLTFExporter dùng FileReader (chỉ có trên trình duyệt) → polyfill tối thiểu cho Node.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
      this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const OUT = resolve(import.meta.dirname, "../public/assets");

/** RNG tất định (mulberry32) → asset sinh lại luôn giống nhau. */
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

function mat(color: string, name: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, name, roughness: 0.9, metalness: 0, flatShading: true });
}

/** Chuẩn hóa geometry về non-indexed + normal phẳng để merge được và ra chất low-poly. */
function prep(geo: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(matrix);
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  return g;
}

class Batch {
  private parts = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  add(material: THREE.MeshStandardMaterial, geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const entry = this.parts.get(material.name) ?? { material, geos: [] };
    entry.geos.push(prep(geo, matrix));
    this.parts.set(material.name, entry);
  }
  toGroup(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, { material, geos }] of this.parts) {
      const merged = mergeGeometries(geos, false);
      if (!merged) throw new Error(`merge thất bại: ${key}`);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = key;
      group.add(mesh);
    }
    return group;
  }
}

function m4(pos: THREE.Vector3Like, rotY = 0, scale: THREE.Vector3Like = { x: 1, y: 1, z: 1 }, rotX = 0, rotZ = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos.x, pos.y, pos.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ)),
    new THREE.Vector3(scale.x, scale.y, scale.z),
  );
}

function buildPark(): THREE.Group {
  const rand = rng(20260925);
  const b = new Batch();

  const grass = mat("#7fbf5a", "grass");
  const dirt = mat("#d8b77a", "dirt");
  const trunk = mat("#7a5230", "trunk");
  const leavesA = mat("#3f8f3a", "leaves_a");
  const leavesB = mat("#5aa843", "leaves_b");
  const leavesC = mat("#2f7a45", "leaves_c");
  const rock = mat("#9a9a94", "rock");
  const bush = mat("#4c9a3c", "bush");
  const hill = mat("#8fcf6a", "hill");
  const flowerR = mat("#ff6b8a", "flower_r");
  const flowerY = mat("#ffd24a", "flower_y");

  // Mặt đất phẳng tại y = 0 (quy ước MVP).
  b.add(grass, new THREE.PlaneGeometry(120, 120, 1, 1), m4({ x: 0, y: 0, z: 0 }, 0, undefined, -Math.PI / 2));
  // Lối đi dọc trục Z.
  b.add(dirt, new THREE.PlaneGeometry(3.2, 70, 1, 1), m4({ x: 0, y: 0.01, z: 5 }, 0, undefined, -Math.PI / 2));

  const onPath = (x: number, z: number): boolean => Math.abs(x) < 3.6 && z > -32 && z < 42;

  // Cây.
  for (let i = 0; i < 90; i++) {
    const x = (rand() - 0.5) * 80;
    const z = (rand() - 0.5) * 80 + 5;
    if (onPath(x, z) || Math.abs(x) < 4.5) continue;
    const s = 0.8 + rand() * 0.9;
    const rot = rand() * Math.PI * 2;
    b.add(trunk, new THREE.CylinderGeometry(0.18, 0.25, 1.6, 6), m4({ x, y: 0.8 * s, z }, rot, { x: s, y: s, z: s }));
    const leaves = [leavesA, leavesB, leavesC][Math.floor(rand() * 3)]!;
    if (rand() < 0.55) {
      // Cây thông: 2 tầng nón.
      b.add(leaves, new THREE.ConeGeometry(1.3, 2.2, 7), m4({ x, y: (1.6 + 0.9) * s, z }, rot, { x: s, y: s, z: s }));
      b.add(leaves, new THREE.ConeGeometry(0.95, 1.7, 7), m4({ x, y: (1.6 + 2.0) * s, z }, rot, { x: s, y: s, z: s }));
    } else {
      // Cây tán tròn.
      b.add(leaves, new THREE.IcosahedronGeometry(1.25, 0), m4({ x, y: (1.6 + 0.8) * s, z }, rot, { x: s, y: s * 0.9, z: s }));
    }
  }

  // Bụi cây ven đường.
  for (let i = 0; i < 40; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = side * (2.3 + rand() * 3);
    const z = -25 + rand() * 60;
    const s = 0.4 + rand() * 0.4;
    b.add(bush, new THREE.IcosahedronGeometry(0.8, 0), m4({ x, y: 0.35 * s, z }, rand() * 6, { x: s * 1.2, y: s, z: s * 1.2 }));
  }

  // Đá.
  for (let i = 0; i < 30; i++) {
    const x = (rand() - 0.5) * 60;
    const z = (rand() - 0.5) * 60 + 5;
    if (onPath(x, z)) continue;
    const s = 0.25 + rand() * 0.6;
    b.add(rock, new THREE.DodecahedronGeometry(0.7, 0), m4({ x, y: 0.2 * s, z }, rand() * 6, { x: s, y: s * 0.7, z: s }));
  }

  // Hoa.
  for (let i = 0; i < 80; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = side * (1.9 + rand() * 6);
    const z = -25 + rand() * 60;
    b.add(rand() < 0.5 ? flowerR : flowerY, new THREE.OctahedronGeometry(0.09, 0), m4({ x, y: 0.12, z }, rand() * 6));
  }

  // Đồi xa làm phông nền.
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + rand() * 0.2;
    const r = 52 + rand() * 6;
    const s = 8 + rand() * 7;
    b.add(hill, new THREE.IcosahedronGeometry(1, 1), m4({ x: Math.cos(angle) * r, y: -s * 0.35, z: Math.sin(angle) * r + 5 }, 0, { x: s * 1.6, y: s, z: s * 1.6 }));
  }

  return b.toGroup("env_park");
}

function buildLog(): THREE.Group {
  const b = new Batch();
  const bark = mat("#8a5a33", "bark");
  const cut = mat("#e2bf86", "cut");
  const radius = 0.28;
  // Khúc gỗ nằm dọc trục Z (heading 90 → nằm ngang trục X).
  const along = m4({ x: 0, y: radius, z: 0 }, 0, undefined, Math.PI / 2);
  b.add(bark, new THREE.CylinderGeometry(radius, radius * 1.05, 2.4, 9, 1, true), along);
  b.add(cut, new THREE.CircleGeometry(radius * 0.98, 9), m4({ x: 0, y: radius, z: 1.2 }));
  b.add(cut, new THREE.CircleGeometry(radius * 0.98, 9), m4({ x: 0, y: radius, z: -1.2 }, Math.PI));
  // Mấu cành.
  b.add(bark, new THREE.CylinderGeometry(0.06, 0.09, 0.4, 6), m4({ x: 0.2, y: radius + 0.2, z: 0.4 }, 0, undefined, 0, -0.7));
  return b.toGroup("prop_log");
}

async function exportGlb(object: THREE.Object3D, file: string): Promise<void> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("GLTFExporter không trả về GLB");
  const path = resolve(OUT, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(result));
  console.log(`✓ ${file} (${(result.byteLength / 1024).toFixed(1)} KB)`);
}

/** Rác cho cảnh ô nhiễm: chai nhựa, lon, túi ni lông (nằm trên mặt đất/mặt nước). */
function buildBottle(): THREE.Group {
  const b = new Batch();
  const plastic = new THREE.MeshStandardMaterial({ color: "#7fd0e6", name: "plastic", roughness: 0.3, metalness: 0, transparent: true, opacity: 0.8, flatShading: true });
  const cap = mat("#1f6fd1", "cap");
  const label = mat("#e84c3d", "label");
  // Chai nằm dọc trục X, cao ~ bán kính.
  const lying = (x: number) => m4({ x, y: 0.07, z: 0 }, 0, undefined, 0, Math.PI / 2);
  b.add(plastic, new THREE.CylinderGeometry(0.07, 0.07, 0.2, 10), lying(0));
  b.add(label, new THREE.CylinderGeometry(0.072, 0.072, 0.07, 10), lying(0.01));
  b.add(plastic, new THREE.CylinderGeometry(0.03, 0.07, 0.07, 10), lying(0.135));
  b.add(cap, new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), lying(0.185));
  return b.toGroup("prop_trash_bottle");
}

function buildCan(): THREE.Group {
  const b = new Batch();
  const metal = new THREE.MeshStandardMaterial({ color: "#c9ccd1", name: "metal", roughness: 0.35, metalness: 0.6, flatShading: true });
  const paint = mat("#2eaa4a", "paint");
  const lying = m4({ x: 0, y: 0.045, z: 0 }, 0.6, undefined, 0, Math.PI / 2);
  b.add(paint, new THREE.CylinderGeometry(0.045, 0.045, 0.1, 10), lying);
  b.add(metal, new THREE.CylinderGeometry(0.042, 0.046, 0.125, 10, 1, true), lying);
  return b.toGroup("prop_trash_can");
}

function buildBag(): THREE.Group {
  const b = new Batch();
  const bag = new THREE.MeshStandardMaterial({ color: "#f1f1ee", name: "bag", roughness: 0.6, transparent: true, opacity: 0.85, flatShading: true });
  const stripe = mat("#e0a52b", "stripe");
  b.add(bag, new THREE.IcosahedronGeometry(0.22, 1), m4({ x: 0, y: 0.06, z: 0 }, 0.3, { x: 1.2, y: 0.28, z: 0.9 }));
  b.add(stripe, new THREE.TorusGeometry(0.08, 0.015, 4, 10), m4({ x: 0.18, y: 0.1, z: 0 }, 0, undefined, Math.PI / 2));
  return b.toGroup("prop_trash_bag");
}

await exportGlb(buildPark(), "environments/park.glb");
await exportGlb(buildBottle(), "props/trash_bottle.glb");
await exportGlb(buildCan(), "props/trash_can.glb");
await exportGlb(buildBag(), "props/trash_bag.glb");
await exportGlb(buildLog(), "props/log.glb");
