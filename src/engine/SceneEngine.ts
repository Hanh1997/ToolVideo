import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { findAsset, resolveClip, type AssetEntry, type Registry } from "../schemas/asset.schema";
import type { HoldPoint, SceneCharacter, SceneProp, SceneScript } from "../schemas/scene.schema";
import { applyAnimation, evaluateAnimation } from "./AnimationEngine";
import { AssetLoader, findRootBone, stripRootMotion } from "./AssetLoader";
import { evaluateCamera } from "./CameraEngine";
import { clamp, DEG, shortestAngleDelta } from "./math";
import { evaluateTransform, type CharacterTransform } from "./MovementEngine";
import { LightRig, PostFx } from "./Lighting";
import { ParticleSystems } from "./Particles";
import { evaluateProp } from "./PropEngine";
import { emotionPose, evaluatePerformance, type Performance } from "./Speech";

export class SceneLoadError extends Error {
  constructor(
    readonly code: "AssetNotFound" | "AnimationNotFound" | "AssetLoadFailed",
    message: string,
  ) {
    super(message);
    this.name = "SceneLoadError";
  }
}

interface CharacterRuntime {
  def: SceneCharacter;
  asset: AssetEntry;
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  durations: Record<string, number>;
  /** Điểm cầm đồ vật: vị trí cục bộ trong một xương/node → đi theo hoạt ảnh. */
  hold: Partial<Record<Exclude<HoldPoint, "auto">, HoldAnchor>>;
  /** Xương/node dùng cho "diễn" khi nói + tư thế gốc để khôi phục mỗi frame (tránh cộng dồn). */
  rig: { head?: THREE.Object3D; jaw?: THREE.Object3D; body?: THREE.Object3D; base: Map<THREE.Object3D, NodePose> };
  /** Lệch pha lắc đầu riêng cho từng nhân vật (tất định theo id). */
  phase: number;
}

interface NodePose {
  q: THREE.Quaternion;
  p: THREE.Vector3;
  s: THREE.Vector3;
}

interface HoldAnchor {
  anchor: THREE.Object3D;
  offset: THREE.Vector3;
  /** Ngậm bằng miệng: cuống nằm ngang, hoa chìa sang bên. */
  kind: "hand" | "mouth" | "body";
}

/** Nghiêng đồ vật khi ngậm (quanh trục trước–sau của nhân vật). */
const MOUTH_TILT = 80 * DEG;

interface PropRuntime {
  def: SceneProp;
  root: THREE.Group;
  /** Hệ số phóng to/thu nhỏ khi được cầm (asset.holdHeight). */
  holdScale: number;
}

export interface SceneEngineOptions {
  canvas?: HTMLCanvasElement;
  width: number;
  height: number;
  pixelRatio?: number;
  /** Bật khi cần đọc pixel (render video). */
  preserveDrawingBuffer?: boolean;
  loader?: AssetLoader;
  /** high (mặc định): hậu kỳ AO + chỉnh màu; standard: render thẳng (ánh sáng như nhau). */
  quality?: "high" | "standard";
}

const DEFAULT_BACKGROUND = "#a8d8f0";

/**
 * Scene Engine dùng chung cho Preview và Render.
 * seek(t) đặt toàn bộ trạng thái chỉ từ (SceneScript, t) → tất định.
 */
