# BRD – HỆ THỐNG SẢN XUẤT HÀNG LOẠT VIDEO HOẠT HÌNH 3D

**Version:** 2.0
**Ngày:** 25/09/2026
**Trạng thái:** Draft – đã chốt định hướng

> **Thay đổi so với v1.0**
> - Định hướng lại: từ "công cụ dựng phim 3D" → **dây chuyền sản xuất hàng loạt** video hoạt hình 3D đơn giản, có kiểm soát (kênh thiếu nhi, video giải thích, nội dung kịch bản lặp lại).
> - Thống nhất **một** định dạng Scene Script duy nhất (trước đây có 3 phiên bản mâu thuẫn).
> - Bổ sung: Render CLI không cần UI, Template, TTS + phụ đề, xuất 9:16, props (đạo cụ), action `turn` / `jump`.
> - Chốt kiến trúc render: **Chromium headless (Playwright) + FFmpeg**.
> - Chốt nguyên tắc: engine đánh giá theo **thời gian tuyệt đối** `evaluate(t)`, không cộng dồn theo delta.
> - Ưu tiên nhân vật **rig humanoid** để dùng chung thư viện animation.

---

# 1. Tổng quan

## 1.1. Mục tiêu

Xây dựng hệ thống nhận **Scene Script (JSON)** – do người viết, do template sinh ra, hoặc do AI sinh ra – và tự động xuất ra **video MP4 hoạt hình 3D**, trong đó nhân vật thực sự chuyển động trong không gian 3D.

Hệ thống phục vụ **sản xuất hàng loạt**: một kịch bản mẫu (template) + dữ liệu thay đổi (nhân vật, bối cảnh, lời thoại) → hàng chục/hàng trăm video.

## 1.2. Định vị sản phẩm

| Hệ thống này LÀ | Hệ thống này KHÔNG PHẢI |
|---|---|
| Dây chuyền lắp ghép asset 3D có sẵn theo kịch bản | AI sinh video từ pixel (Sora, Veo, Kling…) |
| Kết quả tất định, lặp lại được, sửa được từng chi tiết | "Gõ gì ra nấy" không giới hạn |
| Chi phí render gần như bằng 0 mỗi video | Chất lượng phim điện ảnh |

**Giới hạn cốt lõi:** hệ thống chỉ làm được những gì **thư viện asset** cho phép. Năng lực sản phẩm tỷ lệ thuận với số nhân vật × animation × bối cảnh × đạo cụ.

## 1.3. Công nghệ

- TypeScript, React, Vite, Zustand, Zod
- Three.js (WebGL2), GLB/glTF
- Playwright (Chromium headless) để render frame
- FFmpeg để encode MP4, trộn âm thanh, gắn phụ đề
- AI (tùy chọn) chỉ để sinh Scene Script JSON

---

# 2. Nhóm nội dung mục tiêu

| Loại | Đặc điểm | Yêu cầu nổi bật |
|---|---|---|
| Kênh thiếu nhi | Nhân vật dễ thương, hành động đơn giản, lặp lại | Giọng đọc, nhạc nền, biểu cảm, màu sắc tươi |
| Video giải thích | Nhân vật dẫn chuyện + chữ/biểu đồ | Phụ đề, overlay chữ, cử chỉ (chỉ tay, gật đầu, vẫy) |
| Nội dung kịch bản lặp lại | Cùng cấu trúc, khác nội dung | Template, batch render |

Tỷ lệ khung hình: **16:9** (YouTube) và **9:16** (Shorts/TikTok/Reels) từ cùng một Scene Script.

---

# 3. Phạm vi

## 3.1. MVP (Milestone 1–2)

1. Scene Script JSON thống nhất + validate bằng schema.
2. Asset Registry (nhân vật, bối cảnh, đạo cụ) có metadata + license.
3. Load nhân vật GLB humanoid có animation.
4. Load bối cảnh và đạo cụ GLB.
5. Timeline hành động: `animation`, `move`, `moveTo`, `path`, `turn`, `jump`, `camera`.
6. Crossfade giữa các animation.
7. Camera `fixed` và `follow`, cắt cảnh theo timeline.
8. Preview trên trình duyệt: Play / Pause / Stop / Seek / thời gian hiện tại.
9. Hiển thị lỗi validate rõ ràng.
10. Lưu / mở Scene Script của Project.
11. **Render CLI không cần UI**: `scene.json → MP4`.
12. Render tất định (fixed timestep), kết quả lặp lại được.
13. Demo project end-to-end.

## 3.2. MVP+ (Milestone 3–4) – điều kiện để sản xuất hàng loạt

