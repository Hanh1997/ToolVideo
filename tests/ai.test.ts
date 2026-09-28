import { describe, expect, it } from "vitest";
import { buildScene, buildStory } from "../src/ai/buildScene";
import { checkCast, checkStory, normalizeStory, type Story } from "../src/ai/story";
import { MovieSchema } from "../src/movie/movie";
import { resolveScene } from "../src/tts/resolveScene";
import { validateScene } from "../src/validation/validateScene";
import { fakeTts, registry } from "./helpers";

/** Kịch bản mẫu như AI trả về (2 ngôn ngữ, có người dẫn chuyện, nhân vật có/không có clip walk). */
const sample = (): Story => ({
  languages: ["vi", "en"],
  title: { vi: "Chia sẻ là vui", en: "Sharing is fun" },
  summary: { vi: "Cáo học cách chia sẻ.", en: "Fox learns to share." },
  music: true,
  mood: "happy",
  narratorVoice: "female",
  ending: "dance",
  characters: [
    { id: "fox", asset: "char_k_animal_fox", voice: "squeaky", name: { vi: "Cáo", en: "Fox" }, size: "normal" },
    { id: "bunny", asset: "char_k_animal_bunny", voice: "child", name: { vi: "Thỏ", en: "Bunny" }, size: "normal" },
    { id: "bear", asset: "char_k_animal_panda", voice: "deep", name: { vi: "Gấu", en: "Panda" }, size: "big" },
  ],
  objects: [],
  scenes: [
    {
      id: "forest",
      environment: "env_forest",
      cast: ["fox", "bunny", "bear"],
      transition: "cut", mood: null, time: null,
      lines: [
        { id: "l1", speaker: null, gesture: null, text: { vi: "Trong rừng xanh có một giỏ dâu.", en: "In the forest there is a basket of berries." }, emotion: "neutral", action: null },
        { id: "l2", speaker: "fox", gesture: "yes", text: { vi: "Dâu này của mình!", en: "These berries are mine!" }, emotion: "neutral", action: null },
        { id: "l3", speaker: "bunny", gesture: "no", text: { vi: "Cho mình một ít nhé?", en: "Can I have some?" }, emotion: "neutral", action: null },
        { id: "l4", speaker: "bear", gesture: null, text: { vi: "Chia sẻ thì ai cũng vui.", en: "Sharing makes everyone happy." }, emotion: "neutral", action: null },
        { id: "l5", speaker: "fox", gesture: "wave", text: { vi: "Cùng ăn nào các bạn!", en: "Let's eat together!" }, emotion: "neutral", action: null },
      ],
    },
  ],
});

/** Cùng câu chuyện, chia 3 cảnh ở 3 bối cảnh; cảnh 2 chỉ có cáo và thỏ. */
const multi = (): Story => {
  const s = sample();
  const lines = s.scenes[0]!.lines;
  s.scenes = [
    { id: "forest", environment: "env_forest", cast: ["fox", "bunny", "bear"], transition: "cut", mood: null, time: null, lines: lines.slice(0, 2) },
    { id: "meadow", environment: "env_meadow", cast: ["fox", "bunny"], transition: "fade", mood: null, time: null, lines: [lines[2]!, { ...lines[4]!, id: "l5b", gesture: null }] },
    { id: "farm", environment: "env_farm", cast: ["fox", "bunny", "bear"], transition: "dissolve", mood: null, time: null, lines: [lines[3]!, lines[4]!] },
  ];
  return s;
};

describe("AI kịch bản – kiểm tra Story", () => {
  it("chấp nhận kịch bản hợp lệ", () => {
    expect(checkStory(sample(), registry).issues).toEqual([]);
  });

  it("báo id nhân vật/bối cảnh không có, người nói lạ, thiếu bản dịch", () => {
    const s = sample();
    const sc = s.scenes[0]!;
    sc.environment = "env_moon";
    s.characters[0]!.asset = "char_unicorn";
    sc.lines[1]!.speaker = "dragon";
    delete sc.lines[2]!.text.en;
    const paths = checkStory(s, registry).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["scenes.0.environment", "characters.0.asset", "scenes.0.lines.1.speaker", "scenes.0.lines.2.text.en"]));
  });

  it("không cho chọn cá (không có bối cảnh dưới nước)", () => {
    const s = sample();
    s.characters[0]!.asset = "char_fish_clownfish";
    expect(checkStory(s, registry).issues.map((i) => i.path)).toContain("characters.0.asset");
  });
});

