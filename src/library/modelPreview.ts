import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AssetLoader } from "../engine/AssetLoader";
import { DEG } from "../engine/math";
import type { AssetEntry } from "../schemas/asset.schema";

/** Loader dùng chung cho mọi xem trước trong Thư viện (cache GLB). */
export const previewLoader = new AssetLoader();

export interface PreparedModel {
  root: THREE.Group;
  mixer?: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  size: THREE.Vector3;
}

/** Model đã chuẩn hóa như trong SceneEngine: chiều cao theo Registry, chân chạm y = 0, xoay headingOffset. */
export async function prepareModel(asset: AssetEntry): Promise<PreparedModel> {
  const gltf = await previewLoader.load(asset.file);
  const model = asset.type === "character" ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene, true);
  const raw = box.getSize(new THREE.Vector3());
  const s = asset.height && raw.y > 0 ? asset.height / raw.y : (asset.scale ?? 1);
  model.scale.setScalar(s);
  model.position.y = -box.min.y * s;
  model.rotation.y = asset.headingOffset * DEG;
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const root = new THREE.Group();
  root.add(model);
  const clips = new Map(gltf.animations.map((c) => [c.name, c]));
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : undefined;
  return { root, mixer, clips, size: raw.multiplyScalar(s) };
}

export function addLights(scene: THREE.Scene): void {
  // Ánh nền dưới trung tính ấm (xanh lá hắt lên làm da mặt dưới vành mũ ngả olive, lệch tông với tay chân)
  // + đèn phụ chính diện như engine (Lighting.ts) – mặt không bị tối hơn thân.
  const hemi = new THREE.HemisphereLight("#e6f2ff", "#b8a58c", 1.4);
  const sun = new THREE.DirectionalLight("#ffffff", 2.0);
  sun.position.set(3, 6, 4);
  const fill = new THREE.DirectionalLight("#fff6ec", 0.7);
  fill.position.set(-1, 2, 6);
  scene.add(hemi, sun, fill);
}

/** Đặt camera nhìn chéo 3/4 từ phía trước (model nhìn về +Z). */
export function frameCamera(camera: THREE.PerspectiveCamera, size: THREE.Vector3, wide = false): THREE.Vector3 {
  const h = Math.max(size.y, 0.2);
  const w = Math.max(size.x, size.z, 0.2);
  const span = Math.max(h, w * (wide ? 0.9 : 0.75));
  const dist = (span / 2 / Math.tan((camera.fov * DEG) / 2)) * 1.35;
  const target = new THREE.Vector3(0, h * 0.5, 0);
  const dir = new THREE.Vector3(wide ? 0.8 : 0.45, wide ? 0.55 : 0.25, 1).normalize();
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  return target;
}

// ------------------------------------------------------------ ảnh thu nhỏ

const SIZE = 320;
let renderer: THREE.WebGLRenderer | undefined;
const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

function snapshotRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
  }
  return renderer;
}

/** Quên GLB + ảnh thu nhỏ đã cache của một asset (vừa dựng lại cùng file). */
export function forgetModel(asset: Pick<AssetEntry, "id" | "file">): void {
  previewLoader.forget(asset.file);
  for (const k of cache.keys()) if (k.startsWith(`${asset.id}|${asset.file}|`)) cache.delete(k);
}

/** Ảnh PNG (data URL) của asset ở tư thế Idle. Chạy tuần tự trên 1 WebGL context dùng chung. */
export function assetThumbnail(asset: AssetEntry): Promise<string> {
  const key = `${asset.id}|${asset.file}|${asset.height ?? ""}|${asset.headingOffset}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = queue.then(async () => {
      const r = snapshotRenderer();
      const scene = new THREE.Scene();
      addLights(scene);
      const m = await prepareModel(asset);
      scene.add(m.root);
      const idle = asset.defaultClip ? m.clips.get(asset.defaultClip) : undefined;
      if (m.mixer && idle) {
        m.mixer.clipAction(idle).play();
        m.mixer.update(Math.min(0.5, idle.duration / 2));
      }
      const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
      frameCamera(camera, m.size, asset.type !== "character");
      r.render(scene, camera);
      const url = r.domElement.toDataURL("image/png");
      m.mixer?.stopAllAction();
      return url;
    });
    queue = hit.catch(() => undefined);
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}
