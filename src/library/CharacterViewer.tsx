import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ALIAS_CANDIDATES } from "../assets/clipAliases";
import { resolveClip, type AssetEntry } from "../schemas/asset.schema";
import { addLights, frameCamera, prepareModel } from "./modelPreview";

/** Trình xem 3D: xoay/zoom, bấm thử từng động tác (preview – không dùng cho render). */
export function ModelViewer({ asset, clip }: { asset: AssetEntry; clip?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<(name: string | undefined) => void>(() => undefined);
  const [error, setError] = useState<string>();

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
    if (sun) sun.castShadow = true;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: "#b8d6a0" }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let mixer: THREE.AnimationMixer | undefined;
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
        mixer = m.mixer;
        clips = m.clips;
        const r = Math.max(m.size.x, m.size.z, m.size.y * 0.6);
        ground.scale.setScalar(r * 1.2);
        controls.target.copy(frameCamera(camera, m.size, asset.type !== "character"));
        playRef.current(clip ? resolveClip(asset, clip) : asset.defaultClip);
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
    const loop = () => {
      mixer?.update(clock.getDelta());
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
