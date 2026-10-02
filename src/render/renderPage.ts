import { loadRegistry } from "../engine/AssetLoader";
import { SceneEngine } from "../engine/SceneEngine";
import { drawSubtitle, drawTitles, hasOverlay, loadSubtitleFont } from "../engine/Subtitles";
import { frameTime, totalFrames } from "../engine/time";
import type { Registry } from "../schemas/asset.schema";
import type { SceneScript } from "../schemas/scene.schema";
import { validateScene } from "../validation/validateScene";
import type { RenderApi, RenderLoadResult, RenderQuality } from "./types";

/**
 * Trang render chạy trong Chromium headless. Dùng đúng SceneEngine của preview.
 * CLI điều khiển qua window.__AC_RENDER__.
 */
let registry: Registry | undefined;
let engine: SceneEngine | undefined;
let fps = 30;
let current: SceneScript | undefined;
/** Canvas 2D ghép frame WebGL + phụ đề (khi burnIn). */
let composite: CanvasRenderingContext2D | undefined;

const api: RenderApi = {
  async load(input: unknown, options: { quality?: RenderQuality } = {}): Promise<RenderLoadResult> {
    try {
      registry ??= await loadRegistry();
      const result = validateScene(input, registry);
      if (!result.ok) return { ok: false, issues: result.issues };

      const { meta } = result.scene;
      engine?.dispose();
      engine?.canvas.remove();
      engine = new SceneEngine({ width: meta.width, height: meta.height, pixelRatio: 1, preserveDrawingBuffer: true, quality: options.quality });
      document.body.appendChild(engine.canvas);
      await engine.load(result.scene, registry);
      fps = meta.fps;
      current = result.scene;
      composite = undefined;
      if (hasOverlay(current)) {
        await loadSubtitleFont();
        const c = document.createElement("canvas");
        c.width = meta.width;
        c.height = meta.height;
        composite = c.getContext("2d") ?? undefined;
      }

      const gl = engine.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      return { ok: true, totalFrames: totalFrames(meta.duration, meta.fps), gpu };
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "SceneLoadFailed";
      return { ok: false, issues: [{ code, message: err instanceof Error ? err.message : String(err) }] };
    }
  },

  renderFrame(index: number): string {
    if (!engine) throw new Error("Chưa load scene");
    const t = frameTime(index, fps);
    engine.seek(t);
    engine.render();
    let url: string;
    if (composite && current) {
      const { width, height } = composite.canvas;
      composite.clearRect(0, 0, width, height);
      composite.drawImage(engine.canvas, 0, 0, width, height);
      if (current.subtitles.burnIn) drawSubtitle(composite, current, t, width, height);
      drawTitles(composite, current, t, width, height);
      url = composite.canvas.toDataURL("image/png");
    } else {
      url = engine.canvas.toDataURL("image/png");
    }
    return url.slice(url.indexOf(",") + 1);
  },
};

window.__AC_RENDER__ = api;
window.__AC_READY__ = true;
