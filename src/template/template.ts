import { z } from "zod";
import { AssetTypeSchema, findAsset, type Registry } from "../schemas/asset.schema";

/**
 * Template = Scene Script soạn thảo có {{biến}} + khai báo tham số + override theo định dạng.
 *
 *   "{{name}}"              → thay bằng giá trị ĐÚNG KIỂU (số, bool…); thiếu giá trị tùy chọn → xóa key
 *   "Chào {{name}}!"        → nội suy chuỗi
 *   { "$if": "line_4", … }  → phần tử mảng chỉ giữ khi tham số có giá trị ("!line_4" = khi không có)
 *
 * Chỉ thay GIÁ TRỊ trên JSON đã parse – không thực thi code, không ghép chuỗi JSON thô.
 */

const paramName = z.string().regex(/^[a-z][a-z0-9_]*$/, "tên tham số: chữ thường, số, '_'");

export const TemplateParamSchema = z.object({
  type: z.enum(["string", "number", "boolean", "color", "asset"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** type "asset": loại asset bắt buộc. */
  assetType: AssetTypeSchema.optional(),
  enum: z.array(z.string()).optional(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type TemplateParam = z.infer<typeof TemplateParamSchema>;

const Even = z.number().int().min(16).max(4096).refine((n) => n % 2 === 0, "kích thước phải chẵn");

export const TemplateFormatSchema = z.object({
  width: Even,
  height: Even,
  /** Deep-merge vào scene (object gộp, mảng thay thế). */
  overrides: z.record(z.string(), z.unknown()).optional(),
  /** Deep-merge vào action có id tương ứng (vd. đổi shot camera cho khung dọc). */
  actions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type TemplateFormat = z.infer<typeof TemplateFormatSchema>;

export const TemplateSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/, "id template: chữ thường, số, '-'"),
  name: z.string().min(1),
  description: z.string().optional(),
  params: z.record(paramName, TemplateParamSchema),
  formats: z.record(z.string().regex(/^[a-z0-9]+$/), TemplateFormatSchema).default({ "16x9": { width: 1280, height: 720 } }),
  scene: z.record(z.string(), z.unknown()),
});
export type Template = z.infer<typeof TemplateSchema>;

export type ParamValue = string | number | boolean;

export interface TemplateIssue {
  level: "error" | "warning";
  code: "MissingParam" | "InvalidParam" | "UnknownParam" | "UnusedColumn" | "InvalidRowId";
  message: string;
  param?: string;
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const EXACT = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/;
const ROW_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Cột dữ liệu không phải tham số. */
const RESERVED = new Set(["id"]);

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Ép kiểu một giá trị (CSV luôn là chuỗi) theo khai báo tham số. */
export function coerceParam(name: string, def: TemplateParam, raw: unknown, registry?: Registry): { value?: ParamValue; issue?: TemplateIssue } {
  const bad = (message: string): { issue: TemplateIssue } => ({ issue: { level: "error", code: "InvalidParam", message: `${name}: ${message}`, param: name } });

  if (isEmpty(raw)) {
    if (def.default !== undefined) return coerceParam(name, { ...def, default: undefined }, def.default, registry);
    if (def.required === false) return {};
    return { issue: { level: "error", code: "MissingParam", message: `Thiếu tham số bắt buộc "${name}"`, param: name } };
  }

  let value: ParamValue;
  switch (def.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n)) return bad(`"${String(raw)}" không phải số`);
      if (def.min !== undefined && n < def.min) return bad(`${n} < ${def.min}`);
      if (def.max !== undefined && n > def.max) return bad(`${n} > ${def.max}`);
      value = n;
      break;
    }
    case "boolean": {
      if (typeof raw === "boolean") value = raw;
      else {
        const s = String(raw).trim().toLowerCase();
        if (["true", "1", "yes", "có", "co", "x"].includes(s)) value = true;
        else if (["false", "0", "no", "không", "khong"].includes(s)) value = false;
        else return bad(`"${String(raw)}" không phải true/false`);
      }
      break;
    }
    case "color": {
      const s = String(raw).trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(s)) return bad(`"${s}" không phải màu #rrggbb`);
      value = s.toLowerCase();
      break;
    }
    case "asset": {
      const s = String(raw).trim();
      const asset = registry ? findAsset(registry, s) : undefined;
      if (registry && !asset) return bad(`asset "${s}" không có trong Registry`);
      if (asset && def.assetType && asset.type !== def.assetType) return bad(`asset "${s}" là ${asset.type}, cần ${def.assetType}`);
      value = s;
      break;
    }
    case "string": {
      const s = String(raw);
      if (def.maxLength !== undefined && s.length > def.maxLength) return bad(`dài ${s.length} ký tự, tối đa ${def.maxLength}`);
      value = s;
      break;
    }
  }
  if (def.enum && !def.enum.includes(String(value))) return bad(`"${String(value)}" không thuộc [${def.enum.join(", ")}]`);
  return { value };
}

export function collectParams(template: Template, row: Record<string, unknown>, registry?: Registry): { values: Record<string, ParamValue>; issues: TemplateIssue[] } {
  const values: Record<string, ParamValue> = {};
  const issues: TemplateIssue[] = [];
  for (const [name, def] of Object.entries(template.params)) {
    const r = coerceParam(name, def, row[name], registry);
    if (r.issue) issues.push(r.issue);
    if (r.value !== undefined) values[name] = r.value;
  }
  for (const key of Object.keys(row)) {
    if (!RESERVED.has(key) && !(key in template.params)) {
      issues.push({ level: "warning", code: "UnusedColumn", message: `Cột "${key}" không phải tham số của template (bỏ qua)` });
    }
  }
  return { values, issues };
}

function condition(expr: unknown, values: Record<string, ParamValue>, issues: TemplateIssue[], declared: Record<string, TemplateParam>): boolean {
  if (typeof expr !== "string") return true;
  const negate = expr.startsWith("!");
  const name = negate ? expr.slice(1) : expr;
  if (!(name in declared)) issues.push({ level: "error", code: "UnknownParam", message: `$if dùng tham số "${name}" chưa khai báo`, param: name });
  const v = values[name];
  const truthy = v !== undefined && v !== false && v !== "";
  return negate ? !truthy : truthy;
}

const REMOVE = Symbol("remove");

function substitute(node: unknown, values: Record<string, ParamValue>, declared: Record<string, TemplateParam>, issues: TemplateIssue[]): unknown {
  if (typeof node === "string") {
    const exact = EXACT.exec(node);
    if (exact) {
      const name = exact[1]!;
      if (!(name in declared)) {
        issues.push({ level: "error", code: "UnknownParam", message: `Biến {{${name}}} chưa khai báo trong params`, param: name });
        return node;
      }
      return values[name] ?? REMOVE;
    }
    return node.replace(PLACEHOLDER, (_, name: string) => {
      if (!(name in declared)) {
        issues.push({ level: "error", code: "UnknownParam", message: `Biến {{${name}}} chưa khai báo trong params`, param: name });
        return "";
      }
      const v = values[name];
      return v === undefined ? "" : String(v);
    });
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (item && typeof item === "object" && !Array.isArray(item) && "$if" in item) {
        const { $if, ...rest } = item as Record<string, unknown>;
        if (!condition($if, values, issues, declared)) continue;
        out.push(substitute(rest, values, declared, issues));
        continue;
      }
      const v = substitute(item, values, declared, issues);
      if (v !== REMOVE) out.push(v);
    }
    return out;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = substitute(v, values, declared, issues);
      if (r !== REMOVE) out[k] = r;
    }
    return out;
  }
  return node;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: object gộp đệ quy, mảng / giá trị thay thế. Không sửa đầu vào. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

