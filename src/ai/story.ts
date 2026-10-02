import { z } from "zod";
import { findAsset, resolveClip, type Registry } from "../schemas/asset.schema";
import { EmotionSchema } from "../schemas/scene.schema";
import { availableObjectKinds } from "./objects";

/**
 * Kịch bản (Story) do AI sinh từ prompt – dạng NGƯỜI ĐỌC DUYỆT được, chưa phải Scene Script.
 *
 *   prompt ──AI──► Story (nhiều ngôn ngữ) ──người duyệt──► buildScene(story, lang) ──► Scene Script ──► render
 *
 * AI chỉ chọn nội dung (nhân vật, bối cảnh, lời thoại, cử chỉ); vị trí, camera, thời gian do buildScene
 * tính TẤT ĐỊNH → scene luôn hợp lệ, không phụ thuộc AI "đoán" toạ độ.
 */

export const LANGUAGES = {
  vi: { label: "Tiếng Việt", english: "Vietnamese" },
  en: { label: "English", english: "English" },
  zh: { label: "中文", english: "Simplified Chinese" },
  fr: { label: "Français", english: "French" },
  es: { label: "Español", english: "Spanish" },
} as const;
export type Lang = keyof typeof LANGUAGES;
export const LANG_CODES = Object.keys(LANGUAGES) as Lang[];
export const LangSchema = z.enum(LANG_CODES as [Lang, ...Lang[]]);

/** Vai giọng → asset voice_<lang>_<vai>. */
export const VOICE_ROLES = ["female", "deep", "low", "child", "squeaky", "soft", "cute", "warm"] as const;
export const VoiceRoleSchema = z.enum(VOICE_ROLES);

/** Cử chỉ khi nói (tên clip chuẩn – xem clipAliases). */
export const GESTURES = [
  "wave", "yes", "no", "thumbsup", "dance", "victory", "defeat", "jump", "clap",
  // chỉ nhân vật có clip thật mới dùng được (xem supportedGestures)
  "laugh", "cry", "shrug", "think", "point", "bow", "cheer", "blow_kiss", "salute",
] as const;
/** Cử chỉ diễn một lần (không lặp suốt câu). */
export const ONCE_GESTURES: readonly string[] = ["wave", "jump", "bow", "salute", "blow_kiss"];
export const GestureSchema = z.enum(GESTURES);

export const FORMATS = { "16x9": { width: 1280, height: 720 }, "9x16": { width: 720, height: 1280 } } as const;
export type Format = keyof typeof FORMATS;

/** Độ phân giải xuất: 720p (nhanh) / 1080p (chuẩn phim, YouTube HD). */
export const RESOLUTIONS = { "720p": 1, "1080p": 1.5 } as const;
export type Resolution = keyof typeof RESOLUTIONS;
/** Số khung hình / giây: 24 (điện ảnh), 25 (truyền hình PAL, Việt Nam), 30 (web). */
export const FPS_OPTIONS = [24, 25, 30] as const;
/** Độ to chuẩn: web (YouTube / mạng xã hội, -14 LUFS) / tv (phát sóng EBU R128, -23 LUFS). */
export const LOUDNESS = { web: -14, tv: -23 } as const;
export type Loudness = keyof typeof LOUDNESS;

/** Kích thước khung hình theo hướng + độ phân giải. */
export function frameSize(format: Format = "16x9", resolution: Resolution = "720p"): { width: number; height: number } {
  const k = RESOLUTIONS[resolution];
  const { width, height } = FORMATS[format];
  return { width: Math.round((width * k) / 2) * 2, height: Math.round((height * k) / 2) * 2 };
}

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "id: chữ thường, số, '_' (≤ 24 ký tự)");
const Localized = z.record(z.string(), z.string().min(1).max(300));

export const CHARACTER_SIZES = { small: 0.8, normal: 1, big: 1.3 } as const;
export type CharacterSize = keyof typeof CHARACTER_SIZES;

export const StoryCharacterSchema = z.object({
  id: slug,
  asset: z.string().min(1),
  voice: VoiceRoleSchema,
  name: Localized,
  /** Cỡ so với asset gốc: big = bố mẹ / người lớn cùng loài, small = em bé. */
  size: z.enum(["small", "normal", "big"]).default("normal"),
});

/** Phong cách hình: không trộn Kenney khối vuông với Quaternius low-poly trong một truyện. */
export function characterStyle(asset: { pack?: string } | undefined): "cube" | "lowpoly" {
  return asset?.pack?.startsWith("Kenney") ? "cube" : "lowpoly";
}

