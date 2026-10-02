import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panGains, type AudioSegment, type Ducking } from "../src/engine/AudioTimeline";

export const FRAME_PATTERN = "frame_%06d.png";
const AUDIO_RATE = 48000;
const TRUE_PEAK = -1.5;
const LRA = 11;

export function frameFileName(index: number): string {
  // Frame đánh số từ 1, zero-padding 6 chữ số.
  return `frame_${String(index + 1).padStart(6, "0")}.png`;
}

/** Kết quả đo pass 1 của loudnorm. */
export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface EncodeAudio {
  segments: readonly AudioSegment[];
  /** Thời lượng video (giây) – audio được pad/cắt đúng bằng. */
  duration: number;
  /** Thư mục gốc chứa asset (tương ứng /assets/). */
  assetsDir: string;
  ducking?: Ducking;
  /** LUFS mục tiêu; undefined = không chuẩn hóa (dùng limiter). */
  loudness?: number;
  /** Có số đo pass 1 → pass 2 chuẩn hóa tuyến tính chính xác. */
  measured?: LoudnessMeasure;
}

export interface EncodeOptions {
  framesDir: string;
  fps: number;
  output: string;
  crf?: number;
  preset?: string;
  audio?: EncodeAudio;
  /** File .srt → track phụ đề mềm (mov_text) trong MP4. */
  subtitlesFile?: string;
}

const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** Biểu thức volume của FFmpeg cho ducking – cùng công thức với duckGainAt(). */
export function duckExpression(d: Ducking): string {
  const r = num(d.ramp);
  const terms = d.intervals.map((iv) => `clip(min((t-${num(iv.start - d.ramp)})/${r},(${num(iv.end + d.ramp)}-t)/${r}),0,1)`);
  const w = terms.reduce((acc, term) => (acc ? `max(${acc},${term})` : term), "");
  return `1-${num(1 - d.level)}*${w}`;
}

function loudnormFilter(target: number, measured?: LoudnessMeasure): string {
  const base = `loudnorm=I=${num(target)}:TP=${TRUE_PEAK}:LRA=${LRA}`;
  if (!measured) return `${base}:print_format=json`;
  return (
    `${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
    `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
  );
}

/**
 * filter_complex trộn audio. Mỗi đoạn: cắt → chuẩn định dạng → volume → fade → delay (→ ducking nếu là nhạc);
 * sau đó amix → loudnorm (hoặc limiter) → pad đúng thời lượng video.
 */
