import * as THREE from "three";
import type { DialogueLine, Emotion } from "../schemas/scene.schema";
import { clamp } from "./math";

/**
 * Khuôn mặt bằng morph target (shape key) – nhân vật tự dựng (scripts/blender/make_character.py) hoặc model có
 * cùng tên morph:
 *   blink                                   – nhắm mắt (chớp)
 *   happy, sad, angry, surprised, scared    – cảm xúc (theo cảm xúc câu thoại, người nghe "lây" nhẹ)
 *   aa, ih, ou, ee, oh                      – khẩu hình theo nguyên âm của lời thoại, đậm theo độ to giọng
 */

export const EXPRESSIONS = ["happy", "sad", "angry", "surprised", "scared"] as const;
export const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
export type Viseme = (typeof VISEMES)[number];

/** Shape key chỉnh hình theo tư thế (không phải khuôn mặt). */
const CORRECTIVE = /^shoulderUp[LR]$/;

interface Slot {
  influences: number[];
  index: number;
}

export class FaceMorphs {
  private readonly slots = new Map<string, Slot[]>();

  private constructor(meshes: THREE.Mesh[]) {
    for (const m of meshes) {
      const dict = m.morphTargetDictionary;
      if (!dict || !m.morphTargetInfluences) continue;
      for (const [name, index] of Object.entries(dict)) {
        if (CORRECTIVE.test(name)) continue; // key chỉnh vai – CorrectiveMorphs điều khiển
        const list = this.slots.get(name) ?? [];
        list.push({ influences: m.morphTargetInfluences, index });
        this.slots.set(name, list);
      }
    }
  }

  /** Model có khuôn mặt morph (ít nhất chớp mắt + một khẩu hình) → điều khiển được; không thì undefined. */
  static find(model: THREE.Object3D): FaceMorphs | undefined {
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary) meshes.push(m);
    });
    const f = new FaceMorphs(meshes);
    return f.has("blink") && VISEMES.some((v) => f.has(v)) ? f : undefined;
  }

  has(name: string): boolean {
    return this.slots.has(name);
  }

  /** Tên mọi shape key của khuôn mặt (xem thử trong Thư viện). */
  names(): string[] {
    return [...this.slots.keys()];
  }

  set(name: string, value: number): void {
    for (const s of this.slots.get(name) ?? []) s.influences[s.index] = clamp(value, 0, 1);
  }

  /** Đặt toàn bộ khuôn mặt tại một thời điểm. */
  apply(state: { blink: number; emotion?: { kind: Exclude<Emotion, "neutral">; weight: number }; visemes: Partial<Record<Viseme, number>> }): void {
    const emo = state.emotion;
    for (const e of EXPRESSIONS) this.set(e, emo && emo.kind === e ? emo.weight * 0.9 : 0);
    // Mắt đang cười / nheo thì chớp nhẹ hơn (không ép quá mức).
    const squint = emo && (emo.kind === "happy" || emo.kind === "angry") ? emo.weight : 0;
    this.set("blink", state.blink * (1 - 0.5 * squint));
    // Cảm xúc đã mở / kéo miệng (cười, ngạc nhiên) → khẩu hình nhẹ bớt để không há quá cỡ khi cộng dồn.
    const damp = 1 - 0.35 * (emo?.weight ?? 0);
    for (const v of VISEMES) this.set(v, (state.visemes[v] ?? 0) * damp);
  }
}

/** Nguyên âm (đã bỏ dấu) → khẩu hình. */
const VOWEL: Record<string, Viseme> = { a: "aa", e: "ee", i: "ih", y: "ih", o: "oh", u: "ou" };

/** Dãy khẩu hình của câu: mỗi cụm nguyên âm liền nhau = một âm tiết. Không có chữ Latin (vd. chữ Hán) → xen kẽ aa / oh. */
export function visemeSequence(text: string): Viseme[] {
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
  const out: Viseme[] = [];
  let prevVowel = false;
  for (const ch of plain) {
    const v = VOWEL[ch];
    if (v && !prevVowel) out.push(v);
    prevVowel = !!v;
  }
  if (out.length) return out;
  const n = Math.max(2, [...text].filter((c) => /\p{L}/u.test(c)).length);
  return Array.from({ length: n }, (_, i) => (i % 3 === 2 ? "oh" : "aa"));
}

const seqCache = new WeakMap<DialogueLine, Viseme[]>();

/**
 * Khẩu hình tại t của câu đang nói: âm tiết chia đều theo thời lượng câu, chuyển mượt sang âm kế ở 35% cuối mỗi âm;
 * đậm theo `talk` (độ to giọng hiện tại, 0 = đang ngừng giữa câu → khép miệng).
 */
export function visemesAt(line: DialogueLine, t: number, talk: number): Partial<Record<Viseme, number>> {
  let seq = seqCache.get(line);
  if (!seq) {
    seq = visemeSequence(line.text);
    seqCache.set(line, seq);
  }
  const local = clamp((t - line.start) / line.duration, 0, 0.9999) * seq.length;
  const i = Math.floor(local);
  const frac = local - i;
  const w = clamp(talk * 1.4, 0, 1);
  const cur = seq[i]!;
  const next = seq[Math.min(i + 1, seq.length - 1)]!;
  const mix = frac > 0.65 ? (frac - 0.65) / 0.35 : 0;
  const out: Partial<Record<Viseme, number>> = {};
  out[cur] = (out[cur] ?? 0) + w * (1 - mix);
  out[next] = (out[next] ?? 0) + w * mix;
  return out;
}
