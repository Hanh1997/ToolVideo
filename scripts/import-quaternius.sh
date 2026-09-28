#!/usr/bin/env bash
# Import các gói Quaternius (CC0) đã tải về tools/quaternius/ vào thư viện asset.
# Tải: .venv/Scripts/python scripts/fetch-drive.py <url thư mục Drive> tools/quaternius/<gói> FBX/ "*"
# Chạy lại an toàn: asset cùng id được ghi đè.
set -euo pipefail
cd "$(dirname "$0")/.."
Q=tools/quaternius
LIC=(--license CC0-1.0 --author Quaternius)

add() { npm run --silent asset:add -- "$@" 2>&1 | grep -E "^✓|✗|⚠" || true; }

# ---------------------------------------------------------------- thiên nhiên
UN=$Q/ultimate-nature/FBX
P=(--type prop --prefix prop_n_ --pack "Quaternius · Ultimate Nature" --source https://quaternius.com/packs/ultimatenature.html "${LIC[@]}")
add $UN/*Tree_*.fbx $UN/Willow_*.fbx "${P[@]}" --scale 2.2
add $UN/Rock_*.fbx "${P[@]}" --scale 1.2
add $UN/Bush*.fbx "${P[@]}" --scale 1.0
add $UN/Flowers.fbx $UN/Grass*.fbx $UN/Plant_*.fbx $UN/Lilypad.fbx "${P[@]}" --scale 0.5
add $UN/Corn_*.fbx $UN/Wheat.fbx "${P[@]}" --scale 0.9 --tags crop
add $UN/Cactus*.fbx "${P[@]}" --scale 1.6
add $UN/TreeStump*.fbx $UN/WoodLog*.fbx "${P[@]}" --scale 0.8

SN=$Q/stylized-nature/glTF
P=(--type prop --prefix prop_sn_ --pack "Quaternius · Stylized Nature" --source https://quaternius.com/packs/ultimatestylizednature.html "${LIC[@]}")
add $SN/*Tree_*.gltf $SN/Bush*.gltf "${P[@]}" --scale 1.0
add $SN/Flower_*.gltf $SN/Grass_*.gltf "${P[@]}" --scale 0.8

SI=$Q/simple-nature/FBX
P=(--type prop --prefix prop_s_ --pack "Quaternius · Simple Nature" --source https://quaternius.com/packs/simplenature.html "${LIC[@]}")
add $SI/Tree*.fbx "${P[@]}" --scale 1.4
add $SI/Grass*.fbx "${P[@]}" --scale 2.0
add $SI/Rock*.fbx $SI/Bush*.fbx "${P[@]}" --scale 0.8

FB=$Q/farm-buildings/FBX
add $FB/*.fbx --type prop --prefix prop_farm_ --pack "Quaternius · Farm Buildings" --source https://quaternius.com/packs/farmbuildings.html "${LIC[@]}" --scale 1.0 --tags farm

# ---------------------------------------------------------------- nhân vật (height = chiều cao m)
char() { # file id tên height pack source [tags]
  add "$1" --id "$2" --name "$3" --height "$4" --pack "$5" --source "$6" "${LIC[@]}" ${7:+--tags "$7"}
}

CM=$Q/cute-monsters/glTF; CMP="Quaternius · Cute Monsters"; CMS=https://quaternius.com/packs/cutemonsters.html
while IFS='|' read -r f id name h tags; do
  [ -n "$f" ] && char "$CM/$f.gltf" "$id" "$name" "$h" "$CMP" "$CMS" "$tags"
done <<'EOF'
Alien|char_m_alien|Người ngoài hành tinh nhỏ|1.0|monster
Alien_Tall|char_m_alien_tall|Người ngoài hành tinh cao|1.6|monster
Bat|char_m_bat|Dơi|0.7|animal
Bee|char_m_bee|Ong|0.6|animal
Cactus|char_m_cactus|Xương rồng vui vẻ|1.2|plant
Chicken|char_m_chicken|Gà|0.6|animal,farm
Crab|char_m_crab|Cua|0.5|animal,sea
Cthulhu|char_m_cthulhu|Bạch tuộc xanh|1.5|monster
Cyclops|char_m_cyclops|Quái một mắt|1.5|monster
Deer|char_m_deer|Hươu|1.4|animal
Demon|char_m_demon|Quỷ đỏ|1.4|monster
Ghost|char_m_ghost|Ma nhỏ|1.1|monster
GreenDemon|char_m_green_demon|Quỷ xanh|1.4|monster
Mushroom|char_m_mushroom|Nấm|0.9|plant
Panda|char_m_panda|Gấu trúc|1.2|animal
Penguin|char_m_penguin|Chim cánh cụt|0.9|animal
Pig|char_m_pig|Heo con|0.8|animal,farm
Skull|char_m_skull|Đầu lâu|0.9|monster
Tree|char_m_tree|Cây biết đi|1.8|plant
YellowDragon|char_m_yellow_dragon|Rồng vàng|1.6|monster
Yeti|char_m_yeti|Người tuyết|1.8|monster
EOF

HP="Quaternius · Animated Men / Women"
for f in Male_Casual Male_LongSleeve Male_Shirt Male_Suit; do
  char "$Q/animated-men/FBX/$f.fbx" "char_h_$(echo "$f" | tr 'A-Z' 'a-z')" "Nam – ${f#Male_}" 1.75 "$HP" https://quaternius.com/packs/animatedmen.html human
done
for f in Female_Alternative Female_Casual Female_Dress Female_TankTop; do
  char "$Q/animated-women/FBX/$f.fbx" "char_h_$(echo "$f" | tr 'A-Z' 'a-z')" "Nữ – ${f#Female_}" 1.65 "$HP" https://quaternius.com/packs/animatedwomen.html human
done

DP="Quaternius · Animated Dinosaurs"; DS=https://quaternius.com/packs/animateddinosaurs.html
char $Q/dinosaurs/FBX/Apatosaurus.fbx char_dino_apatosaurus "Khủng long cổ dài" 7 "$DP" $DS dinosaur
char $Q/dinosaurs/FBX/Parasaurolophus.fbx char_dino_parasaurolophus "Khủng long mỏ vịt" 4 "$DP" $DS dinosaur
char $Q/dinosaurs/FBX/Stegosaurus.fbx char_dino_stegosaurus "Khủng long phiến sừng" 3.5 "$DP" $DS dinosaur
char $Q/dinosaurs/FBX/Trex.fbx char_dino_trex "Khủng long bạo chúa" 5 "$DP" $DS dinosaur
char $Q/dinosaurs/FBX/Triceratops.fbx char_dino_triceratops "Khủng long ba sừng" 3 "$DP" $DS dinosaur
char $Q/dinosaurs/FBX/Velociraptor.fbx char_dino_velociraptor "Khủng long Velociraptor" 1.6 "$DP" $DS dinosaur

char $Q/alien/FBX/Alien.fbx char_alien "Người ngoài hành tinh" 1.2 "Quaternius · Animated Alien" https://quaternius.com/packs/animatedalien.html monster
char $Q/alien/FBX/Alien_Helmet.fbx char_alien_helmet "Phi hành gia ngoài hành tinh" 1.3 "Quaternius · Animated Alien" https://quaternius.com/packs/animatedalien.html monster

SP="Quaternius · Animated Fish"; SS=https://quaternius.com/packs/animatedfish.html
char $Q/fish/FBX/Dolphin.fbx char_sea_dolphin "Cá heo" 0.8 "$SP" $SS sea
char $Q/fish/FBX/Fish1.fbx char_sea_fish_1 "Cá 1" 0.3 "$SP" $SS sea
char $Q/fish/FBX/Fish2.fbx char_sea_fish_2 "Cá 2" 0.3 "$SP" $SS sea
char $Q/fish/FBX/Fish3.fbx char_sea_fish_3 "Cá 3" 0.3 "$SP" $SS sea
char "$Q/fish/FBX/Manta ray.fbx" char_sea_manta_ray "Cá đuối" 0.4 "$SP" $SS sea
char $Q/fish/FBX/Shark.fbx char_sea_shark "Cá mập" 1.0 "$SP" $SS sea
char $Q/fish/FBX/Whale.fbx char_sea_whale "Cá voi" 3.0 "$SP" $SS sea
