/**
 * Đọc CSV (RFC 4180): ngoặc kép, "" thoát dấu nháy, xuống dòng trong ô, CRLF, BOM của Excel.
 * Tự nhận dấu phân cách , ; hoặc tab từ dòng tiêu đề (Excel tiếng Việt hay dùng ;).
 */
export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  let inQuotes = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return count > 0 ? best : ",";
}

export function parseCsvRows(input: string, delimiter = detectDelimiter(input.replace(/^﻿/, ""))): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Bỏ dòng trống hoàn toàn.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** CSV → mảng object theo dòng tiêu đề (tên cột được trim). */
export function parseCsv(input: string): Record<string, string>[] {
  const [header, ...body] = parseCsvRows(input);
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((cells) => {
    const obj: Record<string, string> = {};
    keys.forEach((k, idx) => {
      if (k) obj[k] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
}