export class SceneEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** true: seek() không điều khiển camera (OrbitControls trong editor). */
  freeCamera = false;

  private readonly loader: AssetLoader;
  private readonly ownsLoader: boolean;
  private readonly content = new THREE.Group();
  private readonly lights: LightRig;
  private readonly particles = new ParticleSystems();
  /** Hậu kỳ (AO + chỉnh màu) – chỉ ở chất lượng high; standard render thẳng (nhanh trên CPU). */
  private readonly post: PostFx | undefined;
  private characters = new Map<string, CharacterRuntime>();
  private props: PropRuntime[] = [];
  private script: SceneScript | undefined;
  private loadToken = 0;
  private currentTime = 0;

  constructor(options: SceneEngineOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    this.renderer.setPixelRatio(options.pixelRatio ?? 1);
    this.renderer.setSize(options.width, options.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, options.width / options.height, 0.1, 500);
    this.camera.position.set(6, 4, 8);
    this.camera.lookAt(0, 1, 0);

    this.loader = options.loader ?? new AssetLoader();
    this.ownsLoader = !options.loader;

    this.lights = new LightRig(this.scene);
    if ((options.quality ?? "high") === "high") this.post = new PostFx(this.renderer, this.scene, this.camera, options.width, options.height);
    this.scene.add(this.content, this.particles.group);
    this.scene.background = new THREE.Color(DEFAULT_BACKGROUND);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get duration(): number {
    return this.script?.meta.duration ?? 0;
  }

  get time(): number {
    return this.currentTime;
  }

  /** Load Scene Script đã validate. Load lại sẽ xóa nội dung cũ. */
  async load(script: SceneScript, registry: Registry): Promise<void> {
    const token = ++this.loadToken;

    const envAsset = this.requireAsset(registry, script.environment.asset);
    const [envGltf, props, characters] = await Promise.all([
      this.loader.load(envAsset.file),
      Promise.all(script.props.map((p) => this.buildProp(p, registry))),
      Promise.all(script.characters.map((c) => this.buildCharacter(c, registry))),
    ]);

    if (token !== this.loadToken) return; // đã có lần load mới hơn

    this.clearContent();
    this.script = script;

    const env = envGltf.scene.clone(true);
    enableShadows(env);
    this.content.add(env);
    for (const p of props) this.content.add(p.root);
    this.props = props;
    for (const c of characters) {
      this.content.add(c.root);
      this.characters.set(c.def.id, c);
    }

    const bg = script.environment.background ?? DEFAULT_BACKGROUND;
    this.scene.background = new THREE.Color(bg);
    const fog = script.environment.fog;
    this.scene.fog = fog ? new THREE.Fog(fog.color ?? bg, fog.near, fog.far) : null;
    this.lights.configure(script, this.renderer);
    const cam0 = script.camera;
    const center = cam0.mode === "fixed" ? cam0.lookAt : (script.characters.find((c) => c.id === cam0.target)?.position ?? { x: 0, y: 0, z: 0 });
    const from = cam0.mode === "fixed" ? cam0.position : { x: center.x + cam0.offset.x, y: 0, z: center.z + cam0.offset.z };
    const len = Math.hypot(center.x - from.x, center.z - from.z) || 1;
    this.particles.configure(script.environment.effects, center, { x: (center.x - from.x) / len, z: (center.z - from.z) / len });
    this.post?.configure(script.environment.lighting.ao, this.lights.grade);

    this.seek(0);
  }

  seek(t: number): void {
    const script = this.script;
    if (!script) return;
    const time = Math.min(Math.max(t, 0), script.meta.duration);
    this.currentTime = time;

    const transforms = new Map<string, CharacterTransform>();
    for (const rt of this.characters.values()) {
      for (const [node, pose] of rt.rig.base) {
        node.quaternion.copy(pose.q);
        node.position.copy(pose.p);
        node.scale.copy(pose.s);
      }
      const tr = evaluateTransform(rt.def, script.actions, time);
      rt.root.position.set(tr.position.x, tr.position.y, tr.position.z);
      rt.root.rotation.set(0, tr.heading * DEG, 0);
      transforms.set(rt.def.id, tr);
      const states = evaluateAnimation(script.actions, rt.def.id, time, rt.asset.defaultClip, rt.durations);
      // Tên chuẩn ("walk") → clip thật của nhân vật ("Walking").
      applyAnimation(rt.mixer, rt.actions, states.map((s) => ({ ...s, clip: resolveClip(rt.asset, s.clip) ?? s.clip })));
    }

    // Diễn khi nói: người nói nhún/gật/mở miệng theo giọng, người nghe quay đầu về người nói.
    const perf = evaluatePerformance(script, time);
    for (const rt of this.characters.values()) {
      const p = perf.get(rt.def.id);
      if (p) applyPerformance(rt, p, transforms, time);
    }

    // Đồ vật: ẩn/hiện, nằm trên đất hoặc đi theo điểm cầm của nhân vật (sau khi đã áp hoạt ảnh).
    for (const p of this.props) {
      const st = evaluateProp(p.def, script.characters, script.actions, time);
      p.root.visible = st.visible;
      const holder = st.holder && this.characters.get(st.holder.character);
      if (holder && st.holder) {
        holder.root.updateMatrixWorld(true);
        const hp = holdAnchor(holder, st.holder.point);
        const world = hp.anchor.localToWorld(hp.offset.clone());
        this.content.worldToLocal(world);
        p.root.position.copy(world);
        p.root.rotation.set(0, (transforms.get(holder.def.id)!.heading + p.def.heading) * DEG, hp.kind === "mouth" ? MOUTH_TILT : 0, "YXZ");
        p.root.scale.setScalar(p.holdScale);
      } else {
        p.root.position.set(st.position.x, st.position.y, st.position.z);
        p.root.rotation.set(0, st.heading * DEG, 0, "YXZ");
        p.root.scale.setScalar(1);
      }
    }

    this.particles.update(time);

    const cam = evaluateCamera(script, time, transforms);
    if (!this.freeCamera) {
      this.camera.position.set(cam.position.x, cam.position.y, cam.position.z);
      this.camera.fov = cam.fov;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    }

    // Ánh sáng theo camera đang dùng (hàm của t → vẫn tất định; camera tự do trong editor: theo camera thật).
    const view = this.freeCamera
      ? { position: this.camera.position, lookAt: this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(6).add(this.camera.position) }
      : cam;
    this.lights.update(view);
  }

  render(): void {
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.post?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.loadToken++;
    this.clearContent();
    if (this.ownsLoader) void this.loader.dispose();
    this.particles.clear();
    this.post?.dispose();
    this.renderer.dispose();
  }

  private clearContent(): void {
    for (const rt of this.characters.values()) {
      rt.mixer.stopAllAction();
      rt.mixer.uncacheRoot(rt.root);
    }
    this.characters.clear();
    this.props = [];
    // Geometry/material dùng chung với cache của AssetLoader → giải phóng khi dispose loader.
    this.content.clear();
    this.script = undefined;
  }

  private requireAsset(registry: Registry, id: string): AssetEntry {
    const asset = findAsset(registry, id);
    if (!asset) throw new SceneLoadError("AssetNotFound", `Asset "${id}" không có trong Registry`);
    return asset;
  }

  private async loadGltf(asset: AssetEntry) {
    try {
      return await this.loader.load(asset.file);
    } catch (err) {
      throw new SceneLoadError("AssetLoadFailed", `Không tải được ${asset.file}: ${String(err)}`);
    }
  }

  /** Bọc model trong Group điều khiển; chuẩn hóa chiều cao và chân chạm y = 0. */
  private place(model: THREE.Object3D, source: THREE.Object3D, asset: AssetEntry, scale: number): THREE.Group {
    source.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(source, true);
    const size = box.getSize(new THREE.Vector3());
    const s = (asset.height && size.y > 0 ? asset.height / size.y : (asset.scale ?? 1)) * scale;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.rotation.y = asset.headingOffset * DEG;
    enableShadows(model);
    const root = new THREE.Group();
    root.name = asset.id;
    root.add(model);
    return root;
  }

  private async buildProp(def: SceneProp, registry: Registry): Promise<PropRuntime> {
    const asset = this.requireAsset(registry, def.asset);
    const gltf = await this.loadGltf(asset);
    const root = this.place(gltf.scene.clone(true), gltf.scene, asset, def.scale);
    root.name = def.id;
    root.position.set(def.position.x, def.position.y, def.position.z);
    root.rotation.y = def.heading * DEG;
    root.visible = def.visible;
    let holdScale = 1;
    if (asset.holdHeight) {
      const h = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3()).y;
      if (h > 0) holdScale = asset.holdHeight / h;
    }
    return { def, root, holdScale };
  }

  private async buildCharacter(def: SceneCharacter, registry: Registry): Promise<CharacterRuntime> {
    const asset = this.requireAsset(registry, def.asset);
    const gltf = await this.loadGltf(asset);
    const model = cloneSkinned(gltf.scene);
    const root = this.place(model, gltf.scene, asset, def.scale);
    root.name = def.id;

    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();
    const durations: Record<string, number> = {};
    const rootBone = asset.rootMotion === "strip" ? findRootBone(model) : undefined;

    for (const original of gltf.animations) {
      const clip = rootBone ? stripRootMotion(original, rootBone.name) : original;
      const action = mixer.clipAction(clip);
      action.play();
      action.weight = 0;
      actions.set(clip.name, action);
      durations[clip.name] = clip.duration;
    }

    for (const name of asset.clips) {
      if (!actions.has(name)) {
        throw new SceneLoadError("AnimationNotFound", `Registry khai báo clip "${name}" nhưng ${asset.file} không có`);
      }
    }
    // Độ dài cho tên chuẩn để evaluateAnimation tính loop đúng.
    for (const alias of Object.keys(asset.clipAliases)) {
      const real = resolveClip(asset, alias);
      if (real && durations[real] !== undefined) durations[alias] = durations[real];
    }

    const head = findNode(model, [norm("Head")]);
    const jaw = findNode(model, [norm("Jaw"), norm("Mouth")]);
    const body = head ? undefined : findNode(model, ["body"]);
    const base = new Map<THREE.Object3D, NodePose>();
    for (const n of [head, jaw, body]) if (n) base.set(n, { q: n.quaternion.clone(), p: n.position.clone(), s: n.scale.clone() });
    const phase = [...def.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) / 997;
    return { def, asset, root, mixer, actions, durations, hold: findHoldPoints(root, model, asset), rig: { head, jaw, body, base }, phase };
  }
}

