import type { AnimationAction as ThreeAnimationAction, AnimationMixer } from "three";
import type { Action, AnimationAction } from "../schemas/scene.schema";
import { smoothstep } from "./math";

export interface ClipState {
  clip: string;
  time: number;
  weight: number;
}

const EPS = 1e-6;

function clipTime(clip: string, local: number, loop: boolean, durations: Readonly<Record<string, number>>): number {
  const d = durations[clip] ?? 1;
  if (d <= 0) return 0;
  if (loop) return ((local % d) + d) % d;
  return Math.max(0, Math.min(local, d - 1e-4));
}

function stateOf(a: AnimationAction, t: number, durations: Readonly<Record<string, number>>): ClipState {
  return { clip: a.clip, time: clipTime(a.clip, (t - a.start) * a.speed, a.loop, durations), weight: 1 };
}

function mix(from: ClipState, to: ClipState, w: number): ClipState[] {
  if (from.clip === to.clip) return [to];
  return [
    { ...from, weight: 1 - w },
    { ...to, weight: w },
  ];
}

/**
 * Trạng thái các clip tại thời điểm t (hàm thuần, không dùng mixer.update(delta)).
 * Crossfade được tính trực tiếp từ timeline.
 */
export function evaluateAnimation(
  actions: readonly Action[],
  targetId: string,
  t: number,
  defaultClip: string | undefined,
  durations: Readonly<Record<string, number>>,
): ClipState[] {
  const anims = actions
    .filter((a): a is AnimationAction => a.type === "animation" && a.target === targetId)
    .sort((a, b) => a.start - b.start);

  const idle = (): ClipState | undefined =>
    defaultClip ? { clip: defaultClip, time: clipTime(defaultClip, t, true, durations), weight: 1 } : undefined;

  const activeIndex = anims.findIndex((a) => t >= a.start - EPS && t < a.start + a.duration);

  if (activeIndex < 0) {
    // Khoảng trống: về defaultClip, crossfade từ action vừa kết thúc.
    const base = idle();
    let prev: AnimationAction | undefined;
    for (const a of anims) if (a.start + a.duration <= t + EPS) prev = a;
    if (!base) return prev ? [stateOf(prev, t, durations)] : [];
    if (prev && prev.fade > 0) {
      const since = t - (prev.start + prev.duration);
      if (since < prev.fade) return mix(stateOf(prev, t, durations), base, smoothstep(since / prev.fade));
    }
    return [base];
  }

  const active = anims[activeIndex]!;
  const current = stateOf(active, t, durations);
  const since = t - active.start;
  if (active.fade <= 0 || since >= active.fade || active.start < EPS) return [current];

  const w = smoothstep(since / active.fade);
  const prev = activeIndex > 0 ? anims[activeIndex - 1] : undefined;
  if (prev && active.start - (prev.start + prev.duration) <= active.fade + EPS) {
    return mix(stateOf(prev, t, durations), current, w);
  }
  const base = idle();
  return base ? mix(base, current, w) : [current];
}

/**
 * Áp trạng thái clip vào AnimationMixer. Mọi action đã play() sẵn;
 * chỉ đặt time + weight rồi update(0) → tất định.
 */
export function applyAnimation(
  mixer: AnimationMixer,
  actions: ReadonlyMap<string, ThreeAnimationAction>,
  states: readonly ClipState[],
): void {
  const merged = new Map<string, ClipState>();
  for (const s of states) {
    const existing = merged.get(s.clip);
    merged.set(s.clip, existing ? { ...s, weight: existing.weight + s.weight } : s);
  }
  for (const [name, action] of actions) {
    const s = merged.get(name);
    action.enabled = true;
    action.weight = s ? s.weight : 0;
    if (s) action.time = s.time;
  }
  mixer.update(0);
}