export function buildAudioFilter(audio: Omit<EncodeAudio, "assetsDir">, firstInput = 1): string {
  const { segments, duration, ducking } = audio;
  const parts: string[] = [];
  segments.forEach((seg, i) => {
    const len = seg.end - seg.start;
    const chain = [
      `atrim=start=${num(seg.offset)}:duration=${num(len)}`,
      "asetpts=PTS-STARTPTS",
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      `volume=${num(seg.volume)}`,
    ];
    if (seg.pan) {
      const [l, r] = panGains(seg.pan);
      chain.push(`pan=stereo|c0=${num(l)}*c0|c1=${num(r)}*c1`);
    }
    if (seg.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(Math.min(seg.fadeIn, len))}`);
    if (seg.fadeOut > 0) {
      const d = Math.min(seg.fadeOut, len);
      chain.push(`afade=t=out:st=${num(len - d)}:d=${num(d)}`);
    }
    if (seg.start > 0) chain.push(`adelay=delays=${Math.round(seg.start * 1000)}:all=1`);
    // Sau adelay, t của filter = thời gian trong video.
    if (ducking && seg.kind === "music") chain.push(`volume=eval=frame:volume='${duckExpression(ducking)}'`);
    parts.push(`[${firstInput + i}:a]${chain.join(",")}[a${i}]`);
  });
  const labels = segments.map((_, i) => `[a${i}]`).join("");
  const mix = segments.length > 1 ? `${labels}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,` : labels;
  const level =
    audio.loudness !== undefined ? `${loudnormFilter(audio.loudness, audio.measured)},aresample=${AUDIO_RATE}` : "alimiter=limit=0.95:latency=1";
  parts.push(`${mix}${level},apad=whole_dur=${num(duration)}[aout]`);
  return parts.join(";");
}

function audioInputs(audio: EncodeAudio): string[] {
  const args: string[] = [];
  for (const seg of audio.segments) {
    if (seg.loop) args.push("-stream_loop", "-1");
    args.push("-i", join(audio.assetsDir, seg.file));
  }
  return args;
}

/** Pass 1 của loudnorm: chỉ trộn audio và đo độ to. */
export function buildLoudnessMeasureArgs(audio: EncodeAudio): string[] {
  const filter = buildAudioFilter({ ...audio, measured: undefined }, 0);
  return ["-hide_banner", "-nostats", "-loglevel", "info", ...audioInputs(audio), "-filter_complex", filter, "-map", "[aout]", "-t", num(audio.duration), "-f", "null", "-"];
}

/** Lấy khối JSON cuối cùng loudnorm in ra stderr. */
export function parseLoudnessMeasure(stderr: string): LoudnessMeasure {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new FFmpegError("Không đọc được kết quả đo loudnorm");
  const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
  for (const k of keys) {
    const v = json[k];
    if (v === undefined || !Number.isFinite(Number(v))) throw new FFmpegError(`loudnorm thiếu ${k} (audio im lặng?)`);
  }
  return Object.fromEntries(keys.map((k) => [k, json[k]!])) as unknown as LoudnessMeasure;
}

/** Argument array cho FFmpeg – không bao giờ ghép thành chuỗi shell. */
export function buildEncodeArgs(o: EncodeOptions): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(o.fps), "-start_number", "1", "-i", join(o.framesDir, FRAME_PATTERN)];

  const audio = o.audio && o.audio.segments.length > 0 ? o.audio : undefined;
  let nextInput = 1;
  if (audio) {
    args.push(...audioInputs(audio));
    nextInput += audio.segments.length;
  }
  const subtitleInput = o.subtitlesFile ? nextInput : undefined;
  if (o.subtitlesFile) args.push("-i", o.subtitlesFile);

  if (audio) args.push("-filter_complex", buildAudioFilter(audio), "-map", "0:v", "-map", "[aout]");
  else args.push("-map", "0:v");
  if (subtitleInput !== undefined) args.push("-map", `${subtitleInput}:s`);

  args.push("-c:v", "libx264", "-preset", o.preset ?? "medium", "-crf", String(o.crf ?? 18), "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", String(AUDIO_RATE), "-t", num(audio.duration));
  if (subtitleInput !== undefined) args.push("-c:s", "mov_text", "-metadata:s:s:0", "language=vie");
  args.push("-movflags", "+faststart", o.output);
  return args;
}

export interface MovieClip {
  /** Clip chỉ có hình của một cảnh. */
  file: string;
  /** Độ dài clip (giây, = frame / fps). */
  duration: number;
  /** Chuyển VÀO clip này; duration 0 = cắt thẳng. */
  transition: { type: "cut" | "fade" | "dissolve"; duration: number };
}

export interface MovieEncodeOptions {
  clips: readonly MovieClip[];
  fps: number;
  output: string;
  crf?: number;
  preset?: string;
  audio?: EncodeAudio;
  subtitlesFile?: string;
}

/** Ghép hình: cut → concat, fade → xfade fadeblack, dissolve → xfade fade. Đầu ra [vout]. */
export function buildMovieVideoFilter(clips: readonly MovieClip[], fps: number): string {
  const parts = clips.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,setsar=1,settb=AVTB[c${i}]`);
  let acc = "c0";
  let length = clips[0]?.duration ?? 0;
  clips.forEach((clip, i) => {
    if (i === 0) return;
    const out = i === clips.length - 1 ? "vout" : `v${i}`;
    const d = clip.transition.duration;
    if (clip.transition.type === "cut" || d <= 0) {
      parts.push(`[${acc}][c${i}]concat=n=2:v=1:a=0[${out}]`);
      length += clip.duration;
    } else {
      const kind = clip.transition.type === "fade" ? "fadeblack" : "fade";
      parts.push(`[${acc}][c${i}]xfade=transition=${kind}:duration=${num(d)}:offset=${num(length - d)}[${out}]`);
      length += clip.duration - d;
    }
    acc = out;
  });
  if (clips.length === 1) parts.push("[c0]null[vout]");
  return parts.join(";");
}

/** Argument FFmpeg cho movie: N clip hình + audio toàn phim + phụ đề mềm → MP4. */
export function buildMovieEncodeArgs(o: MovieEncodeOptions): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const clip of o.clips) args.push("-i", clip.file);
  const audio = o.audio && o.audio.segments.length > 0 ? o.audio : undefined;
  let nextInput = o.clips.length;
  if (audio) {
    args.push(...audioInputs(audio));
    nextInput += audio.segments.length;
  }
  const subtitleInput = o.subtitlesFile ? nextInput : undefined;
  if (o.subtitlesFile) args.push("-i", o.subtitlesFile);

  const filters = [buildMovieVideoFilter(o.clips, o.fps)];
  if (audio) filters.push(buildAudioFilter(audio, o.clips.length));
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audio) args.push("-map", "[aout]");
  if (subtitleInput !== undefined) args.push("-map", `${subtitleInput}:s`);

  args.push("-c:v", "libx264", "-preset", o.preset ?? "medium", "-crf", String(o.crf ?? 18), "-pix_fmt", "yuv420p", "-r", String(o.fps));
  if (audio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", String(AUDIO_RATE), "-t", num(audio.duration));
  if (subtitleInput !== undefined) args.push("-c:s", "mov_text", "-metadata:s:s:0", "language=vie");
  args.push("-movflags", "+faststart", o.output);
  return args;
}