export const OBJECT_ACTIONS = ["pickup", "give", "drop", "stow", "trip"] as const;

/**
 * Tương tác với đồ vật, diễn ra NGAY TRƯỚC câu thoại: pickup = đi tới, nhặt, mang về chỗ đứng;
 * give = đi tới người nhận, trao; drop = đặt xuống trước mặt; stow = mang món đang cầm bỏ vào hộp đồ chơi
 * (hộp tự đặt vào cảnh); trip = chạy ngang, vấp phải món đang nằm dưới đất, ngã chúi rồi đứng dậy về chỗ.
 */
export const LineActionSchema = z.object({
  type: z.enum(OBJECT_ACTIONS),
  object: slug,
  /** Người nhận (give). */
  to: slug.nullable().default(null),
  /** Người làm; bỏ trống = người nói câu này. */
  by: slug.nullable().default(null),
});
export type LineAction = z.infer<typeof LineActionSchema>;

export const INTERACTIONS = ["hug", "highfive", "pat", "leave", "play", "walk"] as const;
/** Tương tác cần người thứ hai ("with"). */
export const INTERACTIONS_WITH: readonly InteractionType[] = ["hug", "highfive", "pat", "walk"];
export type InteractionType = (typeof INTERACTIONS)[number];

/**
 * Tương tác giữa hai nhân vật. hug / highfive / pat diễn ra NGAY TRƯỚC câu thoại (người làm đi tới, chạm, quay về);
 * leave = người nói (+ `with`, hoặc cả nhóm khi bỏ trống) cùng đi ra khỏi khung hình trong lúc nói – chỉ ở câu cuối cảnh;
 * play = chạy một vòng vui đùa rồi nhảy cẫng (có `with` → hai người đuổi nhau), trước câu thoại;
 * walk = đi tới đứng cạnh `with` (đổi chỗ đứng) rồi nói.
 */
export const LineInteractionSchema = z.object({
  type: z.enum(INTERACTIONS),
  /** Người cùng tương tác. */
  with: slug.nullable().default(null),
  /** Người làm; bỏ trống = người nói câu này. */
  by: slug.nullable().default(null),
});
export type LineInteraction = z.infer<typeof LineInteractionSchema>;

export const StoryLineSchema = z.object({
  id: slug,
  /** null = người dẫn chuyện */
  speaker: slug.nullable(),
  gesture: GestureSchema.nullable().default(null),
  /** Cảm xúc khi nói → tư thế + tốc độ đọc. */
  emotion: EmotionSchema.default("neutral"),
  text: Localized,
  action: LineActionSchema.nullable().default(null),
  /** Nói với ai (id nhân vật); null = tự đoán (người đáp lời kế tiếp). */
  to: slug.nullish(),
  interaction: LineInteractionSchema.nullish(),
  /** Người làm action / interaction làm gì SAU câu (xem AFTER_MOVES); null = tự chọn (walk: ở lại, còn lại: về chỗ cũ). */
  then: z.enum(["return", "stay", "leave"]).nullish(),
  /** Âm thanh không lời người nói phát ra ngay trước câu (cười, thốt lên…); xem VOCALS. */
  vocal: z.enum(["laugh", "gasp", "sigh", "hmm", "wow", "ouch", "yay"]).nullish(),
});

/** Âm thanh không lời → lời đọc ngắn theo ngôn ngữ (đọc bằng giọng nhân vật, không hiện phụ đề). */
export const VOCALS = {
  laugh: { vi: "Hi hi hi!", en: "Hee hee hee!", zh: "嘻嘻嘻！", fr: "Hi hi hi !", es: "¡Ji ji ji!" },
  gasp: { vi: "Ối!", en: "Oh!", zh: "哎呀！", fr: "Oh !", es: "¡Oh!" },
  sigh: { vi: "Haizz…", en: "Haah…", zh: "唉……", fr: "Pff…", es: "Ay…" },
  hmm: { vi: "Hừm…", en: "Hmm…", zh: "嗯……", fr: "Hum…", es: "Mmm…" },
  wow: { vi: "Oa!", en: "Wow!", zh: "哇！", fr: "Waouh !", es: "¡Guau!" },
  ouch: { vi: "Ui da!", en: "Ouch!", zh: "哎哟！", fr: "Aïe !", es: "¡Ay!" },
  yay: { vi: "Yeah!", en: "Yay!", zh: "耶！", fr: "Youpi !", es: "¡Bien!" },
} as const satisfies Record<string, Record<Lang, string>>;
export type Vocal = keyof typeof VOCALS;

