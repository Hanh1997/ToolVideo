/**
 * Thư viện âm thanh tự tổng hợp (CC0): nhạc nền theo cảm xúc + âm thanh môi trường, lặp liền mạch
 * + hiệu ứng hoạt hình ngắn (còi trượt, lấp lánh, bụp, vút…).
 * Tất định: cùng seed → cùng file. Ghi vào public/assets/audio/gen/ và Registry.
 *
 *   npx tsx scripts/generate-audio-library.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AssetEntrySchema } from "../src/schemas/asset.schema";
import { readRegistry, writeRegistry } from "../server/assets/importAsset";
import { runFfmpeg } from "../cli/ffmpeg";
import { Buffer32, kick, midi, noiseHit, note, RATE, rng, sine, soft, tri, wav } from "./synth";

const OUT = resolve(import.meta.dirname, "../public/assets/audio/gen");

/** Chuông / celesta: họa âm không nguyên. */
function bell(buf: Buffer32, start: number, f: number, amp: number, len = 1.2): void {
  const partials: [number, number, number][] = [
    [1, 1, 3],
    [2, 0.4, 4.5],
    [2.76, 0.2, 6],
    [5.4, 0.08, 9],
  ];
  for (const [ratio, a, decay] of partials) note(buf, start, len, f * ratio, amp * a, sine, decay, 0.002);
}

/** Pad: vài dao động hơi lệch tần, attack/release chậm. */
function pad(buf: Buffer32, start: number, len: number, notes: number[], amp: number): void {
  const s0 = Math.round(start * RATE);
  const n = Math.round((len + 0.6) * RATE);
  for (const m of notes) {
    const f = midi(m);
    for (const detune of [-0.004, 0, 0.004]) {
      const ff = f * (1 + detune);
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const env = Math.min(1, t / 0.5) * (t > len ? Math.max(0, 1 - (t - len) / 0.6) : 1);
        buf.add(s0 + i, (amp / 3) * env * (Math.sin(2 * Math.PI * ff * t) + 0.3 * Math.sin(4 * Math.PI * ff * t)));
      }
    }
  }
}

/** Pizzicato / gỗ: nốt ngắn, tắt nhanh. */
const pluck = (buf: Buffer32, t: number, m: number, amp: number) => note(buf, t, 0.08, midi(m), amp, tri, 14);

type Bar = { chord: number[]; root: number; melody: number[] };

/** Nhạc nhẹ nhàng: 80 bpm, pad + arpeggio sine, không trống. */
function calm(): Buffer32 {
  const beat = 60 / 80;
  const bars: Bar[] = [
    { root: 41, chord: [65, 69, 72], melody: [77, 0, 76, 74, 72, 0, 0, 0] },
    { root: 38, chord: [62, 65, 69], melody: [74, 0, 72, 69, 72, 0, 0, 0] },
    { root: 46, chord: [58, 62, 65], melody: [70, 72, 74, 0, 77, 0, 76, 0] },
    { root: 48, chord: [60, 64, 67], melody: [76, 0, 74, 0, 72, 0, 0, 0] },
  ];
  const buf = new Buffer32(bars.length * 4 * beat, true);
  bars.forEach((bar, b) => {
    const t0 = b * 4 * beat;
    pad(buf, t0, 4 * beat - 0.1, bar.chord, 0.07);
    note(buf, t0, 4 * beat, midi(bar.root), 0.18, sine, 0.8);
    for (let e = 0; e < 8; e++) {
      const t = t0 + (e * beat) / 2;
      note(buf, t, 0.3, midi(bar.chord[[0, 1, 2, 1][e % 4]!]! + 12), 0.05, sine, 5);
      const m = bar.melody[e]!;
      if (m) note(buf, t, beat * 0.9, midi(m), 0.13, soft, 2);
    }
  });
  return buf.normalize(0.7);
}

