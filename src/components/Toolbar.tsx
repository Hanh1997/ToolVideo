import { useState } from "react";
import { formatTime } from "../engine/time";
import { useEditor } from "../store/editorStore";

export function Toolbar() {
  const projects = useEditor((s) => s.projects);
  const projectId = useEditor((s) => s.projectId);
  const scene = useEditor((s) => s.scene);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const freeCamera = useEditor((s) => s.freeCamera);
  const previewFps = useEditor((s) => s.previewFps);
  const dirty = useEditor((s) => s.dirty);
  const muted = useEditor((s) => s.muted);
  const { openProject, play, pause, stop, setFreeCamera, setMuted } = useEditor.getState();
  const [copied, setCopied] = useState(false);

  const renderCmd = projectId ? `npm run render -- projects/${projectId}` : "";

  return (
    <header className="toolbar">
      <select value={projectId ?? ""} onChange={(e) => void openProject(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {dirty && <span className="badge">chưa lưu</span>}

      <div className="transport">
        <button onClick={() => (playing ? pause() : play())} disabled={!scene}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={stop} disabled={!scene}>
          ■ Stop
        </button>
        <span className="clock">
          {formatTime(time)} / {formatTime(scene?.meta.duration ?? 0)}
        </span>
      </div>

      <button onClick={() => setMuted(!muted)} title={muted ? "Bật tiếng" : "Tắt tiếng"}>
        {muted ? "🔇" : "🔊"}
      </button>

      <label className="toggle">
        <input type="checkbox" checked={freeCamera} onChange={(e) => setFreeCamera(e.target.checked)} />
        Camera tự do (khi dừng)
      </label>

      <span className="muted">{previewFps} FPS</span>
      {scene && (
        <span className="muted">
          {scene.meta.width}×{scene.meta.height} @{scene.meta.fps}
        </span>
      )}

      <button
        className="primary"
        disabled={!projectId}
        title={renderCmd}
        onClick={() => {
          void navigator.clipboard.writeText(renderCmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "✓ Đã copy lệnh render" : "Render MP4 (copy lệnh CLI)"}
      </button>
    </header>
  );
}
