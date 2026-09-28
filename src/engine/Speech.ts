import type { DialogueLine, Emotion, SceneScript } from "../schemas/scene.schema";
import { clamp, smoothstep } from "./math";

/**
 * "Diễn" khi nói, tính tất định từ lời thoại tại thời điểm t:
 *   speechLevel – độ mở miệng / nhún theo độ to giọng (envelope từ file TTS, 25 mẫu/giây)
 *   attention   – người nghe nhìn về người đang nói (giữ hướng nhìn tới câu kế tiếp, chuyển mượt)
 */

/** Số mẫu envelope mỗi giây (dialogue[].lipsync). */
export const LIPSYNC_RATE = 25;

/**
 * Envelope độ to từ PCM (mono, -1..1): RMS theo cửa sổ 1/LIPSYNC_RATE giây, chuẩn hóa theo mức 95%,
 * bỏ tiếng ồn nền, làm tròn 2 chữ số (gọn khi lưu trong scene).
 */
export function envelopeFromPcm(samples: Float32Array, sampleRate: number): number[] {
  const win = Math.max(1, Math.round(sampleRate / LIPSYNC_RATE));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  if (ref <= 1e-5) return rms.map(() => 0);
  const floor = 0.12;
  return rms.map((v) => {
    const n = clamp(v / ref, 0, 1);
    return Math.round(clamp((n - floor) / (1 - floor), 0, 1) * 100) / 100;
  });
}

/** Nhịp giả (khi không có envelope, vd. TTS giả trong test): ~4.5 âm tiết/giây. */
function syntheticLevel(local: number, duration: number): number {
  const edge = Math.min(1, local / 0.08, (duration - local) / 0.08);
  const s = Math.sin(local * Math.PI * 4.5);
  return clamp(edge, 0, 1) * (0.25 + 0.75 * s * s);
}

/** Mức nói 0..1 của câu tại t (0 ngoài câu). */
export function speechLevel(line: DialogueLine, t: number): number {
  const local = t - line.start;
  if (local < 0 || local >= line.duration) return 0;
  const env = line.lipsync;
  if (!env || env.length === 0) return syntheticLevel(local, line.duration);
  const x = local * LIPSYNC_RATE;
  const i = Math.floor(x);
  const a = env[Math.min(i, env.length - 1)] ?? 0;
  const b = env[Math.min(i + 1, env.length - 1)] ?? 0;
  return a + (b - a) * (x - i);
}

export interface Performance {
  /** Mức nói hiện tại (0 = im lặng). */
  talk: number;
  /** Cảm xúc của câu đang nói + độ đậm (0..1, vào/ra mượt) và thời gian từ đầu câu. */
  emotion?: { kind: Exclude<Emotion, "neutral">; weight: number; since: number };
  /** Nhân vật đang được nhìn + độ đậm (0..1). */
  lookAt?: { character: string; weight: number };
}

const LOOK_IN = 0.35;
const EMOTE_IN = 0.3;
const EMOTE_OUT = 0.5;

/**
 * Tư thế theo cảm xúc (độ / tỷ lệ), cộng thêm trên hoạt ảnh: pitch > 0 = cúi đầu; lean > 0 = ngả ra sau;
 * squash = co giãn thân (model không xương); bob = nhún lên xuống; shake = lắc đầu (độ, tần số).
 */
export function emotionPose(kind: Exclude<Emotion, "neutral">, since: number): { pitch: number; lean: number; squash: number; bob: number; shake: number } {
  switch (kind) {
    case "happy":
      return { pitch: -6, lean: 0, squash: 0.04 * Math.abs(Math.sin(since * 7)), bob: 0.035 * Math.abs(Math.sin(since * 7)), shake: 0 };
    case "sad":
      return { pitch: 16, lean: -4, squash: -0.06, bob: 0, shake: 0 };
    case "surprised": {
      const jolt = Math.exp(-since * 4);
      return { pitch: -14 * (0.4 + 0.6 * jolt), lean: 9 * jolt, squash: 0.08 * jolt, bob: 0.05 * jolt * Math.max(0, Math.sin(since * 10)), shake: 0 };
    }
    case "angry":
      return { pitch: 7, lean: -3, squash: 0, bob: 0, shake: 7 * Math.exp(-since * 1.5) * Math.sin(since * 16) };
    case "scared":
      return { pitch: 9, lean: 4, squash: -0.05, bob: 0, shake: 2.5 * Math.sin(since * 32) };
  }
}

/** Sau khi câu kết thúc vẫn nhìn người vừa nói tối đa bấy lâu (nếu chưa có câu mới). */
const LOOK_HOLD = 1.6;

/** Trạng thái diễn của từng nhân vật tại t. */
export function evaluatePerformance(scene: SceneScript, t: number): Map<string, Performance> {
  const out = new Map<string, Performance>(scene.characters.map((c) => [c.id, { talk: 0 }]));
  const lines = scene.dialogue.filter((l) => l.speaker).sort((a, b) => a.start - b.start);
  let current: DialogueLine | undefined;
  for (const l of lines) if (l.start <= t) current = l;
  if (!current) return out;
  const speaker = current.speaker!;
  const me = out.get(speaker);
  if (me) me.talk = speechLevel(current, t);

  const since = t - current.start;
  const after = t - (current.start + current.duration);
  if (me && current.emotion !== "neutral") {
    const w = Math.min(smoothstep(since / EMOTE_IN), after <= 0 ? 1 : 1 - smoothstep(after / EMOTE_OUT));
    if (w > 0) me.emotion = { kind: current.emotion, weight: w, since };
  }
  const fadeIn = smoothstep(since / LOOK_IN);
  const fadeOut = after <= 0 ? 1 : 1 - smoothstep((after - LOOK_HOLD) / LOOK_IN);
  const weight = Math.min(fadeIn, fadeOut);
  if (weight <= 0) return out;
  for (const [id, p] of out) if (id !== speaker && scene.characters.some((c) => c.id === speaker)) p.lookAt = { character: speaker, weight };
  return out;
}