1. ✅ Audio track: nhạc nền (loop), hiệu ứng, lời thoại từ file; volume, fade, trim; preview + trộn vào MP4.
2. ✅ **TTS tiếng Việt** cho lời thoại (offline, có cache); thời lượng action tự khớp độ dài câu thoại; nhạc nền tự giảm khi nói; chuẩn hóa độ to −14 LUFS.
3. ✅ **Phụ đề** tự sinh từ lời thoại: `.srt`, track phụ đề mềm trong MP4, tùy chọn in lên hình.
4. ✅ **Template có tham số** (nhân vật, giọng, màu, lời thoại, cử chỉ, câu tùy chọn `$if`…) + dữ liệu CSV/JSON.
5. ✅ **Batch render**: hàng đợi, nhiều luồng song song, bỏ qua video không đổi, báo cáo CSV.
6. ✅ Xuất **9:16** và **16:9**, có override camera / phụ đề riêng cho từng định dạng.
7. Asset Manager (upload, metadata, license).

## 3.3. Phase 2

- Nhép miệng cơ bản (theo biên độ âm thanh hoặc viseme).
- Biểu cảm khuôn mặt (morph target) trên timeline.
- Overlay 2D: tiêu đề, chữ, hình minh họa.
- Camera `path` / cinematic, chuyển cảnh.
- Nhiều scene (shot) trong một video.
- AI Scene Generator (prompt → Scene Script).
- Editor UI đầy đủ: kéo thả / resize action, Transform gizmo, Undo/Redo.

## 3.4. Phase 3

- AI Story Generator: chủ đề → kịch bản nhiều cảnh → Scene Script.
- Tự động chọn asset/animation từ Registry.
- Quy trình duyệt nội dung và xuất bản.

## 3.5. Out of scope

- Sinh nhân vật/animation mới bằng AI.
- Vật lý thời gian thực, va chạm phức tạp, chất lỏng, lửa, vải, tóc.
- Tương tác vật lý giữa các nhân vật (ôm, đánh nhau, trao đồ).
- Địa hình gồ ghề: **MVP giả định mặt đất phẳng tại `y = 0`**.

---

# 4. Ví dụ nghiệp vụ

Kịch bản:

> Chú robot đi bộ trong công viên. Sau 4 giây chạy nhanh hơn, nhảy qua một khúc gỗ rồi tiếp tục đi và vẫy tay chào.

Scene Script (định dạng chuẩn, xem chi tiết tại §9):

```json
{
  "version": 1,
  "meta": { "name": "Robot Park", "duration": 10, "fps": 30, "width": 1280, "height": 720 },
  "environment": { "asset": "env_park" },
  "characters": [
    { "id": "robot", "asset": "char_robot", "position": { "x": 0, "y": 0, "z": -8 }, "heading": 0 }
  ],
  "props": [
    { "id": "log", "asset": "prop_log", "position": { "x": 0, "y": 0, "z": 9 }, "heading": 90 }
  ],
  "camera": { "mode": "follow", "target": "robot", "offset": { "x": 4, "y": 2.5, "z": -5 } },
  "actions": [
    { "id": "a1", "type": "animation", "target": "robot", "start": 0, "duration": 4, "clip": "Walking" },
    { "id": "m1", "type": "move", "target": "robot", "start": 0, "duration": 4, "direction": "forward", "speed": 1.3 },
    { "id": "a2", "type": "animation", "target": "robot", "start": 4, "duration": 3, "clip": "Running" },
    { "id": "m2", "type": "move", "target": "robot", "start": 4, "duration": 3, "direction": "forward", "speed": 3.5 },
    { "id": "a3", "type": "animation", "target": "robot", "start": 7, "duration": 1, "clip": "Jump", "loop": false },
    { "id": "j1", "type": "jump", "target": "robot", "start": 7, "duration": 1, "height": 0.9 },
    { "id": "m3", "type": "move", "target": "robot", "start": 7, "duration": 1, "direction": "forward", "speed": 3 },
    { "id": "a4", "type": "animation", "target": "robot", "start": 8, "duration": 2, "clip": "Walking" }
  ]
}
```

Output: `robot_park.mp4`.

---

# 5. Kiến trúc tổng thể

```text
      Người vận hành / Template / AI (tùy chọn)
                       │
                       ▼
               Scene Script (JSON)  ◄── nguồn dữ liệu duy nhất
                       │
                       ▼
          Validator (Zod schema + Asset Registry)
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
   Editor / Preview             Render CLI / Worker
   (trình duyệt)                (Node.js)
         │                            │
         │                            ▼
         │                  Chromium headless (Playwright)
         │                            │
         └──────────┬─────────────────┘
                    ▼
       Scene Engine dùng chung (Three.js)
       evaluate(t): animation, movement, camera
                    │
                    ▼
            Frame PNG (render)
                    │
                    ▼
       FFmpeg (H.264 + audio + phụ đề)
                    │
                    ▼
                  MP4
```

**Quyết định kiến trúc quan trọng:** Node.js không có WebGL2, nên render phía server chạy **cùng một Scene Engine** trong Chromium headless. Preview và render dùng chung code → "preview thấy gì, video ra đúng như vậy".

---

# 6. Asset

## 6.1. Nguyên tắc thư viện asset

