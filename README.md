# AutoCartoon V3

Dây chuyền sản xuất video hoạt hình 3D từ **Scene Script (JSON)** → **MP4**.
Tài liệu: [BRD.md](BRD.md) · [IMPLEMENTATION.md](IMPLEMENTATION.md)

## Yêu cầu

- Node.js ≥ 20
- FFmpeg trong PATH (hoặc đặt biến `FFMPEG_PATH`)
- Chromium cho Playwright: `npx playwright install chromium` (hoặc dùng Edge/Chrome có sẵn: `--browser msedge`)
- Python ≥ 3.10 cho TTS tiếng Việt (Piper, offline)

## Bắt đầu

```bash
npm install
npx playwright install chromium
npm run assets:generate      # sinh park.glb, log.glb, âm thanh demo (đã có sẵn trong repo)

# TTS tiếng Việt (Piper, offline) – chỉ cần khi scene có lời thoại
python -m venv .venv
.venv/Scripts/pip install piper-tts          # macOS/Linux: .venv/bin/pip
mkdir -p tools/tts-voices && cd tools/tts-voices
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json
cd ../..
npm test                     # unit test engine + validator + ffmpeg args
npm run dev                  # Editor/Preview: http://localhost:5173
```

## Giao diện quản lý (`npm run dev` → http://localhost:5173)

| Trang | Làm được gì |
|---|---|
| ✎ **Editor** | Mở project, xem trước 3D + âm thanh + phụ đề, sửa Scene Script, lưu |
| 🎞 **Video** | Mọi video đã render (project + batch): lọc, phát ngay, phụ đề, tải MP4/SRT, mở thư mục, mở project để sửa, xóa |
| 🧍 **Nhân vật** | Ảnh 3D từng nhân vật, trình xem xoay/zoom, bấm thử từng động tác (dự phòng viền đứt), sửa tên / chiều cao / hướng / license, **kéo thả file để thêm nhân vật**, **✨ tạo nhân vật người bằng mô tả** |
| ▦ **Batch** | Chọn template, sửa bảng dữ liệu ngay trên trang (nhân vật chọn từ danh sách), Kiểm tra / Render (chọn dòng, định dạng, số luồng), tiến độ + log + kết quả |
| ♪ **Âm thanh & bối cảnh** | Nghe thử nhạc/hiệu ứng, nghe thử giọng đọc với câu tùy ý, xem & thêm bối cảnh/đạo cụ |

Server của giao diện chỉ chạy trên máy (localhost). Ảnh thu nhỏ video lưu tại `storage/thumbs/`.

## Render MP4 (không cần UI)

```bash
npm run render -- projects/demo-robot-park
npm run render -- projects/demo-robot-park --width 1080 --height 1920   # 9:16
npm run render -- projects/demo-robot-park --fps 24 --out out.mp4 --keep-frames
npm run render -- projects/demo-robot-park --renderer cpu                # ép render bằng CPU
```

**CPU hay GPU:** chọn bằng `--renderer auto | gpu | cpu` (dùng cho cả `render` và `batch`), hoặc biến môi trường `AC_RENDERER` (áp dụng cho cả video dựng từ giao diện / tab AI).
- `auto` (mặc định): dùng GPU nếu trình duyệt có WebGL chạy trên card đồ họa, không thì tự chuyển sang CPU.
- `gpu`: bắt buộc GPU, báo lỗi nếu không có.
- `cpu`: SwiftShader (render bằng phần mềm): chậm hơn nhưng chạy trên mọi máy, kể cả server không có card đồ họa.

Hai chế độ cho hình như nhau. Bộ render thực tế dùng được ghi trong dòng log `Render bằng …` và trường `gpu` của `.render.json`.

**Chất lượng:** chọn bằng `--quality auto | high | standard`, hoặc biến môi trường `AC_QUALITY`.
- `high`: có hậu kỳ, gồm bóng tiếp xúc (ambient occlusion), tone mapping, chỉnh màu và vignette.
- `standard`: render thẳng, không hậu kỳ. Ánh sáng thì vẫn như `high`.
- `auto` (mặc định): dùng `high` khi render bằng GPU, `standard` khi render bằng CPU.

Tốc độ đo trên Intel Iris Xe, video 1280×720:

| | GPU | CPU |
|---|---|---|
| high | ~18 frame/s | ~1,2 frame/s |
| standard | ~42 frame/s | ~7 frame/s |

## Hình ảnh, âm thanh, diễn xuất