// ---------------------------------------------------------------- diễn khi nói

const UP = new THREE.Vector3(0, 1, 0);

/** Xoay node thêm (yaw quanh trục đứng, pitch quanh trục ngang của nhân vật) trong hệ toạ độ thế giới. */
function rotateWorld(node: THREE.Object3D, yawDeg: number, pitchDeg: number, headingDeg: number): void {
  if (!node.parent || (Math.abs(yawDeg) < 1e-3 && Math.abs(pitchDeg) < 1e-3)) return;
  const h = headingDeg * DEG;
  const right = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
  const delta = new THREE.Quaternion().setFromAxisAngle(UP, yawDeg * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(right, pitchDeg * DEG));
  const world = node.getWorldQuaternion(new THREE.Quaternion());
  const parent = node.parent.getWorldQuaternion(new THREE.Quaternion());
  node.quaternion.copy(parent.invert().multiply(delta.multiply(world)));
  node.updateMatrixWorld(true);
}

function applyPerformance(rt: CharacterRuntime, p: Performance, transforms: ReadonlyMap<string, CharacterTransform>, t: number): void {
  const tr = transforms.get(rt.def.id);
  if (!tr) return;
  let yaw = 0;
  if (p.lookAt) {
    const other = transforms.get(p.lookAt.character);
    if (other) {
      const want = Math.atan2(other.position.x - tr.position.x, other.position.z - tr.position.z) / DEG;
      const limit = rt.rig.head ? 55 : 25;
      yaw = clamp(shortestAngleDelta(tr.heading, want), -limit, limit) * p.lookAt.weight;
    }
  }
  const talk = p.talk;
  // Lắc đầu nhẹ khi nói (biên độ theo độ to), gật theo nhịp.
  const sway = talk > 0 ? Math.sin((t + rt.phase * 3) * 2.3) * 4 * Math.min(1, talk * 3) : 0;
  const pose = p.emotion ? emotionPose(p.emotion.kind, p.emotion.since) : undefined;
  const w = p.emotion?.weight ?? 0;
  if (pose && w > 0) {
    // Ngả người + nhún: xoay/đẩy cả nhân vật quanh chân (không đổi vị trí đứng).
    const h = tr.heading * DEG;
    rt.root.rotateOnWorldAxis(new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), -pose.lean * w * DEG);
    rt.root.position.y += pose.bob * w * (rt.asset.height ?? 1);
  }

  if (!rt.rig.head) {
    // Model không xương (Kenney): xoay cả người về người nói, thân nhún co giãn theo giọng.
    rt.root.rotateOnWorldAxis(UP, (yaw + sway * 0.5 + (pose?.shake ?? 0) * w) * DEG);
    const squash = 0.07 * talk + (pose?.squash ?? 0) * w;
    if (rt.rig.body && squash !== 0) {
      rt.rig.body.scale.y *= 1 + squash;
      rt.rig.body.scale.x *= 1 - squash * 0.45;
      rt.rig.body.scale.z *= 1 - squash * 0.45;
    }
    if (rt.rig.body && pose && w > 0) rt.rig.body.rotateX((pose.pitch * w * DEG) / 2);
    rt.root.updateMatrixWorld(true);
    return;
  }
  rt.root.updateMatrixWorld(true);
  rotateWorld(rt.rig.head, yaw + sway + (pose?.shake ?? 0) * w, talk * 7 + (pose?.pitch ?? 0) * w, tr.heading + yaw);
  if (rt.rig.jaw && rt.rig.jaw !== rt.rig.head && talk > 0) rotateWorld(rt.rig.jaw, 0, talk * 18, tr.heading + yaw);
}