1. **Nhân vật ưu tiên rig humanoid chuẩn** để dùng chung animation (retarget Mixamo hoặc bộ animation nội bộ). Thú bốn chân chỉ dùng khi thật cần, vì mỗi loài cần bộ animation riêng.
2. **Cùng một phong cách mỹ thuật** trong một kênh (low-poly/stylized).
3. **Animation in-place** (không có root motion). Nếu clip có root motion, metadata phải đánh dấu để engine loại bỏ.
4. Mỗi asset có đủ **license, author, source**.

## 6.2. Loại asset

| Loại | Ví dụ | Ghi chú |
|---|---|---|
| `character` | robot, bé trai, bé gái, gấu | Có skeleton + clip animation |
| `environment` | công viên, lớp học, phòng ngủ | Mặt đất phẳng tại y = 0 |
| `prop` | khúc gỗ, bàn, quả bóng, bảng | Tĩnh trong MVP |
| `audio` | nhạc nền, SFX, voice (`.wav`, `.mp3`, `.ogg`) | ✅ Đã có |

## 6.3. Quy mô thư viện mục tiêu (để phục vụ đa số kịch bản)

- 10–20 nhân vật
- 30–50 animation dùng chung
- 8–12 bối cảnh
- 50–100 đạo cụ

## 6.4. Metadata asset

```json
{
  "id": "char_robot",
  "type": "character",
  "name": "Robot Expressive",
  "file": "characters/robot_expressive.glb",
  "height": 1.6,
  "headingOffset": 0,
  "defaultClip": "Idle",
  "clips": ["Idle", "Walking", "Running", "Jump", "Wave", "Yes", "No"],
  "suggestedSpeed": { "Walking": 1.3, "Running": 3.5 },
  "rootMotion": "none",
  "license": "CC0-1.0",
  "author": "Tomás Laulhé (Quaternius), sửa bởi Don McCurdy",
  "source": "https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive",
  "commercialUse": true,
  "attributionRequired": false
}
```

- `height`: engine tự scale model về chiều cao này (mét) để mọi nhân vật cùng tỷ lệ.
- `headingOffset`: bù hướng mặt nếu model không nhìn về +Z.
- `suggestedSpeed`: gợi ý tốc độ di chuyển khớp animation, dùng cho AI và template, tránh "trượt chân".

## 6.5. License

- Không cho phép `commercialUse: true` nếu license không cho phép thương mại (validator chặn).
- Asset cần ghi công → hệ thống sinh `ATTRIBUTIONS.txt` kèm mỗi video.
- Không dùng asset không rõ nguồn gốc.

---

## 6.6. Thư viện hiện có (25/09/2026) – 66 nhân vật · 213 đạo cụ · 7 bối cảnh (tất cả CC0)

| Nhóm | Asset | Gói nguồn |
|---|---|---|
| Robot | `char_robot` – 14 clip (Wave, Yes, No, ThumbsUp, Dance…), 3 biểu cảm mặt | Quaternius (three.js examples) |
| Người chibi (1.3 m) | 14 `char_q_*` – chung khung xương, 17 clip | Ultimate Animated Character |
| Người lớn (1.65–1.75 m) | 8 `char_h_*` (nam/nữ, nhiều trang phục) – 11 clip, có **Clapping**, Sitting, Standing | Animated Men / Women |
| Quái vật dễ thương | 21 `char_m_*` (gấu trúc, chim cánh cụt, hươu, gà, cua, ong, dơi, nấm, cây biết đi, rồng vàng, người tuyết…) – thường có Idle, Walk, Jump, **Dance, Yes, No**; loài bay có Flying | Cute Monsters |
| Thú nông trại | ngựa, bò, ngựa vằn (đi, chạy); heo, cừu, lạc đà, chó pug (đứng, nhảy) | Farm Animals |
| Khủng long | 6 `char_dino_*` (bạo chúa, ba sừng, cổ dài, phiến sừng, mỏ vịt, velociraptor) – Idle, Walk, Run, Jump, Attack, Death | Animated Dinosaurs |
| Người ngoài hành tinh | `char_alien`, `char_alien_helmet` – 14 clip (có Swimming, Clapping) | Animated Alien |
| Sinh vật biển | 7 `char_sea_*` (cá heo, cá mập, cá voi, cá đuối, 3 loại cá) – Swim | Animated Fish |
| Đạo cụ thiên nhiên | 199 món: 121 cây (thường, thông, bạch dương, liễu, cọ, phong – có bản **thu, tuyết, cây khô**), 24 đá, 15 bụi, 17 hoa, cỏ, cây cảnh, xương rồng, gốc cây/khúc gỗ, ngô, lúa mì | Ultimate Nature, Stylized Nature, Simple Nature |
| Công trình nông trại | 13 món: chuồng, kho, silo, cối xay gió, tháp nước, giếng, chuồng gà, hàng rào | Farm Buildings |
| **Bối cảnh ghép sẵn** | `env_park`, `env_forest` (rừng xanh), `env_autumn_forest` (rừng thu), `env_snow_forest` (rừng tuyết), `env_meadow` (đồng hoa), `env_farm` (nông trại), `env_desert` (sa mạc) – đều có lối đi dọc trục Z tại x = 0 | ghép bằng `npm run env:compose` |

