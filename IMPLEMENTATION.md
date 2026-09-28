# IMPLEMENTATION.md

**Version:** 2.0 – đồng bộ với BRD v2.0 (sản xuất hàng loạt)

> **Thay đổi chính so với v1.0**
> - Engine là **hàm thuần của thời gian** `evaluate(t)` → seek bất kỳ, render tất định. Bỏ API `move(..., delta)`.
> - AnimationMixer **không** dùng `crossFadeTo()` / `fadeIn()` (có trạng thái). Weight và time của clip được tính trực tiếp từ timeline.
> - Render chạy trong **Chromium headless (Playwright)**, cùng engine với preview. FFmpeg gọi bằng `child_process.spawn` với argument array (không dùng `fluent-ffmpeg` – đã ngừng bảo trì).
> - Scene Script dùng **Zod discriminated union** theo `type`, không dùng `data: Record<string, unknown>`.
> - Lưu trữ: filesystem là nguồn duy nhất (`projects/<id>/scene.json`); không nhân đôi vào DB.
> - Render CLI có trước Express server; API server chuyển sang MVP+ (batch).

---

# 1. Tech stack

| Thành phần | Lựa chọn |
|---|---|
| Ngôn ngữ | TypeScript strict |
| UI | React 19 + Zustand |
| Build/dev | Vite |
| 3D | Three.js (WebGL2), GLTFLoader, SkeletonUtils |
| Schema | Zod |
| Test | Vitest |
| Render | Playwright (Chromium headless; fallback Edge/Chrome cài sẵn) |
| Encode | FFmpeg (binary cài riêng, gọi qua `spawn`) |
| Chạy script TS | tsx |

---

# 2. Nguyên tắc phát triển

1. `strict: true`, không dùng `any` (trừ khi bắt buộc với thư viện ngoài, phải chú thích).
2. **Scene Script là nguồn dữ liệu duy nhất.** Không hard-code nhân vật, animation, timeline.
3. **Engine tất định:** mọi trạng thái tại thời điểm `t` tính được chỉ từ `(SceneScript, Registry, t)`.
4. **Không `setTimeout` / `clock.getDelta()`** để điều khiển nội dung. `getDelta` chỉ dùng để tiến đồng hồ preview.
5. Không `eval`, `new Function`, không thực thi code từ AI/template.
6. Không ghép chuỗi shell; `spawn(cmd, argsArray)`.
7. Logic thuần (evaluate, validate) **không import WebGL** → test được trong Node.

---

# 3. Cấu trúc thư mục

```text
AutoCatoonV3/
├── package.json · tsconfig.json · vite.config.ts
├── index.html                 ← Editor / Preview
├── render.html                ← Trang render cho Chromium headless
│
├── public/assets/
│   ├── registry.json          ← Asset Registry
│   ├── characters/*.glb
│   ├── environments/*.glb
│   ├── props/*.glb
│   └── audio/*.wav
│
├── templates/<template-id>/
│   ├── template.json
│   └── data.csv
│
├── batches/<template-id>/     ← videos/, report.csv, report.json (không commit)
│
├── projects/<project-id>/
│   ├── project.json
│   ├── scene.json
│   └── renders/
│
├── src/
│   ├── main.tsx · App.tsx · styles.css
│   ├── components/            ← Toolbar, Viewport, Timeline, ScenePanel
│   ├── store/editorStore.ts   ← Zustand: project, scene, validate, playback (advance(dt))
│   ├── schemas/
│   │   ├── scene.schema.ts    ← Zod: SceneScript, Action, CameraShot
│   │   └── asset.schema.ts    ← Zod: AssetEntry, Registry
│   ├── validation/
│   │   └── validateScene.ts   ← schema + tham chiếu Registry → lỗi có mã
│   ├── engine/
│   │   ├── time.ts            ← frame ↔ time, format thời gian
│   │   ├── math.ts            ← góc, heading ↔ vector, smoothstep
│   │   ├── MovementEngine.ts  ← evaluateTransform(t)   (thuần)
│   │   ├── AnimationEngine.ts ← evaluateAnimation(t)   (thuần) + applyAnimation()
│   │   ├── CameraEngine.ts    ← evaluateCamera(t)      (thuần)
│   │   ├── AudioTimeline.ts   ← computeAudioSegments   (thuần, dùng chung preview + FFmpeg)
│   │   ├── AudioEngine.ts     ← Web Audio cho preview (music bus + ducking)
│   │   ├── Subtitles.ts       ← SRT, phụ đề đang hiển thị, vẽ phụ đề (canvas 2D)
│   │   ├── AssetLoader.ts     ← GLTFLoader + cache + chuẩn hóa scale
│   │   └── SceneEngine.ts     ← Three.js: scene, renderer, load, seek, render, dispose
│   ├── template/
│   │   ├── template.ts        ← schema template, ép kiểu tham số, thay biến, $if, override định dạng
│   │   └── csv.ts             ← đọc CSV (RFC 4180, BOM, ; / tab)
│   ├── tts/
│   │   └── resolveScene.ts    ← Scene soạn thảo → đã resolve (TTS, after, sync, duration auto)
│   └── render/
│       ├── renderPage.ts      ← API window.__AC_RENDER__ cho Playwright
│       └── types.ts           ← kiểu RenderApi dùng chung CLI ↔ trang
│
├── cli/
│   ├── renderJob.ts           ← lõi render dùng chung (env, prepareScene, renderScene)
│   ├── render.ts              ← npm run render -- <project>
│   ├── batch.ts               ← npm run batch -- <template> [data.csv]
│   └── ffmpeg.ts              ← build args + spawn
│
├── server/
│   ├── projectsApi.ts         ← Vite plugin: /api/projects (list/load/save) + /api/resolve
│   └── tts/piperTts.ts        ← TTS offline Piper + cache theo hash
│
├── scripts/
│   ├── generate-demo-assets.ts ← sinh park.glb, log.glb (low-poly, tự tạo → CC0)
│   └── generate-demo-audio.ts  ← tổng hợp nhạc nền + hiệu ứng (CC0)
│
├── tools/tts-voices/          ← model giọng Piper (.onnx + .onnx.json, không commit)
└── .venv/                     ← Python venv chứa piper-tts (không commit)
│
└── tests/                     ← Vitest
```

