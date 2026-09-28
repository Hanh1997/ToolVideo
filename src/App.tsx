import { useEffect, useState } from "react";
import { ScenePanel } from "./components/ScenePanel";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { Viewport } from "./components/Viewport";
import { useAudioPreview } from "./components/useAudioPreview";
import { AiTab } from "./library/AiTab";
import { BatchTab } from "./library/BatchTab";
import { ModelsTab } from "./library/CharactersTab";
import { MediaTab } from "./library/MediaTab";
import { VideosTab } from "./library/VideosTab";
import { useEditor } from "./store/editorStore";

type Page = "editor" | "ai" | "videos" | "characters" | "batch" | "media";

const PAGES: { id: Page; label: string }[] = [
  { id: "editor", label: "✎ Editor" },
  { id: "ai", label: "✨ AI kịch bản" },
  { id: "videos", label: "🎞 Video" },
  { id: "characters", label: "🧍 Nhân vật" },
  { id: "batch", label: "▦ Batch" },
  { id: "media", label: "♪ Âm thanh & bối cảnh" },
];

const CHARACTER_TYPES = ["character"] as const;

interface Route {
  page: Page;
  /** #/editor/<projectId> */
  project?: string;
}

function parseHash(): Route {
  const [, page, arg] = window.location.hash.split("/");
  const p = PAGES.find((x) => x.id === page)?.id ?? "editor";
  return { page: p, project: p === "editor" && arg ? decodeURIComponent(arg) : undefined };
}

function go(page: Page, project?: string) {
  window.location.hash = project ? `#/${page}/${encodeURIComponent(project)}` : `#/${page}`;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    void useEditor.getState().init(parseHash().project);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openProject = (id: string) => go("editor", id);

  return (
    <div className="app-shell">
      <nav className="appnav">
        <strong className="brand">AutoCartoon</strong>
        {PAGES.map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={route.page === p.id ? "active" : ""}>
            {p.label}
          </a>
        ))}
      </nav>
      {route.page === "editor" && <EditorPage project={route.project} />}
      {route.page === "ai" && <AiTab openProject={openProject} openVideos={() => go("videos")} />}
      {route.page === "videos" && <VideosTab openProject={openProject} />}
      {route.page === "characters" && <ModelsTab types={[...CHARACTER_TYPES]} title="Nhân vật" />}
      {route.page === "batch" && <BatchTab openVideos={() => go("videos")} />}
      {route.page === "media" && <MediaTab />}
    </div>
  );
}

function EditorPage({ project }: { project?: string }) {
  const status = useEditor((s) => s.status);
  const projectId = useEditor((s) => s.projectId);
  useAudioPreview();

  useEffect(() => {
    if (!project || project === projectId) return;
    const s = useEditor.getState();
    void s.refreshProjects().then(() => s.openProject(project));
    // Chỉ khi route đổi project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  return (
    <div className="app">
      <Toolbar />
      <main className="main">
        <Viewport />
        <ScenePanel />
      </main>
      <Timeline />
      <footer className="status">{status}</footer>
    </div>
  );
}
