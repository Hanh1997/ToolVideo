import type { DialogueLine, Emotion, SceneScript } from "../schemas/scene.schema";
import { clamp, smoothstep } from "./math";

/**
 * "Diễn" khi nói, tính tất định từ lời thoại tại thời điểm t:
 *   speechLevel – độ mở miệng / nhún theo độ to giọng (envelope từ file TTS, 25 mẫu/giây)
 *   attention   – người nghe nhìn về người đang nói (giữ hướng nhìn tới câu kế tiếp, chuyển mượt),
 *                 người nói quay ~3/4 về người mình nói với (vẫn thấy mặt trên camera)
 *   reaction    – người nghe gật đầu theo nhịp câu và "lây" cảm xúc của người nói (nhẹ hơn, trễ một nhịp)
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
  /** Gật đầu (độ, > 0 = cúi) – người nghe đáp lại người nói. */
  nod?: number;
}

const LOOK_IN = 0.35;
/** Người nói chỉ quay một phần về người nghe để camera vẫn thấy mặt. */
const SPEAKER_TURN = 0.6;
/** Người nghe phản ứng cảm xúc: trễ bấy lâu, đậm bằng bấy nhiêu so với người nói. */
const REACT_DELAY = 0.35;
const REACT_WEIGHT = 0.55;
/** Cảm xúc người nói → phản ứng của người nghe (giận → người nghe sợ nhẹ). */
const REACTION: Partial<Record<Exclude<Emotion, "neutral">, Exclude<Emotion, "neutral">>> = {
  happy: "happy",
  sad: "sad",
  surprised: "surprised",
  scared: "scared",
  angry: "scared",
};
/** Gật đầu: mỗi người nghe gật theo chu kỳ riêng (lệch pha theo id) trong lúc người kia nói. */
const NOD_PERIOD = 1.8;
const NOD_LEN = 0.5;
const NOD_DEG = 9;

/** Số 0..1 cố định theo id (lệch pha tất định giữa các nhân vật). */
export function idPhase(id: string): number {
  return [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) / 997;
}

/** Người mà câu thoại nói với: `to`, hoặc người đáp lời kế tiếp, hoặc người vừa nói trước, hoặc người đứng gần nhất. */
export function addresseeOf(scene: SceneScript, line: DialogueLine): string | undefined {
  const speaker = line.speaker;
  if (!speaker) return undefined;
  const present = new Set(scene.characters.map((c) => c.id));
  if (line.to && present.has(line.to) && line.to !== speaker) return line.to;
  const spoken = scene.dialogue.filter((l) => l.speaker && present.has(l.speaker)).sort((a, b) => a.start - b.start);
  const at = spoken.findIndex((l) => l.id === line.id);
  const next = spoken.slice(at + 1).find((l) => l.speaker !== speaker);
  if (next) return next.speaker;
  const prev = spoken.slice(0, Math.max(0, at)).reverse().find((l) => l.speaker !== speaker);
  if (prev) return prev.speaker;
  const me = scene.characters.find((c) => c.id === speaker)!;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of scene.characters) {
    if (c.id === speaker) continue;
    const d = Math.hypot(c.position.x - me.position.x, c.position.z - me.position.z);
    if (d < bestD) [best, bestD] = [c.id, d];
  }
  return best;
}

/** Nhịp gật đầu 0..1 của người nghe tại thời điểm `since` trong câu. */
function nodPulse(id: string, since: number): number {
  const local = since - 0.4 - idPhase(id) * NOD_PERIOD;
  if (local < 0) return 0;
  const k = local % NOD_PERIOD;
  return k < NOD_LEN ? Math.sin((k / NOD_LEN) * Math.PI) ** 2 : 0;
}
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
  if (weight <= 0 || !scene.characters.some((c) => c.id === speaker)) return out;
  const to = addresseeOf(scene, current);
  if (me && to) me.lookAt = { character: to, weight: weight * SPEAKER_TURN };

  // Người nghe: nhìn người nói, gật đầu trong lúc nghe (thưa dần khi câu hết), phản ứng cảm xúc.
  const reactKind = current.emotion !== "neutral" ? REACTION[current.emotion] : undefined;
  const rs = since - REACT_DELAY;
  const reactW = reactKind && rs > 0 ? Math.min(smoothstep(rs / EMOTE_IN), after <= 0 ? 1 : 1 - smoothstep((after - REACT_DELAY) / EMOTE_OUT)) * REACT_WEIGHT : 0;
  const listening = after <= 0 ? 1 : 1 - smoothstep(after / 0.4);
  for (const [id, p] of out) {
    if (id === speaker) continue;
    p.lookAt = { character: speaker, weight };
    // Người được nói với gật rõ hơn người đứng bên.
    const nod = nodPulse(id, since) * listening * NOD_DEG * (id === to ? 1 : 0.6);
    if (nod > 0.01) p.nod = nod;
    if (reactKind && reactW > 0) p.emotion = { kind: reactKind, weight: reactW, since: rs };
  }
  return out;
}