---

# 4. Scene Script (schema chuẩn)

File: `src/schemas/scene.schema.ts`

```typescript
type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; z: number };

interface SceneScript {
  version: 1;
  meta: { name: string; duration: number; fps: number; width: number; height: number; commercial?: boolean };
  environment: { asset: string; background?: string; fog?: { color?: string; near: number; far: number } };
  characters: { id: string; asset: string; position: Vec3; heading: number; scale: number }[];
  props: { id: string; asset: string; position: Vec3; heading: number; scale: number }[];
  camera: CameraShot;            // shot mặc định
  actions: Action[];
  audio: AudioTrack[];           // mặc định []
}

interface AudioTrack {
  id: string;
  kind: "music" | "sfx" | "voice";
  asset: string;                 // asset type "audio"
  start: number;                 // giây, trong video
  duration?: number;             // bỏ trống: hết file (loop: tới cuối video)
  trimStart: number;             // bỏ qua đoạn đầu file (0)
  volume: number;                // 0–4 (1)
  loop: boolean;                 // (false)
  fadeIn: number;                // giây (0)
  fadeOut: number;               // giây (0)
}

type CameraShot =
  | { mode: "fixed"; position: Vec3; lookAt: Vec3; fov: number }
  | { mode: "follow"; target: string; offset: Vec3; lookAtOffset: Vec3; relative: boolean; fov: number };

type Action = { id: string; start: number; duration: number } & (
  | { type: "animation"; target: string; clip: string; loop: boolean; speed: number; fade: number }
  | { type: "move";      target: string; direction: "forward" | "backward" | "left" | "right"; speed: number; face?: boolean }
  | { type: "moveTo";    target: string; to: Vec2; face: boolean }
  | { type: "path";      target: string; points: Vec2[]; face: boolean }
  | { type: "turn";      target: string; heading?: number; by?: number }   // đúng một trong hai
  | { type: "jump";      target: string; height: number }
  | { type: "camera";    shot: CameraShot }
);
```

Giá trị mặc định (Zod `.default`): `heading 0`, `scale 1`, `loop true`, `speed 1`, `fade 0.25`, `fov 50`, `face true` (riêng `move backward` mặc định `face false`), `lookAtOffset {0,1,0}`, `relative false`, `props []`.

---

# 5. Asset Registry

File: `public/assets/registry.json`, schema `src/schemas/asset.schema.ts`.

```typescript
interface AssetEntry {
  id: string;
  type: "character" | "environment" | "prop" | "audio";
  name: string;
  file: string;               // tương đối với /assets/
  height?: number;            // chuẩn hóa chiều cao (m) – character/prop
  headingOffset?: number;     // độ
  defaultClip?: string;       // character
  clips?: string[];           // character – tên clip thật trong file
  clipAliases?: Record<string, string>; // tên chuẩn → clip thật (walk → Walking)
  suggestedSpeed?: Record<string, number>;
  rootMotion?: "none" | "strip";
  duration?: number;          // audio: bắt buộc, độ dài file (giây)
  license: string;
  author: string;
  source: string;
  commercialUse: boolean;
  attributionRequired: boolean;
}
```

Registry dùng chung cho Validator, Editor, AI prompt builder.

**Tên clip chuẩn:** `STANDARD_CLIPS` + `resolveClip(asset, name)` (`src/schemas/asset.schema.ts`) – nhận tên thật hoặc tên chuẩn. Validator dùng `resolveClip` để kiểm tra `AnimationNotFound`; SceneEngine đổi tên chuẩn → clip thật ngay trước `applyAnimation` và thêm độ dài clip cho tên chuẩn (loop đúng).

**Trường mới của AssetEntry:** `scale` (hệ số khi không có `height` – SceneEngine, preview, env:compose đều dùng `height ? height/size.y : scale ?? 1`), `tags: string[]`, `pack`.

**Tên clip:** khi import, bỏ `Armature|`, đuôi Blender `.001`, và **tiền tố tên nhân vật** (`stripClipPrefixes`: ≥ 60% clip cùng tiền tố, hoặc phần sau là tên quen thuộc – "Man_Walk" → "Walk"). Tên chuẩn bổ sung: `clap`, `fly`, `swim`, `attack`; dự phòng `wave/thumbsup/dance/victory` ưu tiên `Clapping`.

**Nén texture:** `textureCompress({ encoder: sharp, targetFormat: "webp", resize: [MAX_TEXTURE, MAX_TEXTURE] })`, `MAX_TEXTURE` mặc định 1024 (biến môi trường).

