import type { STANDARD_CLIPS } from "../schemas/asset.schema";

/**
 * Tên chuẩn → danh sách tên clip thật theo thứ tự ưu tiên.
 * `fallback` là PHƯƠNG ÁN DỰ PHÒNG (khác nghĩa một chút) khi model không có clip đúng – asset:add in ra để người dùng biết.
 */
export const ALIAS_CANDIDATES: Record<(typeof STANDARD_CLIPS)[number], { exact: string[]; fallback?: string[] }> = {
  idle: { exact: ["Idle", "Idle_Neutral", "Idle_Loop"], fallback: ["Flying", "Swim", "Swimming", "Swimming_Normal", "IdleHold", "Walk"] },
  walk: { exact: ["Walk", "Walking", "Walk_Loop"], fallback: ["WalkSlow"] },
  run: { exact: ["Run", "Running", "Run_Loop", "Gallop", "Sprint"], fallback: ["Swimming_Fast", "Walk", "Walking"] },
  jump: { exact: ["Jump", "WalkJump", "Jump_Start"], fallback: ["RunningJump"] },
  wave: { exact: ["Wave", "Waving"], fallback: ["Clapping", "Victory", "Yes", "Emote_Yes", "Interact_Right"] },
  yes: { exact: ["Yes", "Nod", "Emote_Yes"], fallback: ["Gesture_Positive", "Idle"] },
  no: { exact: ["No", "HeadShake", "Emote_No"], fallback: ["Gesture_Negative", "Idle"] },
  thumbsup: { exact: ["ThumbsUp", "Thumbs_Up"], fallback: ["Victory", "Clapping", "Wave", "Gesture_Positive", "Emote_Yes"] },
  dance: { exact: ["Dance", "Dancing"], fallback: ["Victory", "Clapping", "Jump"] },
  victory: { exact: ["Victory", "Cheer"], fallback: ["ThumbsUp", "Clapping", "Wave", "Jump"] },
  defeat: { exact: ["Defeat", "Sad"], fallback: ["Idle"] },
  sit: { exact: ["SitDown", "Sitting", "Sit"] },
  stand: { exact: ["StandUp", "Standing"] },
  punch: { exact: ["Punch", "Attack", "Attack_Melee_Right"] },
  hit: { exact: ["RecieveHit", "ReceiveHit", "HitRecieve", "HitReceive", "HitReact", "Hit"] },
  death: { exact: ["Death", "Die"] },
  pickup: { exact: ["PickUp", "Pickup", "Pick_Up"] },
  roll: { exact: ["Roll"] },
  clap: { exact: ["Clapping", "Clap"], fallback: ["Victory"] },
  fly: { exact: ["Flying", "Fly"] },
  swim: { exact: ["Swim", "Swimming", "Swimming_Normal"] },
  attack: { exact: ["Attack", "Bite_Front", "Bite", "Punch", "SwordSlash", "Headbutt"] },
  talk: { exact: ["Talk", "Talking"] },
  laugh: { exact: ["Laugh", "Laughing"] },
  cry: { exact: ["Cry", "Crying"] },
  angry: { exact: ["Angry", "AngryGesture"] },
  surprised: { exact: ["Surprised"] },
  scared: { exact: ["Scared", "Terrified"] },
  shrug: { exact: ["Shrug", "Shrugging"] },
  think: { exact: ["Think", "Thinking"] },
  point: { exact: ["Point", "Pointing"] },
  bow: { exact: ["Bow", "Bowing"] },
  cheer: { exact: ["Cheer", "Cheering"] },
  excited: { exact: ["Excited"] },
  blow_kiss: { exact: ["BlowKiss", "Blow_Kiss"] },
  salute: { exact: ["Salute"] },
  kneel: { exact: ["Kneel", "Kneeling"] },
  sleep: { exact: ["Sleep", "Sleeping"] },
  yawn: { exact: ["Yawn"] },
  trip: { exact: ["Trip", "Tripping"] },
  getup: { exact: ["FallGetup", "GetUp", "GettingUp"] },
  sit_idle: { exact: ["SitIdle", "SittingIdle"] },
  sit_talk: { exact: ["SitTalk", "SittingTalking"] },
  idle_happy: { exact: ["IdleHappy", "HappyIdle"] },
  idle_sad: { exact: ["IdleSad", "SadIdle"] },
  idle_bored: { exact: ["IdleBored", "Bored"] },
  walk_happy: { exact: ["WalkHappy", "HappyWalk"] },
  walk_sad: { exact: ["WalkSad", "SadWalk"] },
  sneak: { exact: ["WalkSneak", "SneakWalk", "Sneak"] },
  swagger: { exact: ["WalkSwagger", "SwaggerWalk"] },
};

/**
 * Bỏ tiền tố tên nhân vật khỏi tên clip ("Man_Walk" → "Walk", "Apatosaurus_Idle" → "Idle").
 * Chỉ bỏ khi phần lớn clip (≥ 60%) có cùng tiền tố, hoặc khi phần còn lại là tên clip quen thuộc.
 * Không đổi nếu tạo ra tên trùng.
 */
export function stripClipPrefixes(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const counts = new Map<string, number>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)_(.+)$/.exec(n);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const [prefix, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const known = new Set(Object.values(ALIAS_CANDIDATES).flatMap((c) => [...c.exact, ...(c.fallback ?? [])]));
  if (!prefix || count / names.length < 0.6 || known.has(prefix)) return [...names];
  const out = names.map((n) => {
    const m = /^([A-Za-z0-9]+)_(.+)$/.exec(n);
    if (!m) return n;
    if (m[1] === prefix || known.has(m[2]!)) return m[2]!;
    return n;
  });
  return new Set(out).size === out.length ? out : [...names];
}

/** So khớp không phân biệt hoa thường và "-"/"_" (Kenney đặt "idle", "gesture-positive"). */
const norm = (s: string) => s.toLowerCase().replace(/[-_ ]/g, "");

export function buildAliases(clips: readonly string[]): { aliases: Record<string, string>; fallbacks: string[] } {
  const aliases: Record<string, string> = {};
  const fallbacks: string[] = [];
  const byNorm = new Map<string, string>();
  for (const c of clips) if (!byNorm.has(norm(c))) byNorm.set(norm(c), c);
  const find = (cands: readonly string[] | undefined) => cands?.map((c) => clips.find((x) => x === c) ?? byNorm.get(norm(c))).find(Boolean);
  for (const [std, cand] of Object.entries(ALIAS_CANDIDATES)) {
    const exact = find(cand.exact);
    if (exact) {
      aliases[std] = exact;
      continue;
    }
    const fb = find(cand.fallback);
    if (fb) {
      aliases[std] = fb;
      fallbacks.push(`${std}→${fb}`);
    }
  }
  return { aliases, fallbacks };
}

