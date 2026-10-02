import type { CharacterSpec } from "../ai/characterSpec";
import type { AssetEntry } from "../schemas/asset.schema";
import type { TemplateParam } from "../template/template";

export interface VideoEntry {
  path: string;
  name: string;
  source: { kind: "project" | "batch"; id: string };
  project?: string;
  status: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  sizeBytes?: number;
  modifiedAt: string;
  elapsedSeconds?: number;
  hasSubtitles: boolean;
  error?: string;
  exists: boolean;
  loudness?: number;
}

export interface ImportResult {
  entry: AssetEntry;
  fallbacks: string[];
  warnings: string[];
}

export interface BatchJobRow {
  row: string;
  format: string;
  project: string;
  status: string;
  duration?: number;
  output?: string;
  elapsedSeconds?: number;
  error?: string;
}

export interface BatchReport {
  template: string;
  startedAt: string;
  finishedAt: string;
  summary: Record<string, number>;
  jobs: BatchJobRow[];
}

export interface TemplateInfo {
  id: string;
  dir: string;
  name: string;
  description?: string;
  params?: Record<string, TemplateParam>;
  formats?: Record<string, { width: number; height: number }>;
  columns?: string[];
  rows?: Record<string, string>[];
  report?: BatchReport;
  error?: string;
}

export interface BatchJob {
  id: string;
  template: string;
  args: string[];
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  log: string[];
  report?: BatchReport;
}

export interface CharGenStatus {
  ai: boolean;
  blender: string | null;
  mixamoClips: number;
}

export interface CharGenJob {
  id: string;
  assetId: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  step: string;
  progress: number;
  mixamoClips: number;
  clips?: number;
  log: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  videos: () => request<VideoEntry[]>("/api/videos"),
  deleteVideo: (path: string) => request<{ removed: string[] }>(`/api/videos?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  openFolder: (path: string) => request<{ ok: true }>("/api/open-folder", json("POST", { path })),
  mediaUrl: (path: string, download = false) => `/media/${path.split("/").map(encodeURIComponent).join("/")}${download ? "?download" : ""}`,
  thumbUrl: (v: VideoEntry) => `/api/videos/thumb?path=${encodeURIComponent(v.path)}&t=${encodeURIComponent(v.modifiedAt)}`,
  vttUrl: (path: string) => `/api/videos/vtt?path=${encodeURIComponent(path)}`,

  importAsset: (file: File, params: Record<string, string>) =>
    request<ImportResult>(`/api/assets/import?${new URLSearchParams(params).toString()}`, {
      method: "POST",
      headers: { "X-Filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
      body: file,
    }),
  updateAsset: (id: string, patch: Record<string, unknown>) => request<AssetEntry>(`/api/assets/${encodeURIComponent(id)}`, json("PATCH", patch)),
  ttsPreview: (voice: string, text: string) => request<{ url: string; duration: number; cached: boolean }>("/api/tts/preview", json("POST", { voice, text })),

  templates: () => request<TemplateInfo[]>("/api/templates"),
  saveTemplateData: (dir: string, columns: string[], rows: Record<string, string>[]) =>
    request<{ ok: true }>(`/api/templates/${encodeURIComponent(dir)}/data`, json("PUT", { columns, rows })),
  runBatch: (body: { template: string; formats?: string[]; only?: string[]; force?: boolean; dryRun?: boolean; concurrency?: number }) =>
    request<{ id: string }>("/api/batch", json("POST", body)),
  currentBatch: () => request<BatchJob | null>("/api/batch/current"),
  cancelBatch: () => request<{ ok: true }>("/api/batch/cancel", json("POST", {})),

  chargen: {
    status: () => request<CharGenStatus>("/api/chargen/status"),
    design: (prompt: string) => request<{ spec: CharacterSpec; note?: string }>("/api/chargen/design", json("POST", { prompt })),
    revise: (base: CharacterSpec, instruction: string) => request<{ spec: CharacterSpec; note?: string }>("/api/chargen/design", json("POST", { base, instruction })),
    build: (spec: CharacterSpec, prompt?: string, id?: string) => request<CharGenJob>("/api/chargen/build", json("POST", { spec, prompt, id })),
    job: () => request<CharGenJob | null>("/api/chargen/job"),
    cancel: () => request<{ ok: true }>("/api/chargen/job/cancel", json("POST", {})),
    savedList: () => request<{ assetId: string; name: string; spec: CharacterSpec }[]>("/api/chargen/saved"),
    fromBase: (base: CharacterSpec, prompt: string) => request<{ spec: CharacterSpec; note?: string }>("/api/chargen/design", json("POST", { base, instruction: prompt, fromBase: true })),
    saved: (id: string) => request<{ assetId: string; prompt?: string; spec: CharacterSpec }>(`/api/chargen/saved/${encodeURIComponent(id)}`),
    previewUrl: (id: string, face = false, v = "") => `/api/chargen/preview/${encodeURIComponent(id)}/preview${face ? "_face" : ""}.png?v=${encodeURIComponent(v)}`,
  },
};

export function formatBytes(n?: number): string {
  if (n === undefined) return "–";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("vi-VN")} ${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`;
}

export function aspectLabel(w?: number, h?: number): string {
  if (!w || !h) return "?";
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.02) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.02) return "9:16";
  if (Math.abs(r - 1) < 0.02) return "1:1";
  return `${w}×${h}`;
}
