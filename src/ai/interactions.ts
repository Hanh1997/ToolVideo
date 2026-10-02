import { DROP_DISTANCE } from "../engine/PropEngine";
import { findAsset, resolveClip, type AssetEntry, type Registry } from "../schemas/asset.schema";
import { OBJECT_KINDS } from "./objects";
import { afterMove, simulateObjects, type Story, type StoryCharacter } from "./story";

/** Âm lượng bước chân theo cỡ nhân vật (giống buildScene). */
const stepVolume = (h: number) => Math.round(Math.min(0.5, Math.max(0.12, 0.08 + 0.2 * h)) * 100) / 100;

/**
 * Tương tác với đồ vật cho buildScene: đặt đồ vật vào cảnh và sinh chuỗi action cho từng câu có `action`.
 *
 *   pickup: đi tới → quay vào → cúi nhặt (đồ vật gắn vào tay/miệng) → quay về chỗ đứng, vẫn cầm
 *   give:   đi tới người nhận → trao (đồ vật sang tay/miệng người nhận) → người nhận cảm ơn → quay về
 *   drop:   cúi xuống, đặt trước mặt
 *   stow:   mang món đang cầm tới hộp đồ chơi → cúi bỏ vào hộp → quay về (hộp tự đặt vào cảnh khi có câu "stow")
 *   trip:   chạy ngang → vấp món đang nằm dưới đất: chúi người bật lên, loạng choạng, ngã sấp ("oái!") → đứng dậy đi về
 *
 * Tương tác giữa hai nhân vật (line.interaction):
 *   hug:      đi tới sát người kia → hai người cùng nhún (ôm) → quay về
 *   highfive: đi tới → cùng bật nhảy, "bốp" ở đỉnh → quay về
 *   pat:      đi tới → nhún nhẹ ba lần (vỗ vai), người kia gật → quay về
 *   leave:    trong lúc nói câu cuối cảnh, người nói (+ with / cả nhóm) cùng đi ra khỏi khung hình
 *   play:     chạy một vòng phía trước nhóm rồi nhảy cẫng hai cái; có with → người kia đuổi theo sau nửa giây
 *   walk:     đi tới đứng cạnh người kia (đổi chỗ đứng), quay vào nhau rồi nói
 *
 * Sau câu (line.then, xem afterMove): return = đi về chỗ cũ; stay = đứng lại chỗ vừa tới, quay ra phía trước
 * (thành chỗ đứng mới cho các câu sau – camera, bước lại gần, tương tác kế tiếp đều tính từ đây; đứng đè lên
 * người khác → tự về chỗ cũ); leave = đi ra khỏi cảnh ngay sau câu.
 *
 * Mọi action gắn với câu thoại bằng `sync` offset âm → diễn ra NGAY TRƯỚC câu; `busy` = thời gian câu phải lùi lại.
 * Cắt tắt đoạn đi: người làm rảnh ở hai câu trước → bắt đầu đi ngay từ cuối câu trước (không chờ khoảng lặng);
 * "walk" → nói luôn khi sắp tới nơi. Camera khi đi: quay ngang theo hướng đi (thấy mặt nghiêng, không thấy lưng);
 * nhặt / trao: chèn cảnh cận món đồ đúng lúc cúi nhặt / trao tay.
 * Người làm NÓI NGAY TẠI CHỖ vừa tới (cạnh người kia / món đồ); đi về chỗ cũ SAU câu (sync "end") – trừ khi câu kế
 * cũng do người đó làm (đi thẳng từ chỗ đang đứng) hoặc là câu cuối cảnh. `displaced` = chỗ đứng khi nói (camera
 * hai người); `after` = câu kế phải chờ thêm bấy lâu (khi câu kế liên quan tới người đang đi về).
 */

export interface Placed {
  c: StoryCharacter;
  asset: AssetEntry | undefined;
  h: number;
  x: number;
  z: number;
  heading: number;
}

/** Chỗ người làm đứng khi nói câu (sau khi đi tới) + điểm cần cùng lọt khung (người kia / món đồ). */
/** Vị trí + hướng đứng của một nhân vật. */
export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export interface Displaced {
  actor: string;
  at: { x: number; z: number };
  focus: { x: number; z: number };
}

export interface StageArea {
  center: { x: number; z: number };
  halfWidth: number;
  /** "back" = lối đi dọc (ra/vào phía sau), "sides" = hai bên. */
  entrance?: "back" | "sides";
  /** Cửa ra vào (trong nhà) + hướng đi ra ngoài. */
  exit?: { x: number; z: number; out: { x: number; z: number } };
  /** Chỗ đặt hộp đồ chơi (câu "stow"); bỏ trống = cạnh nhóm. */
  toyBox?: { x: number; z: number };
}

/** Độ dài động tác cúi nhặt / trao (giây) và thời điểm đồ vật đổi chỗ trong động tác. */
const PICK = 1.3;
const PICK_AT = 0.55;
const TURN = 0.3;
/** Nói xong bao lâu thì bắt đầu đi về chỗ cũ (giây). */
const POST_DELAY = 0.2;
/**
 * Khe hở giữa mũi hai người khi chạm nhau (mét, cộng thêm vào kích thước thật – không lồng vào nhau)
 * và thời gian giữ động tác.
 */
const TOUCH_GAP = { hug: 0.06, highfive: 0.22, pat: 0.1 } as const;
/** Hộp đồ chơi (Kenney Furniture Kit, thùng mở nắp): bán kính miệng hộp và độ cao đồ vật nằm trong hộp. */
const TOY_BOX = "prop_fk_cardboard_box_open";
const TOY_BOX_R = 0.25;
const TOY_BOX_FLOOR = 0.18;
/** Cất rác (mọi món cất trong cảnh đều là trash_*): thùng rác công viên thay cho hộp đồ chơi – gốc cao 1.14 m, rộng
 *  1 m → thu còn ~0.63 m cho vừa trẻ em; rác thả vào miệng thùng rồi ẩn (nằm trong thùng). */