Xem trước: Thư viện → tab Nhân vật / Âm thanh & bối cảnh (lọc theo nhãn, gói); project `character-library` đặt toàn bộ nhân vật trong một cảnh.

**Hạn chế đã biết:**
- Nhiều nhóm không có Wave / ThumbsUp → dùng **clip dự phòng** (ưu tiên Clapping, rồi Victory); `yes`/`no` dự phòng → Idle. Trình xem nhân vật đánh dấu viền đứt.
- Heo, cừu, lạc đà, chó pug (Farm Animals) chỉ đứng / nhảy; muốn đi lại dùng `char_m_pig`, `char_m_chicken`… (Cute Monsters có Walk).
- Chưa có bối cảnh nước cho sinh vật biển.
- Stylized Nature MEGAKIT, Universal Animation Library chỉ có trên itch.io – cần tải tay rồi import.

## 6.6b. Tải & nhập gói mới

```bash
# 1. Tải có chọn lọc từ thư mục Google Drive công khai (song song, bỏ qua file đã có)
.venv/Scripts/python scripts/fetch-drive.py <url thư mục Drive> tools/quaternius/<gói> FBX/ "*"
# 2. Nhập (xem mẫu theo nhóm + hệ số tỷ lệ trong scripts/import-quaternius.sh)
npm run asset:add -- tools/quaternius/<gói>/FBX/*.fbx --type prop --prefix prop_x_ --scale 1.2 --pack "…" --author … --source …
# 3. Ghép bối cảnh từ đạo cụ
npm run env:compose -- environments/forest.layout.json
```

- **Đạo cụ giữ tỷ lệ tương đối** bằng `scale` theo nhóm (cây ×2.2, đá ×1.2, hoa/cỏ ×0.5 …) thay vì ép cùng chiều cao; nhân vật dùng `height` (m).
- **Texture tự nén** khi import: tối đa 1024 px, WebP (gói Stylized Nature giảm từ 436 MB → ~15 MB).
- **Nhãn** (tree, rock, flower, bush, grass, cactus, wood, building, crop, dinosaur, sea, monster, human…) tự đoán từ tên file, thêm bằng `--tags`; **gói** (`--pack`) để lọc.

## 6.6c. Ghép bối cảnh – `npm run env:compose -- <layout.json>`

Layout (xem `environments/*.layout.json`): nền (`ground`), lối đi (`path`), đặt cố định (`place`), xếp lưới (`grid` – luống ngô, hàng rào), rải ngẫu nhiên có seed (`scatter` – theo nhãn / gói / include / exclude, tránh lối đi `clearPath`, khoảng cách tối thiểu, tỷ lệ ngẫu nhiên). Kết quả là **một GLB** (các lượt đặt cùng mẫu dùng chung mesh → 134–576 đạo cụ chỉ 1.5–4.4 MB) + mục Registry `type: environment`. Cùng layout + seed → cùng bối cảnh.

## 6.7. Tên clip chuẩn (`clipAliases`)

Template / AI dùng **tên chuẩn** thay vì tên riêng của từng model:

`idle, walk, run, jump, wave, yes, no, thumbsup, dance, victory, defeat, sit, stand, punch, hit, death, pickup, roll`

Mỗi nhân vật khai báo `clipAliases` (tên chuẩn → clip thật). Robot: `walk → Walking`; nhân vật Quaternius: `walk → Walk`, `wave → Victory` (dự phòng). Nhờ vậy **đổi nhân vật trong CSV không phải sửa template**; nếu nhân vật thiếu động tác, validator báo lỗi ngay cho dòng đó.

## 6.8. Thêm asset mới – `npm run asset:add`

```bash
npm run asset:add -- Cat.fbx --id char_cat --name "Mèo" --height 0.6 --author "Tác giả" --source "<url>"
npm run asset:add -- a.gltf b.gltf c.gltf --prefix char_q_ --height 1.3 --author "Quaternius" --source "<url>"
npm run asset:add -- Table.glb --type prop --id prop_table --height 0.8 --author "..." --source "..." --dry-run
```

Tự động: FBX → GLB (FBX2glTF), glTF → GLB, bỏ tiền tố tên clip (`Armature|Walk` → `Walk`), dọn dữ liệu thừa, liệt kê clip, chọn `defaultClip`, sinh `clipAliases` (in ra các clip dự phòng), ghi file vào `public/assets/<loại>/` và cập nhật Registry. `--license` mặc định `CC0-1.0`; license khác → tự bật `attributionRequired`.

Sau khi thêm: mở project `character-library` (thêm nhân vật vào scene) để kiểm tra cỡ và hướng; nếu model nhìn sai hướng, chạy lại với `--heading-offset 90|180|-90`.

---

# 7. Hệ tọa độ và quy ước

