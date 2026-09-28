import { findAsset, resolveClip, type AssetEntry, type Registry } from "../schemas/asset.schema";
import type { Emotion, LightingPreset, WeatherEffect } from "../schemas/scene.schema";
import { buildInteractions } from "./interactions";
import { CHARACTER_SIZES, FORMATS, type Format, type Lang, type Mood, type Story } from "./story";

/**
 * Story đã duyệt + ngôn ngữ → Scene Script soạn thảo (dialogue "after", action "sync", duration "auto").
 * Tất định: cùng đầu vào → cùng scene. Resolver + validator sẵn có lo phần TTS và kiểm tra.
 *
 * Bố cục: nhân vật đứng thành vòng cung quanh "sân khấu" của bối cảnh, quay về phía camera (-z).
 * Mở đầu: đi vào từ hai bên (cảnh toàn) → mỗi câu thoại: cận người nói, người dẫn chuyện: cảnh toàn
 * → câu cuối: cảnh toàn + cả nhóm nhảy/vẫy tay.
 *
 * Kịch bản nhiều khung cảnh → buildStory() dựng từng cảnh (bối cảnh, nhân vật có mặt riêng) + movie.json
 * ghép các cảnh; nhạc nền đặt ở cấp movie để chạy liền suốt phim, kết (nhảy/vẫy tay, chuông) chỉ ở cảnh cuối.
 */

interface Stage {
  center: { x: number; z: number };
  /** Nửa bề ngang tối đa của nhóm (lối đi giữa cây / đá). Rộng hơn → xếp so le hai hàng. */
  halfWidth: number;
  /** Đi vào cảnh: "back" = dọc lối đi từ phía sau (hai bên là cây), "sides" = từ hai bên. */
  entrance: "back" | "sides";
  /** Khoảng cách camera tối đa về phía -z trước khi đụng cây/nhà. */
  maxCamDist: number;
  background: string;
  /** Preset ánh sáng hợp với bối cảnh (xem engine/Lighting). */
  lighting?: LightingPreset;
  /** Âm thanh môi trường lặp suốt cảnh. */
  ambience?: string;
  /** Mặt đất → tiếng bước chân (sfx_steps_<surface>_loop). */
  surface?: "grass" | "snow" | "wood" | "concrete";
  /** Hiệu ứng hạt mặc định (tuyết, lá rơi, bướm…). */
  effects?: WeatherEffect[];
}

/** Thời điểm trong ngày của cảnh → preset ánh sáng + màu trời (đè lên mặc định của bối cảnh). */
const TIME_OF_DAY: Record<"day" | "morning" | "sunset" | "night", { lighting: LightingPreset; background?: string }> = {
  day: { lighting: "day" },
  morning: { lighting: "morning", background: "#f3dcc0" },
  sunset: { lighting: "sunset", background: "#f2a878" },
  night: { lighting: "night", background: "#1d2748" },
};

