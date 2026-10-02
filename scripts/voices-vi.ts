/**
 * Giọng tiếng Việt dùng VieNeu-TTS (offline, Apache-2.0, https://github.com/pnnbao97/VieNeu-TTS):
 * một giọng nữ đọc truyện nhẹ nhàng (Kim Thanh) cho mẹ / dẫn chuyện, các vai bé / con vật nhỏ nâng cao độ
 * từ cùng giọng đó (cả phim một chất giọng), giọng nam Đức Trí cho bố / ông.
 *
 *   npx tsx scripts/voices-vi.ts
 *
 * Cần: .venv/Scripts/pip install vieneu (model tự tải về tools/tts-voices/vieneu lần đầu).
 */
import { AssetEntrySchema } from "../src/schemas/asset.schema";
import { readRegistry, writeRegistry } from "../server/assets/importAsset";

/** Chống vỡ tiếng khi nâng cao độ. */
const LIMIT = "alimiter=limit=0.9";

const VOICES = [
  { id: "voice_vi_female", name: "Nữ đọc truyện – Kim Thanh (VieNeu)", preset: "Kim Thanh" },
  { id: "voice_vi_soft", name: "Nữ nhẹ nhàng (mẹ, cô giáo, dẫn chuyện) – Kim Thanh (VieNeu)", preset: "Kim Thanh" },
  { id: "voice_vi_cute", name: "Bé dễ thương (bé gái, bé nhỏ) – Kim Thanh +4 (VieNeu)", preset: "Kim Thanh", pitch: 4 },
  { id: "voice_vi_child", name: "Trẻ em (bé lớn, bé trai) – Kim Thanh +3 (VieNeu)", preset: "Kim Thanh", pitch: 3 },
  { id: "voice_vi_squeaky", name: "Con vật nhỏ – Kim Thanh +6 (VieNeu)", preset: "Kim Thanh", pitch: 6 },
  { id: "voice_vi_warm", name: "Nam ấm áp (bố, ông hiền) – Đức Trí (VieNeu)", preset: "Đức Trí" },
  { id: "voice_vi_low", name: "Nam trẻ – Đức Trí (VieNeu)", preset: "Đức Trí", pitch: 1 },
  { id: "voice_vi_deep", name: "Nam trầm (ông, con vật to) – Đức Trí -3 (VieNeu)", preset: "Đức Trí", pitch: -3 },
] as const;

const registry = await readRegistry();
for (const v of VOICES) {
  const entry = AssetEntrySchema.parse({
    id: v.id,
    type: "voice",
    name: v.name,
    file: "vieneu",
    tags: ["voice", "vieneu"],
    provider: "vieneu",
    preset: v.preset,
    language: "vi-VN",
    defaultRate: 1,
    ...("pitch" in v ? { pitch: v.pitch, formant: "shifted" } : {}),
    filter: LIMIT,
    license: "Apache-2.0",
    author: "VieNeu-TTS (pnnbao97)",
    source: "https://github.com/pnnbao97/VieNeu-TTS",
    commercialUse: true,
    attributionRequired: false,
  });
  const i = registry.assets.findIndex((a) => a.id === v.id);
  if (i >= 0) registry.assets[i] = entry;
  else registry.assets.push(entry);
  console.log(`✓ ${v.id.padEnd(18)} ${v.name}`);
}
await writeRegistry(registry);