- **Ánh sáng** (`environment.lighting`):
  - `preset`: `day`, `morning`, `sunset`, `overcast`, `snow` hoặc `night`.
  - Mặt trời lệch 35° so với camera chính, nên nhân vật được chiếu từ phía trước.
  - Có đèn phụ đi theo camera (mặt không bị tối) và đèn viền phía sau nhân vật.
  - `sunAzimuth` cố định hướng nắng; `ao: false` tắt bóng tiếp xúc.
- **Hiệu ứng hạt** (`environment.effects`): `snow`, `rain`, `leaves`, `petals`, `butterflies`, `fireflies`. Tất định, nên preview và video khớp nhau.
- **Camera:**
  - `blend`: số giây chuyển mượt từ góc máy trước.
  - `move`: chuyển động chậm trong suốt góc máy, gồm `dolly` (tỷ lệ đẩy vào), `pan` (độ xoay quanh điểm nhìn), `rise` (mét nâng lên).
- **Nói:**
  - Resolver tính envelope độ to của file TTS và lưu vào `dialogue[].lipsync`.
  - Người nói gật đầu và lắc nhẹ theo giọng. Nhân vật có xương hàm hoặc miệng thì mở miệng, nhân vật Kenney thì thân nhún co giãn.
  - Người nghe quay đầu về phía người nói.
- **Cảm xúc** (`dialogue[].emotion`): `happy`, `sad`, `surprised`, `angry`, `scared` hoặc `neutral`. Cảm xúc thể hiện qua tư thế khi nói (cúi đầu, ngả người, run, nhún) và tốc độ đọc (buồn thì chậm hơn, hào hứng thì nhanh hơn).
- **Âm thanh:**
  - Nhạc nền: `music_happy`, `music_calm`, `music_adventure`, `music_sad`, `music_magic`, `music_playful`.
  - Môi trường: `amb_birds`, `amb_wind`, `amb_water`, `amb_night`, `amb_park`.
  - Bước chân lặp: `sfx_steps_{grass,snow,wood,concrete}_loop`.
  - Hiệu ứng CC0 của Kenney: `sfx_pluck_*`, `sfx_cloth_*`, `sfx_drop_*`, `sfx_thud_*`…
  - Nhạc và âm thanh môi trường tự sinh bằng `npx tsx scripts/generate-audio-library.ts`. Thêm file âm thanh ngoài bằng `npm run audio:add`.
- **Bối cảnh mới:** `env_beach` (bãi biển), `env_garden` (vườn nhà), `env_clear_lake` (hồ nước trong).
- **AI tự dùng tất cả những thứ trên:**
  - `mood` của truyện và của từng cảnh chọn nhạc nền.
  - `time` của từng cảnh (`day`, `morning`, `sunset`, `night`) chọn ánh sáng, bầu trời và hiệu ứng. Ban đêm có đom đóm và tiếng dế.
  - `emotion` cho từng câu thoại.
  - `size` cho nhân vật: `big` cho bố mẹ cùng loài, `small` cho em bé.
  - Không trộn nhân vật Kenney khối vuông với Quaternius low-poly trong cùng một truyện.
- **Cache:** mỗi lần đổi engine, tăng `RENDER_VERSION` trong `cli/renderJob.ts` để các clip cảnh cũ được render lại.

Kết quả nằm ở `projects/<id>/renders/`:
- `<timestamp>.mp4`: H.264, yuv420p
- `<timestamp>.render.json`: trạng thái, số frame, GPU, lỗi
- `<timestamp>.srt`: phụ đề (khi có lời thoại); MP4 cũng chứa track phụ đề mềm
- `<timestamp>.ATTRIBUTIONS.txt`: ghi công asset
- `projects/<id>/scene.resolved.json`: bản đã resolve (TTS, sync, duration auto)

## Sản xuất hàng loạt (template + CSV)

```bash
npm run batch -- templates/kids-lesson                 # 3 dòng × 16:9 + 9:16 = 6 video
npm run batch -- templates/kids-lesson --dry-run       # chỉ kiểm tra dữ liệu + tạo giọng, không render
npm run batch -- templates/kids-lesson my.csv --formats 9x16 --concurrency 3 --only hoc-dem
```

- Sửa/thêm dòng trong [templates/kids-lesson/data.csv](templates/kids-lesson/data.csv) (mở bằng Excel được), chạy lại: chỉ video thay đổi được render lại.
- Kết quả: `batches/kids-lesson/videos/<id>_<format>.mp4` + `report.csv`.
- Mỗi dòng cũng thành project `projects/kids-lesson-<id>/` → mở trong Editor để duyệt trước khi đăng.
- Tạo template mới: xem [templates/kids-lesson/template.json](templates/kids-lesson/template.json) và BRD §14.

