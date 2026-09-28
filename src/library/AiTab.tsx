import { useCallback, useEffect, useRef, useState } from "react";
import { castable, characterStyle, GESTURES, LANGUAGES, normalizeStory, STORY_TRANSITIONS, VOICE_ROLES, type Format, type Lang, type RequestedCharacter, type Story, type StoryLine } from "../ai/story";
import type { AssetEntry } from "../schemas/asset.schema";
import { AssetThumb } from "./AssetThumb";
import { EMOTIONS } from "../schemas/scene.schema";
import { useEditor } from "../store/editorStore";

/**
 * AI kịch bản: prompt → DeepSeek sinh kịch bản nhiều ngôn ngữ → người dùng xem/sửa/góp ý
 * → XÁC NHẬN DUYỆT → mới tạo project, giọng đọc, kiểm tra và render (mỗi ngôn ngữ một video).
 */

interface Draft {
  id: string;
  prompt: string;
  updatedAt: string;
  model?: string;
  tokens?: number;
  story: Story;
  revisions: string[];
  approved?: { at: string; projects: string[] };
  cast?: RequestedCharacter[];
}
interface DraftSummary {
  id: string;
  prompt: string;
  title: string;
  languages: Lang[];
  updatedAt: string;
  approved?: { at: string };
}
interface Status {
  configured: boolean;
  model: string;
  languages: Lang[];
}
interface JobItem {
  lang: Lang;
  project: string;
  status: "pending" | "preparing" | "rendering" | "completed" | "failed" | "cancelled";
  progress: number;
  duration?: number;
  scenes?: number;
  output?: string;
  error?: string;
}
interface AiJob {
  id: string;
  draftId: string;
  title: string;
  format: Format;
  status: "running" | "completed" | "failed" | "cancelled";
  items: JobItem[];
  log: string[];
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const d = data as { error?: string; issues?: { path: string; message: string }[] } | undefined;
    throw new Error([d?.error ?? String(res.status), ...(d?.issues ?? []).slice(0, 5).map((i) => `${i.path}: ${i.message}`)].join("\n"));
  }
  return data as T;
}

const EMOTION_LABEL: Record<(typeof EMOTIONS)[number], string> = {
  neutral: "–",
  happy: "😊 vui",
  sad: "😢 buồn",
  surprised: "😮 ngạc nhiên",
  angry: "😠 giận",
  scared: "😨 sợ",
};

const TRANSITION_LABEL: Record<(typeof STORY_TRANSITIONS)[number], string> = {
  fade: "Tối dần (fade)",
  dissolve: "Hòa cảnh (dissolve)",
  cut: "Cắt thẳng (cut)",
};

/** Bản nháp cũ (một bối cảnh) → dạng nhiều cảnh. */
function withScenes(d: Draft): Draft {
  return { ...d, story: normalizeStory(d.story) as Story };
}

const ITEM_LABEL: Record<JobItem["status"], string> = {
  pending: "Chờ",
  preparing: "Tạo giọng đọc & kiểm tra…",
  rendering: "Đang render",
  completed: "✓ Xong",
  failed: "✗ Lỗi",
  cancelled: "■ Đã hủy",
};

