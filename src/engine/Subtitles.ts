import type { DialogueLine, SceneScript, TitleCard } from "../schemas/scene.schema";

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

/** Thời điểm bắt đầu của thẻ chữ trong scene. */
export function titleStart(scene: SceneScript, card: TitleCard): number {
  return card.at === "end" ? Math.max(0, scene.meta.duration - card.duration) : card.start;
}

/** Có vẽ lớp chữ nào không (phụ đề chèn vào hình hoặc thẻ tên phim / danh sách cuối). */
export function hasOverlay(scene: SceneScript): boolean {
  return (scene.subtitles.burnIn && scene.dialogue.some((l) => l.subtitle)) || scene.titles.length > 0;
}

/**
 * Vẽ thẻ tên phim / danh sách cuối phim (hiện dần 0.6 s, tắt dần 0.6 s). Tên phim: chữ lớn giữa khung, dải tối mờ phía
 * sau; danh sách: nền tối dần rồi các dòng chữ căn giữa.
 */
export function drawTitles(ctx: CanvasRenderingContext2D, scene: SceneScript, t: number, width: number, height: number): void {
  for (const card of scene.titles) {
    const t0 = titleStart(scene, card);
    const local = t - t0;
    if (local < 0 || local > card.duration) continue;
    const fade = card.kind === "credits" && card.at === "end" ? Math.min(1, local / 0.8) : Math.min(1, local / 0.6, (card.duration - local) / 0.6);
    const a = Math.max(0, Math.min(1, fade));
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const unit = Math.min(width, height * 16 / 9) / 1280;
    if (card.kind === "title") {
      const size = Math.round(78 * unit);
      const sub = Math.round(34 * unit);
      const y = height * 0.42;
      const band = ctx.createLinearGradient(0, y - size * 1.6, 0, y + size * 1.9);
      band.addColorStop(0, "rgba(0,0,0,0)");
      band.addColorStop(0.5, `rgba(10,12,30,${0.45 * a})`);
      band.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = band;
      ctx.fillRect(0, y - size * 1.6, width, size * 3.5);
      ctx.font = `900 ${size}px "${SUBTITLE_FONT_FAMILY}", "Segoe UI", sans-serif`;
      ctx.globalAlpha = a;
      const rise = (1 - a) * size * 0.3;
      const lines = wrapText(ctx, card.text, width * 0.86);
      lines.forEach((l, i) => {
        const ly = y - ((lines.length - 1) / 2 - i) * size * 1.1 + rise;
        ctx.lineWidth = Math.max(3, size * 0.12);
        ctx.strokeStyle = "rgba(20,20,40,0.9)";
        ctx.strokeText(l, width / 2, ly);
        ctx.fillStyle = "#fff6d8";
        ctx.fillText(l, width / 2, ly);
      });
      if (card.lines.length) {
        ctx.font = `700 ${sub}px "${SUBTITLE_FONT_FAMILY}", "Segoe UI", sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = Math.max(2, sub * 0.14);
        card.lines.forEach((l, i) => {
          const ly = y + size * (0.55 + (lines.length - 1) * 0.55) + sub * (1.2 + i * 1.3) + rise;
          ctx.strokeText(l, width / 2, ly);
          ctx.fillText(l, width / 2, ly);
        });
      }
    } else {
      ctx.fillStyle = `rgba(8,10,24,${0.62 * a})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = a;
      const head = Math.round(54 * unit);
      const body = Math.round(30 * unit);
      const total = head * 1.6 + card.lines.length * body * 1.45;
      let y = height / 2 - total / 2 + head / 2;
      ctx.font = `900 ${head}px "${SUBTITLE_FONT_FAMILY}", "Segoe UI", sans-serif`;
      ctx.fillStyle = "#fff6d8";
      ctx.fillText(card.text, width / 2, y);
      y += head * 1.1 + body;
      ctx.font = `700 ${body}px "${SUBTITLE_FONT_FAMILY}", "Segoe UI", sans-serif`;
      for (const l of card.lines) {
        ctx.fillStyle = l.endsWith(":") ? "#9fd3ff" : "#ffffff";
        ctx.fillText(l, width / 2, y);
        y += body * 1.45;
      }
    }
    ctx.restore();
  }
}
