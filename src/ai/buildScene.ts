import { findAsset, resolveClip, type AssetEntry, type Registry } from "../schemas/asset.schema";
import type { Emotion, LightingPreset, WeatherEffect } from "../schemas/scene.schema";
import { buildInteractions, extent, faceToFace, TALK_GAP } from "./interactions";
import { CHARACTER_SIZES, frameSize, LOUDNESS, ONCE_GESTURES, VOCALS, type Format, type Lang, type Loudness, type Mood, type Resolution, type Story, type StoryEntrance } from "./story";

/**
 * Story đã duyệt + ngôn ngữ → Scene Script soạn thảo (dialogue "after", action "sync", duration "auto").
 * Tất định: cùng đầu vào → cùng scene. Resolver + validator sẵn có lo phần TTS và kiểm tra.
 *
 * Bố cục: nhân vật đứng thành vòng cung quanh "sân khấu" của bối cảnh, quay về phía camera (-z).
 * Mở đầu (theo scene.entrance): người nói đầu / cả nhóm bước vào từ mép khung, hoặc đứng sẵn → mỗi câu thoại: cận người nói, người dẫn chuyện: cảnh toàn
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
  /** Trong nhà: ánh sáng indoor (đêm → indoor_night), không có hiệu ứng ngoài trời. */
  indoor?: boolean;
  /** Cửa ra vào (tâm ô cửa trên sàn) + hướng đi ra ngoài – "leave" đi qua đây thay vì xuyên tường. */
  exit?: { x: number; z: number; out: { x: number; z: number } };
  /** Chỗ đặt hộp đồ chơi (câu "stow"). */
  toyBox?: { x: number; z: number };
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
  // Phòng 10.5 × 8.4 m (x ±5.25, z ±4.2), mặt trước để trống; đứng trên thảm, camera không lùi quá mép phòng.
  env_living_room: {
    center: { x: 0, z: 0.9 },
    halfWidth: 3,
    entrance: "sides",
    maxCamDist: 4.9,
    background: "#bfe3ff",
    lighting: "indoor",
    surface: "wood",
    indoor: true,
    exit: { x: -5.25, z: -1.05, out: { x: -1, z: 0 } },
    toyBox: { x: -2.3, z: 2.75 },
  },
};
const DEFAULT_STAGE: Stage = { center: { x: 0, z: 0 }, halfWidth: 3, entrance: "back", maxCamDist: 10, background: "#bde0fe" };

/** Thời gian mở cảnh tối đa khi có người đi vào (giây). */
const INTRO = 3.4;
/** Mở cảnh khi mọi người đứng sẵn: chỉ đẩy máy chậm cảnh toàn. */
const STILL_INTRO = 0.9;
/** Quãng đi vào tối đa (m): bước vào từ mép khung, không băng ngang cả màn hình. */
const ENTRY_DIST = 3;
/**
 * Điểm mọi người cùng hướng về nằm trước nhóm bao xa (m), theo số người: gần → quay vào nhau như đang trò chuyện
 * (2 người ≈ 30° mỗi bên), một mình thì nhìn thẳng camera.
 */
const focusAhead = (n: number) => (n <= 1 ? 6 : n === 2 ? 1.4 : 2.5);
/** Bước lại gần người nghe khi nói (m) và thời gian bước. */
const APPROACH = 0.45;
const APPROACH_TIME = 0.55;
/** Thời gian chuyển cảnh fade / dissolve (giây). */
const TRANSITION = 0.8;
const GAP = 0.45;
/** Cảnh phản ứng: cắt sang người nghe bấy nhiêu giây trước khi câu kết thúc. */
const REACT = 0.9;
const WIDE_FOV = 50;
const CLOSE_FOV = 45;

/**
 * Câu không có cử chỉ → clip hợp cảm xúc, lấy clip ĐẦU TIÊN nhân vật thật sự có (không có → engine diễn bằng tư thế):
 * câu thường → cử chỉ nói chuyện; buồn → đứng buồn / thất vọng; giận → khoa tay; ngạc nhiên / sợ → giật mình.
 */