/**
 * Sau tương tác: return = đi về chỗ cũ, stay = đứng lại chỗ vừa tới (chỗ đứng mới cho các câu sau),
 * leave = đi ra khỏi cảnh ngay sau câu (không xuất hiện lại trong cảnh này).
 */
export const AFTER_MOVES = ["return", "stay", "leave"] as const;
export type AfterMove = (typeof AFTER_MOVES)[number];

/** Người làm action / interaction của câu (null = không có hoặc người dẫn chuyện). */
export function lineActor(l: { speaker: string | null; action?: { by: string | null } | null; interaction?: { by: string | null } | null }): string | null {
  if (l.action) return l.action.by ?? l.speaker;
  if (l.interaction) return l.interaction.by ?? l.speaker;
  return null;
}

/** Sau câu này người làm đi đâu: theo `then`, mặc định walk → ở lại, còn lại → về chỗ. */
export function afterMove(l: StoryLine): AfterMove {
  return l.then ?? (l.interaction?.type === "walk" ? "stay" : "return");
}

/** Đồ vật trong truyện: lúc đầu nằm ở một cảnh (`scene`) hoặc đang được ai đó cầm (`heldBy`). */
export const StoryObjectSchema = z.object({
  id: slug,
  /** Loại trong OBJECT_KINDS (flower_red, mushroom, trash_bottle…). */
  kind: z.string().min(1),
  name: Localized,
  scene: slug.nullable().default(null),
  heldBy: slug.nullable().default(null),
});
export type StoryObject = z.infer<typeof StoryObjectSchema>;

export const STORY_TRANSITIONS = ["cut", "fade", "dissolve"] as const;

/**
 * Cách nhân vật có mặt khi cảnh mở: "walk" = cả nhóm đi vào, "speaker" = chỉ người nói đầu tiên đi vào
 * (người khác đứng sẵn), "none" = mọi người đứng sẵn. null = tự chọn (cảnh đầu "speaker", cảnh sau "none").
 */
export const STORY_ENTRANCES = ["walk", "speaker", "none"] as const;
export type StoryEntrance = (typeof STORY_ENTRANCES)[number];

/** Cảm xúc → nhạc nền (xem MUSIC_BY_MOOD trong buildScene). */
export const MOODS = ["happy", "calm", "adventure", "sad", "magic", "playful"] as const;
export const MoodSchema = z.enum(MOODS);
export type Mood = z.infer<typeof MoodSchema>;

/** Một khung cảnh: bối cảnh riêng, nhân vật có mặt, lời thoại của cảnh. */
export const StorySceneSchema = z.object({
  id: slug,
  environment: z.string().min(1),
  /** Id nhân vật (trong characters) có mặt ở cảnh này. */
  cast: z.array(slug).min(1).max(5),
  /** Cách chuyển VÀO cảnh này (cảnh đầu bỏ qua). */
  transition: z.enum(STORY_TRANSITIONS).default("fade"),
  /** Cảm xúc riêng của cảnh (đổi nhạc); null = theo cả truyện. */
  mood: MoodSchema.nullable().default(null),
  /** Thời điểm trong ngày → ánh sáng, bầu trời, hiệu ứng (đêm: đom đóm); null = mặc định của bối cảnh. */
  time: z.enum(["day", "morning", "sunset", "night"]).nullable().default(null),
  /** Ai đi vào khi cảnh mở (xem STORY_ENTRANCES); null = tự chọn. */
  entrance: z.enum(STORY_ENTRANCES).nullish(),
  lines: z.array(StoryLineSchema).min(1).max(20),
});

export const MAX_SCENES = 6;
export const MAX_LINES = 50;

/**
 * Kịch bản cũ (một bối cảnh: `environment` + `lines` ở cấp gốc) → một cảnh duy nhất.
 * Dùng cho bản nháp đã lưu trước khi có nhiều khung cảnh.
 */
export function normalizeStory(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (r.scenes !== undefined || !Array.isArray(r.lines)) return raw;
  const { environment, lines, ...rest } = r;
  const cast = Array.isArray(r.characters) ? r.characters.map((c) => (c as { id?: unknown }).id) : [];
  return { ...rest, scenes: [{ id: "s1", environment, cast, transition: "cut", lines }] };
}

