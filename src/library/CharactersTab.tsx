import { useMemo, useState, type DragEvent } from "react";
import type { AssetEntry, AssetType } from "../schemas/asset.schema";
import { useEditor } from "../store/editorStore";
import { api, type ImportResult } from "./api";
import { AssetThumb } from "./AssetThumb";
import { aliasKind, ModelViewer } from "./CharacterViewer";

const LICENSES = ["CC0-1.0", "CC-BY-4.0", "MIT", "Proprietary-Owned"];

/** Tab hiển thị asset 3D (nhân vật hoặc bối cảnh/đạo cụ). */
export function ModelsTab({ types, title }: { types: AssetType[]; title: string }) {
  const registry = useEditor((s) => s.registry);
  const reloadRegistry = useEditor((s) => s.reloadRegistry);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [tag, setTag] = useState<string>();

  const assets = useMemo(() => (registry?.assets ?? []).filter((a) => types.includes(a.type)), [registry, types]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) for (const t of a.tags) if (!types.includes(t as AssetType)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [assets, types]);
  const packs = useMemo(() => [...new Set(assets.map((a) => a.pack).filter((p): p is string => !!p))].sort(), [assets]);
  const [pack, setPack] = useState("all");
  const shown = assets.filter(
    (a) =>
      (!tag || a.tags.includes(tag)) &&
      (pack === "all" || a.pack === pack) &&
      `${a.id} ${a.name} ${a.author} ${a.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = assets.find((a) => a.id === selectedId);

  return (
    <div className="lib-tab">
      <div className="lib-filters">
        <input className="search" placeholder={`Tìm ${title.toLowerCase()}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {packs.length > 0 && (
          <select value={pack} onChange={(e) => setPack(e.target.value)}>
            <option value="all">Mọi gói</option>
            {packs.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        )}
        <span className="muted">{shown.length} mục</span>
        <span className="spacer" />
        <button className="primary" onClick={() => setImporting(true)}>
          ＋ Thêm {title.toLowerCase()}
        </button>
      </div>
      {tagCounts.length > 0 && (
        <div className="tag-chips">
          <button className={!tag ? "active" : ""} onClick={() => setTag(undefined)}>
            tất cả
          </button>
          {tagCounts.map(([t, n]) => (
            <button key={t} className={tag === t ? "active" : ""} onClick={() => setTag(tag === t ? undefined : t)}>
              {t} <span className="muted">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="asset-grid">
        {shown.map((a) => (
          <button key={a.id} className={`asset-card ${a.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(a.id)}>
            <AssetThumb asset={a} />
            <div className="title">{a.name}</div>
            <div className="muted small">
              <code>{a.id}</code>
            </div>
            <div className="muted small">
              {a.type === "character" ? `${a.clips.length} động tác · ` : ""}
              {a.license}
              {a.pack ? ` · ${a.pack.replace(/^Quaternius · /, "")}` : ""}
            </div>
          </button>
        ))}
      </div>
      {selected && <AssetDetail key={selected.id} asset={selected} onClose={() => setSelectedId(undefined)} onSaved={() => void reloadRegistry()} />}
      {importing && (
        <ImportDialog
          defaultType={types[0] === "character" ? "character" : "prop"}
          onClose={() => setImporting(false)}
          onImported={(r) => {
            setImporting(false);
            void reloadRegistry().then(() => setSelectedId(r.entry.id));
          }}
        />
      )}
    </div>
  );
}

function AssetDetail({ asset, onClose, onSaved }: { asset: AssetEntry; onClose: () => void; onSaved: () => void }) {
  const [clip, setClip] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const aliases = Object.entries(asset.clipAliases);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal asset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{asset.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="asset-modal-body">
          <ModelViewer asset={asset} clip={clip} />
          <div className="asset-side">
            <div className="id-row">
              <code>{asset.id}</code>
              <button
                className="small-btn"
                onClick={() =>
                  void navigator.clipboard.writeText(asset.id).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  })
                }
              >
                {copied ? "✓ đã copy" : "copy id"}
              </button>
            </div>
            <p className="muted small">Dùng id này trong scene (&quot;asset&quot;) hoặc cột character của file CSV.</p>

            {asset.type === "character" && (
              <>
                <h3>Động tác chuẩn (dùng trong kịch bản)</h3>
                <div className="clip-list">
                  {aliases.length === 0 && <span className="muted small">Chưa có tên chuẩn</span>}
                  {aliases.map(([std, real]) => (
                    <button
                      key={std}
                      className={`clip ${aliasKind(std, real)} ${clip === std ? "active" : ""}`}
                      onClick={() => setClip(std)}
                      title={aliasKind(std, real) === "fallback" ? `Dự phòng: dùng tạm "${real}"` : real}
                    >
                      {std}
                      {aliasKind(std, real) === "fallback" && <span className="fb">≈{real}</span>}
                    </button>
                  ))}
                </div>
                <h3>Clip gốc trong file</h3>
                <div className="clip-list">
                  {asset.clips.map((c) => (
                    <button key={c} className={`clip raw ${clip === c ? "active" : ""}`} onClick={() => setClip(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </>
            )}

            <h3>Thông tin</h3>
            {editing ? (
              <EditForm
                asset={asset}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  onSaved();
                }}
              />
            ) : (
              <>
                <dl className="info">
                  <dt>Loại</dt>
                  <dd>{asset.type}</dd>
                  <dt>Chiều cao</dt>
                  <dd>{asset.height ? `${asset.height} m` : `giữ gốc × ${asset.scale ?? 1}`}</dd>
                  {asset.tags.length > 0 && (
                    <>
                      <dt>Nhãn</dt>
                      <dd>{asset.tags.join(", ")}</dd>
                    </>
                  )}
                  {asset.pack && (
                    <>
                      <dt>Gói</dt>
                      <dd>{asset.pack}</dd>
                    </>
                  )}
                  <dt>Xoay bù</dt>
                  <dd>{asset.headingOffset}°</dd>
                  <dt>File</dt>
                  <dd className="path">{asset.file}</dd>
                  <dt>License</dt>
                  <dd>
                    {asset.license} {asset.commercialUse ? "· dùng thương mại được" : "· KHÔNG dùng thương mại"}
                    {asset.attributionRequired ? " · cần ghi công" : ""}
                  </dd>
                  <dt>Tác giả</dt>
                  <dd>{asset.author}</dd>
                  <dt>Nguồn</dt>
                  <dd className="path">
                    {/^https?:/.test(asset.source) ? (
                      <a href={asset.source} target="_blank" rel="noreferrer">
                        {asset.source}
                      </a>
                    ) : (
                      asset.source
                    )}
                  </dd>
                </dl>
                <button onClick={() => setEditing(true)}>✎ Sửa thông tin</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditForm({ asset, onCancel, onSaved }: { asset: AssetEntry; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(asset.name);
  const [height, setHeight] = useState(asset.height?.toString() ?? "");
  const [heading, setHeading] = useState(String(asset.headingOffset));
  const [license, setLicense] = useState(asset.license);
  const [author, setAuthor] = useState(asset.author);
  const [source, setSource] = useState(asset.source);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.updateAsset(asset.id, {
        name,
        height: height.trim() ? Number(height) : null,
        headingOffset: Number(heading) || 0,
        license,
        author,
        source,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form">
      <label>
        Tên hiển thị
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Chiều cao (m) – để trống giữ kích thước gốc
        <input type="number" step="0.05" min="0.05" value={height} onChange={(e) => setHeight(e.target.value)} />
      </label>
      <label>
        Xoay bù (độ) – dùng khi model nhìn sai hướng
        <select value={heading} onChange={(e) => setHeading(e.target.value)}>
          {["0", "90", "180", "-90"].map((v) => (
            <option key={v} value={v}>
              {v}°
            </option>
          ))}
        </select>
      </label>
      <label>
        License
        <select value={license} onChange={(e) => setLicense(e.target.value)}>
          {[...new Set([...LICENSES, license])].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Tác giả
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <label>
        Nguồn
        <input value={source} onChange={(e) => setSource(e.target.value)} />
      </label>
      {error && <div className="lib-error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Đang lưu…" : "Lưu"}
        </button>
        <button onClick={onCancel}>Hủy</button>
      </div>
    </div>
  );
}

function suggestId(fileName: string, type: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const snake = stem
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${type === "character" ? "char" : type}_${snake}`;
}

function ImportDialog({ defaultType, onClose, onImported }: { defaultType: "character" | "prop"; onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [file, setFile] = useState<File>();
  const [type, setType] = useState<string>(defaultType);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [height, setHeight] = useState(defaultType === "character" ? "1.3" : "");
  const [license, setLicense] = useState("CC0-1.0");
  const [author, setAuthor] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ImportResult>();
  const [drag, setDrag] = useState(false);

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setId(suggestId(f.name, type));
    if (!name) setName(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.importAsset(file, { type, id, name, height, license, author, source });
      setResult(r);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Thêm asset 3D</h2>
          <button onClick={onClose}>✕</button>
        </div>
        {result ? (
          <div className="form">
            <p>
              ✓ Đã thêm <code>{result.entry.id}</code> – {result.entry.clips.length} clip.
            </p>
            {result.fallbacks.length > 0 && <p className="muted small">Động tác dự phòng: {result.fallbacks.join(", ")}</p>}
            {result.warnings.map((w) => (
              <p key={w} className="warn small">
                ⚠ {w}
              </p>
            ))}
            <p className="muted small">Kiểm tra cỡ và hướng trong trình xem; nếu nhìn sai hướng thì sửa &quot;Xoay bù&quot;.</p>
            <button className="primary" onClick={() => onImported(result)}>
              Xem asset
            </button>
          </div>
        ) : (
          <div className="form">
            <div
              className={`dropzone ${drag ? "drag" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              {file ? (
                <span>
                  📦 {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
                </span>
              ) : (
                <span>Kéo thả file .glb / .gltf / .fbx vào đây</span>
              )}
              <input type="file" accept=".glb,.gltf,.fbx" onChange={(e) => pick(e.target.files?.[0])} />
            </div>
            <p className="muted small">.gltf phải nhúng dữ liệu (1 file). Nhân vật cần có khung xương + animation trong file.</p>
            <label>
              Loại
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  if (file) setId(suggestId(file.name, e.target.value));
                }}
              >
                <option value="character">Nhân vật</option>
                <option value="prop">Đạo cụ</option>
                <option value="environment">Bối cảnh</option>
              </select>
            </label>
            <label>
              Id (chữ thường, số, _)
              <input value={id} onChange={(e) => setId(e.target.value)} />
            </label>
            <label>
              Tên hiển thị
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Chiều cao (m)
              <input type="number" step="0.05" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="để trống = giữ gốc" />
            </label>
            <label>
              License
              <select value={license} onChange={(e) => setLicense(e.target.value)}>
                {LICENSES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <label>
              Tác giả *
              <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="vd. Quaternius" />
            </label>
            <label>
              Nguồn (URL / mô tả) *
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://…" />
            </label>
            {error && <div className="lib-error">{error}</div>}
            <div className="row">
              <button className="primary" disabled={!file || !author.trim() || !source.trim() || !id || busy} onClick={() => void submit()}>
                {busy ? "Đang xử lý…" : "Thêm vào thư viện"}
              </button>
              <button onClick={onClose}>Hủy</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