// ---------------------------------------------------------------- điểm cầm

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Tên xương/node theo thứ tự ưu tiên (so khớp bỏ dấu chấm: three.js đổi "Fist.R" → "FistR"). */
const HAND_NODES = ["Fist.R", "Palm.R", "Palm1.R", "Hand.R", "RightHand", "mixamorigRightHand", "MiddleHand.R", "Wrist.R", "LowerArm.R"].map(norm);

function findNode(model: THREE.Object3D, names: readonly string[]): THREE.Object3D | undefined {
  const all: THREE.Object3D[] = [];
  model.traverse((o) => all.push(o));
  for (const n of names) {
    const hit = all.find((o) => norm(o.name) === n);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Dò điểm cầm ở tư thế gốc (root tại gốc toạ độ, nhìn +Z): tay = xương bàn tay phải; miệng = trước đầu
 * (xương Head/Mouth), với model không xương (Kenney) = mép trước, phía trên của node thân.
 */
function findHoldPoints(root: THREE.Group, model: THREE.Object3D, asset: AssetEntry): CharacterRuntime["hold"] {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const h = Math.max(0.2, box.max.y - box.min.y);
  const out: CharacterRuntime["hold"] = {};
  const anchorAt = (anchor: THREE.Object3D, world: THREE.Vector3, kind: HoldAnchor["kind"]): HoldAnchor => ({ anchor, offset: anchor.worldToLocal(world.clone()), kind });
  const nodePos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

  for (const kind of ["hand", "mouth"] as const) {
    const o = asset.holdPoints?.[kind];
    const node = o && findNode(model, [norm(o.node)]);
    if (o && node) out[kind] = anchorAt(node, nodePos(node).add(new THREE.Vector3(...o.offset)), kind);
  }

  if (!out.hand) {
    const hand = findNode(model, HAND_NODES);
    if (hand) out.hand = anchorAt(hand, nodePos(hand).add(new THREE.Vector3(0, 0, 0.03 * h)), "hand");
  }
  if (!out.mouth) {
    const mouth = findNode(model, [norm("Mouth"), norm("Jaw")]);
    const head = findNode(model, [norm("Head")]);
    if (mouth) {
      out.mouth = anchorAt(mouth, nodePos(mouth).add(new THREE.Vector3(0, 0, 0.04 * h)), "mouth");
    } else if (head) {
      // Mõm: phía trước đầu, tới gần mép trước của model (thú bốn chân: đầu ở phía trước).
      const hp = nodePos(head);
      const quadruped = box.max.z - box.min.z > 1.2 * (box.max.x - box.min.x);
      out.mouth = quadruped
        ? anchorAt(head, new THREE.Vector3(hp.x, hp.y - 0.14 * h, box.max.z - 0.04 * h), "mouth")
        : anchorAt(head, new THREE.Vector3(hp.x, hp.y - 0.06 * h, hp.z + 0.12 * h), "mouth");
    } else {
      // Không có xương (Kenney): mép trước của khối đầu–thân.
      const body = findNode(model, ["body", "head"]) ?? model;
      out.mouth = anchorAt(body, new THREE.Vector3(0, box.min.y + 0.55 * h, box.max.z - 0.02 * h), "mouth");
    }
  }
  return out;
}

function holdAnchor(rt: CharacterRuntime, point: HoldPoint): HoldAnchor {
  const pick = point === "mouth" ? (rt.hold.mouth ?? rt.hold.hand) : (rt.hold.hand ?? rt.hold.mouth);
  return pick ?? { anchor: rt.root, offset: new THREE.Vector3(0, 0.5 * (rt.asset.height ?? 1), 0.3), kind: "body" };
}

function enableShadows(object: THREE.Object3D): void {
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}
