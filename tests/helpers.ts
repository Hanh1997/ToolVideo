import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RegistrySchema, type Registry } from "../src/schemas/asset.schema";
import { resolveScene, type Synthesize } from "../src/tts/resolveScene";

const root = resolve(import.meta.dirname, "..");

export const registry: Registry = RegistrySchema.parse(JSON.parse(readFileSync(resolve(root, "public/assets/registry.json"), "utf8")));

/** TTS giả: 0.06s mỗi ký tự (gần tốc độ Piper), không gọi Piper. */
export const fakeTts: Synthesize = async ({ text, rate }) => ({
  file: `tts/fake_${text.length}.wav`,
  duration: Math.round(((text.length * 0.06) / rate) * 1000) / 1000,
  cached: false,
});

/** Scene demo đã resolve (TTS giả) dưới dạng JSON thô – dùng làm đầu vào cho validateScene. */
export async function resolvedDemo(project: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(readFileSync(resolve(root, "projects", project, "scene.json"), "utf8"));
  const r = await resolveScene(raw, registry, fakeTts);
  if (r.issues.length) throw new Error(JSON.stringify(r.issues));
  return r.scene as Record<string, unknown>;
}
