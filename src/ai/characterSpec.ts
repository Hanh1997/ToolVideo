/**
 * Bản mô tả nhân vật người (CharacterSpec) – AI viết từ prompt, người dùng chỉnh trên form, Blender dựng thành GLB:
 *
 *   prompt ──AI──► CharacterSpec ──người chỉnh──► scripts/blender/gen_character.py ──► GLB (xương + mặt + hoạt ảnh) ──► registry
 *
 * normalizeCharacterSpec: mọi trường đều có mặc định, giá trị lạ bị thay bằng mặc định (không bao giờ lỗi)
 * → AI trả thiếu / sai vẫn dựng được.
 */

export const GENDERS = { male: "Nam", female: "Nữ" } as const;
export const AGES = { toddler: "Em bé (2–4 tuổi)", child: "Trẻ em", teen: "Thiếu niên", adult: "Người lớn", elder: "Người già" } as const;
export const BUILDS = { slim: "Gầy", average: "Vừa", chubby: "Mũm mĩm" } as const;
/** Tỉ lệ cơ thể. base = như nhân vật gốc (không áo): chân / thân / tay dài hơn, đầu nhỏ hơn – bật cho nhân vật mặc đồ
 *  muốn cùng dáng với nhân vật gốc (vd. Bé Tí ← Bé Tí – Base). Nhân vật không áo luôn dùng base. */
export const PROPORTIONS = { default: "Mặc định", base: "Như nhân vật gốc" } as const;
export const HAIR_STYLES = {
  bald: "Hói (vành tóc)",
  short: "Ngắn",
  spiky: "Vuốt dựng",
  curly: "Xoăn",
  afro: "Xù (afro)",
  bob: "Bob ngang vai",
  long: "Dài",
  ponytail: "Đuôi ngựa",
  pigtails: "Buộc hai bên",
  bun: "Búi",
} as const;
export const TOP_STYLES = { tshirt: "Áo phông", shirt: "Sơ mi có cổ", longsleeve: "Áo dài tay", hoodie: "Áo hoodie", tank: "Áo ba lỗ", dress: "Váy liền", none: "Không mặc (nhân vật gốc)" } as const;
export const PATTERNS = { none: "Trơn", stripes: "Sọc ngang", dots: "Chấm bi", plaid: "Kẻ caro", flowers: "Hoa" } as const;
export const BOTTOM_STYLES = { pants: "Quần dài", shorts: "Quần short", skirt: "Chân váy", none: "Không mặc (nhân vật gốc)" } as const;
export const SHOE_STYLES = { sneaker: "Giày thể thao", barefoot: "Chân trần" } as const;
export const ACCESSORIES = {
  glasses: "Kính cận",
  sunglasses: "Kính râm",
  cap: "Mũ lưỡi trai",
  beanie: "Mũ len",
  sunhat: "Mũ rộng vành",
  backpack: "Ba lô",
  necklace: "Dây chuyền",
  earrings: "Khuyên tai",
  watch: "Đồng hồ",
  bowtie: "Nơ cổ",
  tie: "Cà vạt",
  scarf: "Khăn quàng",
} as const;
export const FACIAL_HAIR = { none: "Không", mustache: "Ria mép", beard: "Râu quai nón" } as const;

// Khuôn mặt: mỗi nhân vật một vẻ (dáng đầu, mắt, lông mày, mũi, miệng, tai, má, nếp nhăn).
export const FACE_SHAPES = { oval: "Trái xoan", round: "Tròn", square: "Vuông (hàm bạnh)", long: "Dài", heart: "Trái tim (cằm nhọn)" } as const;
export const EYE_SHAPES = { round: "Tròn", big: "To tròn", almond: "Hạnh nhân (xếch)", narrow: "Híp", droopy: "Mí sụp (hiền)" } as const;
export const BROW_STYLES = { normal: "Vừa", thick: "Rậm", thin: "Mảnh", arched: "Cong vút", flat: "Ngang", bushy: "Rậm, rủ đuôi" } as const;
export const NOSE_STYLES = { normal: "Vừa", button: "Nhỏ xinh", round: "Tròn to", long: "Dài", wide: "Bè", pointy: "Nhọn, cao" } as const;
export const MOUTH_STYLES = { normal: "Vừa", small: "Nhỏ", wide: "Rộng", full: "Môi dày" } as const;
export const EAR_STYLES = { normal: "Vừa", small: "Nhỏ", big: "To, vểnh" } as const;
export const CHEEK_STYLES = { blush: "Má hồng nhẹ", rosy: "Má đỏ hây", freckles: "Tàn nhang", none: "Không" } as const;