/** Phiêu lưu: 112 bpm, Dm–C–Bb–C, bass hành khúc + trống. */
function adventure(): Buffer32 {
  const rand = rng(21);
  const beat = 60 / 112;
  const bars: Bar[] = [
    { root: 38, chord: [62, 65, 69], melody: [74, 74, 77, 74, 72, 74, 69, 0] },
    { root: 36, chord: [60, 64, 67], melody: [72, 72, 76, 72, 71, 72, 67, 0] },
    { root: 34, chord: [58, 62, 65], melody: [70, 74, 77, 79, 77, 74, 70, 0] },
    { root: 36, chord: [60, 64, 67], melody: [72, 76, 79, 81, 79, 76, 74, 0] },
  ];
  const buf = new Buffer32(bars.length * 4 * beat, true);
  bars.forEach((bar, b) => {
    const t0 = b * 4 * beat;
    pad(buf, t0, 4 * beat - 0.05, bar.chord, 0.05);
    for (let q = 0; q < 8; q++) note(buf, t0 + (q * beat) / 2, beat * 0.4, midi(bar.root + (q % 2 ? 12 : 0)), 0.22, tri, 5);
    for (let e = 0; e < 8; e++) {
      const m = bar.melody[e]!;
      if (m) note(buf, t0 + (e * beat) / 2, beat * 0.45, midi(m), 0.16, soft, 3);
    }
    for (let q = 0; q < 4; q++) kick(buf, t0 + q * beat, q % 2 ? 0.25 : 0.4);
    noiseHit(buf, t0 + beat, 0.18, 0.1, 20, false, rand);
    noiseHit(buf, t0 + 3 * beat, 0.18, 0.1, 20, false, rand);
    for (let s = 0; s < 8; s++) noiseHit(buf, t0 + (s * beat) / 2, 0.03, 0.03, 90, true, rand);
  });
  return buf.normalize(0.75);
}

/** Buồn: 68 bpm, Am–F–C–G, giai điệu sine chậm trên pad. */
function sad(): Buffer32 {
  const beat = 60 / 68;
  const bars: Bar[] = [
    { root: 45, chord: [57, 60, 64], melody: [76, 0, 74, 72, 71, 0, 69, 0] },
    { root: 41, chord: [53, 57, 60], melody: [72, 0, 71, 69, 67, 0, 65, 0] },
    { root: 48, chord: [55, 60, 64], melody: [67, 0, 69, 71, 72, 0, 0, 0] },
    { root: 43, chord: [55, 59, 62], melody: [71, 0, 69, 67, 66, 0, 67, 0] },
  ];
  const buf = new Buffer32(bars.length * 4 * beat, true);
  bars.forEach((bar, b) => {
    const t0 = b * 4 * beat;
    pad(buf, t0, 4 * beat - 0.1, bar.chord, 0.08);
    note(buf, t0, 4 * beat, midi(bar.root), 0.16, sine, 0.6);
    for (let e = 0; e < 8; e++) {
      const m = bar.melody[e]!;
      if (m) note(buf, t0 + (e * beat) / 2, beat, midi(m), 0.14, sine, 1.4, 0.04);
    }
  });
  return buf.normalize(0.65);
}

/** Kỳ diệu: 92 bpm, Cmaj7–Am7–Fmaj7–G6, arpeggio chuông. */
function magic(): Buffer32 {
  const beat = 60 / 92;
  const bars = [
    { root: 48, chord: [60, 64, 67, 71] },
    { root: 45, chord: [57, 60, 64, 67] },
    { root: 41, chord: [53, 57, 60, 64] },
    { root: 43, chord: [55, 59, 62, 64] },
  ];
  const buf = new Buffer32(bars.length * 4 * beat, true);
  bars.forEach((bar, b) => {
    const t0 = b * 4 * beat;
    pad(buf, t0, 4 * beat - 0.1, bar.chord.slice(0, 3), 0.06);
    note(buf, t0, 4 * beat, midi(bar.root), 0.14, sine, 0.7);
    const seq = [0, 1, 2, 3, 2, 3, 1, 2, 0, 2, 3, 1, 3, 2, 1, 3];
    seq.forEach((k, i) => bell(buf, t0 + (i * beat) / 4, midi(bar.chord[k]! + 24), i % 4 === 0 ? 0.09 : 0.055, 0.9));
  });
  return buf.normalize(0.7);
}

/** Tinh nghịch: 132 bpm, pizzicato nảy + gõ gỗ. */
function playful(): Buffer32 {
  const rand = rng(33);
  const beat = 60 / 132;
  const bars: Bar[] = [
    { root: 48, chord: [60, 64, 67], melody: [72, 76, 79, 76, 72, 0, 74, 76] },
    { root: 43, chord: [55, 59, 62], melody: [74, 71, 67, 71, 74, 0, 72, 71] },
    { root: 45, chord: [57, 60, 64], melody: [72, 69, 64, 69, 72, 0, 74, 76] },
    { root: 41, chord: [53, 57, 60], melody: [77, 76, 74, 72, 74, 0, 72, 0] },
  ];
  const buf = new Buffer32(bars.length * 4 * beat, true);
  bars.forEach((bar, b) => {
    const t0 = b * 4 * beat;
    for (let q = 0; q < 4; q++) {
      pluck(buf, t0 + q * beat, bar.root + (q % 2 ? 7 : 0), 0.3);
      for (const m of bar.chord) pluck(buf, t0 + q * beat + beat / 2, m, 0.07);
    }
    bar.melody.forEach((m, e) => m && pluck(buf, t0 + (e * beat) / 2, m + 12, 0.16));
    for (let e = 0; e < 8; e += 2) noiseHit(buf, t0 + (e * beat) / 2 + beat / 4, 0.03, 0.08, 120, true, rand);
  });
  return buf.normalize(0.75);
}

