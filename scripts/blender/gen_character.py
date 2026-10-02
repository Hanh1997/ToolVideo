"""
Dựng nhân vật hoạt hình từ bản mô tả JSON (thường do AI viết từ prompt – server/ai/characterGenerator.ts) → GLB có
xương, biểu cảm khuôn mặt, khẩu hình và hoạt ảnh. Dùng lại hình khối / khuôn mặt / xương / hoạt ảnh của make_character.py.

    blender -b -P scripts/blender/gen_character.py -- --spec spec.json --out char.glb [--preview preview.png] [--mixamo D:/Mixamo]

spec (mọi trường có mặc định – xem src/ai/characterSpec.ts):
    gender male|female · age toddler|child|teen|adult|elder · build slim|average|chubby · skin, eyes "#rrggbb"
    hair {style, color} · top {style, color, pattern, patternColor} · bottom {style, color} · shoes {color, accent}
    accessories [...] · accessoryColor · facialHair none|mustache|beard

- Tỉ lệ: đầu giữ nguyên cỡ (khuôn mặt + shape key dùng chung), thân / tay / chân co giãn theo tuổi và vóc dáng →
  trẻ em đầu to kiểu chibi. Engine tự co model về chiều cao ghi trong registry.
- In ra (để server báo tiến độ): "STEP <việc>", "RETARGET …" (make_character), "INFO {json}", "PREVIEW <file>".
"""
import json
import math
import os
import random
import sys

import bpy
from mathutils import Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_character as mc  # noqa: E402

sys.stdout.reconfigure(line_buffering=True)  # server đọc tiến độ qua pipe
pi = math.pi
interp = mc.interp

# ---------------------------------------------------------------- tham số

# sl chân · st thân · sn cổ · sw bề ngang · sd bề dày · sa tay · sf bàn chân · eye cỡ mắt · nose cỡ mũi
AGES = {
    "toddler": dict(sl=0.36, st=0.42, sn=0.5, sw=0.66, sd=0.84, sa=0.4, sf=0.62, eye=1.22, nose=0.68),
    "child": dict(sl=0.48, st=0.5, sn=0.6, sw=0.74, sd=0.86, sa=0.47, sf=0.72, eye=1.18, nose=0.72),
    "teen": dict(sl=0.92, st=0.85, sn=0.9, sw=0.88, sd=0.9, sa=0.88, sf=0.9, eye=1.03, nose=0.92),
    "adult": dict(sl=1.0, st=1.0, sn=1.0, sw=1.0, sd=1.0, sa=1.0, sf=1.0, eye=1.0, nose=1.0),
    "elder": dict(sl=0.95, st=0.96, sn=0.95, sw=1.0, sd=1.05, sa=0.97, sf=1.0, eye=0.95, nose=1.1),
}
# (bề ngang, bề dày, độ to tay chân)
BUILDS = {"slim": (0.9, 0.9, 0.9), "average": (1.0, 1.0, 1.0), "chubby": (1.1, 1.14, 1.08)}

# Khuôn mặt (spec.face) – mỗi nhân vật một vẻ. Mặc định (oval / round / normal…) = khuôn mặt chung trước đây.
# dáng mặt: (hệ số ngang, sâu, cao của đầu, JAW thon về cằm, JAW_EXP độ vuông hàm, CHIN cằm nhô, dịch miệng)
FACE_SHAPES = {
    "oval": (1.0, 1.0, 1.0, 0.3, 1.4, 0.012, 0.0),
    "round": (1.06, 1.02, 0.95, 0.2, 1.6, 0.004, 0.004),
    "square": (1.05, 1.0, 0.98, 0.14, 2.6, 0.006, 0.0),
    "long": (0.93, 0.98, 1.08, 0.3, 1.3, 0.016, -0.008),
    "heart": (1.05, 1.0, 1.0, 0.42, 1.0, 0.02, 0.0),
}
# mắt: (hệ số ngang, cao, xếch (rad), mí trên che, cỡ tròng)
EYE_SHAPES = {
    "round": (1.0, 1.0, 0.0, 0.0, 1.0),
    "big": (1.12, 1.12, 0.0, 0.0, 1.08),
    "almond": (1.1, 0.8, 0.14, 0.0, 0.92),
    "narrow": (1.06, 0.64, 0.04, 0.0, 0.75),
    "droopy": (1.0, 0.92, -0.1, 0.32, 0.95),
}
# lông mày: dày, độ cong, dài, rủ đuôi, thon đuôi
BROWS = {
    "normal": dict(th=0.014, arch=0.008, len=0.072, drop=0.0, taper=0.45),
    "thick": dict(th=0.021, arch=0.006, len=0.076, drop=0.0, taper=0.35),
    "thin": dict(th=0.0075, arch=0.009, len=0.068, drop=0.0, taper=0.5),
    "arched": dict(th=0.0105, arch=0.017, len=0.07, drop=0.004, taper=0.55),
    "flat": dict(th=0.016, arch=0.0, len=0.074, drop=0.0, taper=0.25),
    "bushy": dict(th=0.023, arch=0.009, len=0.08, drop=0.012, taper=0.3),
}
# mũi: (bán kính x, y, z, cao độ, nhô ra, cánh mũi)
NOSES = {
    "normal": ((0.017, 0.016, 0.015), -0.028, 0.004, False),
    "button": ((0.012, 0.012, 0.011), -0.026, 0.004, False),
    "round": ((0.022, 0.02, 0.019), -0.03, 0.006, False),
    "long": ((0.014, 0.017, 0.026), -0.034, 0.004, False),
    "wide": ((0.023, 0.014, 0.013), -0.032, 0.003, True),
    "pointy": ((0.011, 0.024, 0.014), -0.026, 0.01, False),
}
MOUTHS = {"normal": (1.0, False), "small": (0.8, False), "wide": (1.2, False), "full": (1.0, True)}
EARS = {"normal": (1.0, 0.0), "small": (0.8, -0.002), "big": (1.28, 0.01)}
# má: (cỡ má hồng, độ đậm, tàn nhang)
CHEEKS = {"blush": (1.0, 0.45, False), "rosy": (1.3, 0.7, False), "freckles": (0.8, 0.3, True), "none": (0.0, 0.0, False)}

# Thân (cao độ mẫu người lớn, bán kính ngang, bán kính trước–sau): nam vai rộng; nữ vai hẹp, eo thon, ngực đầy hơn.
# Sườn / ngực hẹp hơn khoảng vai (0.212) → tay buông không lún vào thân khi động tác Mixamo khép tay.
# Thân thu dần lên cổ: bờ vai do đầu tay áo tạo (không có góc vai vuông của thân lòi ra khi giơ tay);
# gấu áo chỉ rộng hơn hông quần một chút.
# Bề dày (trước–sau) phần bụng / hông ≈ bề dày đùi → nhìn nghiêng bụng, mông không lòi ra khỏi đùi.
TORSO_M = [(0.9, 0.155, 0.096), (0.97, 0.148, 0.093), (1.05, 0.146, 0.094), (1.15, 0.152, 0.1), (1.23, 0.156, 0.106),
           (1.285, 0.142, 0.1), (1.325, 0.122, 0.092), (1.352, 0.102, 0.082), (1.37, 0.08, 0.07)]
TORSO_F = [(0.9, 0.156, 0.095), (0.97, 0.138, 0.088), (1.05, 0.13, 0.087), (1.15, 0.137, 0.1), (1.23, 0.14, 0.108),
           (1.285, 0.13, 0.099), (1.325, 0.114, 0.089), (1.352, 0.098, 0.08), (1.37, 0.077, 0.068)]

# Đường mép tóc (cao độ dz theo |phương vị|, 0 = chính diện): dz 0.56 ở trán = mái ngang trên lông mày.
BOB = [(0.0, 0.56), (0.55, 0.52), (0.8, 0.3), (0.95, -0.2), (1.15, -0.55), (1.6, -0.62), (pi, -0.68)]
LONG = [(0.0, 0.56), (0.55, 0.52), (0.8, 0.3), (0.95, -0.25), (1.15, -0.8), (1.6, -0.9), (pi, -0.95)]
TIGHT = [(0.0, 0.52), (0.5, 0.48), (0.8, 0.3), (1.2, 0.15), (1.5, 0.05), (1.85, -0.2), (2.1, -0.45), (2.5, -0.55), (pi, -0.58)]
# Tóc thường (ngắn / xoăn / afro): trán như make_character, nhưng ngay sau tai tóc xuống tới gáy (không cạo hai bên
# như kiểu vuốt dựng) – nhìn chéo từ sau không lộ mảng da lớn.
FULL = [(0.0, 0.5), (0.4, 0.47), (0.7, 0.3), (1.1, 0.2), (1.35, 0.17), (1.6, 0.14), (1.85, -0.15), (2.1, -0.5), (2.5, -0.62), (pi, -0.66)]


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"spec": None, "out": None, "preview": None, "mixamo": None}
    for i, a in enumerate(argv):
        if a[2:] in out and i + 1 < len(argv):
            out[a[2:]] = argv[i + 1]
    return out


def step(msg):
    print(f"STEP {msg}")


def face_opt(table, key, default):
    face = SPEC.get("face") if isinstance(SPEC.get("face"), dict) else {}
    return table.get(face.get(key), table[default])


def apply_face():
    """Đặt dáng đầu / mắt / lông mày / miệng / má / nếp nhăn cho make_character trước khi dựng đầu + khuôn mặt."""
    fx, fy, fz, jaw, jexp, chin, mdz = face_opt(FACE_SHAPES, "shape", "oval")
    mc.HEAD_RX, mc.HEAD_RY, mc.HEAD_RZ = mc.HEAD_RX * fx, mc.HEAD_RY * fy, mc.HEAD_RZ * fz
    mc.JAW, mc.JAW_EXP, mc.CHIN = jaw, jexp, chin
    mc.EYE_X *= fx
    mc.MOUTH_Z += mdz
    ex, ez, tilt, lid, iris = face_opt(EYE_SHAPES, "eyes", "round")
    mc.EYE_RX *= ex
    mc.EYE_RZ *= ez
    mc.EYE_TILT, mc.EYE_LID, mc.IRIS_K = tilt, lid, iris
    # lông mày cách mép trên của mắt một khoảng cố định (mắt to → lông mày cao hơn), không lên quá chân tóc
    mc.BROW_Z = min(mc.EYE_Z + mc.EYE_RZ + 0.023, 0.074)
    mc.BROW = dict(face_opt(BROWS, "brows", "normal"))
    # ...và luôn nằm dưới mép tóc trước trán (tóc ngắn / xoăn / búi… che mất lông mày → mặt mất biểu cảm)
    hair = SPEC.get("hair") or {}
    front = {"bald": None, "spiky": mc.HAIRLINE[0][1], "ponytail": TIGHT[0][1], "pigtails": TIGHT[0][1], "bun": TIGHT[0][1]}
    dz = front.get(hair.get("style"), FULL[0][1]) if hair.get("style") not in ("bob", "long") else None  # mái bob / dài: lông mày dưới mái là kiểu tóc
    if dz is not None:
        b = mc.BROW
        brow_top = mc.BROW_Z + b["arch"] + b["th"] / 2 + 0.006  # + nhướng mày (browUp / ngạc nhiên) một phần
        cap = dz * mc.HEAD_RZ - 0.01  # chừa một khoảng da giữa lông mày và mép tóc
        if brow_top > cap:
            mc.BROW_Z = max(mc.EYE_Z + mc.EYE_RZ + b["th"] / 2 + 0.002, mc.BROW_Z - (brow_top - cap))
    mc.MOUTH_K, mc.LIPS = face_opt(MOUTHS, "mouth", "normal")
    mc.BLUSH, _, mc.FRECKLES = face_opt(CHEEKS, "cheeks", "blush")
    face = SPEC.get("face") if isinstance(SPEC.get("face"), dict) else {}
    mc.WRINKLES = bool(face.get("wrinkles", False))


def rgb(s, default):
    try:
        s = str(s).lstrip("#")
        return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, IndexError):
        return default


