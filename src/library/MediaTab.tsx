import { useState } from "react";
import type { AssetEntry } from "../schemas/asset.schema";
import { useEditor } from "../store/editorStore";
import { api } from "./api";
import { ModelsTab } from "./CharactersTab";

const PROP_TYPES = ["environment", "prop"] as const;

/** Âm thanh (nhạc, hiệu ứng), giọng đọc, bối cảnh & đạo cụ. */
export function MediaTab() {
  const registry = useEditor((s) => s.registry);
  const audio = (registry?.assets ?? []).filter((a) => a.type === "audio");
  const voices = (registry?.assets ?? []).filter((a) => a.type === "voice");

  return (
    <div className="lib-tab media-tab">
      <section>
        <h2>Nhạc nền & hiệu ứng</h2>
        <table className="report-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Tên</th>
              <th>Độ dài</th>
              <th>Nghe thử</th>
              <th>License</th>
            </tr>
          </thead>
          <tbody>
            {audio.map((a) => (
              <tr key={a.id}>
                <td>
                  <code>{a.id}</code>
                </td>
                <td>{a.name}</td>
                <td>{a.duration}s</td>
                <td>
                  <audio controls preload="none" src={`/assets/${a.file}`} />
                </td>
                <td className="small">{a.license}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Thêm âm thanh: chép file vào public/assets/audio/ và khai báo trong registry.json (type &quot;audio&quot;, có duration).</p>
      </section>

      <section>
        <h2>Giọng đọc</h2>
        {voices.map((v) => (
          <VoiceRow key={v.id} voice={v} />
        ))}
      </section>

      <section>
        <h2>Bối cảnh & đạo cụ</h2>
        <ModelsTab types={[...PROP_TYPES]} title="Bối cảnh / đạo cụ" />
      </section>
    </div>
  );
}

function VoiceRow({ voice }: { voice: AssetEntry }) {
  const [text, setText] = useState("Xin chào các bạn nhỏ! Hôm nay chúng mình cùng học nhé.");
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const speak = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ttsPreview(voice.id, text);
      setUrl(`${r.url}?t=${Date.now()}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-row">
      <div>
        <strong>{voice.name}</strong> <code>{voice.id}</code>
        <div className="muted small">
          {voice.provider} · {voice.language} · tốc độ {voice.defaultRate ?? 1} · {voice.license}
          {voice.attributionRequired ? " · cần ghi công" : ""}
        </div>
      </div>
      <div className="row">
        <input className="grow" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void speak()}>
          {busy ? "Đang tạo…" : "🔊 Nghe thử"}
        </button>
      </div>
      {url && <audio controls autoPlay src={url} />}
      {error && <div className="lib-error">{error}</div>}
    </div>
  );
}
