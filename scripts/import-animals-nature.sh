#!/usr/bin/env bash
# Đợt 2 (2026-09): nhập gói động vật + thiên nhiên từ Quaternius, Kenney, Poly Pizza vào thư viện asset.
# Chạy lại an toàn: asset cùng id được ghi đè. Gói chưa tải thì bỏ qua.
set -euo pipefail
cd "$(dirname "$0")/.."
Q=tools/quaternius
LIC=(--license CC0-1.0 --author Quaternius)

add() { npm run --silent asset:add -- "$@" 2>&1 | grep -E "^✓|✗|⚠" || true; }
char() { # file id tên height pack source [tags]
  add "$1" --id "$2" --name "$3" --height "$4" --pack "$5" --source "$6" "${LIC[@]}" ${7:+--tags "$7"}
}
# Cấu trúc: tools/<nguồn>/<gói>/<định dạng>/ – nguồn = quaternius | kenney | polypizza (tác giả khác).
# Tải:
#   Poly Pizza (Drive hay báo "Quota exceeded"): .venv/Scripts/python scripts/fetch-polypizza.py https://poly.pizza/bundle/<slug> tools/<nguồn>/<gói>
#     Animated-Animal-Pack-ILAPXeUYiS → quaternius/animals        Animated-Fish-Bundle-44zhHN1UbT → quaternius/cute-fish
#     Stylized-Nature-MegaKit-T34GZFA0fm → quaternius/stylized-nature-megakit
#     Animal-Kit-J1PqAonfYb → polypizza/animal-kit     Animals-ULEaWm7bsY → polypizza/animals
#     Australian-Animals-Aw46S1RO1G → polypizza/australian-animals     Coral-Reef-Kit-ghN8EmbYa6 → polypizza/coral-reef-kit
#     Pretty-park-set-G2WINPAG9S → polypizza/pretty-park    Low-Poly-Outdoor-Garden-Decorations-Uw7aBn0TBr → polypizza/outdoor-garden
#     Tree-Collection-zdry8l7ugJ → polypizza/tree-collection
#   Kenney (zip trực tiếp, giải nén vào tools/kenney/<gói>): nature-kit, cube-pets, mini-forest – https://kenney.nl/assets/<gói>
#   Drive (FETCH_WORKERS=2): D=https://drive.google.com/drive/folders
#     fetch-drive.py $D/1GlrFUFcNj6KIuc4-QpVEiRcXVUzSClP2 $Q/stylized-tree FBX/ Textures/ "*"
#     fetch-drive.py $D/1WKJe-QxkPs_zb8CVhxPhYT57EsY5tGD3 $Q/textured-fantasy-nature FBX/ Blends/Textures/ "*"
#     fetch-drive.py $D/1uhbi-NWp7pwqOGtraBZurbphyxAvoABZ $Q/crops FBX/ "*"

AA=$Q/animals/GLB; AAP="Quaternius · Ultimate Animated Animals"; AAS=https://quaternius.com/packs/ultimateanimatedanimals.html
while IFS='|' read -r f id name h tags; do
  [ -n "$f" ] && char "$AA/$f.glb" "$id" "$name" "$h" "$AAP" "$AAS" "$tags"
done <<'EOF2'
Alpaca|char_a_alpaca|Lạc đà Alpaca|1.7|animal,farm
Bull|char_a_bull|Bò tót|1.6|animal,farm
Cow|char_a_cow|Bò sữa|1.5|animal,farm
Deer|char_a_deer|Hươu cái|1.3|animal,forest
Donkey|char_a_donkey|Lừa|1.4|animal,farm
Fox|char_a_fox|Cáo|0.5|animal,forest
Horse|char_a_horse|Ngựa nâu|1.7|animal,farm
White_Horse|char_a_horse_white|Ngựa trắng|1.7|animal,farm
Husky|char_a_husky|Chó Husky|0.65|animal,pet
Shiba_Inu|char_a_shiba|Chó Shiba|0.45|animal,pet
Stag|char_a_stag|Hươu đực|1.9|animal,forest
Wolf|char_a_wolf|Sói|0.8|animal,forest
EOF2

