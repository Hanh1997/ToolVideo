/**
 * Tổng hợp âm thanh demo bằng code (tự tạo → CC0): nhạc nền lặp + hiệu ứng.
 * Tất định: cùng seed → cùng file.
 * Chạy: npm run assets:generate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Buffer32, kick, midi, noiseHit, note, RATE, rng, sine, soft, tri, wav } from "./synth";

const OUT = resolve(import.meta.dirname, "../public/assets/audio");
/** Nhạc nền vui tươi 120 bpm, 4 ô nhịp C–Am–F–G, lặp liền mạch 8 giây. */
function music(): Buffer32 {
  const rand = rng(7);
  const buf = new Buffer32(8, true);
  const eighth = 0.25;
  const bars = [
    { root: 48, chord: [60, 64, 67], melody: [76, 79, 81, 79, 76, 74, 72, 0] },
    { root: 45, chord: [57, 60, 64], melody: [69, 72, 76, 74, 72, 69, 72, 0] },
    { root: 41, chord: [53, 57, 60], melody: [69, 72, 74, 72, 69, 67, 69, 0] },
    { root: 43, chord: [55, 59, 62], melody: [67, 69, 72, 74, 76, 74, 79, 0] },
  ];
  bars.forEach((bar, b) => {
    const t0 = b * 2;
    // Bass: root – quãng 5 theo từng phách.
    [0, 7, 0, 7].forEach((iv, beat) => note(buf, t0 + beat * 0.5, 0.42, midi(bar.root + iv), 0.3, tri, 3));
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * eighth;
      const m = bar.melody[e]!;
      if (m) note(buf, t, e === 6 ? 0.45 : 0.2, midi(m), 0.2, soft, 3.5);
      const arp = bar.chord[[0, 1, 2, 1][e % 4]!]!;
      note(buf, t, 0.12, midi(arp + 12), 0.06, sine, 9);
      noiseHit(buf, t, 0.04, 0.035, 90, true, rand);
    }
    kick(buf, t0, 0.45);
    kick(buf, t0 + 1, 0.45);
    noiseHit(buf, t0 + 0.5, 0.15, 0.12, 25, false, rand);
    noiseHit(buf, t0 + 1.5, 0.15, 0.12, 25, false, rand);
  });
  return buf.normalize(0.8);
}

/** "Boing" khi nhảy: quét tần số đi lên + rung. */
function boing(): Buffer32 {
  const buf = new Buffer32(0.5);
  let phase = 0;
  for (let i = 0; i < buf.data.length; i++) {
    const t = i / RATE;
    const f = 220 * 3 ** Math.min(t / 0.18, 1) * (1 + 0.04 * Math.sin(2 * Math.PI * 14 * t) * Math.min(t / 0.18, 1));
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 6);
    buf.add(i, env * (Math.sin(phase) + 0.3 * Math.sin(2 * phase)));
  }
  return buf.normalize(0.7);
}

/** Tiếp đất: tiếng thịch trầm + chút tạp âm. */
function land(): Buffer32 {
  const buf = new Buffer32(0.3);
  kick(buf, 0, 1);
  noiseHit(buf, 0, 0.12, 0.35, 40, false, rng(3));
  return buf.normalize(0.75);
}

/** Chuông: hai nốt G5 → C6 với các họa âm kiểu bell. */
function chime(): Buffer32 {
  const buf = new Buffer32(1.6);
  const bell = (start: number, f: number) => {
    const partials: [number, number, number][] = [
      [1, 1, 3],
      [2, 0.45, 4.5],
      [2.76, 0.25, 6],
      [5.4, 0.12, 9],
    ];
    for (const [ratio, amp, decay] of partials) note(buf, start, 1.3, f * ratio, amp, sine, decay, 0.002);
  };
  bell(0, 784);
  bell(0.14, 1047);
  return buf.normalize(0.6);
}

/** "Vút" khi tăng tốc: tạp âm lọc thông thấp với tần số cắt quét lên rồi xuống. */
function whoosh(): Buffer32 {
  const rand = rng(11);
  const buf = new Buffer32(0.6);
  let y = 0;
  for (let i = 0; i < buf.data.length; i++) {
    const p = i / buf.data.length;
    const cutoff = 300 + 3500 * Math.sin(Math.PI * p) ** 2;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
    y += a * (rand() * 2 - 1 - y);
    buf.add(i, Math.sin(Math.PI * p) ** 1.5 * y);
  }
  return buf.normalize(0.55);
}

const files: [string, Buffer32][] = [
  ["music_happy_loop.wav", music()],
  ["sfx_boing.wav", boing()],
  ["sfx_land.wav", land()],
  ["sfx_chime.wav", chime()],
  ["sfx_whoosh.wav", whoosh()],
];

for (const [name, buf] of files) {
  const path = resolve(OUT, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, wav(buf));
  console.log(`✓ audio/${name} (${buf.seconds}s, ${((44 + buf.data.length * 2) / 1024).toFixed(0)} KB)`);
}
