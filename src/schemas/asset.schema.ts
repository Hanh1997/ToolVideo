import { z } from "zod";

export const AssetTypeSchema = z.enum(["character", "environment", "prop", "audio", "voice"]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetEntrySchema = z.object({
  id: z.string().min(1),
  type: AssetTypeSchema,
  name: z.string().min(1),
  /** Đường dẫn tương đối với /assets/ */
  file: z.string().min(1),
  /** Chiều cao chuẩn hóa (mét). Bỏ trống = giữ kích thước gốc × scale. */
  height: z.number().positive().optional(),
  /** Hệ số tỷ lệ khi không đặt height (giữ tỷ lệ tương đối giữa các món trong một gói). */
  scale: z.number().positive().optional(),
  /** Nhãn để lọc trong Thư viện (tree, rock, flower, dinosaur…). */
  tags: z.array(z.string()).default([]),
  /** Gói nguồn (vd. "Quaternius · Ultimate Nature"). */
  pack: z.string().optional(),
  /** Bù hướng mặt (độ) nếu model không nhìn về +Z. */
  headingOffset: z.number().default(0),
  defaultClip: z.string().optional(),
  clips: z.array(z.string()).default([]),
  /**
   * Tên clip chuẩn → clip thật trong file (vd. "walk" → "Walking").
   * Template/AI dùng tên chuẩn → đổi nhân vật không phải sửa kịch bản.
   */
  clipAliases: z.record(z.string(), z.string()).default({}),
  suggestedSpeed: z.record(z.string(), z.number().positive()).default({}),
  rootMotion: z.enum(["none", "strip"]).default("none"),
  /**
   * Nhân vật: điểm cầm đồ vật (ghi đè dò tự động). `node` = tên xương/node trong model,
   * `offset` = lệch thêm (mét, theo hướng nhân vật: x trái, y lên, z trước).
   */
  holdPoints: z
    .object({
      hand: z.object({ node: z.string().min(1), offset: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]) }).optional(),
      mouth: z.object({ node: z.string().min(1), offset: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]) }).optional(),
    })
    .optional(),
  /** Đồ vật: chiều cao (mét) khi được cầm – mặc định bằng kích thước khi đặt trong cảnh. */
  holdHeight: z.number().positive().optional(),
  /**
   * Nhân vật: kích thước chiếm chỗ (mét, ở chiều cao chuẩn hóa, theo hướng mặt): mũi → tâm (front),
   * tâm → đuôi (back), nửa bề ngang (side). Dùng để đứng sát mà không lồng vào nhau (ôm, đập tay, trao đồ).
   */
  footprint: z.object({ front: z.number().min(0), back: z.number().min(0), side: z.number().min(0) }).optional(),
  /** Độ dài file audio (giây) – bắt buộc với asset audio. */
  duration: z.number().positive().optional(),
  /** Voice: engine TTS. `file` là model, tương đối với tools/tts-voices/. */
  provider: z.enum(["piper", "vieneu"]).optional(),
  /** Voice (vieneu): tên giọng mẫu có sẵn của VieNeu-TTS (vd. "Kim Thanh"). */
  preset: z.string().optional(),
  language: z.string().optional(),
  /** Voice: tốc độ đọc mặc định (1 = gốc, < 1 chậm hơn). */
  defaultRate: z.number().min(0.5).max(2).optional(),
  /** Voice: đổi cao độ (nửa cung, âm = trầm) sau khi TTS – tạo giọng riêng cho từng nhân vật. */
  pitch: z.number().min(-12).max(12).optional(),
  /** Voice: speaker id trong model nhiều giọng. */
  speaker: z.number().int().min(0).optional(),
  /** Voice: khi đổi cao độ – "preserved" giữ âm sắc tự nhiên (không "chíp chíp"), "shifted" (mặc định) đổi theo. */
  formant: z.enum(["shifted", "preserved"]).optional(),
  /** Voice (Piper): độ biểu cảm ngữ điệu (mặc định model ~0.667) và độ co giãn độ dài âm (~0.8). */
  noiseScale: z.number().min(0).max(2).optional(),
  noiseW: z.number().min(0).max(2).optional(),
  /** Voice: chuỗi bộ lọc âm thanh ffmpeg thêm sau cùng (EQ ấm, bớt chói, nén nhẹ…). */
  filter: z.string().optional(),
  license: z.string().min(1),
  author: z.string().min(1),
  source: z.string().min(1),
  commercialUse: z.boolean(),
  attributionRequired: z.boolean(),
})
  .refine((a) => a.type !== "audio" || a.duration !== undefined, {
    message: "asset audio cần trường duration (giây)",
    path: ["duration"],
  })
  .refine((a) => a.type !== "voice" || a.provider !== undefined, {
    message: "asset voice cần trường provider",
    path: ["provider"],
  });
export type AssetEntry = z.infer<typeof AssetEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(1),
  assets: z.array(AssetEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

/** License được phép dùng thương mại trong MVP. */
export const COMMERCIAL_LICENSES: ReadonlySet<string> = new Set([
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "MIT",
  "Apache-2.0",
  "Proprietary-Owned",
  // Nhân vật / hoạt ảnh Adobe Mixamo: miễn phí bản quyền, dùng thương mại trong sản phẩm hoàn chỉnh (video);
  // KHÔNG phát tán lại file gốc (FBX / GLB) dưới dạng asset.
  "Adobe-Mixamo",
]);

/** Tên clip chuẩn dùng chung mọi nhân vật (xem clipAliases). */
export const STANDARD_CLIPS = [
  "idle", "walk", "run", "jump", "wave", "yes", "no", "thumbsup", "dance", "victory",
  "defeat", "sit", "stand", "punch", "hit", "death", "pickup", "roll",
  "clap", "fly", "swim", "attack",
  // cử chỉ / cảm xúc / biến thể (bộ Mixamo – xem scripts/mixamo/download.ts)
  "talk", "laugh", "cry", "angry", "surprised", "scared", "shrug", "think", "point", "bow", "cheer", "excited",
  "blow_kiss", "salute", "kneel", "sleep", "yawn", "trip", "getup", "sit_idle", "sit_talk",
  "idle_happy", "idle_sad", "idle_bored", "walk_happy", "walk_sad", "sneak", "swagger",
] as const;

/** Tên clip thật của asset cho một tên (thật hoặc chuẩn); undefined nếu không có. */
export function resolveClip(asset: AssetEntry, name: string): string | undefined {
  if (asset.clips.includes(name)) return name;
  const target = asset.clipAliases[name];
  return target && asset.clips.includes(target) ? target : undefined;
}

export function findAsset(registry: Registry, id: string): AssetEntry | undefined {
  return registry.assets.find((a) => a.id === id);
}
