/**
 * Tải một DANH SÁCH CHỌN LỌC hoạt ảnh Mixamo (không tải cả kho) bằng phiên đăng nhập Adobe của chính người dùng.
 *
 *   npx tsx scripts/mixamo/download.ts [--out D:/Mixamo] [--browser msedge|chrome|chromium] [--character <uuid>] [--only walk,run]
 *
 * - Mở Chromium (hồ sơ riêng ở <out>/.profile để lần sau khỏi đăng nhập lại). Người dùng TỰ đăng nhập Mixamo trong
 *   cửa sổ đó; script không đọc hay lưu mật khẩu, chỉ dùng phiên đã đăng nhập để gọi các API mà trang web tự gọi.
 * - Mỗi mục: tìm theo từ khoá → chọn kết quả khớp tên nhất → xuất FBX (không kèm da / nhân vật, 30 fps, tại chỗ)
 *   → tải về <out>/<id>.fbx. Kết quả + tên thật trên Mixamo ghi vào <out>/manifest.json.
 * - File gốc Mixamo chỉ để trên máy (không đưa vào repo): điều khoản Adobe cho dùng trong sản phẩm hoàn chỉnh,
 *   cấm phát tán lại file gốc.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "D:/Mixamo" },
    character: { type: "string" },
    only: { type: "string" },
    /** msedge (mặc định) | chrome | chromium */
    browser: { type: "string", default: "msedge" },
  },
});
const OUT = resolve(values.out!);

/** id (tên file) → từ khoá tìm (thử lần lượt) + có giữ tại chỗ không. */
interface Want {
  id: string;
  queries: string[];
  inplace?: boolean;
}
const LIST: Want[] = [
  // đứng yên
  { id: "idle_breathing", queries: ["Breathing Idle"] },
  { id: "idle_happy", queries: ["Happy Idle"] },
  { id: "idle_sad", queries: ["Sad Idle"] },
  { id: "idle_bored", queries: ["Bored"] },
  { id: "idle_look_around", queries: ["Looking Around", "Look Around"] },
  { id: "idle_nervous", queries: ["Nervously Look Around", "Nervous"] },
  // di chuyển (tại chỗ – engine tự di chuyển nhân vật)
  { id: "walk", queries: ["Walking"], inplace: true },
  { id: "walk_happy", queries: ["Happy Walk"], inplace: true },
  { id: "walk_sad", queries: ["Sad Walk"], inplace: true },
  { id: "walk_sneak", queries: ["Sneak Walk", "Sneaking Forward"], inplace: true },
  { id: "walk_swagger", queries: ["Swagger Walk", "Catwalk Walk"], inplace: true },
  { id: "walk_backward", queries: ["Walking Backwards"], inplace: true },
  { id: "run", queries: ["Running"], inplace: true },
  { id: "run_jog", queries: ["Jogging"], inplace: true },
  { id: "run_scared", queries: ["Run Scared", "Scared Run", "Running Scared"], inplace: true },
  { id: "skip", queries: ["Skipping"], inplace: true },
  // nói chuyện / cử chỉ
  { id: "talk", queries: ["Talking"] },
  { id: "talk_explain", queries: ["Explaining", "Having A Meeting"] },
  { id: "talk_argue", queries: ["Arguing"] },
  { id: "agree", queries: ["Agreeing"] },
  { id: "yes", queries: ["Head Nod Yes"] },
  { id: "no", queries: ["Shaking Head No"] },
  { id: "wave", queries: ["Waving"] },
  { id: "point", queries: ["Pointing"] },
  { id: "clap", queries: ["Clapping"] },
  { id: "thumbsup", queries: ["Thumbs Up"] },
  { id: "shrug", queries: ["Shrugging"] },
  { id: "think", queries: ["Thinking"] },
  { id: "head_scratch", queries: ["Scratching Head", "Head Scratch"] },
  { id: "arms_crossed", queries: ["Arms Crossed", "Crossed Arms"] },
  // nói chuyện / trình bày một vấn đề (các bản "Talking" khác nhau: mục sau bỏ qua bản mục trước đã lấy)
  { id: "talk_2", queries: ["Talking"] },
  { id: "talk_3", queries: ["Talking"] },
  { id: "talk_4", queries: ["Talking"] },
  { id: "talk_meeting", queries: ["Having A Meeting", "Meeting"] },
  { id: "talk_secret", queries: ["Telling A Secret", "Whispering"] },
  { id: "talk_ask", queries: ["Asking Question", "Asking A Question", "Questioning"] },
  { id: "talk_phone", queries: ["Talking On Phone", "Phone Call"] },
  { id: "hand_raise", queries: ["Hand Raising", "Raising Hand"] },
  { id: "count", queries: ["Counting"] },
  { id: "point_forward", queries: ["Pointing Forward", "Pointing Gesture"] },
  { id: "nod_thoughtful", queries: ["Thoughtful Head Nod", "Lengthy Head Nod"] },
  { id: "nod_hard", queries: ["Hard Head Nod", "Head Nod"] },
  { id: "shake_thoughtful", queries: ["Thoughtful Head Shake"] },
  { id: "shake_annoyed", queries: ["Annoyed Head Shake"] },
  { id: "acknowledge", queries: ["Acknowledging"] },
  { id: "dismiss", queries: ["Dismissing Gesture", "Whatever Gesture"] },
  { id: "look_away", queries: ["Look Away Gesture"] },
  { id: "disappointed", queries: ["Disappointed"] },
  { id: "yelling", queries: ["Yelling"] },
  { id: "reacting", queries: ["Reacting"] },
  { id: "cocky", queries: ["Being Cocky"] },
  { id: "rallying", queries: ["Rallying"] },
  { id: "handshake", queries: ["Shaking Hands", "Handshake"] },
  // cảm xúc
  { id: "laugh", queries: ["Laughing"] },
  { id: "cry", queries: ["Crying"] },
  { id: "angry", queries: ["Angry Gesture", "Angry"] },
  { id: "surprised", queries: ["Surprised"] },
  { id: "scared", queries: ["Terrified", "Scared"] },
  { id: "relieved", queries: ["Relieved Sigh"] },
  { id: "excited", queries: ["Excited"] },
  { id: "cheer", queries: ["Cheering"] },
  { id: "victory", queries: ["Victory"] },
  { id: "defeat", queries: ["Defeated"] },
  // tương tác / thân mình
  { id: "pickup", queries: ["Picking Up", "Pick Up"] },
  { id: "give", queries: ["Giving", "Hand Over"] },
  { id: "receive", queries: ["Receiving", "Taking Item"] },
  { id: "hug", queries: ["Hugging", "Hug"] },
  { id: "bow", queries: ["Bowing", "Quick Formal Bow"] },
  { id: "blow_kiss", queries: ["Blow A Kiss"] },
  { id: "salute", queries: ["Salute"] },
  { id: "jump", queries: ["Jumping"], inplace: true },
  { id: "trip", queries: ["Tripping", "Stumble"], inplace: true },
  { id: "fall_getup", queries: ["Getting Up"], inplace: true },
  { id: "kneel", queries: ["Kneeling"] },
  { id: "sit_down", queries: ["Stand To Sit"] },
  { id: "sit_idle", queries: ["Sitting Idle"] },
  { id: "sit_talk", queries: ["Sitting Talking"] },
  { id: "stand_up", queries: ["Sit To Stand"] },
  { id: "sleep", queries: ["Sleeping"] },
  { id: "yawn", queries: ["Yawn", "Tired"] },
  // nhảy múa
  { id: "dance_hiphop", queries: ["Hip Hop Dancing"] },
  { id: "dance_silly", queries: ["Silly Dancing"] },
  { id: "dance_samba", queries: ["Samba Dancing"] },
  { id: "dance_chicken", queries: ["Chicken Dance"] },
  { id: "dance_swing", queries: ["Swing Dancing"] },
];