const EMOTION_CLIPS: Record<Emotion, string[]> = {
  neutral: ["talk"],
  happy: ["talk", "yes"],
  sad: ["idle_sad", "defeat"],
  angry: ["angry", "talk"],
  surprised: ["surprised"],
  scared: ["scared"],
};

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
  /** 720p (mặc định) / 1080p. */
  resolution?: Resolution;
  /** Khung hình / giây (mặc định 30). */
  fps?: number;
  /** Chuẩn độ to: web -14 LUFS (mặc định) / tv -23 LUFS. */
  loudness?: Loudness;
  /** Tên phim lúc mở đầu + danh sách nhân vật cuối phim (mặc định bật). */
  titles?: boolean;
}

/** Nhãn danh sách cuối phim theo ngôn ngữ. */
const CREDITS: Record<Lang, { end: string; cast: string; made: string }> = {
  vi: { end: "Hết", cast: "Nhân vật", made: "Thực hiện bằng AutoCartoon" },
  en: { end: "The End", cast: "Cast", made: "Made with AutoCartoon" },
  zh: { end: "剧终", cast: "角色", made: "由 AutoCartoon 制作" },
  fr: { end: "Fin", cast: "Personnages", made: "Réalisé avec AutoCartoon" },
  es: { end: "Fin", cast: "Personajes", made: "Hecho con AutoCartoon" },
};
/** Mở cảnh đầu khi có tên phim: đủ lâu để đọc tên (giây). */
const TITLE_INTRO = 3;
/** Danh sách cuối phim hiện bấy nhiêu giây cuối cùng. */
const CREDITS_TIME = 4.5;

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
  const { width, height } = frameSize(opts.format, opts.resolution);
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
    meta: { name: story.title[lang], fps: opts.fps ?? 30, width, height },
    scenes: scenes.map((s, i) => ({
      id: s.id,
      file: s.file,
      ...(i > 0 ? { transition: { type: story.scenes[i]!.transition, duration: story.scenes[i]!.transition === "cut" ? 0.6 : TRANSITION } } : {}),
    })),
    audio,
    mix: { duckMusic: true, duckLevel: 0.25, loudness: LOUDNESS[opts.loudness ?? "web"] },
  };
  return { kind: "movie", movie, scenes };
}

