import { useEffect, useState } from "react";
import {
  ACCESSORIES,
  AGES,
  BOTTOM_STYLES,
  SHOE_STYLES,
  BROW_STYLES,
  BUILDS,
  CHEEK_STYLES,
  DEFAULT_SPEC,
  EAR_STYLES,
  EYE_SHAPES,
  FACE_SHAPES,
  FACIAL_HAIR,
  GENDERS,
  HAIR_STYLES,
  MOUTH_STYLES,
  NOSE_STYLES,
  normalizeCharacterSpec,
  PATTERNS,
  TOP_STYLES,
  type Accessory,
  type CharacterFace,
  type CharacterSpec,
} from "../ai/characterSpec";
import { useEditor } from "../store/editorStore";
import { api, type CharGenJob, type CharGenStatus } from "./api";
import { forgetModel } from "./modelPreview";

const EXAMPLES = [
  "cô bé 7 tuổi tóc đuôi ngựa nâu, váy hồng chấm bi trắng, đeo ba lô vàng",
  "ông cụ hói, ria mép bạc, đeo kính, áo sơ mi trắng thắt cà vạt đỏ, quần nâu",
  "chàng trai tóc vuốt dựng đen, áo hoodie xanh lá, quần jean, đội mũ lưỡi trai",
];

/**
 * Tạo nhân vật người từ mô tả: AI thiết kế (CharacterSpec) → người dùng chỉnh trên form → Blender dựng (job) → thư viện.
 * `editId`: sửa & dựng lại nhân vật đã tạo (ghi đè cùng id).
 */