export function applyFormat(scene: Record<string, unknown>, format: TemplateFormat): Record<string, unknown> {
  let out = (format.overrides ? deepMerge(scene, format.overrides) : structuredClone(scene)) as Record<string, unknown>;
  const meta = isPlainObject(out.meta) ? out.meta : {};
  out = { ...out, meta: { ...meta, width: format.width, height: format.height } };
  if (format.actions && Array.isArray(out.actions)) {
    out.actions = out.actions.map((a) => (isPlainObject(a) && typeof a.id === "string" && format.actions?.[a.id] ? deepMerge(a, format.actions[a.id]) : a));
  }
  return out;
}

export interface Instance {
  rowId: string;
  values: Record<string, ParamValue>;
  /** Scene soạn thảo theo từng định dạng (chưa resolve TTS). */
  scenes: Record<string, Record<string, unknown>>;
  issues: TemplateIssue[];
}

/** Một dòng dữ liệu → scene cho mọi định dạng. */
export function instantiate(template: Template, row: Record<string, unknown>, index: number, registry?: Registry): Instance {
  const rawId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : String(index + 1).padStart(3, "0");
  const issues: TemplateIssue[] = [];
  if (!ROW_ID.test(rawId)) {
    issues.push({ level: "error", code: "InvalidRowId", message: `id "${rawId}" chỉ gồm chữ thường, số, '-', '_'` });
  }
  const collected = collectParams(template, row, registry);
  issues.push(...collected.issues);
  const base = substitute(template.scene, collected.values, template.params, issues) as Record<string, unknown>;
  const scenes: Record<string, Record<string, unknown>> = {};
  for (const [name, format] of Object.entries(template.formats)) scenes[name] = applyFormat(base, format);
  return { rowId: rawId, values: collected.values, scenes, issues };
}
