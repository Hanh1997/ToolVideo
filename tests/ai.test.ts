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

describe("AI kịch bản – mở cảnh", () => {
  type Built = { actions: { id: string; type: string; target?: string; start?: number; duration?: number }[]; dialogue: { id: string; start: unknown }[] };
  const walkers = (sc: Built) => sc.actions.filter((a) => a.id === `${a.target}_in`).map((a) => a.target);

  it("mặc định: cảnh đầu chỉ người nói đầu bước vào, cảnh sau mọi người đứng sẵn và nói sớm", () => {
    const built = buildStory(multi(), "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    const [first, second] = built.scenes.map((s) => s.scene as unknown as Built);
    const speaker = multi().scenes[0]!.lines.find((l) => l.speaker)!.speaker;
    expect(walkers(first!).every((t) => t === speaker)).toBe(true);
    expect(walkers(second!)).toEqual([]);
    expect(second!.dialogue[0]!.start).toBeLessThan(2);
  });

  it("walk: cả nhóm bước vào quãng ngắn, không trượt chân", () => {
    const s = multi();
    s.scenes[0]!.entrance = "walk";
    const built = buildStory(s, "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    const sc = built.scenes[0]!.scene as unknown as Built;
    const moves = sc.actions.filter((a) => a.id === `${a.target}_in`);
    expect(moves.length).toBeGreaterThan(1);
    for (const m of moves) expect(m.start! + m.duration!).toBeLessThanOrEqual(3.4 + 1e-6);
  });

  it("none: không ai đi vào", () => {
    const s = multi();
    s.scenes[0]!.entrance = "none";
    const built = buildStory(s, "vi", registry);
    if (built.kind !== "movie") throw new Error("movie");
    expect(walkers(built.scenes[0]!.scene as unknown as Built)).toEqual([]);
  });
});

describe("AI kịch bản – tương tác giữa nhân vật", () => {
  const withTouches = (): Story => {
    const s = sample();
    const l = s.scenes[0]!.lines;
    l[1] = { ...l[1]!, gesture: null, emotion: "surprised", text: { vi: "Chào các bạn!", en: "Hi friends!" } }; // → bước lại gần (không có clip cảm xúc)
    l[2] = { ...l[2]!, gesture: null, interaction: { type: "hug", with: "fox", by: null } };
    l[3] = { ...l[3]!, interaction: { type: "pat", with: "bunny", by: null } };
    l.push({ id: "l6", speaker: "bunny", gesture: null, text: { vi: "Tuyệt!", en: "Great!" }, emotion: "happy", action: null, interaction: { type: "highfive", with: "fox", by: null } });
    l.push({ id: "l7", speaker: "fox", gesture: null, text: { vi: "Đi thôi!", en: "Let's go!" }, emotion: "happy", action: null, interaction: { type: "leave", with: "bunny", by: null } });
    l.splice(4, 1); // bỏ l5 (vẫy tay) để l7 là câu cuối
    return s;
  };

  it("ôm / vỗ vai / đập tay / cùng rời đi / bước lại gần: qua resolver + validator, không chồng action", async () => {
    const s = withTouches();
    expect(checkStory(s, registry).issues).toEqual([]);
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    expect(r.issues).toEqual([]);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) return;
    const ids = v.scene.actions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["l3_hug_hug0", "l3_hug_rhug0", "l4_pat_pat0", "l6_highfive_hi5", "l6_highfive_rhi5", "l7_leave_fox_move", "l7_leave_bunny_move"]));
    // Người đã rời đi không nhảy kết; người ở lại vẫn nhảy.
    expect(ids).not.toContain("end_fox");
    expect(ids).not.toContain("end_bunny");
    // Câu thoại biết nói với ai.
    expect(v.scene.dialogue.find((l) => l.id === "l3")!.to).toBe("fox");
    // Ôm xong mới nói.
    const hug = v.scene.actions.find((a) => a.id === "l3_hug_hug1")!;
    expect(hug.start + hug.duration).toBeLessThanOrEqual(v.scene.dialogue.find((l) => l.id === "l3")!.start + 1e-6);
  });

  it("câu cảm thán: người nói bước lại gần người nghe rồi lùi về chỗ trước câu kế", async () => {
    const s = sample();
    s.ending = "none";
    const l4 = s.scenes[0]!.lines[3]!;
    Object.assign(l4, { emotion: "surprised", text: { vi: "Thật sao, chia sẻ vui thế à!", en: "Really, sharing is that fun!" } });
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) return;
    const back = v.scene.actions.find((a) => a.id === "ap_l4_back")!;
    expect(v.scene.actions.find((a) => a.id === "ap_l4_in")).toMatchObject({ type: "moveTo", target: "bear" });
    const l4r = v.scene.dialogue.find((l) => l.id === "l4")!;
    expect(back.start).toBeGreaterThanOrEqual(l4r.start + l4r.duration); // nói xong mới lùi về
  });

  it("chạm nhau không lồng vào nhau: tâm cách nhau ≥ mũi người này + mũi người kia", async () => {
    const s = withTouches();
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    const v = validateScene(r.scene, registry);
    if (!v.ok) throw new Error("scene");
    const front = (id: string) => {
      const c = v.scene.characters.find((k) => k.id === id)!;
      const a = registry.assets.find((x) => x.id === c.asset)!;
      return a.footprint!.front * (c.scale ?? 1);
    };
    for (const [tag, actor, other] of [["l3_hug", "bunny", "fox"], ["l4_pat", "bear", "bunny"], ["l6_highfive", "bunny", "fox"]] as const) {
      const go = v.scene.actions.find((a) => a.id === `${tag}_go_move`) as { to: { x: number; z: number } };
      const o = v.scene.characters.find((k) => k.id === other)!.position;
      expect(Math.hypot(go.to.x - o.x, go.to.z - o.z)).toBeGreaterThanOrEqual(front(actor) + front(other));
    }
  });

  it("báo lỗi tương tác sai", () => {
    const s = withTouches();
    const l = s.scenes[0]!.lines;
    l[1]!.interaction = { type: "leave", with: null, by: null }; // leave không ở câu cuối
    l[2]!.interaction = { type: "hug", with: null, by: null }; // thiếu with
    l[3]!.interaction = { type: "pat", with: "owl", by: null }; // with không có mặt
    const paths = checkStory(s, registry).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["scenes.0.lines.1.interaction", "scenes.0.lines.2.interaction.with", "scenes.0.lines.3.interaction.with"]));
  });
});