/** Vùng trống của từng bối cảnh (xem environments/*.layout.json: path x=0, clearings, place). */
const PATH_STAGE = { center: { x: 0, z: 0 }, halfWidth: 2.3, entrance: "back", maxCamDist: 14 } as const;
const STAGES: Record<string, Stage> = {
  env_meadow: { ...PATH_STAGE, background: "#a8d8f0", ambience: "amb_birds", effects: ["butterflies"] },
  env_forest: { ...PATH_STAGE, background: "#bde0fe", ambience: "amb_birds" },
  env_autumn_forest: { ...PATH_STAGE, background: "#ffd6a5", lighting: "morning", ambience: "amb_birds", effects: ["leaves"] },
  env_snow_forest: { ...PATH_STAGE, background: "#dfe9f3", lighting: "snow", ambience: "amb_wind", surface: "snow", effects: ["snow"] },
  env_desert: { ...PATH_STAGE, background: "#f6d8a8", lighting: "sunset", ambience: "amb_wind" },
  // Hàng rào hai bên lối đi (x = ±3) từ z = -18 → đứng ở bãi trống đầu lối đi, nhìn về phía chuồng trại.
  env_farm: { center: { x: 0, z: -23 }, halfWidth: 6, entrance: "sides", maxCamDist: 14, background: "#bde0fe", lighting: "morning", ambience: "amb_park", effects: ["butterflies"] },
  env_polluted_pond: { center: { x: 0, z: 1.5 }, halfWidth: 3.5, entrance: "sides", maxCamDist: 6.5, background: "#b3cad6", lighting: "overcast", ambience: "amb_water" },
  env_beach: { center: { x: 0, z: 0 }, halfWidth: 4, entrance: "sides", maxCamDist: 12, background: "#9fd8f5", ambience: "amb_water", surface: "snow" },
  env_garden: { center: { x: 0, z: 0 }, halfWidth: 3.2, entrance: "back", maxCamDist: 11, background: "#bde0fe", ambience: "amb_birds", effects: ["butterflies"] },
  env_clear_lake: { center: { x: 0, z: 1.5 }, halfWidth: 3.5, entrance: "sides", maxCamDist: 6.5, background: "#b9dcf0", ambience: "amb_water" },
  env_park: { center: { x: 0, z: 0 }, halfWidth: 4, entrance: "sides", maxCamDist: 12, background: "#bde0fe", ambience: "amb_park", effects: ["petals"] },
};
const DEFAULT_STAGE: Stage = { center: { x: 0, z: 0 }, halfWidth: 3, entrance: "back", maxCamDist: 10, background: "#bde0fe" };

const INTRO = 3.4;
/** Thời gian chuyển cảnh fade / dissolve (giây). */
const TRANSITION = 0.8;
const GAP = 0.45;
const WIDE_FOV = 50;
const CLOSE_FOV = 45;

/** Cảm xúc câu thoại → clip (chỉ khi nhân vật có clip thật; còn lại engine diễn bằng tư thế). */
const EMOTION_CLIP: Partial<Record<Emotion, string>> = { sad: "defeat", happy: "yes" };

/** Cảm xúc → nhạc nền (thiếu asset → music_happy). */
const MUSIC_BY_MOOD: Record<Mood, string> = {
  happy: "music_happy",
  calm: "music_calm",
  adventure: "music_adventure",
  sad: "music_sad",
  magic: "music_magic",
  playful: "music_playful",
};

function musicFor(registry: Registry, mood: Mood): string | undefined {
  const id = MUSIC_BY_MOOD[mood];
  if (findAsset(registry, id)?.type === "audio") return id;
  return findAsset(registry, "music_happy") ? "music_happy" : undefined;
}

/** Tiếng bước chân lặp cho mặt đất của bối cảnh (nếu có trong Registry). */
export function stepsFor(registry: Registry, surface: string | undefined): string | undefined {
  const id = `sfx_steps_${surface ?? "grass"}_loop`;
  return findAsset(registry, id)?.type === "audio" ? id : undefined;
}

/** Âm lượng bước chân theo cỡ nhân vật. */
export const stepVolume = (h: number) => Math.round(Math.min(0.5, Math.max(0.12, 0.08 + 0.2 * h)) * 100) / 100;

const r2 = (n: number) => Math.round(n * 100) / 100;
const heading = (dx: number, dz: number) => r2((Math.atan2(dx, dz) * 180) / Math.PI);

function voiceFor(registry: Registry, lang: Lang, role: string): string {
  const exact = `voice_${lang}_${role}`;
  if (findAsset(registry, exact)?.type === "voice") return exact;
  const any = registry.assets.find((a) => a.type === "voice" && a.id.startsWith(`voice_${lang}_`));
  if (!any) throw new Error(`Chưa có giọng đọc cho ngôn ngữ "${lang}"`);
  return any.id;
}

function heightOf(a: AssetEntry | undefined): number {
  return a?.height ?? 1.2;
}

export interface BuildOptions {
  format?: Format;
}

/** Kịch bản MỘT cảnh → Scene Script (kịch bản nhiều cảnh: dùng buildStory). */
export function buildScene(story: Story, lang: Lang, registry: Registry, opts: BuildOptions = {}): Record<string, unknown> {
  if (story.scenes.length !== 1) throw new Error("Kịch bản nhiều cảnh – dùng buildStory()");
  return buildStoryScene(story, 0, lang, registry, opts, true, true);
}

