#!/usr/bin/env bash
# Đợt 3 (2026-09): nhập Kenney Furniture Kit (CC0) làm đạo cụ trong nhà – dựng bối cảnh phòng khách, bếp, phòng ngủ.
# Tải: https://kenney.nl/assets/furniture-kit → giải nén vào tools/kenney/furniture-kit
# Tỷ lệ gốc: cửa 1.01 đơn vị, tường 1.29 → ×2.1 = cửa 2.1 m, tường 2.7 m (giữ tỷ lệ tương đối giữa các món).
# Chạy lại an toàn: asset cùng id được ghi đè.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="tools/kenney/furniture-kit/Models/GLTF format"
[ -d "$DIR" ] || { echo "Chưa tải gói: $DIR"; exit 1; }
# Lô 20 file / lần (Windows giới hạn độ dài dòng lệnh).
files=("$DIR"/*.glb)
for ((i = 0; i < ${#files[@]}; i += 20)); do
  npm run --silent asset:add -- "${files[@]:i:20}" --type prop --prefix prop_fk_ --scale 2.1 \
    --pack "Kenney · Furniture Kit" --tags furniture,indoor \
    --license CC0-1.0 --author Kenney --source https://kenney.nl/assets/furniture-kit 2>&1 | grep -E "^✓|✗|⚠|rror" || true
done | awk '/^✓/ {n++} !/^✓/ {print} END {print "✓ " n " đạo cụ"}'
# Đồ vật cầm được (xem src/ai/objects.ts): chiều cao khi nhân vật cầm / ngậm.
printf 'prop_fk_bear holdHeight=0.32\nprop_fk_books holdHeight=0.16\nprop_fk_pillow_blue holdHeight=0.26\nprop_fk_cardboard_box_closed holdHeight=0.26\n' | npm run --silent asset:set