| Quy ước | Giá trị |
|---|---|
| Trục đứng | +Y |
| Đơn vị | mét, giây |
| Mặt đất | y = 0 (MVP) |
| `heading = 0` | nhân vật nhìn về **+Z** |
| `heading` dương | quay **sang trái** (ngược chiều kim đồng hồ khi nhìn từ trên xuống), đơn vị độ |
| `forward/backward/left/right` | **tương đối theo hướng nhân vật** tại thời điểm bắt đầu action |

---

# 8. Hệ thống chuyển động

## 8.1. Animation và Movement tách biệt

- Animation (`Walking`) chỉ là tư thế khung xương.
- Movement (`move`) mới thay đổi vị trí.
- Cho phép: đi bộ tại chỗ (Walking + không move), trượt (Idle + move).
- Template/AI nên dùng `suggestedSpeed` để khớp chân.

## 8.2. Loại action

| Action | Ý nghĩa | Tham số |
|---|---|---|
| `animation` | Phát clip | `clip`, `loop` (mặc định true), `speed` (1), `fade` (0.25s) |
| `move` | Đi theo hướng tương đối | `direction`, `speed` (m/s), `face` |
| `moveTo` | Đi thẳng tới điểm | `to {x,z}`, `face` |
| `path` | Đi qua các điểm (tuyến tính, tốc độ đều) | `points [{x,z}]`, `face` |
| `turn` | Quay người | `heading` (tuyệt đối) **hoặc** `by` (tương đối) |
| `jump` | Nảy lên theo trục Y (parabol) | `height` |
| `camera` | Đổi shot camera | `shot` |

Quy tắc:
- Các action thuộc nhóm **vị trí/hướng** (`move`, `moveTo`, `path`, `turn`) của cùng một nhân vật **không được chồng thời gian**.
- `jump` chỉ tác động trục Y nên **được** chồng với `move`.
- `animation` của cùng nhân vật không được chồng nhau. Khoảng trống giữa các animation → phát `defaultClip`.
- Camera action không được chồng nhau. Ngoài camera action → dùng `camera` mặc định của scene.

## 8.3. Camera

| Mode | Mô tả |
|---|---|
| `fixed` | `position`, `lookAt`, `fov` |
| `follow` | bám `target` với `offset`; `relative: true` thì offset xoay theo hướng nhân vật; `lookAtOffset` |
| `path` | Phase 2 |

---

# 9. Scene Script – định dạng chuẩn (version 1)

```text
SceneScript
├── version: 1
├── meta: name, duration, fps, width, height
├── environment: asset, background?, fog?
├── characters[]: id, asset, position, heading, scale
├── props[]: id, asset, position, heading, scale
├── camera: CameraShot (mặc định)
├── actions[]: Action (discriminated union theo "type")
└── audio[]: track nhạc nền / SFX / voice
```

Nguyên tắc:
- Scene Script là **nguồn dữ liệu duy nhất** để preview và render.
- Mọi Scene Script phải **validate thành công** trước khi load/render.
- Mỗi action có `id` duy nhất.
- `start + duration ≤ meta.duration`.

---

# 10. Validation

Validator kiểm tra và trả **danh sách lỗi có mã**:

| Mã lỗi | Ví dụ |
|---|---|
| `InvalidSchema` | thiếu trường, sai kiểu |
| `AssetNotFound` | `asset: "char_dragon"` không có trong Registry |
| `AssetTypeMismatch` | dùng asset `prop` làm character |
| `AnimationNotFound` | `clip: "Flying"` không có trong `char_robot` |
| `AudioOutOfRange` | audio bắt đầu sau khi video kết thúc, hoặc `trimStart` vượt độ dài file |
| `DialogueOutOfRange` | câu thoại kết thúc sau video (gợi ý dùng `duration: "auto"`) |
| `DialogueOverlap` | hai câu của cùng một người nói chồng thời gian |
| `DialogueOrder` | `start.after` trỏ tới câu không có hoặc khai báo sau |
| `TtsFailed` | engine TTS lỗi / thiếu model giọng |
| `TargetNotFound` | action trỏ tới nhân vật không tồn tại |
| `DuplicateId` | trùng id |
| `ActionOutOfRange` | action kéo dài quá `meta.duration` |
| `ActionOverlap` | hai action vị trí chồng thời gian |
| `LicenseViolation` | asset không cho phép thương mại nhưng project đánh dấu thương mại |

Không render khi còn lỗi.

---

# 11. Preview (Editor)

- Viewport 3D, OrbitControls khi không phát.
- Toolbar: chọn project, Play / Pause / Stop, thời gian `00:03.250 / 00:10.000`, FPS preview.
- Timeline hiển thị các track: từng nhân vật (animation / movement) và camera; click để seek.
- Bảng Scene Script: sửa JSON → Apply (validate) → Save.
- Bảng lỗi validate.

Preview **không** dùng để tạo video cuối cùng.

---

# 12. Render

## 12.1. Render CLI (MVP)