// ---------------------------------------------------------------- âm thanh môi trường

/** Tạp âm lọc thông thấp một cực, tần số cắt thay đổi theo thời gian. */
function filteredNoise(buf: Buffer32, amp: number, cutoff: (t: number) => number, gain: (t: number) => number, seed: number): void {
  const rand = rng(seed);
  let y = 0;
  for (let i = 0; i < buf.data.length; i++) {
    const t = i / RATE;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(t)) / RATE);
    y += a * (rand() * 2 - 1 - y);
    buf.add(i, amp * gain(t) * y);
  }
}

/** Làm liền mạch khi lặp: trộn đoạn cuối vào đoạn đầu (crossfade `fade` giây). */
function loopSeam(buf: Buffer32, fade: number): Buffer32 {
  const n = Math.round(fade * RATE);
  const len = buf.data.length - n;
  const out = new Buffer32(len / RATE, true);
  for (let i = 0; i < len; i++) out.data[i] = buf.data[i]!;
  for (let i = 0; i < n; i++) {
    const w = i / n;
    out.data[i] = out.data[i]! * w + buf.data[len + i]! * (1 - w);
  }
  return out;
}

function chirp(buf: Buffer32, start: number, f0: number, f1: number, len: number, amp: number): void {
  const s0 = Math.round(start * RATE);
  let phase = 0;
  const n = Math.round(len * RATE);
  for (let i = 0; i < n; i++) {
    const p = i / n;
    phase += (2 * Math.PI * (f0 + (f1 - f0) * p)) / RATE;
    buf.add(s0 + i, amp * Math.sin(Math.PI * p) ** 2 * Math.sin(phase));
  }
}

const LOOP = 16;

function birds(): Buffer32 {
  const rand = rng(41);
  const buf = new Buffer32(LOOP + 2);
  filteredNoise(buf, 0.05, () => 400, (t) => 0.7 + 0.3 * Math.sin(t * 0.7), 42);
  for (let t = 0.3; t < LOOP; t += 0.6 + rand() * 1.6) {
    const base = 2600 + rand() * 2200;
    const count = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < count; k++) chirp(buf, t + k * 0.09, base, base * (1.15 + rand() * 0.3), 0.07, 0.12 + rand() * 0.08);
  }
  return loopSeam(buf, 2).normalize(0.5);
}

function wind(): Buffer32 {
  const buf = new Buffer32(LOOP + 2);
  filteredNoise(buf, 1, (t) => 250 + 500 * (0.5 + 0.5 * Math.sin(t * 0.45)), (t) => 0.55 + 0.45 * Math.sin(t * 0.31 + 1), 51);
  return loopSeam(buf, 2).normalize(0.45);
}

function water(): Buffer32 {
  const rand = rng(61);
  const buf = new Buffer32(LOOP + 2);
  filteredNoise(buf, 1, (t) => 1400 + 500 * Math.sin(t * 1.3), () => 0.6, 62);
  for (let t = 0.1; t < LOOP; t += 0.08 + rand() * 0.35) chirp(buf, t, 500 + rand() * 700, 900 + rand() * 1200, 0.04 + rand() * 0.04, 0.12);
  return loopSeam(buf, 2).normalize(0.45);
}

function night(): Buffer32 {
  const buf = new Buffer32(LOOP + 2);
  filteredNoise(buf, 0.04, () => 300, () => 1, 71);
  // Dế: xung 4.6 kHz, nhóm 3 tiếng, chu kỳ ~0.9s; hai con lệch pha.
  for (const [offset, f] of [[0, 4600], [0.43, 4150]] as const) {
    for (let t = offset; t < LOOP; t += 0.9) for (let k = 0; k < 3; k++) chirp(buf, t + k * 0.05, f, f, 0.035, 0.12);
  }
  return loopSeam(buf, 2).normalize(0.4);
}