describe("AI kịch bản – nhiều khung cảnh", () => {
  it("chuyển kịch bản cũ (environment + lines) thành một cảnh", () => {
    const { scenes, ...rest } = sample();
    const legacy = { ...rest, environment: "env_forest", lines: scenes[0]!.lines };
    const { story, issues } = checkStory(legacy, registry);
    expect(issues).toEqual([]);
    expect(story!.scenes).toHaveLength(1);
    expect(story!.scenes[0]).toMatchObject({ environment: "env_forest", cast: ["fox", "bunny", "bear"] });
    expect(normalizeStory(sample())).toEqual(sample());
  });

  it("chấp nhận kịch bản 3 cảnh; báo người nói không có mặt, id câu trùng giữa các cảnh", () => {
    expect(checkStory(multi(), registry).issues).toEqual([]);
    const s = multi();
    s.scenes[1]!.lines[0]!.speaker = "bear"; // gấu không có ở cảnh 2
    s.scenes[2]!.lines[0]!.id = "l1";
    s.scenes[2]!.cast.push("owl");
    const paths = checkStory(s, registry).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["scenes.1.lines.0.speaker", "scenes.2.lines.0.id", "scenes.2.cast.3"]));
  });

  it("dựng movie: mỗi cảnh qua resolver + validator, nhạc ở cấp movie, kết chỉ ở cảnh cuối", async () => {
    const built = buildStory(multi(), "vi", registry);
    if (built.kind !== "movie") throw new Error("phải là movie");
    const movie = MovieSchema.parse(built.movie);
    expect(movie.scenes.map((s) => [s.id, s.file, s.transition.type])).toEqual([
      ["forest", "scenes/01-forest.json", "cut"],
      ["meadow", "scenes/02-meadow.json", "fade"],
      ["farm", "scenes/03-farm.json", "dissolve"],
    ]);
    expect(movie.audio.map((a) => a.id)).toEqual(["bgm"]);
    for (const [i, sc] of built.scenes.entries()) {
      const r = await resolveScene(sc.scene, registry, fakeTts);
      expect(r.issues).toEqual([]);
      const v = validateScene(r.scene, registry);
      expect(v.ok ? [] : v.issues).toEqual([]);
      if (!v.ok) continue;
      expect(v.scene.environment.asset).toBe(multi().scenes[i]!.environment);
      expect(v.scene.characters.map((c) => c.id)).toEqual(multi().scenes[i]!.cast);
      expect(v.scene.audio.some((a) => a.kind === "music")).toBe(false);
      const isLast = i === built.scenes.length - 1;
      expect(v.scene.actions.some((a) => a.id.startsWith("end_"))).toBe(isLast);
      expect(v.scene.audio.some((a) => a.id === "sfx_end")).toBe(isLast);
    }
  });

  it("kịch bản một cảnh vẫn ra scene.json như cũ", () => {
    const built = buildStory(sample(), "vi", registry);
    expect(built.kind).toBe("scene");
    expect(() => buildScene(multi(), "vi", registry)).toThrow();
  });
});

describe("AI kịch bản – dựng Scene", () => {
  for (const lang of ["vi", "en"] as const) {
    for (const format of ["16x9", "9x16"] as const) {
      it(`${lang} ${format}: scene qua resolver + validator`, async () => {
        const raw = buildScene(sample(), lang, registry, { format });
        const r = await resolveScene(raw, registry, fakeTts);
        expect(r.issues).toEqual([]);
        const v = validateScene(r.scene, registry);
        expect(v.ok ? [] : v.issues).toEqual([]);
      });
    }
  }

  it("dùng giọng đúng ngôn ngữ, tên nhân vật theo ngôn ngữ, tất định", () => {
    const a = buildScene(sample(), "en", registry) as { characters: { voice: string; name: string }[]; dialogue: { text: string; voice?: string }[] };
    expect(a.characters.map((c) => c.voice)).toEqual(["voice_en_squeaky", "voice_en_child", "voice_en_deep"]);
    expect(a.characters[0]!.name).toBe("Fox");
    expect(a.dialogue[0]).toMatchObject({ voice: "voice_en_female", text: "In the forest there is a basket of berries." });
    expect(buildScene(sample(), "en", registry)).toEqual(a);
  });

  it("từ chối ngôn ngữ không có trong kịch bản", () => {
    expect(() => buildScene(sample(), "fr", registry)).toThrow();
  });
});