def shade(c, k):
    return tuple(max(0.0, min(1.0, v * k)) for v in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def clamp1(x):
    return max(-1.0, min(1.0, x))


# Số lần lặp hoạ tiết theo chiều cao thân áo: 0.85 → ~7 sọc lớn (nhìn xa không rối)
PATTERN_V = 0.85

# ---------------------------------------------------------------- tỉ lệ cơ thể + xương

class Body:
    """Mốc cơ thể (mét, Blender Z lên) tính từ tuổi / giới / vóc dáng; đặt luôn các biến toàn cục của make_character."""

    def __init__(self, spec):
        self.female = spec.get("gender") == "female"
        self.age = spec.get("age") if spec.get("age") in AGES else "adult"
        self.kid = self.age in ("toddler", "child")
        a = AGES[self.age]
        bw, bd, bl = BUILDS.get(spec.get("build"), BUILDS["average"])
        self.chubby = spec.get("build") == "chubby"
        self.sl, self.st, self.sn, self.sa = a["sl"], a["st"], a["sn"], a["sa"]
        # tỉ lệ "base" (nhân vật gốc – không áo luôn dùng; nhân vật mặc đồ bật bằng spec.proportions = "base")
        self.base_prop = (spec.get("top") or {}).get("style") == "none" or spec.get("proportions") == "base"
        # bộ chỉnh mạnh (chân +29 %, thân / tay +8 %, chân đầy hơn, đầu nhỏ lại) chỉ cho trẻ em (đầu to kiểu chibi);
        # thiếu niên / người lớn / người già đã cân → chỉ chân dài hơn 13 % như nhân vật gốc trước đây
        self.base_kid = self.base_prop and self.kid
        if self.base_kid:
            self.sl *= 1.13 * 1.14  # nhân vật gốc: chân dài hơn (13 % rồi thêm 14 %) – đầu : thân ≈ 1 : 3.5
            self.st *= 1.08  # thân dài hơn chút cho cân với chân dài
            self.sa *= 1.08  # tay dài hơn → đầu ngón tay buông tới khoảng giữa đùi
        elif self.base_prop:
            self.sl *= 1.13
        # chiều cao riêng (spec.height, m): cao / thấp hơn mặc định của tuổi → chân co giãn mạnh, thân vừa, đầu giữ
        # nguyên → bạn cao trông lớn hơn (đầu nhỏ đi tương đối), không chỉ phóng to cả người. Engine co về đúng spec.height.
        h0 = {"toddler": 0.95, "child": 1.2, "teen": 1.55 if self.female else 1.6, "adult": 1.65 if self.female else 1.75,
              "elder": 1.58 if self.female else 1.65}[self.age]  # = ageHeight (src/ai/characterSpec.ts)
        try:
            r = float(spec.get("height") or h0) / h0
        except (TypeError, ValueError):
            r = 1.0
        if abs(r - 1.0) > 1e-3:
            self.sl *= r ** 1.6
            self.st *= r ** 0.8
            self.sa *= r ** 1.1
        self.sw = a["sw"] * bw * (0.94 if self.female else 1.0)
        self.sd = a["sd"] * bd
        self.sf = a["sf"] * (0.93 if self.female else 1.0)
        self.limb = bl * (0.9 if self.female else 1.0)
        self.eye, self.nose = a["eye"], a["nose"]
        top_style = (spec.get("top") or {}).get("style")
        self.bare = top_style == "none"  # nhân vật gốc: thân + tay đúc thành một lớp da (merge_body)
        self.sleeve = {"tshirt": "short", "shirt": "short", "dress": "short", "longsleeve": "long", "hoodie": "long"}.get(top_style, "none")
        # Vai kiểu Quaternius (mọi nhân vật trừ áo ba lỗ): vai đủ rộng (100 %), dốc xuôi từ cổ (khớp vai hạ thấp + khối
        # cơ vai liền từ cổ ra tay), tay buông gần thẳng; sườn dưới nách thu lại cho tay / tay áo không dính vào thân.
        self.slope = self.bare or self.sleeve != "none"
        self.shk = 1.0 if self.slope else 0.82  # áo ba lỗ: vai hẹp 82 % (khớp cầu kiểu cũ)
        if self.bare:
            self.shk = 1.08  # vai trần: rộng hơn bản cũ (0.92) ~17 % → cân với hông / mông, vai tròn mềm (không cơ bắp)
        # Tay chân theo bề ngang (không theo bề dày bụng) → người mũm mĩm không bị đùi / tay áo phình hơn thân;
        # tay còn co theo chiều dài tay (trẻ em tay ngắn thì cũng thon hơn).
        self.armR = max(0.66, 0.5 * (self.sw + self.sa)) * self.limb * (1.1 if self.kid else 1.0)  # tay trẻ em tròn mềm
        if self.base_prop:  # (cả bản mặc đồ cùng dáng gốc – tay lộ ra giống hệt nhân vật gốc)
            self.armR *= 1.15  # vai trần rộng 100 % + khối cơ vai: cánh tay dày hơn cho cân (không "vai độn, tay que")
        self.legR = self.sw * self.limb * (1.1 if self.kid else 1.0)  # chân trẻ em đầy, mềm
        if self.base_kid:
            self.legR *= 1.08  # chân dài hơn → đầy thêm cho khỏi thành "chân que"
        self.hand = max(0.5 * (self.sa + self.sw), 0.74 if self.kid else 0.0)  # bàn tay trẻ em to hơn chút kiểu hoạt hình
        # ngón trẻ em: ngắn, mập (hoạt hình) – không mảnh / dài như tay người lớn
        self.finger_r, self.finger_l = (1.15, 0.8) if self.kid else (1.0, 1.0)
        # vai trần (bàn tay đúc chung lớp da với thân, voxel thô hơn): ngón thon, dài hơn, xoè xa nhau hơn → từng ngón
        # tách rõ, không dính thành một khối
        self.finger_spread = 1.0
        self.finger_splay = 0.0  # độ xoè ngón (độ, ngón ngoài cùng) – đầu ngón tách nhau rõ
        self.knuckle = 0.082  # cổ tay → khớp gốc ngón (× hand)
        if self.base_prop:
            # bàn tay nhân vật gốc (cả bản mặc đồ cùng dáng gốc): lòng bàn tay ngắn lại, ngón dài + tròn hơn, xoè nhẹ → 5 ngón tách rõ, cân với cánh tay
            self.finger_r, self.finger_l = (1.05, 1.18) if self.kid else (0.95, 1.1)
            self.finger_spread = 1.6
            self.finger_splay = 9.0
            self.knuckle = 0.072

        self.ank = 0.10 * self.sf
        self.H = self.ank + 0.76 * self.sl  # khớp hông (đầu xương Hips)
        self.N = self.H + 0.47 * self.st  # chân cổ
        head_bone = self.N + 0.09 * self.sn * (1.3 if (spec.get("top") or {}).get("style") == "none" else 1.0)  # vai trần: cổ lộ rõ
        self.head_c = Vector((0, 0.005, head_bone + 0.135))
        self.neck_r = 0.056 * (0.5 + 0.5 * self.sw) * self.limb ** 0.5
        if (spec.get("top") or {}).get("style") == "none":
            self.neck_r *= 1.3  # cổ chắc, rõ (đúc liền vào vai – merge_body)
        # độ cao khớp vai: vai dốc hạ nhẹ (vai trần 2 %, có áo 4.5 % chiều cao thân) – hạ nhiều quá thì vai xệ, cụt cổ
        # vai trần: hạ như có áo (4.5 %) → đỉnh đầu vai ngang chân cổ / xương quai xanh, không nhô cao hơn
        self.shz = self.tz(1.30) - (0.045 * self.st if self.slope else 0.0)

        prof = TORSO_F if self.female and not self.kid else TORSO_M
        self.torso = []
        for z, rx, ry in prof:
            if self.chubby and 0.95 <= z <= 1.16:
                rx, ry = rx * 1.03, ry * 1.08  # bụng hơi tròn (không thành thùng)
            if self.age == "toddler" and 0.95 <= z <= 1.12:
                ry *= 1.05
            rx *= 1 + (self.shk - 1) * mc.smooth01((z - 1.15) / 0.12)  # thu cùng tỉ lệ với vai → tay không lún vào thân
            if self.bare:  # bụng dưới + hông thon 12 % (lên tới ngực thì như cũ) → vai rộng hơn hông, không "to mông"
                rx *= 1 - 0.12 * (1 - mc.smooth01((z - 1.0) / 0.18))
            if self.slope:  # vai dốc: ngực trên vuốt thon vào cổ → không còn góc vai vuông nhô trên chỗ nối tay
                rx *= 1 - 0.18 * mc.smooth01((z - 1.24) / 0.1)
            if self.bare:  # ngực trên / xương quai xanh đầy hơn → cổ nối vào vai qua một mặt cong mềm, không hõm
                ry *= 1 + 0.09 * math.exp(-((z - 1.3) / 0.055) ** 2)
                rx *= 1 + 0.05 * math.exp(-((z - 1.31) / 0.05) ** 2)
            self.torso.append((self.tz(z), rx * self.sw, ry * self.sd))

        t = self.tz
        B = {
            "Hips": ((0, 0, self.H), (0, 0, t(0.98)), None),
            "Spine": ((0, 0, t(0.98)), (0, 0, t(1.15)), "Hips"),
            "Chest": ((0, 0, t(1.15)), (0, 0, self.N), "Spine"),
            "Neck": ((0, 0, self.N), (0, 0, head_bone), "Chest"),
            "Head": ((0, 0, head_bone), (0, 0, head_bone + 0.34), "Neck"),
        }
        self.hipk = 1.06 if self.female else 1.0
        hip_x = 0.068 * self.sw * self.hipk * (0.9 if self.bare else 1.0)  # chân sát nhau → đùi đầy, không hở giữa hai chân
        # Đùi / ống quần không rộng hơn gấu áo: mép ngoài ống quần (bán kính đùi × 1.05) nằm trong gấu áo 6 mm
        # → nhìn thẳng không có phần hông / đùi nhô ra hai bên áo.
        self.hem_rx = self.torso[0][1]
        self.crotch = self.H - 0.07 * self.st  # đáy quần (hai đùi tách nhau từ đây)
        self.thigh_k = min(1.0, (self.hem_rx - 0.006 - hip_x) / (0.086 * self.legR * 1.05))
        if self.bare:  # không áo: đùi chỉ cần không rộng quá hông (không có gấu áo phải tránh) → đùi đầy hơn bắp chân
            self.thigh_k = min(1.0, (self.hem_rx + 0.004 - hip_x) / (0.086 * self.legR))
        knee = self.ank + 0.38 * self.sl
        self.fingers = {}
        for s, sx in (("L", 1), ("R", -1)):
            shz = self.shz
            # vai dốc: khớp vai hơi ra trước (như người thật) → nhìn nghiêng cánh tay không áp vào lưng
            sy = -0.2 * self.torso_r(shz)[1] if self.slope else 0.0
            S = Vector((0.212 * self.sw * self.shk * sx, sy, shz))
            # (vai trần: tay vẫn cách sườn vài mm → khi đúc thành một lớp da, tay không dính vào thân)
            out_e, out_w = (0.032, 0.016) if self.slope else (0.042, 0.024)
            E = S + Vector((out_e * self.sw * sx, -0.012 * self.sa, -0.26 * self.sa))  # khuỷu hơi ra trước → tay cong mềm
            W = E + Vector((out_w * self.sw * sx, -0.024 * self.sa, -0.23 * self.sa))
            Ht = W + Vector((0.007 * sx * self.hand, -0.008 * self.hand, -0.11 * self.hand))
            B.update({
                f"Shoulder.{s}": ((0.03 * sx * self.sw, 0, shz), (0.2 * sx * self.sw * self.shk, sy, shz), "Chest"),
                f"UpperArm.{s}": (tuple(S), tuple(E), f"Shoulder.{s}"),
                f"LowerArm.{s}": (tuple(E), tuple(W), f"UpperArm.{s}"),
                f"Hand.{s}": (tuple(W), tuple(Ht), f"LowerArm.{s}"),
                f"UpperLeg.{s}": ((hip_x * sx, 0, self.H + 0.02 * self.st), (hip_x * sx, 0, knee), "Hips"),
                f"LowerLeg.{s}": ((hip_x * sx, 0, knee), (hip_x * sx, 0.01 * self.sf, self.ank), f"UpperLeg.{s}"),
                f"Foot.{s}": ((hip_x * sx, 0.01 * self.sf, self.ank), (hip_x * sx, -0.12 * self.sf, 0.03 * self.sf), f"LowerLeg.{s}"),
            })
            self.fingers[s] = self.hand_bones(B, s, sx, W, Ht)
        self.bones = B
        if self.slope:
            # vai trần: tay đúc chung lớp da với thân (voxel mịn) · có áo: tay áo đúc chung với thân áo (voxel thô hơn)
            self.clear_arms(0.009 if self.bare else 0.0042 * max(self.sw, 0.8) * 2.3)
        # make_character đọc các biến này lúc chạy (hình đầu, khuôn mặt, xương, retarget).
        mc.BONES = B
        for s, m in (("L", "Left"), ("R", "Right")):
            for fn in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
                for i in (1, 2, 3):
                    mc.MIXAMO_MAP[f"{fn}{i}.{s}"] = f"{m}Hand{fn}{i}"
        mc.HEAD_C = self.head_c
        mc.EYE_RX *= self.eye
        mc.EYE_RZ *= self.eye
        mc.LASHES = self.female

    def clear_arms(self, gap=0.006):
        """
        Vai trần (thân + tay đúc thành một lớp da): sườn dưới nách thu lại cho cách mặt trong cánh tay ≥ `gap` →
        khi đúc tay không dính vào sườn (dính thì đánh tay lúc đi / chạy kéo theo cả mảng da nách).
        """
        S, E, W = Vector(self.bones["UpperArm.L"][0]), Vector(self.bones["UpperArm.L"][1]), Vector(self.bones["LowerArm.L"][1])

        rb = 0.054 * self.armR  # ống tay áo ở vai (như build_body)
        L1, L2 = (E - S).length, (W - E).length

        def radius(t):  # bán kính ngoài của tay (da hoặc tay áo) tại t (0 = vai, 0.5 = khuỷu, 1 = cổ tay)
            r = interp(ARM_PROF, t) * self.armR
            if self.sleeve == "short" and t <= 0.225:
                r = max(r, rb * 1.03 * (1 + 0.04 * t / 0.225))
            elif self.sleeve == "long":
                d = (t * 2 * L1 if t <= 0.5 else L1 + (t - 0.5) * 2 * L2) / (L1 + L2 * 0.94)
                r = max(r, interp([(0, 1.0), (0.4, 0.95), (0.7, 0.88), (1, 0.8)], min(d, 1.0)) * rb * 1.03)
            return r

        def inner_x(z):  # mép trong cánh tay ở độ cao z
            for a, b, t0, t1 in ((S, E, 0.0, 0.5), (E, W, 0.5, 1.0)):
                if b.z <= z <= a.z:
                    k = (a.z - z) / max(a.z - b.z, 1e-6)
                    return a.x + (b.x - a.x) * k - radius(t0 + (t1 - t0) * k)
            return None

        top = S.z - 0.02 * self.armR  # dưới khớp vai (chỏm vai để nguyên)
        # thêm mặt cắt dày ở vùng nách (mặt cắt gốc thưa → nội suy giữa hai mặt cắt vẫn chạm tay)
        zs = [c[0] for c in self.torso]
        extra = [top - 0.012 * i for i in range(6) if zs[0] < top - 0.012 * i < zs[-1]]
        for z in extra:
            if min(abs(z - q) for q in zs) > 0.004:
                rx, ry = self.torso_r(z)
                self.torso.append((z, rx, ry))
        self.torso.sort(key=lambda c: c[0])
        for i, (z, rx, ry) in enumerate(self.torso):
            if i == 0 or z > top:
                continue  # gấu thân giữ nguyên (đùi / hông tính theo nó)
            x = inner_x(z)
            if x is not None and rx > x - gap:
                self.torso[i] = (z, x - gap, ry)

    def hand_bones(self, B, s, sx, W, Ht):
        """
        Xương ngón (3 đốt – trùng Mixamo Thumb/Index/Middle/Ring/Pinky 1..3 → động tác chỉ tay, giơ ngón cái… cử động
        ngón thật). Tay buông: lòng bàn tay hướng vào thân, ngón cái chỉ ra trước, các ngón hơi khum.
        Trả về {ngón: (các khớp, bán kính)} để dựng hình.
        """
        hk = self.hand
        d = (Ht - W).normalized()  # dọc bàn tay, xuống
        f = Vector((0, -1, 0))
        f = (f - d * f.dot(d)).normalized()  # ra trước
        n = d.cross(f).normalized()  # pháp tuyến lòng bàn tay
        if n.x * sx > 0:
            n = -n  # hướng vào thân
        out = {}

        def chain(name, base, direction, lengths, curl, r):
            pts, dirv = [base], direction.normalized()
            for i, L in enumerate(lengths):
                dirv = (dirv * math.cos(math.radians(curl[i])) + n * math.sin(math.radians(curl[i]))).normalized()
                pts.append(pts[-1] + dirv * L * hk)
            parent = f"Hand.{s}"
            for i in range(len(lengths)):
                bn = f"{name}{i + 1}.{s}"
                B[bn] = (tuple(pts[i]), tuple(pts[i + 1]), parent)
                parent = bn
            out[name] = (pts, r * hk)

        knuckle = W + d * self.knuckle * hk
        fr, fl = self.finger_r, self.finger_l
        for name, off, L, r in (("Index", 0.021, 0.048, 0.0088), ("Middle", 0.007, 0.052, 0.009), ("Ring", -0.007, 0.049, 0.0086), ("Pinky", -0.02, 0.04, 0.0076)):
            base = knuckle + f * off * self.finger_spread * hk + n * 0.002 * hk
            a = math.radians(self.finger_splay * off / 0.021)  # ngón ngoài xoè ra xa hơn ngón giữa
            chain(name, base, d * math.cos(a) + f * math.sin(a), [L * fl * 0.45, L * fl * 0.3, L * fl * 0.25], (8, 14, 12), r * fr)
        thumb = W + d * 0.028 * hk + f * (0.024 + 0.008 * (self.finger_spread - 1) / 0.45) * hk + n * 0.006 * hk
        chain("Thumb", thumb, f * 0.6 + d * 0.75 + n * 0.25, [0.024 * fl, 0.02 * fl, 0.018 * fl], (0, 10, 10), 0.0105 * fr)
        return out

    def tz(self, z):
        """Cao độ mẫu người lớn (make_character) → cao độ của nhân vật này (dưới cổ co theo thân, trên cổ tịnh tiến)."""
        return self.H + (z - 0.86) * self.st if z <= 1.33 else self.N + (z - 1.33) * self.sn

    def bone(self, name, i=0):
        return Vector(self.bones[name][i])

    def torso_r(self, z):
        zs = [c[0] for c in self.torso]
        return interp(list(zip(zs, [c[1] for c in self.torso])), z), interp(list(zip(zs, [c[2] for c in self.torso])), z)

    def on_torso(self, a, z, off):
        """Điểm trên mặt thân: góc a (0 = chính diện, + về bên trái), cao độ z, đẩy ra `off`."""
        rx, ry = self.torso_r(z)
        return Vector(((rx + off) * math.sin(a), -(ry + off) * math.cos(a), z))


# ---------------------------------------------------------------- vật liệu

def pattern_image(kind, base, c2, size=256):
    """Hoạ tiết áo (tất định): sọc ngang, chấm bi, kẻ caro, hoa lá."""
    px = [base] * (size * size)
    rnd = random.Random(5)

    def disc(cx, cy, r, color, petals=0, rot=0.0):
        for y in range(int(cy - r - 2), int(cy + r + 3)):
            for x in range(int(cx - r - 2), int(cx + r + 3)):
                dx, dy = x - cx, y - cy
                rr = r * (0.55 + 0.45 * abs(math.cos(petals * (math.atan2(dy, dx) + rot) / 2))) if petals else r
                if dx * dx + dy * dy <= rr * rr:
                    px[(y % size) * size + (x % size)] = color

    if kind == "stripes":
        for y in range(size):
            if (y // 16) % 2:
                px[y * size:(y + 1) * size] = [c2] * size
    elif kind == "dots":
        for row, cy in enumerate(range(16, size, 32)):
            for cx in range(16 * (row % 2), size + 16, 32):
                disc(cx, cy, 6.5, c2)
    elif kind == "plaid":
        half = mix(base, c2, 0.5)
        for y in range(size):
            for x in range(size):
                h, v = (y % 48) < 12, (x % 48) < 12
                if h and v:
                    px[y * size + x] = c2
                elif h or v:
                    px[y * size + x] = half
    elif kind == "flowers":
        leaf = mix(base, (0.12, 0.5, 0.3), 0.65)
        c3 = mix(c2, (1.0, 0.82, 0.25), 0.6)
        for _ in range(24):
            disc(rnd.uniform(0, size), rnd.uniform(0, size), rnd.uniform(8, 13), leaf, petals=2, rot=rnd.uniform(0, 3))
        for _ in range(16):
            cx, cy = rnd.uniform(0, size), rnd.uniform(0, size)
            col = c2 if rnd.random() < 0.6 else c3
            disc(cx, cy, rnd.uniform(9, 15), col, petals=5, rot=rnd.uniform(0, 3))
            disc(cx, cy, 3.5, c3 if col == c2 else c2)
    img = bpy.data.images.new("TopPattern", size, size)
    flat = []
    for p in px:  # ảnh trong Blender là tuyến tính
        flat += [mc.srgb_to_lin(p[0]), mc.srgb_to_lin(p[1]), mc.srgb_to_lin(p[2]), 1.0]
    img.pixels = flat
    img.pack()
    return img


# ---------------------------------------------------------------- tóc

def hair_surface(name, bottom, lift, material, top=lambda a: 1.0, phi0=-pi, phi1=pi, cols=72, rows=18, edge_in=0.012, hang=0.0):
    """
    Mảng ôm đầu giữa hai đường cao độ top(|phương vị|) → bottom(|phương vị|) trong khoảng phương vị [phi0, phi1]
    (đủ vòng = khép kín). hang > 0: phần dưới xích đạo rủ thẳng xuống (tóc bob / dài) thay vì ôm theo hàm.
    """
    closed = phi1 - phi0 >= 2 * pi - 1e-6
    ncol = cols if closed else cols + 1
    verts, faces = [], []
    for i in range(rows + 1):
        f = i / rows
        lift_i = lift - (lift - edge_in) * max(0.0, (f - 0.8) / 0.2)
        for j in range(ncol):
            ph = phi0 + (phi1 - phi0) * j / cols
            a = abs((ph + pi) % (2 * pi) - pi)
            t, b = top(a), bottom(a)
            dz = t - (t - b) * f
            p = mc.head_point(mc.head_dir(math.acos(clamp1(dz)), ph), lift_i)
            if hang > 0 and dz < 0:
                eq = mc.head_point(mc.head_dir(pi / 2, ph), lift_i)
                q = Vector((eq.x, eq.y, mc.HEAD_C.z + dz * mc.HEAD_RZ * (1 + lift_i)))
                p = p.lerp(q, mc.smooth01(-dz / 0.35) * hang)
            verts.append(p)
    for i in range(rows):
        for j in range(cols):
            a = i * ncol + j
            b = i * ncol + (j + 1) % ncol if closed else a + 1
            faces.append((a, a + ncol, b + ncol, b))
    return mc.new_obj(name, verts, faces, material, ["Head"], None, True)


def locks(rows_spec, mats, rnd, width=0.03, thick=0.013):
    """Lọn tóc dẹt mọc từ đầu (như mái vuốt của make_character): (dz gốc, phạm vi phương vị, số lọn, dài, kiểu)."""
    up, back = Vector((0, 0, 1)), Vector((0, 1, 0))
    k = 0
    for dz0, span, count, L, kind in rows_spec:
        for c in range(count):
            ph = -span / 2 + span * (c + 0.5) / count + rnd.uniform(-0.05, 0.05)
            if kind == "back":
                ph = pi - span / 2 + span * (c + 0.5) / count
            th = math.acos(clamp1(dz0 + rnd.uniform(-0.03, 0.03)))
            root = mc.head_point(mc.head_dir(th, ph), 0.03)
            n = (root - mc.HEAD_C).normalized()
            lat = Vector((math.sin(ph), 0, 0))
            if kind == "front":
                g1 = (n * 0.45 + up * 1.0 + Vector((0, -0.25, 0))).normalized()
                g2 = (up * 0.35 + back * 1.0 + lat * 0.25).normalized()
            elif kind == "top":
                g1 = (n * 0.4 + up * 0.7 + back * 0.4).normalized()
                g2 = (back * 1.0 + up * 0.1 + lat * 0.3).normalized()
            else:
                g1 = (n * 0.4 + back * 0.6 + up * 0.3).normalized()
                g2 = (back * 0.6 - up * 0.6 + n * 0.3).normalized()
            L2 = L * rnd.uniform(0.85, 1.15)
            p1 = root + g1 * L2 * 0.55
            pts = mc.bezier(root, p1, p1 + g2 * L2 * 0.55)
            m = len(pts)
            widths = [width * (1 - 0.85 * (i / (m - 1)) ** 1.3) for i in range(m)]
            thicks = [thick * (1 - 0.7 * i / (m - 1)) for i in range(m)]
            mc.strand(f"Lock{k}", pts, widths, thicks, mats[k % len(mats)], ["Head"])
            k += 1


def tail(name, root, ctrl, end, r0, material):
    pts = mc.bezier(root, ctrl, end, 9)
    radii = [r0 * (1 - 0.7 * (i / 8) ** 1.2) for i in range(9)]
    mc.limb_path(name, pts, radii, material, ["Head"], segs=12)


def build_hair(style, color, hat, body, rnd):
    main = mc.mat("Hair", color, 0.6)
    dark = mc.mat("HairDark", shade(color, 0.8), 0.7)
    hl = lambda a: interp(FULL, a)  # noqa: E731
    if style == "spiky" and hat:
        style = "short"
    if style == "spiky":
        hl = lambda a: interp(mc.HAIRLINE, a)  # noqa: E731 – kiểu vuốt dựng: cạo hai bên
    if style == "bald":
        # vành tóc hai bên + sau gáy
        hair_surface("HairRing", hl, 0.018, main, top=lambda a: 0.3, phi0=1.8, phi1=2 * pi - 1.8, cols=40, rows=8, edge_in=0.004)
    elif style == "short":
        hair_surface("Hair", hl, 0.032, main, edge_in=0.006)
        if not hat:
            locks([(0.64, 0.9, 7, 0.06, "top"), (0.8, 0.6, 4, 0.05, "top")], [main, dark], rnd, width=0.026, thick=0.011)
    elif style == "spiky":
        mc.shell("HairSide", hl, 0.024, dark, ["Head"], edge_in=0.004)
        mc.shell("HairTop", lambda a: interp(mc.CROWN, a) - 0.02, 0.05, main, ["Head"], edge_in=0.026)
        locks([(0.62, 1.0, 9, 0.13, "front"), (0.72, 0.8, 7, 0.11, "front"), (0.84, 0.6, 5, 0.09, "top"),
               (0.93, 0.5, 3, 0.08, "top"), (0.72, 2.6, 8, 0.07, "back")], [dark, main, main], rnd)
    elif style in ("curly", "afro"):
        hair_surface("Hair", hl, 0.03, main, edge_in=0.006)
        if not hat:
            count, r, lift, front = (46, 0.034, 0.035, 0.62) if style == "curly" else (80, 0.058, 0.07, 0.7)
            for i in range(count):
                ph = rnd.uniform(-pi, pi)
                lo = max(hl(abs(ph)) + 0.1, front if abs(ph) < 0.9 else -1.0)
                c = mc.head_point(mc.head_dir(math.acos(clamp1(rnd.uniform(lo, 1.0))), ph), lift)
                rr = r * rnd.uniform(0.8, 1.15)
                mc.ellipsoid(f"Curl{i}", c, (rr, rr, rr), main if i % 3 else dark, ["Head"], segs=10, rings=6)
    elif style in ("bob", "long"):
        hair_surface("Hair", (lambda a: interp(BOB, a)) if style == "bob" else (lambda a: interp(LONG, a)), 0.045, main, edge_in=0.014, hang=1.0)
        if style == "long":
            # suối tóc sau lưng: từ sau đầu rủ xuống giữa lưng (nửa trước nằm trong đầu / cổ / thân)
            z0, zb = mc.HEAD_C.z + 0.02, body.tz(1.12)
            back = body.torso_r(body.tz(1.23))[1] + 0.005
            secs = []
            for i in range(9):
                t = i / 8
                secs.append(((0, 0.05 + (back - 0.05) * t, z0 + (zb - z0) * t), 0.165 + (0.13 * max(body.sw, 0.8) - 0.165) * t, 0.15 - 0.1 * t ** 0.5))
            ob = mc.loft("HairBack", secs, main, ["Chest", "Head"], segs=24, cap_start=False)
            w = mc.chain_weights(["Chest", ((0, 0, body.bone("Head").z), (0, 0, 1), 0.06, "Head")])
            mc.PARTS[-1] = (ob, ["Chest", "Head"], w)
    elif style in ("ponytail", "pigtails", "bun"):
        hair_surface("Hair", lambda a: interp(TIGHT, a), 0.034, main, edge_in=0.008)
        tie = mc.mat("HairTie", rgb(SPEC.get("accessoryColor"), (1.0, 0.4, 0.5)), 0.5)
        L = 0.3 * max(body.st, 0.6)
        if style == "ponytail":
            root = mc.head_point(mc.head_dir(math.acos(0.25), pi), 0.03)
            mc.torus("PonyTie", root + Vector((0, 0.012, 0)), 0.03, 0.011, tie, ["Head"], tilt=pi / 2)
            tail("Ponytail", root, root + Vector((0, 0.13, -0.02)), root + Vector((0, 0.13, -L)), 0.042, main)
        elif style == "pigtails":
            for sx in (1, -1):
                root = mc.head_point(mc.head_dir(math.acos(0.1), sx * 2.1), 0.03)
                mc.ellipsoid(f"PigTie.{sx}", root, (0.02, 0.02, 0.02), tie, ["Head"], segs=10, rings=6)
                tail(f"Pigtail.{sx}", root, root + Vector((0.07 * sx, 0.03, -0.02)), root + Vector((0.1 * sx, 0.05, -0.7 * L)), 0.036, main)
        elif not hat:
            c = mc.head_point(mc.head_dir(math.acos(0.72), pi), 0.06)
            mc.ellipsoid("Bun", c, (0.075, 0.07, 0.07), main, ["Head"], segs=16, rings=10)
            mc.torus("BunTie", c + Vector((0, -0.03, -0.035)), 0.045, 0.009, tie, ["Head"], tilt=0.5)


def build_facial_hair(kind, color):
    if kind == "none":
        return
    m = mc.mat("Beard", color, 0.75)
    if kind == "beard":
        hair_surface("Beard", lambda a: -0.995, 0.022, m, top=lambda a: interp([(0, -0.84), (0.5, -0.8), (0.85, -0.55), (1.15, 0.05), (1.45, 0.25)], a),
                     phi0=-1.45, phi1=1.45, cols=40, rows=10, edge_in=0.01)
    for sx in (1, -1):
        mc.ellipsoid(f"Mustache.{sx}", mc.on_head(0.021 * sx, mc.MOUTH_Z + 0.025, 0.007), (0.026, 0.009, 0.011), m, ["Head"], segs=12, rings=6)


# ---------------------------------------------------------------- phụ kiện đầu

def build_glasses(sun, color):
    frame = mc.mat("GlassFrame", color, 0.35, 0.2)
    lens = mc.mat("Lens", (0.05, 0.05, 0.08), 0.15)
    rx, rz = 0.045 * mc.EYE_RX / 0.029, 0.04 * mc.EYE_RZ / 0.036
    for sx in (1, -1):
        c = mc.on_head(sx * mc.EYE_X, mc.EYE_Z + 0.002, 0.026)
        ring = [c + Vector((rx * math.cos(2 * pi * i / 20), 0, rz * math.sin(2 * pi * i / 20))) for i in range(21)]
        mc.limb_path(f"Rim.{sx}", ring, [0.0045] * len(ring), frame, ["Head"], segs=6, caps=False)
        if sun:
            mc.ellipsoid(f"Lens.{sx}", c + Vector((0, 0.002, 0)), (rx, 0.005, rz), lens, ["Head"], segs=16, rings=8)
        ear = mc.head_point(mc.head_dir(pi / 2 - 0.03, sx * (pi / 2 + 0.05)), 0.012)
        mid = mc.head_point(mc.head_dir(pi / 2 - 0.1, sx * 1.0), 0.035)
        mc.limb_path(f"Temple.{sx}", [c + Vector((rx * sx, 0, 0.004)), mid, ear], [0.0038] * 3, frame, ["Head"], segs=6)
    y, z = mc.on_head(0, mc.EYE_Z, 0.026).y, mc.on_head(mc.EYE_X, mc.EYE_Z + 0.008, 0.026).z
    mc.limb("Bridge", (mc.EYE_X - rx, y, z), (-(mc.EYE_X - rx), y, z), [(0, 0.004), (1, 0.004)], frame, ["Head"], segs=6)


def build_hat(kind, color, accent):
    m = mc.mat("Hat", color, 0.7)
    rx, ry, rz = mc.HEAD_RX, mc.HEAD_RY, mc.HEAD_RZ
    c = mc.HEAD_C + Vector((0, 0.008, 0.012))
    if kind == "cap":
        # ôm sát đầu (chỉ cách lớp tóc ~1 cm), phủ thấp hơn, vành mũ mỏng, dây quai dưới cằm; không có núm đỉnh
        cut = 0.52  # mép mũ trên lông mày (kể cả khi nhướng) → lông mày luôn thấy, biểu cảm được
        c = mc.HEAD_C + Vector((0, 0.004, 0.006))
        r = (rx + 0.015, ry + 0.016, rz + 0.012)
        mc.ellipsoid("Cap", c, r, m, ["Head"], segs=32, rings=16, cut=cut)
        mc.ellipsoid("CapBrim", c + Vector((0, -r[1] * 0.95 - 0.045, cut * r[2] + 0.002)), (0.098, 0.072, 0.009), m, ["Head"], segs=28, rings=8)
        strap = mc.mat("HatStrap", shade(color, 0.86), 0.7)
        # dây quai: cung mượt ôm theo mặt (cách da), từ mép mũ bên này vòng dưới cằm sang bên kia
        th0 = math.acos(cut * 0.95)
        side = [mc.head_point(mc.head_dir(th0 + (pi - 0.03 - th0) * t, 1.5 * (1 - t ** 2.5)), 0.065) for t in (i / 16 for i in range(17))]
        pts = side + [Vector((-p.x, p.y, p.z)) for p in reversed(side[:-1])]
        mc.limb_path("CapStrap", pts, [0.0058] * len(pts), strap, ["Head"], segs=8, caps=True)
    elif kind == "beanie":
        r = (rx + 0.034, ry + 0.036, rz + 0.034)
        mc.ellipsoid("Beanie", c, r, m, ["Head"], segs=28, rings=14, cut=0.38)
        band = [c + Vector(((r[0] + 0.006) * math.cos(2 * pi * i / 32), (r[1] + 0.006) * math.sin(2 * pi * i / 32), 0.38 * r[2] * 0.97)) for i in range(33)]
        mc.limb_path("BeanieBand", band, [0.018] * len(band), mc.mat("HatBand", shade(color, 0.8), 0.8), ["Head"], segs=8, caps=False)
        mc.ellipsoid("Pompom", c + Vector((0, 0, r[2] + 0.025)), (0.04, 0.04, 0.036), mc.mat("HatAccent", accent, 0.9), ["Head"], segs=14, rings=8)
    elif kind == "sunhat":
        cut = 0.45
        r = (rx + 0.032, ry + 0.034, rz + 0.04)
        mc.ellipsoid("SunHat", c, r, m, ["Head"], segs=28, rings=14, cut=cut)
        mc.ellipsoid("SunHatBrim", c + Vector((0, 0, cut * r[2])), (0.3, 0.29, 0.01), m, ["Head"], segs=36, rings=10)
        band = [c + Vector(((r[0] * 0.9 + 0.003) * math.cos(2 * pi * i / 32), (r[1] * 0.9 + 0.003) * math.sin(2 * pi * i / 32), cut * r[2] + 0.02)) for i in range(33)]
        mc.limb_path("SunHatBand", band, [0.012] * len(band), mc.mat("HatAccent", accent, 0.6), ["Head"], segs=8, caps=False)


# ---------------------------------------------------------------- khớp vai + bàn tay

def uv_by_height(ob, body):
    """
    Toạ độ v của hoạ tiết theo độ cao (tư thế nghỉ), cùng một thước cho thân, vai, tay áo → sọc / chấm chạy liền
    từ thân sang vai sang tay áo, khoảng cách đều (loft theo mặt cắt thì sọc thưa / dày theo từng đoạn).
    """
    uv = ob.data.uv_layers.active
    if uv is None:
        return ob
    z0, z1 = body.torso[0][0], body.torso[-1][0]
    k = PATTERN_V / max(z1 - z0, 1e-3)
    off = pattern_phase(body)
    for loop in ob.data.loops:
        uv.data[loop.index].uv = (uv.data[loop.index].uv[0], (ob.data.vertices[loop.vertex_index].co.z - z0) * k + off)
    return ob


def pattern_phase(body):
    """
    Dịch pha hoạ tiết để đúng độ cao đỉnh vai rơi vào giữa dải nền (sọc trắng): mặt nằm ngang trên đỉnh vai chỉ ăn
    một màu → là màu nền nhạt thay vì một mảng sọc đậm nổi bật.
    """
    z0, z1 = body.torso[0][0], body.torso[-1][0]
    k = PATTERN_V / max(z1 - z0, 1e-3)
    top = body.bone("UpperArm.L").z + 0.054 * body.armR
    period = 32 / 256  # một cặp sọc (pattern_image: dải 16 px / ảnh 256 px)
    return (8 / 256 - (top - z0) * k) % period


def uv_sphere(name, c, r, material, bones, segs=18, rings=10):
    """Cầu có UV (hoạ tiết áo dán lên được) – dùng làm khớp vai."""
    c = Vector(c)
    verts, faces, uvs = [], [], []
    for i in range(rings + 1):
        th = pi * i / rings
        for j in range(segs + 1):
            ph = 2 * pi * j / segs
            verts.append(c + Vector((r * math.sin(th) * math.cos(ph), r * math.sin(th) * math.sin(ph), r * math.cos(th))))
            uvs.append((j / segs, 0.5 * (1 - i / rings)))
    for i in range(rings):
        for j in range(segs):
            a = i * (segs + 1) + j
            faces.append((a, a + segs + 1, a + segs + 2, a + 1))
    return mc.new_obj(name, verts, faces, material, bones, uvs)


def build_hand(body, s, wr, ha, skin):
    """Lòng bàn tay dẹt + 5 ngón (ống 3 đốt, đầu ngón tròn), trọng lượng chuyển mượt qua từng khớp ngón."""
    hk = body.hand
    d = (ha - wr).normalized()
    pr = (0.025, 0.038, 0.047) if body.kid else (0.02, 0.035, 0.05)  # lòng bàn tay trẻ em dày, tròn
    pc = 0.045
    if body.base_prop:  # tay nhân vật gốc: lòng bàn tay dẹt hơn, ngắn hơn (theo khớp gốc ngón) → bàn tay không thành cục
        pr, pc = (0.019, 0.037, 0.042), 0.04
    mc.ellipsoid(f"Palm.{s}", wr + d * pc * hk, (pr[0] * hk, pr[1] * hk, pr[2] * hk), skin, [f"Hand.{s}"], segs=24, rings=14)
    for name, (pts, r) in body.fingers[s].items():
        first = (pts[1] - pts[0]).normalized()
        start = pts[0] - first * (0.02 if name == "Thumb" else 0.012) * hk  # chìm vào lòng bàn tay
        chain = [f"Hand.{s}"] + [(pts[i], pts[i + 1] - pts[i], 0.005 * hk, f"{name}{i + 1}.{s}") for i in range(3)]
        path, ts = mc.polyline([start] + pts, 3)
        radii = [r * (1.12 - 0.3 * t) for t in ts]
        bones = [f"Hand.{s}"] + [f"{name}{i}.{s}" for i in (1, 2, 3)]
        mc.limb_path(f"{name}.{s}", path, radii, skin, bones, segs=14 if body.base_prop else 10, caps="start", weights=mc.chain_weights(chain))
        tip = r * (1.12 - 0.3)
        mc.ellipsoid(f"{name}Tip.{s}", pts[-1], (tip, tip, tip), skin, [f"{name}3.{s}"], segs=14 if body.base_prop else 10, rings=8 if body.base_prop else 6)


# ---------------------------------------------------------------- thân

def torso_weights(body):
    """
    Trọng lượng thân áo, tính theo vị trí (thay cho "xương gần nhất" – xương vai chạy ngang trên ngực nên ngực / lưng
    bị kéo méo mỗi khi vai cử động):
      - dọc thân: Hips → Spine → Chest chuyển mượt ở hai khớp lưng;
      - vai: chỉ mép ngoài đầu vai (≥ 72 % bề ngang thân, gần độ cao vai) theo xương vai, tối đa 50 %;
      - gấu áo: theo đùi một chút (≤ 30 %) để đùi không đâm thủng gấu khi đá chân.
    """
    t = body.tz
    spine = mc.chain_weights(["Hips", ((0, 0, t(0.98)), (0, 0, 1), 0.06 * body.st, "Spine"), ((0, 0, t(1.15)), (0, 0, 1), 0.06 * body.st, "Chest")])
    shz = body.shz
    hem = body.torso[0][0]

    def fn(p):
        ws = spine(p)
        rx, _ = body.torso_r(p.z)
        for s, sx in (("L", 1), ("R", -1)):
            f = 0.5 * mc.smooth01((p.x * sx / max(rx, 1e-3) - 0.72) / 0.25) * mc.smooth01((p.z - (shz - 0.07 * body.st)) / (0.05 * body.st))
            moved = ws.get("Chest", 0.0) * f
            if moved > 0:
                ws["Chest"] -= moved
                ws[f"Shoulder.{s}"] = moved
        k = 0.3 * mc.smooth01((hem + 0.03 * body.st - p.z) / (0.03 * body.st))
        if k > 0 and ws.get("Hips", 0.0) > 0:
            h = ws["Hips"] * k
            ws["Hips"] -= h
            ws["UpperLeg.L"] = h * mc.smooth01(0.5 + p.x / 0.1)
            ws["UpperLeg.R"] = h - ws["UpperLeg.L"]
        return ws

    return fn


def build_seat(body, material, k):
    """
    Tấm lấp khe giữa hai ống quần, từ trong áo xuống tới đũng. Hai ống quần (liền một mạch từ trong áo xuống gấu)
    tạo mặt ngoài; tấm này có mặt cắt "viên thuốc" nhỏ hơn ống quần 3 % – hai đầu tròn nằm khuất trong ống, chỉ mặt
    phẳng trước / sau lộ ra giữa hai ống và gặp ống theo một nếp dọc (như đường may giữa quần), không trùng mặt nào.
    Trên hông theo xương hông; từ hông xuống đũng chuyển dần sang theo đùi từng bên (co giãn liền khối khi bước).
    """
    t = body.tz
    h = abs(body.bone("UpperLeg.L").x)
    r = 0.086 * body.legR * body.thigh_k * k * 0.97
    z0, z1 = t(0.95), body.crotch
    n_arc, n_flat, rings = 10, 6, 8

    # Nửa dưới: mặt trước / sau cong dần vào nếp giao của hai ống quần (|y| = √(R² − h²)) → đáy tấm không tạo gờ.
    R = r / 0.97
    fmin = max(0.1, 0.9 * math.sqrt(max(0.0, R * R - h * h)) / r)

    hem_z = body.torso[0][0]

    def ring(z, f):
        pts = []
        r_z = r * (1.0 - 0.15 * mc.smooth01((z - hem_z) / max(z0 - hem_z, 1e-3)))  # thon trong áo như ống quần
        for sx in (1, -1):  # nửa tròn bên trái (+x) rồi bên phải (−x), nối bằng mặt phẳng sau / trước chia đều
            for i in range(n_arc + 1):
                a = -pi / 2 + pi * i / n_arc
                pts.append(Vector((sx * (h + r_z * math.cos(a)), sx * r_z * math.sin(a) * f, z)))
            for i in range(1, n_flat):
                x = sx * h * (1 - 2 * i / n_flat)
                pts.append(Vector((x, sx * r_z * f, z)))
        return pts

    verts, faces = [], []
    for i in range(rings + 1):
        u = i / rings
        f = 1.0 - (1.0 - fmin) * mc.smooth01((u - 0.55) / 0.45)
        verts += ring(z0 + (z1 - z0) * u, f)
    n = len(verts) // (rings + 1)
    for i in range(rings):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    verts.append(Vector((0, 0, z1)))  # đáy (đũng)
    c = len(verts) - 1
    faces += [(c, rings * n + (j + 1) % n, rings * n + j) for j in range(n)]
    ob = mc.new_obj("Seat", verts, faces, material, ["Hips", "UpperLeg.L", "UpperLeg.R"])
    H = body.H

    def fn(p):
        kk = 0.8 * mc.smooth01((H - p.z) / max(H - z1, 1e-3))
        wl = kk * mc.smooth01(0.5 + p.x / (1.2 * h))
        return {"Hips": 1.0 - kk, "UpperLeg.L": wl, "UpperLeg.R": kk - wl}

    mc.PARTS[-1] = (ob, ["Hips", "UpperLeg.L", "UpperLeg.R"], fn)


def scale_head(body, k):
    """
    Phóng to đầu (và mọi thứ gắn đầu: mặt + shape key, tóc, tai, mũi, mũ, kính, râu) quanh chân đầu → tỉ lệ hoạt
    hình trẻ em (đầu to hơn thân). Khuôn mặt / tóc dựng theo cỡ đầu chuẩn nên phóng sau khi dựng xong.
    """
    if abs(k - 1.0) < 1e-3:
        return
    pivot = Vector(body.bones["Head"][0])
    for ob, bones, _ in mc.PARTS:
        if bones != ["Head"]:
            continue
        for v in ob.data.vertices:
            v.co = pivot + (v.co - pivot) * k
        if ob.data.shape_keys:
            for kb in ob.data.shape_keys.key_blocks:
                for d in kb.data:
                    d.co = pivot + (d.co - pivot) * k
    mc.HEAD_C = pivot + (mc.HEAD_C - pivot) * k


def action_fcurves(act):
    """fcurve của action (Blender ≥ 4.4 lưu trong channelbag của slot)."""
    try:
        return list(act.fcurves)
    except AttributeError:
        from bpy_extras import anim_utils
        return list(anim_utils.action_get_channelbag_for_slot(act, act.slots[0]).fcurves) if act.slots else []


def match_shoulders(rig, target, ref):
    """
    Tư thế nền của hai xương bả vai (xương đòn) trong `target` lấy theo `ref`: Walk của Mixamo nhún vai lên + gù ra
    trước → vai hạ, thả lỏng như WalkSwagger. Giữ nhịp lắc vai theo từng bước của `target` (chỉ đổi phần trung bình);
    cánh tay được bù ngược để hướng tay trong không gian giữ nguyên như `target` – chỉ khớp vai hạ xuống.
    """
    at, ar = bpy.data.actions.get(target), bpy.data.actions.get(ref)
    if not at or not ar:
        return

    def curves(act, bone):
        path = f'pose.bones["{bone}"].rotation_quaternion'
        fc = sorted((c for c in action_fcurves(act) if c.data_path == path), key=lambda c: c.array_index)
        return fc if len(fc) == 4 and all(len(c.keyframe_points) == len(fc[0].keyframe_points) for c in fc) else None

    def key(fc, i):
        return Quaternion(tuple(c.keyframe_points[i].co[1] for c in fc))

    def put(fc, i, q):
        for j, c in enumerate(fc):
            c.keyframe_points[i].co[1] = q[j]
            c.keyframe_points[i].handle_left[1] = q[j]
            c.keyframe_points[i].handle_right[1] = q[j]

    def mean(fc):
        q0 = key(fc, 0)
        acc = [0.0, 0.0, 0.0, 0.0]
        for i in range(len(fc[0].keyframe_points)):
            q = key(fc, i)
            sgn = 1.0 if q.dot(q0) >= 0 else -1.0
            acc = [a + sgn * b for a, b in zip(acc, q)]
        return Quaternion(tuple(acc)).normalized()

    for s in ("L", "R"):
        ft, fr, fu = curves(at, f"Shoulder.{s}"), curves(ar, f"Shoulder.{s}"), curves(at, f"UpperArm.{s}")
        if not ft or not fr:
            continue
        delta = mean(ft).inverted() @ mean(fr)
        bs, bu = rig.data.bones[f"Shoulder.{s}"], rig.data.bones[f"UpperArm.{s}"]
        rel = (bs.matrix_local.inverted() @ bu.matrix_local).to_quaternion()  # cánh tay so với bả vai (tư thế gốc)
        comp = rel.inverted() @ delta.inverted() @ rel
        same = fu is not None and len(fu[0].keyframe_points) == len(ft[0].keyframe_points)
        for i in range(len(ft[0].keyframe_points)):
            put(ft, i, key(ft, i) @ delta)
            if same:
                put(fu, i, comp @ key(fu, i))
        for c in ft + (fu if same else []):
            c.update()
        print(f"SHOULDERS {target} ← {ref} Shoulder.{s}: lệch {math.degrees(delta.angle):.1f}°{'' if same else ' (không bù cánh tay)'}")


def damp_shoulders(rig, k=0.45, only=("Idle", "Walk", "Run", "Sneak", "Jog")):
    """
    Xương bả vai (xương đòn) Mixamo xoay mạnh: khi đi / chạy khớp vai tụt 2–5 cm so với lúc đứng → vai xệ (nhất là vai
    dốc kiểu Quaternius). Chỉ các clip đứng / đi / chạy (`only`): góc xoay bả vai chỉ còn `k` phần (so với tư thế gốc);
    động tác giơ tay (Victory, ThumbsUp, vẫy…) giữ nguyên bả vai Mixamo – bả vai phải nâng theo tay, không thì nách /
    chỏm vai bị ép thành nếp. Cánh tay
    được bù ngược từng khung → hướng tay trong không gian giữ nguyên, chỉ vai không tụt / nhô nữa.
    """
    def curves(act, bone):
        path = f'pose.bones["{bone}"].rotation_quaternion'
        fc = sorted((c for c in action_fcurves(act) if c.data_path == path), key=lambda c: c.array_index)
        return fc if len(fc) == 4 and all(len(c.keyframe_points) == len(fc[0].keyframe_points) for c in fc) else None

    def key(fc, i):
        return Quaternion(tuple(c.keyframe_points[i].co[1] for c in fc))

    def put(fc, i, q):
        for j, c in enumerate(fc):
            c.keyframe_points[i].co[1] = q[j]
            c.keyframe_points[i].handle_left[1] = q[j]
            c.keyframe_points[i].handle_right[1] = q[j]

    ident = Quaternion()
    n = 0
    for act in bpy.data.actions:
        if not any(w in act.name for w in only):
            continue
        for s in ("L", "R"):
            ft, fu = curves(act, f"Shoulder.{s}"), curves(act, f"UpperArm.{s}")
            if not ft:
                continue
            bs, bu = rig.data.bones[f"Shoulder.{s}"], rig.data.bones[f"UpperArm.{s}"]
            rel = (bs.matrix_local.inverted() @ bu.matrix_local).to_quaternion()
            same = fu is not None and len(fu[0].keyframe_points) == len(ft[0].keyframe_points)
            for i in range(len(ft[0].keyframe_points)):
                q = key(ft, i)
                qn = ident.slerp(q if q.w >= 0 else -q, k)
                delta = q.inverted() @ qn
                put(ft, i, qn)
                if same:
                    put(fu, i, (rel.inverted() @ delta.inverted() @ rel) @ key(fu, i))
            for c in ft + (fu if same else []):
                c.update()
        n += 1
    print(f"DAMP bả vai × {k}: {n} clip")


def shoulder_correctives(rig, body, ref=("Victory", 30)):
    """
    Shape key chỉnh vai (corrective) cho lớp da liền của nhân vật gốc: shoulderUpL / shoulderUpR.
    Ở tư thế tay giơ cao (`ref` – Victory khung 30) cơ delta dồn lên thành hai khối ở bả vai. Lấy lưới đã biến dạng
    ở tư thế đó, làm mượt (Taubin – không co lưới) vùng quanh khớp vai từng bên → độ lệch cần sửa; đổi độ lệch về tư
    thế gốc (nghịch đảo ma trận skinning của từng đỉnh) → shape key. Engine (src/engine/CorrectiveMorphs.ts) bật key
    theo độ nâng cánh tay mỗi khung: tay buông = 0, tay giơ quá vai → 1.
    """
    ob = bpy.data.objects.get("Body")
    act = bpy.data.actions.get(ref[0])
    if ob is None or act is None:
        return
    ad = rig.animation_data
    muted = [(t, t.mute) for t in ad.nla_tracks]
    for t, _ in muted:
        t.mute = True
    ad.action = act
    bpy.context.scene.frame_set(ref[1])
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    tmp = ev.to_mesh()
    P = [ob.matrix_world @ v.co.copy() for v in tmp.vertices]
    ev.to_mesh_clear()
    me = ob.data
    n = len(me.vertices)
    if len(P) != n:
        print("CORRECTIVE bỏ qua: số đỉnh lệch")
        return
    nbr = [[] for _ in range(n)]
    for e in me.edges:
        i, j = e.vertices
        nbr[i].append(j)
        nbr[j].append(i)
    # ma trận biến dạng của từng xương (thế giới) ở tư thế ref
    mats = {}
    for pb in rig.pose.bones:
        mats[pb.name] = (rig.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ rig.matrix_world.inverted()).to_3x3()
    gname = {g.index: g.name for g in ob.vertex_groups}
    rb = 0.054 * body.armR
    if ob.data.shape_keys is None:
        ob.shape_key_add(name="Basis")
    for s in ("L", "R"):
        pb = rig.pose.bones[f"UpperArm.{s}"]
        J = rig.matrix_world @ pb.head  # khớp vai ở tư thế ref
        k = [0.0] * n
        for i, p in enumerate(P):
            d = (p - J).length
            if d < 4.2 * rb:
                k[i] = mc.smooth01((4.2 * rb - d) / (1.6 * rb))
        idx = [i for i in range(n) if k[i] > 0]
        T = list(P)
        for it in range(90):  # Taubin λ/μ: làm phẳng khối dồn, không làm teo lưới
            lam = 0.55 if it % 2 == 0 else -0.58
            new = {}
            for i in idx:
                if not nbr[i]:
                    continue
                c = sum((T[j] for j in nbr[i]), Vector()) / len(nbr[i])
                new[i] = T[i] + (c - T[i]) * lam * k[i]
            for i, v in new.items():
                T[i] = v
        key = ob.shape_key_add(name=f"shoulderUp{s}", from_mix=False)
        moved = 0
        for i in idx:
            dp = T[i] - P[i]
            if dp.length < 1e-5:
                continue
            M = None
            for g in me.vertices[i].groups:
                nm = gname.get(g.group)
                if nm in mats and g.weight > 0:
                    M = mats[nm] * g.weight if M is None else M + mats[nm] * g.weight
            if M is None:
                continue
            try:
                dr = M.inverted() @ dp
            except ValueError:
                continue
            key.data[i].co = me.vertices[i].co + ob.matrix_world.to_3x3().inverted() @ dr
            moved += 1
        print(f"CORRECTIVE shoulderUp{s}: {moved} đỉnh, lệch lớn nhất {max(((T[i] - P[i]).length for i in idx), default=0) * 1000:.1f} mm")
    ad.action = None
    for t, m in muted:
        t.mute = m
    bpy.context.scene.frame_set(0)


def relax_idle_arms(rig, deg=-20):
    """Clip đứng yên (Idle*): cẳng tay hơi gập ở khuỷu → tay thả lỏng, không thẳng đơ như ma-nơ-canh."""
    for act in bpy.data.actions:
        if not act.name.startswith("Idle"):
            continue
        curves = action_fcurves(act)
        for s in ("L", "R"):
            path = f'pose.bones["LowerArm.{s}"].rotation_quaternion'
            fc = sorted((c for c in curves if c.data_path == path), key=lambda c: c.array_index)
            if len(fc) != 4 or any(len(c.keyframe_points) != len(fc[0].keyframe_points) for c in fc):
                continue
            bend = mc.local_rot(rig, f"LowerArm.{s}", mc.X, deg)
            for i in range(len(fc[0].keyframe_points)):
                q = Quaternion([c.keyframe_points[i].co[1] for c in fc]) @ bend
                for j, c in enumerate(fc):
                    c.keyframe_points[i].co[1] = q[j]
                    c.keyframe_points[i].handle_left[1] = q[j]
                    c.keyframe_points[i].handle_right[1] = q[j]
            for c in fc:
                c.update()
            print(f"RELAX {act.name} LowerArm.{s}: {len(fc[0].keyframe_points)} khung")


def merge_shirt(body, material, sleeve, collar=None, extra=()):
    """
    Thân áo + đoạn vai + khớp vai + tay áo → MỘT lưới liền (voxel remesh: đúc lại thành bề mặt kín, rồi làm mượt,
    giảm mặt) như nhân vật game: vai bo tròn liền vào thân, không còn đường ghép. Trọng lượng da tính sau bằng
    bone heat của Blender (auto_weights) → vai / nách co giãn liền như vải khi nhấc tay. Hoạ tiết dán lại theo độ
    cao + vòng quanh thân (sọc liền từ thân sang tay áo).
    """
    names = ["Torso", "NeckBand", *extra] + [f"{p}.{s}" for s in ("L", "R") for p in ("Yoke", "ShoulderBall", "Trap", "Sleeve")]
    obs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    mc.PARTS[:] = [p for p in mc.PARTS if p[0] not in obs]
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    ob = obs[0]
    ob.name = "Shirt"

    def apply(kind, **props):
        m = ob.modifiers.new(kind, kind)
        for k, v in props.items():
            setattr(m, k, v)
        bpy.ops.object.modifier_apply(modifier=m.name)

    apply("REMESH", mode="VOXEL", voxel_size=0.0042 * max(body.sw, 0.8), adaptivity=0.0)
    apply("SMOOTH", factor=0.6, iterations=10)  # bo mềm vai / nách / cổ tay áo (kiểu hoạt hình, không góc cạnh)
    if len(ob.data.polygons) > 16000:
        apply("DECIMATE", ratio=16000 / len(ob.data.polygons))
    me = ob.data
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.clear()
    me.materials.append(material)
    if collar is not None:
        # viền cổ (đã đúc liền vào áo) tô màu nền: vùng sát cổ, trên mép vai → một dải bo liền của áo, không phải vòng rời
        me.materials.append(collar)
        t = body.tz
        zc, rc = t(1.343), 0.1 * body.sw + 0.012
        if SPEC.get("top", {}).get("pattern") == "stripes":
            # ranh giới viền cổ đặt giữa một sọc nền (trắng): mép tô theo từng mặt lưới (răng cưa) gặp đúng màu nền → không thấy
            z0, z1 = body.torso[0][0], body.torso[-1][0]
            k = PATTERN_V / max(z1 - z0, 1e-3)
            period = 32 / 256
            ph = (((zc - z0) * k + pattern_phase(body)) / period) % 1.0
            zc += ((0.25 - ph + 0.5) % 1.0 - 0.5) * period / k
        for poly in me.polygons:
            c = poly.center
            if c.z > zc and (SPEC.get("top", {}).get("pattern") == "stripes" or math.hypot(c.x, c.y) < rc):
                poly.material_index = 1
    uv = me.uv_layers.new(name="UVMap")
    z0, z1 = body.torso[0][0], body.torso[-1][0]
    k = PATTERN_V / max(z1 - z0, 1e-3)
    off = pattern_phase(body)
    for poly in me.polygons:
        cos = [me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
        us = [((math.atan2(c.x, -c.y) / (2 * pi)) % 1.0) * 2.0 for c in cos]  # 2 vòng quanh thân như bản cũ
        if max(us) - min(us) > 1.0:  # mặt vắt qua đường nối sau lưng
            us = [u + 2.0 if u < 1.0 else u for u in us]
        for li, u, c in zip(poly.loop_indices, us, cos):
            uv.data[li].uv = (u, (c.z - z0) * k + off)
    allowed = ["Hips", "Spine", "Chest", "Shoulder.L", "Shoulder.R", "UpperArm.L", "UpperArm.R", "UpperLeg.L", "UpperLeg.R"]
    if sleeve == "long":
        allowed += ["LowerArm.L", "LowerArm.R"]
    mc.PARTS.append((ob, allowed, "auto"))
    return ob


FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
# bán kính da cánh tay theo vị trí dọc tay (0 = khớp vai → 1 = cổ tay), nhân body.armR
ARM_PROF = [(0, 0.042), (0.3, 0.043), (0.5, 0.039), (0.62, 0.04), (0.85, 0.036), (1, 0.032)]


def check_symmetry(ob):
    """In độ lệch trái – phải của lưới (mỗi đỉnh so với đỉnh gần nhất của ảnh gương): đúc voxel + giảm mặt có thể lệch."""
    from mathutils.kdtree import KDTree
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    kd = KDTree(len(vs))
    for i, p in enumerate(vs):
        kd.insert(p, i)
    kd.balance()
    ds = sorted(kd.find(Vector((-p.x, p.y, p.z)))[2] for p in vs)
    print(f"SYM {ob.name}: lệch trái–phải trung bình {sum(ds) / len(ds) * 1000:.2f} mm · 99 % ≤ {ds[int(len(ds) * 0.99)] * 1000:.2f} mm · lớn nhất {ds[-1] * 1000:.2f} mm")


def shade_body(ob, body, skin_rgb):
    """
    Bóng / highlight vẽ sẵn vào màu đỉnh (COLOR_0 trong GLB – engine dùng thẳng, không cần ánh sáng đặc biệt):
      - chỗ lõm (nách, rãnh lưng, chân cổ, nếp hông) tối nhẹ – như bóng che (ambient occlusion);
      - đỉnh cơ vai + bả vai (mặt hướng lên, quanh khớp vai) sáng nhẹ → khối vai – lưng nổi hơn.
    Vùng phẳng giữ đúng màu da (khớp với đầu / chân là lưới riêng).
    """
    me = ob.data
    n = len(me.vertices)
    nbr = [[] for _ in range(n)]
    for e in me.edges:
        i, j = e.vertices
        nbr[i].append(j)
        nbr[j].append(i)
    co = [v.co for v in me.vertices]
    no = [v.normal for v in me.vertices]
    cav = [0.0] * n
    for i in range(n):
        if nbr[i]:
            cav[i] = sum(no[i].dot((co[j] - co[i]).normalized()) for j in nbr[i] if (co[j] - co[i]).length > 1e-9) / len(nbr[i])
    for _ in range(14):  # nhoè rộng: bóng mềm như khối cơ, không thành đường kẻ / lốm đốm theo mặt lưới
        cav = [0.5 * cav[i] + 0.5 * sum(cav[j] for j in nbr[i]) / max(len(nbr[i]), 1) for i in range(n)]
    rb = 0.054 * body.armR
    caps = [body.bone(f"UpperArm.{s}") for s in ("L", "R")]
    lin = [mc.srgb_to_lin(c) for c in skin_rgb]
    zb, zn = body.tz(1.03), body.tz(1.005)  # giữa bụng · rốn
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i in range(n):
        p = ob.matrix_world @ co[i]
        k = 1.0 - min(0.08, max(0.0, cav[i]) * 1.8)  # lõm → tối nhẹ (tối đa 8 % – bóng mềm)
        hl = max(mc.smooth01((3.0 * rb - (p - c).length) / (1.5 * rb)) for c in caps) * mc.smooth01((no[i].z - 0.1) / 0.6)
        k *= 1.0 + 0.035 * hl  # đỉnh vai sáng nhẹ (vai tròn như quả bóng, không nổi khối cơ)
        # (không vẽ xương sườn / khối cơ – nhân vật hoạt hình trẻ em: thân trơn mềm); bụng trước sáng nhẹ (bụng tròn)
        a = abs(math.atan2(p.x, -p.y))
        if a < 0.7:
            k *= 1.0 + 0.04 * mc.smooth01((0.7 - a) / 0.5) * math.exp(-((p.z - zb) / (0.06 * body.st)) ** 2)
            # rốn: chấm nhỏ mờ hơi dài theo chiều dọc (vẽ màu, không khoét lõm)
            k *= 1.0 - 0.2 * math.exp(-(p.x / 0.0032) ** 2 - ((p.z - zn) / 0.0048) ** 2)
        attr.data[i].color = (lin[0] * k, lin[1] * k, lin[2] * k, 1.0)
    # vật liệu riêng cho lớp da thân: màu = màu đỉnh (glTF xuất COLOR_0, baseColorFactor = 1)
    m = bpy.data.materials.new("SkinBody")
    m.use_nodes = True
    nodes = m.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    ca = nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    m.node_tree.links.new(ca.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    m.use_backface_culling = False
    me.materials.clear()
    me.materials.append(m)
    print(f"SHADE {ob.name}: {n} đỉnh")


def shade_nose(obs):
    """
    Mũi: bóng / highlight vẽ sẵn vào màu đỉnh (như shade_body) – mặt dưới sẫm nhẹ (bóng đổ mềm xuống nhân trung),
    chóp mũi phía trên sáng nhẹ → mũi có khối mà vẫn trơn kiểu hoạt hình.
    """
    lin = [mc.srgb_to_lin(c) for c in mc.P["skin"]]
    m = bpy.data.materials.get("SkinNose")
    if m is None:
        m = bpy.data.materials.new("SkinNose")
        m.use_nodes = True
        nodes = m.node_tree.nodes
        ca = nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        m.node_tree.links.new(ca.outputs["Color"], nodes.get("Principled BSDF").inputs["Base Color"])
        nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.6
        m.use_backface_culling = False
    for ob in obs:
        me = ob.data
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        zs = [v.co.z for v in me.vertices]
        z0, z1 = min(zs), max(zs)
        for i, v in enumerate(me.vertices):
            h = (v.co.z - z0) / max(z1 - z0, 1e-6)  # 0 = mặt dưới, 1 = đỉnh
            k = 1.0 - 0.13 * mc.smooth01((0.45 - h) / 0.4)  # dưới sẫm tới 13 %
            k *= 1.0 + 0.07 * mc.smooth01((-v.normal.y - 0.4) / 0.5) * mc.smooth01((h - 0.45) / 0.35)  # chóp trước sáng 7 %
            attr.data[i].color = (lin[0] * k, lin[1] * k, lin[2] * k, 1.0)
        me.materials.clear()
        me.materials.append(m)


def shoulder_fair(ob, body, iters=None):
    """
    Sau khi đúc: khối cơ vai (Trap) + đầu cánh tay + thân chỉ dính vào nhau → nhìn nghiêng / chéo thấy hai cục chồng
    lên nhau, nhìn thẳng có rãnh dọc mép dưới khối cơ vai. Làm mượt Taubin (λ/μ – lấp rãnh, giữ thể tích, không teo)
    riêng vùng quanh đường cổ → khớp vai, mạnh ở giữa, nhạt dần ra mép → vai thành MỘT khối tròn liền.
    Vai trần: nhiều lượt hơn + vùng ra quá khớp vai xa hơn → hết nếp gấp giữa đầu vai và khối vai.
    """
    import numpy as np
    iters = iters or (700 if body.bare else 260)
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    rb = 0.054 * body.armR
    k = np.zeros(n)
    out = 0.8 if body.bare else 0.4
    for s, sx in (("L", 1), ("R", -1)):
        S = np.array(body.bone(f"UpperArm.{s}"))
        a = np.array((S[0] * 0.2, S[1], S[2] + 1.1 * rb))  # gần chân cổ
        b = S + np.array((out * rb * sx, 0, 0))  # qua khỏi khớp (đầu cánh tay)
        ab = b - a
        t = np.clip(((co - a) @ ab) / (ab @ ab), 0.0, 1.0)
        d = np.linalg.norm(co - (a + t[:, None] * ab), axis=1)
        w = np.clip((3.0 * rb - d) / (1.4 * rb), 0.0, 1.0)
        z = np.clip((co[:, 2] - (S[2] - 1.6 * rb)) / (0.8 * rb), 0.0, 1.0)
        w, z = w * w * (3 - 2 * w), z * z * (3 - 2 * z)
        k = np.maximum(k, np.where(co[:, 2] < S[2] - 1.6 * rb, 0.0, w * z))
    co = taubin(co, edges, k, iters)
    if body.bare:
        # rãnh chữ V nơi đầu vai (cầu) gặp ngực / khối vai: Taubin giữ thể tích nên không lấp được rãnh rộng → thêm
        # lượt "chỉ lấp lõm": đỉnh chỉ được dịch ra ngoài (theo pháp tuyến) → rãnh đầy lên, khối tròn không teo.
        # Chỉ trên nách (dưới đó là khe tay – sườn: lấp thì dính tay vào thân).
        no = np.empty(n * 3)
        me.vertices.foreach_get("normal", no)
        no = no.reshape(n, 3)
        kf = k.copy()
        for s in ("L", "R"):
            S = np.array(body.bone(f"UpperArm.{s}"))
            near = np.linalg.norm(co - S, axis=1) < 3.0 * rb
            kf = np.where(near & (co[:, 2] < S[2] - 0.9 * rb), 0.0, kf)
        a, b = edges[:, 0], edges[:, 1]
        deg = np.maximum(np.bincount(a, minlength=n) + np.bincount(b, minlength=n), 1).astype(np.float64)
        for _ in range(260):
            sm = np.empty_like(co)
            for ax in range(3):
                sm[:, ax] = np.bincount(a, weights=co[b, ax], minlength=n) + np.bincount(b, weights=co[a, ax], minlength=n)
            dv = sm / deg[:, None] - co
            out = np.clip((dv * no).sum(1), 0.0, None)  # chỉ phần dịch ra ngoài
            co = co + no * (out * 0.6 * kf)[:, None]
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()
    print(f"FAIR vai: {int((k > 0).sum())} đỉnh × {iters} lượt")


def taubin(co, edges, k, iters, lam=0.5, mu=-0.53):
    """Làm mượt Taubin (λ/μ – giữ thể tích) bằng numpy; k[i] ∈ [0, 1] = độ mượt từng đỉnh (0 = giữ nguyên)."""
    import numpy as np
    n = len(co)
    a, b = edges[:, 0], edges[:, 1]
    deg = np.maximum(np.bincount(a, minlength=n) + np.bincount(b, minlength=n), 1).astype(np.float64)
    kk = k[:, None]
    for it in range(iters):
        s = np.empty_like(co)
        for ax in range(3):
            s[:, ax] = np.bincount(a, weights=co[b, ax], minlength=n) + np.bincount(b, weights=co[a, ax], minlength=n)
        co = co + (s / deg[:, None] - co) * (lam if it % 2 == 0 else mu) * kk
    return co


def hand_mask(co, body):
    """0 quanh lòng bàn tay / ngón, tăng dần lên 1 ở cẳng tay (numpy, co: N×3)."""
    import numpy as np
    hand = np.ones(len(co))
    for s in ("L", "R"):
        w, h = np.array(body.bone(f"Hand.{s}")), np.array(body.bone(f"Hand.{s}", 1))
        d = h - w
        t = np.clip(((co - w) @ d) / max(d @ d, 1e-9), 0.0, 1.6)
        dist = np.linalg.norm(co - (w + t[:, None] * d), axis=1)
        hand = np.minimum(hand, np.clip((dist - 0.045 * body.hand) / (0.04 * body.hand), 0.0, 1.0) ** 2)
    return hand


def arm_fair(ob, body):
    """Bản mặc đồ cùng dáng gốc (merge_arm): cẳng tay mượt như lớp da thân của nhân vật gốc, ngón mượt nhẹ."""
    import numpy as np
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    hand = hand_mask(co, body)
    co = taubin(co, edges, hand, 40)
    co = taubin(co, edges, (1.0 - hand) * 0.6, 12)
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()


def body_fair(ob, body):
    """
    Lớp da thân trần sau khi đúc voxel: bậc thang voxel còn lại thành vân ô vuông / gợn trên ngực, bụng, lưng; mối nối
    cổ – thân còn gờ. Làm mượt Taubin cả lớp da (mịn như subdivision ≥ 2 cấp, không teo), tránh bàn tay / ngón (mượt
    thì ngón teo); thêm một lượt mạnh quanh chân cổ → cổ nối vào ngực / vai qua mặt cong mềm, không cạnh gắt.
    """
    import numpy as np
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    hand = hand_mask(co, body)  # không mượt mạnh bàn tay (ngón teo)
    co = taubin(co, edges, hand, 40)
    if body.bare:  # bàn tay / ngón: mượt nhẹ (vài lượt, Taubin không teo) – xoá gợn voxel trên ngón mà ngón vẫn đủ tròn
        co = taubin(co, edges, (1.0 - hand) * 0.6, 12)
    # chân cổ: vòng quanh điểm nối cổ – ngực – vai
    nb = np.array((0.0, 0.005, body.N))
    r = body.neck_r * 3.0
    d = np.linalg.norm((co - nb) * np.array((1.0, 1.0, 1.4)), axis=1)
    neck = np.clip((r - d) / (0.6 * r), 0.0, 1.0) * hand
    neck = neck * neck * (3 - 2 * neck)
    co = taubin(co, edges, neck, 320)
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()
    print(f"FAIR thân: {n} đỉnh · cổ {int((neck > 0).sum())} đỉnh")


def subdivide_parts(obs, kinds):
    """
    Chia mịn (subdivision 2 cấp) các khối lớn trước khi đúc voxel: mặt phẳng của khối thân / cổ / vai / ống tay (16–24
    cạnh) nếu để nguyên thì voxel đúc lại đúng các mặt phẳng đó → vân ô vuông / sọc dọc trên ngực, bụng, tay.
    Ngón / lòng bàn tay không chia (chia thì teo ngón).
    """
    for o in obs:
        if o.name.split(".")[0] not in kinds:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        w = o.modifiers.new("Weld", "WELD")  # đường nối UV (đỉnh trùng) → hở; chia mịn sẽ thành rãnh dọc
        w.merge_threshold = 1e-5
        bpy.ops.object.modifier_apply(modifier=w.name)
        m = o.modifiers.new("Subsurf", "SUBSURF")
        m.levels = m.render_levels = 2
        bpy.ops.object.modifier_apply(modifier=m.name)


def merge_body(body, skin, extra=()):
    """
    Nhân vật gốc (không áo): thân + vai + cánh tay + bàn tay + ngón → MỘT lớp da liền (voxel remesh) như nhân vật
    game (Quaternius…): vai nối vào tay không còn khớp cầu / đường ghép. Trọng lượng: bone heat trên cả lưới.
    """
    # khe hở tay – sườn dọc cánh tay (tư thế nghỉ): đúc voxel sẽ dính tay vào thân nếu khe < ~2 voxel
    S, E, W = body.bone("UpperArm.L"), body.bone("LowerArm.L"), body.bone("Hand.L")
    gaps = []
    for i in range(11):
        t = i / 10
        c = S.lerp(E, t * 2) if t <= 0.5 else E.lerp(W, (t - 0.5) * 2)
        gaps.append(c.x - interp(ARM_PROF, t) * body.armR - body.torso_r(c.z)[0])
    print("ARMGAP " + " ".join(f"{g * 1000:.1f}" for g in gaps) + " mm")
    names = ["Torso", "NeckBand", "Neck", *extra] + [f"{p}.{s}" for s in ("L", "R") for p in ("Yoke", "ShoulderBall", "Trap", "Arm", "Palm")]
    names += [f"{f}{t}.{s}" for s in ("L", "R") for f in FINGERS for t in ("", "Tip")]
    obs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    mc.PARTS[:] = [p for p in mc.PARTS if p[0] not in obs]
    subdivide_parts(obs, ("Torso", "Seat", "NeckBand", "Neck", "Yoke", "ShoulderBall", "Trap", "Arm"))
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    ob = obs[0]
    ob.name = "Body"

    def apply(kind, **props):
        m = ob.modifiers.new(kind, kind)
        for k, v in props.items():
            setattr(m, k, v)
        bpy.ops.object.modifier_apply(modifier=m.name)

    # voxel đủ mịn cho ngón tay trẻ em; làm mượt nhẹ (mạnh quá thì ngón teo lại); giảm mặt ít + làm mượt lại
    # (giảm mạnh để lại mảng tam giác lổn nhổn trên ngực / bụng)
    apply("REMESH", mode="VOXEL", voxel_size=0.0024 * max(body.hand, 0.8), adaptivity=0.0)
    apply("SMOOTH", factor=0.5, iterations=4)
    print(f"BODYMESH {len(ob.data.polygons)} mặt sau đúc")
    body_fair(ob, body)
    shoulder_fair(ob, body)
    if len(ob.data.polygons) > 60000:  # giữ đủ mặt cho bóng đổ mịn (ít mặt → mảng tam giác lổn nhổn trên ngực / bụng)
        # (không dùng use_symmetry: để lại đường dọc giữa ngực; lệch trái – phải do giảm mặt chỉ ~0.7 mm, không thấy)
        apply("DECIMATE", ratio=60000 / len(ob.data.polygons))
        apply("SMOOTH", factor=0.3, iterations=2)
    # gộp đỉnh sát nhau (< 0.4 mm – giảm mặt / làm mượt để lại): còn thì bone heat có lúc không giải được, cả lưới mất
    # trọng lượng ("Bone Heat Weighting: failed to find solution")
    apply("WELD", merge_threshold=0.0004)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    ob.data.materials.clear()
    ob.data.materials.append(skin)
    allowed = ["Hips", "Spine", "Chest", "Neck", "Head", "UpperLeg.L", "UpperLeg.R"]
    for s in ("L", "R"):
        allowed += [f"Shoulder.{s}", f"UpperArm.{s}", f"LowerArm.{s}", f"Hand.{s}"] + [f"{f}{i}.{s}" for f in FINGERS for i in (1, 2, 3)]
    mc.PARTS.append((ob, allowed, "auto_body"))
    return ob


def merge_arm(body, s, skin, sleeve):
    """
    Da cánh tay + lòng bàn tay + 5 ngón → MỘT lưới liền mỗi bên (voxel remesh mịn): cổ tay, gốc ngón liền mạch,
    sạch cho biến dạng. Trọng lượng: bone heat theo xương tay + từng đốt ngón (auto_weights, kiểu "limb").
    Áo ba lỗ: gộp cả đoạn vai + khớp vai (màu da) vào luôn.
    """
    names = [f"Arm.{s}", f"Palm.{s}"] + [f"{f}{t}.{s}" for f in FINGERS for t in ("", "Tip")]
    if sleeve == "none":
        names += [f"Yoke.{s}", f"ShoulderBall.{s}"]
    obs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    if len(obs) < 2:
        return None
    mc.PARTS[:] = [p for p in mc.PARTS if p[0] not in obs]
    if body.base_prop:  # dáng gốc: da tay mịn như nhân vật gốc (không sọc dọc theo mặt ống tay)
        subdivide_parts(obs, ("Arm", "Yoke", "ShoulderBall"))
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    ob = obs[0]
    ob.name = f"ArmHand.{s}"

    def apply(kind, **props):
        m = ob.modifiers.new(kind, kind)
        for k, v in props.items():
            setattr(m, k, v)
        bpy.ops.object.modifier_apply(modifier=m.name)

    apply("REMESH", mode="VOXEL", voxel_size=0.0014, adaptivity=0.0)
    apply("SMOOTH", factor=0.5, iterations=3)
    if body.base_prop:
        arm_fair(ob, body)
    cap = 14000 if body.base_prop else 7000  # dáng gốc: giữ đủ mặt cho 5 ngón tròn
    if len(ob.data.polygons) > cap:
        apply("DECIMATE", ratio=cap / len(ob.data.polygons))
        if body.base_prop:
            apply("WELD", merge_threshold=0.0002)  # tránh bone heat thất bại (đỉnh sát nhau)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    ob.data.materials.clear()
    ob.data.materials.append(skin)
    allowed = [f"UpperArm.{s}", f"LowerArm.{s}", f"Hand.{s}"] + [f"{f}{i}.{s}" for f in FINGERS for i in (1, 2, 3)]
    if sleeve == "none":
        allowed += ["Chest", f"Shoulder.{s}"]
    mc.PARTS.append((ob, allowed, "auto_limb"))
    return ob


def nearest_bone_weights(allowed):
    """Dự phòng khi bone heat bỏ sót đỉnh: 2 xương gần nhất (theo đoạn xương), như make_character.skin."""
    def fn(p):
        ws = sorted(((1.0 / (mc.seg_dist(p, Vector(mc.BONES[n][0]), Vector(mc.BONES[n][1])) + 0.005) ** 4, n) for n in allowed), reverse=True)[:2]
        tot = sum(w for w, _ in ws)
        return {n: w / tot for w, n in ws}
    return fn


def auto_weights(rig, ob, allowed, body, kind="auto"):
    """Bone heat (Blender tự tính, như rig chuyên nghiệp) chỉ với các xương được phép; đỉnh nào không nhận được
    trọng lượng (heat thất bại cục bộ) → dự phòng bằng trọng lượng thân (torso_weights)."""
    for b in rig.data.bones:
        b.use_deform = b.name in allowed
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    for b in rig.data.bones:
        b.use_deform = True
    fallback = torso_weights(body) if kind == "auto" else nearest_bone_weights(allowed)  # auto_body: có cả ngón tay
    missing = 0
    for v in ob.data.vertices:
        if sum(g.weight for g in v.groups) > 0.2:
            continue
        missing += 1
        for n, w in fallback(ob.matrix_world @ v.co).items():
            if w > 0.01:
                (ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n)).add([v.index], w, "REPLACE")
    print(f"AUTOWEIGHT {ob.name}: {len(ob.data.vertices)} đỉnh, {missing} đỉnh dùng trọng lượng dự phòng")
    if kind == "auto_limb":
        return
    if kind == "auto_body":
        split_arm_torso(ob, body)
    shoulder_caps(ob, body)
    # làm mượt trọng lượng (chuyển tiếp rộng, êm) → không bóp chữ X ở nách / gờ ở đỉnh vai khi giơ tay
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    # (lớp da liền thân + tay: tách tay / thân để lại bậc trọng lượng → làm mượt nhiều hơn cho bụng không nhăn khi đi)
    bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.5, repeat=30 if kind == "auto_body" else 3)
    bpy.ops.object.mode_set(mode="OBJECT")
    chest_from_arms(ob, body)
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def split_arm_torso(ob, body):
    """
    Lưới liền thân + tay (merge_body): bone heat cho sườn / hông (nằm sát tay buông) theo cả xương cẳng tay / bàn tay
    → tay cử động là kéo rách thân. Tách tay khỏi thân bằng cách loang theo cạnh lưới từ bàn tay ngược lên, chỉ đi
    trong ống tay (bán kính tay theo ARM_PROF) và dừng ở vùng khớp vai → đỉnh tay = mọi đỉnh nối liền với bàn tay;
    tay bỏ trọng lượng thân, thân bỏ trọng lượng tay; vùng khớp vai giữ bone heat (chuyển tiếp mượt).
    """
    me = ob.data
    co = [ob.matrix_world @ v.co for v in me.vertices]
    nbr = [[] for _ in co]
    for e in me.edges:
        i, j = e.vertices
        nbr[i].append(j)
        nbr[j].append(i)
    rb = 0.054 * body.armR
    arm_bones = {s: [f"UpperArm.{s}", f"LowerArm.{s}", f"Hand.{s}"] + [f"{f}{i}.{s}" for f in FINGERS for i in (1, 2, 3)] for s in ("L", "R")}
    torso_bones = ["Hips", "Spine", "Chest", "Neck", "Head", "UpperLeg.L", "UpperLeg.R", "Shoulder.L", "Shoulder.R"]
    label = [None] * len(co)  # "L" / "R" = tay, "J" = khớp vai, None = thân
    for s in ("L", "R"):
        S, E, W = body.bone(f"UpperArm.{s}"), body.bone(f"LowerArm.{s}"), body.bone(f"Hand.{s}")
        L1, L2 = (E - S).length, (W - E).length
        tips = [Vector(b[1]) for n, b in body.bones.items() if n.endswith(f"3.{s}")]

        def where(p, W=W, E=E, S=S, L1=L1, L2=L2, tips=tips):
            """Trong ống tay (cánh tay theo ARM_PROF, bàn tay = các đoạn cổ tay → đầu ngón)?"""
            if min(mc.seg_dist(p, W, tp) for tp in tips) < 0.03 * body.hand + 0.0015:
                return True
            best = None
            for a, b, t0, L in ((S, E, 0.0, L1), (E, W, L1, L2)):
                ab = b - a
                t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
                d = (p - (a + ab * t)).length
                if best is None or d < best[0]:
                    best = (d, (t0 + t * L) / (L1 + L2))
            d, t = best
            # ngưỡng (≈ r + 7 mm) phải nhỏ hơn khe tay – sườn hẹp nhất (ARMGAP) – không thì loang tràn sang sườn
            return d < interp(ARM_PROF, t) * body.armR * 1.12 + 0.002

        for i, p in enumerate(co):
            # khớp vai = chỏm vai (trên / phía ngoài khớp, sát khớp); nách + sườn dưới khớp KHÔNG thuộc khớp → không
            # bị kéo theo tay khi đánh tay lúc đi / chạy
            if (p - S).length < 1.5 * rb and (p.z > S.z - 0.3 * rb or (p.x - S.x) * (1 if s == "L" else -1) > 0):
                label[i] = "J"
        seeds = [i for i, p in enumerate(co) if label[i] is None and min((p - tp).length for tp in tips) < 0.012]
        for i in seeds:
            label[i] = s
        stack = list(seeds)
        while stack:
            i = stack.pop()
            for j in nbr[i]:
                if label[j] is None and where(co[j]):
                    label[j] = s
                    stack.append(j)
    torso_fb = torso_weights(body)
    hem_z = body.torso[0][0]
    names = {g.index: g.name for g in ob.vertex_groups}
    fixed = 0
    for v in me.vertices:
        lb = label[v.index]
        if lb == "J":
            continue
        ws = {names[g.group]: g.weight for g in v.groups}
        allowed = arm_bones[lb] if lb else torso_bones
        if not lb:
            # thân quanh khớp vai (nách, bả vai, chỏm vai): giữ phần cánh tay của bone heat → vai / nách co giãn tự
            # nhiên khi giơ tay; chỉ bỏ cẳng tay / bàn tay (thứ kéo rách sườn, hông)
            for s_ in ("L", "R"):
                if (co[v.index] - body.bone(f"UpperArm.{s_}")).length < 3.0 * rb:
                    allowed = torso_bones + [f"UpperArm.{s_}"]
        keep = {n: w for n, w in ws.items() if n in allowed}
        # bụng trên gấu: ảnh hưởng của đùi nhạt dần lên trên (dải mềm, không cắt gắt) → nhấc chân không nhăn bụng
        fade = 0.0 if lb else mc.smooth01((co[v.index].z - hem_z) / (0.08 * body.st))
        if fade > 0:
            keep = {n: w * (1 - fade) if n.startswith("UpperLeg") else w for n, w in keep.items()}
        if len(keep) == len(ws) and fade <= 0:
            continue
        tot = sum(keep.values())
        new_ws = {n: w / tot for n, w in keep.items()} if tot > 0.05 else (nearest_bone_weights(allowed) if lb else torso_fb)(co[v.index])
        for g in list(v.groups):
            ob.vertex_groups[g.group].remove([v.index])
        for n, w in new_ws.items():
            if w > 1e-4:
                (ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n)).add([v.index], w, "ADD")
        fixed += 1
    # (1) Cánh tay (trước cổ tay): trọng lượng dọc tay chuyển mượt qua khuỷu / cổ tay (bone heat trên lưới lớn đổi
    #     đột ngột ở khuỷu → đường nứt ngang). Bàn tay + ngón giữ bone heat.
    # (2) Vai / nách / bả vai: để bone heat (đã có khe tay – sườn nên không còn dính) – vai co giãn tự nhiên khi giơ tay.
    fixed2 = 0
    for s, sx in (("L", 1), ("R", -1)):
        S, E, W = body.bone(f"UpperArm.{s}"), body.bone(f"LowerArm.{s}"), body.bone(f"Hand.{s}")
        Ht = body.bone(f"Hand.{s}", 1)
        dh = (Ht - W).normalized()
        # dải khuỷu rộng (±9 cm × tỉ lệ tay): khuỷu gập không ép da mặt trong thành nếp
        arm_fn = mc.chain_weights([f"UpperArm.{s}", (E, W - E, 0.09 * body.sa, f"LowerArm.{s}"), (W, Ht - W, 0.02 * body.hand, f"Hand.{s}")])
        for v in me.vertices:
            p = co[v.index]
            lb = label[v.index]
            new_ws = None
            if lb == s and (p - W).dot(dh) < 0.015 * body.hand:
                # khuỷu / cổ tay: chuyển mượt theo chain; sát vai: dần về bone heat (không có đường ranh ở gốc tay)
                ua = E - S
                m = mc.smooth01(((p - S).dot(ua.normalized()) - 0.2 * ua.length) / (0.3 * ua.length))
                chain = arm_fn(p)
                if m < 1.0:
                    heat = {ob.vertex_groups[g.group].name: g.weight for g in v.groups}
                    names_ = set(chain) | set(heat)
                    chain = {n: (1 - m) * heat.get(n, 0.0) + m * chain.get(n, 0.0) for n in names_}
                new_ws = chain
            if new_ws is None:
                continue
            for g in list(v.groups):
                ob.vertex_groups[g.group].remove([v.index])
            for n, w in new_ws.items():
                if w > 1e-4:
                    (ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n)).add([v.index], w, "ADD")
            fixed2 += 1
    # (3) Làm mượt trọng lượng riêng vùng quanh khớp vai (Laplace theo cạnh lưới, mạnh ở giữa vùng, nhạt dần ra mép)
    #     → bả vai / chỏm vai / nách co giãn như một tấm liền khi giơ tay, không còn gờ ở chỗ trọng lượng đổi gắt.
    region = {}
    for s in ("L", "R"):
        S = body.bone(f"UpperArm.{s}")
        for i, p in enumerate(co):
            d = (p - S).length
            if d < 4.2 * rb:
                region[i] = max(region.get(i, 0.0), mc.smooth01((4.2 * rb - d) / (1.6 * rb)))
    if region:
        gname = {g.index: g.name for g in ob.vertex_groups}
        W = [{gname[g.group]: g.weight for g in me.vertices[i].groups} for i in range(len(co))]
        for _ in range(35):
            new = {}
            for i, k in region.items():
                acc = {}
                for j in nbr[i]:
                    for n, w in W[j].items():
                        acc[n] = acc.get(n, 0.0) + w
                m = max(len(nbr[i]), 1)
                mix_ = {n: (1 - 0.6 * k) * W[i].get(n, 0.0) + 0.6 * k * acc.get(n, 0.0) / m for n in set(W[i]) | set(acc)}
                tot = sum(mix_.values()) or 1.0
                new[i] = {n: w / tot for n, w in mix_.items() if w > 1e-4}
            for i, ws in new.items():
                W[i] = ws
        for i in region:
            v = me.vertices[i]
            for g in list(v.groups):
                ob.vertex_groups[g.group].remove([i])
            for n, w in W[i].items():
                (ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n)).add([i], w, "ADD")
    print(f"SPLIT {ob.name}: tay trái {label.count('L')} · tay phải {label.count('R')} · khớp vai {label.count('J')} đỉnh, sửa {fixed} + {fixed2} (tay), mượt vai {len(region)} đỉnh")


