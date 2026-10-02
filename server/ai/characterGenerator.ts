/**
 * Tạo nhân vật người từ mô tả (dùng chung cho API Thư viện và CLI `npm run character:gen`):
 *
 *   designCharacter(prompt)            → CharacterSpec (DeepSeek viết JSON, chuẩn hoá bằng normalizeCharacterSpec)
 *   designCharacter("", {base, instruction}) → spec đã sửa theo góp ý
 *   startBuild(spec)                   → job: Blender dựng GLB + ảnh xem trước → importAssets → registry
 *
 * Blender: BLENDER_PATH (.env) hoặc tự tìm (D:/Tools/blender-*, Program Files/Blender Foundation/*, PATH).
 * Hoạt ảnh Mixamo: MIXAMO_DIR (mặc định D:/Mixamo nếu có manifest.json) – không có thì chỉ dùng hoạt ảnh tự sinh.
 * Lưu trữ: storage/characters/<id>/ (spec.json, preview.png, preview_face.png, build.log) – để sửa & dựng lại.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeCharacterSpec, specGuide, specHeight, specTags, type CharacterSpec } from "../../src/ai/characterSpec";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune, resample } from "@gltf-transform/functions";
import { ASSETS_DIR, importAssets, readRegistry, ROOT, snake, updateAsset, writeRegistry } from "../assets/importAsset";
import { chatJson, type ChatMessage } from "./deepseek";

export const CHAR_STORAGE = join(ROOT, "storage", "characters");
const SCRIPT = join(ROOT, "scripts", "blender", "gen_character.py");
/** Id nhân vật tự tạo: file GLB có hoạt ảnh Mixamo → .gitignore đã chặn char_ac_*. */
export const GEN_PREFIX = "char_ac_gen_";
export const GEN_ID = /^char_ac_gen_[a-z0-9_]+$/;
const PACK = "AutoCartoon · AI tạo nhân vật";
/** Tốc độ (m/s) của nhân vật mẫu cao 1.8 m, hông 0.86 m – co theo chiều dài chân. */
const BASE_SPEED: Record<string, number> = { Walk: 1.2, Run: 3.2, WalkSad: 0.85, WalkHappy: 1.25, WalkSneak: 0.6, WalkSwagger: 1, RunJog: 2.2 };

// ---------------------------------------------------------------- công cụ

export function findBlender(): string | undefined {
  const env = process.env.BLENDER_PATH;
  if (env) return existsSync(env) ? env : undefined;
  const exe = process.platform === "win32" ? "blender.exe" : "blender";
  for (const root of ["D:/Tools", "C:/Tools", "C:/Program Files/Blender Foundation", "D:/Program Files/Blender Foundation"]) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => /blender/i.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) if (existsSync(join(root, d, exe))) return join(root, d, exe);
  }
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["blender"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

/** Thư mục hoạt ảnh Mixamo (scripts/mixamo/download.ts) + số clip có file. */
export function mixamoLibrary(): { dir: string; clips: number } | undefined {
  const dir = process.env.MIXAMO_DIR ?? "D:/Mixamo";
  const manifest = join(dir, "manifest.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, { file: string }>;
    const clips = Object.values(m).filter((e) => existsSync(join(dir, e.file))).length;
    return clips ? { dir, clips } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- AI thiết kế

const SYSTEM = `You design 3D cartoon HUMAN characters (Pixar-like, big head, simple shapes) for a children's animation pipeline.
A procedural generator builds the model from a JSON description. Reply with ONLY a JSON object with exactly these fields:
${specGuide()}
note: optional short Vietnamese note for the user – ONLY when something in the request cannot be built (e.g. an animal, a robot,
      wings, a costume, a specific logo) and how you approximated it; otherwise omit.

Rules:
- Pick colours that match the description and look good together (clothes contrast with skin and hair).
- Infer age/gender from Vietnamese words: "bé", "em bé" → toddler/child; "cậu bé"/"cô bé" → child; "anh", "chị" → teen/adult;
  "bố", "mẹ", "cô giáo", "chú" → adult; "ông", "bà" → elder.
- Only include accessories the description implies (or that clearly fit the role: teacher → glasses, student → backpack).
- Always fill "face" so each character is recognisable by the face alone (not only by clothes / hair): combine shape, eyes,
  brows, nose, mouth, ears and cheeks to match age and personality; avoid giving every character the same defaults.`;

export interface DesignResult {
  spec: CharacterSpec;
  note?: string;
  model: string;
}

export async function designCharacter(prompt: string, opts: { base?: CharacterSpec; instruction?: string; fromBase?: boolean } = {}): Promise<DesignResult> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }];
  if (opts.base && opts.fromBase) {
    // Phát triển từ nhân vật gốc: giữ cơ thể / khuôn mặt / màu da, chỉ thêm quần áo / tóc / phụ kiện theo mô tả.
    messages.push({
      role: "user",
      content:
        `BASE character JSON (body, proportions, face, skin already approved):\n${JSON.stringify(opts.base)}\n\n` +
        `Create a NEW character developed from this base: ${opts.instruction ?? ""}\n` +
        `Keep gender, age, build, skin, eyes and face of the base unless the description clearly asks to change them. ` +
        `Give it a new Vietnamese name. Choose clothing (a real top / bottom / shoes, not "none", unless asked), hair and accessories that fit the description. Return the FULL JSON.`,
    });
  } else if (opts.base) {
    messages.push({
      role: "user",
      content: `Current character JSON:\n${JSON.stringify(opts.base)}\n\nChange request: ${opts.instruction ?? ""}\nReturn the FULL updated JSON (keep everything that is not mentioned).`,
    });
  } else {
    messages.push({ role: "user", content: `Character description: ${prompt}` });
  }
  const r = await chatJson(messages, { maxTokens: 6000, temperature: 0.7, timeoutMs: 180_000 });
  const raw = JSON.parse(r.content) as Record<string, unknown>;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
  return { spec: normalizeCharacterSpec(raw), note, model: r.model };
}