/** Cáo con hái hoa ở đồng hoa, ngậm về nông trại tặng mẹ. */
const flowerStory = (): Story => {
  const line = (id: string, speaker: string | null, vi: string, action: Story["scenes"][number]["lines"][number]["action"] = null) => ({
    id,
    speaker,
    gesture: null,
    emotion: "neutral" as const,
    text: { vi, en: vi },
    action,
  });
  return {
    languages: ["vi", "en"],
    title: { vi: "Hoa tặng mẹ", en: "A flower for mom" },
    summary: { vi: "Cáo con hái hoa tặng mẹ.", en: "Little fox picks a flower for mom." },
    music: true,
    mood: "happy",
    narratorVoice: "female",
    ending: "dance",
    characters: [
      { id: "kit", asset: "char_k_animal_fox", voice: "child", name: { vi: "Cáo Con", en: "Kit" }, size: "normal" },
      { id: "mom", asset: "char_k_animal_fox", voice: "female", name: { vi: "Cáo Mẹ", en: "Mom" }, size: "big" },
      { id: "girl", asset: "char_k_animal_bunny", voice: "child", name: { vi: "Thỏ Na", en: "Na" }, size: "normal" },
    ],
    objects: [{ id: "rose", kind: "flower_red", name: { vi: "bông hoa đỏ", en: "red flower" }, scene: "meadow", heldBy: null }],
    scenes: [
      {
        id: "meadow",
        environment: "env_meadow",
        cast: ["kit", "girl"],
        transition: "cut", mood: null, time: null,
        lines: [
          line("l1", null, "Cáo con đi tìm quà cho mẹ."),
          line("l2", "kit", "Bông hoa này đẹp quá!", { type: "pickup", object: "rose", to: null, by: null }),
          line("l3", "girl", "Mẹ bạn sẽ thích lắm đó."),
        ],
      },
      {
        id: "farm",
        environment: "env_farm",
        cast: ["kit", "mom"],
        transition: "fade", mood: null, time: null,
        lines: [
          line("l4", "kit", "Con tặng mẹ nè!", { type: "give", object: "rose", to: "mom", by: null }),
          line("l5", "mom", "Cảm ơn con yêu!"),
        ],
      },
    ],
  };
};