```bash
npm run render -- projects/demo-robot-park
npm run render -- projects/demo-robot-park --width 1080 --height 1920
```

- Không cần UI, chạy được trong script / cron / CI.
- Tham số: `--width`, `--height`, `--fps`, `--out`, `--keep-frames`, `--browser`.
- Output mặc định: `projects/<id>/renders/<timestamp>.mp4` + `render.json` (trạng thái, thời gian, lỗi).

## 12.2. Quy trình

```text
scene.json → validate → Chromium headless → seek(frame / fps) → PNG
→ frame_000001.png … → FFmpeg (libx264, yuv420p) → MP4
```

## 12.3. Trạng thái render job

`Pending → Processing → Completed | Failed | Cancelled`, kèm `progress`, `currentFrame`, `totalFrames`, `error`.

## 12.4. Batch render (đã triển khai – xem §14.3)

- Hàng đợi job, N worker song song (mỗi worker một trang Chromium).
- Một job lỗi không ảnh hưởng job khác.

---

# 13. Âm thanh, giọng đọc, phụ đề

## 13.1. Audio track (đã triển khai)

```json
"audio": [
  { "id": "bgm", "kind": "music", "asset": "music_happy", "start": 0, "loop": true, "volume": 0.45, "fadeIn": 0.3, "fadeOut": 1.5 },
  { "id": "sfx_jump", "kind": "sfx", "asset": "sfx_boing", "start": 7.0, "volume": 0.9 }
]
```

| Trường | Ý nghĩa | Mặc định |
|---|---|---|
| `kind` | `music` / `sfx` / `voice` | – |
| `asset` | asset loại `audio` trong Registry (có `duration`) | – |
| `start` | thời điểm bắt đầu trong video (giây) | – |
| `duration` | độ dài phát; bỏ trống = hết file (loop: tới cuối video) | – |
| `trimStart` | bỏ qua đoạn đầu file | 0 |
| `volume` | 0–4 | 1 |
| `loop` | lặp | false |
| `fadeIn` / `fadeOut` | giây | 0 |

- Preview phát audio đồng bộ timeline (Play / Pause / Seek), có nút tắt tiếng.
- Render trộn tất cả track vào MP4 (AAC 48 kHz stereo); audio luôn dài đúng bằng video.
- Lỗi: `AssetNotFound`, `AssetTypeMismatch`, `AudioOutOfRange`.

## 13.2. Lời thoại, TTS, phụ đề (đã triển khai)

Người vận hành chỉ viết **câu thoại**; hệ thống tự tính thời điểm:

```json
"meta": { "duration": "auto", "tail": 1.5, ... },
"dialogue": [
  { "id": "l1", "speaker": "robot", "text": "Xin chào các bạn nhỏ!", "start": 0.6 },
  { "id": "l2", "speaker": "robot", "text": "Hôm nay mình cùng học đếm nhé.", "start": { "after": "l1", "gap": 0.5 } }
],
"actions": [
  { "id": "wave", "type": "animation", "target": "robot", "clip": "Wave", "sync": { "line": "l1", "offset": -0.3, "pad": 0.2 } }
],
"audio": [
  { "id": "ding", "kind": "sfx", "asset": "sfx_chime", "sync": { "line": "l2", "at": "end", "offset": 0.1 } }
],
"subtitles": { "burnIn": true, "size": 0.055, "position": "bottom", "showSpeaker": false },
"mix": { "duckMusic": true, "duckLevel": 0.3, "duckRamp": 0.25, "loudness": -14 }
```

| Tính năng | Mô tả |
|---|---|
| `dialogue[].start` | số giây, hoặc `{ "after": "<id câu trước>", "gap": 0.3 }` |
| Giọng đọc | `dialogue[].voice` → `characters[].voice` → giọng đầu tiên trong Registry; `rate` (mặc định theo giọng) |
| `actions[].sync` | `{ line, offset, pad }` → action bắt đầu/kéo dài theo câu thoại |
| `audio[].sync` | `{ line, at: "start" \| "end", offset }` → hiệu ứng đúng lúc bắt đầu/kết thúc câu |
| `meta.duration: "auto"` | = lời thoại/action/audio kết thúc muộn nhất + `meta.tail`; camera không tính (camera vượt quá được cắt ở cuối) |
| Phụ đề | luôn tạo `.srt` + track phụ đề mềm trong MP4; `burnIn: true` → in lên hình (preview và video giống nhau, font Nunito đóng gói sẵn) |
| Ducking | nhạc nền giảm còn `duckLevel` khi có thoại, chuyển mượt trong `duckRamp` giây; câu gần nhau được gộp |
| Độ to | loudnorm 2 pass về `mix.loudness` LUFS (mặc định −14, chuẩn YouTube); `null` = tắt |

Quy trình:

```text
scene.json (soạn thảo) → Resolve: TTS từng câu (cache) → start / sync / duration auto
→ scene.resolved.json (lưu lại để tái lập) → Validate → Preview / Render
```

