#!/usr/bin/env bash
# Đợt 4 (2026-09): nhân vật NGƯỜI phong cách khối vuông của Kenney (CC0, có hoạt ảnh: đi, chạy, nhảy, nhặt, gật/lắc, ngồi…).
#   Mini Characters   – chibi dễ thương (bé + bố mẹ, ông, cảnh sát): https://kenney.nl/assets/mini-characters
#   Blocky Characters – người lớn kiểu Minecraft + vai phụ (cướp biển, ninja, robot…): https://kenney.nl/assets/blocky-characters
# Tải zip trên trang → giải nén vào tools/kenney/mini-characters, tools/kenney/blocky-characters.
# Tên / nhãn theo hình (ảnh xếp hàng render từ engine). Chạy lại an toàn: asset cùng id được ghi đè.
set -euo pipefail
cd "$(dirname "$0")/.."
LIC=(--license CC0-1.0 --author Kenney)
add() { npm run --silent asset:add -- "$@" "${LIC[@]}" 2>&1 | grep -E "^✓|✗|⚠|rror" | cut -c1-60 || true; }

M="tools/kenney/mini-characters/Models/GLB format"; MP="Kenney · Mini Characters"; MS=https://kenney.nl/assets/mini-characters
while IFS='|' read -r f id name h tags; do
  [ -n "$f" ] && add "$M/$f.glb" --id "$id" --name "$name" --height "$h" --pack "$MP" --source "$MS" --tags "$tags"
done <<'EOF2'
character-female-a|char_km_girl_purple|Bé gái tóc đen búi, áo tím (chống nạng)|0.95|human,kid,girl
character-female-b|char_km_girl_blonde|Bé gái tóc vàng, áo vàng|0.95|human,kid,girl
character-female-c|char_km_girl_beanie|Bé gái đội mũ len, áo xanh|0.95|human,kid,girl
character-female-d|char_km_mom|Mẹ tóc đỏ búi, váy xám|1.2|human,adult,woman,mom
character-female-e|char_km_girl_ponytail|Chị tóc đen buộc đuôi ngựa, áo khoác trắng|1.05|human,kid,girl,teen
character-female-f|char_km_girl_pigtails|Bé gái tóc nâu hai bím, quần yếm|0.95|human,kid,girl
character-male-a|char_km_boy_glasses|Bé trai đeo kính, áo xanh lá|0.95|human,kid,boy
character-male-b|char_km_grandpa|Ông hói râu cam|1.15|human,adult,man,grandpa
character-male-c|char_km_police|Chú cảnh sát|1.2|human,adult,man,police
character-male-d|char_km_dad|Bố tóc cam, mặc vest|1.2|human,adult,man,dad
character-male-e|char_km_boy_vest|Anh đeo kính, áo gi-lê vàng|1.05|human,kid,boy,teen
character-male-f|char_km_boy|Bé trai tóc đen, áo xanh (mặt cau có – hợp vai bướng bỉnh)|0.95|human,kid,boy,grumpy
EOF2

B="tools/kenney/blocky-characters/Models/GLB format"; BP="Kenney · Blocky Characters"; BS=https://kenney.nl/assets/blocky-characters
while IFS='|' read -r f id name h tags; do
  [ -n "$f" ] && add "$B/$f.glb" --id "$id" --name "$name" --height "$h" --pack "$BP" --source "$BS" --tags "$tags"
done <<'EOF2'
character-a|char_kb_farmer|Bác nông dân râu xám|1.7|human,adult,man,farmer
character-b|char_kb_man_red|Chú áo đỏ|1.75|human,adult,man
character-c|char_kb_gamer|Anh áo xanh tay cầm game|1.7|human,adult,man,teen
character-d|char_kb_dummy|Hình nộm thử nghiệm vàng|1.7|human,robot,funny
character-e|char_kb_woman_purple|Cô áo tím|1.65|human,adult,woman
character-f|char_kb_woman_green|Cô áo xanh lá|1.65|human,adult,woman
character-g|char_kb_robot_red|Rô-bốt đỏ|1.7|robot,fantasy
character-h|char_kb_robot_purple|Rô-bốt tím|1.7|robot,fantasy
character-i|char_kb_grandpa|Ông đeo kính|1.65|human,adult,man,grandpa
character-j|char_kb_police|Chú cảnh sát (blocky)|1.75|human,adult,man,police
character-k|char_kb_man_mustache|Chú ria mép áo đỏ|1.7|human,adult,man
character-l|char_kb_zombie|Thây ma xanh|1.7|monster,fantasy
character-m|char_kb_explorer|Nhà thám hiểm|1.7|human,adult,man,explorer
character-n|char_kb_kimono|Cô mặc kimono|1.65|human,adult,woman
character-o|char_kb_orc|Yêu tinh xanh|1.8|monster,fantasy
character-p|char_kb_pirate|Cướp biển bịt mắt|1.75|human,adult,man,pirate
character-q|char_kb_businessman|Chú mặc vest|1.75|human,adult,man
character-r|char_kb_ninja|Ninja|1.7|human,adult,ninja
EOF2