# Cá có hoạt ảnh bơi → nhân vật; thuyền/bến/cần câu/mồi tĩnh → đạo cụ.
CF=$Q/cute-fish/GLB; CFP="Quaternius · Cute Fish"; CFS=https://quaternius.com/packs/cutefish.html
for f in $(ls $CF/*.glb | grep -vE '/(Boat|Dock_|Fishing_Rod|Lure|Worm)'); do
  add "$f" --prefix char_fish_ --height 0.35 --pack "$CFP" --source $CFS "${LIC[@]}" --tags animal,fish,sea
done
add $CF/Boat.glb $CF/Dock_*.glb --type prop --prefix prop_fish_ --pack "$CFP" --source $CFS "${LIC[@]}" --scale 1.0 --tags fishing,water
add $CF/Fishing_Rod*.glb $CF/Lure*.glb $CF/Worm.glb --type prop --prefix prop_fish_ --pack "$CFP" --source $CFS "${LIC[@]}" --scale 1.0 --tags fishing

SM=$Q/stylized-nature-megakit/GLB
P=(--type prop --prefix prop_snm_ --pack "Quaternius · Stylized Nature MegaKit" --source https://quaternius.com/packs/stylizednaturemegakit.html "${LIC[@]}")
add $SM/*Tree*.glb $SM/Pine*.glb "${P[@]}" --scale 1.0
add $SM/Bush*.glb $SM/Plant*.glb $SM/Fern.glb $SM/Mushroom*.glb "${P[@]}" --scale 1.0
add $SM/Flower*.glb $SM/Grass*.glb $SM/Tall_Grass.glb $SM/Clover*.glb "${P[@]}" --scale 1.0
add $SM/Rock*.glb $SM/Pebble*.glb "${P[@]}" --scale 1.0

ST=$Q/stylized-tree/FBX
compgen -G "$ST/*.fbx" >/dev/null && add $ST/*.fbx --type prop --prefix prop_st_ --pack "Quaternius · Stylized Trees" --source https://quaternius.com/packs/stylizedtree.html "${LIC[@]}" --scale 1.0
TF=$Q/textured-fantasy-nature/FBX
compgen -G "$TF/*.fbx" >/dev/null && add $TF/*.fbx --type prop --prefix prop_tf_ --pack "Quaternius · Textured Fantasy Nature" --source https://quaternius.com/packs/texturedfantasynature.html "${LIC[@]}" --scale 1.0
CR=$Q/crops/FBX
compgen -G "$CR/*.fbx" >/dev/null && add $CR/*.fbx --type prop --prefix prop_crop_ --pack "Quaternius · Ultimate Crops" --source https://quaternius.com/packs/ultimatecrops.html "${LIC[@]}" --scale 1.0 --tags crop,farm

# ---------------------------------------------------------------- Kenney (CC0)
K=tools/kenney
KL=(--license CC0-1.0 --author Kenney)
KP="$K/cube-pets/Models/GLB format"
add "$KP"/animal-*.glb --prefix char_k_ --height 0.8 --pack "Kenney · Cube Pets" --source https://kenney.nl/assets/cube-pets "${KL[@]}" --tags animal,pet
KN="$K/nature-kit/Models/GLTF format"
P=(--type prop --prefix prop_kn_ --pack "Kenney · Nature Kit" --source https://kenney.nl/assets/nature-kit "${KL[@]}")
add "$KN"/tree_*.glb "$KN"/plant_*.glb "$KN"/flower_*.glb "$KN"/grass*.glb "$KN"/mushroom_*.glb "$KN"/cactus_*.glb "$KN"/lily_*.glb "${P[@]}" --scale 2.0
add "$KN"/rock_*.glb "$KN"/stone_*.glb "$KN"/log*.glb "$KN"/stump_*.glb "$KN"/crop*.glb "${P[@]}" --scale 2.0
KM="$K/mini-forest/Models/GLB format"
add "$KM"/tree*.glb "$KM"/plant.glb "$KM"/rocks-*.glb "$KM"/stones.glb "$KM"/patch-*.glb --type prop --prefix prop_km_ --pack "Kenney · Mini Forest" --source https://kenney.nl/assets/mini-forest "${KL[@]}" --scale 1.0

# ---------------------------------------------------------------- Poly Pizza – tác giả khác (CC0 / CC-BY)
# Mỗi bundle có thể trộn giấy phép → nhập theo nhóm (giấy phép, tác giả) đọc từ manifest.json.
pp() { # thư mục prefix pack [tuỳ chọn add…]
  local dir=$1 prefix=$2 pack=$3; shift 3
  .venv/Scripts/python -c "
import json,sys,collections
m=json.load(open(sys.argv[1]+'/manifest.json',encoding='utf-8')); g=collections.defaultdict(list)
for x in m['models']: g[(x['license'],x['author'])].append(sys.argv[1]+'/'+x['file'])
for (l,a),fs in g.items(): print(l+'|'+a+'|'+m['source']+'|'+' '.join(fs))" "$dir" |
  while IFS='|' read -r lic author src files; do
    # shellcheck disable=SC2086
    add $files --prefix "$prefix" --pack "$pack" --source "$src" --license "$lic" --author "$author" "$@" </dev/null
  done
}
PP=tools/polypizza
pp $PP/animal-kit          prop_pa_  "Poly Pizza · Animal Kit"        --type prop --scale 1.0 --tags animal
pp $PP/animals             prop_pz_  "Poly Pizza · Animals"           --type prop --scale 1.0 --tags animal
pp $PP/australian-animals  prop_au_  "Poly Pizza · Australian Animals" --type prop --scale 1.0 --tags animal
pp $PP/coral-reef-kit      prop_reef_ "Poly Pizza · Coral Reef Kit"   --type prop --scale 1.0 --tags sea,coral
pp $PP/pretty-park         prop_park_ "Poly Pizza · Pretty Park"      --type prop --scale 1.0 --tags park
pp $PP/outdoor-garden      prop_gd_  "Poly Pizza · Outdoor Garden"    --type prop --scale 1.0 --tags garden
pp $PP/tree-collection     prop_tc_  "Poly Pizza · Tree Collection"   --type prop --scale 1.0 --tags tree

# ---------------------------------------------------------------- chuẩn hoá kích thước (đo khung bao sau khi nhập)
# Mốc: cây của Ultimate/Stylized Nature cao ~6–7 m. Gói Poly Pizza có tỷ lệ gốc lộn xộn (gà 189 m, cá voi 0.8 m)
# nên đặt chiều cao từng con. Dòng sau ghi đè dòng trước.
npm run --silent asset:set <<'SIZES'
prop_kn_*              scale=4.5
prop_kn_grass*         scale=2.5
prop_kn_flower*        scale=3.0
prop_km_*              scale=2.7
prop_snm_tree*         scale=0.6
prop_snm_dead_tree*    scale=0.6
prop_snm_twisted_tree* scale=0.6
prop_snm_pine*         scale=0.6
prop_gd_tree           scale=0.45
prop_tc_*              scale=3.0

prop_pa_beagle height=0.45
prop_pa_bear height=1.2
prop_pa_bird height=0.2
prop_pa_bird_2 height=0.2
prop_pa_bizon height=1.8
prop_pa_cat height=0.35
prop_pa_chick height=0.15
prop_pa_chicken height=0.45
prop_pa_corgi height=0.35
prop_pa_cow height=1.5
prop_pa_deer height=1.3
prop_pa_deer_2 height=1.6
prop_pa_dog height=0.6
prop_pa_dog_2 height=0.6
prop_pa_dog_3 height=0.6
prop_pa_duck height=0.4
prop_pa_fox height=0.5
prop_pa_frog height=0.12
prop_pa_giraffe height=4.5
prop_pa_horse height=1.7
prop_pa_lizard height=0.1
prop_pa_penguin height=0.9
prop_pa_rabbit height=0.3
prop_pa_shark height=1.0
prop_pa_sheep height=1.0

prop_pz_anteater height=1.0
prop_pz_antelope height=1.3
prop_pz_buffalo_sunrise height=1.6
prop_pz_baboon height=0.8
prop_pz_badger height=0.35
prop_pz_bear height=1.2
prop_pz_bee height=0.15
prop_pz_bird height=0.2
prop_pz_butterfly height=0.15
prop_pz_capybara height=0.55
prop_pz_cat height=0.35
prop_pz_chicken height=0.45
prop_pz_cow height=1.5
prop_pz_coyote height=0.6
prop_pz_crab height=0.2
prop_pz_dragonfly height=0.12
prop_pz_duck height=0.4
prop_pz_elephant height=3.0
prop_pz_emu height=1.8
prop_pz_fish height=0.3
prop_pz_fox height=0.5
prop_pz_frog height=0.12
prop_pz_giraffe height=4.5
prop_pz_goat height=0.8
prop_pz_horse height=1.7
prop_pz_kangaroo height=1.5
prop_pz_koala height=0.6
prop_pz_lion height=1.2
prop_pz_manatee height=0.8
prop_pz_monkey height=0.6
prop_pz_moose_antlers height=2.2
prop_pz_narwhal height=0.8
prop_pz_octopus height=0.5
prop_pz_ostrich height=2.2
prop_pz_penguin height=0.9
prop_pz_porcupine height=0.4
prop_pz_raccoon height=0.4
prop_pz_rhino height=1.7
prop_pz_salamander height=0.08
prop_pz_seal height=0.6
prop_pz_snake height=0.15
prop_pz_spider height=0.1
prop_pz_starfish height=0.05
prop_pz_tiger height=1.0
prop_pz_turkey_vulture height=0.7
prop_pz_walrus height=1.0
prop_pz_whale height=3.0
prop_pz_wolf height=0.8
prop_pz_zebra height=1.5

prop_au_banksia height=1.5
prop_au_bilby height=0.35
prop_au_dunnart height=0.12
prop_au_long_necked_turtle height=0.25
prop_au_numbat height=0.3
prop_au_pimelea_suaveolens height=0.6
SIZES
