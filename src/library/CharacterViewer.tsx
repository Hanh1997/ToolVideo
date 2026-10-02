import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ALIAS_CANDIDATES } from "../assets/clipAliases";
import { CorrectiveMorphs } from "../engine/CorrectiveMorphs";
import { FaceMorphs, visemeSequence } from "../engine/FaceMorphs";
import { resolveClip, type AssetEntry } from "../schemas/asset.schema";
import { addLights, frameCamera, prepareModel } from "./modelPreview";

/** Xem thử khuôn mặt: một shape key đang bật (null = mặt thường) + nói thử (nhép miệng theo câu mẫu). */
export interface FacePreview {
  key: string | null;
  talk: boolean;
  /** Tăng lên để đưa camera cận mặt. */
  closeUp: number;
}

const SAMPLE = "Xin chào, mình là bạn nhỏ vui vẻ. Hôm nay trời đẹp quá!";

/**
 * Trình xem 3D: xoay/zoom, bấm thử từng động tác (preview – không dùng cho render). Nhân vật có khuôn mặt morph
 * (blink + khẩu hình): tự chớp mắt như trong video, bật thử từng shape key, nói thử.
 */
export function ModelViewer({ asset, clip, face, onFaceNames }: { asset: AssetEntry; clip?: string; face?: FacePreview; onFaceNames?: (names: string[]) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<(name: string | undefined) => void>(() => undefined);
  const faceRef = useRef<FacePreview | undefined>(face);
  const closeUpRef = useRef<() => void>(() => undefined);
  const [error, setError] = useState<string>();
  faceRef.current = face;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dfeaf3");
    addLights(scene);
    const sun = scene.children.find((o): o is THREE.DirectionalLight => o instanceof THREE.DirectionalLight);
    if (sun) {
      sun.castShadow = true;
      // như Lighting.ts – không thì mặt cong mịn (nhân vật tự dựng) bị vân sọc tự đổ bóng
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
    }
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: "#b8d6a0" }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let mixer: THREE.AnimationMixer | undefined;
    let morphs: FaceMorphs | undefined;
    let correctives: CorrectiveMorphs | undefined;
    let modelRoot: THREE.Object3D | undefined;
    let names: string[] = [];
    let headBone: THREE.Object3D | undefined;
    const weights = new Map<string, number>();
    const syllables = visemeSequence(SAMPLE);
    let clips = new Map<string, THREE.AnimationClip>();
    let current: THREE.AnimationAction | undefined;
    let disposed = false;

    playRef.current = (name) => {
      if (!mixer) return;
      const next = name ? clips.get(name) : undefined;
      if (!next) return;
      const action = mixer.clipAction(next);
      action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
      if (current && current !== action) current.crossFadeTo(action, 0.25, false);
      current = action;
    };

    prepareModel(asset).then(
      (m) => {
        if (disposed) return;
        scene.add(m.root);
        correctives = CorrectiveMorphs.find(m.root); // tư thế gốc – trước khi chạy hoạt ảnh
        modelRoot = m.root;
        mixer = m.mixer;
        clips = m.clips;
        const r = Math.max(m.size.x, m.size.z, m.size.y * 0.6);
        ground.scale.setScalar(r * 1.2);
        controls.target.copy(frameCamera(camera, m.size, asset.type !== "character"));
        playRef.current(clip ? resolveClip(asset, clip) : asset.defaultClip);
        morphs = FaceMorphs.find(m.root);
        names = morphs?.names() ?? [];
        m.root.traverse((o) => {
          if (!headBone && (o as THREE.Bone).isBone && o.name.toLowerCase() === "head") headBone = o;
        });
        onFaceNames?.(names);
        closeUpRef.current = () => {
          if (!headBone) return;
          m.root.updateMatrixWorld(true);
          const h = headBone.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.12 * m.size.y, 0));
          const dist = 0.9 * m.size.y;
          camera.position.copy(h).add(new THREE.Vector3(0.25 * dist, 0.05 * dist, dist));
          controls.target.copy(h);
          controls.update();
        };
      },
      (e: unknown) => setError(String(e)),
    );

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const clock = new THREE.Clock();
    let raf = 0;
    let t = 0;
    const loop = () => {
      const dt = clock.getDelta();
      t += dt;
      mixer?.update(dt);
      if (correctives && modelRoot) {
        modelRoot.updateMatrixWorld(true);
        correctives.update();
      }
      if (morphs) {
        // Chớp mắt ~3.5 s một lần (0.16 s), như engine khi render; shape key đang chọn chuyển mượt.
        const f = faceRef.current;
        const ph = t % 3.5;
        const blink = ph < 0.16 ? Math.sin((ph / 0.16) * Math.PI) : 0;
        // Nói thử: mỗi âm tiết ~0.17 s, miệng mở / khép theo nhịp; nghỉ 1 s cuối câu.
        const talkLen = syllables.length * 0.17;
        const tt = t % (talkLen + 1);
        const syl = f?.talk && tt < talkLen ? syllables[Math.floor(tt / 0.17)] : undefined;
        const open = syl ? Math.sin(((tt % 0.17) / 0.17) * Math.PI) * 0.9 : 0;
        for (const n of names) {
          const want = n === "blink" ? Math.max(blink, f?.key === "blink" ? 1 : 0) : n === syl ? open : f?.key === n ? 1 : 0;
          const cur = weights.get(n) ?? 0;
          const next = n === "blink" || n === syl ? want : cur + (want - cur) * Math.min(1, dt * 12);
          weights.set(n, next);
          morphs.set(n, next);
        }
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      mixer?.stopAllAction();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // clip đổi → chỉ đổi động tác (effect dưới), không dựng lại cảnh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  useEffect(() => {
    playRef.current(clip ? resolveClip(asset, clip) : asset.defaultClip);
  }, [clip, asset]);

  useEffect(() => {
    if (face?.closeUp) closeUpRef.current();
  }, [face?.closeUp]);

  return (
    <div className="model-viewer" ref={hostRef}>
      {error && <div className="lib-error overlay">{error}</div>}
    </div>
  );
}

/** Tên chuẩn có khớp đúng (exact) hay chỉ là dự phòng. */
export function aliasKind(std: string, real: string): "exact" | "fallback" {
  const cand = (ALIAS_CANDIDATES as Record<string, { exact: string[] } | undefined>)[std];
  return cand?.exact.includes(real) ? "exact" : "fallback";
}
