import type { DialogueLine, SceneScript } from "../schemas/scene.schema";

export const SUBTITLE_FONT_FAMILY = "AC Subtitle";
const FONT_URL = "/assets/fonts/Nunito.ttf";

/** Câu thoại có phụ đề đang hiển thị tại t. */
export function activeSubtitle(scene: SceneScript, t: number): DialogueLine | undefined {
  return scene.dialogue.find((l) => l.subtitle && t >= l.start && t < l.start + l.duration);
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

function speakerLabel(scene: SceneScript, line: DialogueLine): string {
  if (!scene.subtitles.showSpeaker || !line.speaker) return "";
  const name = scene.characters.find((c) => c.id === line.speaker)?.name ?? line.speaker;
  return `${name}: `;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** Các dòng phụ đề của scene (đã sắp xếp, cắt ở cuối scene). */
export function subtitleCues(scene: SceneScript): SubtitleCue[] {
  return scene.dialogue
    .filter((l) => l.subtitle)
    .sort((a, b) => a.start - b.start)
    .map((l) => ({ start: l.start, end: Math.min(l.start + l.duration, scene.meta.duration), text: `${speakerLabel(scene, l)}${l.text}` }));
}

export function formatSrt(cues: readonly SubtitleCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

/** File phụ đề SubRip (.srt) từ lời thoại. */
export function buildSrt(scene: SceneScript): string {
  return formatSrt(subtitleCues(scene));
}

let fontPromise: Promise<void> | undefined;

/** Nạp font phụ đề (đóng gói sẵn → mọi máy render giống nhau). */
export function loadSubtitleFont(): Promise<void> {
  fontPromise ??= (async () => {
    const face = new FontFace(SUBTITLE_FONT_FAMILY, `url(${FONT_URL})`, { weight: "100 1000" });
    await face.load();
    document.fonts.add(face);
  })();
  return fontPromise;
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Vẽ phụ đề lên canvas 2D. Dùng chung cho preview (lớp phủ) và render (ghép vào frame).
 */
export function drawSubtitle(ctx: CanvasRenderingContext2D, scene: SceneScript, t: number, width: number, height: number): void {
  const line = activeSubtitle(scene, t);
  if (!line) return;
  const style = scene.subtitles;
  const fontSize = Math.round(height * style.size);
  ctx.save();
  ctx.font = `800 ${fontSize}px "${SUBTITLE_FONT_FAMILY}", "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapText(ctx, speakerLabel(scene, line) + line.text, width * 0.86);
  const lineHeight = fontSize * 1.25;
  const blockHeight = lines.length * lineHeight;
  const margin = height * 0.06;
  const top = style.position === "top" ? margin : height - margin - blockHeight;

  const padX = fontSize * 0.6;
  const padY = fontSize * 0.25;
  const boxWidth = Math.min(width * 0.94, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.roundRect((width - boxWidth) / 2, top - padY, boxWidth, blockHeight + padY * 2, fontSize * 0.4);
  ctx.fill();

  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, fontSize * 0.14);
  ctx.strokeStyle = "rgba(20, 20, 30, 0.9)";
  ctx.fillStyle = "#ffffff";
  lines.forEach((l, i) => {
    const y = top + lineHeight * (i + 0.5);
    ctx.strokeText(l, width / 2, y);
    ctx.fillText(l, width / 2, y);
  });
  ctx.restore();
}
