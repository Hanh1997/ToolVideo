export function totalFrames(duration: number, fps: number): number {
  return Math.round(duration * fps);
}

export function frameTime(index: number, fps: number): number {
  return index / fps;
}

/** 3.25 → "00:03.250" */
export function formatTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}