export const StorySchema = z.preprocess(
  normalizeStory,
  z.object({
    languages: z.array(LangSchema).min(1),
    title: Localized,
    summary: Localized,
    music: z.boolean().default(true),
    mood: MoodSchema.default("happy"),
    narratorVoice: VoiceRoleSchema.default("female"),
    ending: z.enum(["dance", "wave", "none"]).default("dance"),
    characters: z.array(StoryCharacterSchema).min(1).max(6),
    objects: z.array(StoryObjectSchema).max(6).default([]),
    scenes: z.array(StorySceneSchema).min(1).max(MAX_SCENES),
  }),
);
export type Story = z.infer<typeof StorySchema>;
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type StoryCharacter = z.infer<typeof StoryCharacterSchema>;
export type StoryLine = z.infer<typeof StoryLineSchema>;

/** Mọi câu thoại theo thứ tự (qua mọi cảnh). */
export function allLines(story: Story): StoryLine[] {
  return story.scenes.flatMap((s) => s.lines);
}

/** Trạng thái đồ vật lúc bắt đầu mỗi cảnh: ai đang cầm, món nào đang nằm trong cảnh này. */
export interface SceneObjectState {
  heldBy: Map<string, string>;
  lying: Set<string>;
}

/**
 * Mô phỏng đồ vật qua các cảnh (nhặt / trao / đặt xuống). Trả về trạng thái đầu mỗi cảnh + lỗi (tiếng Anh, gửi lại cho AI).
 * Đồ vật đang được cầm đi theo người cầm sang cảnh sau; nằm trên đất thì ở lại cảnh đó.
 */
export function simulateObjects(story: Story): { states: SceneObjectState[]; issues: StoryIssue[] } {
  const issues: StoryIssue[] = [];
  const holder = new Map<string, string>();
  const location = new Map<string, string>();
  for (const o of story.objects) {
    if (o.heldBy) holder.set(o.id, o.heldBy);
    else if (o.scene) location.set(o.id, o.scene);
  }
  const states: SceneObjectState[] = [];
  story.scenes.forEach((scene, si) => {
    const cast = new Set(scene.cast);
    states.push({
      heldBy: new Map([...holder].filter(([, c]) => cast.has(c))),
      lying: new Set([...location].filter(([, s]) => s === scene.id).map(([o]) => o)),
    });
    scene.lines.forEach((line, li) => {
      const a = line.action;
      if (!a) return;
      const path = `scenes.${si}.lines.${li}.action`;
      const actor = a.by ?? line.speaker;
      if (!actor) return void issues.push({ path, message: `narrator lines cannot act – set "by" to a character` });
      if (!cast.has(actor)) return void issues.push({ path, message: `"${actor}" is not in this scene's cast` });
      if (!story.objects.some((o) => o.id === a.object)) return void issues.push({ path: `${path}.object`, message: `"${a.object}" is not an object id from "objects"` });
      switch (a.type) {
        case "pickup":
          if (holder.has(a.object)) issues.push({ path, message: `"${a.object}" is already held by "${holder.get(a.object)}"` });
          else if ([...holder.values()].includes(actor)) {
            const held = [...holder].find(([, c]) => c === actor)![0];
            issues.push({ path, message: `"${actor}" is already holding "${held}" – a character holds one object at a time (drop or give it first)` });
          }
          else if (location.get(a.object) !== scene.id) issues.push({ path, message: `"${a.object}" is not lying in scene "${scene.id}" at this point` });
          else {
            location.delete(a.object);
            holder.set(a.object, actor);
          }
          break;
        case "give":
          if (holder.get(a.object) !== actor) issues.push({ path, message: `"${actor}" is not holding "${a.object}"` });
          else if (!a.to || !cast.has(a.to) || a.to === actor) issues.push({ path: `${path}.to`, message: `"give" needs "to": another character in this scene's cast` });
          else if ([...holder.values()].includes(a.to)) issues.push({ path: `${path}.to`, message: `"${a.to}" is already holding something – a character holds one object at a time` });
          else holder.set(a.object, a.to);
          break;
        case "drop":
          if (holder.get(a.object) !== actor) issues.push({ path, message: `"${actor}" is not holding "${a.object}"` });
          else {
            holder.delete(a.object);
            location.set(a.object, scene.id);
          }
          break;
        case "stow":
          // Cất vào hộp: không nằm trên đất nữa (không nhặt lại được).
          if (holder.get(a.object) !== actor) issues.push({ path, message: `"${actor}" is not holding "${a.object}" – pick it up before "stow"` });
          else holder.delete(a.object);
          break;
        case "trip":
          if (location.get(a.object) !== scene.id) issues.push({ path, message: `"${a.object}" is not lying in scene "${scene.id}" – you can only trip over an object on the ground` });
          break;
      }
    });
  });
  return { states, issues };
}

