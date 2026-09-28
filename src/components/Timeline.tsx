import { useRef, type PointerEvent } from "react";
import { isMotionAction, isPropAction, type Action, type AudioKind, type SceneScript } from "../schemas/scene.schema";
import { computeAudioSegments, type AudioSegment } from "../engine/AudioTimeline";
import type { Registry } from "../schemas/asset.schema";
import { useEditor } from "../store/editorStore";

interface Track {
  key: string;
  label: string;
  actions: Action[];
  kind: "anim" | "motion" | "jump" | "camera" | "prop";
}

function tracksOf(scene: SceneScript): Track[] {
  const tracks: Track[] = [];
  for (const c of scene.characters) {
    const mine = scene.actions.filter((a) => a.type !== "camera" && !isPropAction(a) && a.target === c.id);
    tracks.push({ key: `${c.id}-anim`, label: `${c.id} · animation`, kind: "anim", actions: mine.filter((a) => a.type === "animation") });
    tracks.push({ key: `${c.id}-motion`, label: `${c.id} · di chuyển`, kind: "motion", actions: mine.filter(isMotionAction) });
    const jumps = mine.filter((a) => a.type === "jump");
    if (jumps.length) tracks.push({ key: `${c.id}-jump`, label: `${c.id} · nhảy`, kind: "jump", actions: jumps });
  }
  for (const p of scene.props) {
    const events = scene.actions.filter((a) => isPropAction(a) && a.target === p.id);
    if (events.length) tracks.push({ key: `prop-${p.id}`, label: `${p.id} · đồ vật`, kind: "prop", actions: events });
  }
  tracks.push({ key: "camera", label: "camera", kind: "camera", actions: scene.actions.filter((a) => a.type === "camera") });
  return tracks;
}

const AUDIO_LABEL: Record<AudioKind, string> = { music: "nhạc nền", sfx: "hiệu ứng", voice: "lời thoại" };

function segmentLabel(scene: SceneScript, seg: AudioSegment): string {
  if (!seg.id.startsWith("dlg:")) return seg.id;
  const line = scene.dialogue.find((l) => `dlg:${l.id}` === seg.id);
  return line ? `${line.speaker ? `${line.speaker}: ` : ""}${line.text}` : seg.id;
}

function audioTracksOf(scene: SceneScript, registry: Registry | undefined): { kind: AudioKind; segments: AudioSegment[] }[] {
  if (!registry) return [];
  const segments = computeAudioSegments(scene, registry);
  return (["music", "voice", "sfx"] as const)
    .map((kind) => ({ kind, segments: segments.filter((s) => s.kind === kind) }))
    .filter((t) => t.segments.length > 0);
}

function labelOf(a: Action): string {
  switch (a.type) {
    case "animation":
      return a.clip;
    case "move":
      return `${a.direction} ${a.speed}m/s`;
    case "moveTo":
      return `→ (${a.to.x}, ${a.to.z})`;
    case "path":
      return `path ${a.points.length} điểm`;
    case "turn":
      return a.by !== undefined ? `quay ${a.by}°` : `hướng ${a.heading}°`;
    case "jump":
      return `nhảy ${a.height}m`;
    case "camera":
      return a.shot.mode === "follow" ? `follow ${a.shot.target}` : "fixed";
    case "attach":
      return `→ ${a.to}`;
    case "drop":
      return "đặt xuống";
    case "show":
      return "hiện";
    case "hide":
      return "ẩn";
  }
}

export function Timeline() {
  const scene = useEditor((s) => s.scene);
  const time = useEditor((s) => s.time);
  const seek = useEditor((s) => s.seek);
  const registry = useEditor((s) => s.registry);
  const areaRef = useRef<HTMLDivElement>(null);

  if (!scene) return <div className="timeline empty">Chưa có scene hợp lệ</div>;
  const duration = scene.meta.duration;
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const seekFromEvent = (e: PointerEvent) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    seek(((e.clientX - rect.left) / rect.width) * duration);
  };

  const ticks: number[] = [];
  const step = duration > 30 ? 5 : 1;
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(t);

  const audioTracks = audioTracksOf(scene, registry);
  const defaultCamera = scene.camera.mode === "follow" ? `mặc định: follow ${scene.camera.target}` : "mặc định: fixed";

  return (
    <div className="timeline">
      <div className="tl-labels">
        <div className="tl-label tl-ruler-label">thời gian (s)</div>
        {tracksOf(scene).map((tr) => (
          <div key={tr.key} className="tl-label">
            {tr.label}
          </div>
        ))}
        {audioTracks.map((tr) => (
          <div key={`audio-${tr.kind}`} className="tl-label">
            ♪ {AUDIO_LABEL[tr.kind]}
          </div>
        ))}
      </div>
      <div
        className="tl-area"
        ref={areaRef}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          useEditor.getState().pause();
          seekFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e);
        }}
      >
        <div className="tl-ruler">
          {ticks.map((t) => (
            <span key={t} className="tl-tick" style={{ left: pct(t) }}>
              {t}
            </span>
          ))}
        </div>
        {tracksOf(scene).map((tr) => (
          <div key={tr.key} className={`tl-track tl-${tr.kind}`}>
            {tr.kind === "camera" && <div className="tl-default">{defaultCamera}</div>}
            {tr.actions.map((a) => (
              <div
                key={a.id}
                className="tl-block"
                style={{ left: pct(a.start), width: pct(a.duration) }}
                title={JSON.stringify(a, null, 2)}
              >
                {labelOf(a)}
              </div>
            ))}
          </div>
        ))}
        {audioTracks.map((tr) => (
          <div key={`audio-${tr.kind}`} className="tl-track tl-audio">
            {tr.segments.map((seg) => (
              <div
                key={seg.id}
                className="tl-block"
                style={{ left: pct(seg.start), width: pct(seg.end - seg.start) }}
                title={`${seg.id}: ${seg.file}
${seg.start}s → ${seg.end.toFixed(2)}s · volume ${seg.volume}${seg.loop ? " · loop" : ""}`}
              >
                {segmentLabel(scene, seg)}
              </div>
            ))}
          </div>
        ))}
        <div className="tl-playhead" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}