**Tải gói:** `scripts/fetch-drive.py` (gdown liệt kê, `requests` tải song song `FETCH_WORKERS`=6 qua drive.usercontent, bỏ qua file đã có, thử lại 3 lần). `scripts/import-quaternius.sh` ghi lại toàn bộ lệnh nhập (nhóm, tỷ lệ, chiều cao, tên tiếng Việt).

**Ghép bối cảnh – `scripts/compose-environment.ts`:** nạp mỗi đạo cụ một lần bằng `mergeDocuments`, giữ node gốc làm mẫu, mỗi lượt đặt tạo node mới trỏ tới **cùng mesh** (instancing), chuẩn hóa như engine (`getBounds` → scale, chân chạm y = 0), nền + lối đi là quad tự dựng, `dedup` + `prune`, ghi GLB + upsert Registry. RNG mulberry32 theo `seed`.

**Import asset – `scripts/asset-add.ts` (`npm run asset:add`):** FBX → GLB bằng `tools/bin/FBX2glTF.exe` (hoặc `FBX2GLTF_PATH`); đọc/ghi bằng `@gltf-transform` (đổi tên clip `a|b` → `b`, `dedup` + `prune`); `buildAliases(clips)` (`src/assets/clipAliases.ts`, thuần) chọn khớp đúng trước, dự phòng sau; upsert Registry theo `id`. File gốc tải về để trong `tools/quaternius/` (không commit).
Danh sách license cho phép thương mại (MVP): `CC0-1.0`, `CC-BY-4.0`, `MIT`, `Proprietary-Owned`.

---

# 6. Validator

File: `src/validation/validateScene.ts`

```typescript
interface SceneIssue { code: SceneErrorCode; message: string; path?: string }
type ValidationResult =
  | { ok: true; scene: SceneScript }     // scene đã áp default
  | { ok: false; issues: SceneIssue[] };

function validateScene(input: unknown, registry: Registry): ValidationResult;
```

Thứ tự:
1. Zod parse → `InvalidSchema` (kèm path).
2. `DuplicateId` (characters, props, actions, audio).
3. `AssetNotFound`, `AssetTypeMismatch` (audio phải trỏ tới asset loại `audio`).
4. `TargetNotFound` (action + camera follow).
5. `AnimationNotFound` (clip ∉ `clips` của asset).
6. `ActionOutOfRange` (`start + duration > meta.duration + ε`).
7. `ActionOverlap`: nhóm vị trí (`move|moveTo|path|turn`) / nhóm `animation` / nhóm `jump` của cùng nhân vật; nhóm `camera`.
8. `AudioOutOfRange`: audio bắt đầu ≥ `meta.duration`, hoặc `trimStart` ≥ độ dài file (khi không loop).
9. `LicenseViolation`: `meta.commercial === true` mà asset `commercialUse === false` (áp dụng cả audio).

---

# 7. MovementEngine (thuần)

```typescript
interface CharacterTransform { position: Vec3; heading: number /* độ */ }

function evaluateTransform(
  character: SceneCharacter,
  actions: Action[],   // action của nhân vật này
  t: number
): CharacterTransform;
```

Thuật toán (O(n) theo số action, tất định):

```text
pos = character.position; heading = character.heading; y = 0
for action in motionActions sorted by start:
    if t <= action.start: break
    p = clamp((t - action.start) / action.duration, 0, 1)
    elapsed = p * action.duration
    switch action.type:
      move:   dir = heading + {forward:0, left:+90, right:-90, backward:180}
              pos += unit(dir) * speed * elapsed
              if face: heading = dir   (backward: face mặc định false)
      moveTo: pos = lerp(start, to, p);  if face: heading = atan2(to - start)
      path:   di chuyển theo độ dài cung, tốc độ đều qua [start, ...points]
              if face: heading = hướng đoạn hiện tại
      turn:   heading = lerp(heading, target, easeInOut(p))
jump (độc lập): y = height * 4p(1-p) khi action đang chạy
```

- Hướng vector từ heading: `(sin h, 0, cos h)`; heading 0 → +Z; +90 → +X (bên trái nhân vật).
- Khi `face` đổi hướng đột ngột, hướng hiển thị được làm mượt trong `min(0.2s, duration)` đầu action (vẫn là hàm của t).
- Góc được nội suy theo đường ngắn nhất.

---

# 8. AnimationEngine

## 8.1. Phần thuần

```typescript
interface ClipState { clip: string; time: number; weight: number }

function evaluateAnimation(
  animActions: AnimationAction[],   // đã sort, không chồng
  t: number,
  defaultClip: string | undefined,
  clipDurations: Record<string, number>
): ClipState[];
```

- Action đang chạy `A`: `localTime = (t - A.start) * A.speed`; `loop` → `mod clipDuration`, không loop → `min(localTime, clipDuration - ε)`.
- Crossfade: trong `A.fade` giây đầu, nếu ngay trước đó (khoảng hở ≤ fade) là clip `B` (hoặc `defaultClip`), trả về `[B: 1-w, A: w]` với `w = p` (smoothstep). `B` tiếp tục thời gian của chính nó.
- Không có action nào → `defaultClip` với `time = t mod duration`.

## 8.2. Áp vào Three.js

```typescript
function applyAnimation(mixer: AnimationMixer, actions: Map<string, AnimationAction>, states: ClipState[]): void
```