def chest_from_arms(ob, body):
    """
    Ngực / lưng (phần trong bề ngang thân, cách xa khớp vai) gần như không theo xương cánh tay → tay đung đưa khi
    đi bộ không kéo phồng ngực / lưng. Ảnh hưởng cánh tay chỉ tăng dần khi ra tới vùng vai / nách.
    """
    rb = 0.054 * body.armR
    chest = ob.vertex_groups.get("Chest") or ob.vertex_groups.new(name="Chest")
    for s, sx in (("L", 1), ("R", -1)):
        up = ob.vertex_groups.get(f"UpperArm.{s}")
        if up is None:
            continue
        c = body.bone(f"UpperArm.{s}")
        for v in ob.data.vertices:
            p = ob.matrix_world @ v.co
            w = next((g.weight for g in v.groups if g.group == up.index), 0.0)
            if w <= 0:
                continue
            # 0 ở giữa thân → 1 khi tới gần khớp vai (theo bề ngang), và ra ngoài tay áo thì giữ nguyên
            keep = mc.smooth01((p.x * sx - (c.x * sx - 2.6 * rb)) / (1.8 * rb))
            if keep >= 1.0:
                continue
            wc = next((g.weight for g in v.groups if g.group == chest.index), 0.0)
            up.add([v.index], w * keep, "REPLACE")
            chest.add([v.index], wc + w * (1 - keep), "REPLACE")