function buildStoryScene(story: Story, index: number, lang: Lang, registry: Registry, opts: BuildOptions, single: boolean, ownMusic: boolean): Record<string, unknown> {
  if (!story.languages.includes(lang)) throw new Error(`Kịch bản không có ngôn ngữ "${lang}"`);
  const { width, height } = frameSize(opts.format, opts.resolution);
  const aspect = width / height;
  const titled = opts.titles !== false;
  const sc = story.scenes[index]!;
  const isLast = index === story.scenes.length - 1;
  const stage = STAGES[sc.environment] ?? DEFAULT_STAGE;
  const night = sc.time === "night";
  // Trong nhà: chỉ phân biệt ngày / đêm (ánh đèn); ngoài trời: theo thời điểm trong ngày.
  const tod = stage.indoor ? { lighting: night ? ("indoor_night" as const) : ("indoor" as const), background: night ? "#1d2748" : undefined } : sc.time ? TIME_OF_DAY[sc.time] : undefined;
  const sky = tod?.background ?? stage.background;
  // Đêm: đom đóm thay bướm; tuyết / lá rơi vẫn giữ.
  const effects = [...(stage.effects ?? []).filter((e) => !(night && (e === "butterflies" || e === "petals"))), ...(night && !stage.indoor ? (["fireflies"] as const) : [])];
  const { x: cx, z: cz } = stage.center;

  // ---------------------------------------------------------------- xếp nhân vật thành vòng cung
  const members = sc.cast.map((id) => story.characters.find((c) => c.id === id)).filter((c) => c !== undefined);
  const cast = members.map((c) => ({ c, asset: findAsset(registry, c.asset), h: heightOf(findAsset(registry, c.asset)) * CHARACTER_SIZES[c.size] }));
  // Đứng cạnh nhau hơi quay vào nhau (~30°): bề ngang khi xoay = mũi·sin + nửa ngang·cos, chừa 0.35 m.
  const lateral = (k: (typeof cast)[number]) => 0.5 * extent(k, "front") + 0.87 * extent(k, "side");
  let gaps = cast.slice(1).map((k, i) => Math.max(1.3, 0.55 * (k.h + cast[i]!.h) + 0.7, lateral(k) + lateral(cast[i]!) + 0.35));
  const want = gaps.reduce((s, g) => s + g, 0);
  // Quá rộng so với khoảng trống → khít lại (tối thiểu 1.1 m), vẫn rộng → so le hàng trước/sau.
  const squeeze = want > 2 * stage.halfWidth ? Math.max(0.6, (2 * stage.halfWidth) / want) : 1;
  gaps = gaps.map((g) => Math.max(1.1, g * squeeze));
  const totalW = gaps.reduce((s, g) => s + g, 0);
  const stagger = totalW > 2 * stage.halfWidth + 0.01;
  let acc = -totalW / 2;
  const focus = { x: cx, z: cz - focusAhead(cast.length) }; // điểm mọi người cùng hướng về (trước nhóm, phía camera)
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
  /** Khoảng lùi + góc nhìn để thấy cả nhóm rộng `halfW` hai bên tâm. */
  const framing = (halfW: number) => {
    const dist = Math.max((halfW + margin) / Math.tan(hHalf), (maxH + 0.8) / Math.tan(vHalf), 4.5);
    if (dist <= stage.maxCamDist) return { dist, fov: WIDE_FOV };
    // Không lùi được nữa (vướng cây) → mở rộng góc nhìn.
    const needH = Math.atan((halfW + margin) / stage.maxCamDist);
    return { dist: stage.maxCamDist, fov: Math.min(80, Math.max(WIDE_FOV, ((2 * Math.atan(Math.tan(needH) / aspect)) * 180) / Math.PI)) };
  };
  const groupFrame = framing(totalW / 2);
  const wideShot = (side = 0, frame = groupFrame) => ({
    mode: "fixed",
    position: { x: r2(cx + side * frame.dist * 0.35), y: r2(1 + frame.dist * 0.2), z: r2(cz - frame.dist) },
    lookAt: { x: cx, y: r2(maxH * 0.45), z: r2(cz - 0.4) },
    fov: r2(frame.fov),
  });

  // Cận: từ nhân vật lùi về phía điểm focus, lệch sang bên một chút – về phía người đang nói chuyện cùng (`toward`)
  // để hai người luôn được quay từ cùng một phía trục nhìn nhau (quy tắc 180°); không có ai → xen kẽ.
  const closeShot = (p: (typeof placed)[number], alt: number, toward?: { x: number }) => {
    const dx = focus.x - p.x;
    const dz = focus.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const d = 1.3 + p.h * 1.5;
    const side = (toward && Math.abs(toward.x - p.x) > 0.05 ? Math.sign(toward.x - p.x) : alt % 2 === 0 ? 1 : -1) * 0.25 * d;
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
    // Đủ xa, lệch và cao đủ để người nghe (đang quay về người nói) chỉ chiếm một mép khung hình.
    const back = 1.3 + 1.3 * listener.h;
    const side = 0.9 + 0.8 * listener.h;
    // Chọn bên vai lệch về phía camera chính (-z) để không bị cây phía sau che.
    const sign = ux > 0 ? -1 : 1; // vector vuông góc (-uz, ux)·sign có thành phần z âm
    const px = listener.x - ux * back - uz * side * sign;
    const pz = listener.z - uz * back + ux * side * sign;
    return {
      mode: "fixed",
      position: { x: r2(px), y: r2(listener.h * 1.15 + 0.3), z: r2(pz) },
      lookAt: { x: r2(speaker.x), y: r2(speaker.h * 0.62), z: r2(speaker.z) },
      fov: 42,
    };
  };

  // Hai người (hoặc người + món đồ) đứng ở chỗ mới: nhìn từ phía camera chính, lùi đủ để thấy cả hai.
  const twoShot = (p: (typeof placed)[number], at: { x: number; z: number }, other: { x: number; z: number }, alt: number) => {
    const mx = (at.x + other.x) / 2;
    const mz = (at.z + other.z) / 2;
    const span = Math.hypot(at.x - other.x, at.z - other.z);
    const d = Math.min(Math.max(2.4, 1.4 + span * 1.3 + p.h * 1.2), stage.maxCamDist * 0.85);
    // Lệch về phía GIỮA bối cảnh (ra phía tường / mép có đồ đạc che ống kính); ở giữa thì xen kẽ trái phải.
    const toward = Math.abs(cx - mx) > 0.5 ? Math.sign(cx - mx) : alt % 2 === 0 ? 1 : -1;
    const side = toward * 0.3 * d;
    // Không lùi quá mép bối cảnh (tường / cây phía camera), không ra sát hai bên.
    const z = Math.max(mz - d, cz - stage.maxCamDist);
    const lim = stage.halfWidth + 0.8;
    const x = Math.min(cx + lim, Math.max(cx - lim, mx + side));
    return {
      mode: "fixed",
      position: { x: r2(x), y: r2(0.55 + p.h * 0.9), z: r2(z) },
      lookAt: { x: r2(mx), y: r2(p.h * 0.5), z: r2(mz) },
      fov: 46,
    };
  };

  // ---------------------------------------------------------------- nhân vật + đi vào cảnh
  const actions: Record<string, unknown>[] = [];
  const audio: Record<string, unknown>[] = [];
  // Ai đi vào: mặc định cảnh đầu chỉ người nói đầu tiên, cảnh sau mọi người đã đứng sẵn.
  const entrance: StoryEntrance = sc.entrance ?? (index === 0 ? "speaker" : "none");
  const firstSpeaker = sc.lines.find((l) => l.speaker && sc.cast.includes(l.speaker))?.speaker ?? sc.cast[0];
  const walksIn = (id: string) => entrance === "walk" || (entrance === "speaker" && id === firstSpeaker);
  let intro = STILL_INTRO;
  let order = 0;
  const characters = placed.map((p, i) => {
    const walk = p.asset && walksIn(p.c.id) ? resolveClip(p.asset, "walk") : undefined;
    const fromLeft = p.x - cx < 0 || (p.x === cx && i % 2 === 0);
    let start = { x: p.x, z: p.z };
    let startHeading = p.heading;
    if (walk && p.asset) {
      const speed = p.asset.suggestedSpeed[walk] ?? 1.2;
      const t0 = r2(0.25 * order++);
      // Đi đúng tốc độ bước (không trượt chân): quãng ngắn → đến sớm hơn.
      const d = Math.min(ENTRY_DIST, speed * (INTRO - t0));
      const dur = r2(d / speed);
      const arrive = r2(t0 + dur);
      intro = Math.max(intro, arrive);
      start = stage.entrance === "back" ? { x: p.x, z: r2(p.z + d) } : { x: r2(p.x + (fromLeft ? -d : d)), z: r2(p.z - 0.4) };
      startHeading = heading(p.x - start.x, p.z - start.z);
      actions.push(
        { id: `${p.c.id}_walk`, type: "animation", target: p.c.id, start: t0, duration: dur, clip: "walk" },
        { id: `${p.c.id}_in`, type: "moveTo", target: p.c.id, start: t0, duration: dur, to: { x: p.x, z: p.z } },
        { id: `${p.c.id}_face`, type: "turn", target: p.c.id, start: arrive, duration: 0.5, heading: p.heading },
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

  // Cảnh đầu có tên phim: giữ cảnh toàn mở đầu đủ lâu để đọc.
  if (titled && index === 0) intro = Math.max(intro, TITLE_INTRO);

  // ---------------------------------------------------------------- đồ vật + tương tác
  const byId = new Map(placed.map((p) => [p.c.id, p]));
  const lines = sc.lines;
  const steps = stepsFor(registry, stage.surface);
  const { props, busy, leaving, displaced, after, stands, camEarly } = buildInteractions(story, index, byId, stage, totalW, registry, actions, audio, steps, focus);
  /** Nhân vật ở chỗ đang đứng khi nói câu `lineId` (có người đã đổi chỗ sau tương tác "stay"). */
  const posed = (p: (typeof placed)[number], lineId: string): (typeof placed)[number] => {
    const at = stands.get(lineId)?.get(p.c.id);
    return at ? { ...p, ...at } : p;
  };
  /** Cảnh toàn đủ rộng cho chỗ đứng hiện tại của mọi người (có người đứng lại ở mép → lùi thêm). */
  const wideAt = (lineId: string, side = 0) => {
    const at = stands.get(lineId);
    const half = Math.max(totalW / 2, ...[...(at?.values() ?? [])].map((q) => Math.abs(q.x - cx)));
    return wideShot(side, half > totalW / 2 + 0.05 ? framing(half) : groupFrame);
  };

  // ---------------------------------------------------------------- lời thoại, cử chỉ, camera
  const last = lines.length - 1;
  // Nói với ai: chỉ định sẵn / người cùng tương tác / người đáp lời kế tiếp / người vừa nói trước.
  const addressee = (i: number): string | undefined => {
    const line = lines[i]!;
    const me = line.speaker;
    if (!me) return undefined;
    const pick = line.to ?? line.interaction?.with ?? undefined;
    if (pick && pick !== me && byId.has(pick)) return pick;
    const other = (l: (typeof lines)[number]) => l.speaker && l.speaker !== me && byId.has(l.speaker);
    return (lines.slice(i + 1).find(other) ?? lines.slice(0, i).reverse().find(other))?.speaker ?? undefined;
  };
  /** Lệch trái / phải nhẹ theo chỗ người nói (camera nhìn về +z: bên phải khung hình = phía -x). */
  const panOf = (line: (typeof lines)[number]): number => {
    const who = line.speaker ? stands.get(line.id)?.get(line.speaker) : undefined;
    return who ? r2(Math.max(-1, Math.min(1, -(who.x - cx) / (stage.halfWidth + 1.5))) * 0.35) : 0;
  };
  /** Câu âm thanh không lời (nếu có) đứng ngay trước câu chính: phần diễn trước câu neo vào nó. */
  const vocalId = (line: (typeof lines)[number]) => (line.vocal && line.speaker ? `${line.id}_v` : undefined);
  const dialogue = lines.flatMap((line, i) => {
    // Tương tác diễn ra ngay trước câu → lùi câu lại đúng bằng thời gian tương tác.
    // + chờ người vừa tương tác đi về (khi câu này cần tới họ).
    const start = i === 0 ? r2(intro + 0.6 + (busy.get(line.id) ?? 0)) : { after: lines[i - 1]!.id, gap: r2(GAP + (after.get(lines[i - 1]!.id) ?? 0) + (busy.get(line.id) ?? 0)) };
    const pan = panOf(line);
    const common = {
      ...(line.speaker ? { speaker: line.speaker } : { voice: voiceFor(registry, lang, story.narratorVoice) }),
      ...(addressee(i) ? { to: addressee(i) } : {}),
      ...(line.emotion !== "neutral" ? { emotion: line.emotion } : {}),
      ...(pan ? { pan } : {}),
    };
    const v = vocalId(line);
    const main = { id: line.id, ...common, text: line.text[lang]!, start: v ? { after: v, gap: 0.12 } : start };
    return v ? [{ id: v, ...common, text: VOCALS[line.vocal!][lang], subtitle: false, start }, main] : [main];
  });
  // Câu ngạc nhiên đầu tiên của cảnh: tiếng lấp lánh.
  const firstSurprise = lines.find((l) => l.emotion === "surprised");
  if (firstSurprise && findAsset(registry, "sfx_sparkle")?.type === "audio") {
    audio.push({ id: `sfx_spark_${firstSurprise.id}`, kind: "sfx", asset: "sfx_sparkle", volume: 0.28, sync: { line: vocalId(firstSurprise) ?? firstSurprise.id, at: "start", offset: -0.05 } });
  }

  // Mở đầu: cảnh toàn đẩy máy vào chậm (trong lúc ai đó đi vào, nếu có).
  actions.push({ id: "cam_intro", type: "camera", start: 0, duration: r2(intro + 0.45), shot: wideShot(-1), move: { dolly: 0.12 } });
  /** Câu gần nhất có cảnh phản ứng (không cắt phản ứng hai câu liền). */
  let lastReact = -2;
  lines.forEach((line, i) => {
    const p = line.speaker ? byId.get(line.speaker) : undefined;
    if (p && line.gesture && p.asset && resolveClip(p.asset, line.gesture)) {
      const once = ONCE_GESTURES.includes(line.gesture);
      actions.push({ id: `g_${line.id}`, type: "animation", target: p.c.id, clip: line.gesture, ...(once ? { loop: false } : {}), sync: { line: line.id } });
    } else if (p && p.asset && !line.gesture && !(isLast && i === last && story.ending !== "none") && line.interaction?.type !== "walk" && line.interaction?.type !== "leave") {
      // Không có cử chỉ: clip hợp cảm xúc nếu nhân vật có clip thật (câu "walk" / "leave" đang đi trong lúc nói → bỏ qua).
      const asset = p.asset;
      const clip = EMOTION_CLIPS[line.emotion].find((c) => {
        const real = resolveClip(asset, c);
        return real && real !== asset.clipAliases.idle;
      });
      if (clip) actions.push({ id: `e_${line.id}`, type: "animation", target: p.c.id, clip, sync: { line: line.id } });
    }
    if (i === last) return;
    // Đối thoại hai người: xen kẽ cận và qua vai người nghe; người dẫn chuyện: cảnh toàn xoay nhẹ.
    const prevBase = i > 0 && lines[i - 1]!.speaker ? byId.get(lines[i - 1]!.speaker!) : undefined;
    const prev = prevBase && stands.get(line.id)?.has(prevBase.c.id) ? posed(prevBase, line.id) : undefined;
    const sp = p && posed(p, line.id);
    // Người nghe to hơn hẳn người nói (bố mẹ, thú tròn) sẽ che khung → dùng cận thường.
    const ots = sp && prev && prevBase !== p && i % 2 === 1 && prev.h <= sp.h * 1.15 && Math.hypot(sp.x - prev.x, sp.z - prev.z) < 4.5 ? overShoulder(sp, prev) : undefined;
    const moved = displaced.get(line.id);
    const mover = moved ? byId.get(moved.actor) : undefined;
    // Vừa đi tới người kia / món đồ → khung hai người tại chỗ đó (không cận chỗ đứng cũ).
    const toId = addressee(i);
    const listener = toId && stands.get(line.id)?.has(toId) ? posed(byId.get(toId)!, line.id) : undefined;
    const shot = mover && moved ? twoShot(mover, moved.at, moved.focus, i) : (ots ?? (sp ? closeShot(sp, i, listener) : wideAt(line.id, i % 2 ? 1 : 0)));
    const move = p ? { dolly: 0.07 } : { pan: i % 2 ? -6 : 6 };
    // Cảnh phản ứng: câu nhiều cảm xúc / câu hỏi đủ dài → cuối câu cắt sang mặt người nghe (họ gật, "lây" cảm xúc).
    const text = line.text[lang] ?? "";
    const react =
      !!sp && !!listener && !moved && i - lastReact > 2 && text.trim().split(/\s+/).length >= 7 && (line.emotion !== "neutral" || /[?!]\s*$/.test(text));
    const early = camEarly.get(line.id) ?? 0;
    const v = vocalId(line);
    // Có câu không lời phía trước: cùng khung hình, vào từ câu không lời (nối liền tới câu chính).
    if (v) actions.push({ id: `cam_${v}`, type: "camera", sync: { line: v, offset: r2(-0.15 - early), pad: -0.03 }, shot });
    actions.push({ id: `cam_${line.id}`, type: "camera", sync: { line: line.id, offset: v ? -0.15 : r2(-0.15 - early), pad: react ? -REACT : r2(GAP - 0.15) }, shot, move });
    if (react) {
      lastReact = i;
      actions.push({ id: `cam_${line.id}_react`, type: "camera", sync: { line: line.id, at: "end", offset: -REACT, duration: r2(REACT + GAP - 0.15) }, shot: closeShot(listener!, i + 1, sp), move: { dolly: 0.05 } });
    }
  });

  // Kết: cảnh toàn + cả nhóm cùng nhảy / vẫy tay (nếu làm được).
  const endLine = lines[last]!.id;
  // Kết: kéo máy ra mượt thành cảnh toàn, nâng nhẹ.
  actions.push({ id: "cam_end", type: "camera", sync: { line: vocalId(lines[last]!) ?? endLine, offset: -0.15, pad: 30 }, shot: wideAt(endLine, 0), blend: 1.2, move: { dolly: -0.1, rise: 0.4 } });
  if (isLast && story.ending !== "none") {
    for (const p of placed) {
      if ((lines[last]!.speaker === p.c.id && lines[last]!.gesture) || leaving.has(p.c.id)) continue;
      const clip = [story.ending, "victory", "yes"].find((g) => p.asset && resolveClip(p.asset, g) && resolveClip(p.asset, g) !== p.asset.clipAliases.idle);
      // Người vừa làm động tác ngay trước câu cuối (nhặt, cất, ôm…) → nhảy khi động tác xong (đầu câu).
      const busyActor = displaced.get(endLine)?.actor === p.c.id || (lines[last]!.action && (lines[last]!.action!.by ?? lines[last]!.speaker) === p.c.id);
      if (clip) actions.push({ id: `end_${p.c.id}`, type: "animation", target: p.c.id, clip, ...(clip === "wave" ? { loop: false } : {}), sync: { line: endLine, offset: busyActor ? 0.1 : -0.3, pad: 2 } });
    }
  }

  // Bước lại gần người nghe khi nói câu có cảm xúc / câu hỏi (mỗi người tối đa một lần mỗi cảnh), nói xong lùi về.
  // Bỏ qua câu có tương tác / đồ vật / cử chỉ (hoặc câu kế tiếp có) để không chồng chuyển động.
  const approached = new Set<string>();
  const occupied = (l: (typeof lines)[number] | undefined) => !!l && (!!l.action || !!l.interaction);
  const animatedOn = (who: string, ...ids: string[]) =>
    actions.some((a) => a.type === "animation" && a.target === who && ids.includes((a.sync as { line?: string } | undefined)?.line ?? ""));
  lines.forEach((line, i) => {
    const pBase = line.speaker ? byId.get(line.speaker) : undefined;
    const to = addressee(i);
    const qBase = to ? byId.get(to) : undefined;
    const p = pBase && posed(pBase, line.id);
    const q = qBase && stands.get(line.id)?.has(qBase.c.id) ? posed(qBase, line.id) : undefined;
    if (!p || !q || i === last || approached.has(p.c.id) || occupied(line) || occupied(lines[i + 1])) return;
    const text = line.text[lang] ?? "";
    // Câu quá ngắn: không kịp bước tới rồi lùi về.
    if (text.trim().split(/\s+/).length < 4) return;
    if (!(/[?!]\s*$/.test(text) || ["happy", "surprised", "angry"].includes(line.emotion))) return;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const dist = Math.hypot(dx, dz);
    const step = Math.min(APPROACH, dist - faceToFace(p, q, TALK_GAP));
    if (step < 0.2 || !p.asset || !resolveClip(p.asset, "walk") || animatedOn(p.c.id, line.id, lines[i + 1]!.id)) return;
    approached.add(p.c.id);
    const toward = heading(dx, dz);
    // Quay 3/4 về người nghe sau khi bước (vẫn thấy mặt trên camera).
    const threeQuarter = r2(p.heading + (((toward - p.heading + 540) % 360) - 180) * 0.6);
    actions.push(
      { id: `ap_${line.id}_walk`, type: "animation", target: p.c.id, clip: "walk", sync: { line: line.id, offset: 0, duration: APPROACH_TIME } },
      { id: `ap_${line.id}_in`, type: "moveTo", target: p.c.id, to: { x: r2(p.x + (dx / dist) * step), z: r2(p.z + (dz / dist) * step) }, sync: { line: line.id, offset: 0, duration: APPROACH_TIME } },
      { id: `ap_${line.id}_turn`, type: "turn", target: p.c.id, heading: threeQuarter, sync: { line: line.id, offset: APPROACH_TIME, duration: 0.3 } },
      { id: `ap_${line.id}_bwalk`, type: "animation", target: p.c.id, clip: "walk", sync: { line: line.id, at: "end", offset: 0.05, duration: 0.5 } },
      { id: `ap_${line.id}_back`, type: "moveTo", target: p.c.id, to: { x: p.x, z: p.z }, face: false, sync: { line: line.id, at: "end", offset: 0.05, duration: 0.5 } },
      { id: `ap_${line.id}_home`, type: "turn", target: p.c.id, heading: p.heading, sync: { line: line.id, at: "end", offset: 0.55, duration: 0.3 } },
    );
  });

  const music = ownMusic && story.music ? musicFor(registry, sc.mood ?? story.mood) : undefined;
  if (music) audio.push({ id: "bgm", kind: "music", asset: music, start: 0, loop: true, volume: 0.3, fadeIn: single ? 0.5 : 0.8, fadeOut: single ? 1.8 : 1.2 });
  const ambience = night && findAsset(registry, "amb_night") ? "amb_night" : stage.ambience;
  if (ambience && findAsset(registry, ambience)?.type === "audio") {
    audio.push({ id: "amb", kind: "sfx", asset: ambience, start: 0, loop: true, volume: 0.35, fadeIn: 1, fadeOut: 1 });
  }
  if (isLast && findAsset(registry, "sfx_chime")) audio.push({ id: "sfx_end", kind: "sfx", asset: "sfx_chime", sync: { line: endLine, at: "end", offset: 0.2 }, volume: 0.8 });

  return {
    version: 1,
    meta: { name: single ? story.title[lang] : `${story.title[lang]} – ${index + 1}`, duration: "auto", tail: isLast ? (titled ? CREDITS_TIME + 0.8 : 2.5) : 1.5, fps: opts.fps ?? 30, width, height },
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
    titles: [
      ...(titled && index === 0 ? [{ kind: "title", text: story.title[lang], start: 0.3, duration: r2(intro) }] : []),
      ...(titled && isLast
        ? [
            {
              kind: "credits",
              text: CREDITS[lang].end,
              lines: [story.title[lang], `${CREDITS[lang].cast}:`, story.characters.map((c) => c.name[lang]).join(" · "), CREDITS[lang].made],
              at: "end",
              duration: CREDITS_TIME,
            },
          ]
        : []),
    ],
    mix: { duckMusic: true, duckLevel: 0.25, loudness: LOUDNESS[opts.loudness ?? "web"] },
    dialogue,
    actions,
    audio,
  };
}
