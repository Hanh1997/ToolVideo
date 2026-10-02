import { describe, expect, it } from "vitest";
import { visemesAt, visemeSequence } from "../src/engine/FaceMorphs";
import type { DialogueLine } from "../src/schemas/scene.schema";

describe("Khuôn mặt morph – khẩu hình", () => {
  it("tách âm tiết tiếng Việt theo cụm nguyên âm (bỏ dấu)", () => {
    expect(visemeSequence("Chào bạn!")).toEqual(["aa", "aa"]);
    expect(visemeSequence("Mẹ ơi, cô út")).toEqual(["ee", "oh", "oh", "ou"]);
    expect(visemeSequence("Đi thôi")).toEqual(["ih", "oh"]);
  });

  it("chữ không phải Latin → xen kẽ aa / oh", () => {
    expect(visemeSequence("你好吗").length).toBeGreaterThanOrEqual(2);
  });

  it("đậm theo độ to giọng, im lặng → khép miệng", () => {
    const line = { id: "l1", text: "Mẹ ơi", start: 1, duration: 1 } as DialogueLine;
    const open = visemesAt(line, 1.2, 0.8);
    expect(open.ee).toBeGreaterThan(0.9);
    const closed = visemesAt(line, 1.2, 0);
    expect(Object.values(closed).every((v) => v === 0)).toBe(true);
    // Cuối âm tiết đầu chuyển mượt sang âm kế.
    const blend = visemesAt(line, 1.45, 0.7);
    expect(blend.ee! > 0 && blend.oh! > 0).toBe(true);
  });
});