def shoulder_caps(ob, body):
    """
    Đỉnh vai (phía trên khớp vai, trong khoảng ~2 bán kính tay áo) chuyển bớt trọng lượng xương cánh tay sang xương
    bả vai: càng cao so với khớp càng theo bả vai (tới 70 %) → tay đung đưa khi đi bộ không kéo đỉnh vai trĩu xuống;
    mặt dưới / nách vẫn theo cánh tay nên giơ tay vẫn co giãn tự nhiên.
    """
    rb = 0.054 * body.armR
    for s, sx in (("L", 1), ("R", -1)):
        up, sh = ob.vertex_groups.get(f"UpperArm.{s}"), ob.vertex_groups.get(f"Shoulder.{s}")
        if up is None:
            continue
        sh = sh or ob.vertex_groups.new(name=f"Shoulder.{s}")
        c = body.bone(f"UpperArm.{s}")
        for v in ob.data.vertices:
            p = ob.matrix_world @ v.co
            if (p.x - c.x) * sx < -2.5 * rb or (p - c).length > 2.4 * rb:
                continue
            w = next((g.weight for g in v.groups if g.group == up.index), 0.0)
            if w <= 0:
                continue
            k = 0.6 * mc.smooth01((p.z - c.z + 0.2 * rb) / (1.4 * rb)) * (1 - mc.smooth01(((p - c).length - 1.6 * rb) / (0.8 * rb)))
            if k <= 0:
                continue
            ws = next((g.weight for g in v.groups if g.group == sh.index), 0.0)
            up.add([v.index], w * (1 - k), "REPLACE")
            sh.add([v.index], ws + w * k, "REPLACE")