/** Nhân vật AI được chọn: có hoạt ảnh idle, không phải cá (không có bối cảnh dưới nước). */
export function castable(registry: Registry) {
  return registry.assets.filter((a) => a.type === "character" && a.clipAliases.idle && !a.tags.includes("fish") && !a.tags.includes("sea"));
}

export interface StoryIssue {
  path: string;
  message: string;
}

/** Kiểm tra Story với Registry. Rỗng = hợp lệ. Thông điệp bằng tiếng Anh để gửi lại cho AI sửa. */
/** Nhân vật người dùng chọn trước khi sinh kịch bản (AI phải dùng đúng những nhân vật này). */
export const RequestedCharacterSchema = z.object({
  asset: z.string().min(1),
  /** Tên / vai mong muốn (vd. "Cáo mẹ"); bỏ trống = AI tự đặt. */
  name: z.string().trim().max(60).optional(),
});
export type RequestedCharacter = z.infer<typeof RequestedCharacterSchema>;

/** Kịch bản có dùng đúng (và chỉ) các nhân vật được chọn không. Thông điệp tiếng Anh để gửi lại cho AI. */
export function checkCast(story: Story, cast: readonly RequestedCharacter[]): StoryIssue[] {
  const issues: StoryIssue[] = [];
  const remaining = story.characters.map((c) => c.asset);
  cast.forEach((want, i) => {
    const at = remaining.indexOf(want.asset);
    if (at < 0) issues.push({ path: "characters", message: `the reviewer chose "${want.asset}"${want.name ? ` (${want.name})` : ""} – it must be one of the characters (requested #${i + 1})` });
    else remaining.splice(at, 1);
  });
  for (const extra of remaining) issues.push({ path: "characters", message: `"${extra}" was not chosen by the reviewer – use only the chosen characters` });
  return issues;
}

export interface CheckOptions {
  /** Bắt buộc cùng phong cách (AI tự chọn nhân vật). Người dùng tự chọn / đổi nhân vật thì không ép. */
  strictStyle?: boolean;
  /** Nhân vật người dùng đã chọn. */
  cast?: readonly RequestedCharacter[];
}

