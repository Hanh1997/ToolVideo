import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "../store/editorStore";
import { api, type BatchJob, type BatchReport, type TemplateInfo } from "./api";

const STATUS_LABEL: Record<string, string> = {
  Completed: "✓ Xong",
  Skipped: "= Không đổi",
  Ready: "● Sẵn sàng",
  Invalid: "✗ Lỗi dữ liệu",
  Failed: "✗ Lỗi render",
  Cancelled: "■ Hủy",
};

export function BatchTab({ openVideos }: { openVideos: () => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[]>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<BatchJob | null>(null);

  const loadTemplates = useCallback(() => {
    api.templates().then(
      (t) => {
        setTemplates(t);
        setSelected((s) => s ?? t[0]?.dir);
      },
      (e: unknown) => setError(String(e)),
    );
  }, []);
  useEffect(loadTemplates, [loadTemplates]);

  // Theo dõi batch đang chạy.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await api.currentBatch();
        if (stop) return;
        setJob(j);
        timer = setTimeout(() => void poll(), j?.status === "running" ? 1500 : 5000);
      } catch {
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const tpl = templates?.find((t) => t.dir === selected);

  return (
    <div className="lib-tab batch-tab">
      <aside className="tpl-list">
        <h3>Template</h3>
        {templates?.map((t) => (
          <button key={t.dir} className={t.dir === selected ? "active" : ""} onClick={() => setSelected(t.dir)}>
            <div>{t.name}</div>
            <div className="muted small">
              {t.dir} · {t.rows?.length ?? 0} dòng
            </div>
          </button>
        ))}
        {templates?.length === 0 && <p className="muted small">Chưa có template trong thư mục templates/</p>}
      </aside>
      <section className="tpl-main">
        {error && <div className="lib-error">{error}</div>}
        {tpl?.error && <div className="lib-error">Template lỗi: {tpl.error}</div>}
        {tpl && !tpl.error && <TemplatePanel key={tpl.dir} tpl={tpl} job={job} onJob={setJob} onSaved={loadTemplates} openVideos={openVideos} />}
      </section>
    </div>
  );
}

function TemplatePanel({
  tpl,
  job,
  onJob,
  onSaved,
  openVideos,
}: {
  tpl: TemplateInfo;
  job: BatchJob | null;
  onJob: (j: BatchJob | null) => void;
  onSaved: () => void;
  openVideos: () => void;
}) {
  const columns = tpl.columns ?? [];
  const registry = useEditor((s) => s.registry);
  const [rows, setRows] = useState<Record<string, string>[]>(tpl.rows ?? []);
  const [dirty, setDirty] = useState(false);
  const [formats, setFormats] = useState<string[]>(Object.keys(tpl.formats ?? {}));
  const [force, setForce] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [onlySelected, setOnlySelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string>();
  const logRef = useRef<HTMLPreElement>(null);

  const running = job?.status === "running";
  const mine = job?.template === tpl.id;
  const report: BatchReport | undefined = mine && job?.report ? job.report : tpl.report;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  const setCell = (i: number, col: string, value: string) => {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [col]: value } : row)));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    try {
      await api.saveTemplateData(tpl.dir, columns, rows);
      setDirty(false);
      setMsg("Đã lưu data.csv");
      onSaved();
      return true;
    } catch (e) {
      setMsg(`Lưu thất bại: ${String(e)}`);
      return false;
    }
  };

  const run = async (dryRun: boolean) => {
    if (dirty && !(await save())) return;
    const only = onlySelected.size ? [...onlySelected].map((i) => rows[i]?.id).filter((x): x is string => !!x) : undefined;
    try {
      await api.runBatch({ template: tpl.dir, formats, only, force, dryRun, concurrency });
      setMsg(dryRun ? "Đang kiểm tra dữ liệu + tạo giọng đọc…" : "Đã bắt đầu render");
      onJob(await api.currentBatch());
    } catch (e) {
      setMsg(String(e));
    }
  };

  const doneCount = mine && job?.report ? job.report.jobs.filter((j) => ["Completed", "Skipped", "Failed", "Cancelled"].includes(j.status)).length : 0;
  const totalMatch = mine ? /Render (\d+) video/.exec(job?.log.join("\n") ?? "") : null;
  const total = totalMatch ? Number(totalMatch[1]) : 0;

  return (
    <>
      <div className="tpl-head">
        <div>
          <h2>{tpl.name}</h2>
          {tpl.description && <p className="muted">{tpl.description}</p>}
        </div>
      </div>

      <div className="tpl-toolbar">
        <span className="muted">Định dạng:</span>
        {Object.entries(tpl.formats ?? {}).map(([f, s]) => (
          <label key={f} className="toggle">
            <input
              type="checkbox"
              checked={formats.includes(f)}
              onChange={(e) => setFormats((cur) => (e.target.checked ? [...cur, f] : cur.filter((x) => x !== f)))}
            />
            {f} ({s.width}×{s.height})
          </label>
        ))}
        <label className="toggle" title="Render lại cả video không thay đổi">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Render lại tất cả
        </label>
        <label className="toggle">
          Luồng
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button disabled={running || formats.length === 0} onClick={() => void run(true)} title="Kiểm tra dữ liệu và tạo giọng đọc, không render">
          ✓ Kiểm tra
        </button>
        <button className="primary" disabled={running || formats.length === 0} onClick={() => void run(false)}>
          ▶ Render {onlySelected.size ? `${onlySelected.size} dòng đã chọn` : "tất cả"}
        </button>
        {running && mine && (
          <button className="danger" onClick={() => void api.cancelBatch().then(async () => onJob(await api.currentBatch()))}>
            ■ Hủy
          </button>
        )}
      </div>
      {msg && <div className="muted small pad-s">{msg}</div>}

      <div className="data-grid-wrap">
        <table className="data-grid">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && onlySelected.size === rows.length}
                  onChange={(e) => setOnlySelected(e.target.checked ? new Set(rows.map((_, i) => i)) : new Set())}
                  title="Chọn dòng để render riêng"
                />
              </th>
              {columns.map((c) => (
                <th key={c} title={tpl.params?.[c]?.description ?? ""}>
                  {c}
                  {tpl.params?.[c] && tpl.params[c]!.required !== false && tpl.params[c]!.default === undefined ? " *" : ""}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="checkbox"
                    checked={onlySelected.has(i)}
                    onChange={(e) =>
                      setOnlySelected((cur) => {
                        const n = new Set(cur);
                        if (e.target.checked) n.add(i);
                        else n.delete(i);
                        return n;
                      })
                    }
                  />
                </td>
                {columns.map((c) => {
                  const p = tpl.params?.[c];
                  return (
                    <td key={c}>
                      {p?.type === "asset" && registry ? (
                        <select value={row[c] ?? ""} onChange={(e) => setCell(i, c, e.target.value)}>
                          <option value="">{p.default !== undefined ? `(mặc định: ${String(p.default)})` : ""}</option>
                          {registry.assets
                            .filter((a) => !p.assetType || a.type === p.assetType)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({a.id})
                              </option>
                            ))}
                        </select>
                      ) : p?.enum ? (
                        <select value={row[c] ?? ""} onChange={(e) => setCell(i, c, e.target.value)}>
                          <option value="">{p.default !== undefined ? `(mặc định: ${String(p.default)})` : ""}</option>
                          {p.enum.map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={row[c] ?? ""}
                          placeholder={p?.default !== undefined ? String(p.default) : ""}
                          onChange={(e) => setCell(i, c, e.target.value)}
                          className={c === "id" ? "id-cell" : p?.type === "color" ? "color-cell" : ""}
                        />
                      )}
                    </td>
                  );
                })}
                <td>
                  <button
                    className="small-btn"
                    title="Xóa dòng"
                    onClick={() => {
                      setRows((r) => r.filter((_, idx) => idx !== i));
                      setDirty(true);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row pad-s">
        <button
          onClick={() => {
            setRows((r) => [...r, Object.fromEntries(columns.map((c) => [c, c === "id" ? `moi-${r.length + 1}` : ""]))]);
            setDirty(true);
          }}
        >
          ＋ Thêm dòng
        </button>
        <button className={dirty ? "primary" : ""} disabled={!dirty} onClick={() => void save()}>
          💾 Lưu data.csv
        </button>
        {dirty && <span className="badge">chưa lưu</span>}
      </div>

      {mine && job && (
        <div className="job-panel">
          <div className="row">
            <strong>
              {job.status === "running" ? "Đang chạy" : job.status === "completed" ? "Hoàn tất" : job.status === "cancelled" ? "Đã hủy" : "Kết thúc có lỗi"}
            </strong>
            <span className="muted small">bắt đầu {new Date(job.startedAt).toLocaleTimeString("vi-VN")}</span>
            {total > 0 && (
              <span className="muted small">
                {doneCount}/{total} video
              </span>
            )}
          </div>
          {total > 0 && (
            <div className="progress">
              <div style={{ width: `${Math.min(100, (doneCount / total) * 100)}%` }} />
            </div>
          )}
          <pre className="log" ref={logRef}>
            {job.log.join("\n")}
          </pre>
        </div>
      )}

      {report && (
        <div className="report">
          <div className="row">
            <h3>Kết quả gần nhất</h3>
            <span className="muted small">{new Date(report.finishedAt).toLocaleString("vi-VN")}</span>
            <span className="spacer" />
            <button onClick={openVideos}>🎞 Xem trong tab Video</button>
          </div>
          <table className="report-table">
            <thead>
              <tr>
                <th>Dòng</th>
                <th>Định dạng</th>
                <th>Trạng thái</th>
                <th>Thời lượng</th>
                <th>Render</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {report.jobs.map((j) => (
                <tr key={`${j.row}-${j.format}`} className={`r-${j.status}`}>
                  <td>{j.row}</td>
                  <td>{j.format}</td>
                  <td>{STATUS_LABEL[j.status] ?? j.status}</td>
                  <td>{j.duration !== undefined ? `${j.duration}s` : ""}</td>
                  <td>{j.elapsedSeconds ? `${j.elapsedSeconds}s` : ""}</td>
                  <td className="err small">{j.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
