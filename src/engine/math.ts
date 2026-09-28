export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

export function smoothstep(p: number): number {
  const x = clamp(p, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Hiệu góc ngắn nhất (độ) từ a tới b, trong (-180, 180]. */
export function shortestAngleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** heading (độ) → vector đơn vị trên mặt phẳng XZ. heading 0 = +Z, +90 = +X. */
export function headingToVector(heading: number): { x: number; z: number } {
  return { x: Math.sin(heading * DEG), z: Math.cos(heading * DEG) };
}

/** Vector XZ → heading (độ). */
export function vectorToHeading(x: number, z: number): number {
  return Math.atan2(x, z) / DEG;
}
