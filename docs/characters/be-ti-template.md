# Mẫu nhân vật: Bé Tí (cấu hình gốc)

Dùng file này để dựng một nhân vật trẻ em hoạt hình 3D cùng dáng, cùng chất lượng với **Bé Tí – Base** / **Bé Tí**
(chốt ngày 02/10/2026, sau 5 vòng chỉnh). Chỉ cần sửa khối JSON bên dưới rồi chạy một lệnh.

## Dựng nhanh

```bash
# 1. Sao chép file này, đổi "name" (và quần áo / màu nếu muốn) trong khối json đầu tiên
# 2. Dựng – lệnh tự đọc khối ```json ĐẦU TIÊN trong file .md
npm run character:gen -- --spec docs/characters/be-ti-template.md
# dựng lại / ghi đè một nhân vật có sẵn:
npm run character:gen -- --spec docs/characters/be-ti-template.md --id char_ac_gen_<ten>
```

- Không có `--id` → tạo nhân vật mới (id lấy theo `name`). Có `--id` của nhân vật cũ → **ghi đè** GLB + ảnh xem trước.
- Kết quả: `public/assets/characters/<id>.glb` (xương, 54 động tác Mixamo, biểu cảm mặt, khẩu hình), ảnh xem trước
  ở `storage/characters/<id>/preview.png` + `preview_face.png`, tự thêm vào thư viện (`public/assets/registry.json`).
- Thời gian: ~10–15 phút (Mixamo chiếm phần lớn). Cần Blender (`BLENDER_PATH` trong `.env` hoặc `D:/Tools/blender-*`)
  và thư viện Mixamo (`D:/Mixamo`, xem `scripts/mixamo/`).

## Bản mô tả (spec)

Nhân vật gốc – không mặc đồ, chân trần (= Bé Tí – Base):

```json
{
  "spec": {
    "name": "Bé Tí – Base",
    "gender": "male",
    "age": "child",
    "build": "chubby",
    "proportions": "base",
    "skin": "#f5c5b4",
    "eyes": "#5d3a1a",
    "hair": { "style": "curly", "color": "#6b4226" },
    "top": { "style": "none", "color": "#ffffff", "pattern": "none", "patternColor": "#1e88e5" },
    "bottom": { "style": "none", "color": "#e53935" },
    "shoes": { "style": "barefoot", "color": "#ffffff", "accent": "#e53935" },
    "accessories": [],
    "accessoryColor": "#fbc02d",
    "facialHair": "none",
    "face": {
      "shape": "round",
      "eyes": "big",
      "brows": "normal",
      "nose": "normal",
      "mouth": "wide",
      "ears": "big",
      "cheeks": "freckles",
      "wrinkles": false
    }
  }
}
```

Bản mặc đồ cùng dáng (= Bé Tí). Muốn dựng bản này thì chép khối dưới lên thay khối trên, vì lệnh chỉ đọc khối đầu tiên.
Giữ `"proportions": "base"` để có cùng tỉ lệ với nhân vật gốc:

```jsonc
{
  "spec": {
    "name": "Bé Tí",
    "gender": "male", "age": "child", "build": "chubby", "proportions": "base",
    "skin": "#f5c5b4", "eyes": "#5d3a1a",
    "hair": { "style": "curly", "color": "#6b4226" },
    "top": { "style": "tshirt", "color": "#ffffff", "pattern": "stripes", "patternColor": "#1e88e5" },
    "bottom": { "style": "shorts", "color": "#e53935" },
    "shoes": { "style": "sneaker", "color": "#ffffff", "accent": "#e53935" },
    "accessories": [], "accessoryColor": "#fbc02d", "facialHair": "none",
    "face": { "shape": "round", "eyes": "big", "brows": "normal", "nose": "normal", "mouth": "wide", "ears": "big", "cheeks": "freckles", "wrinkles": false }
  }
}
```

### Giá trị cho từng trường

Giá trị lạ hoặc thiếu sẽ bị thay bằng mặc định, không báo lỗi (`src/ai/characterSpec.ts`).

| Trường | Giá trị |
|---|---|
| `gender` | `male` · `female` |
| `age` | `toddler` · `child` · `teen` · `adult` · `elder` |
| `build` | `slim` · `average` · `chubby` |
| `proportions` | `base` (chân / thân / tay dài, đầu nhỏ, bàn tay như nhân vật gốc) · `default`. Không áo thì luôn là `base` |
| `height` | (tuỳ chọn) chiều cao riêng, mét, 0.8–2.0. Bỏ trống = theo tuổi (trẻ em 1.2 m) |
| `skin`, `eyes`, mọi `color` | mã màu `#rrggbb` |
| `hair.style` | `bald` · `short` · `spiky` · `curly` · `afro` · `bob` · `long` · `ponytail` · `pigtails` · `bun` |
| `top.style` | `none` (nhân vật gốc) · `tshirt` · `shirt` · `longsleeve` · `hoodie` · `tank` · `dress` |
| `top.pattern` | `none` · `stripes` · `dots` · `plaid` · `flowers` |
| `bottom.style` | `none` · `pants` · `shorts` · `skirt` |
| `shoes.style` | `sneaker` · `barefoot` |
| `accessories` | `glasses` `sunglasses` `cap` `beanie` `sunhat` `backpack` `necklace` `earrings` `watch` `bowtie` `tie` `scarf` (một mũ, một kính, nơ **hoặc** cà vạt) |
| `facialHair` | `none` · `mustache` · `beard` (trẻ em / nữ luôn `none`) |
| `face.shape` | `oval` · `round` · `square` · `long` · `heart` |
| `face.eyes` | `round` · `big` · `almond` · `narrow` · `droopy` |
| `face.brows` | `normal` · `thick` · `thin` · `arched` · `flat` · `bushy` |
| `face.nose` | `normal` · `button` · `round` · `long` · `wide` · `pointy` |
| `face.mouth` | `normal` · `small` · `wide` · `full` |
| `face.ears` | `normal` · `small` · `big` |
| `face.cheeks` | `blush` · `rosy` · `freckles` · `none` |