const log = (m: string) => console.log(`[mixamo] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gọi API Mixamo từ trong trang (đúng cookie / CORS như chính trang web). */
async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem("access_token");
      const res = await fetch(`https://www.mixamo.com/api/v1${path}`, {
        method: init?.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, "X-Api-Key": "mixamo2", Accept: "application/json", "Content-Type": "application/json" },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return res.json();
    },
    { path, init },
  ) as Promise<T>;
}

interface Product {
  id: string;
  name: string;
  type: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Mã sản phẩm đã loại theo từng mục (<out>/rejected.json, vd. bản "Talking" ngồi) – lần tải sau chọn bản khác. */
let REJECTED: Record<string, string[]> = {};

/** Mã sản phẩm các mục khác đã lấy (manifest) – vd. talk_2 / talk_3 cùng tìm "Talking" nhưng ra bản khác nhau. */
let TAKEN = new Set<string>();

async function pick(page: Page, w: Want): Promise<Product | undefined> {
  const skip = new Set([...(REJECTED[w.id] ?? []), ...TAKEN]);
  for (const q of w.queries) {
    const r = await api<{ results: Product[] }>(page, `/products?page=1&limit=48&order=&type=Motion&query=${encodeURIComponent(q)}`);
    const list = (r.results ?? []).filter((p) => !skip.has(p.id));
    const exact = list.find((p) => norm(p.name) === norm(q));
    // Chỉ nhận tên trùng hoặc chứa từ khoá – không lấy bừa kết quả đầu (từng ra "Hurricane Kick" khi tìm "Hug").
    const hit = exact ?? list.find((p) => norm(p.name).includes(norm(q)));
    if (hit) return hit;
  }
  return undefined;
}

async function exportOne(page: Page, character: string, product: Product, inplace: boolean): Promise<string> {
  const details = await api<{ details: { gms_hash: Record<string, unknown> & { params: [string, number][] } } }>(page, `/products/${product.id}?similar=0&character_id=${character}`);
  const g = details.details.gms_hash;
  const gms = {
    ...g,
    params: (g.params ?? []).map((p) => p[1]).join(","),
    overdrive: 0,
    "arm-space": 0,
    mirror: false,
    trim: g.trim ?? [0, 100],
    inplace: inplace && "inplace" in g ? true : Boolean(g.inplace),
  };
  await api(page, "/animations/export", {
    method: "POST",
    body: { character_id: character, gms_hash: [gms], preferences: { format: "fbx7_2019", skin: "false", fps: "30", reducekf: "0" }, product_name: product.name, type: "Motion" },
  });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const m = await api<{ status: string; job_result?: string; message?: string }>(page, `/characters/${character}/monitor`);
    if (m.status === "completed" && m.job_result) return m.job_result;
    if (m.status === "failed") throw new Error(m.message ?? "xuất thất bại");
  }
  throw new Error("quá thời gian chờ xuất");
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const manifestPath = join(OUT, "manifest.json");
  const manifest: Record<string, { name: string; productId: string; file: string; inplace: boolean }> = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
  const only = values.only ? new Set(values.only.split(",")) : undefined;
  const rejectedPath = join(OUT, "rejected.json");
  if (existsSync(rejectedPath)) REJECTED = JSON.parse(await readFile(rejectedPath, "utf8"));
  TAKEN = new Set(Object.values(manifest).map((m) => m.productId));