// ---------------------------------------------------------------- dựng (Blender)

export interface CharacterJob {
  id: string;
  assetId: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  step: string;
  progress: number;
  /** Số clip Mixamo sẽ chuyển sang nhân vật (0 = chỉ hoạt ảnh tự sinh). */
  mixamoClips: number;
  clips?: number;
  log: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

let job: CharacterJob | undefined;
let child: ChildProcess | undefined;

export function currentJob(): CharacterJob | undefined {
  return job;
}

export function cancelJob(): boolean {
  if (job?.status !== "running") return false;
  job.status = "cancelled";
  child?.kill();
  return true;
}

export interface SavedCharacter {
  assetId: string;
  prompt?: string;
  spec: CharacterSpec;
  updatedAt: string;
}

export async function loadSaved(assetId: string): Promise<SavedCharacter | undefined> {
  if (!GEN_ID.test(assetId)) return undefined;
  try {
    const s = JSON.parse(await readFile(join(CHAR_STORAGE, assetId, "spec.json"), "utf8")) as SavedCharacter;
    return { ...s, spec: normalizeCharacterSpec(s.spec) };
  } catch {
    return undefined;
  }
}

/** Mọi nhân vật AI đã tạo (để chọn làm gốc cho nhân vật mới). */
export async function listSaved(): Promise<SavedCharacter[]> {
  if (!existsSync(CHAR_STORAGE)) return [];
  const out: SavedCharacter[] = [];
  for (const d of readdirSync(CHAR_STORAGE)) {
    const s = await loadSaved(d);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.spec.name.localeCompare(b.spec.name, "vi"));
}

function slugify(s: string): string {
  return snake(s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")).slice(0, 30) || "nhan_vat";
}

/** Id mới (không trùng registry) – hoặc id cũ khi dựng lại nhân vật đã tạo. */
async function chooseId(spec: CharacterSpec, id?: string): Promise<string> {
  if (id) {
    if (!GEN_ID.test(id)) throw new Error(`Chỉ dựng lại được nhân vật do AI tạo (${GEN_PREFIX}…)`);
    return id;
  }
  const taken = new Set((await readRegistry()).assets.map((a) => a.id));
  const base = `${GEN_PREFIX}${slugify(spec.name)}`;
  let out = base;
  for (let i = 2; taken.has(out) || existsSync(join(CHAR_STORAGE, out)); i++) out = `${base}_${i}`;
  return out;
}

/** "STEP <việc>" của gen_character.py → (nhãn, % tiến độ); Mixamo chiếm 10 → 90 %. */
const STEPS: Record<string, [string, number]> = {
  body: ["Dựng hình + khuôn mặt + xương", 5],
  actions: ["Hoạt ảnh tự sinh", 8],
  mixamo: ["Chuyển hoạt ảnh Mixamo", 10],
  export: ["Xuất GLB", 91],
  preview: ["Ảnh xem trước", 94],
};
const NOISE = /^\d\d:\d\d:\d\d \| INFO: |^Fra:|^\s*$|^INFO (Draco|MeshOptimizer)|DeprecationWarning|use_nodes = True|FBX version|\| Saved: |^Blender (quit|\d)/;

export async function startBuild(input: unknown, o: { prompt?: string; id?: string; onLog?: (line: string) => void } = {}): Promise<CharacterJob> {
  if (job?.status === "running") throw new Error("Đang dựng nhân vật khác – chờ xong hoặc hủy");
  const blender = findBlender();
  if (!blender) throw new Error("Không tìm thấy Blender – cài Blender (≥ 4.2) hoặc đặt BLENDER_PATH trong .env");
  const spec = normalizeCharacterSpec(input);
  const assetId = await chooseId(spec, o.id);
  const dir = join(CHAR_STORAGE, assetId);
  await mkdir(dir, { recursive: true });
  const saved: SavedCharacter = { assetId, prompt: o.prompt ?? (await loadSaved(assetId))?.prompt, spec, updatedAt: new Date().toISOString() };
  await writeFile(join(dir, "spec.json"), `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  for (const f of ["preview.png", "preview_face.png"]) await rm(join(dir, f), { force: true });

  const mixamo = mixamoLibrary();
  const j: CharacterJob = {
    id: Math.random().toString(36).slice(2, 10),
    assetId,
    name: spec.name,
    status: "running",
    step: "Chuẩn bị",
    progress: 1,
    mixamoClips: mixamo?.clips ?? 0,
    log: [],
    startedAt: new Date().toISOString(),
  };
  job = j;
  void runBuild(j, blender, spec, dir, mixamo, o.onLog);
  return j;
}

async function runBuild(j: CharacterJob, blender: string, spec: CharacterSpec, dir: string, mixamo: ReturnType<typeof mixamoLibrary>, onLog?: (line: string) => void): Promise<void> {
  const glb = join(dir, "model.glb");
  const full: string[] = [];
  const log = (line: string) => {
    j.log.push(line);
    if (j.log.length > 200) j.log.splice(0, j.log.length - 200);
    onLog?.(line);
  };
  let info: { hips: number; top: number } | undefined;
  let retargeted = 0;
  try {
    await rm(glb, { force: true });
    const args = ["-b", "--factory-startup", "--python-exit-code", "1", "-P", SCRIPT, "--", "--spec", join(dir, "spec.json"), "--out", glb, "--preview", join(dir, "preview.png")];
    if (mixamo) args.push("--mixamo", mixamo.dir);
    const code = await new Promise<number | null>((done) => {
      const c = spawn(blender, args, { cwd: ROOT, windowsHide: true });
      child = c;
      let rest = "";
      const onData = (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const line of lines) {
          full.push(line);
          if (NOISE.test(line)) continue;
          const stepM = /^STEP (\w+)/.exec(line);
          if (stepM) {
            [j.step, j.progress] = STEPS[stepM[1]!] ?? [stepM[1]!, j.progress];
          } else if (/^RETARGET/.test(line)) {
            retargeted++;
            j.step = `Chuyển hoạt ảnh Mixamo (${retargeted}/${j.mixamoClips})`;
            j.progress = Math.round(10 + (80 * retargeted) / Math.max(1, j.mixamoClips));
          } else if (line.startsWith("INFO {")) {
            info = JSON.parse(line.slice(5)) as typeof info;
            continue;
          }
          log(line);
        }
      };
      c.stdout.on("data", onData);
      c.stderr.on("data", onData);
      c.on("error", (err) => {
        log(`✗ ${err.message}`);
        done(-1);
      });
      c.on("close", (code) => done(code));
    });
    child = undefined;
    await writeFile(join(dir, "build.log"), full.join("\n"), "utf8");
    if (j.status === "cancelled") return;
    if (code !== 0 || !existsSync(glb)) throw new Error(full.filter((l) => /Error|Traceback|line \d+/.test(l)).slice(-4).join(" · ") || `Blender thoát mã ${code}`);

    j.step = "Thêm vào thư viện";
    j.progress = 97;
    const height = specHeight(spec);
    const [result] = await importAssets([glb], {
      type: "character",
      id: j.assetId,
      name: spec.name,
      height,
      headingOffset: 0,
      tags: specTags(spec),
      pack: PACK,
      license: mixamo ? "Adobe-Mixamo" : "Proprietary-Owned",
      author: mixamo ? "AutoCartoon – AI tạo (hoạt ảnh: Adobe Mixamo)" : "AutoCartoon – AI tạo",
      source: `scripts/blender/gen_character.py${mixamo ? " + https://www.mixamo.com (dùng trong video; không phát tán lại file gốc)" : ""}`,
    });
    const entry = result!.entry;
    // Tốc độ đi / chạy theo chiều dài chân (trẻ em bước ngắn → đi chậm hơn, không trượt chân).
    const reg = await readRegistry();
    const e = reg.assets.find((a) => a.id === j.assetId);
    if (e) {
      const ratio = info ? ((info.hips / info.top) * height) / 0.86 : height / 1.8;
      e.suggestedSpeed = Object.fromEntries(Object.entries(BASE_SPEED).filter(([c]) => e.clips.includes(c)).map(([c, v]) => [c, Math.round(v * ratio * 100) / 100]));
      await writeRegistry(reg);
    }
    if (!mixamo) await updateAsset(j.assetId, { attributionRequired: false });
    await rm(glb, { force: true }); // bản chính đã nằm ở public/assets/characters
    // 30 xương ngón × ~50 clip Mixamo: bỏ khung hình thừa (đốt ngón gần như đứng yên) → file nhẹ hơn nhiều, chuyển
    // động giữ nguyên (sai số 1e-4).
    const out = join(ASSETS_DIR, entry.file);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(out);
    await doc.transform(resample(), prune());
    await io.write(out, doc);
    j.clips = entry.clips.length;
    j.step = "Xong";
    j.progress = 100;
    j.status = "completed";
    log(`✓ ${entry.id} – ${entry.clips.length} động tác, cao ${height} m`);
  } catch (err) {
    if (j.status !== "cancelled") {
      j.status = "failed";
      j.error = err instanceof Error ? err.message : String(err);
      log(`✗ ${j.error}`);
    }
  } finally {
    child = undefined;
    j.finishedAt = new Date().toISOString();
  }
}
