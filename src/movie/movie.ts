import { z } from "zod";
import { computeAudioSegments, trackSegments, type AudioSegment } from "../engine/AudioTimeline";
import { subtitleCues, type SubtitleCue } from "../engine/Subtitles";
import { totalFrames } from "../engine/time";
import type { Registry } from "../schemas/asset.schema";
import { AudioTrackSchema, MixSchema, SubtitleStyleSchema, type SceneScript } from "../schemas/scene.schema";

/**
 * Movie = nhiều khung cảnh (mỗi cảnh là một Scene Script đầy đủ, bối cảnh riêng) nối thành một video.
 *
 *   movie.json ─► từng scene: resolve + render clip (chỉ hình, cache theo hash)
 *              ─► ghép clip (cut / fade / dissolve) + trộn audio toàn phim + phụ đề gộp ─► MP4
 *
 * Mốc thời gian của cảnh k: start_k = start_{k-1} + len_{k-1} − d_k (d_k = độ dài chuyển cảnh vào cảnh k,
 * 0 với "cut"). "fade" và "dissolve" chồng 2 cảnh trong d_k giây (fade: tối dần về đen rồi sáng lên).
 */

export const TRANSITION_TYPES = ["cut", "fade", "dissolve"] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES).default("cut"),
  /** Giây; bỏ qua với "cut". */
  duration: z.number().min(0.1).max(3).default(0.6),
});
export type Transition = z.infer<typeof TransitionSchema>;

const sceneId = z.string().regex(/^[A-Za-z0-9_-]+$/, "id chỉ gồm chữ, số, '_' hoặc '-'");
const even = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .refine((v) => v % 2 === 0, "phải là số chẵn");

export const MovieSceneSchema = z
  .object({
    id: sceneId,
    /** Đường dẫn scene.json, tương đối với thư mục project. */
    file: z.string().min(1).optional(),
    /** Hoặc Scene Script viết trực tiếp. */
    scene: z.record(z.string(), z.unknown()).optional(),
    /** Cách chuyển VÀO cảnh này (cảnh đầu tiên bỏ qua). */
    transition: TransitionSchema.default({ type: "cut", duration: 0.6 }),
  })
  .refine((s) => (s.file === undefined) !== (s.scene === undefined), { message: "mỗi cảnh cần đúng một trong 'file' hoặc 'scene'" });
export type MovieScene = z.infer<typeof MovieSceneSchema>;

export const MovieSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    name: z.string().min(1),
    fps: z.number().int().min(1).max(60),
    width: even,
    height: even,
    commercial: z.boolean().default(false),
  }),
  scenes: z.array(MovieSceneSchema).min(1).max(50),
  /** Âm thanh chạy suốt phim (vd. nhạc nền), thời gian tính theo cả phim. */
  audio: z.array(AudioTrackSchema).default([]),
  /** Ducking + chuẩn hóa độ to cho cả phim (thay cho mix của từng cảnh). */
  mix: MixSchema.default({ duckMusic: true, duckLevel: 0.3, duckRamp: 0.25, loudness: -14 }),
  /** Kiểu phụ đề chung – ghi đè `subtitles` của từng cảnh nếu có. */
  subtitles: SubtitleStyleSchema.optional(),
});
export type Movie = z.infer<typeof MovieSchema>;

export interface MovieIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SceneTiming {
  id: string;
  /** Thời điểm bắt đầu trong phim (giây). */
  start: number;
  /** Độ dài clip (giây, đã làm tròn theo frame). */
  duration: number;
  frames: number;
  /** Chuyển cảnh vào cảnh này (cảnh đầu: cut); duration đã làm tròn theo frame, 0 với cut. */
  transition: { type: TransitionType; duration: number };
}