## Thư viện nhân vật

- **66 nhân vật** (robot, người chibi, người lớn, quái vật dễ thương, thú nông trại, khủng long, người ngoài hành tinh, sinh vật biển), **213 đạo cụ** (cây 4 mùa, đá, hoa, cỏ, bụi, xương rồng, công trình nông trại…), **7 bối cảnh** (công viên, rừng xanh, rừng thu, rừng tuyết, đồng hoa, nông trại, sa mạc) – tất cả CC0 (Quaternius + tự sinh). Xem trong Thư viện hoặc project **character-library**.
- Tải thêm gói: `scripts/fetch-drive.py`; nhập hàng loạt: xem `scripts/import-quaternius.sh`; ghép bối cảnh mới: `npm run env:compose -- environments/<tên>.layout.json`.
- Dùng **tên clip chuẩn** trong kịch bản (`idle`, `walk`, `run`, `jump`, `wave`, `yes`, `thumbsup`, `victory`, `dance`, …) → đổi nhân vật không phải sửa kịch bản.
- Thêm nhân vật mới (FBX / glTF / GLB):
  ```bash
  npm run asset:add -- path/Cat.fbx --id char_cat --name "Mèo" --height 0.6 --author "Tác giả" --source "<url>"
  ```
  Cần `tools/bin/FBX2glTF.exe` cho file FBX: https://github.com/facebookincubator/FBX2glTF/releases
- Chi tiết: BRD §6.6–6.8.

### Tạo nhân vật người bằng mô tả

Trang **🧍 Nhân vật** → **✨ Tạo bằng mô tả**:

1. Nhập mô tả, ví dụ "cô bé 7 tuổi tóc đuôi ngựa, váy hồng chấm bi, đeo ba lô vàng". Bấm **AI thiết kế**: DeepSeek điền bản thông số gồm tuổi, giới tính, dáng người, màu da, kiểu và màu tóc, áo, hoạ tiết, quần / váy, giày, phụ kiện, râu.
2. Chỉnh thông số trên form, hoặc gõ yêu cầu sửa bằng lời (ví dụ "áo màu cam, thêm kính râm").
3. Bấm **Dựng nhân vật 3D**. Blender dựng file GLB đã có sẵn:
   - khung xương người chuẩn,
   - khuôn mặt biểu cảm và nhép miệng theo lời thoại,
   - hoạt ảnh tự sinh, cộng thêm các hoạt ảnh Mixamo nếu có thư viện ở `D:/Mixamo`.

   Nhân vật tự vào thư viện với id `char_ac_gen_<tên>`. Có Mixamo thì mất khoảng 2 phút, không có thì vài giây.
4. Muốn sửa sau này: mở nhân vật trong thư viện → **✨ Sửa & dựng lại**. Bản mô tả được lưu ở `storage/characters/<id>/`.

Dùng không cần giao diện:

```bash
npm run character:gen -- "ông cụ hói, ria mép bạc, đeo kính, áo sơ mi trắng thắt cà vạt đỏ"
npm run character:gen -- "…" --design-only                 # chỉ in bản mô tả JSON
npm run character:gen -- --spec my.json [--id char_ac_gen_x] # dựng từ file mô tả (ghi đè nếu có --id)
npm run character:gen -- --spec docs/characters/be-ti-template.md  # dựng từ file mẫu nhân vật (.md – khối ```json đầu tiên)
```

Cần có:
- Blender ≥ 4.2: tự tìm trong `D:/Tools/blender-*` và `Program Files/Blender Foundation`, hoặc đặt `BLENDER_PATH` trong `.env`.
- `DEEPSEEK_API_KEY`: chỉ cần cho bước AI thiết kế; tự chỉnh từ mẫu trống thì không cần.
- Thư viện Mixamo (`MIXAMO_DIR`, mặc định `D:/Mixamo`): không bắt buộc, tải bằng `scripts/mixamo/download.ts`.

Kiểu có thể dựng:
- Chỉ nhân vật người, đầu to kiểu hoạt hình, từ em bé đến người già.
- Tóc: ngắn, vuốt dựng, xoăn, afro, bob, dài, đuôi ngựa, buộc hai bên, búi, hói.
- Áo: áo phông, sơ mi, dài tay, hoodie, ba lỗ, váy liền. Hoạ tiết: trơn, sọc, chấm bi, caro, hoa.
- Phụ kiện: kính, kính râm, mũ lưỡi trai, mũ len, mũ rộng vành, ba lô, dây chuyền, khuyên tai, đồng hồ, nơ, cà vạt, khăn quàng.

Nếu mô tả có thứ không dựng được (con vật, cánh, đồ hoá trang…), AI sẽ báo và dựng phiên bản gần nhất.

## Tạo video mới

1. Tạo thư mục `projects/<id>/` với `scene.json` (xem [projects/demo-robot-park/scene.json](projects/demo-robot-park/scene.json)).
2. Chỉ dùng asset và clip có trong [public/assets/registry.json](public/assets/registry.json). Validator sẽ chặn nếu dùng asset hoặc clip không có.
3. Xem trước trong Editor, sửa JSON (Ctrl+Enter để áp dụng, Ctrl+S để lưu).
4. Thêm âm thanh vào mảng `audio` (asset loại `audio` trong Registry): nhạc nền `loop`, hiệu ứng theo `start`, `volume`, `fadeIn`/`fadeOut`, `trimStart`.
5. Lời thoại: thêm `dialogue` (chỉ cần text; `start` có thể `{ "after": "<câu trước>" }`), cho action/âm thanh `sync` theo câu, đặt `meta.duration: "auto"`. Xem [projects/demo-robot-hello/scene.json](projects/demo-robot-hello/scene.json).
6. `npm run render -- projects/<id>`.

## Video nhiều khung cảnh (movie)

Đặt `movie.json` trong project. Khi có file này, `npm run render` sẽ render theo movie thay vì `scene.json`. Mỗi cảnh là một Scene Script đầy đủ, có bối cảnh, nhân vật, camera và lời thoại riêng. Xem [projects/demo-movie-journey/movie.json](projects/demo-movie-journey/movie.json).

```json
{
  "version": 1,
  "meta": { "name": "…", "fps": 30, "width": 1280, "height": 720 },
  "scenes": [
    { "id": "farm", "file": "scenes/01-farm.json" },
    { "id": "forest", "file": "scenes/02-forest.json", "transition": { "type": "fade", "duration": 0.8 } },
    { "id": "meadow", "file": "scenes/03-meadow.json", "transition": { "type": "dissolve", "duration": 1 } }
  ],
  "audio": [{ "id": "bgm", "kind": "music", "asset": "music_happy", "start": 0, "loop": true, "volume": 0.45 }],
  "subtitles": { "burnIn": true },
  "mix": { "duckMusic": true, "loudness": -14 }
}
```

- `transition` là cách chuyển **vào** cảnh đó: `cut` (cắt thẳng), `fade` (tối về đen rồi sáng lên), `dissolve` (hòa hai cảnh). Cảnh đầu tiên bỏ qua `transition`.
- Có thể viết scene trực tiếp trong movie bằng `"scene": { … }` thay cho `"file"`.
- Kích thước, fps và `subtitles` của movie ghi đè giá trị trong từng cảnh.
- `audio` của movie dùng thời gian tính trên cả phim (vd. nhạc nền chạy suốt). Âm thanh riêng của từng cảnh được dời theo mốc bắt đầu của cảnh và tự fade ở chỗ chuyển cảnh. `mix` (ducking, độ to) áp dụng cho cả phim.
- Mỗi cảnh được render thành clip riêng trong `renders/.clips/`. Cảnh không đổi sẽ dùng lại clip cũ, không render lại.
- **Chọn nhân vật cho AI:** trong tab AI, bấm **＋ Chọn nhân vật** để chọn tối đa 6 nhân vật (tìm theo tên, lọc theo phong cách), và đặt tên hoặc vai nếu muốn (vd. "Cáo mẹ"). Chọn cùng một model hai lần sẽ được hai nhân vật khác nhau. AI bắt buộc dùng đúng các nhân vật đã chọn. Không chọn thì AI tự chọn. Ở bước duyệt, có thể đổi model và giọng của từng nhân vật mà không cần sinh lại kịch bản.
- **Sinh bằng AI:** trong Thư viện → tab AI, chọn **Khung cảnh** (AI tự chọn hoặc 1–5 cảnh). AI sẽ chia truyện thành các cảnh, mỗi cảnh có bối cảnh và nhân vật có mặt riêng. Khi duyệt, bạn có thể đổi bối cảnh và kiểu chuyển cảnh của từng cảnh. Kịch bản nhiều cảnh tạo ra `movie.json` và `scenes/*.json`. Kịch bản một cảnh vẫn tạo `scene.json` như trước.

## Tương tác với đồ vật

Nhân vật có thể nhặt, cầm, mang đi, trao và đặt đồ vật xuống. Ví dụ: cáo con ngắt hoa rồi ngậm về tặng mẹ, hoặc các bạn nhặt rác bên ao. Xem [projects/demo-fox-flower/](projects/demo-fox-flower/movie.json).

- Đồ vật là một mục trong `props`. Thêm `"visible": false` nếu muốn nó ẩn lúc đầu.
- Các action tức thời, có hiệu lực từ `start`:

| Action | Ý nghĩa |
|---|---|
| `{ "type": "attach", "target": "<đồ vật>", "to": "<nhân vật>", "point": "auto" \| "hand" \| "mouth" }` | Đồ vật đi theo tay hoặc miệng nhân vật, kể cả khi nhân vật đang đi hay nhảy. Gắn sang nhân vật khác = trao tay. |
| `{ "type": "drop", "target": "<đồ vật>", "at"?: {x,y,z} }` | Đặt xuống: tại `at`, hoặc trước mặt người đang cầm. |
| `{ "type": "show" \| "hide", "target": "<đồ vật>" }` | Hiện hoặc ẩn đồ vật. |

- **Điểm cầm được dò tự động.** Tay: xương `Fist.R` / `Palm.R` / `Hand.R`… Miệng: xương `Mouth`, hoặc mõm trước xương `Head`. Nhân vật không có xương (Kenney) dùng mép trước của thân. Muốn chỉnh tay thì thêm `holdPoints` vào asset nhân vật trong registry.
- Kích thước đồ vật khi được cầm lấy từ `holdHeight` của asset. Đặt bằng lệnh `npm run asset:set` với dòng `prop_x holdHeight=0.3`.
- **AI:** kịch bản có thêm `objects` (đồ vật nằm ở cảnh nào, hoặc ai đang cầm sẵn). Mỗi câu thoại có thể có `action` là `pickup`, `give` hoặc `drop`, diễn ra ngay trước câu đó. Hệ thống tự đặt đồ vật cạnh nhóm nhân vật (hoa, nấm có cả bụi xung quanh) và tự sinh chuỗi động tác: đi tới → cúi nhặt → mang về, hoặc đi tới → trao → cảm ơn. Đồ đang cầm theo người cầm sang cảnh sau. Mỗi nhân vật chỉ cầm một món mỗi lúc. Danh sách đồ vật AI được dùng nằm trong [src/ai/objects.ts](src/ai/objects.ts).

## Quy ước tọa độ

- Trục Y hướng lên, đơn vị mét và giây. Mặt đất phẳng ở y = 0.
- `heading = 0` là nhìn về +Z; `heading` dương là quay sang trái.
- Hướng `forward/backward/left/right` tính tương đối theo hướng nhân vật.

## Trạng thái

| Hạng mục | Trạng thái |
|---|---|
| Milestone 1: engine `evaluate(t)`, GLB, animation + crossfade, move/moveTo/path/turn/jump, camera fixed/follow, preview, validate, save/load | ✅ |
| Milestone 2: render CLI Playwright + FFmpeg, 16:9 và 9:16, render.json, ATTRIBUTIONS | ✅ |
| Audio: nhạc nền / hiệu ứng / lời thoại (file), preview Web Audio + trộn FFmpeg | ✅ |
| Lời thoại: TTS tiếng Việt (Piper, cache), sync action/âm thanh theo câu, duration auto, phụ đề srt/mềm/burn-in, ducking, −14 LUFS | ✅ |
| Template (tham số có kiểu, `$if`, override 16:9 / 9:16) + batch render song song, bỏ qua video không đổi, báo cáo CSV | ✅ |
| Thư viện nhân vật Quaternius (14 người + 7 thú), tên clip chuẩn, `npm run asset:add` (FBX/glTF → GLB) | ✅ |
| Giao diện Thư viện: Video, Nhân vật (xem 3D, thử động tác, import kéo thả), Batch (sửa CSV, chạy, tiến độ), Âm thanh & bối cảnh | ✅ |
| Tiếp theo: Universal Animation Library (thêm động tác), thêm bối cảnh, adapter TTS thương mại, batch server | ⏳ |
| Phase 2: AI Scene Generator, nhép miệng, overlay chữ, editor kéo thả | ⏳ |