- **TTS mặc định: Piper (offline, miễn phí)**, giọng `voice_vi_female` (Piper vais1000, dữ liệu CC-BY-4.0 → cần ghi công, đã có trong `ATTRIBUTIONS.txt`).
- **Tái lập:** Piper không tất định, nên mỗi câu được cache theo hash(text + giọng + tốc độ); render lại dùng đúng file cũ.
- **Provider thay thế được** (Azure / Google / FPT.AI / Viettel AI…): thêm adapter cùng interface `Synthesize`. Với sản phẩm thương mại nên dùng dịch vụ TTS có hợp đồng license rõ ràng và giọng tự nhiên hơn.
- Lỗi: `TtsFailed`, `DialogueOrder`, `DialogueOverlap`, `DialogueOutOfRange`, `TargetNotFound` (speaker / sync).

---

# 14. Template và sản xuất hàng loạt (đã triển khai)

## 14.1. Template

`templates/<id>/template.json`:

```json
{
  "version": 1,
  "id": "kids-lesson",
  "name": "Bài học thiếu nhi",
  "params": {
    "title":     { "type": "string", "maxLength": 80 },
    "character": { "type": "asset", "assetType": "character", "default": "char_robot" },
    "sky":       { "type": "color", "default": "#a8d8f0" },
    "line_4":    { "type": "string", "required": false },
    "gesture_2": { "type": "string", "enum": ["Yes", "No", "Wave", "ThumbsUp", "Idle"], "default": "Yes" },
    "music_volume": { "type": "number", "min": 0, "max": 1.5, "default": 0.5 }
  },
  "formats": {
    "16x9": { "width": 1280, "height": 720 },
    "9x16": { "width": 1080, "height": 1920,
              "overrides": { "camera": { "fov": 55 }, "subtitles": { "size": 0.032 } },
              "actions": { "cam_close": { "shot": { "fov": 50 } } } }
  },
  "scene": { "...": "Scene Script soạn thảo có {{title}}, {{sky}}…" }
}
```

| Cú pháp | Ý nghĩa |
|---|---|
| `"{{name}}"` (cả chuỗi) | thay bằng giá trị **đúng kiểu** (số, bool, chuỗi); tham số tùy chọn không có giá trị → xóa key |
| `"Chào {{name}}!"` | nội suy chuỗi |
| `{ "$if": "line_4", ... }` | phần tử mảng chỉ giữ khi tham số có giá trị; `"!line_4"` = khi không có |
| `formats.<f>.overrides` | deep-merge vào scene (object gộp, mảng thay thế) |
| `formats.<f>.actions.<id>` | deep-merge vào action có id đó (vd. shot camera cho khung dọc) |