- Tất cả `AnimationAction` được `play()` một lần khi load, `weight = 0`.
- Mỗi lần seek: đặt `action.time`, `action.weight` theo `states`, còn lại weight 0; gọi `mixer.update(0)`.
- **Không** dùng `crossFadeTo`, `fadeIn`, `fadeOut`, `mixer.update(delta)` để tiến nội dung.

## 8.3. Root motion

Nếu `rootMotion: "strip"`: khi load, xóa thành phần X/Z của track `position` trên root bone (giữ Y). Asset `"none"` giữ nguyên.

---

# 9. CameraEngine (thuần)

```typescript
interface CameraState { position: Vec3; lookAt: Vec3; fov: number }
function evaluateCamera(scene: SceneScript, t: number, transforms: Map<string, CharacterTransform>): CameraState;
```

- Shot đang hoạt động = camera action chứa `t`, nếu không thì `scene.camera`.
- `fixed`: trả trực tiếp.
- `follow`: `position = target.position + offset` (nếu `relative` thì xoay offset theo heading), `lookAt = target.position + lookAtOffset`.
- Không làm mượt theo frame (lerp theo delta phá tính tất định). Làm mượt (nếu cần) phải là hàm của t – Phase 2.

---

# 10. SceneEngine (Three.js)

```typescript
class SceneEngine {
  constructor(options: { canvas?: HTMLCanvasElement; container?: HTMLElement; width; height; preserveDrawingBuffer?: boolean });
  load(scene: SceneScript, registry: Registry): Promise<void>;
  seek(t: number): void;        // áp evaluateTransform / evaluateAnimation / evaluateCamera
  render(): void;
  resize(width: number, height: number): void;
  get duration(): number;
  dispose(): void;              // geometry, material, texture, mixer, renderer, listeners
}
```

- Renderer: `WebGLRenderer({ antialias: true })`, `SRGBColorSpace`, `ACESFilmicToneMapping`, shadow map PCF soft.
- Ánh sáng mặc định: HemisphereLight + DirectionalLight có bóng (theo nhân vật trong vùng shadow camera cố định).
- Nhân vật: clone bằng `SkeletonUtils.clone` (nhiều instance cùng asset), bọc trong `Group` (điều khiển vị trí/hướng), model con được scale theo `height` và xoay `headingOffset`.
- `AssetLoader` cache `Promise<GLTF>` theo file → không load trùng.

---

# 11. Preview

- `editorStore`: `play / pause / stop / seek / advance(dt)`. Mỗi `requestAnimationFrame`, Viewport gọi `advance(dt)` (chỉ tiến **đồng hồ**), rồi `engine.seek(time)` + `engine.render()` → nội dung luôn là hàm của `time`.
- Checkbox "Camera tự do (khi dừng)": OrbitControls xoay tự do khi không phát; khi Play → camera theo Scene Script.
- Viewport giữ đúng tỷ lệ khung hình của `meta.width × meta.height` (letterbox).

---

# 12. Render

## 12.1. Render page (`render.html` → `src/render/renderPage.ts`)

```typescript
window.__AC_RENDER__ = {
  load(scene: unknown, width: number, height: number): Promise<{ ok: true; totalFrames: number } | { ok: false; issues: SceneIssue[] }>;
  renderFrame(index: number): string;   // PNG base64 (không prefix), time = index / fps
};
```

Renderer render mode: `pixelRatio = 1`, `preserveDrawingBuffer: true`, kích thước đúng `width × height`.

## 12.2. Render CLI (`cli/render.ts`)

```bash
npm run render -- projects/demo-robot-park [--width 1280] [--height 720] [--fps 30]
                   [--out file.mp4] [--keep-frames] [--browser chromium|msedge|chrome]
```

Luồng:

```text
đọc scene.json → khởi động Vite nội bộ (port ngẫu nhiên)
→ Playwright mở render.html (viewport = width×height)
→ __AC_RENDER__.load(scene) (validate trong trang; lỗi → Failed)
→ for i in 0..totalFrames-1: renderFrame(i) → ghi frame_{i+1:06d}.png
→ FFmpeg → MP4 → ghi render.json → dọn frames (trừ --keep-frames)
```

- `totalFrames = round(duration × fps)`; frame `i` ở thời điểm `i / fps`.
- Tên frame zero-padding 6 chữ số, bắt đầu từ 1 → FFmpeg `-start_number 1`.
- `render.json`: `{ id, status, progress, currentFrame, totalFrames, width, height, fps, output, error, startedAt, completedAt }`, cập nhật định kỳ.
- Không bao giờ ghi vào `scene.json`.

## 12.3. FFmpeg (`cli/ffmpeg.ts`)

```text
ffmpeg -y -framerate <fps> -start_number 1 -i <dir>/frame_%06d.png
       -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart <out>.mp4
```

- `spawn("ffmpeg", args)`; đường dẫn FFmpeg có thể override bằng biến `FFMPEG_PATH`.
- Exit code ≠ 0 → lỗi `FFmpegRenderFailed` kèm stderr cuối.
- Kích thước lẻ → lỗi validate (H.264 yuv420p cần chẵn).

## 12.4. Audio

### Resolve (thuần, dùng chung) – `src/engine/AudioTimeline.ts`

