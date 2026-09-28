import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Đường dẫn tương đối (từ client) → tuyệt đối, CHỈ khi nằm trong một thư mục gốc cho phép.
 * Chặn "..", đường dẫn tuyệt đối, ký tự NUL.
 */
export function safeResolve(root: string, rel: string, allowedDirs: readonly string[]): string | undefined {
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return undefined;
  const abs = resolve(root, rel);
  for (const dir of allowedDirs) {
    const base = resolve(root, dir);
    const r = relative(base, abs);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return abs;
  }
  return undefined;
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** SubRip → WebVTT (trình duyệt chỉ hiểu VTT cho <track>). */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

function csvCell(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Ghi CSV (UTF-8 + BOM để Excel đọc đúng tiếng Việt, CRLF). */
export function toCsv(columns: readonly string[], rows: readonly Record<string, string>[]): string {
  const lines = [columns.map(csvCell).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c] ?? "")).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".csv": "text/csv; charset=utf-8",
};

export function contentType(ext: string): string {
  return TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/** "bytes=100-" → [100, size-1]; undefined nếu không hợp lệ. */
export function parseRange(header: string | undefined, size: number): [number, number] | undefined {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m) return undefined;
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start)) {
    if (Number.isNaN(end)) return undefined;
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) end = size - 1;
  if (start > end || start >= size) return undefined;
  return [start, end];
}