function crowdPark(): Buffer32 {
  const rand = rng(81);
  const buf = new Buffer32(LOOP + 2);
  filteredNoise(buf, 0.6, () => 700, (t) => 0.6 + 0.2 * Math.sin(t * 0.9), 82);
  for (let t = 0.2; t < LOOP; t += 1.2 + rand() * 2.5) {
    const base = 2800 + rand() * 1500;
    chirp(buf, t, base, base * 1.2, 0.08, 0.08);
  }
  return loopSeam(buf, 2).normalize(0.35);
}

// ---------------------------------------------------------------- hiệu ứng hoạt hình (không lặp)

/** Quét tần mũ (còi trượt): f0 → f1 trong `len` giây, có vibrato. */
function glide(buf: Buffer32, start: number, len: number, f0: number, f1: number, amp: number, vibrato = 0): void {
  const s0 = Math.round(start * RATE);
  const n = Math.round(len * RATE);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = f0 * (f1 / f0) ** (t / len) * (1 + vibrato * Math.sin(2 * Math.PI * 6 * t));
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, t / 0.02, (len - t) / 0.08);
    buf.add(s0 + i, amp * env * (Math.sin(phase) + 0.15 * Math.sin(2 * phase)));
  }
}

/** Còi trượt xuống: ngã, hụt hẫng. */
const slideDown = () => {
  const b = new Buffer32(0.8);
  glide(b, 0, 0.7, 1400, 260, 0.5, 0.025);
  return b.normalize(0.7);
};
/** Còi trượt lên: bật dậy, hào hứng. */
const slideUp = () => {
  const b = new Buffer32(0.5);
  glide(b, 0, 0.42, 320, 1300, 0.5, 0.02);
  return b.normalize(0.65);
};
/** Lấp lánh: chuỗi chuông cao đi lên (phát hiện, bất ngờ, phép màu). */
const sparkle = () => {
  const b = new Buffer32(1.4);
  [84, 88, 91, 96, 100, 103].forEach((m, k) => bell(b, 0.06 * k, midi(m), 0.35 - 0.035 * k, 0.7));
  return b.normalize(0.55);
};
/** Bụp: bong bóng / nhặt lên gọn. */
const pop = () => {
  const b = new Buffer32(0.18);
  let phase = 0;
  for (let i = 0; i < b.data.length; i++) {
    const t = i / RATE;
    phase += (2 * Math.PI * (180 + 1000 * Math.exp(-t * 45))) / RATE;
    b.add(i, Math.exp(-t * 32) * Math.sin(phase));
  }
  return b.normalize(0.6);
};
/** Leng keng nhẹ: ôm, tình cảm. */
const twinkle = () => {
  const b = new Buffer32(1.1);
  bell(b, 0, midi(84), 0.3, 0.8);
  bell(b, 0.13, midi(88), 0.25, 0.8);
  return b.normalize(0.45);
};
/** Gõ nhẹ (vỗ vai). */
const tap = () => {
  const b = new Buffer32(0.25);
  note(b, 0, 0.03, 620, 0.5, tri, 45);
  noiseHit(b, 0, 0.05, 0.25, 60, false, rng(7));
  return b.normalize(0.5);
};
/** Vút: gió lướt qua (chạy vụt, xoay người). */
const swish = () => {
  const b = new Buffer32(0.45);
  filteredNoise(b, 1, (t) => 600 + 5200 * Math.sin((Math.PI * t) / 0.45), (t) => Math.sin((Math.PI * t) / 0.45) ** 2, 11);
  return b.normalize(0.5);
};

interface Item {
  id: string;
  name: string;
  tags: string[];
  build: () => Buffer32;
}