export function AiTab({ openProject, openVideos }: { openProject: (id: string) => void; openVideos: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [job, setJob] = useState<AiJob | null>(null);
  const [error, setError] = useState<string>();

  const loadDrafts = useCallback(() => {
    call<DraftSummary[]>("/api/ai/drafts").then(setDrafts, () => undefined);
  }, []);
  useEffect(() => {
    call<Status>("/api/ai/status").then(setStatus, (e: unknown) => setError(String(e)));
    loadDrafts();
  }, [loadDrafts]);

  // Theo dõi job dựng video.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await call<AiJob | null>("/api/ai/job");
        if (stop) return;
        setJob(j);
        timer = setTimeout(() => void poll(), j?.status === "running" ? 1500 : 6000);
      } catch {
        timer = setTimeout(() => void poll(), 6000);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const openDraft = async (id: string) => {
    setError(undefined);
    try {
      setDraft(withScenes(await call<Draft>(`/api/ai/drafts/${id}`)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="lib-tab batch-tab ai-tab">
      <aside className="tpl-list">
        <button className={!draft ? "active" : ""} onClick={() => setDraft(undefined)}>
          ＋ Kịch bản mới
        </button>
        <h3>Bản nháp gần đây</h3>
        {drafts.map((d) => (
          <button key={d.id} className={draft?.id === d.id ? "active" : ""} onClick={() => void openDraft(d.id)}>
            <div>{d.title}</div>
            <div className="muted small">
              {d.languages.join(" · ")} · {d.approved ? "✓ đã duyệt" : "chờ duyệt"}
            </div>
          </button>
        ))}
        {drafts.length === 0 && <p className="muted small">Chưa có bản nháp</p>}
      </aside>
      <section className="tpl-main">
        {error && <div className="lib-error">{error}</div>}
        {status && !status.configured && <div className="lib-error">Chưa cấu hình DEEPSEEK_API_KEY trong file .env ở thư mục dự án.</div>}
        {!draft && status && (
          <PromptForm
            status={status}
            onDraft={(d) => {
              setDraft(withScenes(d));
              loadDrafts();
            }}
          />
        )}
        {draft && status && (
          <Review
            key={`${draft.id}-${draft.updatedAt}`}
            draft={draft}
            status={status}
            job={job}
            onDraft={(d) => {
              setDraft(withScenes(d));
              loadDrafts();
            }}
            onJob={setJob}
          />
        )}
        {job && (!draft || job.draftId === draft.id) && <JobPanel job={job} onJob={setJob} openProject={openProject} openVideos={openVideos} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- bước 1: prompt

function LangPicker({ available, value, onChange, disabled }: { available: Lang[]; value: Lang[]; onChange: (v: Lang[]) => void; disabled?: Lang[] }) {
  return (
    <div className="ai-langs">
      {available.map((l) => (
        <label key={l} className="toggle">
          <input
            type="checkbox"
            checked={value.includes(l)}
            disabled={disabled?.includes(l)}
            onChange={(e) => onChange(e.target.checked ? [...value, l] : value.filter((x) => x !== l))}
          />
          {LANGUAGES[l].label}
        </label>
      ))}
    </div>
  );
}

function PromptForm({ status, onDraft }: { status: Status; onDraft: (d: Draft) => void }) {
  const [prompt, setPrompt] = useState("");
  const [languages, setLanguages] = useState<Lang[]>(["vi"]);
  const [seconds, setSeconds] = useState(45);
  /** 0 = AI tự chọn số cảnh. */
  const [scenes, setScenes] = useState(0);
  /** Rỗng = AI tự chọn nhân vật. */
  const [cast, setCast] = useState<RequestedCharacter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDraft(await call<Draft>("/api/ai/story", "POST", { prompt, languages, seconds, scenes: scenes || undefined, cast: cast.length ? cast : undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-form">
      <div className="tpl-head">
        <h2>✨ Sinh kịch bản bằng AI</h2>
        <p className="muted">
          Nhập ý tưởng, AI ({status.model}) viết kịch bản từ nhân vật và bối cảnh có trong thư viện. Bạn xem, sửa và <b>duyệt</b> trước khi dựng video.
        </p>
      </div>
      <textarea
        className="ai-prompt"
        rows={5}
        placeholder="Ví dụ: Cáo con rời nông trại, băng qua rừng thu rồi tới đồng hoa tìm quà cho mẹ; dọc đường học cách giúp đỡ bạn bè."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <CastPicker value={cast} onChange={setCast} />
      <div className="tpl-toolbar">
        <span className="muted">Ngôn ngữ kịch bản:</span>
        <LangPicker available={status.languages} value={languages} onChange={setLanguages} />
      </div>
      <div className="tpl-toolbar">
        <span className="muted">Độ dài:</span>
        <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
          {[30, 45, 60, 90, 120].map((s) => (
            <option key={s} value={s}>
              ~{s} giây
            </option>
          ))}
        </select>
        <span className="muted">Khung cảnh:</span>
        <select value={scenes} onChange={(e) => setScenes(Number(e.target.value))}>
          <option value={0}>AI tự chọn</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 cảnh (một bối cảnh)" : `${n} cảnh`}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="primary" disabled={busy || !status.configured || prompt.trim().length < 5 || !languages.length} onClick={() => void submit()}>
          {busy ? `Đang viết kịch bản… ${elapsed}s` : "✨ Sinh kịch bản"}
        </button>
      </div>
      {error && <div className="lib-error pre">{error}</div>}
    </div>
  );
}

/** Chọn nhân vật cho kịch bản (tùy chọn). Chọn cùng một model hai lần = hai nhân vật (vd. cáo mẹ và cáo con). */
function CastPicker({ value, onChange }: { value: RequestedCharacter[]; onChange: (v: RequestedCharacter[]) => void }) {
  const registry = useEditor((s) => s.registry);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [style, setStyle] = useState<"all" | "cube" | "lowpoly">("all");
  const all: AssetEntry[] = registry ? castable(registry) : [];
  const byId = new Map(all.map((a) => [a.id, a]));
  const q = query.trim().toLowerCase();
  const shown = all.filter((a) => (style === "all" || characterStyle(a) === style) && (!q || `${a.name} ${a.id} ${a.tags.join(" ")}`.toLowerCase().includes(q)));
  const mixed = new Set(value.map((v) => characterStyle(byId.get(v.asset)))).size > 1;
  const count = (id: string) => value.filter((v) => v.asset === id).length;

  return (
    <div className="ai-cast-picker">
      <div className="tpl-toolbar">
        <span className="muted">Nhân vật:</span>
        {value.length === 0 && <span className="muted small">AI tự chọn theo câu chuyện</span>}
        {value.map((c, i) => (
          <span key={i} className="badge ai-cast-chip">
            {byId.get(c.asset)?.name ?? c.asset}
            <input
              placeholder="tên / vai (tùy chọn)"
              value={c.name ?? ""}
              maxLength={60}
              onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, name: e.target.value || undefined } : x)))}
            />
            <button className="small-btn" title="Bỏ" onClick={() => onChange(value.filter((_, k) => k !== i))}>
              ✕
            </button>
          </span>
        ))}
        <button onClick={() => setOpen(!open)}>{open ? "Đóng danh sách" : "＋ Chọn nhân vật"}</button>
        {value.length > 0 && <button onClick={() => onChange([])}>Để AI tự chọn</button>}
      </div>
      {mixed && <div className="muted small">⚠ Đang trộn nhân vật Kenney (khối vuông) với Quaternius (low-poly) – vẫn dựng được nhưng có thể trông lệch nhau.</div>}
      {open && (
        <div className="ai-cast-browser">
          <div className="tpl-toolbar">
            <input placeholder="Tìm: cáo, fox, robot, cô bé…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
              <option value="all">Mọi phong cách</option>
              <option value="cube">Khối vuông (Kenney)</option>
              <option value="lowpoly">Low-poly (Quaternius)</option>
            </select>
            <span className="muted small">
              {shown.length} nhân vật · đã chọn {value.length}/6
            </span>
          </div>
          <div className="asset-grid ai-cast-grid">
            {shown.map((a) => (
              <button
                key={a.id}
                className={`asset-card ${count(a.id) ? "active" : ""}`}
                disabled={value.length >= 6}
                title="Bấm để thêm (bấm lần nữa = thêm một nhân vật cùng model)"
                onClick={() => onChange([...value, { asset: a.id }])}
              >
                <AssetThumb asset={a} />
                <div className="title">
                  {a.name}
                  {count(a.id) ? ` ×${count(a.id)}` : ""}
                </div>
                <div className="muted small">
                  {a.height ? `${a.height} m · ` : ""}
                  {characterStyle(a) === "cube" ? "khối vuông" : "low-poly"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- bước 2: xem, sửa, duyệt

function Review({ draft, status, job, onDraft, onJob }: { draft: Draft; status: Status; job: AiJob | null; onDraft: (d: Draft) => void; onJob: (j: AiJob) => void }) {
  const registry = useEditor((s) => s.registry);
  const [story, setStory] = useState<Story>(draft.story);
  const [dirty, setDirty] = useState(false);
  const [lang, setLang] = useState<Lang>(draft.story.languages[0]!);
  const [feedback, setFeedback] = useState("");
  const [extraLangs, setExtraLangs] = useState<Lang[]>(draft.story.languages);
  const [renderLangs, setRenderLangs] = useState<Lang[]>([draft.story.languages[0]!]);
  const [format, setFormat] = useState<Format>("16x9");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();

  const running = job?.status === "running";
  const assetName = (id: string) => registry?.assets.find((a) => a.id === id)?.name ?? id;
  const environments = registry?.assets.filter((a) => a.type === "environment") ?? [];
  const castOptions = registry ? castable(registry) : [];
  const hasActions = story.scenes.some((sc) => sc.lines.some((l) => l.action));
  const objName = (id: string) => story.objects.find((o) => o.id === id)?.name[lang] ?? id;
  const actionLabel = (line: StoryLine) => {
    const a = line.action;
    if (!a) return "";
    const who = a.by ? `${charName(a.by)}: ` : "";
    if (a.type === "pickup") return `${who}🤲 nhặt ${objName(a.object)}`;
    if (a.type === "give") return `${who}🎁 trao ${objName(a.object)} → ${charName(a.to)}`;
    return `${who}⬇ đặt ${objName(a.object)} xuống`;
  };
  const charName = (id: string | null) => (id ? (story.characters.find((c) => c.id === id)?.name[lang] ?? id) : "🎙 Người dẫn chuyện");

  const edit = (fn: (s: Story) => Story) => {
    setStory((s) => fn(structuredClone(s)));
    setDirty(true);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setMsg(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const save = () =>
    run("save", async () => {
      onDraft(await call<Draft>(`/api/ai/drafts/${draft.id}`, "PUT", { story }));
      setDirty(false);
      setMsg("Đã lưu chỉnh sửa");
    });

  const revise = () =>
    run("revise", async () => {
      const d = await call<Draft>("/api/ai/revise", "POST", { draftId: draft.id, story, instruction: feedback, languages: extraLangs });
      setFeedback("");
      onDraft(d);
    });

  const approve = () => {
    const names = renderLangs.map((l) => LANGUAGES[l].label).join(", ");
    if (!window.confirm(`Duyệt kịch bản "${story.title[lang]}" và dựng ${renderLangs.length} video (${names}, khung ${format})?\n\nSau khi duyệt hệ thống sẽ tạo project, sinh giọng đọc và render.`)) return;
    void run("approve", async () => {
      if (dirty) {
        await call<Draft>(`/api/ai/drafts/${draft.id}`, "PUT", { story });
        setDirty(false);
      }
      await call<{ id: string }>("/api/ai/approve", "POST", { draftId: draft.id, story, languages: renderLangs, format });
      onJob(await call<AiJob>("/api/ai/job"));
    });
  };

  return (
    <div className="ai-review">
      <div className="tpl-head">
        <h2>{story.title[lang]}</h2>
        <p className="muted">{story.summary[lang]}</p>
        <p className="muted small">
          Prompt: “{draft.prompt}” · {draft.model} · {draft.tokens ?? 0} token{draft.revisions.length ? ` · đã sửa ${draft.revisions.length} lần` : ""}
          {draft.approved && ` · ✓ duyệt lúc ${new Date(draft.approved.at).toLocaleString()}`}
        </p>
      </div>

      <div className="ai-lang-tabs">
        {story.languages.map((l) => (
          <button key={l} className={l === lang ? "active" : ""} onClick={() => setLang(l)}>
            {LANGUAGES[l].label}
          </button>
        ))}
      </div>

      <div className="ai-cast">
        <div>
          <span className="muted">
            {story.scenes.length} khung cảnh · Kết: {story.ending} · Nhạc nền: {story.music ? "có" : "không"}
          </span>
        </div>
        {story.characters.map((c, ci) => (
          <span key={c.id} className="badge ai-char">
            <b>{c.name[lang]}</b>
            <select
              title="Đổi nhân vật (model)"
              value={c.asset}
              onChange={(e) =>
                edit((s) => {
                  s.characters[ci]!.asset = e.target.value;
                  return s;
                })
              }
            >
              {castOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              {!castOptions.some((a) => a.id === c.asset) && <option value={c.asset}>{assetName(c.asset)}</option>}
            </select>
            <select
              title="Giọng"
              value={c.voice}
              onChange={(e) =>
                edit((s) => {
                  s.characters[ci]!.voice = e.target.value as Story["characters"][number]["voice"];
                  return s;
                })
              }
            >
              {VOICE_ROLES.map((v) => (
                <option key={v} value={v}>
                  giọng {v}
                </option>
              ))}
            </select>
          </span>
        ))}
        {draft.cast && <span className="muted small">Nhân vật do bạn chọn</span>}
        {story.objects.map((o) => (
          <span key={o.id} className="badge">
            🧺 {o.name[lang]} · {o.heldBy ? `${charName(o.heldBy)} cầm sẵn` : `nằm ở cảnh ${story.scenes.findIndex((x) => x.id === o.scene) + 1}`}
          </span>
        ))}
      </div>

      {story.scenes.map((sc, si) => {
        const offset = story.scenes.slice(0, si).reduce((n, x) => n + x.lines.length, 0);
        return (
          <div key={sc.id} className="ai-scene">
            <div className="tpl-toolbar">
              <b>
                Cảnh {si + 1}
                {story.scenes.length > 1 ? `/${story.scenes.length}` : ""}
              </b>
              <span className="muted">Bối cảnh:</span>
              <select
                value={sc.environment}
                onChange={(e) =>
                  edit((s) => {
                    s.scenes[si]!.environment = e.target.value;
                    return s;
                  })
                }
              >
                {environments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {!environments.some((a) => a.id === sc.environment) && <option value={sc.environment}>{sc.environment}</option>}
              </select>
              {si > 0 && (
                <>
                  <span className="muted">Chuyển vào:</span>
                  <select
                    value={sc.transition}
                    onChange={(e) =>
                      edit((s) => {
                        s.scenes[si]!.transition = e.target.value as (typeof STORY_TRANSITIONS)[number];
                        return s;
                      })
                    }
                  >
                    {STORY_TRANSITIONS.map((t) => (
                      <option key={t} value={t}>
                        {TRANSITION_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span className="muted small">Có mặt: {sc.cast.map((id) => charName(id)).join(", ")}</span>
            </div>
            <div className="data-grid-wrap ai-lines">
              <table className="data-grid">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Người nói</th>
                    <th>Cử chỉ</th>
                    <th>Cảm xúc</th>
                    {hasActions && <th>Hành động</th>}
                    <th>Lời thoại ({LANGUAGES[lang].label})</th>
                  </tr>
                </thead>
                <tbody>
                  {sc.lines.map((line, i) => (
                    <tr key={line.id}>
                      <td className="muted small">{offset + i + 1}</td>
                      <td className="nowrap">{charName(line.speaker)}</td>
                      <td>
                        <select
                          value={line.gesture ?? ""}
                          disabled={!line.speaker}
                          onChange={(e) =>
                            edit((s) => {
                              s.scenes[si]!.lines[i]!.gesture = (e.target.value || null) as StoryLine["gesture"];
                              return s;
                            })
                          }
                        >
                          <option value="">–</option>
                          {GESTURES.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={line.emotion}
                          onChange={(e) =>
                            edit((s) => {
                              s.scenes[si]!.lines[i]!.emotion = e.target.value as StoryLine["emotion"];
                              return s;
                            })
                          }
                        >
                          {EMOTIONS.map((em) => (
                            <option key={em} value={em}>
                              {EMOTION_LABEL[em]}
                            </option>
                          ))}
                        </select>
                      </td>
                      {hasActions && <td className="small">{actionLabel(line)}</td>}
                      <td className="ai-text">
                        <textarea
                          rows={2}
                          value={line.text[lang] ?? ""}
                          onChange={(e) =>
                            edit((s) => {
                              s.scenes[si]!.lines[i]!.text[lang] = e.target.value;
                              return s;
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="tpl-toolbar">
        <button disabled={!dirty || !!busy} onClick={() => void save()}>
          💾 Lưu chỉnh sửa
        </button>
        {msg && <span className="muted small">{msg}</span>}
        {dirty && <span className="muted small">Có thay đổi chưa lưu</span>}
      </div>

      <div className="job-panel">
        <b>Góp ý cho AI sửa kịch bản</b>
        <textarea
          className="ai-prompt"
          rows={2}
          placeholder="Ví dụ: thêm một cảnh ở sa mạc, thêm một chú gấu, câu kết vui hơn, gộp thành một cảnh…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <div className="tpl-toolbar">
          <span className="muted">Ngôn ngữ:</span>
          <LangPicker available={status.languages} value={extraLangs} onChange={setExtraLangs} />
          <span className="spacer" />
          <button disabled={!!busy || running || (!feedback.trim() && extraLangs.join() === story.languages.join()) || !extraLangs.length} onClick={() => void revise()}>
            {busy === "revise" ? "AI đang sửa…" : "↻ Sửa theo góp ý"}
          </button>
        </div>
      </div>

      <div className="job-panel ai-approve">
        <b>Duyệt & dựng video</b>
        <div className="tpl-toolbar">
          <span className="muted">Dựng bản:</span>
          <LangPicker available={story.languages} value={renderLangs} onChange={setRenderLangs} />
          <span className="muted">Khung hình:</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="16x9">16:9 (YouTube)</option>
            <option value="9x16">9:16 (Shorts/TikTok)</option>
          </select>
          <span className="spacer" />
          <button className="primary" disabled={!!busy || running || !renderLangs.length} onClick={approve}>
            {busy === "approve" ? "Đang gửi…" : running ? "Đang dựng video khác…" : `✓ Duyệt & dựng ${renderLangs.length} video`}
          </button>
        </div>
      </div>
      {error && <div className="lib-error pre">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- bước 3: tiến độ

function JobPanel({ job, onJob, openProject, openVideos }: { job: AiJob; onJob: (j: AiJob) => void; openProject: (id: string) => void; openVideos: () => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.log.length]);
  const cancel = async () => {
    await call("/api/ai/job/cancel", "POST", {});
    onJob(await call<AiJob>("/api/ai/job"));
  };
  return (
    <div className="job-panel">
      <div className="row">
        <b>
          Dựng video: {job.title} ({job.format})
        </b>
        <span className="spacer" />
        {job.status === "running" ? (
          <button className="danger" onClick={() => void cancel()}>
            Hủy
          </button>
        ) : (
          <span className="badge">{job.status}</span>
        )}
      </div>
      {job.items.map((it) => (
        <div key={it.project} className="ai-job-item">
          <div className="row">
            <span>
              <b>{LANGUAGES[it.lang].label}</b> <span className="muted small">projects/{it.project}</span>
            </span>
            <span className="spacer" />
            <span className="small">
              {ITEM_LABEL[it.status]}
              {it.status === "rendering" ? ` ${it.progress}%` : ""}
              {it.scenes ? ` · ${it.scenes} cảnh` : ""}
              {it.duration ? ` · ${it.duration}s` : ""}
            </span>
          </div>
          {(it.status === "rendering" || it.status === "completed") && (
            <div className="progress">
              <div style={{ width: `${it.progress}%` }} />
            </div>
          )}
          {it.error && <div className="err small pre">{it.error}</div>}
          {it.status === "completed" && it.output && <video className="ai-video" src={`/media/${it.output}`} controls preload="metadata" />}
          {(it.status === "completed" || it.status === "failed" || it.status === "rendering") && (
            <div className="row">
              {!it.scenes && (
                <button className="small-btn" onClick={() => openProject(it.project)}>
                  ✎ Mở trong Editor
                </button>
              )}
              {it.status === "completed" && (
                <button className="small-btn" onClick={openVideos}>
                  🎞 Tab Video
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <pre className="log" ref={logRef}>
        {job.log.join("\n")}
      </pre>
    </div>
  );
}