describe("AI kịch bản – âm thanh", () => {
  it("cùng cảm xúc: một bản nhạc cho cả phim; cảnh có âm thanh môi trường + bước chân khi đi", () => {
    const s = multi();
    s.mood = "adventure";
    s.scenes[1]!.entrance = "walk";
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
  for (const env of ["env_beach", "env_garden", "env_clear_lake", "env_living_room"]) {
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

describe("AI kịch bản – trong nhà", () => {
  it("phòng khách: ánh sáng trong nhà (đêm → đèn), không đom đóm, cùng rời đi qua cửa (không xuyên tường)", () => {
    const s = sample();
    const sc = s.scenes[0]!;
    sc.environment = "env_living_room";
    sc.time = "night";
    sc.lines[4] = { ...sc.lines[4]!, gesture: null, interaction: { type: "leave", with: null, by: null } };
    const built = buildScene(s, "vi", registry) as { environment: { lighting: { preset: string }; effects: string[] }; actions: { id: string; to?: { x: number; z: number } }[] };
    expect(built.environment.lighting.preset).toBe("indoor_night");
    expect(built.environment.effects).not.toContain("fireflies");
    for (const id of ["fox", "bunny", "bear"]) {
      const legs = built.actions.filter((a) => a.id.startsWith(`l5_leave_${id}_move`)).map((a) => a.to!);
      expect(legs).toHaveLength(2);
      expect(Math.abs(legs[0]!.z - -1.05)).toBeLessThan(0.01); // tới trước ô cửa (x = -5.25, z = -1.05)
      expect(legs[0]!.x).toBeGreaterThan(-5.25);
      expect(legs[1]!.x).toBeLessThan(-5.25); // rồi ra ngoài
    }
  });
});

describe("AI kịch bản – chạy chơi, vấp ngã, cất đồ vào hộp", () => {
  const tidy = (): Story => {
    const s = sample();
    s.objects = [
      { id: "gau", kind: "teddy_bear", name: { vi: "Gấu", en: "Bear" }, scene: "forest", heldBy: null },
      { id: "sach", kind: "book", name: { vi: "Sách", en: "Books" }, scene: "forest", heldBy: null },
    ];
    const t = (vi: string) => ({ vi, en: vi });
    s.scenes[0]!.environment = "env_living_room";
    s.scenes[0]!.lines = [
      { id: "l1", speaker: "fox", gesture: null, emotion: "happy", text: t("Đuổi bắt nào!"), action: null, interaction: { type: "play", with: "bunny", by: null } },
      { id: "l2", speaker: "fox", gesture: null, emotion: "scared", text: t("Oái!"), action: { type: "trip", object: "gau", to: null, by: null } },
      { id: "l3", speaker: "bunny", gesture: null, emotion: "surprised", text: t("Bạn có sao không?"), action: null, interaction: { type: "pat", with: "fox", by: null } },
      { id: "l4", speaker: "fox", gesture: null, emotion: "neutral", text: t("Mình dọn đây."), action: { type: "pickup", object: "gau", to: null, by: null } },
      { id: "l5", speaker: "fox", gesture: null, emotion: "happy", text: t("Vào hộp rồi!"), action: { type: "stow", object: "gau", to: null, by: null } },
      { id: "l6", speaker: "bear", gesture: null, emotion: "neutral", text: t("Còn sách nữa."), action: { type: "pickup", object: "sach", to: null, by: null } },
      { id: "l7", speaker: "bear", gesture: null, emotion: "happy", text: t("Xong!"), action: { type: "stow", object: "sach", to: null, by: null } },
    ];
    return s;
  };

  it("qua resolver + validator; hộp đồ chơi có trong cảnh; đồ cất nằm trong hộp", async () => {
    const s = tidy();
    expect(checkStory(s, registry).issues).toEqual([]);
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    expect(r.issues).toEqual([]);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) return;
    const box = v.scene.props.find((p) => p.id === "toybox")!;
    expect(box).toBeDefined();
    for (const id of ["l5_stow_drop", "l7_stow_drop"]) {
      const drop = v.scene.actions.find((a) => a.id === id) as { at: { x: number; y: number; z: number } };
      expect(Math.hypot(drop.at.x - box.position.x, drop.at.z - box.position.z)).toBeLessThan(0.2);
      expect(drop.at.y).toBeGreaterThan(0);
    }
    const ids = v.scene.actions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["l1_play_fox_path", "l1_play_bunny_path", "l1_play_fox_hop0", "l2_trip_lurch", "l2_trip_fall", "l2_trip_back_move"]));
    // Nói "Oái!" ngay chỗ ngã (ngã xong mới nói), đứng dậy đi về SAU câu.
    const l2 = v.scene.dialogue.find((l) => l.id === "l2")!;
    const fall = v.scene.actions.find((a) => a.id === "l2_trip_fall")!;
    const walkBack = v.scene.actions.find((a) => a.id === "l2_trip_back_move")!;
    expect(fall.start + fall.duration).toBeLessThanOrEqual(l2.start + 0.5);
    expect(walkBack.start).toBeGreaterThanOrEqual(l2.start + l2.duration);
    // l3: thỏ vỗ vai cáo → chờ cáo về chỗ xong (câu có dính tới cáo).
    const home = v.scene.actions.find((a) => a.id === "l2_trip_home")!;
    const pat = v.scene.actions.find((a) => a.id === "l3_pat_go_move")!;
    expect(pat.start).toBeGreaterThanOrEqual(home.start + home.duration - 1e-6);
    // l4 → l5: cáo nhặt rồi cất liền → đi thẳng từ chỗ nhặt tới hộp, không về chỗ giữa chừng.
    expect(v.scene.actions.find((a) => a.id === "l4_pickup_back_move")).toBeUndefined();
  });

  it("ôm / đập tay: nói ngay cạnh người kia (camera hai người), về chỗ sau câu", async () => {
    const s = sample();
    const l = s.scenes[0]!.lines;
    l[2] = { ...l[2]!, gesture: null, interaction: { type: "hug", with: "fox", by: null } };
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) return;
    const l3 = v.scene.dialogue.find((x) => x.id === "l3")!;
    const go = v.scene.actions.find((a) => a.id === "l3_hug_go_move")!;
    const back = v.scene.actions.find((a) => a.id === "l3_hug_back_move")!;
    expect(go.start + go.duration).toBeLessThanOrEqual(l3.start); // tới nơi rồi mới nói
    expect(back.start).toBeGreaterThanOrEqual(l3.start + l3.duration); // nói xong mới về
    // Camera câu l3 nhìn vào giữa hai người, không cận chỗ đứng cũ của thỏ.
    const cam = v.scene.actions.find((a) => a.id === "cam_l3") as { shot: { lookAt: { x: number } } };
    const fox = v.scene.characters.find((c) => c.id === "fox")!.position;
    const to = (go as { to: { x: number } }).to;
    expect(Math.abs(cam.shot.lookAt.x - (to.x + fox.x) / 2)).toBeLessThan(0.05);
  });

  it("báo lỗi: cất món không cầm, vấp món không nằm dưới đất", () => {
    const s = tidy();
    const l = s.scenes[0]!.lines;
    l[3]!.action = null; // không nhặt gấu → l5 stow sai
    l[1]!.action = { type: "trip", object: "sach", to: null, by: null };
    l[5]!.action = null; // sách vẫn nằm đất → trip hợp lệ; l7 stow sách sai
    const paths = checkStory(s, registry).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["scenes.0.lines.4.action", "scenes.0.lines.6.action"]));
    expect(paths).not.toContain("scenes.0.lines.1.action");
  });
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

describe("AI kịch bản – sau tương tác: đứng lại / đi tới / rời cảnh", () => {
  const build = async (s: Story) => {
    expect(checkStory(s, registry).issues).toEqual([]);
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    expect(r.issues).toEqual([]);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) throw new Error("scene không hợp lệ");
    return v.scene;
  };

  it("stay: ôm xong đứng lại cạnh người kia, câu sau camera cận ở chỗ mới", async () => {
    const s = sample();
    const l = s.scenes[0]!.lines;
    l[2] = { ...l[2]!, gesture: null, interaction: { type: "hug", with: "fox", by: null }, then: "stay" };
    l[3] = { ...l[3]!, speaker: "bunny" };
    const scene = await build(s);
    const ids = scene.actions.map((a) => a.id);
    expect(ids).toContain("l3_hug_settle");
    expect(ids).not.toContain("l3_hug_back_move");
    const to = (scene.actions.find((a) => a.id === "l3_hug_go_move") as { to: { x: number } }).to;
    const home = scene.characters.find((c) => c.id === "bunny")!.position;
    const cam = scene.actions.find((a) => a.id === "cam_l4") as { shot: { lookAt: { x: number } } };
    expect(Math.abs(cam.shot.lookAt.x - to.x)).toBeLessThan(Math.abs(cam.shot.lookAt.x - home.x));
  });

  it("walk: đi tới đứng cạnh người kia và ở lại (mặc định stay)", async () => {
    const s = sample();
    const l = s.scenes[0]!.lines;
    l[2] = { ...l[2]!, gesture: null, interaction: { type: "walk", with: "bear", by: null } };
    const scene = await build(s);
    const ids = scene.actions.map((a) => a.id);
    expect(ids).toContain("l3_walk_go_move");
    expect(ids).not.toContain("l3_walk_back_move");
  });

  it("leave: nói xong đi ra khỏi cảnh, không nhảy kết; nhắc lại sau đó → báo lỗi", async () => {
    const s = sample();
    const l = s.scenes[0]!.lines;
    l[2] = { ...l[2]!, gesture: null, interaction: { type: "hug", with: "fox", by: null }, then: "leave" };
    const scene = await build(s);
    const ids = scene.actions.map((a) => a.id);
    expect(ids).toContain("l3_hug_exit0_move");
    expect(ids).not.toContain("l3_hug_back_move");
    expect(ids).not.toContain("end_bunny");
    expect(ids).toContain("end_bear");

    l[4] = { ...l[4]!, speaker: "bunny" };
    expect(checkStory(s, registry).issues.map((i) => i.path)).toContain("scenes.0.lines.2.then");
  });

  it("then chỉ dùng cho câu có action / interaction", () => {
    const s = sample();
    s.scenes[0]!.lines[1]!.then = "stay";
    expect(checkStory(s, registry).issues.map((i) => i.path)).toContain("scenes.0.lines.1.then");
  });
});

