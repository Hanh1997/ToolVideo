import { useEditor } from "../store/editorStore";

export function ScenePanel() {
  const sceneText = useEditor((s) => s.sceneText);
  const issues = useEditor((s) => s.issues);
  const dirty = useEditor((s) => s.dirty);
  const registry = useEditor((s) => s.registry);
  const resolving = useEditor((s) => s.resolving);
  const { setSceneText, applyScene, saveScene } = useEditor.getState();

  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>Scene Script</h2>
        <div className="panel-actions">
          <button onClick={() => void applyScene()} title="Ctrl+Enter" disabled={resolving}>
            {resolving ? "Đang tạo giọng…" : "Áp dụng"}
          </button>
          <button className="primary" onClick={() => void saveScene()} disabled={!dirty} title="Ctrl+S">
            Lưu
          </button>
        </div>
      </div>
      <textarea
        className="scene-json"
        spellCheck={false}
        value={sceneText}
        onChange={(e) => setSceneText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void applyScene();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void saveScene();
          }
        }}
      />
      {issues.length > 0 ? (
        <ul className="issues">
          {issues.map((i, idx) => (
            <li key={idx}>
              <code>{i.code}</code> {i.message}
              {i.path ? <span className="path"> @ {i.path}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="valid">✓ Scene Script hợp lệ</div>
      )}
      {registry && (
        <details className="assets">
          <summary>Asset Registry ({registry.assets.length})</summary>
          {registry.assets.map((a) => (
            <div key={a.id} className="asset">
              <div>
                <code>{a.id}</code> <span className="muted">{a.type} · {a.license}</span>
              </div>
              {a.clips.length > 0 && <div className="muted small">{a.clips.join(", ")}</div>}
            </div>
          ))}
        </details>
      )}
    </aside>
  );
}
