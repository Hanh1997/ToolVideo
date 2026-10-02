import { z } from "zod";

// Zod 4: z.number() đã loại Infinity/NaN
const finite = z.number();

export const Vec3Schema = z.object({ x: finite, y: finite, z: finite });
export const Vec2Schema = z.object({ x: finite, z: finite });
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Vec2 = z.infer<typeof Vec2Schema>;

const id = z.string().regex(/^[A-Za-z0-9_-]+$/, "id chỉ gồm chữ, số, '_' hoặc '-'");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "màu dạng #rrggbb");

export const FixedShotSchema = z.object({
  mode: z.literal("fixed"),
  position: Vec3Schema,
  lookAt: Vec3Schema,
  fov: z.number().min(10).max(120).default(50),
});

export const FollowShotSchema = z.object({
  mode: z.literal("follow"),
  target: id,
  offset: Vec3Schema,
  lookAtOffset: Vec3Schema.default({ x: 0, y: 1, z: 0 }),
  /** true: offset xoay theo hướng nhân vật */
  relative: z.boolean().default(false),
  fov: z.number().min(10).max(120).default(50),
});

export const CameraShotSchema = z.discriminatedUnion("mode", [FixedShotSchema, FollowShotSchema]);
export type CameraShot = z.infer<typeof CameraShotSchema>;

const timing = {
  id,
  start: z.number().min(0),
  duration: z.number().positive(),
};

export const AnimationActionSchema = z.object({
  ...timing,
  type: z.literal("animation"),
  target: id,
  clip: z.string().min(1),
  loop: z.boolean().default(true),
  speed: z.number().positive().default(1),
  fade: z.number().min(0).default(0.25),
});

export const MoveDirectionSchema = z.enum(["forward", "backward", "left", "right"]);
export type MoveDirection = z.infer<typeof MoveDirectionSchema>;

export const MoveActionSchema = z.object({
  ...timing,
  type: z.literal("move"),
  target: id,
  direction: MoveDirectionSchema,
  speed: z.number().min(0),
  /** Mặc định: true, riêng "backward" là false */
  face: z.boolean().optional(),
});

export const MoveToActionSchema = z.object({
  ...timing,
  type: z.literal("moveTo"),
  target: id,
  to: Vec2Schema,
  face: z.boolean().default(true),
});

export const PathActionSchema = z.object({
  ...timing,
  type: z.literal("path"),
  target: id,
  points: z.array(Vec2Schema).min(1),
  face: z.boolean().default(true),
});

export const TurnActionSchema = z
  .object({
    ...timing,
    type: z.literal("turn"),
    target: id,
    heading: finite.optional(),
    by: finite.optional(),
  })
  .refine((a) => (a.heading === undefined) !== (a.by === undefined), {
    message: "turn cần đúng một trong hai: 'heading' hoặc 'by'",
  });

export const JumpActionSchema = z.object({
  ...timing,
  type: z.literal("jump"),
  target: id,
  height: z.number().positive().default(1),
});

/** Chuyển động chậm của camera trong suốt shot (ease in-out theo thời lượng action). */
export const CameraMoveSchema = z.object({
  /** Tỷ lệ tiến lại gần điểm nhìn (0.1 = gần hơn 10%; âm = lùi ra). */
  dolly: z.number().min(-1).max(0.9).default(0),
  /** Xoay quanh điểm nhìn (độ, dương = sang trái). */
  pan: z.number().min(-180).max(180).default(0),
  /** Nâng camera (mét). */
  rise: z.number().min(-5).max(5).default(0),
});
export type CameraMove = z.infer<typeof CameraMoveSchema>;

/** Động tác tay (nhân vật có xương tay), cộng lên hoạt ảnh đang chạy – xem engine/ArmPose. */
export const ARM_POSES = ["hug", "reach", "highfive", "pat"] as const;
export type ArmPose = (typeof ARM_POSES)[number];
export const PoseActionSchema = z.object({
  ...timing,
  type: z.literal("pose"),
  target: id,
  pose: z.enum(ARM_POSES),
});
export type PoseAction = z.infer<typeof PoseActionSchema>;

