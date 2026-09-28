import { DROP_DISTANCE } from "../engine/PropEngine";
import { findAsset, resolveClip, type AssetEntry, type Registry } from "../schemas/asset.schema";
import { OBJECT_KINDS } from "./objects";
import { simulateObjects, type Story, type StoryCharacter } from "./story";

/** Âm lượng bước chân theo cỡ nhân vật (giống buildScene). */
const stepVolume = (h: number) => Math.round(Math.min(0.5, Math.max(0.12, 0.08 + 0.2 * h)) * 100) / 100;

/**
 * Tương tác với đồ vật cho buildScene: đặt đồ vật vào cảnh và sinh chuỗi action cho từng câu có `action`.
 *
 *   pickup: đi tới → quay vào → cúi nhặt (đồ vật gắn vào tay/miệng) → quay về chỗ đứng, vẫn cầm
 *   give:   đi tới người nhận → trao (đồ vật sang tay/miệng người nhận) → người nhận cảm ơn → quay về
 *   drop:   cúi xuống, đặt trước mặt
 *
 * Mọi action gắn với câu thoại bằng `sync` offset âm → diễn ra NGAY TRƯỚC câu; `busy` = thời gian câu phải lùi lại.
 */

export interface Placed {
  c: StoryCharacter;
  asset: AssetEntry | undefined;
  h: number;
  x: number;
  z: number;
  heading: number;
}

export interface StageArea {
  center: { x: number; z: number };
  halfWidth: number;
}

/** Độ dài động tác cúi nhặt / trao (giây) và thời điểm đồ vật đổi chỗ trong động tác. */
const PICK = 1.3;
const PICK_AT = 0.55;
const TURN = 0.3;
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

