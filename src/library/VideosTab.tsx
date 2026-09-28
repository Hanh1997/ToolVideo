import { useEffect, useMemo, useState } from "react";
import { formatTime } from "../engine/time";
import { api, aspectLabel, formatBytes, formatDate, type VideoEntry } from "./api";

const STATUS_LABEL: Record<string, string> = { Completed: "Xong", Failed: "Lỗi", Processing: "Đang render", Cancelled: "Đã hủy", Pending: "Chờ" };

export function VideosTab({ openProject }: { openProject: (id: string) => void }) {
  const [videos, setVideos] = useState<VideoEntry[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [format, setFormat] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<VideoEntry>();

  const load = () => {
    setError(undefined);
    api.videos().then(setVideos, (e: unknown) => setError(String(e)));
  };
  useEffect(load, []);

  const sources = useMemo(() => [...new Set((videos ?? []).map((v) => `${v.source.kind}:${v.source.id}`))].sort(), [videos]);
  const filtered = (videos ?? []).filter((v) => {
    if (source !== "all" && `${v.source.kind}:${v.source.id}` !== source) return false;
    if (format !== "all" && aspectLabel(v.width, v.height) !== format) return false;
    if (status !== "all" && (status === "ok" ? v.status !== "Completed" : v.status === "Completed")) return false;
    const q = query.trim().toLowerCase();
    return !q || `${v.name} ${v.source.id} ${v.project ?? ""}`.toLowerCase().includes(q);
  });
  const totalSize = filtered.reduce((s, v) => s + (v.sizeBytes ?? 0), 0);

  return (
    <div className="lib-tab">
      <div className="lib-filters">
        <input className="search" placeholder="Tìm theo tên, project, batch…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">Mọi nguồn</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s.startsWith("batch:") ? `Batch · ${s.slice(6)}` : `Project · ${s.slice(8)}`}
            </option>
          ))}
        </select>
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="all">Mọi khung hình</option>
          <option value="16:9">16:9 (ngang)</option>
          <option value="9:16">9:16 (dọc)</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Mọi trạng thái</option>
          <option value="ok">Đã xong</option>
          <option value="bad">Lỗi / chưa xong</option>
        </select>
        <button onClick={load}>↻ Làm mới</button>
        <span className="muted">
          {filtered.length} video · {formatBytes(totalSize)}
        </span>
      </div>

      {error && <div className="lib-error">{error}</div>}
      {!videos && !error && <div className="muted pad">Đang tải…</div>}
      {videos && filtered.length === 0 && <div className="muted pad">Chưa có video nào. Render bằng Editor (copy lệnh) hoặc tab Batch.</div>}

      <div className="video-grid">
        {filtered.map((v) => (
          <button key={v.path} className={`video-card ${v.exists ? "" : "failed"}`} onClick={() => setSelected(v)}>
            <div className={`thumb ${aspectLabel(v.width, v.height) === "9:16" ? "portrait" : ""}`}>
              {v.exists ? <img src={api.thumbUrl(v)} loading="lazy" alt="" /> : <div className="thumb-missing">✗</div>}
              {v.duration !== undefined && <span className="duration">{formatTime(v.duration).slice(0, 5)}</span>}
              <span className="fmt">{aspectLabel(v.width, v.height)}</span>
            </div>
            <div className="video-meta">
              <div className="title">{v.name}</div>
              <div className="muted small">
                {v.source.kind === "batch" ? "Batch" : "Project"} · {v.source.id}
              </div>
              <div className="muted small">
                <span className={`status s-${v.status}`}>{STATUS_LABEL[v.status] ?? v.status}</span> · {formatDate(v.modifiedAt)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <VideoModal
          video={selected}
          onClose={() => setSelected(undefined)}
          onDeleted={() => {
            setSelected(undefined);
            load();
          }}
          openProject={openProject}
        />
      )}
    </div>
  );
}

function VideoModal({ video: v, onClose, onDeleted, openProject }: { video: VideoEntry; onClose: () => void; onDeleted: () => void; openProject: (id: string) => void }) {
  const [msg, setMsg] = useState<string>();
  const portrait = aspectLabel(v.width, v.height) === "9:16";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async () => {
    if (!confirm(`Xóa video "${v.name}" cùng phụ đề và file kèm theo? Không thể hoàn tác.`)) return;
    try {
      await api.deleteVideo(v.path);
      onDeleted();
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal video-modal ${portrait ? "portrait" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{v.name}</h2>
          <button onClick={onClose} title="Đóng (Esc)">
            ✕
          </button>
        </div>
        <div className="video-modal-body">
          {v.exists ? (
            <video src={api.mediaUrl(v.path)} controls autoPlay className="player">
              {v.hasSubtitles && <track kind="subtitles" srcLang="vi" label="Tiếng Việt" src={api.vttUrl(v.path)} />}
            </video>
          ) : (
            <div className="lib-error">Render không thành công – chưa có file video.</div>
          )}
          <dl className="info">
            <dt>Trạng thái</dt>
            <dd>{STATUS_LABEL[v.status] ?? v.status}</dd>
            <dt>Nguồn</dt>
            <dd>
              {v.source.kind === "batch" ? "Batch" : "Project"} {v.source.id}
            </dd>
            <dt>Khung hình</dt>
            <dd>
              {v.width && v.height ? `${v.width}×${v.height} (${aspectLabel(v.width, v.height)})` : "–"}
              {v.fps ? ` @${v.fps}fps` : ""}
            </dd>
            <dt>Thời lượng</dt>
            <dd>{v.duration !== undefined ? `${v.duration}s` : "–"}</dd>
            <dt>Dung lượng</dt>
            <dd>{formatBytes(v.sizeBytes)}</dd>
            <dt>Render lúc</dt>
            <dd>{formatDate(v.modifiedAt)}</dd>
            {v.elapsedSeconds !== undefined && (
              <>
                <dt>Thời gian render</dt>
                <dd>{v.elapsedSeconds}s</dd>
              </>
            )}
            {v.loudness !== undefined && (
              <>
                <dt>Độ to gốc</dt>
                <dd>{v.loudness} LUFS → chuẩn hóa</dd>
              </>
            )}
            <dt>Phụ đề</dt>
            <dd>{v.hasSubtitles ? "Có (.srt + track trong MP4)" : "Không"}</dd>
            <dt>File</dt>
            <dd className="path">{v.path}</dd>
            {v.error && (
              <>
                <dt>Lỗi</dt>
                <dd className="err">{v.error}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="modal-actions">
          {v.exists && (
            <a className="btn primary" href={api.mediaUrl(v.path, true)}>
              ⬇ Tải xuống
            </a>
          )}
          {v.hasSubtitles && (
            <a className="btn" href={api.mediaUrl(v.path.replace(/\.mp4$/, ".srt"), true)}>
              ⬇ Phụ đề .srt
            </a>
          )}
          <button onClick={() => void api.openFolder(v.exists ? v.path : v.path.replace(/\.mp4$/, ".render.json")).catch((e: unknown) => setMsg(String(e)))}>
            📂 Mở thư mục
          </button>
          {v.project && <button onClick={() => openProject(v.project!)}>✎ Mở project trong Editor</button>}
          <span className="spacer" />
          <button className="danger" onClick={() => void remove()}>
            🗑 Xóa
          </button>
        </div>
        {msg && <div className="lib-error">{msg}</div>}
      </div>
    </div>
  );
}