Kiểu tham số: `string` (maxLength, enum), `number` (min, max; nhận cả `0,5`), `boolean` (true/1/có/yes…), `color` (#rrggbb), `asset` (kiểm tra có trong Registry + đúng `assetType`).
Template chỉ **thay giá trị** trên JSON đã parse – không thực thi code.

## 14.2. Dữ liệu

`data.csv` (UTF-8, có thể có BOM của Excel; dấu phân cách `,` `;` hoặc tab tự nhận) hoặc `data.json` (mảng object). Mỗi dòng một video, cột = tên tham số, cột `id` (chữ thường, số, `-`, `_`) đặt tên video/project.

```csv
id,title,greeting,line_2,line_3,line_4,gesture_2,gesture_3,sky
hoc-dem,Học đếm đến ba,Xin chào các bạn nhỏ!,Hôm nay mình cùng học đếm nhé.,"Một, hai, ba!",,Yes,ThumbsUp,#a8d8f0
```

Lỗi dữ liệu: `MissingParam`, `InvalidParam`, `UnknownParam`, `InvalidRowId` (+ trùng id); cột thừa → cảnh báo `UnusedColumn`.

## 14.3. Batch render

```bash
npm run batch -- templates/kids-lesson                          # data.csv trong thư mục template
npm run batch -- templates/kids-lesson other.csv --formats 9x16 --concurrency 3
npm run batch -- templates/kids-lesson --only hoc-dem,mau-sac --dry-run
npm run batch -- templates/kids-lesson --force                  # render lại cả video không đổi
```

Quy trình:

```text
dữ liệu → instantiate từng dòng × định dạng → projects/<template>-<id>/ (mở được trong Editor để duyệt)
→ resolve (TTS có cache) + validate TẤT CẢ trước → hàng đợi render N luồng (1 Chromium dùng chung)
→ batches/<template>/videos/<id>_<format>.mp4 (+ .srt, .render.json, .ATTRIBUTIONS.txt)
→ batches/<template>/report.csv + report.json
```

- Dòng lỗi không chặn các dòng khác; mã thoát ≠ 0 nếu có lỗi.
- **Bỏ qua video không đổi:** hash(scene đã resolve + thông số) trùng với lần render thành công trước → `Skipped`. Sửa 1 dòng trong CSV chỉ render lại đúng video đó.
- Ctrl+C: dừng sau frame hiện tại, trạng thái `Cancelled`.
- Báo cáo CSV có BOM để Excel đọc đúng tiếng Việt: `row, format, status, duration, output, project, elapsedSeconds, error`.
- Trạng thái job: `Ready` (dry-run), `Completed`, `Skipped`, `Invalid`, `Failed`, `Cancelled`.

---

# 15. AI Scene Generator (Phase 2)

- AI chỉ sinh **JSON theo schema**, không sinh code.
- Prompt cho AI được bơm danh sách asset + clip + `suggestedSpeed` từ Registry.
- Output AI đi qua **cùng Validator**; lỗi → phản hồi lại AI tự sửa (tối đa N lần) hoặc báo người vận hành.
- AI không phải dependency của core engine.

---

# 16. Project

```text
projects/<project-id>/
├── scene.json        ← Scene Script (nguồn dữ liệu duy nhất)
├── project.json      ← metadata: tên, mô tả, commercial, template gốc…
├── scene.resolved.json ← bản đã resolve (TTS, sync, duration auto) – do render sinh ra
└── renders/
    ├── <timestamp>.mp4             ← H.264 + AAC + phụ đề mềm
    ├── <timestamp>.srt
    ├── <timestamp>.ATTRIBUTIONS.txt
    └── <timestamp>.render.json

public/assets/tts/<hash>.wav ← cache TTS dùng chung mọi project
```

- Filesystem là nơi lưu chính trong MVP. Database (SQLite → PostgreSQL) chỉ lưu **index/job** ở giai đoạn batch, không nhân đôi nội dung `scene.json`.
- Render không bao giờ ghi đè `scene.json`; render lỗi không làm mất project.

---

# 17. Yêu cầu phi chức năng

| Hạng mục | Yêu cầu |
|---|---|
| Preview | ≥ 30 FPS với scene đơn giản |
| Render | Không cần realtime; 10 giây video 720p nên xong trong vài phút trên máy không GPU rời |
| Tất định | Cùng Scene Script + asset + thông số render → cùng kết quả (có thể khác nhẹ giữa các GPU/driver) |
| Ổn định | Render lỗi không làm mất project; lỗi có mã và log rõ ràng |
| Bảo mật | Không `eval`, không thực thi code từ AI/template; FFmpeg gọi bằng argument array |
| Bộ nhớ | Giải phóng geometry/material/texture/mixer/renderer khi đổi project |

---

# 18. Chính sách nền tảng (rủi ro kinh doanh)

- YouTube hạn chế kiếm tiền với nội dung **sản xuất hàng loạt, lặp lại, ít giá trị gia tăng**. Template dùng để **giảm chi phí sản xuất**, mỗi video vẫn phải có nội dung khác biệt thực sự.
- Nội dung trẻ em phải tuân thủ quy định "Made for Kids" / COPPA.
- Dây chuyền phải có **bước người duyệt** trước khi xuất bản.

---

# 19. Acceptance Criteria

## Milestone 1 – Preview
1. `npm install && npm run dev` chạy được.
2. Load Scene Script demo, validate thành công.
3. Nhân vật GLB + bối cảnh + đạo cụ hiển thị.
4. Timeline điều khiển animation (có crossfade), movement, turn, jump.
5. Camera follow bám nhân vật; camera action cắt shot.
6. Play / Pause / Stop / Seek hoạt động; seek tới thời điểm bất kỳ cho đúng trạng thái.
7. Scene Script sai → hiển thị lỗi có mã, không load.
8. Save / Load Scene Script.

## Milestone 2 – Render
9. `npm run render -- projects/<id>` tạo MP4 H.264 đúng thời lượng và FPS.
10. Số frame = `duration × fps`.
11. Render hai lần cùng Scene Script → video tương đương.
12. Render 9:16 từ cùng Scene Script.
13. Render lỗi → `render.json` trạng thái `Failed` + lý do; project không bị ảnh hưởng.

## Milestone 3–4 – Sản xuất hàng loạt
14. ✅ Nhạc nền + hiệu ứng có trong MP4, khớp thời điểm với preview.
15. ✅ Lời thoại → TTS → audio + phụ đề trong MP4; action khớp câu thoại; ducking; −14 LUFS.
16. ✅ Template + file dữ liệu → N video (mỗi dòng một project duyệt được trong Editor).
17. ✅ Batch render song song, bỏ qua video không đổi, báo cáo CSV/JSON.

---

# 20. Lộ trình (ước lượng 1 dev)

| Tuần | Nội dung |
|---|---|
| 1–3 | Engine `evaluate(t)`, GLB humanoid, animation, movement, camera, preview (Milestone 1) |
| 4 | Render CLI Playwright + FFmpeg (Milestone 2) |
| 5–6 | Audio, TTS tiếng Việt, phụ đề, khớp thời lượng theo audio |
| 7–8 | Template, batch render, 9:16 |
| Sau đó | AI Scene Generator, nhép miệng, overlay chữ, editor đầy đủ |