def build_body(spec, body):
    rnd = random.Random(11)
    P = mc.P
    skin = mc.mat("Skin", P["skin"], 0.72)  # một chất liệu da cho mặt, tai, cổ, tay, chân → tông da đồng nhất
    top = spec.get("top") or {}
    bottom = spec.get("bottom") or {}
    shoes = spec.get("shoes") or {}
    acc = set(spec.get("accessories") or [])
    acc_c = rgb(spec.get("accessoryColor"), (1.0, 0.83, 0.23))
    top_c = rgb(top.get("color"), (0.3, 0.67, 0.97))
    pat_c = rgb(top.get("patternColor"), (1.0, 1.0, 1.0))
    top_style = top.get("style", "tshirt")
    pattern = top.get("pattern", "none")
    top_m = mc.mat("Top", (1, 1, 1), 0.85, image=pattern_image(pattern, top_c, pat_c)) if pattern in ("stripes", "dots", "plaid", "flowers") else mc.mat("Top", top_c, 0.85)
    plain = mc.mat("TopPlain", top_c, 0.85)
    bot_style = "dress" if top_style == "dress" else bottom.get("style", "pants")
    bot_m = mc.mat("Bottom", rgb(bottom.get("color"), (0.2, 0.27, 0.4)), 0.9)
    # Nhân vật gốc (không mặc): thân = da, dáng búp bê trơn (không chi tiết giải phẫu); chân như quần dài nhưng bằng da
    # (hông + chân liền mạch). Nhân vật mới phát triển từ bản này chỉ cần đổi style áo / quần / giày.
    if top_style == "none":
        top_m = plain = skin
    if bot_style == "none":
        bot_m, bot_style = skin, "pants"
    t = body.tz
    sw, sd, st = body.sw, body.sd, body.st

    # thân áo (UV quấn 2 vòng → hoạ tiết không quá to)
    secs = list(body.torso)
    if top_style == "none":
        # thân trần: bụng thon dần xuống hông (bằng bề ngang / dày của hông + đùi) → không có gờ như mép áo ở eo
        r_t = 0.086 * body.legR * body.thigh_k
        (z0, rx0, ry0), zc = secs[0], body.crotch
        secs = [(zc + 0.2 * (z0 - zc), rx0 * 0.93, r_t * 1.02), (zc + 0.6 * (z0 - zc), rx0 * 0.97, 0.5 * (r_t + ry0))] + secs
    def y_off(z):
        """Thân trần: quanh bụng tâm mặt cắt dịch ra trước → bụng hơi lồi, lưng dưới hơi lõm (thân không phẳng như ống)."""
        if top_style != "none":
            return 0.0
        zb = t(1.03)
        # + ngực trên hơi nhô ra trước (khối ngực tròn mềm dưới xương quai xanh)
        return -0.016 * sd * math.exp(-((z - zb) / (0.09 * st)) ** 2) - 0.006 * sd * math.exp(-((z - t(1.28)) / (0.06 * st)) ** 2)

    ob = mc.loft("Torso", [((0, y_off(z), z), rx, ry) for z, rx, ry in secs], top_m, ["Hips", "Spine", "Chest", "Shoulder.L", "Shoulder.R"], segs=24, uv_scale=(2, 1.2))
    uv_by_height(ob, body)
    mc.PARTS[-1] = (ob, ["Hips", "Spine", "Chest", "Shoulder.L", "Shoulder.R", "UpperLeg.L", "UpperLeg.R"], torso_weights(body))

    def patch(name, corners, material, n=6):
        """Miếng phẳng dán theo mặt thân: corners = [(a, z)] ×3 (tam giác)."""
        (a0, z0), (a1, z1), (a2, z2) = corners
        verts, faces, idx = [], [], {}
        for i in range(n + 1):
            for j in range(n + 1 - i):
                u, v = i / n, j / n
                w = 1 - u - v
                idx[(i, j)] = len(verts)
                verts.append(body.on_torso(a0 * w + a1 * u + a2 * v, z0 * w + z1 * u + z2 * v, 0.004))
        for i in range(n):
            for j in range(n - i):
                faces.append((idx[(i, j)], idx[(i + 1, j)], idx[(i, j + 1)]))
                if j + 1 <= n - i - 1:
                    faces.append((idx[(i + 1, j)], idx[(i + 1, j + 1)], idx[(i, j + 1)]))
        return mc.new_obj(name, verts, faces, material, ["Chest"], uvs=[(0.15, 0.85)] * len(verts))

    if top_style == "shirt":
        patch("ChestV", [(0.62, t(1.366)), (-0.62, t(1.366)), (0.0, t(1.215))], skin)
        for sx in (1, -1):
            patch(f"Collar.{sx}", [(0.7 * sx, t(1.368)), (0.1 * sx, t(1.225)), (0.78 * sx, t(1.29))], plain)
        for i, z in enumerate((1.17, 1.08, 0.99)):
            mc.ellipsoid(f"Button{i}", body.on_torso(0, t(z), 0.004), (0.008, 0.004, 0.008), mc.mat("Button", shade(top_c, 0.6), 0.5), ["Chest", "Spine"], segs=8, rings=4)
    elif top_style in ("tshirt", "longsleeve", "hoodie", "dress"):
        rx, ry = body.torso_r(t(1.352))
        mc.torus("NeckBand", (0, 0, t(1.355)), 0.1, 0.007, plain, ["Chest"], scale=(rx / 0.1, ry / 0.1))
    if top_style == "hoodie":
        mc.ellipsoid("Hood", (0, body.torso_r(t(1.3))[1] * 0.55 + 0.03, body.N + 0.005), (0.12 * sw, 0.07 * sd, 0.07), plain, ["Chest", "Neck"], segs=18, rings=10)
        for sx in (1, -1):
            z0 = t(1.33)
            p0 = body.on_torso(0.2 * sx, z0, 0.006)
            mc.limb(f"String.{sx}", p0, body.on_torso(0.2 * sx, z0 - 0.11 * st, 0.006), [(0, 0.004), (1, 0.004)], mc.mat("String", pat_c, 0.6), ["Chest"], segs=6)

    # hông / váy
    hipk = 1.06 if body.female else 1.0
    if bot_style in ("pants", "shorts"):
        build_seat(body, bot_m, 1.05 if bot_style == "shorts" else 1.0)
    else:
        knee_z = body.bone("LowerLeg.L").z
        zb = knee_z - 0.02 * body.sl if bot_style == "dress" else knee_z + 0.08 * body.sl
        rx0, ry0 = 0.152 * sw * hipk, 0.104 * sd
        zw = t(0.95)
        secs = [((0, 0, zw), rx0, ry0), ((0, 0, zw - (zw - zb) * 0.3), rx0 * 1.12, ry0 * 1.14), ((0, 0, zb), rx0 * 1.5, ry0 * 1.55)]
        ob = mc.loft("Skirt", secs, top_m if bot_style == "dress" else bot_m, ["Hips", "UpperLeg.L", "UpperLeg.R"], segs=28, cap_end=False, uv_scale=(2, 0.8))

        def skirt_w(p, zw=zw, zb=zb):
            k = 0.6 * mc.smooth01((zw - p.z) / max(zw - zb, 1e-3))
            wl, wr = k * mc.smooth01(0.5 + p.x / 0.12), k * mc.smooth01(0.5 - p.x / 0.12)
            return {"Hips": 1.0 - wl - wr, "UpperLeg.L": wl, "UpperLeg.R": wr}

        mc.PARTS[-1] = (ob, ["Hips", "UpperLeg.L", "UpperLeg.R"], skirt_w)

    # cổ + đầu hình trứng
    # vai trần: cổ cắm sâu vào trong đầu → ngửa / cúi đầu không lộ mép trên của cổ dưới cằm
    neck_top = mc.HEAD_C.z - (0.015 if body.bare else 0.05)
    # vai trần: chân cổ loe ra nối mềm vào vai (không gãy góc cổ – vai), thon dần lên đầu
    # (loe vừa phải + chân cổ cắm sâu trong thân: loe to sát mặt thân sẽ đúc thành gờ ngang như cổ áo ở lưng trên)
    # (gờ nối cổ – thân còn lại được làm mượt sau khi đúc – neck_fair trong body_fair)
    neck_prof = [(0, body.neck_r * 1.24), (0.3, body.neck_r * 1.08), (0.65, body.neck_r * 0.97), (1, body.neck_r * 0.9)] if body.bare else [(0, body.neck_r), (1, body.neck_r * 0.9)]
    mc.limb("Neck", (0, 0.005, body.N - (0.04 if body.bare else 0.01)), (0, 0.005, neck_top), neck_prof, skin, ["Neck", "Chest", "Head"])
    rows, cols = 26, 36
    hv = [mc.head_point(mc.head_dir(pi * i / rows, 2 * pi * j / cols - pi)) for i in range(rows + 1) for j in range(cols)]
    hf = [(i * cols + j, (i + 1) * cols + j, (i + 1) * cols + (j + 1) % cols, i * cols + (j + 1) % cols) for i in range(rows) for j in range(cols)]
    mc.new_obj("Head", hv, hf, skin, ["Head"])
    nk = body.nose
    (nx, ny, nz), nose_z, nose_out, wings = face_opt(NOSES, "nose", "normal")
    noses = [mc.ellipsoid("Nose", mc.on_head(0, nose_z, nose_out), (nx * nk, ny * nk, nz * nk), skin, ["Head"], segs=20, rings=12)]
    if wings:  # cánh mũi
        for sx in (1, -1):
            noses.append(mc.ellipsoid(f"NoseWing.{sx}", mc.on_head(sx * 0.019 * nk, nose_z - 0.006, 0.002), (0.01 * nk, 0.01 * nk, 0.009 * nk), skin, ["Head"], segs=10, rings=6))
    shade_nose(noses)
    gold = mc.mat("Gold", (1.0, 0.76, 0.2), 0.3, 0.35)
    ek, eo = face_opt(EARS, "ears", "normal")
    for sx in (1, -1):
        c = mc.head_point(mc.head_dir(pi / 2 + 0.06, sx * pi / 2 + sx * 0.08)) + Vector(((0.008 + eo) * sx, 0, 0))
        mc.ellipsoid(f"Ear.{sx}", c, (0.017 * ek, 0.028 * ek, 0.04 * ek), skin, ["Head"], segs=14, rings=8)
        if "earrings" in acc:
            mc.ellipsoid(f"Earring.{sx}", c + Vector((0.012 * sx, -0.004, -0.036 * ek)), (0.007, 0.007, 0.007), gold, ["Head"], segs=10, rings=6)

    hat = next((h for h in ("cap", "beanie", "sunhat") if h in acc), None)
    hair = spec.get("hair") or {}
    hair_c = rgb(hair.get("color"), (0.23, 0.16, 0.12))
    build_hair(hair.get("style", "short"), hair_c, hat, body, rnd)
    build_facial_hair(spec.get("facialHair", "none"), hair_c)
    if "glasses" in acc or "sunglasses" in acc:
        build_glasses("sunglasses" in acc, acc_c if "glasses" in acc else (0.1, 0.1, 0.12))
    if hat:
        build_hat(hat, acc_c, pat_c)

    # tay + tay áo + bàn tay
    sleeve = {"tshirt": "short", "shirt": "short", "dress": "short", "longsleeve": "long", "hoodie": "long"}.get(top_style, "none")
    ar = body.armR
    for s, sx in (("L", 1), ("R", -1)):
        sh, el = body.bone(f"UpperArm.{s}"), body.bone(f"LowerArm.{s}")
        wr, ha = body.bone(f"Hand.{s}"), body.bone(f"Hand.{s}", 1)
        # Khớp vai kiểu "quả cầu": đoạn vai cố định (theo ngực / xương vai) từ trong thân ra tới khớp + quả cầu tâm
        # đúng khớp xoay (theo xương cánh tay → xoay tại chỗ, bả vai luôn tròn đầy) + tay áo / cánh tay đi cứng theo
        # xương cánh tay từ khớp trở ra (không trộn với xương vai → không bị bóp dẹp khi nhấc tay).
        upper, lower = f"UpperArm.{s}", f"LowerArm.{s}"
        arm_w = mc.chain_weights([upper, (el, wr - el, 0.035, lower)])
        pts, ts = mc.polyline([sh, el, wr])
        prof = ARM_PROF
        t0 = {"short": 0.15, "long": 0.8}.get(sleeve, 0.0)  # da tay chỉ phần lộ ra ngoài tay áo
        keep = [i for i, x in enumerate(ts) if x >= t0]
        radii = [interp(prof, ts[i]) * ar for i in keep]
        apts = [pts[i] for i in keep]
        if body.base_prop:
            # cổ tay thon dần về bề dày lòng bàn tay (không còn bậc như cổ tay áo ở chỗ ống cẳng tay gặp bàn tay)
            # cổ tay rõ: cẳng tay thon dần về cổ tay (nhỏ hơn bề ngang lòng bàn tay) rồi mới nở ra bàn tay → không thành cục
            wrist_r = 0.0215 * body.hand * 1.15
            radii = [r if ts[i] < 0.7 else r + (wrist_r - r) * mc.smooth01((ts[i] - 0.7) / 0.3) for r, i in zip(radii, keep)]
            d_hand = (ha - wr).normalized()
            apts.append(wr + d_hand * 0.022 * body.hand)
            radii.append(wrist_r * 0.95)
        mc.limb_path(f"Arm.{s}", apts, radii, skin, [upper, lower], weights=arm_w)
        cloth = top_m if sleeve != "none" else skin
        rb = (0.054 if sleeve != "none" else 0.045) * ar  # bán kính quả cầu vai = ống tay áo ở vai
        if body.bare:
            rb = 0.0425 * ar  # vai trần: đầu vai to bằng đúng ống cánh tay (ARM_PROF) → vai – tay liền một đường cong, không gờ
        yoke_w = mc.chain_weights(["Chest", (sh + Vector((-0.07 * sx * sw, 0, 0)), Vector((sx, 0, 0)), 0.04, f"Shoulder.{s}")])
        # vai trần: đầu trong của đoạn vai nằm cao (sát chân cổ) → bờ vai là một dốc xuôi xuống khớp vai
        y_in = sh + (Vector((-0.1 * sx * sw, 0, 0.034 * st)) if body.slope else Vector((-0.12 * sx * sw, 0, -0.012 * st)))
        if body.bare:
            y_in = sh + Vector((-0.1 * sx * sw, 0, 0.1 * rb))  # vai trần: đoạn vai nằm ngang dưới đường dốc vai (không độn cao)
        ypts, yts = mc.polyline([y_in, sh], 5)
        # đoạn vai to bằng quả cầu khớp → đường vai là một dốc trơn từ cổ xuống tay (không bậc / cục gồ); tay áo
        # (103 %) trùm nửa ngoài quả cầu. Các khối được gộp + đúc lại thành một lưới (merge_shirt) nên chồng nhau không sao.
        uv_by_height(mc.limb_path(f"Yoke.{s}", ypts, [rb * ((0.8 + 0.2 * x) if body.slope else (0.97 + 0.03 * x)) for x in yts], cloth, ["Chest", f"Shoulder.{s}"], caps=True, uv_scale=(1, 0.3), weights=yoke_w), body)
        uv_by_height(uv_sphere(f"ShoulderBall.{s}", sh, rb, cloth, [upper]), body)
        if body.slope:
            # khối cơ vai (cơ thang + delta) từ chân cổ ra tới khớp vai, dày gần bằng thân → đường vai là một dốc tròn
            # liền từ cổ ra tay (không còn chữ T: ngực tròn cao + đỉnh vai phẳng như bậc + vết lõm ở giữa)
            # dạng ống dốc (đầu trong cao sát chân cổ → đầu ngoài thấp ở khớp vai): đỉnh vai tròn xuôi, không phẳng như
            # kệ; dày vừa (≈ 2 × bán kính tay, mỏng hơn thân) và lệch nhẹ ra trước → nhìn nghiêng không gù ra sau
            ry = body.torso_r(sh.z)[1]
            fy = -0.12 * ry
            mid_z = sh.z + 0.75 * rb
            if body.bare:
                # vai trần (như vai người thật): đường vai từ chân cổ dốc xuống đều, mềm qua vùng xương quai xanh rồi
                # tròn qua đầu vai – đỉnh: chân cổ 1.15 rb → giữa 1.05 rb → đầu vai 1.0 rb (không gù / bướu gần cổ, đỉnh
                # đầu vai không cao hơn xương quai xanh); ống thon ở trong, to dần ra ngoài = bằng quả cầu đầu vai
                # nhìn thẳng: đường cong LÕM nhẹ – dốc hơn ở sát cổ (cơ thang), thoải dần ra đầu vai (~11°), không ngang
                # như mắc áo; đỉnh: 1.7 rb (bên cổ) → 1.25 rb → 1.0 rb (đầu vai)
                tpts, tts = mc.polyline([Vector((sh.x * 0.15, fy, sh.z + 1.0 * rb)), Vector((sh.x * 0.55, (fy + sh.y) * 0.5, sh.z + 0.45 * rb)), Vector((sh.x * 0.9, sh.y, sh.z + 0.05 * rb))], 5)
                radii = [rb * (0.7 + 0.25 * x) for x in tts]
            else:
                tpts, tts = mc.polyline([Vector((sh.x * 0.2, fy, sh.z + 1.15 * rb)), Vector((sh.x * 0.6, (fy + sh.y) * 0.5, mid_z)), Vector((sh.x * 0.95, sh.y, sh.z + 0.1 * rb))], 4)
                radii = [rb * (0.85 + 0.15 * x) for x in tts]
            mc.limb_path(f"Trap.{s}", tpts, radii, cloth, ["Chest", f"Shoulder.{s}"], caps=True)
        if sleeve == "short":
            spts, sts = mc.polyline([sh, sh.lerp(el, 0.45)], 5)
            uv_by_height(mc.limb_path(f"Sleeve.{s}", spts, [rb * 1.03 * (1 + 0.04 * x) for x in sts], top_m, [upper], caps=True, uv_scale=(1, 0.5)), body)
        elif sleeve == "long":
            sw_fn = mc.chain_weights([upper, (el, wr - el, 0.04, lower)])
            spts, sts = mc.polyline([sh, el, wr.lerp(el, 0.06)], 5)
            sprof = [(0, 1.0), (0.4, 0.95), (0.7, 0.88), (1, 0.8)]
            uv_by_height(mc.limb_path(f"Sleeve.{s}", spts, [interp(sprof, x) * rb * 1.03 for x in sts], top_m, [upper, lower], caps=True, uv_scale=(1, 1.0), weights=sw_fn), body)
        build_hand(body, s, wr, ha, skin)
        if s == "L" and "watch" in acc:
            mc.torus("Watch", wr + Vector((0, 0, 0.022 * body.sa)), 0.036 * ar + 0.002, 0.008, mc.mat("Watch", acc_c, 0.35, 0.3), ["LowerArm.L"])

        # chân + giày
        hip, kn, an = body.bone(f"UpperLeg.{s}"), body.bone(f"LowerLeg.{s}"), body.bone(f"Foot.{s}")
        lr = body.legR
        # chân kéo xuống tận trong giày (không cụt lơ lửng trên giày); dáng: đùi đầy → gối thon → bắp chân → cổ chân nhỏ
        lpts, lts = mc.polyline([hip - Vector((0, 0, 0.01 * st)), kn, an + Vector((0, 0, -0.005 * body.sf))], 7)
        # đùi to → gối thon → bắp chân (nhỏ hơn đùi rõ) → cổ chân mảnh (tỉ lệ bán kính ≈ 1.5 : 1 : 0.7)
        prof0 = [(0, 0.088), (0.18, 0.084), (0.38, 0.066), (0.5, 0.05), (0.62, 0.057), (0.72, 0.053), (0.86, 0.04), (1, 0.035)]
        if body.base_prop:
            # chân trần trẻ em: gối không thắt, bắp chân tròn đầy liền xuống cổ chân (không bẻ góc); cổ chân như cũ
            prof0 = [(0, 0.088), (0.18, 0.083), (0.36, 0.071), (0.5, 0.061), (0.6, 0.062), (0.7, 0.058), (0.8, 0.049), (0.9, 0.039), (1, 0.035)]
        # đùi thu về bề ngang hông (thigh_k), từ gối trở xuống giữ nguyên
        lprof = [(x, r * (body.thigh_k + (1 - body.thigh_k) * mc.smooth01(x / 0.5))) for x, r in prof0]
        if s == "L":
            print("LEGPROF " + " ".join(f"{x:.2f}:{r * lr * 1000:.0f}" for x, r in lprof) + f" mm (thigh_k {body.thigh_k:.2f})")
        leg_w = mc.chain_weights(["Hips", (hip, kn - hip, 0.07, f"UpperLeg.{s}"), (kn, an - kn, 0.04, f"LowerLeg.{s}")])
        bones = [f"UpperLeg.{s}", f"LowerLeg.{s}", "Hips"]
        # Có quần: ống quần liền một mạch từ trong áo (trên gấu) xuống gấu quần → mặt ngoài không có đường nối nào;
        # bề ngang đã giới hạn theo gấu áo (thigh_k) nên không lòi ra ngoài áo. Da chân nằm lọt trong ống quần.
        foot = an + Vector((0, 0, -0.005 * body.sf))
        span = max(hip.z - an.z, 1e-3)
        hem_z, top_z = body.torso[0][0], t(0.95)
        # dáng chân theo độ cao; phần nằm trong áo (trên gấu) thon dần còn 85 % → luôn cách mặt áo, không xuyên áo
        inner = lambda q: 1.0 - 0.15 * mc.smooth01((q.z - hem_z) / max(top_z - hem_z, 1e-3))  # noqa: E731
        def prof_at(x):  # chân trần: nội suy nhoè (trung bình ±5 %) → dáng chân cong mềm, không gãy khúc ở các mốc
            if not body.base_prop:
                return interp(lprof, x)
            return sum(interp(lprof, min(1.0, max(0.0, x + d * 0.0125))) for d in range(-4, 5)) / 9

        rad = lambda q, f: prof_at(max(0.0, hip.z - q.z) / span) * lr * f * inner(q)  # noqa: E731
        if bot_style in ("pants", "shorts"):
            top = Vector((hip.x, hip.y, t(0.95)))
            if bot_style == "pants":
                ppts, _ = mc.polyline([top, hip, kn, foot], 14 if body.bare else 6)
                mc.limb_path(f"Leg.{s}", ppts, [rad(q, 1.0) for q in ppts], bot_m, bones, segs=32 if body.bare else 16, weights=leg_w)
            else:
                spts, _ = mc.polyline([top, hip, hip.lerp(kn, 0.72)], 5)
                n_s = len(spts)
                radii = [rad(q, 1.05) * (1 + 0.06 * mc.smooth01((i / (n_s - 1) - 0.4) / 0.6)) for i, q in enumerate(spts)]
                mc.limb_path(f"Shorts.{s}", spts, radii, bot_m, bones, caps="start", weights=leg_w)
                # mép gấu bo tròn (viền cuộn) thay cho mép cắt thẳng
                mc.torus(f"ShortsHem.{s}", spts[-1], radii[-1] - 0.002, 0.0065, bot_m, [f"UpperLeg.{s}"], segs=28, rsegs=8)
                kpts, _ = mc.polyline([Vector((hip.x, hip.y, body.crotch + 0.012)), kn, foot], 14 if body.base_prop else 7)
                mc.limb_path(f"Leg.{s}", kpts, [rad(q, 0.93) for q in kpts], skin, bones, segs=32 if body.base_prop else 16, weights=leg_w)
        else:
            mc.limb_path(f"Leg.{s}", lpts, [interp(lprof, x) * lr * 0.96 for x in lts], skin, bones, weights=leg_w)
        sf = body.sf
        g = sf * (1.16 if body.kid else 1.04)
        if shoes.get("style") == "barefoot":
            # bàn chân trần tròn kiểu hoạt hình (ống chân cắm vào trong, không lộ mối nối)
            mc.ellipsoid(f"Foot.{s}", an + Vector((0, -0.045 * g, -0.05 * sf)), (0.052 * g, 0.098 * g, 0.056 * g), skin, [f"Foot.{s}", f"LowerLeg.{s}"], segs=22, rings=12)
            mc.ellipsoid(f"Toes.{s}", an + Vector((0, -0.1 * g, -0.062 * sf)), (0.047 * g, 0.045 * g, 0.036 * g), skin, [f"Foot.{s}"], segs=18, rings=10)
            continue
        shoe_m = mc.mat("Shoe", rgb(shoes.get("color"), (0.97, 0.97, 0.97)), 0.6)
        acc_m = mc.mat("ShoeAccent", rgb(shoes.get("accent"), (0.9, 0.15, 0.2)), 0.5)
        sole = mc.mat("Sole", (0.3, 0.3, 0.32), 0.8)
        # giày tròn trịa kiểu hoạt hình: thân giày vồng, mũi giày tròn nhô, đế bo tròn (trẻ em giày to hơn chút)
        mc.ellipsoid(f"Shoe.{s}", an + Vector((0, -0.05 * g, -0.048 * sf)), (0.06 * g, 0.105 * g, 0.068 * g), shoe_m, [f"Foot.{s}"], segs=22, rings=12, cut=-0.55)
        mc.ellipsoid(f"ShoeToe.{s}", an + Vector((0, -0.11 * g, -0.055 * sf)), (0.052 * g, 0.05 * g, 0.042 * g), shoe_m, [f"Foot.{s}"], segs=18, rings=10)
        mc.ellipsoid(f"Sole.{s}", an + Vector((0, -0.058 * g, -0.078 * sf)), (0.064 * g, 0.118 * g, 0.03 * g), sole, [f"Foot.{s}"], segs=22, rings=10)
        mc.ellipsoid(f"Stripe.{s}", an + Vector((0.058 * sx * g, -0.06 * g, -0.045 * sf)), (0.006 * g, 0.05 * g, 0.013 * g), acc_m, [f"Foot.{s}"], segs=10, rings=6)
        mc.ellipsoid(f"ShoeTongue.{s}", an + Vector((0, -0.01 * g, 0.004 * sf)), (0.034 * g, 0.03 * g, 0.022 * g), acc_m, [f"Foot.{s}", f"LowerLeg.{s}"], segs=12, rings=8)

    if sleeve != "none":
        merge_shirt(body, top_m, sleeve, plain)
    elif top_style == "none":
        # thân + vai + tay + bàn tay (+ hông khi cũng không mặc quần) bằng da → một lớp da liền, không khớp vai / eo
        ob = merge_body(body, skin, extra=("Seat",) if bottom.get("style") == "none" else ())
        check_symmetry(ob)
        shade_body(ob, body, mc.P["skin"])
    if top_style != "none":
        for s in ("L", "R"):
            merge_arm(body, s, skin, sleeve)

    # phụ kiện thân
    front = lambda z: -body.torso_r(z)[1]  # noqa: E731
    if "backpack" in acc:
        bp = mc.mat("Backpack", acc_c, 0.7)
        shirt_bvh = None
        if bpy.data.objects.get("Shirt") or bpy.data.objects.get("Body"):
            from mathutils.bvhtree import BVHTree
            shirt_bvh = BVHTree.FromObject(bpy.data.objects.get("Shirt") or bpy.data.objects.get("Body"), bpy.context.evaluated_depsgraph_get())
        back_y = body.torso_r(t(1.23))[1]
        k = max(sw, 0.8)
        mc.ellipsoid("Backpack", (0, back_y + 0.055 * k, t(1.12)), (0.12 * k, 0.065 * k, 0.15 * max(st, 0.75)), bp, ["Chest", "Spine"], segs=20, rings=12)
        mc.ellipsoid("BackpackPocket", (0, back_y + 0.115 * k, t(1.06)), (0.08 * k, 0.02 * k, 0.07 * max(st, 0.75)), mc.mat("BackpackPocket", shade(acc_c, 0.8), 0.7), ["Chest", "Spine"], segs=14, rings=8)
        for sx in (1, -1):
            x = 0.085 * sx * sw
            pts = [Vector((x, back_y, t(1.27))), Vector((x * 1.05, 0.0, t(1.372))), Vector((x, front(t(1.23)) - 0.008, t(1.23))), Vector((x * 1.1, front(t(1.05)) - 0.006, t(1.02)))]
            if shirt_bvh:
                # quai ôm theo mặt áo thật (đã đúc): dò từ trên xuống ở vài điểm từ sau ra trước vai
                arc = []
                for yy in (back_y * 0.7, back_y * 0.35, 0.0, front(t(1.3)) * 0.4, front(t(1.3)) * 0.75):
                    hit = shirt_bvh.ray_cast(Vector((x * 1.05, yy, body.N + 0.3)), Vector((0, 0, -1)))[0]
                    if hit is not None:
                        arc.append(hit + Vector((0, 0, 0.012)))  # quai (bán kính 11 mm) nằm trên mặt áo
                if len(arc) >= 3:
                    pts = [Vector((x, back_y, min(t(1.27), arc[0].z - 0.02)))] + arc + [Vector((x, front(t(1.23)) - 0.008, min(t(1.23), arc[-1].z - 0.02))), pts[-1]]
            ppts, _ = mc.polyline(pts, 4)
            mc.limb_path(f"Strap.{sx}", ppts, [0.011] * len(ppts), bp, ["Chest", "Spine"], segs=8)
    if "necklace" in acc:
        chain = [body.on_torso(a, t(1.362) - 0.09 * st * max(0.0, math.cos(a)) ** 2, 0.006) for a in (2 * pi * i / 40 - pi for i in range(41))]
        mc.limb_path("Necklace", chain, [0.0045] * len(chain), gold, ["Chest", "Neck"], segs=8, caps=False)
        mc.ellipsoid("Pendant", body.on_torso(0, t(1.362) - 0.09 * st - 0.018, 0.01), (0.011, 0.005, 0.015), gold, ["Chest"], segs=10, rings=6)
    if "bowtie" in acc:
        y, z = 0.005 - body.neck_r - 0.012, body.N + 0.004
        bt = mc.mat("Bowtie", acc_c, 0.5)
        for sx in (1, -1):
            mc.cone(f"Bow.{sx}", (0.045 * sx, y, z), (0, y, z), 0.024, bt, ["Chest"], segs=10)
        mc.ellipsoid("BowKnot", (0, y - 0.004, z), (0.012, 0.01, 0.012), bt, ["Chest"], segs=10, rings=6)
    if "tie" in acc:
        zs = [t(1.33), t(1.29), t(1.18), t(1.07), t(1.02)]
        pts = [body.on_torso(0, z, 0.008) for z in zs]
        mc.strand("Tie", pts, [0.014, 0.018, 0.026, 0.032, 0.004], [0.006] * 5, mc.mat("Tie", acc_c, 0.5), ["Chest", "Spine"])
    if "scarf" in acc:
        sc = mc.mat("Scarf", acc_c, 0.85)
        mc.torus("Scarf", (0, 0.005, body.N + 0.012), body.neck_r + 0.022, 0.026, sc, ["Chest", "Neck"])
        p0 = Vector((0.035, 0.005 - body.neck_r - 0.03, body.N))
        mc.limb_path("ScarfTail", [p0, Vector((0.045, front(t(1.2)) - 0.03, t(1.2))), Vector((0.05, front(t(1.1)) - 0.028, t(1.08)))], [0.024, 0.022, 0.02], sc, ["Chest"], segs=10)