export const CameraActionSchema = z.object({
  ...timing,
  type: z.literal("camera"),
  shot: CameraShotSchema,
  /** Giây chuyển mượt từ camera trước sang shot này (0 = cắt). */
  blend: z.number().min(0).max(10).default(0),
  move: CameraMoveSchema.optional(),
});

// ---------------------------------------------------------------- tương tác với đồ vật
// Sự kiện tức thời trên một đồ vật (target = id trong props), có hiệu lực từ `start`.
// `duration` chỉ để hiển thị trên timeline.

/** Điểm cầm: tay (người, robot…), miệng/đầu (con vật), auto = tay nếu có, không thì miệng. */
export const HOLD_POINTS = ["auto", "hand", "mouth"] as const;
export const HoldPointSchema = z.enum(HOLD_POINTS);
export type HoldPoint = z.infer<typeof HoldPointSchema>;

const instant = {
  id,
  start: z.number().min(0),
  duration: z.number().positive().default(0.25),
};

/** Gắn đồ vật vào nhân vật: đồ vật đi theo tay/miệng (kể cả khi đang có hoạt ảnh). Gắn sang người khác = trao tay. */
export const AttachActionSchema = z.object({
  ...instant,
  type: z.literal("attach"),
  target: id,
  to: id,
  point: HoldPointSchema.default("auto"),
});

/** Đặt đồ vật xuống: tại `at`, hoặc trước mặt người đang cầm (mặt đất). */
export const DropActionSchema = z.object({
  ...instant,
  type: z.literal("drop"),
  target: id,
  at: Vec3Schema.optional(),
});

export const ShowActionSchema = z.object({ ...instant, type: z.literal("show"), target: id });
export const HideActionSchema = z.object({ ...instant, type: z.literal("hide"), target: id });