## Những gì generator tự làm (không cần ghi trong spec)

Các quy tắc dưới đây nằm trong `scripts/blender/gen_character.py` + `make_character.py`, áp cho mọi nhân vật dựng
bằng generator này. Ô "Áp cho" ghi rõ quy tắc chỉ chạy với nhân vật không áo hay cả khi có `proportions: base`.

| Hạng mục | Kết quả | Áp cho |
|---|---|---|
| Tỉ lệ | Chân dài hơn ~29 %, thân +8 %, tay +8 % (đầu ngón tay buông tới khoảng giữa đùi), đầu nhỏ lại 14 % → đầu : chiều cao ≈ 1 : 3.3–3.4 | `base` |
| Chân | Gối không thắt, bắp chân tròn mềm liền xuống cổ chân, mặt cắt 32 cạnh; đầy hơn 8 % | `base` |
| Vai | Rộng hơn ~17 %, khớp vai hạ ngang chân cổ; đường vai từ cổ dốc lõm nhẹ (~11°) rồi tròn qua đầu vai (đỉnh đầu vai không cao hơn xương quai xanh); đầu vai to bằng ống cánh tay → vai – tay liền một đường cong | không áo |
| Cổ – ngực | Chân cổ loe mềm, ngực trên / xương quai xanh đầy; làm mượt riêng vùng chân cổ | không áo |
| Bề mặt da | Chia mịn (subdivision 2 cấp) thân / cổ / vai / tay trước khi đúc voxel; làm mượt Taubin cả lớp da (không teo); lấp rãnh chữ V ở vai; giữ 60 000 mặt | không áo |
| Bóng vẽ sẵn | Bóng chỗ lõm tối đa 8 %, không vẽ xương sườn / khối cơ; rốn là chấm mờ (vẽ màu, không khoét) | không áo |
| Bàn tay / cánh tay | 5 ngón tách rõ (dài hơn, tròn hơn, xoè nhẹ 9°), lòng bàn tay dẹt và ngắn, cổ tay thon rõ; cánh tay dày hơn 15 %, da tay làm mượt | `base` (cả bản mặc đồ) |
| Chiều cao riêng | `"height": 1.1–1.3` (m) cho các bạn cùng tuổi cao thấp khác nhau: cao hơn thì chân / thân dài hơn, đầu giữ nguyên | khi có `height` |
| Mắt | Tròng 3 lớp (viền sẫm → tròng → vành sáng), con ngươi tròn, 2 chấm sáng | mọi nhân vật |
| Lông mày | Đầu trong bo tròn, đỉnh cong ở ~60 % chiều dài, đuôi thon | mọi nhân vật |
| Mũi / môi | Mũi tối nhẹ mặt dưới, sáng ở chóp; môi luôn có viền màu môi | mọi nhân vật |

## Kiểm tra sau khi dựng

Tìm các dòng sau trong log (`storage/characters/<id>/build.log`):

- `AUTOWEIGHT Body: … 0 đỉnh dùng trọng lượng dự phòng`. Nếu số này **bằng số đỉnh** thì bước tự tính trọng lượng xương
  (bone heat) đã thất bại, nhân vật sẽ biến dạng xấu khi cử động → báo lỗi, đừng dùng bản đó.
- `PROPORTION … → 1 : 3.3x`: tỉ lệ đầu : chiều cao.
- `SYM Body: … trung bình < 1 mm`: lệch trái – phải.
- Mở `preview.png` / `preview_face.png`.

## Lưu ý đã biết

- Vài động tác Mixamo giơ cao hai tay (vd. `Victory`) làm da bụng / ngực hơi gợn khi đứng yên ở khung đó. Lỗi đã có từ
  trước, chưa sửa; các động tác thường (đứng, đi, vẫy tay) không bị.
- Bản mặc đồ (`proportions: base`) có tỉ lệ, mặt, chân, bàn tay / cánh tay như nhân vật gốc, nhưng vai / thân là của
  áo (không dùng lớp da liền), nên vai trông theo dáng áo chứ không giống hệt bản không áo.
- Bộ chỉnh tỉ lệ mạnh (chân +29 %, đầu nhỏ lại) chỉ áp cho trẻ em; thiếu niên / người lớn / người già chỉ dài chân 13 %.
- Dựng lại cùng spec cho ra kết quả gần như y hệt (tất định), trừ sai khác rất nhỏ do Blender.
