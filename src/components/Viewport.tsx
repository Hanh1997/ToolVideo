import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SceneEngine, SceneLoadError } from "../engine/SceneEngine";
import { drawSubtitle, loadSubtitleFont } from "../engine/Subtitles";
import { useEditor } from "../store/editorStore";

/** Khung nhìn 3D: giữ đúng tỷ lệ khung hình của scene (letterbox). */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SceneEngine | null>(null);
  const scene = useEditor((s) => s.scene);
  const registry = useEditor((s) => s.registry);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!container || !canvas || !overlay) return;
    const overlayCtx = overlay.getContext("2d");
    void loadSubtitleFont();

    const engine = new SceneEngine({ canvas, width: 640, height: 360, pixelRatio: Math.min(window.devicePixelRatio, 2) });
    engineRef.current = engine;
    const controls = new OrbitControls(engine.camera, canvas);
    controls.enableDamping = true;

    const fit = () => {
      const s = useEditor.getState().scene;
      const aspect = s ? s.meta.width / s.meta.height : 16 / 9;
      const { clientWidth: cw, clientHeight: ch } = container;
      let w = cw;
      let h = Math.round(cw / aspect);
      if (h > ch) {
        h = ch;
        w = Math.round(ch * aspect);
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      engine.resize(Math.max(w, 1), Math.max(h, 1));
      // Lớp phủ phụ đề: cùng kích thước hiển thị, độ phân giải theo devicePixelRatio.
      const dpr = Math.min(window.devicePixelRatio, 2);
      overlay.style.width = `${w}px`;
      overlay.style.height = `${h}px`;
      overlay.width = Math.max(1, Math.round(w * dpr));
      overlay.height = Math.max(1, Math.round(h * dpr));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsSince = last;
    let wasFree = false;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const state = useEditor.getState();
      state.advance(dt);

      const free = state.freeCamera && !state.playing;
      if (free && !wasFree) {
        // Chuyển sang camera tự do: đặt tâm xoay vào điểm camera đang nhìn.
        const dir = engine.camera.getWorldDirection(new THREE.Vector3());
        controls.target.copy(engine.camera.position).addScaledVector(dir, 6);
      }
      wasFree = free;
      engine.freeCamera = free;
      controls.enabled = free;

      engine.seek(useEditor.getState().time);
      if (free) controls.update();
      engine.render();

      if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
        const s = useEditor.getState().scene;
        // Chỉ vẽ khi burnIn → preview khớp đúng video.
        if (s?.subtitles.burnIn) drawSubtitle(overlayCtx, s, useEditor.getState().time, overlay.width, overlay.height);
      }

      frames++;
      if (now - fpsSince >= 500) {
        state.setPreviewFps(Math.round((frames * 1000) / (now - fpsSince)));
        frames = 0;
        fpsSince = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const unsub = useEditor.subscribe((s, prev) => {
      if (s.scene !== prev.scene) fit();
    });

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      observer.disconnect();
      controls.dispose();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !scene || !registry) return;
    engine.load(scene, registry).catch((err: unknown) => {
      useEditor.getState().reportLoadError({
        code: err instanceof SceneLoadError ? err.code : "SceneLoadFailed",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, [scene, registry]);

  return (
    <div className="viewport" ref={containerRef}>
      <div className="viewport-stack">
        <canvas ref={canvasRef} />
        <canvas ref={overlayRef} className="subtitle-overlay" />
      </div>
    </div>
  );
}