describe("AI kịch bản – đồ vật", () => {
  it("kịch bản nhặt → mang sang cảnh sau → trao hợp lệ", () => {
    expect(checkStory(flowerStory(), registry).issues).toEqual([]);
  });

  it("báo lỗi: nhặt đồ ở cảnh khác, trao đồ không cầm, loại đồ vật lạ", () => {
    const s = flowerStory();
    s.objects[0]!.scene = "farm";
    expect(checkStory(s, registry).issues.map((i) => i.path)).toContain("scenes.0.lines.1.action");
    const g = flowerStory();
    g.scenes[1]!.lines[0]!.action = { type: "give", object: "rose", to: "mom", by: "mom" };
    expect(checkStory(g, registry).issues.map((i) => i.message).join()).toMatch(/not holding/);
    const two = flowerStory();
    two.objects.push({ id: "shroom", kind: "mushroom", name: { vi: "nấm", en: "mushroom" }, scene: "meadow", heldBy: null });
    two.scenes[0]!.lines[2] = { ...two.scenes[0]!.lines[2]!, speaker: "kit", action: { type: "pickup", object: "shroom", to: null, by: null } };
    expect(checkStory(two, registry).issues.map((i) => i.message).join()).toMatch(/one object at a time/);
    const k = flowerStory();
    k.objects[0]!.kind = "unicorn_horn";
    expect(checkStory(k, registry).issues.map((i) => i.path)).toContain("objects.0.kind");
  });

  it("dựng cảnh: hoa + bụi hoa đặt sẵn, nhặt/gắn trước câu thoại, cảnh sau vẫn ngậm hoa rồi trao", async () => {
    const built = buildStory(flowerStory(), "vi", registry);
    if (built.kind !== "movie") throw new Error("phải là movie");
    const scenes = [];
    for (const sc of built.scenes) {
      const r = await resolveScene(sc.scene, registry, fakeTts);
      expect(r.issues).toEqual([]);
      const v = validateScene(r.scene, registry);
      expect(v.ok ? [] : v.issues).toEqual([]);
      if (v.ok) scenes.push(v.scene);
    }
    const [meadow, farm] = scenes;
    expect(meadow!.props.map((p) => p.id)).toEqual(expect.arrayContaining(["rose", "rose_c0", "rose_c1", "rose_c2"]));
    const pick = meadow!.actions.find((a) => a.type === "attach" && a.target === "rose")!;
    expect(pick).toMatchObject({ to: "kit" });
    const l2 = meadow!.dialogue.find((l) => l.id === "l2")!;
    expect(pick.start).toBeLessThan(l2.start); // nhặt xong rồi mới nói
    // Về lại chỗ đứng trước khi nói.
    const moves = meadow!.actions.filter((a) => a.type === "moveTo" && a.target === "kit" && a.id.startsWith("l2_"));
    expect(moves.at(-1)!.start + moves.at(-1)!.duration).toBeLessThanOrEqual(l2.start + 1e-6);

    expect(farm!.actions.find((a) => a.id === "hold_rose")).toMatchObject({ type: "attach", to: "kit", start: 0 });
    const give = farm!.actions.find((a) => a.type === "attach" && a.target === "rose" && a.id !== "hold_rose")!;
    expect(give).toMatchObject({ to: "mom" });
    expect(give.start).toBeLessThan(farm!.dialogue.find((l) => l.id === "l4")!.start);
  });
});

