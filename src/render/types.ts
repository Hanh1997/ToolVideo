export interface RenderIssue {
  code: string;
  message: string;
  path?: string;
}

export type RenderLoadResult =
  | { ok: true; totalFrames: number; gpu: string }
  | { ok: false; issues: RenderIssue[] };

/** high = hậu kỳ bóng tiếp xúc (AO) + chỉnh màu; standard = không hậu kỳ (render CPU nhanh hơn nhiều). */
export type RenderQuality = "high" | "standard";

export interface RenderApi {
  load(scene: unknown, options?: { quality?: RenderQuality }): Promise<RenderLoadResult>;
  /** Render frame `index` (time = index / fps) → PNG base64 (không prefix data:). */
  renderFrame(index: number): string;
}

declare global {
  interface Window {
    __AC_RENDER__?: RenderApi;
    __AC_READY__?: boolean;
  }
}