describe("AI kịch bản – ngôn ngữ điện ảnh & chuẩn xuất", () => {
  const resolveAll = async (built: ReturnType<typeof buildStory>) => {
    const raw = built.kind === "scene" ? [built.scene] : built.scenes.map((s) => s.scene);
    const out = [];
    for (const sc of raw) {
      const r = await resolveScene(sc, registry, fakeTts);
      expect(r.issues).toEqual([]);
      const v = validateScene(r.scene, registry);
      expect(v.ok ? [] : v.issues).toEqual([]);
      if (v.ok) out.push(v.scene);
    }
    return out;
  };

  it("nhặt / trao có cảnh cận món đồ, camera không chồng nhau", async () => {
    const [meadow, farm] = await resolveAll(buildStory(flowerStory(), "vi", registry));
    expect(meadow!.actions.some((a) => a.type === "camera" && a.id.endsWith("_pickup_insert"))).toBe(true);
    expect(farm!.actions.some((a) => a.type === "camera" && a.id.endsWith("_give_insert"))).toBe(true);
  });

  it("câu cảm xúc đủ dài → cảnh phản ứng của người nghe ở cuối câu", async () => {
    const s = sample();
    s.scenes[0]!.lines[2] = { ...s.scenes[0]!.lines[2]!, text: { vi: "Cho mình một ít dâu nhé, mình đói bụng quá rồi!", en: "Can I have a few berries, I am so hungry now!" }, emotion: "sad" };
    const [scene] = await resolveAll(buildStory(s, "vi", registry));
    const react = scene!.actions.find((a) => a.id === "cam_l3_react")!;
    const l3 = scene!.dialogue.find((l) => l.id === "l3")!;
    expect(react.start).toBeCloseTo(l3.start + l3.duration - 0.9, 2);
  });

  it("tên phim đầu + danh sách cuối; 1080p, 25 fps, -23 LUFS", async () => {
    const [scene] = await resolveAll(buildStory(sample(), "vi", registry, { resolution: "1080p", fps: 25, loudness: "tv" }));
    expect(scene!.meta).toMatchObject({ width: 1920, height: 1080, fps: 25 });
    expect(scene!.mix.loudness).toBe(-23);
    expect(scene!.titles.map((t) => t.kind)).toEqual(["title", "credits"]);
    expect(scene!.dialogue[0]!.start).toBeGreaterThanOrEqual(3);
    const off = await resolveAll(buildStory(sample(), "vi", registry, { titles: false }));
    expect(off[0]!.titles).toEqual([]);
  });

  it("âm thanh không lời: câu ngắn không phụ đề ngay trước câu chính; giọng lệch theo chỗ đứng", async () => {
    const s = sample();
    s.scenes[0]!.lines[1] = { ...s.scenes[0]!.lines[1]!, vocal: "gasp" };
    s.scenes[0]!.lines[2] = { ...s.scenes[0]!.lines[2]!, gesture: null, vocal: "laugh", interaction: { type: "hug", with: "fox", by: null } };
    expect(checkStory(s, registry).issues).toEqual([]);
    const [scene] = await resolveAll(buildStory(s, "vi", registry));
    const ids = scene!.dialogue.map((l) => l.id);
    expect(ids).toEqual(["l1", "l2_v", "l2", "l3_v", "l3", "l4", "l5"]);
    const v = scene!.dialogue.find((l) => l.id === "l2_v")!;
    expect(v.subtitle).toBe(false);
    expect(v.text).toBe("Ối!");
    // Ôm xong mới cười rồi nói.
    const hug = scene!.actions.find((a) => a.id === "l3_hug_hug1")!;
    expect(hug.start + hug.duration).toBeLessThanOrEqual(scene!.dialogue.find((l) => l.id === "l3_v")!.start + 1e-6);
    // Camera nhìn về +z: người đứng ở x âm nằm bên phải khung hình → lệch phải, và ngược lại.
    const pans = Object.fromEntries(scene!.dialogue.map((l) => [l.id, l.pan ?? 0]));
    const x = (id: string) => scene!.characters.find((c) => c.id === id)!.position.x;
    expect(Math.sign(pans.l2!)).toBe(-Math.sign(x("fox")));
    expect(Math.sign(pans.l4!)).toBe(-Math.sign(x("bear")));
    expect(Math.abs(pans.l2!)).toBeLessThanOrEqual(0.35);
  });
});