const ITEMS: Item[] = [
  { id: "music_calm", name: "Nhạc nhẹ nhàng", tags: ["music", "calm", "gentle"], build: calm },
  { id: "music_adventure", name: "Nhạc phiêu lưu", tags: ["music", "adventure", "journey"], build: adventure },
  { id: "music_sad", name: "Nhạc buồn", tags: ["music", "sad", "emotional"], build: sad },
  { id: "music_magic", name: "Nhạc kỳ diệu", tags: ["music", "magic", "wonder"], build: magic },
  { id: "music_playful", name: "Nhạc tinh nghịch", tags: ["music", "playful", "funny"], build: playful },
  { id: "amb_birds", name: "Chim hót, gió nhẹ", tags: ["ambience", "birds", "forest", "meadow"], build: birds },
  { id: "amb_wind", name: "Gió", tags: ["ambience", "wind", "snow", "desert"], build: wind },
  { id: "amb_water", name: "Nước chảy", tags: ["ambience", "water", "pond"], build: water },
  { id: "amb_night", name: "Dế kêu đêm", tags: ["ambience", "night", "crickets"], build: night },
  { id: "amb_park", name: "Công viên", tags: ["ambience", "park", "farm"], build: crowdPark },
  { id: "sfx_slide_down", name: "Còi trượt xuống", tags: ["sfx", "cartoon", "fall"], build: slideDown },
  { id: "sfx_slide_up", name: "Còi trượt lên", tags: ["sfx", "cartoon", "jump"], build: slideUp },
  { id: "sfx_sparkle", name: "Lấp lánh", tags: ["sfx", "cartoon", "magic", "surprise"], build: sparkle },
  { id: "sfx_pop", name: "Bụp", tags: ["sfx", "cartoon", "pop"], build: pop },
  { id: "sfx_twinkle", name: "Leng keng nhẹ", tags: ["sfx", "cartoon", "love"], build: twinkle },
  { id: "sfx_tap", name: "Gõ nhẹ", tags: ["sfx", "cartoon", "tap"], build: tap },
  { id: "sfx_swish", name: "Vút", tags: ["sfx", "cartoon", "whoosh"], build: swish },
];

await mkdir(OUT, { recursive: true });
const registry = await readRegistry();

// Vòng lặp bước chân (6 bước, 0.42s/bước) từ tiếng bước chân Kenney (npm run audio:add … --prefix sfx_step_<mặt đất>_).
const STEP = 0.42;
for (const surface of ["grass", "snow", "wood", "concrete"]) {
  const steps = registry.assets.filter((a) => a.id.startsWith(`sfx_step_${surface}_`)).sort((a, b) => a.id.localeCompare(b.id));
  if (!steps.length) continue;
  const order = [0, 1, 2, 3, 4, 1].map((k) => steps[k % steps.length]!);
  const len = order.length * STEP;
  const id = `sfx_steps_${surface}_loop`;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const s of order) args.push("-i", resolve(import.meta.dirname, "../public/assets", s.file));
  const chains = order.map((_, i) => `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,volume=${i % 2 ? 0.8 : 1},adelay=${Math.round(i * STEP * 1000)}:all=1[s${i}]`);
  const mix = `${order.map((_, i) => `[s${i}]`).join("")}amix=inputs=${order.length}:normalize=0,apad=whole_dur=${len},atrim=duration=${len}[out]`;
  args.push("-filter_complex", [...chains, mix].join(";"), "-map", "[out]", "-c:a", "pcm_s16le", resolve(OUT, `${id}.wav`));
  await runFfmpeg(args);
  const entry = AssetEntrySchema.parse({
    id,
    type: "audio",
    name: `Bước chân lặp (${surface})`,
    file: `audio/gen/${id}.wav`,
    duration: Math.round(len * 1000) / 1000,
    tags: ["audio", "sfx", "footstep", "loop", surface],
    pack: "Kenney · Impact Sounds (ghép lặp)",
    license: "CC0-1.0",
    author: "Kenney",
    source: "https://kenney.nl/assets/impact-sounds",
    commercialUse: true,
    attributionRequired: false,
  });
  const at = registry.assets.findIndex((a) => a.id === id);
  if (at >= 0) registry.assets[at] = entry;
  else registry.assets.push(entry);
  console.log(`✓ ${id} (${entry.duration}s)`);
}
for (const item of ITEMS) {
  const buf = item.build();
  const file = `${item.id}.wav`;
  await writeFile(resolve(OUT, file), wav(buf));
  const entry = AssetEntrySchema.parse({
    id: item.id,
    type: "audio",
    name: item.name,
    file: `audio/gen/${file}`,
    duration: Math.round(buf.seconds * 1000) / 1000,
    tags: ["audio", ...item.tags],
    pack: "AutoCartoon · tự sinh",
    license: "CC0-1.0",
    author: "AutoCartoon",
    source: "scripts/generate-audio-library.ts",
    commercialUse: true,
    attributionRequired: false,
  });
  const at = registry.assets.findIndex((a) => a.id === item.id);
  if (at >= 0) registry.assets[at] = entry;
  else registry.assets.push(entry);
  console.log(`✓ ${item.id} (${entry.duration}s, ${((44 + buf.data.length * 2) / 1024).toFixed(0)} KB)`);
}
await writeRegistry(registry);