export function CharacterGenDialog({ editId, onClose, onDone }: { editId?: string; onClose: () => void; onDone: (assetId: string) => void }) {
  const reloadRegistry = useEditor((s) => s.reloadRegistry);
  const [status, setStatus] = useState<CharGenStatus>();
  const [prompt, setPrompt] = useState("");
  const [spec, setSpec] = useState<CharacterSpec>();
  const [note, setNote] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<CharGenJob | null>(null);
  const [target, setTarget] = useState(editId);
  /** Nhân vật gốc để phát triển nhân vật mới (giữ cơ thể / khuôn mặt, chỉ thêm quần áo, tóc…). */
  const [bases, setBases] = useState<{ assetId: string; name: string; spec: CharacterSpec }[]>([]);
  const [baseId, setBaseId] = useState("");
  const base = bases.find((b) => b.assetId === baseId);

  useEffect(() => {
    void api.chargen.status().then(setStatus, (e: unknown) => setError(String(e)));
    void api.chargen.job().then((j) => j?.status === "running" && setJob(j));
    if (!editId) {
      void api.chargen.savedList().then((list) => {
        setBases(list);
        // mặc định: nhân vật gốc (không mặc gì) nếu có
        const b = list.find((x) => x.spec.top.style === "none");
        if (b) setBaseId(b.assetId);
      });
    }
    if (editId) {
      void api.chargen.saved(editId).then(
        (s) => {
          setSpec(s.spec);
          setPrompt(s.prompt ?? "");
        },
        () => setError("Không có bản mô tả đã lưu của nhân vật này"),
      );
    }
  }, [editId]);

  // Theo dõi job dựng; xong thì nạp lại registry (thumbnail / trình xem lấy bản mới).
  const running = job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void api.chargen.job().then((j) => {
        if (!j) return;
        setJob(j);
        if (j.status === "completed") {
          setTarget(j.assetId);
          forgetModel({ id: j.assetId, file: `characters/${j.assetId}.glb` });
          void reloadRegistry();
        }
      });
    }, 1000);
    return () => clearInterval(t);
  }, [running, reloadRegistry]);

  const ask = async (fn: () => Promise<{ spec: CharacterSpec; note?: string }>) => {
    setThinking(true);
    setError(undefined);
    try {
      const r = await fn();
      setSpec(r.spec);
      setNote(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
    }
  };

  const build = async (id = target) => {
    if (!spec) return;
    setError(undefined);
    try {
      setJob(await api.chargen.build(normalizeCharacterSpec(spec), prompt.trim() || undefined, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const done = job?.status === "completed" ? job : undefined;
  const previewId = done?.assetId ?? (editId && !running ? editId : undefined);

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal chargen-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{editId ? "✨ Sửa & dựng lại nhân vật" : "✨ Tạo nhân vật bằng mô tả"}</h2>
          <button onClick={onClose} title={running ? "Đóng – việc dựng vẫn chạy nền" : undefined}>
            ✕
          </button>
        </div>
        <div className="chargen-body">
          <div className="form">
            {!editId && bases.length > 0 && (
              <label>
                Dựa trên nhân vật có sẵn (giữ cơ thể, tỉ lệ, khuôn mặt, màu da – AI chỉ thêm / đổi theo mô tả)
                <select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
                  <option value="">— Không, AI thiết kế từ đầu —</option>
                  {bases.map((b) => (
                    <option key={b.assetId} value={b.assetId}>
                      {b.name}
                      {b.spec.top.style === "none" ? " (nhân vật gốc)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {base ? `Mô tả nhân vật mới phát triển từ “${base.name}” (quần áo, tóc, phụ kiện, tên…)` : "Mô tả nhân vật (tuổi, giới tính, dáng người, tóc, quần áo, phụ kiện…)"}
              <textarea className="ai-prompt" rows={3} value={prompt} placeholder={EXAMPLES[0]} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="row">
              <button className="primary" disabled={thinking || prompt.trim().length < 3 || !status?.ai} onClick={() => void ask(() => (base ? api.chargen.fromBase(base.spec, prompt) : api.chargen.design(prompt)))}>
                {thinking && !spec ? "AI đang thiết kế…" : spec ? "✨ Thiết kế lại từ mô tả" : "✨ AI thiết kế"}
              </button>
              {!spec && <button onClick={() => setSpec(base ? { ...base.spec, name: `${base.spec.name} mới` } : DEFAULT_SPEC)}>{base ? `Tự chỉnh từ “${base.name}”` : "Tự chỉnh từ mẫu trống"}</button>}
              {status && !status.ai && <span className="warn small">Chưa có DEEPSEEK_API_KEY trong .env – chỉ tự chỉnh được</span>}
            </div>
            {!spec && (
              <div className="muted small">
                Ví dụ:
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chargen-example" onClick={() => setPrompt(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            )}
            {note && <p className="warn small">⚠ {note}</p>}
            {spec && (
              <>
                <SpecForm spec={spec} onChange={setSpec} />
                <div className="row">
                  <input
                    className="grow"
                    placeholder="Sửa bằng lời, vd. “cho áo màu cam, thêm kính râm, tóc ngắn hơn”"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && instruction.trim() && void ask(() => api.chargen.revise(spec, instruction))}
                  />
                  <button disabled={thinking || !instruction.trim() || !status?.ai} onClick={() => void ask(() => api.chargen.revise(spec, instruction))}>
                    {thinking ? "AI đang sửa…" : "Sửa bằng AI"}
                  </button>
                </div>
              </>
            )}
            {error && <div className="lib-error">{error}</div>}
          </div>

          <div className="chargen-side">
            {previewId ? (
              <div className="chargen-previews">
                <img src={api.chargen.previewUrl(previewId, false, done?.finishedAt ?? "")} alt="Toàn thân" />
                <img src={api.chargen.previewUrl(previewId, true, done?.finishedAt ?? "")} alt="Khuôn mặt" />
              </div>
            ) : (
              <div className="chargen-empty muted small">{spec ? "Chỉnh thông số bên trái rồi bấm Dựng." : "Nhập mô tả rồi bấm “AI thiết kế”."}</div>
            )}
            {job && (
              <div className="job-panel">
                <div className="row">
                  <b>{job.name}</b>
                  <span className="spacer" />
                  <span className={`status s-${job.status === "completed" ? "Completed" : job.status === "failed" ? "Failed" : ""}`}>
                    {job.status === "running" ? `${job.progress}%` : job.status === "completed" ? "✓ Xong" : job.status === "failed" ? "✗ Lỗi" : "Đã hủy"}
                  </span>
                </div>
                <div className="progress">
                  <div style={{ width: `${job.progress}%` }} />
                </div>
                <div className="muted small">{job.status === "failed" ? job.error : job.step}</div>
                {job.status !== "completed" && job.log.length > 0 && <pre className="log">{job.log.slice(-8).join("\n")}</pre>}
              </div>
            )}
            <div className="row">
              {running ? (
                <button onClick={() => void api.chargen.cancel().then(() => api.chargen.job().then(setJob))}>Hủy dựng</button>
              ) : (
                <>
                  <button className="primary" disabled={!spec || !status?.blender} onClick={() => void build()}>
                    {target ? "🧍 Dựng lại (ghi đè)" : "🧍 Dựng nhân vật 3D"}
                  </button>
                  {target && (
                    <button disabled={!spec || !status?.blender} onClick={() => void build("")}>
                      Dựng thành nhân vật mới
                    </button>
                  )}
                </>
              )}
              {done && (
                <button className="primary" onClick={() => onDone(done.assetId)}>
                  Xem trong thư viện
                </button>
              )}
            </div>
            <p className="muted small">
              {!status
                ? "…"
                : !status.blender
                  ? "⚠ Không tìm thấy Blender – cài Blender hoặc đặt BLENDER_PATH trong .env."
                  : status.mixamoClips
                    ? `Mất khoảng 2 phút: dựng hình + chuyển ${status.mixamoClips} hoạt ảnh Mixamo. Có thể đóng hộp thoại, việc dựng vẫn chạy.`
                    : "Vài giây (chỉ hoạt ảnh tự sinh – không thấy thư viện Mixamo ở D:/Mixamo / MIXAMO_DIR)."}
            </p>
            {done && <p className="muted small">✓ {done.clips} động tác · id <code>{done.assetId}</code></p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: Record<T, string>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label>
      {label}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {(Object.entries(options) as [T, string][]).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="chargen-color">
      {label}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SpecForm({ spec, onChange }: { spec: CharacterSpec; onChange: (s: CharacterSpec) => void }) {
  const set = (patch: Partial<CharacterSpec>) => onChange({ ...spec, ...patch });
  const setFace = (patch: Partial<CharacterFace>) => set({ face: { ...spec.face, ...patch } });
  const noBeard = spec.gender === "female" || spec.age === "toddler" || spec.age === "child";
  const toggle = (a: Accessory) =>
    onChange(normalizeCharacterSpec({ ...spec, accessories: spec.accessories.includes(a) ? spec.accessories.filter((x) => x !== a) : [a, ...spec.accessories] }));

  return (
    <div className="chargen-form">
      <h3>Cơ thể</h3>
      <label className="wide">
        Tên hiển thị
        <input value={spec.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <Select label="Giới tính" value={spec.gender} options={GENDERS} onChange={(gender) => set({ gender })} />
      <Select label="Tuổi" value={spec.age} options={AGES} onChange={(age) => set({ age })} />
      <Select label="Dáng người" value={spec.build} options={BUILDS} onChange={(build) => set({ build })} />
      <div className="chargen-colors">
        <Color label="Da" value={spec.skin} onChange={(skin) => set({ skin })} />
        <Color label="Mắt" value={spec.eyes} onChange={(eyes) => set({ eyes })} />
      </div>

      <h3>Khuôn mặt</h3>
      <Select label="Dáng mặt" value={spec.face.shape} options={FACE_SHAPES} onChange={(shape) => setFace({ shape })} />
      <Select label="Mắt" value={spec.face.eyes} options={EYE_SHAPES} onChange={(eyes) => setFace({ eyes })} />
      <Select label="Lông mày" value={spec.face.brows} options={BROW_STYLES} onChange={(brows) => setFace({ brows })} />
      <Select label="Mũi" value={spec.face.nose} options={NOSE_STYLES} onChange={(nose) => setFace({ nose })} />
      <Select label="Miệng" value={spec.face.mouth} options={MOUTH_STYLES} onChange={(mouth) => setFace({ mouth })} />
      <Select label="Tai" value={spec.face.ears} options={EAR_STYLES} onChange={(ears) => setFace({ ears })} />
      <Select label="Má" value={spec.face.cheeks} options={CHEEK_STYLES} onChange={(cheeks) => setFace({ cheeks })} />
      <label className="chargen-check">
        <input type="checkbox" checked={spec.face.wrinkles} onChange={(e) => setFace({ wrinkles: e.target.checked })} /> Nếp nhăn
      </label>

      <h3>Tóc</h3>
      <Select label="Kiểu tóc" value={spec.hair.style} options={HAIR_STYLES} onChange={(style) => set({ hair: { ...spec.hair, style } })} />
      <Select label="Râu" value={noBeard ? "none" : spec.facialHair} options={FACIAL_HAIR} disabled={noBeard} onChange={(facialHair) => set({ facialHair })} />
      <div className="chargen-colors">
        <Color label="Màu tóc" value={spec.hair.color} onChange={(color) => set({ hair: { ...spec.hair, color } })} />
      </div>

      <h3>Áo</h3>
      <Select label="Kiểu áo" value={spec.top.style} options={TOP_STYLES} onChange={(style) => set({ top: { ...spec.top, style } })} />
      <Select label="Hoạ tiết" value={spec.top.pattern} options={PATTERNS} onChange={(pattern) => set({ top: { ...spec.top, pattern } })} />
      <div className="chargen-colors">
        <Color label="Màu áo" value={spec.top.color} onChange={(color) => set({ top: { ...spec.top, color } })} />
        {spec.top.pattern !== "none" && <Color label="Màu hoạ tiết" value={spec.top.patternColor} onChange={(patternColor) => set({ top: { ...spec.top, patternColor } })} />}
      </div>

      <h3>Quần / váy · giày</h3>
      <Select label="Kiểu" value={spec.bottom.style} options={BOTTOM_STYLES} disabled={spec.top.style === "dress"} onChange={(style) => set({ bottom: { ...spec.bottom, style } })} />
      <Select label="Giày" value={spec.shoes.style} options={SHOE_STYLES} onChange={(style) => set({ shoes: { ...spec.shoes, style } })} />
      <div className="chargen-colors">
        {spec.top.style !== "dress" && <Color label="Màu quần / váy" value={spec.bottom.color} onChange={(color) => set({ bottom: { ...spec.bottom, color } })} />}
        {spec.shoes.style !== "barefoot" && <Color label="Giày" value={spec.shoes.color} onChange={(color) => set({ shoes: { ...spec.shoes, color } })} />}
        <Color label="Viền giày" value={spec.shoes.accent} onChange={(accent) => set({ shoes: { ...spec.shoes, accent } })} />
      </div>

      <h3>Phụ kiện</h3>
      <div className="chargen-acc wide">
        {(Object.entries(ACCESSORIES) as [Accessory, string][]).map(([k, v]) => (
          <button key={k} className={spec.accessories.includes(k) ? "active" : ""} onClick={() => toggle(k)}>
            {v}
          </button>
        ))}
      </div>
      <div className="chargen-colors wide">
        <Color label="Màu phụ kiện" value={spec.accessoryColor} onChange={(accessoryColor) => set({ accessoryColor })} />
      </div>
    </div>
  );
}
