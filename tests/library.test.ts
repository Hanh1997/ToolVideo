import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRange, safeResolve, srtToVtt, toCsv } from "../server/libraryUtils";
import { parseCsv } from "../src/template/csv";

const root = resolve("/srv/app");
const allowed = ["projects", "batches"];

describe("safeResolve", () => {
  it("cho phép file trong thư mục được phép", () => {
    expect(safeResolve(root, "projects/a/renders/x.mp4", allowed)).toBe(resolve(root, "projects/a/renders/x.mp4"));
    expect(safeResolve(root, "batches/t/videos/y.mp4", allowed)).toBeDefined();
  });

  it("chặn thoát thư mục, đường dẫn tuyệt đối, thư mục khác, NUL", () => {
    expect(safeResolve(root, "projects/../package.json", allowed)).toBeUndefined();
    expect(safeResolve(root, "../etc/passwd", allowed)).toBeUndefined();
    expect(safeResolve(root, "/etc/passwd", allowed)).toBeUndefined();
    expect(safeResolve(root, "C:/Windows/win.ini", allowed)).toBeUndefined();
    expect(safeResolve(root, "public/assets/registry.json", allowed)).toBeUndefined();
    expect(safeResolve(root, "projects", allowed)).toBeUndefined();
    expect(safeResolve(root, "projects/a\0.mp4", allowed)).toBeUndefined();
  });
});

describe("parseRange", () => {
  it("các dạng Range hợp lệ", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual([0, 99]);
    expect(parseRange("bytes=500-", 1000)).toEqual([500, 999]);
    expect(parseRange("bytes=-100", 1000)).toEqual([900, 999]);
    expect(parseRange("bytes=900-5000", 1000)).toEqual([900, 999]);
  });
  it("không hợp lệ", () => {
    expect(parseRange("bytes=1000-", 1000)).toBeUndefined();
    expect(parseRange("items=0-1", 1000)).toBeUndefined();
    expect(parseRange(undefined, 1000)).toBeUndefined();
  });
});

describe("srt → vtt, csv", () => {
  it("đổi dấu phẩy mili giây thành dấu chấm, thêm header", () => {
    const vtt = srtToVtt("\uFEFF1\r\n00:00:00,600 --> 00:00:02,678\r\nXin chào\r\n");
    expect(vtt.startsWith("WEBVTT\n\n1\n")).toBe(true);
    expect(vtt).toContain("00:00:00.600 --> 00:00:02.678");
  });

  it("toCsv ghi lại đọc được y nguyên (dấu phẩy, ngoặc kép, xuống dòng, tiếng Việt)", () => {
    const rows = [
      { id: "a", text: "Một, hai, ba!" },
      { id: "b", text: 'Nói "chào"\nnhé' },
      { id: "c", text: "" },
    ];
    const csv = toCsv(["id", "text"], rows);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(parseCsv(csv)).toEqual(rows);
  });
});