export type BuiltStory =
  | { kind: "scene"; scene: Record<string, unknown> }
  | { kind: "movie"; movie: Record<string, unknown>; scenes: { id: string; file: string; scene: Record<string, unknown> }[] };

/** Story → Scene Script (1 cảnh) hoặc movie.json + scene của từng cảnh (nhiều cảnh). */
export function buildStory(story: Story, lang: Lang, registry: Registry, opts: BuildOptions = {}): BuiltStory {
  if (story.scenes.length === 1) return { kind: "scene", scene: buildScene(story, lang, registry, opts) };
  const { width, height } = FORMATS[opts.format ?? "16x9"];
  // Cùng cảm xúc → một bản nhạc chạy liền cả phim; khác nhau → mỗi cảnh nhạc riêng (tự fade ở chuyển cảnh).
  const moods = new Set(story.scenes.map((sc) => sc.mood ?? story.mood));
  const perScene = moods.size > 1;
  const scenes = story.scenes.map((sc, i) => ({
    id: sc.id,
    file: `scenes/${String(i + 1).padStart(2, "0")}-${sc.id}.json`,
    scene: buildStoryScene(story, i, lang, registry, opts, false, perScene),
  }));
  const audio: Record<string, unknown>[] = [];
  const bgm = story.music && !perScene ? musicFor(registry, story.scenes[0]!.mood ?? story.mood) : undefined;
  if (bgm) audio.push({ id: "bgm", kind: "music", asset: bgm, start: 0, loop: true, volume: 0.3, fadeIn: 0.5, fadeOut: 1.8 });
  const movie = {
    version: 1,
    meta: { name: story.title[lang], fps: 30, width, height },
    scenes: scenes.map((s, i) => ({
      id: s.id,
      file: s.file,
      ...(i > 0 ? { transition: { type: story.scenes[i]!.transition, duration: story.scenes[i]!.transition === "cut" ? 0.6 : TRANSITION } } : {}),
    })),
    audio,
    mix: { duckMusic: true, duckLevel: 0.25, loudness: -14 },
  };
  return { kind: "movie", movie, scenes };
}

