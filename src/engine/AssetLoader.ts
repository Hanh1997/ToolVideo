import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RegistrySchema, type Registry } from "../schemas/asset.schema";

export async function loadRegistry(url = "/assets/registry.json"): Promise<Registry> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được Asset Registry (${res.status}) từ ${url}`);
  return RegistrySchema.parse(await res.json());
}

/**
 * Load GLB/glTF có cache: mỗi file chỉ tải một lần, các instance dùng SkeletonUtils.clone.
 */
export class AssetLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<GLTF>>();

  constructor(private readonly baseUrl = "/assets/") {}

  load(file: string): Promise<GLTF> {
    let entry = this.cache.get(file);
    if (!entry) {
      entry = this.loader.loadAsync(this.baseUrl + file).then((gltf) => {
        fixMissingNormals(gltf.scene);
        return gltf;
      });
      entry.catch(() => this.cache.delete(file));
      this.cache.set(file, entry);
    }
    return entry;
  }

  async dispose(): Promise<void> {
    const all = await Promise.allSettled(this.cache.values());
    for (const r of all) if (r.status === "fulfilled") disposeObject(r.value.scene);
    this.cache.clear();
  }
}

/**
 * Model không có pháp tuyến (vd. Quaternius Cute Monsters, vật liệu unlit): hậu kỳ AO (GTAO) đọc pháp tuyến
 * từ geometry → thiếu thì cả model bị coi là bị che hoàn toàn và đen kịt. Tính bổ sung pháp tuyến khi nạp.
 */
export function fixMissingNormals(root: THREE.Object3D): number {
  let fixed = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.geometry.getAttribute("normal")) return;
    o.geometry.computeVertexNormals();
    fixed++;
  });
  return fixed;
}

/**
 * Loại bỏ root motion: xóa thành phần X/Z của track position trên root bone (giữ Y).
 */
export function stripRootMotion(clip: THREE.AnimationClip, rootBoneName: string): THREE.AnimationClip {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (track.name !== `${rootBoneName}.position`) continue;
    const v = track.values;
    const x0 = v[0] ?? 0;
    const z0 = v[2] ?? 0;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
  return out;
}

export function findRootBone(object: THREE.Object3D): THREE.Bone | undefined {
  let found: THREE.Bone | undefined;
  object.traverse((o) => {
    if (!found && o instanceof THREE.Bone) found = o;
  });
  return found;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}