# ---------------------------------------------------------------- xem trước

def preview(path, rig, top):
    """<path> = toàn thân 3/4 (cười); <path>_face.png = cận mặt."""
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.color_type = "MATERIAL"
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.75, 0.85, 0.95, 1)
    scene.world = world
    scene.view_settings.view_transform = "Standard"  # màu gần với engine (không AgX)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    bpy.context.collection.objects.link(sun)
    scene.render.resolution_x, scene.render.resolution_y = 480, 600
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    face = bpy.data.objects["Face"]
    rig.animation_data_create()
    for tr in rig.animation_data.nla_tracks:
        tr.mute = True
    idle = bpy.data.actions.get("Idle")
    rig.animation_data.action = idle
    scene.frame_set(0)

    def shot(file, loc, look, lens, keys):
        for kb in face.data.shape_keys.key_blocks[1:]:
            kb.value = keys.get(kb.name, 0.0)
        cam.location = loc
        cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        scene.render.filepath = file
        bpy.ops.render.render(write_still=True)
        print(f"PREVIEW {file}")

    d = top * 1.75
    if os.environ.get("AC_EXTRA"):
        # Kiểm tra: động tác Mixamo (toàn thân) + cận bàn tay phải.
        hand = Vector(mc.BONES["Hand.R"][0])
        for act, frame in (("Point", 40), ("ThumbsUp", 20), ("Wave", 20), ("Clap", 20)):
            if bpy.data.actions.get(act):
                rig.animation_data.action = bpy.data.actions[act]
                scene.frame_set(frame)
                shot(path.replace(".png", f"_{act}.png"), (0.2 * d, -0.98 * d, 0.6 * top), (0, 0, 0.55 * top), 50, {"happy": 0.5})
                bpy.context.view_layer.update()
                h = rig.matrix_world @ rig.pose.bones["Hand.R"].tail
                shot(path.replace(".png", f"_{act}_hand.png"), (h.x - 0.12, h.y - 0.4, h.z + 0.05), (h.x, h.y, h.z), 60, {})
        rig.animation_data.action = idle
        scene.frame_set(0)
        shot(path.replace(".png", "_hand.png"), (hand.x - 0.25, hand.y - 0.3, hand.z), (hand.x, hand.y, hand.z - 0.06), 60, {})
        # xoay quanh: trước, nghiêng, sau, 3/4 sau (tỉ lệ, tay xuyên áo)
        for name, ang in (("front", 0), ("side", 90), ("back", 180), ("back34", 135)):
            a = math.radians(ang)
            shot(path.replace(".png", f"_{name}.png"), (math.sin(a) * d, -math.cos(a) * d, 0.55 * top), (0, 0, 0.5 * top), 50, {})
        # cận nửa thân trên (vai / tay áo) khi đứng, vẫy tay, giơ tay
        chest = Vector((0, 0, mc.BONES["Chest"][0][2]))
        for act, frame in (("Idle", 0), ("Wave", 20), ("Victory", 30), ("Walk", 8), ("Walk", 23), ("Run", 5), ("Run", 13)):
            if not bpy.data.actions.get(act):
                continue
            rig.animation_data.action = bpy.data.actions[act]
            scene.frame_set(frame)
            for name, ang in (("f", 20), ("b", 200)):
                a = math.radians(ang)
                shot(path.replace(".png", f"_up_{act}{frame}_{name}.png"), chest + Vector((math.sin(a) * 1.1, -math.cos(a) * 1.1, 0.1)), chest + Vector((0, 0, 0.02)), 50, {})
        rig.animation_data.action = idle
        scene.frame_set(0)
    shot(path, (0.36 * d, -0.93 * d, 0.58 * top), (0, 0, 0.5 * top), 50, {"happy": 0.8})
    hc = mc.HEAD_C
    shot(path.replace(".png", "_face.png"), (hc.x + 0.28, hc.y - 0.95, hc.z + 0.04), (hc.x, hc.y, hc.z - 0.02), 60, {"happy": 0.6, "aa": 0.35})


