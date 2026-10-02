"""
Kiểm tra hoạt ảnh Mixamo đã tải: clip nào hạ hông thấp (ngồi / khom / quỳ) – dùng để loại clip "đứng" chọn nhầm
(vd. "Talking" có nhiều bản, có bản ngồi nói chuyện).

    blender -b -P scripts/mixamo/check_standing.py -- D:/Mixamo

In mỗi dòng: STAND <id> <tỉ lệ hông thấp nhất> <tỉ lệ trung vị> (so với tư thế nghỉ). Ghi <thư mục>/standing.json.
"""
import json
import os
import sys

import bpy

folder = sys.argv[sys.argv.index("--") + 1]
manifest = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf8"))
out = {}
for fid, info in manifest.items():
    path = os.path.join(folder, info["file"])
    if not os.path.exists(path):
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    hb = next(b for b in arm.pose.bones if b.name.endswith("Hips"))
    rest = (arm.matrix_world @ arm.data.bones[hb.name].head_local).z
    act = arm.animation_data.action
    f0, f1 = (int(round(v)) for v in act.frame_range)
    zs = []
    for fr in range(f0, f1 + 1, max(1, (f1 - f0) // 24)):
        bpy.context.scene.frame_set(fr)
        zs.append((arm.matrix_world @ hb.head).z / rest)
    zs.sort()
    out[fid] = {"min": round(zs[0], 3), "median": round(zs[len(zs) // 2], 3)}
    print(f"STAND {fid} {out[fid]['min']} {out[fid]['median']}")
json.dump(out, open(os.path.join(folder, "standing.json"), "w", encoding="utf8"), indent=2)