  // Trình duyệt thật (Edge / Chrome) + tắt cờ "đang bị tự động hoá": trang đăng nhập Adobe / Google chặn Chromium tự động.
  const ctx = await chromium.launchPersistentContext(join(OUT, `.profile-${values.browser}`), {
    headless: false,
    viewport: null,
    ...(values.browser === "chromium" ? {} : { channel: values.browser }),
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Bắt id nhân vật mà trang đang dùng (từ các request của chính trang).
  let character = values.character;
  page.on("request", (r) => {
    const m = r.url().match(/\/api\/v1\/characters\/([0-9a-f-]{36})/);
    if (m && !character) character = m[1];
  });
  await page.goto("https://www.mixamo.com/#/");
  log("Cửa sổ Chromium đã mở – hãy ĐĂNG NHẬP Mixamo trong cửa sổ đó (script chờ tối đa 15 phút).");
  for (let i = 0; !(await page.evaluate(() => !!localStorage.getItem("access_token")).catch(() => false)); i++) {
    if (i > 450) throw new Error("Hết thời gian chờ đăng nhập");
    await sleep(2000);
  }
  log("Đã đăng nhập. Chờ trang tải nhân vật mặc định…");
  for (let i = 0; !character && i < 60; i++) await sleep(1000);
  if (!character) {
    // Dự phòng: nhân vật chính của tài khoản.
    const prim = await api<{ primary_character_id?: string }>(page, "/characters/primary").catch(() => undefined);
    character = prim?.primary_character_id;
  }
  if (!character) throw new Error("Không lấy được id nhân vật – chạy lại với --character <uuid> (xem trong URL khi chọn nhân vật trên Mixamo)");
  log(`Nhân vật dùng để xuất: ${character}`);

  let ok = 0;
  const failed: string[] = [];
  for (const w of LIST) {
    if (only && !only.has(w.id)) continue;
    const file = join(OUT, `${w.id}.fbx`);
    if (manifest[w.id] && existsSync(file)) {
      log(`= ${w.id} (đã có: ${manifest[w.id]!.name})`);
      ok++;
      continue;
    }
    try {
      const product = await pick(page, w);
      if (!product) throw new Error(`không tìm thấy (${w.queries.join(" / ")})`);
      const url = await exportOne(page, character, product, !!w.inplace);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`tải file ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      manifest[w.id] = { name: product.name, productId: product.id, file: `${w.id}.fbx`, inplace: !!w.inplace };
      TAKEN.add(product.id);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      log(`✓ ${w.id} ← "${product.name}"`);
      ok++;
      await sleep(800);
    } catch (err) {
      failed.push(w.id);
      log(`✗ ${w.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`Xong: ${ok} hoạt ảnh${failed.length ? `, lỗi: ${failed.join(", ")}` : ""}. Thư mục: ${OUT}`);
  await ctx.close();
}

main().catch((err) => {
  console.error(`[mixamo] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