```typescript
interface AudioSegment { id; kind; file; fileDuration; start; end; offset; loop; volume; fadeIn; fadeOut }
function computeAudioSegments(scene: SceneScript, registry: Registry): AudioSegment[];
function segmentGainAt(seg: AudioSegment, t: number): number;     // volume × fade tuyến tính
function segmentFileTime(seg: AudioSegment, t: number): number;   // vị trí trong file (mod nếu loop)
```

- `end` = `start + duration` nếu có; loop không duration → cuối video; không loop → hết file (`fileDuration - trimStart`). Luôn cắt tại `meta.duration`.
- Preview và render dùng **cùng** danh sách segment → nghe trong preview đúng như trong MP4.

### Render – FFmpeg

```text
-i frames/frame_%06d.png  [-stream_loop -1] -i audio_1  -i audio_2 …
-filter_complex
  [k:a] atrim=start=<offset>:duration=<len>, asetpts=PTS-STARTPTS,
        aformat=fltp:48000:stereo, volume=<v>, afade=in…, afade=out…, adelay=<start ms>:all=1 [ak]
  [a1][a2]… amix=inputs=N:normalize=0, alimiter=limit=0.95:latency=1, apad=whole_dur=<duration> [aout]
-map 0:v -map [aout] -c:a aac -b:a 192k -ar 48000 -t <duration>
```

- Track loop dùng `-stream_loop -1` cho input + `atrim` giới hạn độ dài.
- `amix normalize=0` giữ nguyên volume khai báo; `alimiter` chống vỡ tiếng khi nhiều track chồng nhau.
- Audio luôn dài đúng bằng video (`apad` + `-t`).
- CLI kiểm tra file audio tồn tại trước khi render frame (`AssetLoadFailed`). `render.json` có thêm `audioTracks`.

### Preview – `src/engine/AudioEngine.ts` (Web Audio)

- `load(scene, registry)`: tính segment, tải trước `AudioBuffer` (cache theo file).
- `start(time)`: mỗi segment còn hiệu lực → `AudioBufferSourceNode.start(when, segmentFileTime(from), remaining)`, `loop` cho nhạc nền; `GainNode` lập lịch volume + fade theo `segmentGainAt`.
- Hook `useAudioPreview` lắng nghe store: Play / seek (`seekId`) / đổi scene → `start(time)`; Pause / Stop → `stop()`. Nút 🔊/🔇 trên toolbar.
- AudioContext chỉ được tạo khi người dùng bấm Play (chính sách autoplay của trình duyệt).

### Asset audio demo

`scripts/generate-demo-audio.ts` tổng hợp bằng code (tất định, CC0): `music_happy` (lặp 8s, 120 bpm), `sfx_boing`, `sfx_land`, `sfx_chime`, `sfx_whoosh` → `public/assets/audio/*.wav`.

## 12.5. Timeout

Mỗi frame timeout 30s, toàn job timeout theo `totalFrames` → `RenderTimeout`.

---

# 13. Project API (MVP, Vite plugin)

File: `server/projectsApi.ts` – chạy trong dev server, không cần Express ở MVP.

```text
GET  /api/projects                → [{ id, name }]
GET  /api/projects/:id/scene      → scene.json
PUT  /api/projects/:id/scene      → ghi scene.json (id chỉ cho phép [a-z0-9-_])
POST /api/resolve                 → { scene, issues, synthesized } (TTS Piper + sync + duration auto)
```

Editor: khi bấm Áp dụng, nếu `needsResolve(scene)` → gọi `/api/resolve` rồi mới validate. File TTS nằm trong `public/assets/tts/` nên preview phát được ngay.

Batch render / job queue (MVP+) sẽ tách thành server riêng (Express/Fastify) với các endpoint `POST /api/render`, `GET /api/render/:id` như BRD.

---

# 14. Lời thoại, TTS, phụ đề, ducking, độ to, template, batch (đã triển khai)

## 14.1. Hai tầng Scene Script

| Tầng | Ai viết | Đặc điểm |
|---|---|---|
| **Soạn thảo** (`scene.json`) | người / template / AI | `dialogue[]` chỉ có text; `start` có thể là `{after}`; action/audio có `sync`; `meta.duration` có thể `"auto"` |
| **Đã resolve** (`scene.resolved.json`) | Resolver | toàn số cụ thể; `dialogue[]` có `start`, `duration`, `file`, `voice`, `rate` → validate + render như cũ |

```typescript
// Đã resolve – src/schemas/scene.schema.ts
interface DialogueLine { id; speaker?; text; start; duration; file; voice; rate; volume; subtitle }
interface SubtitleStyle { burnIn: boolean; size: number /* tỷ lệ chiều cao */; position: "bottom" | "top"; showSpeaker: boolean }
interface MixSettings { duckMusic: boolean; duckLevel: number; duckRamp: number; loudness: number | null }
// SceneCharacter có thêm voice?: string; Registry có asset type "voice" (provider, language, defaultRate, speaker)
```

## 14.2. Resolver – `src/tts/resolveScene.ts` (thuần, TTS truyền vào)

```typescript
type Synthesize = (req: { text; voice: AssetEntry; rate }) => Promise<{ file; duration; cached }>;
function needsResolve(raw: unknown): boolean;
function resolveScene(raw: unknown, registry: Registry, tts: Synthesize): Promise<{ scene; issues; synthesized }>;
```

