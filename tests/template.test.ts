import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRows } from "../src/template/csv";
import { applyFormat, coerceParam, deepMerge, instantiate, TemplateSchema, type Template } from "../src/template/template";
import { resolveScene } from "../src/tts/resolveScene";
import { validateScene } from "../src/validation/validateScene";
import { fakeTts, registry } from "./helpers";

const root = resolve(import.meta.dirname, "..");
const template = TemplateSchema.parse(JSON.parse(readFileSync(resolve(root, "templates/kids-lesson/template.json"), "utf8")));
const rows = parseCsv(readFileSync(resolve(root, "templates/kids-lesson/data.csv"), "utf8"));

const mini = (scene: Record<string, unknown>, params: Template["params"] = {}): Template =>
  TemplateSchema.parse({ version: 1, id: "t", name: "t", params, scene });

describe("csv", () => {
  it("ngoặc kép, dấu phẩy trong ô, \"\" thoát, xuống dòng trong ô, CRLF, BOM", () => {
    const text = '﻿id,text\r\na,"Một, hai, ba"\r\nb,"Nói ""xin chào""\nnhé"\r\n';
    expect(parseCsv(text)).toEqual([
      { id: "a", text: "Một, hai, ba" },
      { id: "b", text: 'Nói "xin chào"\nnhé' },
    ]);
  });

  it("tự nhận dấu ; (Excel tiếng Việt) và bỏ dòng trống", () => {
    expect(parseCsv("id;title\nx;Chào, bạn\n\n")).toEqual([{ id: "x", title: "Chào, bạn" }]);
  });

  it("ô trống ở cuối dòng", () => {
    expect(parseCsvRows("a,b,\n")).toEqual([["a", "b", ""]]);
  });

  it("dữ liệu demo đọc đúng 3 dòng, giữ dấu phẩy trong câu", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]!.line_3).toBe("Một, hai, ba! Các bạn giỏi quá!");
    expect(rows[0]!.line_4).toBe("");
  });
});

describe("tham số", () => {
  it("ép kiểu number / boolean / color, dùng default khi ô trống", () => {
    expect(coerceParam("n", { type: "number" }, "0,5").value).toBe(0.5);
    expect(coerceParam("b", { type: "boolean" }, "có").value).toBe(true);
    expect(coerceParam("c", { type: "color" }, "#FFAA00").value).toBe("#ffaa00");
    expect(coerceParam("d", { type: "number", default: 2 }, "").value).toBe(2);
  });

  it("thiếu tham số bắt buộc / sai kiểu / ngoài enum / quá dài / asset sai loại", () => {
    expect(coerceParam("x", { type: "string" }, "").issue?.code).toBe("MissingParam");
    expect(coerceParam("x", { type: "string", required: false }, "")).toEqual({});
    expect(coerceParam("x", { type: "number" }, "abc").issue?.code).toBe("InvalidParam");
    expect(coerceParam("x", { type: "string", enum: ["Yes"] }, "Fly").issue?.code).toBe("InvalidParam");
    expect(coerceParam("x", { type: "string", maxLength: 3 }, "abcd").issue?.code).toBe("InvalidParam");
    expect(coerceParam("x", { type: "asset", assetType: "character" }, "prop_log", registry).issue?.code).toBe("InvalidParam");
    expect(coerceParam("x", { type: "number", min: 0, max: 1 }, "2").issue?.code).toBe("InvalidParam");
  });
});

