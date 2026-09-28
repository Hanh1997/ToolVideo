/** Bộ tổng hợp âm thanh tối giản dùng chung cho scripts/generate-*-audio.ts (tất định theo seed). */

export const RATE = 44100;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);

export class Buffer32 {
  readonly data: Float32Array;
  constructor(
    readonly seconds: number,
    /** true: mẫu vượt cuối buffer được cuộn về đầu → vòng lặp liền mạch. */
    private readonly wrap = false,
  ) {
    this.data = new Float32Array(Math.round(seconds * RATE));
  }
  add(i: number, v: number): void {
    const n = this.data.length;
    if (this.wrap) this.data[((i % n) + n) % n]! += v;
    else if (i >= 0 && i < n) this.data[i]! += v;
  }
  normalize(peak = 0.8): this {
    let max = 0;
    for (const v of this.data) max = Math.max(max, Math.abs(v));
    if (max > 0) for (let i = 0; i < this.data.length; i++) this.data[i]! *= peak / max;
    return this;
  }
}

/** Nốt có envelope attack/decay; `wave` nhận pha (radian). */
export function note(
  buf: Buffer32,
  start: number,
  length: number,
  freq: number,
  amp: number,
  wave: (phase: number) => number,
  decay = 4,
  attack = 0.005,
): void {
  const s0 = Math.round(start * RATE);
  const n = Math.round((length + 0.25) * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / attack) * Math.exp(-decay * t) * (t > length ? Math.exp(-(t - length) * 30) : 1);
    buf.add(s0 + i, amp * env * wave(2 * Math.PI * freq * t));
  }
}

export const sine = (p: number) => Math.sin(p);
export const soft = (p: number) => Math.sin(p) + 0.25 * Math.sin(3 * p) + 0.1 * Math.sin(5 * p);
export const tri = (p: number) => (2 / Math.PI) * Math.asin(Math.sin(p));

export function noiseHit(buf: Buffer32, start: number, length: number, amp: number, decay: number, highpass: boolean, rand: () => number): void {
  const s0 = Math.round(start * RATE);
  const n = Math.round(length * RATE);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const x = rand() * 2 - 1;
    const v = highpass ? x - prev : x * 0.6 + prev * 0.4;
    prev = x;
    buf.add(s0 + i, amp * Math.exp(-decay * t) * v);
  }
}

export function kick(buf: Buffer32, start: number, amp: number): void {
  const s0 = Math.round(start * RATE);
  let phase = 0;
  for (let i = 0; i < 0.3 * RATE; i++) {
    const t = i / RATE;
    phase += (2 * Math.PI * (45 + 90 * Math.exp(-t * 25))) / RATE;
    buf.add(s0 + i, amp * Math.exp(-t * 12) * Math.sin(phase));
  }
}

export function wav(buf: Buffer32): Buffer {
  const n = buf.data.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf.data[i]!)) * 32767), 44 + i * 2);
  return out;
}