export function checkStory(input: unknown, registry: Registry, opts: CheckOptions = {}): { story?: Story; issues: StoryIssue[] } {
  const parsed = StorySchema.safeParse(input);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const story = parsed.data;
  const issues: StoryIssue[] = [];
  const cast = new Set(castable(registry).map((a) => a.id));

  const ids = new Set<string>();
  story.characters.forEach((c, i) => {
    if (ids.has(c.id)) issues.push({ path: `characters.${i}.id`, message: `duplicate character id "${c.id}"` });
    ids.add(c.id);
    if (!cast.has(c.asset)) issues.push({ path: `characters.${i}.asset`, message: `"${c.asset}" is not an available character asset id` });
    for (const l of story.languages) if (!c.name[l]) issues.push({ path: `characters.${i}.name.${l}`, message: `missing ${LANGUAGES[l].english} name` });
  });

  const styles = new Set(story.characters.map((c) => characterStyle(findAsset(registry, c.asset))));
  if (opts.strictStyle && styles.size > 1) {
    issues.push({ path: "characters", message: `do not mix art styles: use only "cube" characters or only "lowpoly" characters (see the style column)` });
  }

  const sceneIds = new Set<string>();
  const lineIds = new Set<string>();
  story.scenes.forEach((scene, si) => {
    const at = `scenes.${si}`;
    if (sceneIds.has(scene.id)) issues.push({ path: `${at}.id`, message: `duplicate scene id "${scene.id}"` });
    sceneIds.add(scene.id);
    const env = findAsset(registry, scene.environment);
    if (!env || env.type !== "environment") issues.push({ path: `${at}.environment`, message: `"${scene.environment}" is not an available environment id` });

    const present = new Set<string>();
    scene.cast.forEach((c, ci) => {
      if (!ids.has(c)) issues.push({ path: `${at}.cast.${ci}`, message: `"${c}" is not a character id from "characters"` });
      if (present.has(c)) issues.push({ path: `${at}.cast.${ci}`, message: `"${c}" listed twice` });
      present.add(c);
    });

    scene.lines.forEach((line, i) => {
      const lp = `${at}.lines.${i}`;
      if (lineIds.has(line.id)) issues.push({ path: `${lp}.id`, message: `duplicate line id "${line.id}" (line ids must be unique across all scenes)` });
      lineIds.add(line.id);
      if (line.speaker !== null && !ids.has(line.speaker)) issues.push({ path: `${lp}.speaker`, message: `speaker "${line.speaker}" is not a character id (use null for narrator)` });
      else if (line.speaker !== null && !present.has(line.speaker)) issues.push({ path: `${lp}.speaker`, message: `speaker "${line.speaker}" is not in this scene's "cast"` });
      for (const l of story.languages) if (!line.text[l]) issues.push({ path: `${lp}.text.${l}`, message: `missing ${LANGUAGES[l].english} text` });
      if (line.to && (!present.has(line.to) || line.to === line.speaker)) issues.push({ path: `${lp}.to`, message: `"to" must be another character in this scene's cast` });
      const it = line.interaction;
      if (it) {
        const ip = `${lp}.interaction`;
        const actor = it.by ?? line.speaker;
        if (line.action) issues.push({ path: ip, message: `a line has either "action" or "interaction", not both` });
        if (!actor) issues.push({ path: ip, message: `narrator lines cannot interact – set "by" to a character` });
        else if (!present.has(actor)) issues.push({ path: ip, message: `"${actor}" is not in this scene's cast` });
        if (it.with !== null && (!present.has(it.with) || it.with === actor)) issues.push({ path: `${ip}.with`, message: `"with" must be another character in this scene's cast` });
        if (INTERACTIONS_WITH.includes(it.type) && it.with === null) issues.push({ path: `${ip}.with`, message: `"${it.type}" needs "with": the other character` });
        if (it.type === "leave" && i !== scene.lines.length - 1) issues.push({ path: ip, message: `"leave" is only allowed on the last line of a scene` });
      }
      if (line.then && !line.action && !line.interaction) issues.push({ path: `${lp}.then`, message: `"then" only applies to a line with an "action" or "interaction" – use null` });
      if (line.then === "leave") {
        // Đã ra khỏi cảnh → không được nói / làm / được nhắc tới ở các câu sau của cảnh này.
        const gone = lineActor(line);
        const later = gone ? scene.lines.slice(i + 1).findIndex((l) => l.speaker === gone || lineActor(l) === gone || l.to === gone || l.action?.to === gone || l.interaction?.with === gone) : -1;
        if (later >= 0) issues.push({ path: `${lp}.then`, message: `"${gone}" leaves the scene after this line but appears again in line ${i + 1 + later + 1} of this scene – use "stay"/"return", or remove them from the later lines` });
      }
    });
  });
  const total = allLines(story).length;
  if (total < 2 || total > MAX_LINES) issues.push({ path: "scenes", message: `the story must have 2–${MAX_LINES} lines in total (has ${total})` });

  const kinds = new Set(availableObjectKinds(registry));
  const objectIds = new Set<string>();
  story.objects.forEach((o, i) => {
    const at = `objects.${i}`;
    if (objectIds.has(o.id)) issues.push({ path: `${at}.id`, message: `duplicate object id "${o.id}"` });
    objectIds.add(o.id);
    if (!kinds.has(o.kind)) issues.push({ path: `${at}.kind`, message: `"${o.kind}" is not an available object kind` });
    if ((o.scene === null) === (o.heldBy === null)) issues.push({ path: at, message: `set exactly one of "scene" (where it lies at the start) or "heldBy"` });
    if (o.scene !== null && !sceneIds.has(o.scene)) issues.push({ path: `${at}.scene`, message: `"${o.scene}" is not a scene id` });
    if (o.heldBy !== null && !ids.has(o.heldBy)) issues.push({ path: `${at}.heldBy`, message: `"${o.heldBy}" is not a character id` });
    for (const l of story.languages) if (!o.name[l]) issues.push({ path: `${at}.name.${l}`, message: `missing ${LANGUAGES[l].english} name` });
  });
  if (!issues.length) issues.push(...simulateObjects(story).issues);
  if (opts.cast?.length) issues.push(...checkCast(story, opts.cast));
  return { story: issues.length ? undefined : story, issues };
}

/** Cử chỉ nhân vật thực sự làm được (có clip thật, không phải clip dự phòng về Idle). */
export function supportedGestures(registry: Registry, assetId: string): string[] {
  const a = findAsset(registry, assetId);
  if (!a) return [];
  return GESTURES.filter((g) => {
    const clip = resolveClip(a, g);
    return clip !== undefined && clip !== a.clipAliases.idle;
  });
}
