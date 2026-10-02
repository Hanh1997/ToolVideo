import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, normalizeCharacterSpec, normalizeHex, specHeight, specTags } from "../src/ai/characterSpec";

describe("CharacterSpec", () => {
  it("AI trả rỗng / rác → spec mặc định đầy đủ", () => {
    expect(normalizeCharacterSpec(undefined)).toEqual(DEFAULT_SPEC);
    expect(normalizeCharacterSpec("abc")).toEqual(DEFAULT_SPEC);
    expect(normalizeCharacterSpec({ hair: "red", top: [1, 2] })).toEqual(DEFAULT_SPEC);
  });

  it("giữ giá trị hợp lệ, thay giá trị lạ bằng mặc định", () => {
    const s = normalizeCharacterSpec({
      name: "  Bé Na  ",
      gender: "female",
      age: "child",
      build: "huge",
      skin: "F3C",
      hair: { style: "ponytail", color: "#4A2C1A" },
      top: { style: "dress", color: "pink", pattern: "dots" },
      accessories: ["backpack", "wings", "backpack", "toString"],
    });
    expect(s.name).toBe("Bé Na");
    expect(s.gender).toBe("female");
    expect(s.age).toBe("child");
    expect(s.build).toBe("average");
    expect(s.skin).toBe("#ff33cc");
    expect(s.hair).toEqual({ style: "ponytail", color: "#4a2c1a" });
    expect(s.top).toEqual({ style: "dress", color: DEFAULT_SPEC.top.color, pattern: "dots", patternColor: "#ffffff" });
    expect(s.accessories).toEqual(["backpack"]);
  });

  it("một mũ, một kính, nơ hoặc cà vạt – giữ món đầu", () => {
    const s = normalizeCharacterSpec({ accessories: ["sunhat", "cap", "glasses", "sunglasses", "tie", "bowtie", "watch"] });
    expect(s.accessories).toEqual(["sunhat", "glasses", "tie", "watch"]);
  });

  it("trẻ em / phụ nữ không có râu", () => {
    expect(normalizeCharacterSpec({ gender: "male", age: "child", facialHair: "beard" }).facialHair).toBe("none");
    expect(normalizeCharacterSpec({ gender: "female", age: "adult", facialHair: "mustache" }).facialHair).toBe("none");
    expect(normalizeCharacterSpec({ gender: "male", age: "elder", facialHair: "mustache" }).facialHair).toBe("mustache");
  });

  it("khuôn mặt: giữ giá trị hợp lệ, thiếu thì chọn theo tuổi / tên (khác tên → thường khác mặt)", () => {
    const s = normalizeCharacterSpec({ name: "Ông Ba", age: "elder", face: { shape: "square", eyes: "cat", wrinkles: false } });
    expect(s.face.shape).toBe("square");
    expect(["droopy", "narrow", "round"]).toContain(s.face.eyes);
    expect(s.face.wrinkles).toBe(false);
    expect(normalizeCharacterSpec({ age: "elder" }).face.wrinkles).toBe(true);
    expect(normalizeCharacterSpec({ name: "Bé Na", age: "child" }).face).toEqual(normalizeCharacterSpec({ name: "Bé Na", age: "child" }).face);
    const names = ["An", "Bình", "Chi", "Dũng", "Giang", "Hà", "Khánh", "Linh", "Mai", "Nam"];
    const faces = new Set(names.map((name) => JSON.stringify(normalizeCharacterSpec({ name, age: "child" }).face)));
    expect(faces.size).toBeGreaterThan(5);
  });

  it("màu hex", () => {
    expect(normalizeHex("#ABCDEF")).toBe("#abcdef");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    expect(normalizeHex("#12345")).toBeUndefined();
    expect(normalizeHex(42)).toBeUndefined();
  });

  it("chiều cao + nhãn theo tuổi / giới", () => {
    expect(specHeight({ age: "child", gender: "female" })).toBe(1.2);
    expect(specHeight({ age: "adult", gender: "male" })).toBeGreaterThan(specHeight({ age: "adult", gender: "female" }));
    const tags = specTags(normalizeCharacterSpec({ gender: "female", age: "elder", accessories: ["glasses", "scarf"] }));
    expect(tags).toEqual(expect.arrayContaining(["character", "human", "grandma", "glasses"]));
    expect(tags).not.toContain("scarf");
  });
});