export interface MovieTimeline {
  scenes: SceneTiming[];
  duration: number;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Tính mốc thời gian các cảnh. `durations` = meta.duration của từng scene đã resolve. */
export function movieTimeline(
  entries: readonly { id: string; duration: number; transition: Transition }[],
  fps: number,
): { timeline: MovieTimeline; issues: MovieIssue[] } {
  const issues: MovieIssue[] = [];
  const scenes: SceneTiming[] = [];
  let cursor = 0;
  entries.forEach((e, i) => {
    const frames = totalFrames(e.duration, fps);
    const duration = r6(frames / fps);
    const overlapFrames = i === 0 || e.transition.type === "cut" ? 0 : Math.max(1, Math.round(e.transition.duration * fps));
    const overlap = r6(overlapFrames / fps);
    const start = r6(Math.max(0, cursor - overlap));
    scenes.push({ id: e.id, start, duration, frames, transition: { type: i === 0 ? "cut" : e.transition.type, duration: overlap } });
    cursor = r6(start + duration);
  });

  // Hai lần chuyển cảnh của một cảnh không được chồng lên nhau.
  scenes.forEach((s, i) => {
    const next = scenes[i + 1]?.transition.duration ?? 0;
    if (s.transition.duration + next > s.duration + 1e-6) {
      issues.push({
        code: "TransitionTooLong",
        message: `Cảnh "${s.id}" dài ${s.duration}s, ngắn hơn tổng thời gian chuyển cảnh (${r6(s.transition.duration + next)}s)`,
        path: `scenes.${i}.transition`,
      });
    }
  });
  const ids = new Set<string>();
  entries.forEach((e, i) => {
    if (ids.has(e.id)) issues.push({ code: "DuplicateId", message: `Trùng id cảnh "${e.id}"`, path: `scenes.${i}.id` });
    ids.add(e.id);
  });
  return { timeline: { scenes, duration: cursor }, issues };
}

/**
 * Audio toàn phim: đoạn của từng cảnh (dời theo start) + audio chung của movie.
 * Nhạc / hiệu ứng chạm biên cảnh tự fade theo chuyển cảnh để không bị cắt cụt.
 */
export function movieAudioSegments(movie: Pick<Movie, "audio">, scenes: readonly SceneScript[], timeline: MovieTimeline, registry: Registry): AudioSegment[] {
  const out: AudioSegment[] = [];
  scenes.forEach((scene, i) => {
    const t = timeline.scenes[i]!;
    const fadeIn = t.transition.duration;
    const fadeOut = timeline.scenes[i + 1]?.transition.duration ?? 0;
    for (const seg of computeAudioSegments(scene, registry)) {
      const end = Math.min(seg.end, t.duration);
      if (end - seg.start <= 1e-6) continue;
      const s = { ...seg, id: `${t.id}/${seg.id}`, start: r6(t.start + seg.start), end: r6(t.start + end) };
      if (seg.kind !== "voice") {
        if (fadeIn > 0 && seg.start < 1e-3) s.fadeIn = Math.max(s.fadeIn, fadeIn);
        if (fadeOut > 0 && end > t.duration - 1e-3) s.fadeOut = Math.max(s.fadeOut, fadeOut);
      }
      out.push(s);
    }
  });
  out.push(...trackSegments(movie.audio, timeline.duration, registry));
  return out;
}

/** Phụ đề gộp của cả phim (mốc thời gian theo phim). */
export function movieSubtitleCues(scenes: readonly SceneScript[], timeline: MovieTimeline): SubtitleCue[] {
  return scenes.flatMap((scene, i) => {
    const t = timeline.scenes[i]!;
    return subtitleCues(scene)
      .filter((c) => c.start < t.duration)
      .map((c) => ({ ...c, start: r6(t.start + c.start), end: r6(t.start + Math.min(c.end, t.duration)) }));
  });
}

/**
 * Scene thô trước khi resolve: áp meta (kích thước, fps) và phụ đề chung của movie.
 * Không đụng tới nội dung còn lại – resolve/validate như scene thường.
 */
export function applyMovieDefaults(raw: unknown, movie: Movie, entry: MovieScene): Record<string, unknown> {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const meta = { ...((obj.meta as Record<string, unknown> | undefined) ?? {}) };
  meta.name ??= `${movie.meta.name} – ${entry.id}`;
  meta.width = movie.meta.width;
  meta.height = movie.meta.height;
  meta.fps = movie.meta.fps;
  meta.commercial = movie.meta.commercial;
  const out: Record<string, unknown> = { version: 1, ...obj, meta };
  if (movie.subtitles) out.subtitles = movie.subtitles;
  return out;
}
