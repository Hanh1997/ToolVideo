import { create } from "zustand";
import { loadRegistry } from "../engine/AssetLoader";
import type { Registry } from "../schemas/asset.schema";
import type { SceneScript } from "../schemas/scene.schema";
import { needsResolve, type ResolveIssue } from "../tts/resolveScene";
import { validateScene, type SceneIssue } from "../validation/validateScene";

export interface ProjectSummary {
  id: string;
  name: string;
}

export interface EditorIssue extends Omit<SceneIssue, "code"> {
  code: SceneIssue["code"] | ResolveIssue["code"] | "InvalidJson" | "SceneLoadFailed" | "AnimationNotFound" | "AssetLoadFailed" | "ResolveFailed";
}

interface EditorState {
  registry?: Registry;
  projects: ProjectSummary[];
  projectId?: string;
  sceneText: string;
  scene?: SceneScript;
  issues: EditorIssue[];
  dirty: boolean;
  status?: string;

  time: number;
  playing: boolean;
  freeCamera: boolean;
  previewFps: number;
  muted: boolean;
  /** Tăng mỗi lần thời gian bị nhảy (seek/stop/play) → audio preview lập lịch lại. */
  seekId: number;

  init(preferredProject?: string): Promise<void>;
  /** Đọc lại Registry (sau khi thêm/sửa asset trong Thư viện). */
  reloadRegistry(): Promise<void>;
  /** Đọc lại danh sách project (batch tạo project mới). */
  refreshProjects(): Promise<void>;
  openProject(id: string): Promise<void>;
  setSceneText(text: string): void;
  /** Parse → (resolve TTS nếu cần) → validate. */
  applyScene(): Promise<boolean>;
  resolving: boolean;
  saveScene(): Promise<void>;
  reportLoadError(issue: EditorIssue): void;

  play(): void;
  pause(): void;
  stop(): void;
  seek(t: number): void;
  advance(dt: number): void;
  setFreeCamera(free: boolean): void;
  setPreviewFps(fps: number): void;
  setMuted(muted: boolean): void;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const useEditor = create<EditorState>()((set, get) => ({
  projects: [],
  sceneText: "",
  issues: [],
  dirty: false,
  time: 0,
  playing: false,
  freeCamera: false,
  previewFps: 0,
  muted: false,
  seekId: 0,
  resolving: false,

  async init(preferredProject) {
    try {
      const [registry, projects] = await Promise.all([loadRegistry(`/assets/registry.json?t=${Date.now()}`), fetchJson<ProjectSummary[]>("/api/projects")]);
      set({ registry, projects });
      const first = projects.find((p) => p.id === preferredProject) ?? projects[0];
      if (first) await get().openProject(first.id);
      else set({ status: "Chưa có project nào trong thư mục projects/" });
    } catch (err) {
      set({ status: `Khởi tạo thất bại: ${String(err)}` });
    }
  },

  async reloadRegistry() {
    const registry = await loadRegistry(`/assets/registry.json?t=${Date.now()}`);
    set({ registry });
    if (get().sceneText) await get().applyScene();
  },

  async refreshProjects() {
    set({ projects: await fetchJson<ProjectSummary[]>("/api/projects") });
  },

  async openProject(id) {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/scene`);
    if (!res.ok) {
      set({ status: `Không mở được project ${id} (${res.status})` });
      return;
    }
    const text = await res.text();
    set({ projectId: id, sceneText: text, dirty: false, time: 0, playing: false, status: `Đã mở ${id}` });
    await get().applyScene();
  },

  setSceneText(text) {
    set({ sceneText: text, dirty: true });
  },

  async applyScene() {
    const { sceneText, registry } = get();
    if (!registry) return false;
    let json: unknown;
    try {
      json = JSON.parse(sceneText);
    } catch (err) {
      set({ issues: [{ code: "InvalidJson", message: err instanceof Error ? err.message : String(err) }] });
      return false;
    }
    if (needsResolve(json)) {
      set({ resolving: true, status: "Đang tạo giọng đọc (TTS)…" });
      try {
        const res = await fetchJson<{ scene: unknown; issues: EditorIssue[]; synthesized: number }>("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: sceneText,
        });
        if (res.issues.length) {
          set({ issues: res.issues, playing: false, resolving: false, status: "Resolve lời thoại thất bại" });
          return false;
        }
        json = res.scene;
        set({ status: `TTS: ${res.synthesized} câu sinh mới, còn lại từ cache` });
      } catch (err) {
        set({ issues: [{ code: "ResolveFailed", message: String(err) }], resolving: false });
        return false;
      } finally {
        set({ resolving: false });
      }
    }
    const result = validateScene(json, registry);
    if (!result.ok) {
      set({ issues: result.issues, playing: false });
      return false;
    }
    const time = Math.min(get().time, result.scene.meta.duration);
    set({ scene: result.scene, issues: [], time });
    return true;
  },

  async saveScene() {
    const { projectId, sceneText } = get();
    if (!projectId || !(await get().applyScene())) {
      set({ status: "Không lưu: Scene Script chưa hợp lệ" });
      return;
    }
    try {
      await fetchJson(`/api/projects/${encodeURIComponent(projectId)}/scene`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: sceneText,
      });
      set({ dirty: false, status: `Đã lưu ${projectId}/scene.json lúc ${new Date().toLocaleTimeString()}` });
    } catch (err) {
      set({ status: `Lưu thất bại: ${String(err)}` });
    }
  },

  reportLoadError(issue) {
    set({ issues: [issue], playing: false });
  },

  play() {
    const { scene, time } = get();
    if (!scene) return;
    set((s) => ({ playing: true, time: time >= scene.meta.duration - 1e-3 ? 0 : time, seekId: s.seekId + 1 }));
  },
  pause() {
    set({ playing: false });
  },
  stop() {
    set((s) => ({ playing: false, time: 0, seekId: s.seekId + 1 }));
  },
  seek(t) {
    const d = get().scene?.meta.duration ?? 0;
    set((s) => ({ time: Math.min(Math.max(t, 0), d), seekId: s.seekId + 1 }));
  },
  advance(dt) {
    const { scene, time, playing } = get();
    if (!scene || !playing) return;
    const next = time + dt;
    if (next >= scene.meta.duration) set({ time: scene.meta.duration, playing: false });
    else set({ time: next });
  },
  setFreeCamera(free) {
    set({ freeCamera: free });
  },
  setPreviewFps(fps) {
    set({ previewFps: fps });
  },
  setMuted(muted) {
    set({ muted });
  },
}));
