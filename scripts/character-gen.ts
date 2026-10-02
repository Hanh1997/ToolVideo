/**
 * Tạo nhân vật người từ mô tả (AI thiết kế → Blender dựng → thêm vào thư viện).
 *
 *   npm run character:gen -- "cô bé 7 tuổi tóc đuôi ngựa, váy hồng chấm bi, đeo ba lô vàng"
 *   npm run character:gen -- --spec my.json            (bỏ qua AI, dựng từ file mô tả)
 *   npm run character:gen -- "…" --design-only         (chỉ in bản mô tả JSON)
 *   npm run character:gen -- --spec my.json --id char_ac_gen_be_na   (dựng lại, ghi đè)
 *   npm run character:gen -- --spec docs/characters/be-ti-template.md  (file tài liệu: lấy khối ```json đầu tiên)
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { normalizeCharacterSpec } from "../src/ai/characterSpec";
import { currentJob, designCharacter, startBuild } from "../server/ai/characterGenerator";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { spec: { type: "string" }, id: { type: "string" }, "design-only": { type: "boolean" } },
});
const prompt = positionals.join(" ").trim();

let spec;
if (values.spec) {
  let text = await readFile(values.spec, "utf8");
  if (/\.md$/i.test(values.spec)) {
    const block = /```json\s*\n([\s\S]*?)```/.exec(text);
    if (!block?.[1]) throw new Error(`${values.spec}: không thấy khối \`\`\`json chứa bản mô tả nhân vật`);
    text = block[1];
  }
  const raw = JSON.parse(text) as { spec?: unknown };
  spec = normalizeCharacterSpec(raw.spec ?? raw); // nhận cả storage/characters/<id>/spec.json
} else {
  if (!prompt) throw new Error('Cần mô tả nhân vật (vd. "ông cụ hói, ria bạc, áo sơ mi trắng") hoặc --spec file.json');
  console.log("AI đang thiết kế…");
  const r = await designCharacter(prompt);
  spec = r.spec;
  if (r.note) console.log(`⚠ ${r.note}`);
}
console.log(JSON.stringify(spec, null, 2));
if (values["design-only"]) process.exit(0);

const job = await startBuild(spec, { prompt: prompt || undefined, id: values.id, onLog: (l) => console.log(`  ${l}`) });
console.log(`Dựng ${job.assetId}…`);
while (currentJob()?.status === "running") await new Promise((r) => setTimeout(r, 500));
const done = currentJob()!;
if (done.status !== "completed") {
  console.error(`✗ ${done.error ?? done.status}`);
  process.exit(1);
}
console.log(`✓ ${done.assetId} (${done.clips} động tác) – ảnh xem trước: storage/characters/${done.assetId}/preview.png`);
