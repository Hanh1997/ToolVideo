import { z } from "zod";
import { findAsset, type AssetEntry, type Registry } from "../schemas/asset.schema";
import { EmotionSchema, type Emotion } from "../schemas/scene.schema";

/**
 * Resolver: Scene soạn thảo → Scene đã resolve (toàn số cụ thể).
 *
 *   dialogue[].start   : số | { after: "<line id>", gap?: 0.3 }
 *   dialogue[] thiếu duration/file → gọi TTS (có cache) để sinh
 *   actions[].sync     : { line: "<line id>", offset?: 0, pad?: 0, duration? } → start/duration theo câu thoại
 *   audio[].sync       : { line: "<line id>", at?: "start" | "end", offset?: 0 } → start theo câu thoại
 *   meta.duration      : số | "auto"  (auto = lời thoại / action / audio kết thúc muộn nhất + meta.tail;
 *                        camera không tính, camera action vượt quá bị cắt ở cuối video)
 *
 * Không phụ thuộc Node: hàm TTS được truyền vào → test được, dùng chung CLI + dev server.
 */

export interface TtsRequest {
  text: string;
  voice: AssetEntry;
  rate: number;
}

export interface TtsResult {
  /** Tương đối với /assets/ */
  file: string;
  duration: number;
  /** Envelope độ to (0..1, LIPSYNC_RATE mẫu/giây) cho nhép miệng. */
  envelope?: number[];
  /** true: lấy từ cache, không gọi engine. */
  cached: boolean;
}

export type Synthesize = (req: TtsRequest) => Promise<TtsResult>;

export interface ResolveIssue {
  code: "InvalidSchema" | "TargetNotFound" | "AssetNotFound" | "AssetTypeMismatch" | "TtsFailed" | "DialogueOrder";
  message: string;
  path?: string;
}

export interface ResolveResult {
  scene: unknown;
  issues: ResolveIssue[];
  /** Số câu phải gọi TTS mới (không tính cache). Chỉ để log. */
  synthesized: number;
}

const DEFAULT_GAP = 0.3;
const DEFAULT_TAIL = 1;

const AfterSchema = z.object({ after: z.string().min(1), gap: z.number().min(-5).max(30).default(DEFAULT_GAP) });

const DialogueInputSchema = z.object({
  id: z.string().min(1),
  speaker: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  text: z.string().min(1).max(1000),
  start: z.union([z.number().min(0), AfterSchema]),
  voice: z.string().min(1).optional(),
  rate: z.number().min(0.5).max(2).optional(),
  volume: z.number().min(0).max(4).default(1),
  /** Lệch trái (-1) / phải (1) theo chỗ người nói trên khung hình. */
  pan: z.number().min(-1).max(1).default(0),
  subtitle: z.boolean().default(true),
  emotion: EmotionSchema.default("neutral"),
});

/** Tốc độ đọc theo cảm xúc khi câu không đặt `rate` (nhân với tốc độ mặc định của giọng). */
const EMOTION_RATE: Record<Emotion, number> = { neutral: 1, happy: 1.05, sad: 0.88, surprised: 1.06, angry: 1.03, scared: 1.1 };
/**
 * Ngữ điệu theo cảm xúc (TTS không có điều khiển cảm xúc): lệch cao độ (bán cung, cộng vào cao độ của giọng) và
 * độ to – vui / ngạc nhiên / sợ cao giọng hơn, buồn trầm và nhỏ hơn, giận to và hơi trầm.
 */
const EMOTION_PITCH: Record<Emotion, number> = { neutral: 0, happy: 0.7, sad: -0.9, surprised: 1.4, angry: -0.4, scared: 1 };
const EMOTION_VOLUME: Record<Emotion, number> = { neutral: 1, happy: 1.05, sad: 0.85, surprised: 1.1, angry: 1.15, scared: 0.9 };
const emotionVoice = (voice: AssetEntry, emotion: Emotion): AssetEntry =>
  EMOTION_PITCH[emotion] ? { ...voice, pitch: Math.round(((voice.pitch ?? 0) + EMOTION_PITCH[emotion]) * 100) / 100 } : voice;

const lineRate = (input: { rate?: number; emotion: Emotion }, voice: AssetEntry) =>
  input.rate ?? Math.round((voice.defaultRate ?? 1) * EMOTION_RATE[input.emotion] * 100) / 100;