function buildStoryScene(story: Story, index: number, lang: Lang, registry: Registry, opts: BuildOptions, single: boolean, ownMusic: boolean): Record<string, unknown> {
  if (!story.languages.includes(lang)) throw new Error(`Kịch bản không có ngôn ngữ "${lang}"`);
  const { width, height } = FORMATS[opts.format ?? "16x9"];
  const aspect = width / height;
  const sc = story.scenes[index]!;
  const isLast = index === story.scenes.length - 1;
  const stage = STAGES[sc.environment] ?? DEFAULT_STAGE;
  const tod = sc.time ? TIME_OF_DAY[sc.time] : undefined;
  const night = sc.time === "night";
  const sky = tod?.background ?? stage.background;
  // Đêm: đom đóm thay bướm; tuyết / lá rơi vẫn giữ.
  const effects = [...(stage.effects ?? []).filter((e) => !(night && (e === "butterflies" || e === "petals"))), ...(night ? (["fireflies"] as const) : [])];
  const { x: cx, z: cz } = stage.center;

  // ---------------------------------------------------------------- xếp nhân vật thành vòng cung
  const members = sc.cast.map((id) => story.characters.find((c) => c.id === id)).filter((c) => c !== undefined);
  const cast = members.map((c) => ({ c, asset: findAsset(registry, c.asset), h: heightOf(findAsset(registry, c.asset)) * CHARACTER_SIZES[c.size] }));
  let gaps = cast.slice(1).map((k, i) => Math.max(1.3, 0.55 * (k.h + cast[i]!.h) + 0.7));
  const want = gaps.reduce((s, g) => s + g, 0);
  // Quá rộng so với khoảng trống → khít lại (tối thiểu 1.1 m), vẫn rộng → so le hàng trước/sau.
  const squeeze = want > 2 * stage.halfWidth ? Math.max(0.6, (2 * stage.halfWidth) / want) : 1;
  gaps = gaps.map((g) => Math.max(1.1, g * squeeze));
  const totalW = gaps.reduce((s, g) => s + g, 0);
  const stagger = totalW > 2 * stage.halfWidth + 0.01;
  let acc = -totalW / 2;
  const focus = { x: cx, z: cz - 6 }; // điểm mọi người cùng hướng về (phía camera)
  const placed = cast.map((k, i) => {
    if (i > 0) acc += gaps[i - 1]!;
    const x = cx + acc;
    const z = cz - Math.min(1.6, 0.12 * acc * acc) + (stagger && i % 2 === 1 ? 1.3 : 0);
    return { ...k, x: r2(x), z: r2(z), heading: heading(focus.x - x, focus.z - z) };
  });
  const maxH = Math.max(...cast.map((k) => k.h));

  // ---------------------------------------------------------------- cảnh toàn: lùi đủ xa để thấy cả nhóm
  const vHalf = (WIDE_FOV / 2) * (Math.PI / 180);
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const margin = 0.5 + maxH * 0.6; // lề hai bên cảnh toàn, theo cỡ nhân vật
  let dist = Math.max((totalW / 2 + margin) / Math.tan(hHalf), (maxH + 0.8) / Math.tan(vHalf), 4.5);
  let wideFov = WIDE_FOV;
  if (dist > stage.maxCamDist) {
    // Không lùi được nữa (vướng cây) → mở rộng góc nhìn.
    const needH = Math.atan((totalW / 2 + margin) / stage.maxCamDist);
    wideFov = Math.min(80, Math.max(WIDE_FOV, ((2 * Math.atan(Math.tan(needH) / aspect)) * 180) / Math.PI));
    dist = stage.maxCamDist;
  }
  const wideShot = (side = 0) => ({
    mode: "fixed",
    position: { x: r2(cx + side * dist * 0.35), y: r2(1 + dist * 0.2), z: r2(cz - dist) },
    lookAt: { x: cx, y: r2(maxH * 0.45), z: r2(cz - 0.4) },
    fov: r2(wideFov),
  });

  // Cận: từ nhân vật lùi về phía điểm focus, lệch sang bên một chút.
  const closeShot = (p: (typeof placed)[number], alt: number) => {
    const dx = focus.x - p.x;
    const dz = focus.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const d = 1.3 + p.h * 1.5;
    const side = (alt % 2 === 0 ? 1 : -1) * 0.25 * d;
    return {
      mode: "fixed",
      position: { x: r2(p.x + ux * d - uz * side), y: r2(p.h * 0.8 + 0.25), z: r2(p.z + uz * d + ux * side) },
      // Nhìn hơi về phía trước thân (đầu con vật bốn chân nằm ở phía trước).
      lookAt: { x: r2(p.x + ux * 0.25 * p.h), y: r2(p.h * 0.62), z: r2(p.z + uz * 0.25 * p.h) },
      fov: CLOSE_FOV,
    };
  };

  // Qua vai: camera sau vai người nghe (phía gần camera chính), nhìn vào mặt người nói.
  const overShoulder = (speaker: (typeof placed)[number], listener: (typeof placed)[number]) => {
    const dx = speaker.x - listener.x;
    const dz = speaker.z - listener.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    // Đủ xa và lệch đủ để người nghe chỉ chiếm một mép khung hình.
    const back = 1.1 + 1.2 * listener.h;
    const side = 0.6 + 0.6 * listener.h;
    // Chọn bên vai lệch về phía camera chính (-z) để không bị cây phía sau che.
    const sign = ux > 0 ? -1 : 1; // vector vuông góc (-uz, ux)·sign có thành phần z âm
    const px = listener.x - ux * back - uz * side * sign;
    const pz = listener.z - uz * back + ux * side * sign;
    return {
      mode: "fixed",
      position: { x: r2(px), y: r2(listener.h * 0.9 + 0.2), z: r2(pz) },
      lookAt: { x: r2(speaker.x), y: r2(speaker.h * 0.62), z: r2(speaker.z) },
      fov: 42,
    };
  };

  // ---------------------------------------------------------------- nhân vật + đi vào cảnh
  const actions: Record<string, unknown>[] = [];
  const audio: Record<string, unknown>[] = [];
  const characters = placed.map((p, i) => {
    const walk = p.asset ? resolveClip(p.asset, "walk") : undefined;
    const fromLeft = p.x - cx < 0 || (p.x === cx && i % 2 === 0);
    let start = { x: p.x, z: p.z };
    let startHeading = p.heading;
    if (walk && p.asset) {
      const speed = p.asset.suggestedSpeed[walk] ?? 1.2;
      const t0 = r2(0.25 * i);
      const dur = r2(INTRO - t0);
      const d = Math.min(7, speed * dur);
      start = stage.entrance === "back" ? { x: p.x, z: r2(p.z + d) } : { x: r2(p.x + (fromLeft ? -d : d)), z: r2(p.z - 0.6) };
      startHeading = heading(p.x - start.x, p.z - start.z);
      actions.push(
        { id: `${p.c.id}_walk`, type: "animation", target: p.c.id, start: t0, duration: dur, clip: "walk" },
        { id: `${p.c.id}_in`, type: "moveTo", target: p.c.id, start: t0, duration: dur, to: { x: p.x, z: p.z } },
        { id: `${p.c.id}_face`, type: "turn", target: p.c.id, start: INTRO, duration: 0.5, heading: p.heading },
      );
      const stepAsset = stepsFor(registry, stage.surface);
      if (stepAsset) audio.push({ id: `${p.c.id}_steps`, kind: "sfx", asset: stepAsset, start: t0, duration: dur, loop: true, volume: stepVolume(p.h), fadeOut: 0.15 });
    }
    return {
      id: p.c.id,
      name: p.c.name[lang],
      asset: p.c.asset,
      position: { x: start.x, y: 0, z: start.z },
      heading: startHeading,
      ...(p.c.size !== "normal" ? { scale: CHARACTER_SIZES[p.c.size] } : {}),
      voice: voiceFor(registry, lang, p.c.voice),
    };
  });

  // ---------------------------------------------------------------- đồ vật + tương tác
  const byId = new Map(placed.map((p) => [p.c.id, p]));
  const lines = sc.lines;
  const steps = stepsFor(registry, stage.surface);
  const { props, busy } = buildInteractions(story, index, byId, stage, totalW, registry, actions, audio, steps);

  // ---------------------------------------------------------------- lời thoại, cử chỉ, camera
  const last = lines.length - 1;
  const dialogue = lines.map((line, i) => ({
    id: line.id,
    ...(line.speaker ? { speaker: line.speaker } : { voice: voiceFor(registry, lang, story.narratorVoice) }),
    text: line.text[lang]!,
    ...(line.emotion !== "neutral" ? { emotion: line.emotion } : {}),
    // Tương tác diễn ra ngay trước câu → lùi câu lại đúng bằng thời gian tương tác.
    start: i === 0 ? r2(INTRO + 0.6 + (busy.get(line.id) ?? 0)) : { after: lines[i - 1]!.id, gap: r2(GAP + (busy.get(line.id) ?? 0)) },
  }));

  // Mở đầu: cảnh toàn đẩy máy vào chậm trong lúc mọi người đi vào.
  actions.push({ id: "cam_intro", type: "camera", start: 0, duration: r2(INTRO + 0.45), shot: wideShot(-1), move: { dolly: 0.12 } });
  lines.forEach((line, i) => {
    const p = line.speaker ? byId.get(line.speaker) : undefined;
    if (p && line.gesture && p.asset && resolveClip(p.asset, line.gesture)) {
      const once = line.gesture === "wave" || line.gesture === "jump";
      actions.push({ id: `g_${line.id}`, type: "animation", target: p.c.id, clip: line.gesture, ...(once ? { loop: false } : {}), sync: { line: line.id } });
    } else if (p && p.asset && !line.gesture && EMOTION_CLIP[line.emotion] && !(isLast && i === last && story.ending !== "none")) {
      // Không có cử chỉ: dùng clip hợp cảm xúc nếu nhân vật có clip thật (vd. buồn → defeat).
      const clip = EMOTION_CLIP[line.emotion]!;
      const real = resolveClip(p.asset, clip);
      if (real && real !== p.asset.clipAliases.idle) actions.push({ id: `e_${line.id}`, type: "animation", target: p.c.id, clip, sync: { line: line.id } });
    }
    if (i === last) return;
    // Đối thoại hai người: xen kẽ cận và qua vai người nghe; người dẫn chuyện: cảnh toàn xoay nhẹ.
    const prev = i > 0 && lines[i - 1]!.speaker ? byId.get(lines[i - 1]!.speaker!) : undefined;
    // Người nghe to hơn hẳn người nói (bố mẹ, thú tròn) sẽ che khung → dùng cận thường.
    const ots = p && prev && prev !== p && i % 2 === 1 && prev.h <= p.h * 1.15 && Math.hypot(p.x - prev.x, p.z - prev.z) < 4.5 ? overShoulder(p, prev) : undefined;
    const shot = ots ?? (p ? closeShot(p, i) : wideShot(i % 2 ? 1 : 0));
    const move = p ? { dolly: 0.07 } : { pan: i % 2 ? -6 : 6 };
    actions.push({ id: `cam_${line.id}`, type: "camera", sync: { line: line.id, offset: -0.15, pad: r2(GAP - 0.15) }, shot, move });
  });

  // Kết: cảnh toàn + cả nhóm cùng nhảy / vẫy tay (nếu làm được).
  const endLine = lines[last]!.id;
  // Kết: kéo máy ra mượt thành cảnh toàn, nâng nhẹ.
  actions.push({ id: "cam_end", type: "camera", sync: { line: endLine, offset: -0.15, pad: 30 }, shot: wideShot(0), blend: 1.2, move: { dolly: -0.1, rise: 0.4 } });
  if (isLast && story.ending !== "none") {
    for (const p of placed) {
      if (lines[last]!.speaker === p.c.id && lines[last]!.gesture) continue;
      const clip = [story.ending, "victory", "yes"].find((g) => p.asset && resolveClip(p.asset, g) && resolveClip(p.asset, g) !== p.asset.clipAliases.idle);
      if (clip) actions.push({ id: `end_${p.c.id}`, type: "animation", target: p.c.id, clip, ...(clip === "wave" ? { loop: false } : {}), sync: { line: endLine, offset: -0.3, pad: 2 } });
    }
  }

  const music = ownMusic && story.music ? musicFor(registry, sc.mood ?? story.mood) : undefined;
  if (music) audio.push({ id: "bgm", kind: "music", asset: music, start: 0, loop: true, volume: 0.3, fadeIn: single ? 0.5 : 0.8, fadeOut: single ? 1.8 : 1.2 });
  const ambience = night && findAsset(registry, "amb_night") ? "amb_night" : stage.ambience;
  if (ambience && findAsset(registry, ambience)?.type === "audio") {
    audio.push({ id: "amb", kind: "sfx", asset: ambience, start: 0, loop: true, volume: 0.35, fadeIn: 1, fadeOut: 1 });
  }
  if (isLast && findAsset(registry, "sfx_chime")) audio.push({ id: "sfx_end", kind: "sfx", asset: "sfx_chime", sync: { line: endLine, at: "end", offset: 0.2 }, volume: 0.8 });

  return {
    version: 1,
    meta: { name: single ? story.title[lang] : `${story.title[lang]} – ${index + 1}`, duration: "auto", tail: isLast ? 2.5 : 1.5, fps: 30, width, height },
    environment: {
      asset: sc.environment,
      background: sky,
      fog: { color: sky, near: night ? 18 : 28, far: night ? 60 : 80 },
      lighting: { preset: tod?.lighting ?? stage.lighting ?? "day" },
      effects,
    },
    characters,
    props,
    camera: wideShot(-1),
    subtitles: { burnIn: true, size: aspect < 1 ? 0.035 : 0.05, position: "bottom", showSpeaker: true },
    mix: { duckMusic: true, duckLevel: 0.25, loudness: -14 },
    dialogue,
    actions,
    audio,
  };
}