Thứ tự: parse dialogue → chọn giọng (`line.voice` → `character.voice` → giọng đầu tiên) → TTS song song → `start` (số hoặc `after` + `gap`, theo thứ tự khai báo) → `actions[].sync` (`start = line.start + offset`, `duration = line.duration + pad − offset`) → `audio[].sync` (`at: start|end`) → `meta.duration "auto"` (bỏ qua camera; camera vượt quá bị cắt). Không sửa object đầu vào.

## 14.3. Piper TTS – `server/tts/piperTts.ts`

- Binary: `.venv/Scripts/piper.exe` (hoặc biến `PIPER_BIN`); model: `tools/tts-voices/<file>.onnx`.
- Gọi `piper -m model -i text.txt -f out.wav --length-scale 1/rate` với `PYTHONUTF8=1` (Windows đọc UTF-8 đúng), argument array, timeout 120s, tối đa 2 tiến trình song song.
- Cache: `public/assets/tts/<sha256(v, provider, model, speaker, rate, text NFC)[:24]>.wav` + `.json` ghi văn bản gốc. Độ dài đọc từ header WAV.
- **Tái lập:** Piper có nhiễu ngẫu nhiên → chỉ sinh một lần, các lần sau dùng cache.

## 14.4. Phụ đề – `src/engine/Subtitles.ts`

- `buildSrt(scene)` → `.srt` cạnh MP4 + track `mov_text` (ngôn ngữ `vie`) trong MP4.
- `burnIn: true`: `drawSubtitle(ctx2d, scene, t, w, h)` vẽ hộp nền mờ + chữ viền, tự xuống dòng (86% bề ngang).
  - Render page: ghép frame WebGL vào canvas 2D rồi vẽ phụ đề → PNG.
  - Editor: canvas phủ lên viewport, vẽ bằng cùng hàm → preview giống video.
- Font Nunito (OFL) đóng gói tại `public/assets/fonts/` → mọi máy render giống nhau.

## 14.5. Ducking – `computeDucking()` / `duckGainAt()` / `duckExpression()`

- Khoảng có thoại (voice segment), gộp nếu cách nhau < 2·`duckRamp`.
- `gain(t) = 1 − (1 − level) · max_i clip(min((t − (s_i − r))/r, ((e_i + r) − t)/r), 0, 1)`.
- FFmpeg: `volume=eval=frame:volume='<biểu thức trên>'` đặt sau `adelay` của track music (t = thời gian video).
- Preview: GainNode "music bus" lập lịch `linearRampToValueAtTime` tại các điểm gãy – cùng công thức. Test so khớp biểu thức FFmpeg với `duckGainAt` tại nhiều điểm.

## 14.6. Chuẩn hóa độ to – loudnorm 2 pass

1. Pass đo (chỉ audio): cùng filter graph + `loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json` → đọc JSON từ stderr.
2. Pass encode: `loudnorm=…:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=…:linear=true,aresample=48000`.
- Đo lỗi (audio im lặng…) → bỏ qua chuẩn hóa, dùng `alimiter`. `render.json` ghi `loudness.measuredI`.
- Preview không chuẩn hóa độ to (chỉ render).

## 14.7. Template – `src/template/template.ts`, `src/template/csv.ts` (thuần)

```typescript
TemplateSchema: { version: 1; id; name; params: Record<name, TemplateParam>; formats: Record<name, { width; height; overrides?; actions? }>; scene }
coerceParam(name, def, raw, registry?) → { value?, issue? }      // CSV luôn là chuỗi → ép kiểu
instantiate(template, row, index, registry?) → { rowId, values, scenes: Record<format, scene>, issues }
applyFormat(scene, format) · deepMerge(a, b) · parseCsv(text)
```

- Thay biến bằng duyệt cây JSON: chuỗi `"{{x}}"` → giá trị đúng kiểu (thiếu → xóa key), chuỗi có `{{x}}` → nội suy, phần tử mảng có `$if` → lọc.
- Scene sau instantiate là **Scene soạn thảo** → đi tiếp qua resolver (TTS) + validator như mọi scene khác.

## 14.8. Render job dùng chung – `cli/renderJob.ts`

```typescript
createRenderEnv({ browser? }) → { registry, tts, browser(), close() }   // 1 Vite server + 1 Chromium, mở khi cần
prepareScene(env, raw, { width?, height?, fps? }) → { input, scene, synthesized }   // resolve + validate, ném RenderFailure
renderScene(env, prepared, { projectId, output, crf?, keepFrames?, skipUnchanged?, isCancelled?, log? }) → { record, skipped }
writeFailureRecord(projectId, output, err)                            // render.json Failed khi lỗi trước khi render
```

- `renderScene` không ném lỗi: kết quả nằm trong `record.status`. Mỗi job một trang Chromium riêng, thư mục frame riêng.
- `record.sceneHash = sha256({ RENDER_VERSION, crf, scene })[:16]` → `skipUnchanged`.
- `cli/render.ts` (1 project) và `cli/batch.ts` (nhiều video) đều là lớp mỏng trên module này.

## 14.9. Batch CLI – `cli/batch.ts`

1. Đọc template (Zod) + dữ liệu (CSV/JSON); lọc `--only`.
2. Mỗi dòng: `instantiate` → lỗi dữ liệu thì ghi `Invalid`; ghi `projects/<template>-<id>/scene.json` (định dạng đầu tiên) + `project.json` (template, row, params) + `scene.resolved.json`.
3. `prepareScene` cho mọi dòng × định dạng **trước khi render** → lỗi phát hiện sớm, TTS chạy một lần.
4. `--dry-run` dừng ở đây (`Ready`). Ngược lại: pool `--concurrency` worker lấy job từ hàng đợi → `renderScene` → cập nhật `report.json` / `report.csv` sau mỗi job.