# ---------------------------------------------------------------- main

SPEC = {}


def main():
    a = args()
    if not a["spec"]:
        raise SystemExit("Thiếu --spec <file.json>")
    data = json.load(open(a["spec"], encoding="utf8"))
    SPEC.update(data["spec"] if isinstance(data.get("spec"), dict) else data)  # storage/characters/<id>/spec.json bọc {assetId, prompt, spec}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    body = Body(SPEC)
    apply_face()
    skin_c = rgb(SPEC.get("skin"), (0.93, 0.72, 0.56))
    hair = SPEC.get("hair") or {}
    hair_c = rgb(hair.get("color"), (0.23, 0.16, 0.12))
    blush_k = face_opt(CHEEKS, "cheeks", "blush")[1]
    mc.P.update({
        "skin": skin_c,
        "iris": rgb(SPEC.get("eyes"), (0.42, 0.26, 0.14)),
        "blush": mix(skin_c, (0.97, 0.5, 0.52), blush_k or 0.45),
        "lip": mix(skin_c, (0.88, 0.36, 0.42), 0.55 if body.female else 0.42),
        "brow": shade(hair_c, 0.75) if hair.get("style") != "bald" else shade(skin_c, 0.45),
        "mouth": (0.55, 0.12, 0.16) if body.female else (0.36, 0.07, 0.09),
    })
    step("body")
    build_body(SPEC, body)
    mc.build_face()
    # tỉ lệ base (nhân vật gốc / proportions = base): đầu nhỏ lại chút → đầu : chiều cao ≈ 1 : 3.3–3.5
    scale_head(body, {"toddler": 1.14, "child": 1.13, "teen": 1.06}.get(body.age, 1.0) * (0.86 if body.base_kid else 1.0))
    rig = mc.build_armature()
    # lưới liền (áo, tay) → bone heat; phần còn lại → trọng lượng tự tính
    auto = [p for p in mc.PARTS if p[2] in ("auto", "auto_limb", "auto_body")]
    mc.PARTS[:] = [p for p in mc.PARTS if p[2] not in ("auto", "auto_limb", "auto_body")]
    mc.skin(rig)
    for ob, allowed, kind in auto:
        auto_weights(rig, ob, allowed, body, kind)
    step("actions")
    mc.build_actions(rig)
    if a["mixamo"]:
        step("mixamo")
        mc.load_mixamo(rig, a["mixamo"])
    relax_idle_arms(rig)
    match_shoulders(rig, "Walk", "WalkSwagger")
    damp_shoulders(rig)
    if body.bare:
        shoulder_correctives(rig, body)
    top = max((ob.matrix_world @ v.co).z for ob in bpy.data.objects if ob.type == "MESH" for v in ob.data.vertices)
    chin = min((bpy.data.objects["Head"].matrix_world @ v.co).z for v in bpy.data.objects["Head"].data.vertices)
    print("INFO " + json.dumps({"hips": body.H, "top": top, "headTop": mc.HEAD_C.z + mc.HEAD_RZ}))
    print(f"PROPORTION đầu (cằm → đỉnh tóc) {top - chin:.3f} m · cao {top:.3f} m → 1 : {top / (top - chin):.2f} · chân (đáy quần → đất) {body.crotch / top * 100:.1f} % · khớp hông {body.H / top * 100:.1f} % · vai {2 * body.bone('UpperArm.L').x:.3f} m")
    if a["out"]:
        step("export")
        mc.export_glb(a["out"])
    if a["preview"]:
        step("preview")
        try:
            preview(a["preview"], rig, top)
        except Exception as err:  # ảnh xem trước lỗi không làm hỏng nhân vật
            print(f"PREVIEW-FAIL {err}")


main()