function walkSpeed(p: Placed): number {
  const walk = p.asset ? resolveClip(p.asset, "walk") : undefined;
  return (walk && p.asset?.suggestedSpeed[walk]) || 1.2;
}

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
): { props: Record<string, unknown>[]; busy: Map<string, number> } {
  const sc = story.scenes[index]!;
  const state = simulateObjects(story).states[index]!;
  const props: Record<string, unknown>[] = [];
  const busy = new Map<string, number>();
  const ground = new Map<string, { x: number; z: number }>();
  const kindOf = (id: string) => OBJECT_KINDS[story.objects.find((o) => o.id === id)?.kind ?? ""];
  const { x: cx, z: cz } = stage.center;

  // Nằm trên đất: hai bên nhóm, hơi lên phía trước; đặt về phía người sẽ nhặt nó.
  const perSide: Record<string, number> = { left: 0, right: 0 };
  [...state.lying].forEach((oid, k) => {
    const kind = kindOf(oid);
    if (!kind) return;
    const picker = sc.lines.find((l) => l.action?.type === "pickup" && l.action.object === oid);
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
  let lineNo = 0;
  for (const line of sc.lines) {
    const a = line.action;
    if (!a) continue;
    const actor = byId.get(a.by ?? line.speaker ?? "");
    if (!actor) continue;
    const tag = `${line.id}_${a.type}`;
    const home = { x: actor.x, z: actor.z };
    /** Các bước: thời điểm tương đối với đầu tương tác. */
    const steps: { at: number; action: Record<string, unknown> }[] = [];
    const walkSounds: { at: number; duration: number; id: string }[] = [];
    const sounds: { at: number; asset: string | undefined; volume: number }[] = [];
    let total: number;
    const seed = lineNo++;

    const walkTo = (to: { x: number; z: number }, from: { x: number; z: number }, at: number, id: string): number => {
      const w = r2(Math.min(4, Math.max(0.6, Math.hypot(to.x - from.x, to.z - from.z) / walkSpeed(actor))));
      if (actor.asset && resolveClip(actor.asset, "walk")) {
        steps.push({ at, action: { id: `${tag}_${id}_walk`, type: "animation", target: actor.c.id, clip: "walk", duration: w } });
      }
      steps.push({ at, action: { id: `${tag}_${id}_move`, type: "moveTo", target: actor.c.id, to: { x: r2(to.x), z: r2(to.z) }, duration: w } });
      if (stepsAsset && actor.asset && resolveClip(actor.asset, "walk")) walkSounds.push({ at, duration: w, id });
      return w;
    };
    const turn = (heading: number, at: number, id: string, who: Placed = actor, dur = TURN) =>
      steps.push({ at, action: { id: `${tag}_${id}`, type: "turn", target: who.c.id, heading: r2(heading), duration: dur } });
    const play = (clip: string | undefined, at: number, id: string, who: Placed = actor, dur = PICK) => {
      if (clip) steps.push({ at, action: { id: `${tag}_${id}`, type: "animation", target: who.c.id, clip, loop: false, duration: dur } });
    };
    const event = (at: number, action: Record<string, unknown>) => steps.push({ at, action: { ...action, id: `${tag}_${String(action.type)}` } });

    if (a.type === "drop") {
      play(pickClip(actor.asset), 0, "put");
      event(PICK_AT, { type: "drop", target: a.object });
      const rad = (actor.heading * Math.PI) / 180;
      ground.set(a.object, { x: home.x + Math.sin(rad) * DROP_DISTANCE, z: home.z + Math.cos(rad) * DROP_DISTANCE });
      sounds.push({ at: PICK_AT + 0.1, asset: variant("sfx_thud_", seed) ?? variant("sfx_drop_", seed), volume: 0.5 });
      total = PICK + 0.2;
    } else {
      const receiver = a.type === "give" && a.to ? byId.get(a.to) : undefined;
      const target = a.type === "pickup" ? ground.get(a.object) : receiver && { x: receiver.x, z: receiver.z };
      if (!target) continue;
      const reach = a.type === "pickup" ? 0.25 + 0.45 * actor.h : 0.3 + 0.35 * (actor.h + receiver!.h);
      const dx = target.x - home.x;
      const dz = target.z - home.z;
      const len = Math.hypot(dx, dz) || 1;
      const stand = { x: target.x - (dx / len) * reach, z: target.z - (dz / len) * reach };

      const w = walkTo(stand, home, 0, "go");
      turn(headingOf(dx, dz), w, "face");
      const act = w + TURN;
      if (a.type === "pickup") {
        play(pickClip(actor.asset), act, "pick");
        event(act + PICK_AT, { type: "attach", target: a.object, to: actor.c.id });
        ground.delete(a.object);
        sounds.push({ at: act + PICK_AT, asset: variant(kindOf(a.object)?.pickupSound ?? "sfx_cloth_", seed) ?? variant("sfx_cloth_", seed), volume: 0.55 });
      } else if (receiver) {
        turn(headingOf(-dx, -dz), Math.max(0, w - 0.4), "rface", receiver, 0.4);
        play(giveClip(actor.asset), act, "offer");
        event(act + PICK_AT, { type: "attach", target: a.object, to: receiver.c.id });
        const thanks = giveClip(receiver.asset);
        if (thanks !== "eat") play(thanks, act + PICK_AT + 0.1, "thanks", receiver, 1.1);
        turn(receiver.heading, act + PICK + 0.2, "rback", receiver, 0.4);
        sounds.push({ at: act + PICK_AT, asset: variant("sfx_cloth_", seed), volume: 0.45 });
        if (has("sfx_chime")) sounds.push({ at: act + PICK_AT + 0.15, asset: "sfx_chime", volume: 0.35 });
      }
      const back = act + PICK;
      turn(headingOf(home.x - stand.x, home.z - stand.z), back, "turn_back");
      const w2 = walkTo(home, stand, back + TURN, "back");
      turn(actor.heading, back + TURN + w2, "home", actor, 0.4);
      total = back + TURN + w2 + 0.4;
    }
    total = r2(total);
    busy.set(line.id, total);

    // Camera bám người đang làm, từ phía trước nhóm, lệch về phía GIỮA nhóm (đồ vật nằm ở mép ngoài → không che ống kính).
    actions.push({
      id: `cam_${tag}`,
      type: "camera",
      sync: { line: line.id, offset: -total, duration: r2(Math.max(0.3, total - 0.15)) },
      shot: {
        mode: "follow",
        target: actor.c.id,
        offset: { x: r2((actor.x >= cx ? -1 : 1) * (0.8 + actor.h)), y: r2(0.5 + actor.h), z: r2(-(2 + 1.8 * actor.h)) },
        lookAtOffset: { x: 0, y: r2(0.4 * actor.h), z: 0 },
        fov: 50,
      },
    });
    for (const s of steps) {
      const { duration, ...rest } = s.action;
      actions.push({ ...rest, sync: { line: line.id, offset: r2(s.at - total), duration: typeof duration === "number" ? duration : 0.25 } });
    }
    sounds.forEach((snd, k) => {
      if (snd.asset) audio.push({ id: `sfx_${tag}_${k}`, kind: "sfx", asset: snd.asset, volume: snd.volume, sync: { line: line.id, at: "start", offset: r2(snd.at - total) } });
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
        sync: { line: line.id, at: "start", offset: r2(ws.at - total) },
      });
    }
  }
  return { props, busy };
}