export const ActionSchema = z.discriminatedUnion("type", [
  AnimationActionSchema,
  MoveActionSchema,
  MoveToActionSchema,
  PathActionSchema,
  TurnActionSchema,
  JumpActionSchema,
  PoseActionSchema,
  CameraActionSchema,
  AttachActionSchema,
  DropActionSchema,
  ShowActionSchema,
  HideActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;
export type AnimationAction = z.infer<typeof AnimationActionSchema>;
export type MoveAction = z.infer<typeof MoveActionSchema>;
export type MoveToAction = z.infer<typeof MoveToActionSchema>;
export type PathAction = z.infer<typeof PathActionSchema>;
export type TurnAction = z.infer<typeof TurnActionSchema>;
export type JumpAction = z.infer<typeof JumpActionSchema>;
export type CameraAction = z.infer<typeof CameraActionSchema>;
export type AttachAction = z.infer<typeof AttachActionSchema>;
export type DropAction = z.infer<typeof DropActionSchema>;
export type MotionAction = MoveAction | MoveToAction | PathAction | TurnAction;
export type PropAction = AttachAction | DropAction | z.infer<typeof ShowActionSchema> | z.infer<typeof HideActionSchema>;
/** Action trên nhân vật (target = id nhân vật). */
export type CharacterAction = Exclude<Action, CameraAction | PropAction>;
export type TargetedAction = Exclude<Action, CameraAction>;

export const PROP_ACTION_TYPES = ["attach", "drop", "show", "hide"] as const;

export function isPropAction(a: Action): a is PropAction {
  return (PROP_ACTION_TYPES as readonly string[]).includes(a.type);
}

const even = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .refine((n) => n % 2 === 0, "kích thước phải là số chẵn (yêu cầu của H.264 yuv420p)");

const placedObject = {
  id,
  asset: z.string().min(1),
  position: Vec3Schema,
  heading: finite.default(0),
  scale: z.number().positive().default(1),
};

export const SceneCharacterSchema = z.object({
  ...placedObject,
  /** Giọng đọc mặc định (asset loại "voice") cho lời thoại của nhân vật. */
  voice: z.string().min(1).optional(),
  /** Tên hiển thị (phụ đề khi showSpeaker), vd. "Bác Gấu Trúc". */
  name: z.string().min(1).max(40).optional(),
});
export type SceneCharacter = z.infer<typeof SceneCharacterSchema>;

export const ScenePropSchema = z.object({
  ...placedObject,
  /** false = ẩn lúc đầu (hiện bằng action "show", vd. bông hoa vừa ngắt). */
  visible: z.boolean().default(true),
});
export type SceneProp = z.infer<typeof ScenePropSchema>;

export const AudioKindSchema = z.enum(["music", "sfx", "voice"]);
export type AudioKind = z.infer<typeof AudioKindSchema>;

export const AudioTrackSchema = z.object({
  id,
  kind: AudioKindSchema,
  asset: z.string().min(1),
  /** Thời điểm bắt đầu phát trong video (giây). */
  start: z.number().min(0),
  /** Độ dài phát (giây). Bỏ trống: hết file (loop: tới cuối video). */
  duration: z.number().positive().optional(),
  /** Bỏ qua đoạn đầu file (giây). */
  trimStart: z.number().min(0).default(0),
  volume: z.number().min(0).max(4).default(1),
  loop: z.boolean().default(false),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

/** Cảm xúc của câu thoại → tư thế khi nói (engine/Speech) + tốc độ đọc. */
export const EMOTIONS = ["neutral", "happy", "sad", "surprised", "angry", "scared"] as const;
export const EmotionSchema = z.enum(EMOTIONS);
export type Emotion = z.infer<typeof EmotionSchema>;

/**
 * Câu thoại ĐÃ RESOLVE (start/duration/file là số/đường dẫn cụ thể).
 * Bản soạn thảo (start "after", thiếu duration/file) được resolver chuyển sang dạng này.
 */
export const DialogueLineSchema = z.object({
  id,
  /** Nhân vật nói (id trong characters). Bỏ trống = người dẫn chuyện. */
  speaker: id.optional(),
  /** Người được nói với (id nhân vật) – người nói quay về phía họ. Bỏ trống = tự đoán (người đáp lời / người vừa nói). */
  to: id.optional(),
  text: z.string().min(1).max(1000),
  start: z.number().min(0),
  duration: z.number().positive(),
  /** File audio TTS, tương đối với /assets/ */
  file: z.string().min(1),
  voice: z.string().min(1),
  rate: z.number().min(0.5).max(2).default(1),
  volume: z.number().min(0).max(4).default(1),
  /** Lệch trái (-1) / phải (1); bỏ trống = giữa. */
  pan: z.number().min(-1).max(1).optional(),
  subtitle: z.boolean().default(true),
  emotion: EmotionSchema.default("neutral"),
  /** Độ to giọng theo thời gian (0..1, 25 mẫu/giây) – nhép miệng / nhún khi nói. Do resolver điền từ file TTS. */
  lipsync: z.array(z.number().min(0).max(1)).optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

export const SubtitleStyleSchema = z.object({
  /** Vẽ phụ đề lên hình (preview + video). File .srt và track phụ đề mềm luôn được tạo. */
  burnIn: z.boolean().default(false),
  /** Cỡ chữ theo tỷ lệ chiều cao khung hình. */
  size: z.number().min(0.02).max(0.12).default(0.05),
  position: z.enum(["bottom", "top"]).default("bottom"),
  showSpeaker: z.boolean().default(false),
});
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

export const MixSchema = z.object({
  /** Tự giảm nhạc nền khi có lời thoại. */
  duckMusic: z.boolean().default(true),
  /** Hệ số âm lượng nhạc nền khi đang có lời thoại. */
  duckLevel: z.number().min(0).max(1).default(0.3),
  /** Thời gian chuyển (giây). */
  duckRamp: z.number().min(0.01).max(2).default(0.25),
  /** Chuẩn hóa độ to (LUFS) khi render. null = tắt. */
  loudness: z.number().min(-40).max(-5).nullable().default(-14),
});
export type MixSettings = z.infer<typeof MixSchema>;

/**
 * Chữ lớn phủ lên hình: "title" = tên phim lúc mở đầu, "credits" = danh sách cuối phim (nền tối dần).
 * `at: "end"` → hiện `duration` giây cuối cùng của scene (không cần biết trước độ dài khi soạn).
 */
export const TitleCardSchema = z.object({
  kind: z.enum(["title", "credits"]),
  text: z.string().min(1).max(200),
  /** Dòng phụ (title) / các dòng danh sách (credits). */
  lines: z.array(z.string().min(1).max(200)).max(12).default([]),
  at: z.enum(["start", "end"]).default("start"),
  /** Giây, tính từ đầu scene (at "start") – bỏ qua khi at "end". */
  start: z.number().min(0).default(0),
  duration: z.number().positive().max(30),
});
export type TitleCard = z.infer<typeof TitleCardSchema>;

export const LIGHTING_PRESETS = ["day", "morning", "sunset", "overcast", "snow", "night", "indoor", "indoor_night"] as const;
export type LightingPreset = (typeof LIGHTING_PRESETS)[number];

export const LightingSchema = z.object({
  /** Thời điểm / thời tiết: màu nắng, độ cao mặt trời, ánh sáng trời, chỉnh màu. */
  preset: z.enum(LIGHTING_PRESETS).default("day"),
  /** Hướng nắng (độ, 0 = từ phía +Z). Bỏ trống = lệch 35° so với camera chính của cảnh. */
  sunAzimuth: z.number().optional(),
  /** Bóng tiếp xúc (ambient occlusion). */
  ao: z.boolean().default(true),
});
export type Lighting = z.infer<typeof LightingSchema>;

/** Hiệu ứng hạt (thời tiết / không khí) của bối cảnh. */
export const WEATHER_EFFECTS = ["snow", "rain", "leaves", "petals", "butterflies", "fireflies"] as const;
export type WeatherEffect = (typeof WEATHER_EFFECTS)[number];

export const SceneScriptSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    name: z.string().min(1),
    duration: z.number().positive().max(600),
    fps: z.number().int().min(1).max(60),
    width: even,
    height: even,
    commercial: z.boolean().default(false),
  }),
  environment: z.object({
    asset: z.string().min(1),
    background: color.optional(),
    fog: z
      .object({ color: color.optional(), near: z.number().min(0), far: z.number().positive() })
      .optional(),
    lighting: LightingSchema.default({ preset: "day", ao: true }),
    effects: z.array(z.enum(WEATHER_EFFECTS)).max(3).default([]),
  }),
  characters: z.array(SceneCharacterSchema),
  props: z.array(ScenePropSchema).default([]),
  camera: CameraShotSchema,
  actions: z.array(ActionSchema),
  audio: z.array(AudioTrackSchema).default([]),
  dialogue: z.array(DialogueLineSchema).default([]),
  subtitles: SubtitleStyleSchema.default({ burnIn: false, size: 0.05, position: "bottom", showSpeaker: false }),
  titles: z.array(TitleCardSchema).max(4).default([]),
  mix: MixSchema.default({ duckMusic: true, duckLevel: 0.3, duckRamp: 0.25, loudness: -14 }),
});

export type SceneScript = z.infer<typeof SceneScriptSchema>;

export const MOTION_TYPES = ["move", "moveTo", "path", "turn"] as const;

export function isMotionAction(a: Action): a is MotionAction {
  return (MOTION_TYPES as readonly string[]).includes(a.type);
}