describe("AI kịch bản – âm thanh", () => {
  it("cùng cảm xúc: một bản nhạc cho cả phim; cảnh có âm thanh môi trường + bước chân khi đi", () => {
    const s = multi();
    s.mood = "adventure";
    const built = buildStory(s, "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    expect((built.movie.audio as { asset: string }[]).map((a) => a.asset)).toEqual(["music_adventure"]);
    const meadow = built.scenes[1]!.scene as { audio: { id: string; asset: string; kind: string }[] };
    expect(meadow.audio.find((a) => a.id === "amb")?.asset).toBe("amb_birds");
    expect(meadow.audio.some((a) => a.kind === "music")).toBe(false);
    expect(meadow.audio.filter((a) => a.asset === "sfx_steps_grass_loop").length).toBeGreaterThan(0);
  });

  it("khác cảm xúc giữa các cảnh: mỗi cảnh nhạc riêng", () => {
    const s = multi();
    s.scenes[2]!.mood = "sad";
    const built = buildStory(s, "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    expect(built.movie.audio).toEqual([]);
    const music = built.scenes.map((sc) => (sc.scene as { audio: { kind: string; asset: string }[] }).audio.find((a) => a.kind === "music")?.asset);
    expect(music).toEqual(["music_happy", "music_happy", "music_sad"]);
  });

  it("nhặt hoa có tiếng 'pluck' và bước chân lúc đi tới / quay về", async () => {
    const built = buildStory(flowerStory(), "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    const r = await resolveScene(built.scenes[0]!.scene, registry, fakeTts);
    const v = validateScene(r.scene, registry);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const ids = v.scene.audio.map((a) => a.asset);
    expect(ids.some((a) => a.startsWith("sfx_pluck_"))).toBe(true);
    expect(v.scene.audio.filter((a) => a.id.startsWith("l2_pickup_") && a.id.endsWith("_steps"))).toHaveLength(2);
  });
});

describe("AI kịch bản – phong cách & cỡ nhân vật", () => {
  it("không trộn Kenney khối vuông với Quaternius low-poly", () => {
    const s = sample();
    s.characters[2]!.asset = "char_a_wolf";
    expect(checkStory(s, registry, { strictStyle: true }).issues.map((i) => i.path)).toContain("characters");
  });

  it("size big → scale 1.3 trong scene", () => {
    const built = buildStory(flowerStory(), "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    const farm = built.scenes[1]!.scene as { characters: { id: string; scale?: number }[] };
    expect(farm.characters.find((c) => c.id === "mom")?.scale).toBe(1.3);
    expect(farm.characters.find((c) => c.id === "kit")?.scale).toBeUndefined();
  });
});

describe("AI kịch bản – cảm xúc", () => {
  it("câu cuối có cảm xúc vẫn hợp lệ với điệu nhảy kết (không chồng clip)", async () => {
    const s = sample();
    for (const l of s.scenes[0]!.lines) l.emotion = "happy";
    s.scenes[0]!.lines[1]!.emotion = "sad";
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (v.ok) expect(v.scene.dialogue.find((l) => l.id === "l2")?.emotion).toBe("sad");
  });
});

describe("AI kịch bản – thời điểm & hiệu ứng", () => {
  it("đêm: ánh sáng night, trời tối, đom đóm thay bướm, tiếng dế", () => {
    const s = multi();
    s.scenes[1]!.time = "night";
    const built = buildStory(s, "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    const env = (i: number) => (built.scenes[i]!.scene as { environment: { lighting: { preset: string }; effects: string[]; background: string } }).environment;
    expect(env(1)).toMatchObject({ lighting: { preset: "night" }, effects: ["fireflies"], background: "#1d2748" });
    expect(env(0).effects).toEqual([]); // rừng xanh ban ngày
    const amb = (built.scenes[1]!.scene as { audio: { id: string; asset: string }[] }).audio.find((a) => a.id === "amb");
    expect(amb?.asset).toBe("amb_night");
  });
});

describe("AI kịch bản – bối cảnh mới", () => {
  for (const env of ["env_beach", "env_garden", "env_clear_lake"]) {
    it(`${env}: có trong Registry, dựng scene hợp lệ`, async () => {
      const s = sample();
      s.scenes[0]!.environment = env;
      expect(checkStory(s, registry).issues).toEqual([]);
      const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
      const v = validateScene(r.scene, registry);
      expect(v.ok ? [] : v.issues).toEqual([]);
    });
  }
});

describe("AI kịch bản – người dùng chọn nhân vật", () => {
  it("trộn phong cách chỉ bị chặn khi AI tự chọn (strictStyle)", () => {
    const s = sample();
    s.characters[2]!.asset = "char_a_wolf";
    expect(checkStory(s, registry).issues).toEqual([]);
    expect(checkStory(s, registry, { strictStyle: true }).issues.map((i) => i.path)).toContain("characters");
  });

  it("checkCast: thiếu nhân vật đã chọn / thừa nhân vật lạ; cùng model hai lần = hai nhân vật", () => {
    const s = flowerStory(); // kit + mom (cùng char_k_animal_fox) + girl (bunny)
    expect(checkCast(s, [{ asset: "char_k_animal_fox" }, { asset: "char_k_animal_fox" }, { asset: "char_k_animal_bunny" }])).toEqual([]);
    const missing = checkCast(s, [{ asset: "char_k_animal_fox" }, { asset: "char_k_animal_fox" }, { asset: "char_k_animal_bunny" }, { asset: "char_k_animal_panda", name: "Gấu" }]);
    expect(missing.map((i) => i.message).join()).toMatch(/char_k_animal_panda/);
    const extra = checkCast(s, [{ asset: "char_k_animal_fox" }, { asset: "char_k_animal_bunny" }]);
    expect(extra.map((i) => i.message).join()).toMatch(/not chosen/);
    expect(checkStory(s, registry, { cast: [{ asset: "char_k_animal_fox" }] }).issues.length).toBeGreaterThan(0);
  });
});