const SyncSchema = z.object({
  line: z.string().min(1),
  offset: z.number().default(0),
  pad: z.number().default(0),
  /** Độ dài cố định (giây) thay cho "theo câu thoại" – vd. động tác diễn ra ngay trước câu (offset âm). */
  duration: z.number().positive().optional(),
  /** Mốc của offset: đầu câu (mặc định) hoặc cuối câu – vd. lùi về chỗ sau khi nói xong. */
  at: z.enum(["start", "end"]).default("start"),
});

const AudioSyncSchema = z.object({
  line: z.string().min(1),
  at: z.enum(["start", "end"]).default("start"),
  offset: z.number().default(0),
});

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Scene có cần resolve (có lời thoại / sync / duration auto) hay không. */
export function needsResolve(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  const meta = isObject(raw.meta) ? raw.meta : {};
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const audio = Array.isArray(raw.audio) ? raw.audio : [];
  const dialogue = Array.isArray(raw.dialogue) ? raw.dialogue : [];
  const synced = (list: unknown[]) => list.some((a) => isObject(a) && a.sync !== undefined);
  return dialogue.length > 0 || meta.duration === "auto" || synced(actions) || synced(audio);
}

function pickVoice(line: z.infer<typeof DialogueInputSchema>, raw: Json, registry: Registry): string | undefined {
  if (line.voice) return line.voice;
  const chars = Array.isArray(raw.characters) ? raw.characters : [];
  const speaker = chars.find((c) => isObject(c) && c.id === line.speaker);
  if (isObject(speaker) && typeof speaker.voice === "string") return speaker.voice;
  return registry.assets.find((a) => a.type === "voice")?.id;
}