describe("AI kịch bản – clip cảm xúc / cử chỉ mở rộng (nhân vật có bộ Mixamo)", () => {
  const withTung = (): Story => {
    const s = sample();
    s.characters[0] = { ...s.characters[0]!, asset: "char_ac_danchoi", size: "normal" };
    return s;
  };

  it("cử chỉ mới chỉ mở cho nhân vật có clip thật", async () => {
    const { supportedGestures } = await import("../src/ai/story");
    expect(supportedGestures(registry, "char_ac_danchoi")).toEqual(expect.arrayContaining(["laugh", "cry", "shrug", "bow", "salute"]));
    expect(supportedGestures(registry, "char_k_animal_fox")).not.toContain("laugh");
  });

  it("câu thường → cử chỉ nói chuyện; câu buồn → đứng buồn; đi khi buồn → dáng đi buồn", async () => {
    const s = withTung();
    const l = s.scenes[0]!.lines;
    l[1] = { ...l[1]!, gesture: null, emotion: "neutral" };
    l[3] = { ...l[3]!, speaker: "fox", gesture: null, emotion: "sad", interaction: { type: "pat", with: "bunny", by: null } };
    l[4] = { ...l[4]!, gesture: "bow" };
    expect(checkStory(s, registry, { strictStyle: false }).issues).toEqual([]);
    const r = await resolveScene(buildScene(s, "vi", registry), registry, fakeTts);
    const v = validateScene(r.scene, registry);
    expect(v.ok ? [] : v.issues).toEqual([]);
    if (!v.ok) return;
    const clipOf = (id: string) => (v.scene.actions.find((a) => a.id === id) as { clip?: string; loop?: boolean } | undefined);
    expect(clipOf("e_l2")?.clip).toBe("talk");
    expect(clipOf("e_l4")?.clip).toBe("idle_sad");
    expect(clipOf("l4_pat_go_walk")?.clip).toBe("walk_sad");
    expect(clipOf("g_l5")).toMatchObject({ clip: "bow", loop: false });
  });
});