const TRASH_BIN = "prop_park_trashcan";
const TRASH_BIN_SCALE = 0.55;
const TRASH_BIN_R = 0.28;
const TRASH_BIN_TOP = 0.6;
/** Vị trí lệch nhẹ của từng món trong hộp (không chồng khít lên nhau). */
const IN_BOX = [
  { x: -0.07, z: 0.04 },
  { x: 0.08, z: -0.05 },
  { x: 0.02, z: 0.08 },
  { x: -0.05, z: -0.07 },
];
/** Khe hở khi trao đồ và khi bước lại gần người nghe. */
const GIVE_GAP = 0.18;
export const TALK_GAP = 0.35;
const TOUCH_HOLD = { hug: 1.3, highfive: 1.0, pat: 1.2 } as const;
/** Vị trí cụm quanh món được nhặt (bụi hoa, cụm nấm…), nhân với groundScale. */
const CLUSTER_RING = [
  { x: 0.5, z: 0.35 },
  { x: -0.45, z: 0.45 },
  { x: 0.1, z: 0.7 },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const headingOf = (dx: number, dz: number) => r2((Math.atan2(dx, dz) * 180) / Math.PI);

/** Clip cúi xuống: pickup (người), eat (thú Kenney); không có → undefined (chỉ đứng). */
function pickClip(asset: AssetEntry | undefined): string | undefined {
  if (!asset) return undefined;
  return resolveClip(asset, "pickup") ?? (asset.clips.includes("eat") ? "eat" : undefined);
}

/** Clip trao đồ: thú cúi đầu (eat); người: giơ ngón cái / gật nếu có clip thật. */
function giveClip(asset: AssetEntry | undefined): string | undefined {
  if (!asset) return undefined;
  if (asset.clips.includes("eat")) return "eat";
  return ["thumbsup", "yes"].find((g) => {
    const c = resolveClip(asset, g);
    return c !== undefined && c !== asset.clipAliases.idle;
  });
}

/**
 * Kích thước chiếm chỗ (mét) theo hướng mặt: front = mũi → tâm, back = tâm → đuôi, side = nửa bề ngang.
 * Theo footprint trong Registry (nhân với cỡ nhân vật); thiếu → ước lượng theo chiều cao.
 */
export function extent(p: Pick<Placed, "asset" | "h">, part: "front" | "back" | "side"): number {
  const fp = p.asset?.footprint;
  if (!fp) return (part === "side" ? 0.3 : 0.4) * p.h;
  return fp[part] * (p.h / (p.asset?.height ?? p.h));
}

/**
 * Bán kính thân (m) để tránh va chạm: bề ngang footprint của người đo ở tư thế dang tay (chữ T) nên giới hạn theo
 * chiều cao; con vật bốn chân dài theo thân → lấy thêm chiều trước / sau.
 */
export function bodyRadius(p: Pick<Placed, "asset" | "h">): number {
  return Math.max(Math.min(extent(p, "side"), 0.25 * p.h), Math.min(extent(p, "front"), extent(p, "back")));
}

/** Khoảng cách giữa tâm hai người đứng đối mặt, mũi cách nhau `gap`. */
export const faceToFace = (a: Pick<Placed, "asset" | "h">, b: Pick<Placed, "asset" | "h">, gap: number) => extent(a, "front") + extent(b, "front") + gap;

/** Dáng đi theo cảm xúc (nếu nhân vật có clip): buồn → đi buồn, vui → đi vui; còn lại / không có → đi thường. */
export function walkClip(p: Pick<Placed, "asset">, emotion?: string): string {
  const want = emotion === "sad" ? "walk_sad" : emotion === "happy" ? "walk_happy" : undefined;
  return want && p.asset && resolveClip(p.asset, want) ? want : "walk";
}

function walkSpeed(p: Placed, clip = "walk"): number {
  const walk = p.asset ? resolveClip(p.asset, clip) : undefined;
  return (walk && p.asset?.suggestedSpeed[walk]) || (clip === "walk_sad" ? 0.85 : 1.2);
}

/** Clip chạy (nếu có), không thì đi. */
function runClip(p: Placed): string | undefined {
  if (!p.asset) return undefined;
  return resolveClip(p.asset, "run") ? "run" : resolveClip(p.asset, "walk") ? "walk" : undefined;
}

/** Tốc độ chạy trong cảnh (chậm hơn tốc độ chạy thật một chút cho dễ nhìn). */
function runSpeed(p: Placed): number {
  const run = p.asset ? resolveClip(p.asset, "run") : undefined;
  return 0.75 * ((run && p.asset?.suggestedSpeed[run]) || walkSpeed(p) * 2);
}

const pathLength = (from: { x: number; z: number }, pts: readonly { x: number; z: number }[]) =>
  pts.reduce((acc, q, i) => acc + Math.hypot(q.x - (i ? pts[i - 1]! : from).x, q.z - (i ? pts[i - 1]! : from).z), 0);

export function buildInteractions(
  story: Story,
  index: number,
  byId: ReadonlyMap<string, Placed>,
  stage: StageArea,
  groupWidth: number,
  registry: Registry,
  actions: Record<string, unknown>[],
  audio: Record<string, unknown>[],
  /** Tiếng bước chân lặp (sfx_steps_*_loop) cho các đoạn đi; undefined = không có. */
  stepsAsset?: string,
  /** Điểm cả nhóm cùng hướng về (người đứng lại chỗ mới quay về phía này); bỏ trống = trước nhóm 2.5 m. */
  facePoint?: { x: number; z: number },
): {
  props: Record<string, unknown>[];
  busy: Map<string, number>;
  leaving: Set<string>;
  displaced: Map<string, Displaced>;
  after: Map<string, number>;
  /** Chỗ đứng của từng nhân vật trong lúc nói mỗi câu (theo id câu) – đổi khi có người đứng lại chỗ mới. */
  stands: Map<string, Map<string, Pose>>;
  camEarly: Map<string, number>;
} {
  const sc = story.scenes[index]!;
  const state = simulateObjects(story).states[index]!;
  const props: Record<string, unknown>[] = [];
  const busy = new Map<string, number>();
  const leaving = new Set<string>();
  const displaced = new Map<string, Displaced>();
  const after = new Map<string, number>();
  /** Camera của câu vào sớm hơn bấy nhiêu giây (đoạn đi quá ngắn, không cắt riêng). */
  const camEarly = new Map<string, number>();
  /** Vị trí hiện tại của người chưa về chỗ (làm liên tiếp nhiều việc). */
  const pos = new Map<string, { x: number; z: number; heading: number }>();
  const actorOf = (l: (typeof sc.lines)[number] | undefined) => (l && (l.action || l.interaction) ? ((l.action ? l.action.by : l.interaction!.by) ?? l.speaker ?? undefined) : undefined);
  /** Câu có dính tới nhân vật `id` không (nói, làm, nhận, cùng tương tác). */
  const involves = (l: (typeof sc.lines)[number] | undefined, id: string) =>
    !!l && (l.speaker === id || actorOf(l) === id || l.action?.to === id || l.interaction?.with === id || (l.interaction?.type === "leave" && !l.interaction.with));
  const endingDance = index === story.scenes.length - 1 && story.ending !== "none";
  const ground = new Map<string, { x: number; z: number }>();
  const kindOf = (id: string) => OBJECT_KINDS[story.objects.find((o) => o.id === id)?.kind ?? ""];
  const { x: cx, z: cz } = stage.center;
  const face = facePoint ?? { x: cx, z: cz - 2.5 };
  /** Chỗ đứng hiện tại (đổi khi "stay"); người đã rời cảnh bị xoá. */
  const home = new Map<string, Pose>([...byId.values()].map((p) => [p.c.id, { x: p.x, z: p.z, heading: p.heading }]));
  const stands = new Map<string, Map<string, Pose>>();
  /** Nhân vật ở chỗ đứng hiện tại (x, z, heading theo home). */
  const at = (p: Placed): Placed => {
    const h = home.get(p.c.id);
    return h ? { ...p, ...h } : p;
  };
  /** Khoảng cách tâm tối thiểu để `who` đứng / đi ngang qua `q` mà không chạm. */
  const clearance = (who: Placed, q: Placed) => bodyRadius(who) + bodyRadius(q) + 0.15;
  /** Những người đang đứng trong cảnh (trừ `who` và `except`) kèm chỗ đứng hiện tại. */
  const others = (who: Placed, except: readonly string[]) =>
    [...byId.values()].flatMap((q) => {
      const h = q.c.id === who.c.id || except.includes(q.c.id) ? undefined : home.get(q.c.id);
      return h ? [{ q, h }] : [];
    });
  /** Chỗ đứng mới có đè lên người khác không (trừ người làm và người cùng tương tác). */
  const crowded = (spot: { x: number; z: number }, who: Placed, except: readonly string[]) =>
    others(who, except).some(({ q, h }) => Math.hypot(h.x - spot.x, h.z - spot.z) < clearance(who, q));
  /**
   * Đường đi from → to không xuyên qua người khác: gặp ai chắn trên đường thẳng thì vòng qua bên ngắn hơn
   * (ngang nhau → phía sau, xa camera, không che mặt người đang đứng). Trả về các điểm đi qua, điểm cuối là `to`.
   */
  const route = (who: Placed, from: { x: number; z: number }, to: { x: number; z: number }, except: readonly string[]) => {
    const pts: { x: number; z: number }[] = [];
    let a = from;
    for (let k = 0; k < 3; k++) {
      const dx = to.x - a.x;
      const dz = to.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) break;
      const u = { x: dx / len, z: dz / len };
      let hit: { t: number; h: Pose; clear: number } | undefined;
      for (const { q, h } of others(who, except)) {
        const t = ((h.x - a.x) * u.x + (h.z - a.z) * u.z) / len;
        if (t <= 0.02 || t >= 0.98) continue;
        const d = Math.abs((h.x - a.x) * u.z - (h.z - a.z) * u.x);
        const clear = clearance(who, q);
        if (d < clear && (!hit || t < hit.t)) hit = { t, h, clear };
      }
      if (!hit) break;
      const h = hit.h;
      const c = hit.clear * 1.15;
      const cost = (w: { x: number; z: number }) => Math.hypot(w.x - a.x, w.z - a.z) + Math.hypot(to.x - w.x, to.z - w.z) - 0.2 * (w.z - h.z);
      const [left, right] = [1, -1].map((sg) => ({ x: r2(h.x - u.z * sg * c), z: r2(h.z + u.x * sg * c) }));
      a = cost(left!) <= cost(right!) ? left! : right!;
      pts.push(a);
    }
    pts.push(to);
    return pts;
  };

  // Nằm trên đất: hai bên nhóm, hơi lên phía trước; đặt về phía người sẽ nhặt nó.
  const perSide: Record<string, number> = { left: 0, right: 0 };
  [...state.lying].forEach((oid, k) => {
    const kind = kindOf(oid);
    if (!kind) return;
    const picker = sc.lines.find((l) => (l.action?.type === "pickup" || l.action?.type === "trip") && l.action.object === oid);
    const actor = picker && byId.get(picker.action!.by ?? picker.speaker ?? "");
    const side = actor ? (actor.x >= cx ? 1 : -1) : k % 2 ? 1 : -1;
    const key = side > 0 ? "right" : "left";
    const slot = perSide[key]!;
    perSide[key] = slot + 1;
    const x = r2(cx + side * Math.min(groupWidth / 2 + 1.3 + 0.8 * slot, stage.halfWidth + 0.9));
    const z = r2(cz - 1 - 0.9 * slot);
    ground.set(oid, { x, z });
    props.push({ id: oid, asset: kind.asset, position: { x, y: 0, z }, heading: 25 * k, scale: kind.groundScale });
    kind.cluster?.forEach((asset, j) => {
      const o = CLUSTER_RING[j % CLUSTER_RING.length]!;
      const s = kind.groundScale;
      props.push({ id: `${oid}_c${j}`, asset, position: { x: r2(x + o.x * s * side), y: 0, z: r2(z + o.z * s) }, heading: 60 * j + 15, scale: s });
    });
  });

  // Hộp đồ chơi: chỉ khi có câu "stow"; mỗi món cất vào nằm lệch nhau một chút trong hộp.
  const stows = sc.lines.filter((l) => l.action?.type === "stow");
  const trashBin = stows.length > 0 && stows.every((l) => story.objects.find((o) => o.id === l.action!.object)?.kind.startsWith("trash_")) && findAsset(registry, TRASH_BIN)?.type === "prop";
  const toyBox =
    stows.length > 0 && findAsset(registry, trashBin ? TRASH_BIN : TOY_BOX)?.type === "prop"
      ? (stage.toyBox ?? { x: r2(cx - (groupWidth / 2 + 1.6)), z: r2(cz + 0.6) })
      : undefined;
  if (toyBox) {
    props.push(
      trashBin
        ? { id: "trashbin", asset: TRASH_BIN, position: { x: toyBox.x, y: 0, z: toyBox.z }, heading: 12, scale: TRASH_BIN_SCALE }
        : { id: "toybox", asset: TOY_BOX, position: { x: toyBox.x, y: 0, z: toyBox.z }, heading: 12 },
    );
  }
  let stowed = 0;

  // Đang được cầm từ cảnh trước: gắn ngay từ đầu (đi vào cảnh cùng người cầm).
  for (const [oid, holder] of state.heldBy) {
    const kind = kindOf(oid);
    const p = byId.get(holder);
    if (!kind || !p) continue;
    props.push({ id: oid, asset: kind.asset, position: { x: p.x, y: 0, z: p.z }, scale: kind.groundScale });
    actions.push({ id: `hold_${oid}`, type: "attach", target: oid, to: holder, start: 0 });
  }

  const has = (id: string) => findAsset(registry, id)?.type === "audio";
  /** Biến thể âm thanh theo tiền tố (sfx_pluck_0, sfx_pluck_1…), chọn tất định theo `seed`. */
  const variant = (prefix: string, seed: number): string | undefined => {
    const list = registry.assets.filter((x) => x.type === "audio" && x.id.startsWith(prefix)).map((x) => x.id).sort();
    return list.length ? list[seed % list.length] : undefined;
  };
  /** Đường ra khỏi cảnh từ chỗ `p` đang đứng: trong nhà qua cửa, ngoài trời về phía sau / sang một bên. */
  /** `lane` = làn đi riêng khi cả nhóm cùng rời (ngoài trời): z (ra hai bên) hoặc x (ra phía sau) – không đi đè lên nhau. */
  const exitLegs = (p: Pick<Placed, "asset" | "h" | "x" | "z">, side: number, k: number, lane?: number): { x: number; z: number }[] =>
    stage.exit
      ? // Trong nhà: tới trước ô cửa (xếp hàng một) rồi đi ra ngoài.
        [
          { x: r2(stage.exit.x - stage.exit.out.x * (0.9 + extent(p, "front"))), z: r2(stage.exit.z - stage.exit.out.z * (0.9 + extent(p, "front"))) },
          { x: r2(stage.exit.x + stage.exit.out.x * 2.5), z: r2(stage.exit.z + stage.exit.out.z * 2.5) },
        ]
      : [stage.entrance === "back" ? { x: r2(lane ?? p.x * 0.6 + cx * 0.4), z: r2(p.z + 4.5) } : { x: r2(cx + side * (stage.halfWidth + 3)), z: r2(lane ?? p.z + 0.3 * k) }];

  let lineNo = 0;
  for (const [li, line] of sc.lines.entries()) {
    // Chỗ đứng khi nói câu này: chỗ hiện tại (người đang làm liên tiếp: chỗ vừa tới); người làm câu này ghi đè bên dưới.
    const snap = new Map([...home].map(([id, h]) => [id, pos.get(id) ?? h]));
    stands.set(line.id, snap);
    const a = line.action ?? undefined;
    const it = a ? undefined : (line.interaction ?? undefined);
    if (!a && !it) continue;
    const actorBase = byId.get((a ? a.by : it!.by) ?? line.speaker ?? "");
    if (!actorBase || !home.has(actorBase.c.id)) continue;
    const actor = at(actorBase);
    const tag = `${line.id}_${a ? a.type : it!.type}`;
    /** Mốc của phần diễn ra TRƯỚC câu: câu âm thanh không lời (nếu có) đứng ngay trước câu chính. */
    const pre = line.vocal && line.speaker ? `${line.id}_v` : line.id;
    if (it?.type === "leave") {
      // Cùng rời đi trong lúc nói: đi về một phía (lối đi dọc: về phía sau), người đi sau lệch nửa bước.
      const partner = it.with ? byId.get(it.with) : undefined;
      const group = (it.with ? [actorBase, ...(partner ? [partner] : [])] : [...byId.values()]).filter((p) => home.has(p.c.id)).map(at);
      const side = actor.x >= cx ? 1 : -1;
      // Ai gần lối ra đi trước; người sau đi làn phía sau (xa camera), cách ~0.9 m → không vượt ngang trước mặt bạn.
      // Ra phía sau (lối đi dọc): mỗi người một làn theo x, giữ thứ tự đang đứng.
      const exitX = cx + side * (stage.halfWidth + 3);
      const queue = stage.exit || stage.entrance === "back" ? group : [...group].sort((a, b) => Math.abs(exitX - a.x) - Math.abs(exitX - b.x));
      const byX = [...group].sort((a, b) => a.x - b.x);
      const midX = group.reduce((s, p) => s + p.x, 0) / group.length;
      const laneOf = (p: Placed): number | undefined => {
        if (group.length < 2) return undefined;
        if (stage.entrance === "back") return midX + (byX.indexOf(p) - (group.length - 1) / 2) * 1.0;
        return queue[0]!.z + queue.indexOf(p) * 0.9;
      };
      queue.forEach((p, k) => {
        const at = r2(0.4 + 0.35 * k);
        const walks = p.asset && resolveClip(p.asset, "walk");
        const legs = exitLegs(p, side, k, stage.exit ? undefined : laneOf(p));
        let from = { x: p.x, z: p.z };
        let t = at;
        legs.forEach((to, j) => {
          const w = r2(Math.min(4, Math.hypot(to.x - from.x, to.z - from.z) / walkSpeed(p)));
          actions.push({ id: `${tag}_${p.c.id}_move${j ? j : ""}`, type: "moveTo", target: p.c.id, to, sync: { line: line.id, offset: r2(t), duration: w } });
          t += w;
          from = to;
        });
        const w = r2(t - at);
        if (walks) actions.push({ id: `${tag}_${p.c.id}_walk`, type: "animation", target: p.c.id, clip: "walk", sync: { line: line.id, offset: at, duration: w } });
        if (walks && stepsAsset) audio.push({ id: `${tag}_${p.c.id}_steps`, kind: "sfx", asset: stepsAsset, loop: true, duration: w, volume: stepVolume(p.h), fadeOut: 0.3, sync: { line: line.id, at: "start", offset: at } });
        leaving.add(p.c.id);
      });
      continue;
    }
    const origin = { x: actor.x, z: actor.z };
    // Đang đứng chỗ khác (việc trước chưa về) → đi tiếp từ đó.
    const cur = pos.get(actor.c.id);
    const start = cur ? { x: cur.x, z: cur.z } : origin;
    pos.delete(actor.c.id);
    const next = sc.lines[li + 1];
    const then = afterMove(line);
    /** Câu kế cũng do người này làm → không về chỗ, đi thẳng từ đây. Câu cuối cảnh → đứng lại (trừ khi rời cảnh). */
    const chain = then !== "leave" && actorOf(next) === actor.c.id && next?.interaction?.type !== "play";
    const stay = chain || (then !== "leave" && li === sc.lines.length - 1);
    /** Các bước: thời điểm tương đối với đầu tương tác. */
    const steps: { at: number; action: Record<string, unknown> }[] = [];
    /** Sau câu: thời điểm tương đối với lúc câu kết thúc. */
    const post: { at: number; action: Record<string, unknown> }[] = [];
    const postWalk: { at: number; duration: number; id: string }[] = [];
    let spot: { x: number; z: number; heading: number } | undefined;
    let focus: { x: number; z: number } | undefined;
    let partnerBack: Placed | undefined;
    const walkSounds: { at: number; duration: number; id: string }[] = [];
    const sounds: { at: number; asset: string | undefined; volume: number }[] = [];
    let total: number;
    const seed = lineNo++;
    /** Thời gian đi tới + hướng đi (camera quay ngang theo). */
    let goTime = 0;
    let goDir: { x: number; z: number } | undefined;
    /** Cảnh chèn (cận món đồ) trong lúc tương tác: thời điểm tương đối với đầu tương tác. */
    let insert: { at: number; duration: number; shot: Record<string, unknown> } | undefined;
    /** Lúc chạm nhau / trao đồ (thời điểm tương đối với đầu tương tác): khung hai người quay ngang. */
    let contact: { at: number; shot: Record<string, unknown> } | undefined;
    /**
     * Khung hai người nhìn ngang trục nối hai người (thấy mặt nghiêng của cả hai, không ai quay lưng vào máy): máy đặt
     * vuông góc với trục, về phía camera chính; `tight` = cận tay (trao đồ).
     */
    const sideShot = (a: { x: number; z: number }, b: { x: number; z: number }, hMax: number, tight = false) => {
      const ax = b.x - a.x;
      const az = b.z - a.z;
      const span = Math.hypot(ax, az) || 1;
      const n = ax >= 0 ? { x: az / span, z: -ax / span } : { x: -az / span, z: ax / span }; // vuông góc, n.z ≤ 0
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const d = tight ? 1 + 0.75 * hMax : 1.4 + 1.3 * hMax + 0.6 * span;
      const z = Math.max(m.z + n.z * d, cz - stage.halfWidth - 6);
      return {
        mode: "fixed",
        position: { x: r2(m.x + n.x * d), y: r2(tight ? 0.35 + 0.45 * hMax : 0.45 + 0.75 * hMax), z: r2(z) },
        lookAt: { x: r2(m.x), y: r2((tight ? 0.4 : 0.5) * hMax), z: r2(m.z) },
        fov: tight ? 40 : 45,
      };
    };
    /** Cảnh cận thấp vào điểm `p` (món đồ / chỗ trao tay), máy đặt phía camera chính, lệch về giữa bối cảnh. */
    const closeUp = (p: { x: number; z: number }, y: number, dist: number) => {
      const side = p.x >= cx ? -1 : 1;
      return { mode: "fixed", position: { x: r2(p.x + side * dist * 0.45), y: r2(y + 0.35 * dist), z: r2(p.z - dist) }, lookAt: { x: r2(p.x), y: r2(y), z: r2(p.z) }, fov: 38 };
    };

    /** Người cùng tương tác: được phép đi sát tới (không tính là vật cản). */
    let ignore: string[] = [];
    /** Đi tới `to` (vòng qua người chắn đường); trả về thời gian đi. */
    const wclip = walkClip(actor, line.emotion);
    const walkTo = (to: { x: number; z: number }, from: { x: number; z: number }, at: number, id: string, into = steps, sounds_ = walkSounds): number => {
      let t = 0;
      let a = from;
      route(actor, from, to, ignore).forEach((b, k) => {
        const sid = k ? `${id}${k}` : id;
        const w = r2(Math.min(4, Math.max(k ? 0.3 : 0.6, Math.hypot(b.x - a.x, b.z - a.z) / walkSpeed(actor, wclip))));
        if (actor.asset && resolveClip(actor.asset, "walk")) {
          into.push({ at: r2(at + t), action: { id: `${tag}_${sid}_walk`, type: "animation", target: actor.c.id, clip: wclip, duration: w } });
        }
        into.push({ at: r2(at + t), action: { id: `${tag}_${sid}_move`, type: "moveTo", target: actor.c.id, to: { x: r2(b.x), z: r2(b.z) }, duration: w } });
        if (stepsAsset && actor.asset && resolveClip(actor.asset, "walk")) sounds_.push({ at: r2(at + t), duration: w, id: sid });
        t += w;
        a = b;
      });
      return r2(t);
    };
    /** Sau câu: quay về phía chỗ cũ, đi về, quay lại hướng đứng. Trả về thời gian. */
    const goHome = (from: { x: number; z: number }): number => {
      if (Math.hypot(from.x - origin.x, from.z - origin.z) < 0.05) {
        post.push({ at: 0, action: { id: `${tag}_home`, type: "turn", target: actor.c.id, heading: r2(actor.heading), duration: 0.4 } });
        return 0.4;
      }
      post.push({ at: 0, action: { id: `${tag}_turn_back`, type: "turn", target: actor.c.id, heading: headingOf(origin.x - from.x, origin.z - from.z), duration: TURN } });
      const w2 = walkTo(origin, from, TURN, "back", post, postWalk);
      post.push({ at: TURN + w2, action: { id: `${tag}_home`, type: "turn", target: actor.c.id, heading: r2(actor.heading), duration: 0.4 } });
      return TURN + w2 + 0.4;
    };
    const turn = (heading: number, at: number, id: string, who: Placed = actor, dur = TURN) =>
      steps.push({ at, action: { id: `${tag}_${id}`, type: "turn", target: who.c.id, heading: r2(heading), duration: dur } });
    const play = (clip: string | undefined, at: number, id: string, who: Placed = actor, dur = PICK) => {
      if (clip) steps.push({ at, action: { id: `${tag}_${id}`, type: "animation", target: who.c.id, clip, loop: false, duration: dur } });
    };
    const event = (at: number, action: Record<string, unknown>) => steps.push({ at, action: { ...action, id: `${tag}_${String(action.type)}` } });

    if (it?.type === "play") {
      // Chạy một vòng phía trước nhóm (bắt đầu về phía mình đứng), về chỗ, nhảy cẫng hai cái.
      const s = actor.x >= cx ? 1 : -1;
      const W = Math.min(stage.halfWidth, 2.6);
      const loop = [
        { x: cx + s * W, z: cz - 0.9 },
        { x: cx + s * W * 0.35, z: cz - 2.2 },
        { x: cx - s * W * 0.35, z: cz - 2.2 },
        { x: cx - s * W, z: cz - 0.9 },
        { x: cx - s * W * 0.2, z: cz - 1.4 },
      ].map((q) => ({ x: r2(q.x), z: r2(q.z) }));
      const partner = it.with && home.has(it.with) ? at(byId.get(it.with)!) : undefined;
      let end = 0;
      [actor, ...(partner ? [partner] : [])].forEach((p, k) => {
        const pts = [...loop, { x: p.x, z: p.z }];
        const d = r2(pathLength(p, pts) / runSpeed(p));
        const at = 0.5 * k;
        const clip = runClip(p);
        if (clip) steps.push({ at, action: { id: `${tag}_${p.c.id}_run`, type: "animation", target: p.c.id, clip, duration: d } });
        steps.push({ at, action: { id: `${tag}_${p.c.id}_path`, type: "path", target: p.c.id, points: pts, duration: d } });
        steps.push({ at: at + d, action: { id: `${tag}_${p.c.id}_home`, type: "turn", target: p.c.id, heading: p.heading, duration: 0.3 } });
        for (const j of [0, 1]) {
          steps.push({ at: at + d + 0.35 + 0.45 * j, action: { id: `${tag}_${p.c.id}_hop${j}`, type: "jump", target: p.c.id, height: r2(0.28 * p.h), duration: 0.4 } });
        }
        if (stepsAsset && clip && k === 0) walkSounds.push({ at, duration: d, id: p.c.id });
        end = Math.max(end, at + d + 0.35 + 0.9);
      });
      if (has("sfx_boing")) sounds.push({ at: end - 0.9, asset: "sfx_boing", volume: 0.3 });
      if (has("sfx_swish")) sounds.push({ at: 0.05, asset: "sfx_swish", volume: 0.35 });
      total = end + 0.1;
    } else if (a?.type === "trip") {
      // Chạy tới, vấp món đồ: lao qua bật lên, loạng choạng, ngã sấp (cúi rạp), nằm một nhịp rồi đứng dậy đi về.
      const target = ground.get(a.object);
      if (!target) continue;
      const dx = target.x - start.x;
      const dz = target.z - start.z;
      const len = Math.hypot(dx, dz) || 1;
      const u = { x: dx / len, z: dz / len };
      const stand = { x: target.x - u.x * (extent(actor, "front") + 0.2), z: target.z - u.z * (extent(actor, "front") + 0.2) };
      const d = r2(Math.max(0.5, Math.hypot(stand.x - start.x, stand.z - start.z) / runSpeed(actor)));
      goTime = d;
      goDir = u;
      const clip = runClip(actor);
      if (clip) steps.push({ at: 0, action: { id: `${tag}_run`, type: "animation", target: actor.c.id, clip, duration: d } });
      steps.push({ at: 0, action: { id: `${tag}_go_move`, type: "moveTo", target: actor.c.id, to: { x: r2(stand.x), z: r2(stand.z) }, duration: d } });
      if (stepsAsset && clip) walkSounds.push({ at: 0, duration: d, id: "go" });
      const fall = { x: target.x + u.x * 0.45, z: target.z + u.z * 0.45 };
      steps.push({ at: d, action: { id: `${tag}_lurch`, type: "moveTo", target: actor.c.id, to: { x: r2(fall.x), z: r2(fall.z) }, duration: 0.32 } });
      steps.push({ at: d, action: { id: `${tag}_bump`, type: "jump", target: actor.c.id, height: r2(0.2 * actor.h), duration: 0.32 } });
      steps.push({ at: d + 0.32, action: { id: `${tag}_wob1`, type: "turn", target: actor.c.id, by: 28, duration: 0.14 } });
      steps.push({ at: d + 0.46, action: { id: `${tag}_wob2`, type: "turn", target: actor.c.id, by: -42, duration: 0.18 } });
      steps.push({ at: d + 0.64, action: { id: `${tag}_wob3`, type: "turn", target: actor.c.id, by: 14, duration: 0.14 } });
      play(pickClip(actor.asset), d + 0.4, "fall", actor, 1.1);
      if (has("sfx_slide_down")) sounds.push({ at: d, asset: "sfx_slide_down", volume: 0.3 });
      sounds.push({ at: d + 0.34, asset: variant("sfx_thud_", seed), volume: 0.6 });
      if (has("sfx_oops")) sounds.push({ at: d + 0.45, asset: "sfx_oops", volume: 0.7 });
      // Nói ngay chỗ ngã ("Oái!"); đứng dậy đi về sau câu.
      total = d + 0.78 + 0.5;
      spot = { ...fall, heading: headingOf(dx, dz) };
      focus = target;
    } else if (a?.type === "drop") {
      play(pickClip(actor.asset), 0, "put");
      event(PICK_AT, { type: "drop", target: a.object });
      const faceDeg = cur?.heading ?? actor.heading;
      const rad = (faceDeg * Math.PI) / 180;
      ground.set(a.object, { x: start.x + Math.sin(rad) * DROP_DISTANCE, z: start.z + Math.cos(rad) * DROP_DISTANCE });
      if (cur) spot = { ...start, heading: faceDeg };
      sounds.push({ at: PICK_AT + 0.1, asset: variant("sfx_thud_", seed) ?? variant("sfx_drop_", seed), volume: 0.5 });
      total = PICK + 0.2;
    } else {
      const other = a ? (a.type === "give" ? a.to : null) : it!.with;
      const receiver = other && byId.has(other) && home.has(other) ? at(byId.get(other)!) : undefined;
      const target = a?.type === "pickup" ? ground.get(a.object) : a?.type === "stow" ? toyBox : receiver && { x: receiver.x, z: receiver.z };
      if (!target) continue;
      const touch = it?.type;
      const reach =
        a?.type === "pickup"
          ? Math.max(0.25 + 0.45 * actor.h, extent(actor, "front") + 0.12)
          : a?.type === "stow"
            ? extent(actor, "front") + (trashBin ? TRASH_BIN_R : TOY_BOX_R) + 0.1
            : touch === "walk"
              ? faceToFace(actor, receiver!, TALK_GAP + 0.25)
              : faceToFace(actor, receiver!, touch ? TOUCH_GAP[touch] : GIVE_GAP);
      const len0 = Math.hypot(target.x - start.x, target.z - start.z) || 1;
      const u0 = { x: (target.x - start.x) / len0, z: (target.z - start.z) / len0 };
      // Chỗ đứng cạnh người kia / món đồ: ưu tiên phía mình đi tới; đè lên người thứ ba → thử xoay dần quanh người kia.
      const standAt = (deg: number) => {
        const r = (deg * Math.PI) / 180;
        const u = { x: u0.x * Math.cos(r) - u0.z * Math.sin(r), z: u0.x * Math.sin(r) + u0.z * Math.cos(r) };
        return { x: target.x - u.x * reach, z: target.z - u.z * reach };
      };
      if (receiver) ignore = [receiver.c.id];
      // Chọn chỗ không đè ai, đường đi ngắn; đứng chắn trước mặt người kia (phía camera) bị trừ điểm.
      const tries = [0, 50, -50, 90, -90, 130, -130].map(standAt);
      // Đứng ngang hàng (hai người nhìn nhau theo phương ngang khung hình) → camera thấy mặt cả hai; đứng trước / sau
      // người kia thì một người quay lưng vào camera.
      const score = (q: { x: number; z: number }) =>
        pathLength(start, route(actor, start, q, ignore)) + (receiver ? 1.6 * Math.abs(target.z - q.z) / reach + (q.z < target.z - 0.3 ? 0.8 : 0) : 0);
      const free = tries.filter((q) => !crowded(q, actor, ignore));
      const stand = free.length ? free.reduce((b, q) => (score(q) < score(b) - 0.01 ? q : b)) : tries[0]!;
      const dx = target.x - stand.x;
      const dz = target.z - stand.z;

      const w = walkTo(stand, start, 0, "go");
      goTime = w;
      goDir = { x: stand.x - start.x, z: stand.z - start.z };
      turn(headingOf(dx, dz), w, "face");
      const act = w + TURN;
      let hold = PICK;
      if (a?.type === "pickup") {
        play(pickClip(actor.asset), act, "pick");
        insert = { at: act - 0.1, duration: PICK_AT + 0.75, shot: closeUp(target, 0.15 + 0.2 * actor.h, 1 + 0.6 * actor.h) };
        event(act + PICK_AT, { type: "attach", target: a.object, to: actor.c.id });
        ground.delete(a.object);
        sounds.push({ at: act + PICK_AT, asset: variant(kindOf(a.object)?.pickupSound ?? "sfx_cloth_", seed) ?? variant("sfx_cloth_", seed), volume: 0.55 });
        if (has("sfx_pop")) sounds.push({ at: act + PICK_AT + 0.05, asset: "sfx_pop", volume: 0.3 });
      } else if (a?.type === "stow" && toyBox) {
        // Cúi bỏ vào hộp: đồ vật rời miệng / tay, nằm trong lòng hộp.
        play(pickClip(actor.asset), act, "put");
        const o = IN_BOX[stowed++ % IN_BOX.length]!;
        if (trashBin) {
          event(act + PICK_AT, { type: "drop", target: a.object, at: { x: toyBox.x, y: TRASH_BIN_TOP, z: toyBox.z } });
          event(act + PICK_AT + 0.25, { type: "hide", target: a.object });
        } else {
          event(act + PICK_AT, { type: "drop", target: a.object, at: { x: r2(toyBox.x + o.x), y: TOY_BOX_FLOOR, z: r2(toyBox.z + o.z) } });
        }
        sounds.push({ at: act + PICK_AT + 0.05, asset: variant("sfx_drop_", seed) ?? variant("sfx_thud_", seed), volume: 0.5 });
      } else if (touch === "walk" && receiver) {
        // Đi tới đứng cạnh: hai người quay vào nhau, không động tác chạm.
        turn(headingOf(-dx, -dz), Math.max(0, w - 0.4), "rface", receiver, 0.4);
        hold = 0.15;
        partnerBack = receiver;
      } else if (touch && touch !== "walk" && receiver) {
        turn(headingOf(-dx, -dz), Math.max(0, w - 0.4), "rface", receiver, 0.4);
        const hop = (who: Placed, at: number, height: number, dur: number, id: string) =>
          steps.push({ at, action: { id: `${tag}_${id}`, type: "jump", target: who.c.id, height: r2(height), duration: dur } });
        hold = TOUCH_HOLD[touch];
        contact = { at: w, shot: sideShot(stand, receiver, Math.max(actor.h, receiver.h)) };
        /** Động tác tay (nhân vật có xương tay; model khác bỏ qua). */
        const arms = (who: Placed, pose: string, at: number, dur: number, id: string) =>
          steps.push({ at, action: { id: `${tag}_${id}`, type: "pose", target: who.c.id, pose, duration: r2(dur) } });
        if (touch === "hug") {
          arms(actor, "hug", act - 0.25, hold + 0.45, "arms");
          arms(receiver, "hug", act - 0.15, hold + 0.35, "rarms");
          // Ôm: hai người sát nhau cùng nhún hai nhịp.
          for (const [k, t] of [0.15, 0.6].entries()) {
            hop(actor, act + t, 0.07 * actor.h, 0.38, `hug${k}`);
            hop(receiver, act + t + 0.05, 0.07 * receiver.h, 0.38, `rhug${k}`);
          }
          sounds.push({ at: act + 0.2, asset: variant("sfx_cloth_", seed), volume: 0.5 });
          if (has("sfx_twinkle")) sounds.push({ at: act + 0.35, asset: "sfx_twinkle", volume: 0.3 });
        } else if (touch === "highfive") {
          // Đập tay: cùng bật nhảy, chạm ở đỉnh.
          const hgt = 0.22 * Math.min(actor.h, receiver.h);
          arms(actor, "highfive", act - 0.2, hold + 0.3, "arms");
          arms(receiver, "highfive", act - 0.2, hold + 0.3, "rarms");
          hop(actor, act + 0.1, hgt, 0.5, "hi5");
          hop(receiver, act + 0.1, hgt, 0.5, "rhi5");
          sounds.push({ at: act + 0.35, asset: has("sfx_confirm") ? "sfx_confirm" : variant("sfx_pluck_", seed), volume: 0.5 });
        } else {
          // Vỗ vai: người làm nhún nhẹ ba lần, người kia gật đầu (nếu có clip thật).
          for (let k = 0; k < 3; k++) hop(actor, act + 0.1 + 0.3 * k, 0.04 * actor.h, 0.25, `pat${k}`);
          arms(actor, "pat", act - 0.1, hold + 0.2, "arms");
          const nod = giveClip(receiver.asset);
          if (nod && nod !== "eat") play(nod, act + 0.2, "rnod", receiver, 1);
          sounds.push({ at: act + 0.15, asset: variant("sfx_cloth_", seed), volume: 0.35 });
          if (has("sfx_tap")) for (let k = 0; k < 3; k++) sounds.push({ at: act + 0.12 + 0.3 * k, asset: "sfx_tap", volume: 0.25 });
        }
        partnerBack = receiver;
      } else if (receiver && a) {
        turn(headingOf(-dx, -dz), Math.max(0, w - 0.4), "rface", receiver, 0.4);
        play(giveClip(actor.asset), act, "offer");
        steps.push({ at: act - 0.2, action: { id: `${tag}_arms`, type: "pose", target: actor.c.id, pose: "reach", duration: r2(PICK_AT + 0.7) } });
        steps.push({ at: act + 0.1, action: { id: `${tag}_rarms`, type: "pose", target: receiver.c.id, pose: "reach", duration: r2(PICK_AT + 0.4) } });
        const hMax = Math.max(actor.h, receiver.h);
        contact = { at: w, shot: sideShot(stand, receiver, hMax) };
        insert = { at: act, duration: PICK_AT + 0.8, shot: sideShot(stand, receiver, hMax, true) };
        event(act + PICK_AT, { type: "attach", target: a.object, to: receiver.c.id });
        const thanks = giveClip(receiver.asset);
        if (thanks !== "eat") play(thanks, act + PICK_AT + 0.1, "thanks", receiver, 1.1);
        partnerBack = receiver;
        sounds.push({ at: act + PICK_AT, asset: variant("sfx_cloth_", seed), volume: 0.45 });
        if (has("sfx_chime")) sounds.push({ at: act + PICK_AT + 0.15, asset: "sfx_chime", volume: 0.35 });
      }
      // Nói ngay tại chỗ vừa tới; đi về sau câu.
      total = act + hold;
      spot = { ...stand, heading: headingOf(dx, dz) };
      focus = target;
    }
    // Sau câu: người kia quay lại hướng cũ; người làm đi về / đứng lại / rời cảnh (trừ khi làm tiếp / câu cuối).
    if (partnerBack) post.push({ at: 0, action: { id: `${tag}_rback`, type: "turn", target: partnerBack.c.id, heading: r2(partnerBack.heading), duration: 0.35 } });
    let ret = partnerBack ? 0.35 : 0;
    if (then === "leave") {
      // Nói xong đi ra khỏi cảnh từ chỗ đang đứng.
      const here = spot ?? { ...start, heading: cur?.heading ?? actor.heading };
      let from: { x: number; z: number } = here;
      let t = 0;
      exitLegs({ ...actor, ...here }, here.x >= cx ? 1 : -1, 0).forEach((to, j) => {
        post.push({ at: t, action: { id: `${tag}_exit${j}_turn`, type: "turn", target: actor.c.id, heading: headingOf(to.x - from.x, to.z - from.z), duration: TURN } });
        if (!j) t += TURN;
        t += walkTo(to, from, t, `exit${j}`, post, postWalk);
        from = to;
      });
      ret = Math.max(ret, t);
      home.delete(actor.c.id);
      leaving.add(actor.c.id);
    } else if (spot && stay) pos.set(actor.c.id, spot);
    else if (spot && then === "stay" && !crowded(spot, actor, partnerBack ? [partnerBack.c.id] : [])) {
      // Đứng lại chỗ vừa tới, quay ra phía trước nhóm: chỗ đứng mới cho các câu sau.
      const h = headingOf(face.x - spot.x, face.z - spot.z);
      post.push({ at: 0, action: { id: `${tag}_settle`, type: "turn", target: actor.c.id, heading: h, duration: 0.4 } });
      home.set(actor.c.id, { x: r2(spot.x), z: r2(spot.z), heading: h });
      ret = Math.max(ret, 0.4);
    } else if (spot) ret = Math.max(ret, goHome(spot));
    if (spot) snap.set(actor.c.id, { x: r2(spot.x), z: r2(spot.z), heading: r2(spot.heading) });
    if (spot && focus) displaced.set(line.id, { actor: actor.c.id, at: { x: r2(spot.x), z: r2(spot.z) }, focus: { x: r2(focus.x), z: r2(focus.z) } });
    // Câu kế liên quan tới người đang đi về / quay lại (hoặc là câu nhảy mừng kết) → chờ về xong mới nói.
    const movers = [actor.c.id, ...(partnerBack ? [partnerBack.c.id] : [])];
    const nextNeeds = !!next && (movers.some((id) => involves(next, id)) || (endingDance && li + 1 === sc.lines.length - 1));
    if (ret > 0 && nextNeeds && !chain) after.set(line.id, r2(POST_DELAY + ret));
    total = r2(total);
    // Cắt tắt: rảnh ở hai câu trước → bắt đầu đi từ cuối câu trước; "walk" → nói luôn khi sắp tới.
    const free = li > 0 && !cur && !involves(sc.lines[li - 1], actor.c.id) && !involves(sc.lines[li - 2], actor.c.id);
    const talkOver = it?.type === "walk" ? r2(0.7 * goTime) : 0;
    /** Tương tác bắt đầu trước câu bao lâu. */
    const base = r2(total - talkOver);
    const lead = free && goTime > 0 ? r2(Math.min(1, 0.6 * goTime, base)) : 0;
    const wait = r2(Math.max(0, base - lead));
    busy.set(line.id, wait);

    // Camera khi đi: quay ngang theo hướng đi (phía camera chính) → thấy mặt nghiêng, không thấy lưng; đứng tại chỗ
    // (đặt xuống, chạy chơi) → từ phía trước nhóm, lệch về phía GIỮA nhóm (đồ vật nằm ở mép ngoài → không che ống kính).
    const D = 2 + 1.8 * actor.h;
    const g = goDir && Math.hypot(goDir.x, goDir.z) > 0.3 ? { x: goDir.x / Math.hypot(goDir.x, goDir.z), z: goDir.z / Math.hypot(goDir.x, goDir.z) } : undefined;
    const n = g ? (g.x >= 0 ? { x: g.z, z: -g.x } : { x: -g.z, z: g.x }) : undefined; // vuông góc hướng đi, về phía -z
    const offset = g && n ? { x: r2(n.x * D + g.x * 0.35 * D), y: r2(0.5 + actor.h), z: r2(n.z * D + g.z * 0.35 * D) } : { x: r2((actor.x >= cx ? -1 : 1) * (0.8 + actor.h)), y: r2(0.5 + actor.h), z: r2(-D) };
    // Các đoạn camera nối tiếp (không chồng nhau): bám theo → [cận món đồ → bám theo] → camera của câu (từ -0.15).
    const camStart = -wait;
    const camEnd = -0.15;
    const follow = { mode: "follow", target: actor.c.id, offset, lookAtOffset: { x: 0, y: r2(0.4 * actor.h), z: 0 }, fov: 50 };
    // Điểm cắt: bám theo (đang đi) → khung hai người (tới nơi, chạm nhau) → cận món đồ → khung trước đó. Đoạn quá
    // ngắn (< 0.5 s) gộp vào đoạn trước để không cắt giật.
    type Cut = { id: string; from: number; shot: Record<string, unknown>; move?: Record<string, number> };
    const cuts: Cut[] = [{ id: `cam_${tag}`, from: camStart, shot: follow }];
    if (contact) cuts.push({ id: `cam_${tag}_two`, from: r2(contact.at - base), shot: contact.shot, move: { dolly: 0.05 } });
    if (insert) {
      const from = r2(insert.at - base);
      const to = r2(insert.at - base + insert.duration);
      cuts.push({ id: `cam_${tag}_insert`, from, shot: insert.shot, move: { dolly: 0.08 } });
      if (camEnd - to >= 0.5) cuts.push({ id: `cam_${tag}_after`, from: to, shot: contact?.shot ?? follow });
    }
    const kept: Cut[] = [];
    for (const c of cuts.filter((c) => c.from < camEnd - 0.3).sort((p, q) => p.from - q.from)) {
      const prev = kept[kept.length - 1];
      if (c.from <= camStart) kept.splice(0, kept.length, { ...c, from: camStart });
      else if (prev && c.from - prev.from < 0.5) kept[kept.length - 1] = { ...c, from: prev.from };
      else kept.push(c);
    }
    if (kept.length === 1 && camEnd - camStart < 0.5) {
      // Quá ngắn để cắt riêng → camera của câu vào sớm hơn.
      if (wait > 0.15) camEarly.set(line.id, r2(wait - 0.15));
    } else {
      kept.forEach((c, k) => {
        const to = kept[k + 1]?.from ?? camEnd;
        actions.push({ id: c.id, type: "camera", sync: { line: pre, offset: r2(c.from), duration: r2(to - c.from) }, shot: c.shot, ...(c.move ? { move: c.move } : {}) });
      });
    }
    for (const s of post) {
      const { duration, ...rest } = s.action;
      actions.push({ ...rest, sync: { line: line.id, at: "end", offset: r2(POST_DELAY + s.at), duration: typeof duration === "number" ? duration : 0.25 } });
    }
    for (const ws of postWalk) {
      audio.push({ id: `${tag}_${ws.id}_steps`, kind: "sfx", asset: stepsAsset, loop: true, duration: ws.duration, volume: stepVolume(actor.h), fadeOut: 0.15, sync: { line: line.id, at: "end", offset: r2(POST_DELAY + ws.at) } });
    }
    for (const s of steps) {
      const { duration, ...rest } = s.action;
      actions.push({ ...rest, sync: { line: pre, offset: r2(s.at - base), duration: typeof duration === "number" ? duration : 0.25 } });
    }
    sounds.forEach((snd, k) => {
      if (snd.asset) audio.push({ id: `sfx_${tag}_${k}`, kind: "sfx", asset: snd.asset, volume: snd.volume, sync: { line: pre, at: "start", offset: r2(snd.at - base) } });
    });
    for (const ws of walkSounds) {
      audio.push({
        id: `${tag}_${ws.id}_steps`,
        kind: "sfx",
        asset: stepsAsset,
        loop: true,
        duration: ws.duration,
        volume: stepVolume(actor.h),
        fadeOut: 0.15,
        sync: { line: pre, at: "start", offset: r2(ws.at - base) },
      });
    }
  }
  return { props, busy, leaving, displaced, after, stands, camEarly };
}