export class FFmpegError extends Error {
  readonly code = "FFmpegRenderFailed";
  constructor(message: string) {
    super(message);
    this.name = "FFmpegError";
  }
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

/** Dòng lệnh dài hơn mức này → filter_complex ghi ra file (Windows giới hạn ~32 767 ký tự cho cả dòng lệnh). */
const MAX_CMDLINE = 24000;

/**
 * Phim dài / nhiều câu thoại: filter_complex (mỗi đoạn audio một chuỗi lọc + biểu thức ducking) vượt giới hạn dòng
 * lệnh của Windows (spawn ENAMETOOLONG) → ghi filter ra file tạm, FFmpeg đọc bằng `-/filter_complex <file>` (FFmpeg ≥ 7).
 */
function shortenArgs(args: readonly string[]): { args: string[]; cleanup?: () => void } {
  const len = args.reduce((n, a) => n + a.length + 3, 0);
  const at = args.indexOf("-filter_complex");
  if (len <= MAX_CMDLINE || at < 0 || at + 1 >= args.length) return { args: [...args] };
  const file = join(tmpdir(), `ac-filter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(file, args[at + 1]!, "utf8");
  const out = [...args];
  out.splice(at, 2, "-/filter_complex", file);
  return { args: out, cleanup: () => rmSync(file, { force: true }) };
}

/** Chạy FFmpeg; trả về stderr (cần cho pass đo loudnorm). */
export function runFfmpeg(args: readonly string[], bin = ffmpegPath()): Promise<string> {
  const short = shortenArgs(args);
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn(bin, short.args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-20000);
    });
    child.on("error", (err) => reject(new FFmpegError(`Không chạy được FFmpeg (${bin}): ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolveRun(stderr);
      else reject(new FFmpegError(`FFmpeg thoát với mã ${String(code)}: ${stderr.trim().slice(-4000)}`));
    });
  }).finally(() => short.cleanup?.());
}