---

# 14b. Giao diện Thư viện (đã triển khai)

| Phần | File |
|---|---|
| Điều hướng (hash route `#/editor[/<project>]`, `#/videos`, `#/characters`, `#/batch`, `#/media`) | `src/App.tsx` |
| Video | `src/library/VideosTab.tsx` |
| Nhân vật / bối cảnh (thẻ + trình xem + sửa + import) | `src/library/CharactersTab.tsx`, `CharacterViewer.tsx`, `AssetThumb.tsx`, `modelPreview.ts` |
| Batch | `src/library/BatchTab.tsx` |
| Âm thanh, giọng đọc | `src/library/MediaTab.tsx` |
| API (Vite plugin) | `server/libraryApi.ts`, tiện ích thuần `server/libraryUtils.ts` |
| Import asset dùng chung CLI + UI | `server/assets/importAsset.ts` |

- **Ảnh thu nhỏ 3D** dùng 1 WebGL context chung, chụp tuần tự, chỉ khi thẻ hiện trên màn hình (IntersectionObserver) – tránh giới hạn số context của trình duyệt.
- **Trình xem nhân vật** dùng `AnimationMixer.update(delta)` + crossfade: chỉ để xem thử, KHÔNG dùng cho render (render vẫn tất định theo `evaluate(t)`).
- **An toàn file:** `safeResolve` chỉ cho truy cập `projects/` và `batches/` (chặn `..`, đường dẫn tuyệt đối, NUL); `/media` hỗ trợ HTTP Range để tua video; upload chỉ nhận `.glb/.gltf/.fbx`, tối đa 200 MB, bắt buộc tác giả + nguồn.
- **Batch từ UI:** 1 job tại một thời điểm, chạy `cli/batch.ts` như tiến trình con, log giữ 400 dòng cuối, hủy = kết thúc tiến trình. Dry-run ghi `report.dry-run.*` để không ghi đè báo cáo render thật.
- Sửa asset (PATCH) chỉ cho các trường hiển thị/chuẩn hóa: tên, chiều cao, xoay bù, license, tác giả, nguồn, defaultClip.

# 14c. AI kịch bản – prompt → duyệt → video (đã triển khai)

Luồng: **prompt → DeepSeek sinh kịch bản (nhiều ngôn ngữ) → người dùng xem/sửa/góp ý → XÁC NHẬN DUYỆT → dựng scene, TTS, kiểm tra, render** (mỗi ngôn ngữ chọn → 1 project + 1 video). Không bước nào sau "duyệt" chạy trước khi người dùng bấm duyệt.

- **Cấu hình:** `.env` (không commit): `DEEPSEEK_API_KEY`, tùy chọn `DEEPSEEK_MODEL` (mặc định `deepseek-v4-pro`), `DEEPSEEK_BASE_URL`.
- **`src/ai/story.ts` (thuần, dùng chung):** `StorySchema` – kịch bản dạng người đọc: bối cảnh, 1–5 nhân vật (asset + vai giọng `female|deep|low|child|squeaky` + tên theo ngôn ngữ), câu thoại (người nói hoặc `null` = dẫn chuyện, cử chỉ chuẩn, lời theo từng ngôn ngữ). `checkStory()` kiểm tra với Registry (id có thật, đủ bản dịch, không chọn cá).
- **`src/ai/buildScene.ts` (thuần, tất định):** Story + ngôn ngữ + khung (16x9/9x16) → Scene Script soạn thảo. AI **không** tính toạ độ/camera: nhân vật xếp vòng cung trong "sân khấu" của từng bối cảnh (`STAGES`: tâm, bề ngang lối đi, hướng đi vào, khoảng lùi camera tối đa), đi vào cảnh (`back` dọc lối đi / `sides` từ hai bên), camera toàn → cận người nói → toàn + cả nhóm nhảy ở câu cuối. Giọng `voice_<lang>_<vai>`.
- **`server/ai/deepseek.ts`:** Chat Completions ở chế độ JSON. **`server/ai/storyGenerator.ts`:** prompt hệ thống kèm danh mục nhân vật (cử chỉ làm được) + bối cảnh (mô tả từ `environments/*.layout.json`); lỗi `checkStory` được gửi lại cho AI sửa (tối đa 2 lần). `reviseStory()` sửa theo góp ý / thêm ngôn ngữ.
- **`server/aiApi.ts`:** `/api/ai/{status,story,revise,drafts,approve,job}`; bản nháp lưu `storage/ai/drafts/<id>.json`; job duyệt: dựng scene → resolve (Piper) → validate → ghi `projects/ai-<slug>-<id>-<lang>/{scene,story,project}.json` → `cli/render.ts`.
- **UI `src/library/AiTab.tsx`** (tab "✨ AI kịch bản").
- **Giọng đọc:** vi (vais1000), en (ljspeech, public domain), zh (huayan – giấy phép chưa rõ ⇒ `commercialUse: false`), fr (siwis, CC-BY-4.0), es (davefx, CC0); mỗi ngôn ngữ 5 vai bằng đổi cao độ, model trong `tools/tts-voices/`.

# 15. Testing

