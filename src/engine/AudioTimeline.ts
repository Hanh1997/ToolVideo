import { findAsset, type Registry } from "../schemas/asset.schema";
import type { AudioKind, AudioTrack, SceneScript } from "../schemas/scene.schema";
import { clamp } from "./math";

/**
 * Một đoạn audio đã resolve: dùng chung cho preview (Web Audio) và render (FFmpeg)
 * → nghe trong preview đúng như trong MP4.
 */
export interface AudioSegment {
  id: string;
  kind: AudioKind;
  /** Đường dẫn tương đối với /assets/ */
  file: string;
  fileDuration: number;
  /** Thời điểm bắt đầu / kết thúc trong video (giây). */
  start: number;
  end: number;
  /** Vị trí trong file tại thời điểm `start` (giây, đã mod nếu loop). */
  offset: number;
  loop: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

/** Scene phải đã validate (asset audio tồn tại). Đoạn rỗng bị bỏ qua. */
export function computeAudioSegments(scene: SceneScript, registry: Registry): AudioSegment[] {
  const sceneEnd = scene.meta.duration;
  const segments = trackSegments(scene.audio, sceneEnd, registry);

  // Lời thoại TTS → đoạn voice.
  for (const line of scene.dialogue) {
    const end = Math.min(line.start + line.duration, sceneEnd);
    if (end - line.start <= 1e-6) continue;
    segments.push({
      id: `dlg:${line.id}`,
      kind: "voice",
      file: line.file,
      fileDuration: line.duration,
      start: line.start,
      end,
      offset: 0,
      loop: false,
      volume: line.volume,
      fadeIn: 0,
      fadeOut: 0,
    });
  }
  return segments;
}

/** Đoạn phát của các audio track trong [0, sceneEnd] – dùng cho scene và cho nhạc nền chung của movie. */
export function trackSegments(tracks: readonly AudioTrack[], sceneEnd: number, registry: Registry): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (const track of tracks) {
    const asset = findAsset(registry, track.asset);
    if (!asset || asset.type !== "audio" || !asset.duration) continue;
    const fileDuration = asset.duration;

    let end: number;
    if (track.duration !== undefined) end = track.start + track.duration;
    else if (track.loop) end = sceneEnd;
    else end = track.start + Math.max(0, fileDuration - track.trimStart);

    if (!track.loop) end = Math.min(end, track.start + Math.max(0, fileDuration - track.trimStart));
    end = Math.min(end, sceneEnd);
    if (end - track.start <= 1e-6) continue;

    segments.push({
      id: track.id,
      kind: track.kind,
      file: asset.file,
      fileDuration,
      start: track.start,
      end,
      offset: track.loop ? track.trimStart % fileDuration : track.trimStart,
      loop: track.loop,
      volume: track.volume,
      fadeIn: track.fadeIn,
      fadeOut: track.fadeOut,
    });
  }
  return segments;
}

export interface Ducking {
  /** Hệ số âm lượng nhạc nền trong lúc có thoại. */
  level: number;
  ramp: number;
  /** Khoảng có thoại (đã gộp); nhạc giảm trong [start - ramp, start], tăng lại trong [end, end + ramp]. */
  intervals: { start: number; end: number }[];
}

/** Khoảng giảm nhạc nền theo lời thoại (voice), hoặc undefined nếu không cần ducking. */
export function computeDucking(scene: Pick<SceneScript, "mix">, segments: readonly AudioSegment[]): Ducking | undefined {
  const { duckMusic, duckLevel, duckRamp } = scene.mix;
  if (!duckMusic || duckLevel >= 1) return undefined;
  if (!segments.some((s) => s.kind === "music")) return undefined;
  const voice = segments.filter((s) => s.kind === "voice").sort((a, b) => a.start - b.start);
  if (voice.length === 0) return undefined;

  // Gộp các câu gần nhau (< 2·ramp) để nhạc không "nhấp nhô" giữa hai câu.
  const intervals: { start: number; end: number }[] = [];
  for (const v of voice) {
    const last = intervals.at(-1);
    if (last && v.start - last.end < 2 * duckRamp) last.end = Math.max(last.end, v.end);
    else intervals.push({ start: v.start, end: v.end });
  }
  return { level: duckLevel, ramp: duckRamp, intervals };
}

/** Hệ số ducking tại t (1 = không giảm). Tuyến tính từng đoạn – cùng công thức với biểu thức FFmpeg. */
export function duckGainAt(d: Ducking, t: number): number {
  let w = 0;
  for (const iv of d.intervals) {
    const a = iv.start - d.ramp;
    const b = iv.end + d.ramp;
    w = Math.max(w, clamp(Math.min((t - a) / d.ramp, (b - t) / d.ramp), 0, 1));
  }
  return 1 - (1 - d.level) * w;
}

/** Các điểm gãy của đường ducking (để lập lịch Web Audio). */
export function duckBreakpoints(d: Ducking): number[] {
  return d.intervals.flatMap((iv) => [iv.start - d.ramp, iv.start, iv.end, iv.end + d.ramp]);
}

/** Hệ số âm lượng của đoạn tại thời điểm t trong video (có fade in/out tuyến tính). */
export function segmentGainAt(seg: AudioSegment, t: number): number {
  if (t < seg.start || t >= seg.end) return 0;
  const len = seg.end - seg.start;
  const local = t - seg.start;
  let g = 1;
  if (seg.fadeIn > 0) g = Math.min(g, local / Math.min(seg.fadeIn, len));
  if (seg.fadeOut > 0) g = Math.min(g, (len - local) / Math.min(seg.fadeOut, len));
  return seg.volume * clamp(g, 0, 1);
}

/** Vị trí trong file (giây) tương ứng thời điểm t trong video. */
export function segmentFileTime(seg: AudioSegment, t: number): number {
  const pos = seg.offset + Math.max(0, t - seg.start);
  return seg.loop ? pos % seg.fileDuration : Math.min(pos, seg.fileDuration);
}