export async function resolveScene(raw: unknown, registry: Registry, synthesize: Synthesize): Promise<ResolveResult> {
  if (!isObject(raw)) return { scene: raw, issues: [], synthesized: 0 };
  const issues: ResolveIssue[] = [];
  const scene: Json = structuredClone(raw);

  // 1. Parse lời thoại (bản soạn thảo).
  const rawLines = Array.isArray(scene.dialogue) ? scene.dialogue : [];
  const lines: { input: z.infer<typeof DialogueInputSchema>; voice?: AssetEntry; path: string }[] = [];
  rawLines.forEach((l, i) => {
    const path = `dialogue.${i}`;
    const parsed = DialogueInputSchema.safeParse(l);
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        issues.push({ code: "InvalidSchema", message: iss.message, path: [path, ...iss.path.map(String)].join(".") });
      }
      return;
    }
    const voiceId = pickVoice(parsed.data, scene, registry);
    const voice = voiceId ? findAsset(registry, voiceId) : undefined;
    if (!voiceId || !voice) {
      issues.push({ code: "AssetNotFound", message: `Không có giọng đọc "${voiceId ?? "(chưa khai báo)"}" trong Registry`, path: `${path}.voice` });
    } else if (voice.type !== "voice") {
      issues.push({ code: "AssetTypeMismatch", message: `Asset "${voiceId}" là ${voice.type}, cần voice`, path: `${path}.voice` });
    }
    lines.push({ input: parsed.data, voice: voice?.type === "voice" ? voice : undefined, path });
  });

  // 2. TTS (song song, provider tự cache).
  let synthesized = 0;
  const tts = await Promise.all(
    lines.map(async ({ input, voice, path }) => {
      if (!voice) return undefined;
      try {
        const r = await synthesize({ text: input.text, voice: emotionVoice(voice, input.emotion), rate: lineRate(input, voice) });
        if (!r.cached) synthesized++;
        return r;
      } catch (err) {
        issues.push({ code: "TtsFailed", message: `TTS lỗi cho "${input.id}": ${err instanceof Error ? err.message : String(err)}`, path });
        return undefined;
      }
    }),
  );

  // 3. Thời điểm bắt đầu: số hoặc nối sau câu trước (theo thứ tự khai báo).
  const timing = new Map<string, { start: number; duration: number }>();
  const resolvedLines: Json[] = [];
  lines.forEach(({ input, voice, path }, i) => {
    const audio = tts[i];
    let start: number;
    if (typeof input.start === "number") start = input.start;
    else {
      const prev = timing.get(input.start.after);
      if (!prev) {
        issues.push({
          code: "DialogueOrder",
          message: `Câu "${input.id}" nối sau "${input.start.after}" nhưng câu đó không có hoặc khai báo sau`,
          path: `${path}.start`,
        });
        return;
      }
      start = Math.max(0, prev.start + prev.duration + input.start.gap);
    }
    if (!audio || !voice) return;
    start = Math.round(start * 1000) / 1000;
    timing.set(input.id, { start, duration: audio.duration });
    resolvedLines.push({
      id: input.id,
      ...(input.speaker ? { speaker: input.speaker } : {}),
      ...(input.to ? { to: input.to } : {}),
      text: input.text,
      start,
      duration: audio.duration,
      file: audio.file,
      voice: voice.id,
      rate: lineRate(input, voice),
      ...(input.emotion !== "neutral" ? { emotion: input.emotion } : {}),
      volume: Math.round(input.volume * EMOTION_VOLUME[input.emotion] * 100) / 100,
      ...(input.pan ? { pan: input.pan } : {}),
      subtitle: input.subtitle,
      ...(audio.envelope ? { lipsync: audio.envelope } : {}),
    });
  });
  if (Array.isArray(scene.dialogue)) scene.dialogue = resolvedLines;

  // 4. Action sync theo câu thoại.
  if (Array.isArray(scene.actions)) {
    scene.actions.forEach((a, i) => {
      if (!isObject(a) || a.sync === undefined) return;
      const path = `actions.${i}.sync`;
      const sync = SyncSchema.safeParse(a.sync);
      if (!sync.success) {
        issues.push({ code: "InvalidSchema", message: sync.error.issues[0]?.message ?? "sync không hợp lệ", path });
        return;
      }
      const line = timing.get(sync.data.line);
      if (!line) {
        issues.push({ code: "TargetNotFound", message: `Action "${String(a.id)}" sync với câu thoại "${sync.data.line}" không tồn tại`, path });
        return;
      }
      const anchor = sync.data.at === "end" ? line.start + line.duration : line.start;
      a.start = Math.max(0, Math.round((anchor + sync.data.offset) * 1000) / 1000);
      a.duration = Math.max(0.05, Math.round((sync.data.duration ?? line.start + line.duration + sync.data.pad - anchor - sync.data.offset) * 1000) / 1000);
      delete a.sync;
    });
  }

  // 4b. Audio sync (vd. hiệu ứng ngay khi câu thoại kết thúc).
  if (Array.isArray(scene.audio)) {
    scene.audio.forEach((tr, i) => {
      if (!isObject(tr) || tr.sync === undefined) return;
      const path = `audio.${i}.sync`;
      const sync = AudioSyncSchema.safeParse(tr.sync);
      if (!sync.success) {
        issues.push({ code: "InvalidSchema", message: sync.error.issues[0]?.message ?? "sync không hợp lệ", path });
        return;
      }
      const line = timing.get(sync.data.line);
      if (!line) {
        issues.push({ code: "TargetNotFound", message: `Audio "${String(tr.id)}" sync với câu thoại "${sync.data.line}" không tồn tại`, path });
        return;
      }
      const anchor = sync.data.at === "end" ? line.start + line.duration : line.start;
      tr.start = Math.max(0, Math.round((anchor + sync.data.offset) * 1000) / 1000);
      delete tr.sync;
    });
  }

  // 5. meta.duration "auto".
  if (isObject(scene.meta) && scene.meta.duration === "auto") {
    const tail = typeof scene.meta.tail === "number" ? scene.meta.tail : DEFAULT_TAIL;
    let end = 0;
    for (const t of timing.values()) end = Math.max(end, t.start + t.duration);
    const actions = Array.isArray(scene.actions) ? scene.actions : [];
    for (const a of actions) {
      if (isObject(a) && a.type !== "camera" && typeof a.start === "number" && typeof a.duration === "number") end = Math.max(end, a.start + a.duration);
    }
    for (const tr of Array.isArray(scene.audio) ? scene.audio : []) {
      if (!isObject(tr) || tr.loop === true || typeof tr.start !== "number") continue;
      const asset = typeof tr.asset === "string" ? findAsset(registry, tr.asset) : undefined;
      const len = typeof tr.duration === "number" ? tr.duration : (asset?.duration ?? 0);
      end = Math.max(end, tr.start + len);
    }
    const duration = Math.max(1, Math.ceil((end + tail) * 10) / 10);
    scene.meta.duration = duration;
    delete scene.meta.tail;
    for (const a of actions) {
      if (isObject(a) && a.type === "camera" && typeof a.start === "number" && typeof a.duration === "number" && a.start + a.duration > duration) {
        a.duration = Math.max(0.05, Math.round((duration - a.start) * 1000) / 1000);
      }
    }
  } else if (isObject(scene.meta)) {
    delete scene.meta.tail;
  }

  return { scene, issues, synthesized };
}