type Key<T> = keyof T & string;
export type Gender = Key<typeof GENDERS>;
export type Age = Key<typeof AGES>;
export type Accessory = Key<typeof ACCESSORIES>;

/** Chỉ một trong các mũ / kính được đội cùng lúc. */
const EXCLUSIVE: Accessory[][] = [
  ["cap", "beanie", "sunhat"],
  ["glasses", "sunglasses"],
  ["bowtie", "tie"],
];

export function normalizeHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${[...s].map((c) => c + c).join("")}`;
  return undefined;
}

export interface CharacterSpec {
  /** Tên hiển thị trong thư viện (tiếng Việt). */
  name: string;
  gender: Gender;
  age: Age;
  build: Key<typeof BUILDS>;
  proportions: Key<typeof PROPORTIONS>;
  /** Chiều cao riêng (m, 0.8–2.0) – bỏ trống = theo tuổi / giới (specHeight). Cao hơn mặc định → chân / thân dài
   *  hơn (đầu nhỏ đi tương đối), không chỉ phóng to cả người. */
  height?: number;
  skin: string;
  /** Màu tròng mắt. */
  eyes: string;
  hair: { style: Key<typeof HAIR_STYLES>; color: string };
  top: { style: Key<typeof TOP_STYLES>; color: string; pattern: Key<typeof PATTERNS>; patternColor: string };
  /** Bỏ qua khi top.style = dress. */
  bottom: { style: Key<typeof BOTTOM_STYLES>; color: string };
  shoes: { style: Key<typeof SHOE_STYLES>; color: string; accent: string };
  accessories: Accessory[];
  /** Mũ / ba lô / gọng kính / cà vạt / khăn / dây buộc tóc. */
  accessoryColor: string;
  facialHair: Key<typeof FACIAL_HAIR>;
  face: CharacterFace;
}

export interface CharacterFace {
  shape: Key<typeof FACE_SHAPES>;
  eyes: Key<typeof EYE_SHAPES>;
  brows: Key<typeof BROW_STYLES>;
  nose: Key<typeof NOSE_STYLES>;
  mouth: Key<typeof MOUTH_STYLES>;
  ears: Key<typeof EAR_STYLES>;
  cheeks: Key<typeof CHEEK_STYLES>;
  /** Nếp nhăn đuôi mắt, trán, rãnh cười (mặc định: người già). */
  wrinkles: boolean;
}

/** Băm tên (FNV-1a) → chọn nét mặt mặc định tất định: cùng tên cùng mặt, khác tên khác mặt. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/**
 * Nét mặt mặc định khi AI / người dùng không ghi: chọn theo tuổi / giới (trẻ em mắt to, mũi nhỏ; người già mí sụp,
 * lông mày rậm; phụ nữ lông mày mảnh…) rồi lấy một phương án theo tên – để hai nhân vật cùng lứa không trùng mặt.
 */
function defaultFace(s: Pick<CharacterSpec, "name" | "gender" | "age">): CharacterFace {
  const f = s.gender === "female";
  const kid = s.age === "toddler" || s.age === "child";
  const old = s.age === "elder";
  const h = hash(`${s.name}|${s.gender}|${s.age}`);
  const at = <T>(list: T[], salt: number): T => list[(h >>> salt) % list.length]!;
  return {
    shape: at<CharacterFace["shape"]>(kid ? ["round", "oval", "heart"] : f ? ["oval", "heart", "round", "long"] : ["oval", "square", "long", "round"], 0),
    eyes: at<CharacterFace["eyes"]>(kid ? ["big", "round", "almond"] : old ? ["droopy", "narrow", "round"] : f ? ["almond", "round", "big"] : ["round", "almond", "narrow", "droopy"], 3),
    brows: at<CharacterFace["brows"]>(old ? ["bushy", "thin", "flat"] : f ? ["thin", "arched", "normal"] : kid ? ["normal", "thin", "arched"] : ["thick", "flat", "normal"], 6),
    nose: at<CharacterFace["nose"]>(kid ? ["button", "normal", "round"] : f ? ["button", "pointy", "normal"] : ["normal", "long", "wide", "round", "pointy"], 9),
    mouth: at<CharacterFace["mouth"]>(f ? ["full", "small", "normal"] : ["normal", "wide", "small"], 12),
    ears: at<CharacterFace["ears"]>(kid ? ["normal", "big", "small"] : ["normal", "small", "big"], 15),
    cheeks: at<CharacterFace["cheeks"]>(kid ? ["rosy", "blush", "freckles"] : f ? ["blush", "rosy", "freckles"] : ["none", "blush", "freckles"], 18),
    wrinkles: old,
  };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const pick = <T extends Record<string, string>>(values: T, v: unknown, d: Key<T>): Key<T> => (typeof v === "string" && Object.hasOwn(values, v) ? (v as Key<T>) : d);

export function normalizeCharacterSpec(input: unknown): CharacterSpec {
  const v = rec(input);
  const hair = rec(v.hair);
  const top = rec(v.top);
  const bottom = rec(v.bottom);
  const shoes = rec(v.shoes);
  const list = Array.isArray(v.accessories) ? [...new Set(v.accessories.filter((a): a is Accessory => typeof a === "string" && Object.hasOwn(ACCESSORIES, a)))] : [];
  const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 40) : "Nhân vật mới";
  const gender = pick(GENDERS, v.gender, "male");
  const age = pick(AGES, v.age, "adult");
  const spec: CharacterSpec = {
    name,
    gender,
    age,
    build: pick(BUILDS, v.build, "average"),
    proportions: pick(PROPORTIONS, v.proportions, "default"),
    ...(typeof v.height === "number" && v.height >= 0.8 && v.height <= 2.0 ? { height: Math.round(v.height * 100) / 100 } : {}),
    skin: normalizeHex(v.skin) ?? "#f1c9a5",
    eyes: normalizeHex(v.eyes) ?? "#4a2f1b",
    hair: { style: pick(HAIR_STYLES, hair.style, "short"), color: normalizeHex(hair.color) ?? "#3b2a20" },
    top: {
      style: pick(TOP_STYLES, top.style, "tshirt"),
      color: normalizeHex(top.color) ?? "#4dabf7",
      pattern: pick(PATTERNS, top.pattern, "none"),
      patternColor: normalizeHex(top.patternColor) ?? "#ffffff",
    },
    bottom: { style: pick(BOTTOM_STYLES, bottom.style, "pants"), color: normalizeHex(bottom.color) ?? "#34495e" },
    shoes: { style: pick(SHOE_STYLES, shoes.style, "sneaker"), color: normalizeHex(shoes.color) ?? "#ffffff", accent: normalizeHex(shoes.accent) ?? "#e03131" },
    // nhóm loại trừ (một mũ, một kính, nơ hoặc cà vạt): giữ món đầu tiên
    accessories: list.filter((a, i) => !EXCLUSIVE.some((g) => g.includes(a) && list.slice(0, i).some((b) => g.includes(b)))),
    accessoryColor: normalizeHex(v.accessoryColor) ?? "#ffd43b",
    facialHair: pick(FACIAL_HAIR, v.facialHair, "none"),
    face: normalizeFace(v.face, defaultFace({ name, gender, age })),
  };
  // Trẻ em / phụ nữ không có râu.
  if (spec.gender === "female" || spec.age === "toddler" || spec.age === "child") spec.facialHair = "none";
  return spec;
}

function normalizeFace(input: unknown, d: CharacterFace): CharacterFace {
  const face = rec(input);
  return {
    shape: pick(FACE_SHAPES, face.shape, d.shape),
    eyes: pick(EYE_SHAPES, face.eyes, d.eyes),
    brows: pick(BROW_STYLES, face.brows, d.brows),
    nose: pick(NOSE_STYLES, face.nose, d.nose),
    mouth: pick(MOUTH_STYLES, face.mouth, d.mouth),
    ears: pick(EAR_STYLES, face.ears, d.ears),
    cheeks: pick(CHEEK_STYLES, face.cheeks, d.cheeks),
    wrinkles: typeof face.wrinkles === "boolean" ? face.wrinkles : d.wrinkles,
  };
}

export const DEFAULT_SPEC: CharacterSpec = normalizeCharacterSpec({});

/** Chiều cao (m) ghi vào registry – engine co model về đúng chiều cao này. */
export function specHeight(s: Pick<CharacterSpec, "age" | "gender" | "height">): number {
  if (s.height) return s.height;
  return ageHeight(s);
}

/** Chiều cao mặc định theo tuổi / giới (gen_character.py dùng cùng bảng để co giãn chân / thân theo spec.height). */
export function ageHeight(s: Pick<CharacterSpec, "age" | "gender">): number {
  const f = s.gender === "female";
  return { toddler: 0.95, child: 1.2, teen: f ? 1.55 : 1.6, adult: f ? 1.65 : 1.75, elder: f ? 1.58 : 1.65 }[s.age];
}

/** Nhãn thư viện (tiếng Anh, như các asset khác) – AI kịch bản dựa vào nhãn để chọn vai. */
export function specTags(s: CharacterSpec): string[] {
  const f = s.gender === "female";
  const who = {
    toddler: ["toddler", "kid", "baby", f ? "girl" : "boy"],
    child: ["kid", "child", f ? "girl" : "boy"],
    teen: ["teen", f ? "girl" : "boy"],
    adult: [f ? "woman" : "man", "adult", f ? "mom" : "dad"],
    elder: ["old", "elder", f ? "grandma" : "grandpa"],
  }[s.age];
  return ["character", "human", "ai-generated", ...who, ...s.accessories.filter((a) => ["glasses", "sunglasses", "backpack"].includes(a))];
}

/** Mô tả ngắn cho AI (thiết kế) – liệt kê giá trị cho phép. */
export function specGuide(): string {
  const list = (o: Record<string, string>) => Object.keys(o).join(" | ");
  return [
    `name: short Vietnamese display name (e.g. "Bé Na", "Ông Ba", "Cô giáo Lan")`,
    `gender: ${list(GENDERS)}`,
    `age: ${list(AGES)}`,
    `build: ${list(BUILDS)}`,
    `skin, eyes: "#rrggbb" (natural skin tones unless the prompt says otherwise; eyes = iris colour)`,
    `hair: { style: ${list(HAIR_STYLES)}, color: "#rrggbb" } (elder → grey/white; bald = ring of hair on the sides)`,
    `top: { style: ${list(TOP_STYLES)}, color, pattern: ${list(PATTERNS)}, patternColor } ("none" only for an unclothed base mannequin)`,
    `bottom: { style: ${list(BOTTOM_STYLES)}, color } (ignored when top.style = dress)`,
    `shoes: { style: ${list(SHOE_STYLES)}, color, accent }`,
    `accessories: array of ${list(ACCESSORIES)} (at most one hat, one pair of glasses, bowtie OR tie; usually 0–3 items)`,
    `accessoryColor: "#rrggbb" (hat / backpack / glasses frame / tie / scarf / hair tie)`,
    `facialHair: ${list(FACIAL_HAIR)} (adult/elder men only)`,
    `face: { shape: ${list(FACE_SHAPES)}, eyes: ${list(EYE_SHAPES)}, brows: ${list(BROW_STYLES)}, nose: ${list(NOSE_STYLES)},`,
    `        mouth: ${list(MOUTH_STYLES)}, ears: ${list(EAR_STYLES)}, cheeks: ${list(CHEEK_STYLES)}, wrinkles: true|false }`,
    `      (a DISTINCTIVE face that fits age & personality: kids big/round eyes + button nose; elders droopy eyes, bushy brows, wrinkles;`,
    `       stern → flat/thick brows + square face; gentle → droopy eyes; cheeky → freckles / big ears)`,
  ].join("\n");
}
