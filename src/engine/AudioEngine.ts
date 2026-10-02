import type { Registry } from "../schemas/asset.schema";
import type { SceneScript } from "../schemas/scene.schema";
import {
  computeAudioSegments,
  panGains,
  computeDucking,
  duckBreakpoints,
  duckGainAt,
  segmentFileTime,
  segmentGainAt,
  type AudioSegment,
  type Ducking,
} from "./AudioTimeline";

/**
 * Phát audio trong preview (Web Audio), dùng cùng AudioSegment với FFmpeg.
 * Chỉ dùng cho preview – video cuối cùng do FFmpeg trộn.
 */
export class AudioEngine {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private segments: AudioSegment[] = [];
  private ducking: Ducking | undefined;
  /** Bus riêng cho nhạc nền để giảm âm lượng khi có lời thoại. */
  private musicBus: GainNode | undefined;
  private playing: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private muted = false;

  constructor(private readonly baseUrl = "/assets/") {}

  /** Nạp scene mới: tính đoạn phát và tải trước buffer. */
  load(scene: SceneScript, registry: Registry): void {
    this.stop();
    this.segments = computeAudioSegments(scene, registry);
    this.ducking = computeDucking(scene, this.segments);
    if (this.ctx) for (const seg of this.segments) void this.buffer(seg.file).catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  /** Bắt đầu phát từ thời điểm `time` của video. Gọi lại sau mỗi lần seek. */
  async start(time: number): Promise<void> {
    this.stop();
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    const segments = this.segments;
    const buffers = await Promise.all(segments.map((s) => this.buffer(s.file).catch(() => undefined)));
    if (segments !== this.segments) return; // scene đã đổi trong lúc tải

    // Neo thời gian sau khi tải xong để tránh lệch.
    const now = ctx.currentTime + 0.03;
    this.scheduleDucking(time, now);
    segments.forEach((seg, i) => {
      const buffer = buffers[i];
      if (!buffer || seg.end <= time) return;
      const from = Math.max(time, seg.start);
      const when = now + (from - time);
      const remaining = seg.end - from;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = seg.loop;
      const gain = ctx.createGain();
      this.scheduleGain(gain.gain, seg, from, when);
      const bus = seg.kind === "music" ? this.musicBus! : this.master!;
      if (seg.pan) {
        // Cùng hệ số trái / phải với FFmpeg (panGains).
        const [l, r] = panGains(seg.pan);
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        const gl = ctx.createGain();
        const gr = ctx.createGain();
        gl.gain.value = l;
        gr.gain.value = r;
        source.connect(gain).connect(split);
        split.connect(gl, 0).connect(merge, 0, 0);
        split.connect(gr, 1).connect(merge, 0, 1);
        merge.connect(bus);
      } else source.connect(gain).connect(bus);
      source.start(when, segmentFileTime(seg, from), seg.loop ? remaining : Math.min(remaining, buffer.duration));
      this.playing.push({ source, gain });
    });
  }

  stop(): void {
    for (const { source, gain } of this.playing) {
      try {
        source.stop();
      } catch {
        // chưa start
      }
      source.disconnect();
      gain.disconnect();
    }
    this.playing = [];
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = undefined;
    this.buffers.clear();
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
    }
    return this.ctx;
  }

  private buffer(file: string): Promise<AudioBuffer> {
    let entry = this.buffers.get(file);
    if (!entry) {
      const ctx = this.context();
      entry = fetch(this.baseUrl + file)
        .then((r) => {
          if (!r.ok) throw new Error(`${file}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data));
      entry.catch(() => this.buffers.delete(file));
      this.buffers.set(file, entry);
    }
    return entry;
  }

  /** Đường ducking của nhạc nền (tuyến tính từng đoạn, cùng công thức với FFmpeg). */
  private scheduleDucking(time: number, when: number): void {
    const param = this.musicBus?.gain;
    if (!param) return;
    param.cancelScheduledValues(0);
    const d = this.ducking;
    if (!d) {
      param.setValueAtTime(1, when);
      return;
    }
    param.setValueAtTime(duckGainAt(d, time), when);
    for (const bp of duckBreakpoints(d)) {
      if (bp > time) param.linearRampToValueAtTime(duckGainAt(d, bp), when + (bp - time));
    }
  }

  /** Lập lịch volume + fade khớp segmentGainAt (cùng công thức với FFmpeg afade). */
  private scheduleGain(param: AudioParam, seg: AudioSegment, from: number, when: number): void {
    param.setValueAtTime(segmentGainAt(seg, from), when);
    const len = seg.end - seg.start;
    const at = (t: number) => when + (t - from);
    const fadeInEnd = seg.start + Math.min(seg.fadeIn, len);
    if (seg.fadeIn > 0 && from < fadeInEnd) param.linearRampToValueAtTime(seg.volume, at(fadeInEnd));
    if (seg.fadeOut > 0) {
      const fadeOutStart = seg.end - Math.min(seg.fadeOut, len);
      if (from < fadeOutStart) param.setValueAtTime(segmentGainAt(seg, fadeOutStart), at(fadeOutStart));
      param.linearRampToValueAtTime(0, at(seg.end));
    }
  }
}