describe("thay biến", () => {
  it("{{x}} nguyên chuỗi → đúng kiểu; nội suy trong chuỗi; thiếu giá trị tùy chọn → xóa key", () => {
    const t = mini(
      { a: "{{n}}", b: "Chào {{name}}!", c: "{{opt}}", d: ["{{opt}}", "x"] },
      { n: { type: "number" }, name: { type: "string" }, opt: { type: "string", required: false } },
    );
    const inst = instantiate(t, { n: "3", name: "Na" }, 0);
    expect(inst.issues).toEqual([]);
    expect(inst.scenes["16x9"]).toMatchObject({ a: 3, b: "Chào Na!", d: ["x"] });
    expect(inst.scenes["16x9"]).not.toHaveProperty("c");
  });

  it("$if giữ / bỏ phần tử mảng, hỗ trợ phủ định", () => {
    const t = mini({ list: [{ $if: "opt", v: 1 }, { $if: "!opt", v: 2 }] }, { opt: { type: "string", required: false } });
    expect(instantiate(t, { opt: "có" }, 0).scenes["16x9"]!.list).toEqual([{ v: 1 }]);
    expect(instantiate(t, {}, 0).scenes["16x9"]!.list).toEqual([{ v: 2 }]);
  });

  it("biến chưa khai báo → UnknownParam; cột thừa → cảnh báo; id sai → InvalidRowId", () => {
    const t = mini({ a: "{{ghost}}" });
    const inst = instantiate(t, { id: "Sai ID", extra: "1" }, 0);
    const codes = inst.issues.map((i) => `${i.level}:${i.code}`);
    expect(codes).toContain("error:UnknownParam");
    expect(codes).toContain("warning:UnusedColumn");
    expect(codes).toContain("error:InvalidRowId");
  });

  it("không có id → đánh số theo dòng", () => {
    expect(instantiate(mini({}), {}, 4).rowId).toBe("005");
  });
});

describe("định dạng", () => {
  it("deepMerge: object gộp, mảng thay thế, không sửa đầu vào", () => {
    const a = { x: { y: 1, z: 2 }, arr: [1, 2] };
    const out = deepMerge(a, { x: { z: 3 }, arr: [9] });
    expect(out).toEqual({ x: { y: 1, z: 3 }, arr: [9] });
    expect(a).toEqual({ x: { y: 1, z: 2 }, arr: [1, 2] });
  });

  it("applyFormat: kích thước, overrides, override action theo id", () => {
    const scene = { meta: { name: "n", width: 1, height: 1 }, camera: { fov: 45, mode: "fixed" }, actions: [{ id: "c", shot: { fov: 42, mode: "fixed" } }, { id: "d" }] };
    const out = applyFormat(scene, { width: 1080, height: 1920, overrides: { camera: { fov: 55 } }, actions: { c: { shot: { fov: 50 } } } });
    expect(out.meta).toMatchObject({ width: 1080, height: 1920 });
    expect(out.camera).toEqual({ fov: 55, mode: "fixed" });
    expect((out.actions as { shot?: unknown }[])[0]!.shot).toEqual({ fov: 50, mode: "fixed" });
  });
});

describe("template demo kids-lesson", () => {
  it("mọi dòng × mọi định dạng: resolve + validate hợp lệ", async () => {
    for (const [i, row] of rows.entries()) {
      const inst = instantiate(template, row, i, registry);
      expect(inst.issues.filter((x) => x.level === "error")).toEqual([]);
      for (const [format, scene] of Object.entries(inst.scenes)) {
        const r = await resolveScene(scene, registry, fakeTts);
        expect(r.issues, `${inst.rowId} ${format}`).toEqual([]);
        const v = validateScene(r.scene, registry);
        if (!v.ok) throw new Error(`${inst.rowId} ${format}: ${JSON.stringify(v.issues)}`);
        expect(v.scene.meta.width).toBe(template.formats[format]!.width);
      }
    }
  });

  it("câu tùy chọn line_4: có → 4 câu + Dance + camera cận câu 4; không → 3 câu", async () => {
    const withL4 = instantiate(template, rows[1]!, 1, registry).scenes["16x9"]!;
    const without = instantiate(template, rows[0]!, 0, registry).scenes["16x9"]!;
    expect((withL4.dialogue as unknown[]).length).toBe(4);
    expect((withL4.actions as { id: string }[]).map((a) => a.id)).toEqual(expect.arrayContaining(["anim_4", "cam_close_4"]));
    expect((without.dialogue as unknown[]).length).toBe(3);
    expect((without.actions as { id: string }[]).map((a) => a.id)).not.toContain("cam_close_4");
  });

  it("tham số đúng kiểu sau khi thay (music_volume là số, sky vào fog)", () => {
    const scene = instantiate(template, rows[1]!, 1, registry).scenes["9x16"]!;
    const bgm = (scene.audio as { id: string; volume: unknown }[]).find((a) => a.id === "bgm")!;
    expect(bgm.volume).toBe(0.5);
    expect(scene.environment).toMatchObject({ background: "#ffd6a5", fog: { color: "#ffd6a5" } });
    expect(scene.subtitles).toMatchObject({ size: 0.032, burnIn: true });
  });
});