| Nhóm | Ca kiểm thử |
|---|---|
| time | 10s × 30fps = 300 frame; frame 3 = 0.1s |
| Movement | forward theo heading; left đổi hướng +90; moveTo đúng điểm cuối; path tốc độ đều; turn by; jump đỉnh tại p = 0.5; seek không phụ thuộc thứ tự gọi |
| Animation | clip đúng theo t; loop mod; crossfade weight tổng = 1; default clip khi trống |
| Camera | follow = target + offset; camera action ghi đè shot mặc định |
| Validation | scene demo VALID; `Flying` → AnimationNotFound; asset lạ → AssetNotFound; chồng move → ActionOverlap; quá duration → ActionOutOfRange |
| FFmpeg args | có `-start_number 1`, `yuv420p`, không có shell string |
| Audio | segment dài bằng file / loop tới cuối video / cắt ở cuối video / trimStart; fade in-out; vị trí file khi loop; validate AssetNotFound, AssetTypeMismatch, AudioOutOfRange, DuplicateId; filter FFmpeg: adelay ms, afade out, amix, apad; `-stream_loop` cho loop |
| Dialogue | `after` + gap; rate mặc định của giọng; sync action (offset/pad); audio sync `at:end`; duration auto bỏ qua camera + cắt camera; DialogueOrder / TargetNotFound / AssetNotFound / AssetTypeMismatch / TtsFailed; không sửa input; DialogueOverlap / DialogueOutOfRange |
| Subtitle / mix | SRT định dạng giờ; activeSubtitle; ducking gộp khoảng, giá trị tại điểm; **biểu thức FFmpeg khớp duckGainAt**; loudnorm 2 pass args; parse JSON loudnorm; track `mov_text`; đọc độ dài WAV |
| Template / CSV | CSV: ngoặc kép, dấu phẩy trong ô, `""`, xuống dòng trong ô, CRLF, BOM, `;`; ép kiểu + default + lỗi tham số; `{{x}}` đúng kiểu / nội suy / xóa key; `$if` và `!`; UnknownParam, UnusedColumn, InvalidRowId; deepMerge không sửa input; applyFormat + override action; **mọi dòng demo × mọi định dạng resolve + validate hợp lệ** |
| Asset | `buildAliases` khớp đúng trước, dự phòng sau; robot `walk → Walking`; **mọi nhân vật trong Registry: alias trỏ tới clip có thật và có `idle`**; validator nhận tên chuẩn, báo lỗi động tác nhân vật không có |
| Thư viện | `safeResolve` chặn thoát thư mục / đường dẫn tuyệt đối / thư mục khác / NUL; `parseRange` các dạng Range; SRT → VTT; `toCsv` ghi rồi đọc lại y nguyên |
| E2E | `npm run render -- projects/demo-robot-park` → MP4 tồn tại, ffprobe: đúng fps, số frame; `npm run batch -- templates/kids-lesson` → 6 MP4, chạy lại → 6 Skipped |

**Ghi chú tất định:** logic engine tất định tuyệt đối (unit test). Pixel giữa hai lần render có thể lệch cực nhỏ (đo được PSNR ≈ 84 dB trên SwiftShader do rasterize đa luồng) → so sánh E2E dùng PSNR ≥ 60 dB, không so md5.

---

# 16. Thứ tự triển khai

1. Khởi tạo project (Vite, React, TS strict, Three, Zustand, Zod, Vitest).
2. Schema + Registry + Validator + test.
3. Movement / Animation / Camera evaluate thuần + test.
4. Sinh demo asset (park, log) + registry.
5. AssetLoader + SceneEngine.
6. Editor: Viewport, Toolbar, Timeline, Scene JSON panel, lỗi validate, Save/Load.
7. Render page + Render CLI + FFmpeg → MP4 (**spike end-to-end**).
8. ✅ Audio: music / sfx / voice (file), preview Web Audio + trộn FFmpeg.
9. ✅ Lời thoại: TTS Piper (cache), sync, duration auto, phụ đề (srt / mov_text / burn-in), ducking, loudnorm −14 LUFS.
10. ✅ Template (tham số có kiểu, `$if`, override theo định dạng) + batch render song song, bỏ qua video không đổi, báo cáo.
11. Tiếp theo: batch server + hàng đợi bền vững (SQLite), thêm asset, adapter TTS thương mại.
12. Phase 2: AI Scene Generator, nhép miệng, overlay, editor kéo thả, undo/redo.

---

# 17. Definition of Done (Milestone 1–2)

```bash
npm install
npm run assets:generate
npm test
npm run dev                                  # preview demo trong trình duyệt
npm run render -- projects/demo-robot-park   # ra MP4
```

Không coi là xong nếu chỉ hiển thị được GLB, hoặc nếu MP4 không khớp preview.

---

# 18. Quy tắc cho Claude Code

1. Đọc `BRD.md` rồi `IMPLEMENTATION.md` trước khi sửa.
2. Không đổi kiến trúc khi chưa cần; thay đổi thì cập nhật tài liệu.
3. Không thêm dependency AI vào core engine.
4. Không hard-code nhân vật / animation / timeline trong engine.
5. Mọi logic theo thời gian phải là hàm của `t`.
6. Validate Scene Script trước khi load/render.
7. Viết test cho logic thuần.
8. Không `eval`, không thực thi code từ AI.
9. Log rõ ràng, lỗi có mã.
