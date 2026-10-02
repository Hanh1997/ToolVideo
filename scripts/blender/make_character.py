"""
Dựng nhân vật hoạt hình bằng code (Blender, chạy không giao diện) → GLB có xương, biểu cảm khuôn mặt và hoạt ảnh.

    blender -b -P scripts/blender/make_character.py -- --out public/assets/characters/char_ac_danchoi.glb [--preview preview.png]
        [--mixamo D:/Mixamo]   (thay / bổ sung hoạt ảnh bằng hoạt ảnh Mixamo đã tải – xem scripts/mixamo/download.ts)

- Hình: ghép từ các khối "loft" (mặt cắt elip dọc theo trục) → thân, tay chân, giày; đầu cầu; tóc, kính, phụ kiện.
- Xương chuẩn người: Hips → Spine → Chest → Neck → Head; Shoulder/UpperArm/LowerArm/Hand; UpperLeg/LowerLeg/Foot
  (hậu tố .L/.R) – trùng tên engine dùng cho điểm cầm (Hand.R), động tác tay (UpperArm/LowerArm), đầu (Head).
- Trọng lượng da: mỗi bộ phận chỉ gắn vào vài xương cho phép, trọng số theo khoảng cách tới đoạn xương (mượt ở khớp).
- Khuôn mặt: mắt / lông mày / miệng là một mesh riêng "Face" dán lên mặt cầu, có shape key:
  blink, happy, sad, angry, surprised, scared (cảm xúc) và aa, ih, ou, ee, oh (khẩu hình) – engine trộn theo lời thoại.
- Hoạt ảnh (30 fps, tại chỗ): Idle, Walk, Run, Jump, Wave, Yes, No, ThumbsUp, Dance, Victory, Defeat, Clap, PickUp
  tự sinh; có --mixamo → chuyển (retarget) hoạt ảnh Mixamo sang khung xương này: trùng tên thì thay, còn lại thêm mới.

Blender: trục Z lên, nhân vật nhìn về -Y (glTF xuất ra: Y lên, nhìn về +Z), bên trái nhân vật = +X.
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector

# ---------------------------------------------------------------- tham số nhân vật

P = {
    "name": "DanChoi",
    "skin": (0.93, 0.72, 0.56),
    "hair_top": (0.93, 0.8, 0.5),  # vàng tẩy (mái vuốt)
    "hair_top2": (0.84, 0.66, 0.36),  # lọn tóc tối hơn một tông (tạo khối)
    "hair_side": (0.3, 0.23, 0.18),  # hai bên / gáy cắt ngắn
    "shirt_base": (0.98, 0.38, 0.22),  # sơ mi hoa Hawaii
    "shirt_flower": (1.0, 0.95, 0.85),
    "shirt_flower2": (1.0, 0.82, 0.25),
    "shirt_leaf": (0.12, 0.55, 0.35),
    "jeans": (0.16, 0.26, 0.45),
    "jeans_light": (0.45, 0.58, 0.75),
    "belt": (0.12, 0.08, 0.06),
    "gold": (1.0, 0.76, 0.2),
    "shoe": (0.97, 0.97, 0.97),
    "shoe_accent": (0.9, 0.15, 0.2),
    "sole": (0.3, 0.3, 0.32),
    "lens": (0.05, 0.05, 0.08),
    "eye_white": (1.0, 1.0, 1.0),
    "pupil": (0.05, 0.04, 0.04),
    "iris": (0.42, 0.26, 0.14),
    "blush": (0.97, 0.66, 0.6),
    "brow": (0.16, 0.11, 0.08),
    "mouth": (0.36, 0.07, 0.09),
    "teeth": (0.98, 0.97, 0.94),
    "tongue": (0.9, 0.42, 0.45),
}
FPS = 30

# Mốc cơ thể (mét): cao ~1.8 m tính cả mái tóc, đầu to vừa phải kiểu hoạt hình 3D.
HEAD_C = Vector((0, 0.005, 1.555))
HEAD_RX, HEAD_RY, HEAD_RZ = 0.158, 0.152, 0.17
HEAD_R = HEAD_RX  # tương thích chỗ cũ
BONES = {
    # tên: (đầu, đuôi, cha)
    "Hips": ((0, 0, 0.86), (0, 0, 0.98), None),
    "Spine": ((0, 0, 0.98), (0, 0, 1.15), "Hips"),
    "Chest": ((0, 0, 1.15), (0, 0, 1.33), "Spine"),
    "Neck": ((0, 0, 1.33), (0, 0, 1.42), "Chest"),
    "Head": ((0, 0, 1.42), (0, 0, 1.76), "Neck"),
}
for s, sx in (("L", 1), ("R", -1)):
    BONES.update({
        f"Shoulder.{s}": ((0.03 * sx, 0, 1.30), (0.19 * sx, 0, 1.30), "Chest"),
        f"UpperArm.{s}": ((0.2 * sx, 0, 1.30), (0.235 * sx, 0, 1.04), f"Shoulder.{s}"),
        f"LowerArm.{s}": ((0.235 * sx, 0, 1.04), (0.255 * sx, -0.012, 0.81), f"UpperArm.{s}"),
        f"Hand.{s}": ((0.255 * sx, -0.012, 0.81), (0.262 * sx, -0.02, 0.7), f"LowerArm.{s}"),
        f"UpperLeg.{s}": ((0.09 * sx, 0, 0.88), (0.09 * sx, 0, 0.48), "Hips"),
        f"LowerLeg.{s}": ((0.09 * sx, 0, 0.48), (0.09 * sx, 0.01, 0.10), f"UpperLeg.{s}"),
        f"Foot.{s}": ((0.09 * sx, 0.01, 0.10), (0.09 * sx, -0.12, 0.03), f"LowerLeg.{s}"),
    })


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"out": None, "preview": None, "mixamo": None}
    for i, a in enumerate(argv):
        if a in ("--out", "--preview", "--mixamo") and i + 1 < len(argv):
            out[a[2:]] = argv[i + 1]
    return out


# ---------------------------------------------------------------- vật liệu

MATS = {}


def mat(name, color, rough=0.6, metal=0.0, image=None):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    lin = tuple(srgb_to_lin(c) for c in color)  # màu khai báo theo sRGB, ô màu của Blender là tuyến tính
    bsdf.inputs["Base Color"].default_value = (*lin, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if image is not None:
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    m.use_backface_culling = False
    m.diffuse_color = (*lin, 1)
    MATS[name] = m
    return m


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hawaii_texture(size=256):
    """Hoạ tiết sơ mi hoa Hawaii: nền cam đỏ, hoa dâm bụt trắng / vàng, lá xanh (tất định)."""
    img = bpy.data.images.new("ShirtHawaii", size, size)
    base = P["shirt_base"]
    px = [list(base) + [1.0] for _ in range(size * size)]
    import random

    rnd = random.Random(7)

    def blob(cx, cy, r, color, petals=0, rot=0.0):
        for y in range(int(cy - r - 2), int(cy + r + 3)):
            for x in range(int(cx - r - 2), int(cx + r + 3)):
                dx, dy = x - cx, y - cy
                ang = math.atan2(dy, dx) + rot
                rr = r * (0.55 + 0.45 * abs(math.cos(petals * ang / 2))) if petals else r
                if dx * dx + dy * dy <= rr * rr:
                    px[(y % size) * size + (x % size)] = list(color) + [1.0]

    for _ in range(26):
        cx, cy = rnd.uniform(0, size), rnd.uniform(0, size)
        blob(cx, cy, rnd.uniform(9, 14), P["shirt_leaf"], petals=2, rot=rnd.uniform(0, 3))
    for _ in range(18):
        cx, cy = rnd.uniform(0, size), rnd.uniform(0, size)
        col = P["shirt_flower"] if rnd.random() < 0.6 else P["shirt_flower2"]
        blob(cx, cy, rnd.uniform(10, 16), col, petals=5, rot=rnd.uniform(0, 3))
        blob(cx, cy, 3.5, P["shirt_flower2"] if col == P["shirt_flower"] else (0.95, 0.4, 0.15))
    # Ảnh tuyến tính trong Blender: đổi từ màu sRGB.
    flat = []
    for p in px:
        flat += [srgb_to_lin(p[0]), srgb_to_lin(p[1]), srgb_to_lin(p[2]), 1.0]
    img.pixels = flat
    img.pack()
    return img


# ---------------------------------------------------------------- hình khối

PARTS = []  # (object, allowed bones)


def new_obj(name, verts, faces, material, bones, uvs=None, smooth=True, weights=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if uvs is not None:
        uv = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                uv.data[li].uv = uvs[me.loops[li].vertex_index]
    for poly in me.polygons:
        poly.use_smooth = smooth
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(material)
    PARTS.append((ob, bones, weights))
    return ob


def loft(name, sections, material, bones, segs=16, cap_start=True, cap_end=True, uv_scale=(1, 1), smooth=True):
    """Khối nối các mặt cắt elip: sections = [(tâm, rx, ry)] (mặt cắt vuông góc trục Z, dọc theo trục đứng)."""
    verts, faces, uvs = [], [], []
    n = len(sections)
    cols = segs + 1  # cột cuối trùng vị trí cột đầu nhưng u = 1 (đường nối UV)
    for i, (c, rx, ry) in enumerate(sections):
        for j in range(cols):
            a = 2 * math.pi * j / segs
            verts.append(Vector(c) + Vector((rx * math.sin(a), -ry * math.cos(a), 0)))
            uvs.append((j / segs * uv_scale[0], i / max(1, n - 1) * uv_scale[1]))
    for i in range(n - 1):
        for j in range(segs):
            a, b = i * cols + j, i * cols + j + 1
            faces.append((a, b, b + cols, a + cols))
    if cap_start:
        verts.append(Vector(sections[0][0]))
        uvs.append((0.5, 0))
        ci = len(verts) - 1
        for j in range(segs):
            faces.append((ci, j + 1, j))
    if cap_end:
        verts.append(Vector(sections[-1][0]))
        uvs.append((0.5, 1))
        ci = len(verts) - 1
        base = (n - 1) * cols
        for j in range(segs):
            faces.append((ci, base + j, base + j + 1))
    return new_obj(name, verts, faces, material, bones, uvs, smooth)


def limb(name, a, b, radii, material, bones, segs=14, uv_scale=(1, 1)):
    """Loft dọc đoạn a → b (mặt cắt tròn vuông góc với đoạn), radii = [(t, r)]."""
    a, b = Vector(a), Vector(b)
    axis = (b - a).normalized()
    ref = Vector((0, -1, 0)) if abs(axis.y) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u).normalized()
    verts, faces, uvs = [], [], []
    for i, (t, r) in enumerate(radii):
        c = a.lerp(b, t)
        for j in range(segs):
            ang = 2 * math.pi * j / segs
            verts.append(c + u * (r * math.cos(ang)) + v * (r * math.sin(ang)))
            uvs.append((j / segs * uv_scale[0], t * uv_scale[1]))
    n = len(radii)
    for i in range(n - 1):
        for j in range(segs):
            p, q = i * segs + j, i * segs + (j + 1) % segs
            faces.append((p, q, q + segs, p + segs))
    for idx, cap in ((0, a.lerp(b, radii[0][0])), (n - 1, a.lerp(b, radii[-1][0]))):
        verts.append(cap)
        uvs.append((0.5, 0.5))
        ci = len(verts) - 1
        for j in range(segs):
            p, q = idx * segs + j, idx * segs + (j + 1) % segs
            faces.append((ci, q, p) if idx == 0 else (ci, p, q))
    return new_obj(name, verts, faces, material, bones, uvs)


def ellipsoid(name, center, radii, material, bones, segs=20, rings=12, smooth=True, cut=None, gap=0.0):
    """Elipxoit (cut: giữ phần có z_local >= cut·rz, vd. nửa trên; gap: chừa trống ±gap rad quanh mặt trước -Y)."""
    verts, faces = [], []
    c = Vector(center)
    lo = math.acos(max(-1, min(1, cut))) if cut is not None else math.pi
    closed = gap <= 0
    cols = segs if closed else segs + 1
    for i in range(rings + 1):
        th = lo * i / rings
        for j in range(cols):
            # góc phương vị: -Y (mặt trước) = -pi/2; bỏ trống [−pi/2 − gap, −pi/2 + gap]
            ph = 2 * math.pi * j / segs if closed else (-math.pi / 2 + gap) + (2 * math.pi - 2 * gap) * j / segs
            verts.append(c + Vector((radii[0] * math.sin(th) * math.cos(ph), radii[1] * math.sin(th) * math.sin(ph), radii[2] * math.cos(th))))
    for i in range(rings):
        for j in range(segs):
            a = i * cols + j
            b = i * cols + (j + 1) % cols if closed else a + 1
            faces.append((a, a + cols, b + cols, b))
    return new_obj(name, verts, faces, material, bones, None, smooth)


def cone(name, base, tip, r, material, bones, segs=8):
    base, tip = Vector(base), Vector(tip)
    axis = (tip - base).normalized()
    ref = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 1, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u).normalized()
    verts = [base + u * (r * math.cos(2 * math.pi * j / segs)) + v * (r * math.sin(2 * math.pi * j / segs)) for j in range(segs)]
    verts += [tip, base]
    faces = [(j, (j + 1) % segs, segs) for j in range(segs)] + [((j + 1) % segs, j, segs + 1) for j in range(segs)]
    return new_obj(name, verts, faces, material, bones, None, smooth=False)


def torus(name, center, R, r, material, bones, tilt=0.0, segs=24, rsegs=8, scale=(1, 1)):
    verts, faces = [], []
    rot = Matrix.Rotation(tilt, 4, "X")
    for i in range(segs):
        a = 2 * math.pi * i / segs
        for j in range(rsegs):
            b = 2 * math.pi * j / rsegs
            p = Vector(((R + r * math.cos(b)) * math.cos(a) * scale[0], (R + r * math.cos(b)) * math.sin(a) * scale[1], r * math.sin(b)))
            verts.append(Vector(center) + (rot @ p.to_4d()).to_3d())
    for i in range(segs):
        for j in range(rsegs):
            a = i * rsegs + j
            b = ((i + 1) % segs) * rsegs + j
            c = ((i + 1) % segs) * rsegs + (j + 1) % rsegs
            d = i * rsegs + (j + 1) % rsegs
            faces.append((a, b, c, d))
    return new_obj(name, verts, faces, material, bones)


# Dáng hàm (gen_character.py đổi theo dáng mặt): JAW độ thon về cằm, JAW_EXP càng lớn hàm càng vuông (chỉ thon sát
# cằm), CHIN độ nhô của cằm.
JAW, JAW_EXP, CHIN = 0.3, 1.4, 0.012


def head_point(d, lift=0.0):
    """Điểm trên bề mặt đầu theo hướng đơn vị d: elip hình trứng, nửa dưới thon về hàm + cằm hơi nhô, sau gáy đầy."""
    dx, dy, dz = d
    x, y, z = HEAD_RX * dx, HEAD_RY * dy, HEAD_RZ * dz
    if dz < 0:
        t = (-dz) ** JAW_EXP
        x *= 1 - JAW * t
        y *= 1 - 0.1 * t
        if dy < 0:
            y -= CHIN * t * (-dy)  # cằm
    if dy > 0:
        y *= 1.06
    v = Vector((x, y, z))
    return HEAD_C + v * (1 + lift)


def head_normal(p):
    q = p - HEAD_C
    return Vector((q.x / HEAD_RX ** 2, q.y / HEAD_RY ** 2, q.z / HEAD_RZ ** 2)).normalized()


def on_head(x, z, offset):
    """Điểm trên mặt trước đầu có toạ độ ngang x, dọc z (so với tâm đầu), đẩy ra theo pháp tuyến `offset`."""
    dx, dz = x / HEAD_RX, z / HEAD_RZ
    for _ in range(18):
        dy = -math.sqrt(max(1e-4, 1 - dx * dx - dz * dz))
        q = head_point((dx, dy, dz)) - HEAD_C
        dx += (x - q.x) / HEAD_RX
        dz += (z - q.z) / HEAD_RZ
    dy = -math.sqrt(max(1e-4, 1 - dx * dx - dz * dz))
    p = head_point((dx, dy, dz))
    return p + head_normal(p) * offset


def head_dir(theta, phi):
    """Hướng theo góc: theta 0 = đỉnh → pi = cằm; phi 0 = chính diện (-Y), tăng về bên trái (+X)."""
    return (math.sin(theta) * math.sin(phi), -math.sin(theta) * math.cos(phi), math.cos(theta))


def shell(name, bottom, lift, material, bones, cols=72, rows=18, smooth=True, edge_in=0.012):
    """
    Vỏ ôm đầu (tóc) từ đỉnh xuống tới cao độ bottom(|phương vị|) – hàng cuối nằm đúng trên đường chân tóc nên mép
    mượt (không răng cưa); mép dưới vát sát vào da (edge_in) để không thấy bề dày vỏ.
    """
    verts, faces = [], []
    for i in range(rows + 1):
        f = i / rows
        for j in range(cols):
            ph = 2 * math.pi * j / cols - math.pi
            dz = 1 - (1 - bottom(abs(ph))) * f
            th = math.acos(max(-1.0, min(1.0, dz)))
            lift_i = lift - (lift - edge_in) * max(0.0, (f - 0.8) / 0.2)
            verts.append(head_point(head_dir(th, ph), lift_i))
    for i in range(rows):
        for j in range(cols):
            a, b = i * cols + j, i * cols + (j + 1) % cols
            faces.append((a, a + cols, b + cols, b))
    return new_obj(name, verts, faces, material, bones, None, smooth)


def interp(points, x):
    """Nội suy tuyến tính trên bảng [(x, y)] (x tăng dần)."""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return points[-1][1]


# Đường chân tóc (cao độ dz theo |phương vị|): trán cao, lõm hai thái dương, vòng trên tai, xuống gáy.
HAIRLINE = [(0.0, 0.5), (0.4, 0.47), (0.7, 0.3), (1.1, 0.2), (1.45, 0.17), (1.75, 0.12), (2.1, -0.2), (2.5, -0.5), (math.pi, -0.6)]
# Vùng tóc dài phía trên (mái vuốt mọc từ đây): chỏm đầu.
CROWN = [(0.0, 0.55), (0.8, 0.52), (1.4, 0.62), (2.2, 0.55), (math.pi, 0.45)]


def strand(name, pts, widths, thick, material, bones, segs=8):
    """Lọn tóc dẹt: loft dọc đường pts, mặt cắt elip (rộng widths[i], dày thick[i]); mặt dẹt hướng ra ngoài đầu."""
    verts, faces = [], []
    n = len(pts)
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        out = (p - HEAD_C).normalized()
        side = t.cross(out).normalized()
        up = side.cross(t).normalized()
        for j in range(segs):
            a = 2 * math.pi * j / segs
            verts.append(p + side * (widths[i] * math.cos(a)) + up * (thick[i] * math.sin(a)))
    for i in range(n - 1):
        for j in range(segs):
            a, b = i * segs + j, i * segs + (j + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    verts.append(pts[-1])
    tip = len(verts) - 1
    for j in range(segs):
        faces.append(((n - 1) * segs + j, (n - 1) * segs + (j + 1) % segs, tip))
    return new_obj(name, verts, faces, material, bones)


def bezier(p0, p1, p2, n=7):
    return [p0 * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + p2 * t * t for t in (i / (n - 1) for i in range(n))]


def limb_path(name, pts, radii, material, bones, segs=16, caps=True, uv_scale=(1, 1), weights=None):
    """Loft dọc polyline pts (mặt cắt tròn vuông góc tiếp tuyến), radii[i] cho từng điểm – tay / chân liền khối."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    verts, faces, uvs = [], [], []
    ref = Vector((0, -1, 0))
    cols = segs + 1  # đường nối UV: cột cuối trùng cột đầu
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        r0 = ref if abs(t.dot(ref)) < 0.9 else Vector((1, 0, 0))
        u = t.cross(r0).normalized()
        v = t.cross(u).normalized()
        for j in range(cols):
            a = 2 * math.pi * j / segs
            verts.append(p + u * (radii[i] * math.cos(a)) + v * (radii[i] * math.sin(a)))
            uvs.append((j / segs * uv_scale[0], i / (n - 1) * uv_scale[1]))
    for i in range(n - 1):
        for j in range(segs):
            a, b = i * cols + j, i * cols + j + 1
            faces.append((a, b, b + cols, a + cols))
    if caps in (True, "start", "end"):
        ends = [(0, pts[0])] * (caps in (True, "start")) + [(n - 1, pts[-1])] * (caps in (True, "end"))
        for idx, c in ends:
            verts.append(c)
            uvs.append((0.5, 0.5))
            ci = len(verts) - 1
            for j in range(segs):
                a, b = idx * cols + j, idx * cols + j + 1
                faces.append((ci, b, a) if idx == 0 else (ci, a, b))
    return new_obj(name, verts, faces, material, bones, uvs, weights=weights)


def polyline(points, n_per=6):
    """Chia đều các đoạn của polyline (để loft mượt), trả về (điểm, tham số 0..1 theo chiều dài)."""
    out = []
    for (a, b) in zip(points, points[1:]):
        a, b = Vector(a), Vector(b)
        for k in range(n_per):
            out.append(a.lerp(b, k / n_per))
    out.append(Vector(points[-1]))
    total = sum((out[i + 1] - out[i]).length for i in range(len(out) - 1))
    acc, ts = 0.0, [0.0]
    for i in range(len(out) - 1):
        acc += (out[i + 1] - out[i]).length
        ts.append(acc / total)
    return out, ts


# ---------------------------------------------------------------- khuôn mặt (shape key)

EYE_X, EYE_Z, EYE_RX, EYE_RZ = 0.056, 0.004, 0.029, 0.036
BROW_Z = 0.063
MOUTH_Z = -0.08
RINGS, SEG = 4, 20


def disc_params():
    pts = [(0.0, 0.0)]
    for i in range(1, RINGS + 1):
        rr = i / RINGS
        for j in range(SEG):
            a = 2 * math.pi * j / SEG
            pts.append((rr * math.cos(a), rr * math.sin(a)))
    faces = [(0, 1 + (j + 1) % SEG, 1 + j) for j in range(SEG)]
    for i in range(1, RINGS):
        for j in range(SEG):
            a, b = 1 + (i - 1) * SEG + j, 1 + (i - 1) * SEG + (j + 1) % SEG
            faces.append((a, b, b + SEG, a + SEG))
    return pts, faces


DISC, DISC_F = disc_params()
# Lông mi (nhân vật nữ – gen_character.py bật): vài nét ở mép trên ngoài của mắt, theo mí khi chớp.
LASHES = False
# Nét riêng của từng khuôn mặt (gen_character.py đặt theo spec.face; mặc định = mặt DanChoi):
#   EYE_TILT xếch đuôi mắt (rad, + = đuôi mắt lên) · EYE_LID mí trên che bao nhiêu phần mắt (0 = không mí)
#   IRIS_K cỡ tròng · BROW dáng lông mày · MOUTH_K bề ngang miệng · LIPS môi dày (viền môi hồng)
#   BLUSH cỡ má hồng (0 = không) · FRECKLES tàn nhang · WRINKLES nếp nhăn (đuôi mắt, bọng mắt, trán, rãnh cười)
EYE_TILT, EYE_LID, IRIS_K = 0.0, 0.0, 1.0
BROW = {"th": 0.014, "arch": 0.008, "len": 0.072, "drop": 0.0, "taper": 0.45}
MOUTH_K, LIPS = 1.0, False
BLUSH, FRECKLES, WRINKLES = 1.0, False, False
# tàn nhang: (x, z) quanh gò má bên trái (bên phải lấy đối xứng)
FRECKLE_PTS = [(0.064, -0.02), (0.074, -0.028), (0.086, -0.022), (0.069, -0.036), (0.081, -0.04), (0.094, -0.033), (0.058, -0.03)]
# Mặc định của từng khuôn mặt; shape key đổi vài thông số.
NEUTRAL = {
    "eye_scale": 1.0, "eye_squash": 1.0, "eye_lift": 0.0, "pupil": 1.0,
    "brow_dz": 0.0, "brow_tilt": 0.0,
    "mouth_w": 0.075, "mouth_h": 0.012, "mouth_curve": 0.012, "mouth_dz": 0.0,
    "look_x": 0.0, "look_z": 0.0,  # hướng nhìn: tròng + con ngươi + chấm sáng dịch trong lòng trắng (cả hai mắt cùng hướng)
}
KEYS = {
    "blink": {"eye_squash": 0.06},
    "happy": {"eye_squash": 0.45, "eye_lift": 0.012, "brow_dz": 0.008, "mouth_w": 0.088, "mouth_h": 0.022, "mouth_curve": 0.02},
    "sad": {"eye_squash": 0.8, "brow_tilt": 0.02, "brow_dz": -0.004, "mouth_w": 0.06, "mouth_h": 0.012, "mouth_curve": -0.018},
    "angry": {"eye_squash": 0.7, "brow_tilt": -0.022, "brow_dz": -0.01, "mouth_w": 0.07, "mouth_h": 0.014, "mouth_curve": -0.008},
    "surprised": {"eye_scale": 1.25, "pupil": 0.8, "brow_dz": 0.02, "mouth_w": 0.042, "mouth_h": 0.05, "mouth_curve": 0.0, "mouth_dz": -0.006},
    "scared": {"eye_scale": 1.15, "pupil": 0.65, "brow_dz": 0.012, "brow_tilt": 0.016, "mouth_w": 0.06, "mouth_h": 0.026, "mouth_curve": -0.012},
    # khẩu hình (cộng thêm lên cảm xúc)
    "aa": {"mouth_w": 0.062, "mouth_h": 0.058, "mouth_curve": 0.004, "mouth_dz": -0.008},
    "ih": {"mouth_w": 0.076, "mouth_h": 0.03, "mouth_curve": 0.008},
    "ou": {"mouth_w": 0.03, "mouth_h": 0.032, "mouth_curve": 0.0},
    "ee": {"mouth_w": 0.088, "mouth_h": 0.022, "mouth_curve": 0.01},
    "oh": {"mouth_w": 0.042, "mouth_h": 0.046, "mouth_curve": 0.0, "mouth_dz": -0.004},
    # hướng nhìn (engine / người dựng trộn để nhân vật liếc trái / phải / lên / xuống)
    "lookLeft": {"look_x": 0.011}, "lookRight": {"look_x": -0.011}, "lookUp": {"look_z": 0.009}, "lookDown": {"look_z": -0.009},
    # lông mày riêng (ghép với miệng để có vui / buồn / ngạc nhiên / tức giận / lo lắng)
    "browUp": {"brow_dz": 0.016}, "browDown": {"brow_dz": -0.01}, "browAngry": {"brow_tilt": -0.024, "brow_dz": -0.006},
    "browSad": {"brow_tilt": 0.022, "brow_dz": -0.002}, "browWorried": {"brow_tilt": 0.02, "brow_dz": 0.01},
    # miệng riêng
    "smile": {"mouth_w": 0.086, "mouth_h": 0.014, "mouth_curve": 0.026}, "mouthOpen": {"mouth_w": 0.064, "mouth_h": 0.05, "mouth_curve": 0.006, "mouth_dz": -0.006},
    "frown": {"mouth_w": 0.064, "mouth_h": 0.012, "mouth_curve": -0.022},
}


def face_points(k):
    """Toạ độ mọi đỉnh của mesh Face với thông số k; trả về (verts, faces, vật liệu từng mặt)."""
    verts, faces, fmat = [], [], []

    def add_disc(fn, off, mi):
        base = len(verts)
        for (u, v) in DISC:
            x, z = fn(u, v)
            verts.append(on_head(x, z, off))
        for f in DISC_F:
            faces.append(tuple(base + i for i in f))
            fmat.append(mi)

    def add_strip(pts, width, off, mi):
        """Nét mảnh (nếp mí, nếp nhăn) theo các điểm (x, z), hai đầu vuốt nhọn."""
        base, n = len(verts), len(pts)
        for i, (x, z) in enumerate(pts):
            (ax, az), (bx, bz) = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
            L = math.hypot(bx - ax, bz - az) or 1e-9
            nx, nz = -(bz - az) / L, (bx - ax) / L
            wi = width * (0.3 + 0.7 * math.sin(math.pi * i / (n - 1)))
            verts.append(on_head(x + nx * wi / 2, z + nz * wi / 2, off))
            verts.append(on_head(x - nx * wi / 2, z - nz * wi / 2, off))
        for i in range(n - 1):
            a = base + 2 * i
            faces.append((a, a + 2, a + 3, a + 1))
            fmat.append(mi)

    for sx in (1, -1):
        cx, cz = EYE_X * sx, EYE_Z + k["eye_lift"]
        s = k["eye_scale"]

        def eye(u, v, rx=EYE_RX, rz=EYE_RZ, ox=0.0, oz=0.0, cx=cx, cz=cz, s=s, sx=sx):
            x = cx + (ox + u * rx) * s
            z = cz + (oz + v * rz) * s
            # nhắm / cười mắt: ép về mép trên (mí), giữ cung trên.
            top = cz + EYE_RZ * s * 0.55
            z = top + (z - top) * k["eye_squash"]
            if EYE_TILT:  # xếch: xoay quanh tâm mắt, đuôi mắt (phía ngoài) lên
                a = EYE_TILT * sx
                dx, dz = x - cx, z - cz
                x, z = cx + dx * math.cos(a) - dz * math.sin(a), cz + dx * math.sin(a) + dz * math.cos(a)
            return x, z

        add_disc(eye, 0.004, 0)  # tròng trắng
        ir = 0.019 * k["pupil"] * IRIS_K
        lx, lz = k["look_x"], k["look_z"]
        ox, oz = -0.003 * sx + lx, -0.004 + lz
        # tròng chuyển màu: viền ngoài sẫm → tròng → vành sáng quanh con ngươi (nửa dưới) ; con ngươi tròn; 2 chấm sáng
        add_disc(lambda u, v, e=eye, ir=ir: e(u, v, ir, ir * 1.06, ox, oz), 0.005, 12)  # viền tròng sẫm
        add_disc(lambda u, v, e=eye, ir=ir: e(u, v, ir * 0.86, ir * 0.91, ox, oz), 0.0056, 6)  # tròng
        add_disc(lambda u, v, e=eye, ir=ir: e(u, v, ir * 0.62, ir * 0.5, ox, oz - ir * 0.2), 0.0062, 13)  # vành sáng dưới
        add_disc(lambda u, v, e=eye, ir=ir: e(u, v, ir * 0.46, ir * 0.46, ox, oz), 0.007, 1)  # con ngươi (tròn)
        add_disc(lambda u, v, e=eye, sx=sx: e(u, v, 0.0058, 0.0058, 0.005 - 0.003 * sx + lx, 0.008 + lz), 0.0085, 0)  # chấm sáng
        add_disc(lambda u, v, e=eye, sx=sx: e(u, v, 0.0026, 0.0026, -0.006 - 0.003 * sx + lx, -0.011 + lz), 0.0085, 0)  # chấm sáng phụ
        if LASHES:
            for a in (0.25, 0.6, 0.95):  # góc từ phương ngang, phía ngoài
                base = len(verts)
                for da, r in ((-0.1, 1.0), (0.1, 1.0), (0.0, 1.4)):
                    x, z = eye(sx * math.cos(a + da) * r, math.sin(a + da) * r)
                    verts.append(on_head(x, z, 0.0095))  # trên mí
                faces.append((base, base + 1, base + 2))
                fmat.append(1)
        if EYE_LID > 0:
            # mí trên (màu da, sẫm nhẹ) che phần trên lòng trắng + tròng, đuôi mí rủ hơn đầu mí; theo mắt khi chớp /
            # cười; nếp mí ở mép dưới.
            base, cols = len(verts), 12
            edge = 1 - 2 * EYE_LID

            def lid_v(u, sx=sx):
                return min(math.sqrt(max(0.0, 1 - u * u)), edge - 0.08 * u * sx)

            for c in range(cols + 1):
                u = -1 + 2 * c / cols
                for v in (lid_v(u), math.sqrt(max(0.0, 1 - u * u)) * 1.12 + 0.06):
                    x, z = eye(u * 1.08, v)
                    verts.append(on_head(x, z, 0.009))
            for c in range(cols):
                a = base + 2 * c
                faces.append((a, a + 2, a + 3, a + 1))
                fmat.append(8)
            add_strip([eye(u * 1.04, lid_v(u)) for u in (-1 + 2 * c / 10 for c in range(11))], 0.0022, 0.0094, 9)
        if WRINKLES:
            s0 = k["eye_scale"]
            ox = sx * (EYE_X + EYE_RX * s0 * 1.2)
            for j in (-1, 0, 1):  # vết chân chim đuôi mắt
                z0 = EYE_Z + j * 0.009
                add_strip([(ox, z0), (ox + sx * 0.008, z0 + j * 0.003), (ox + sx * 0.015, z0 + j * 0.006)], 0.0024, 0.0035, 9)
            # bọng mắt: cung mảnh dưới mắt
            add_strip([(sx * EYE_X + u * EYE_RX * s0 * 0.8, EYE_Z - EYE_RZ * s0 * 1.15 - 0.005 * (1 - u * u)) for u in (-1 + 2 * c / 8 for c in range(9))], 0.002, 0.0035, 9)
        # lông mày: dải cong, đầu trong nâng / hạ theo tilt.
        # dáng tự nhiên: đầu trong bo tròn, dày nhất ở ~1/3, đỉnh cong ở ~60 % chiều dài, đuôi thon nhọn dần
        base = len(verts)
        n = 14
        L = BROW["len"]
        for i in range(n + 1):
            t = i / n  # 0 = đầu trong, 1 = đầu ngoài
            x = sx * (EYE_X - L / 2 + L * t)
            arch = (BROW["arch"] + 0.003) * math.sin(math.pi * t ** 1.4)
            z = BROW_Z + k["brow_dz"] + arch + k["brow_tilt"] * (1 - t) - BROW["drop"] * t * t
            head = 0.55 + 0.45 * math.sin(0.5 * math.pi * min(1.0, t / 0.18))  # đầu trong bo tròn
            th = BROW["th"] * head * (1 - (BROW["taper"] + 0.25) * smooth01((t - 0.3) / 0.7))
            verts.append(on_head(x, z + th / 2, 0.006))
            verts.append(on_head(x, z - th / 2, 0.006))
        for i in range(n):
            a = base + 2 * i
            faces.append((a, a + 2, a + 3, a + 1))
            fmat.append(2)
    # miệng: lưới giữa môi trên (gần thẳng) và môi dưới (cong theo độ mở) – há ra thành chữ D, khép lại thành một
    # đường cong mảnh; khoé cong lên (cười) / xuống (buồn). Răng trên + lưỡi chỉ lộ khi há miệng.
    w, h, cv = k["mouth_w"] * MOUTH_K, k["mouth_h"], k["mouth_curve"]
    cz = MOUTH_Z + k["mouth_dz"]
    open_k = max(0.0, min(1.0, (h - 0.012) / 0.02))

    def line(u):
        return cz + cv * (u * u - 0.35)

    def gap(u):
        return max(0.004, h) * max(0.0, 1 - u * u) ** 0.7

    def grid(x_of, z_lo, z_hi, off, mi, cols=16, rows=5):
        base = len(verts)
        for r in range(rows + 1):
            for c in range(cols + 1):
                u = -1 + 2 * c / cols
                z = z_lo(u) + (z_hi(u) - z_lo(u)) * r / rows
                verts.append(on_head(x_of(u), z, off))
        for r in range(rows):
            for c in range(cols):
                a = base + r * (cols + 1) + c
                faces.append((a, a + 1, a + cols + 2, a + cols + 1))
                fmat.append(mi)

    # má hồng nhẹ + tàn nhang (không đổi theo biểu cảm)
    for sx in (1, -1):
        if BLUSH > 0:
            add_disc(lambda u, v, sx=sx: (sx * 0.084 + u * 0.022 * BLUSH, -0.036 + v * 0.013 * BLUSH), 0.0015, 7)
        if FRECKLES:
            for i, (fx, fz) in enumerate(FRECKLE_PTS):
                r = 0.0024 + 0.0004 * (i % 3)
                add_disc(lambda u, v, fx=fx, fz=fz, r=r, sx=sx: (sx * fx + u * r, fz + v * r), 0.0024, 11)
    top = lambda u: line(u) + 0.2 * gap(u)  # noqa: E731
    bot = lambda u: line(u) - 0.8 * gap(u)  # noqa: E731
    if WRINKLES:
        # nếp trán + rãnh cười (cánh mũi → khoé miệng, dịch theo độ rộng miệng khi cười / há)
        for dz in (0.024, 0.036):
            add_strip([(u * 0.05, BROW_Z + dz + 0.004 * (1 - u * u)) for u in (-1 + 2 * c / 10 for c in range(11))], 0.0024, 0.0035, 9)
        for sx in (1, -1):
            x0, z0 = sx * 0.03, -0.042
            x1, z1 = sx * (w / 2 + 0.011), line(1.0) - 0.004
            add_strip([(x0 + (x1 - x0) * t + sx * 0.007 * math.sin(math.pi * t), z0 + (z1 - z0) * t) for t in (c / 8 for c in range(9))], 0.0026, 0.0035, 9)
    # môi (màu môi rõ): viền môi dưới đầy + môi trên mảnh, nằm dưới lớp miệng → chỉ lộ ra quanh mép miệng;
    # LIPS (môi dày) đầy hơn, mặc định mảnh vừa
    lk = 1.0 if LIPS else 0.55
    grid(lambda u: u * w / 2 * 1.04, lambda u: bot(u) - 0.0075 * lk * max(0.0, 1 - u * u) ** 0.6 - 0.0012, lambda u: bot(u) + 0.001, 0.0058, 10)
    grid(lambda u: u * w / 2 * 1.04, lambda u: top(u) - 0.001, lambda u: top(u) + 0.0012 + 0.0038 * lk * max(0.0, 1 - u * u) ** 0.6, 0.0058, 10)
    grid(lambda u: u * w / 2, bot, top, 0.006, 3)
    # răng trên: dải trắng sát môi trên, cao theo độ há
    grid(lambda u: u * w * 0.4, lambda u: top(u) - (0.03 + 0.3 * open_k) * gap(u), lambda u: top(u) - 0.03 * gap(u), 0.0068, 4, cols=12, rows=2)
    # lưỡi: sát môi dưới, hẹp hơn
    grid(lambda u: u * w * 0.28, lambda u: bot(u) + 0.05 * gap(u), lambda u: bot(u) + (0.05 + 0.3 * open_k) * gap(u), 0.0068, 5, cols=12, rows=2)
    return verts, faces, fmat


def build_face():
    verts, faces, fmat = face_points(dict(NEUTRAL))
    me = bpy.data.meshes.new("Face")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new("Face", me)
    bpy.context.collection.objects.link(ob)
    sk = P["skin"]
    extra = (  # 8 mí · 9 nếp (mí / nhăn) · 10 môi · 11 tàn nhang – mặc định pha từ màu da
        mat("Lid", P.get("lid", tuple(c * 0.93 for c in sk)), 0.55),
        mat("FaceLine", P.get("line", tuple(c * 0.72 for c in sk)), 0.7),
        mat("Lip", P.get("lip", tuple(a + (b - a) * 0.45 for a, b in zip(sk, (0.85, 0.35, 0.4)))), 0.5),
        mat("Freckle", P.get("freckle", tuple(a + (b - a) * 0.5 for a, b in zip(sk, (0.55, 0.32, 0.2)))), 0.7),
        # 12 viền tròng (sẫm) · 13 vành sáng trong tròng – pha từ màu tròng
        mat("IrisRim", tuple(c * 0.45 for c in P["iris"]), 0.3),
        mat("IrisLight", tuple(c + (1 - c) * 0.35 for c in P["iris"]), 0.3),
    )
    for m in (mat("EyeWhite", P["eye_white"], 0.3), mat("Pupil", P["pupil"], 0.3), mat("Brow", P["brow"], 0.8), mat("Mouth", P["mouth"], 0.6), mat("Teeth", P["teeth"], 0.4), mat("Tongue", P["tongue"], 0.6), mat("Iris", P["iris"], 0.3), mat("Blush", P["blush"], 0.7), *extra):
        ob.data.materials.append(m)
    for poly, mi in zip(me.polygons, fmat):
        poly.material_index = mi
        poly.use_smooth = False
    ob.shape_key_add(name="Basis")
    for name, ch in KEYS.items():
        kv, _, _ = face_points({**NEUTRAL, **ch})
        sk = ob.shape_key_add(name=name)
        for i, v in enumerate(kv):
            sk.data[i].co = v
    PARTS.append((ob, ["Head"], None))
    return ob


# ---------------------------------------------------------------- dựng hình

def build_body():
    skin = mat("Skin", P["skin"], 0.55)
    shirt = mat("Shirt", (1, 1, 1), 0.7, image=hawaii_texture())
    jeans = mat("Jeans", P["jeans"], 0.85)
    jeans_l = mat("JeansLight", P["jeans_light"], 0.85)
    gold = mat("Gold", P["gold"], 0.3, 0.35)
    hair_t = mat("HairTop", P["hair_top"], 0.55)
    hair_t2 = mat("HairTop2", P["hair_top2"], 0.6)
    hair_s = mat("HairSide", P["hair_side"], 0.85)
    shoe = mat("Shoe", P["shoe"], 0.5)
    accent = mat("ShoeAccent", P["shoe_accent"], 0.5)
    sole = mat("Sole", P["sole"], 0.8)
    lens = mat("Lens", P["lens"], 0.15)
    belt = mat("Belt", P["belt"], 0.6)
    rip = mat("SkinRip", tuple(c * 0.95 for c in P["skin"]), 0.7)

    # thân: sơ mi rộng vai, eo thon, vạt dưới hơi xoè; cổ mở chữ V lộ da
    # vai tròn: bề ngang vai do bắp tay áo tạo, thân áo thu vào êm dần tới cổ (không góc nhọn)
    torso = [((0, 0, 0.9), 0.163, 0.113), ((0, 0, 0.97), 0.156, 0.108), ((0, 0, 1.05), 0.155, 0.108), ((0, 0, 1.15), 0.168, 0.118),
             ((0, 0, 1.23), 0.178, 0.122), ((0, 0, 1.285), 0.172, 0.118), ((0, 0, 1.325), 0.15, 0.106), ((0, 0, 1.352), 0.118, 0.09),
             ((0, 0, 1.37), 0.085, 0.072)]
    loft("Torso", torso, shirt, ["Hips", "Spine", "Chest", "Shoulder.L", "Shoulder.R"], segs=24, uv_scale=(2, 1.2))

    def on_torso(a, z, off):
        """Điểm trên mặt thân áo: góc a (0 = chính diện, + về bên trái), độ cao z, đẩy ra `off`."""
        zs = [c[0][2] for c in torso]
        rx = interp([(zz, c[1]) for zz, c in zip(zs, torso)], z)
        ry = interp([(zz, c[2]) for zz, c in zip(zs, torso)], z)
        return Vector(((rx + off) * math.sin(a), -(ry + off) * math.cos(a), z))

    def patch(name, corners, material, n=6):
        """Miếng phẳng dán theo mặt thân: corners = [(a, z)] ×3 (tam giác), chia lưới để ôm cong."""
        (a0, z0), (a1, z1), (a2, z2) = corners
        verts, faces, idx = [], [], {}
        for i in range(n + 1):
            for j in range(n + 1 - i):
                u, v = i / n, j / n
                w = 1 - u - v
                idx[(i, j)] = len(verts)
                verts.append(on_torso(a0 * w + a1 * u + a2 * v, z0 * w + z1 * u + z2 * v, 0.004))
        for i in range(n):
            for j in range(n - i):
                faces.append((idx[(i, j)], idx[(i + 1, j)], idx[(i, j + 1)]))
                if j + 1 <= n - i - 1:
                    faces.append((idx[(i + 1, j)], idx[(i + 1, j + 1)], idx[(i, j + 1)]))
        return new_obj(name, verts, faces, material, ["Chest"], uvs=[(0.15, 0.85)] * len(verts))

    # cổ mở chữ V lộ da + hai vạt cổ áo nằm ép theo ngực
    patch("ChestV", [(0.62, 1.366), (-0.62, 1.366), (0.0, 1.215)], skin)
    for sx in (1, -1):
        patch(f"Collar.{'L' if sx > 0 else 'R'}", [(0.7 * sx, 1.368), (0.1 * sx, 1.225), (0.78 * sx, 1.29)], shirt)
    # hông + thắt lưng + khoá vàng
    loft("Pelvis", [((0, 0, 0.78), 0.15, 0.1), ((0, 0, 0.87), 0.153, 0.104), ((0, 0, 0.95), 0.152, 0.104)], jeans, ["Hips", "UpperLeg.L", "UpperLeg.R"], segs=24)
    loft("Belt", [((0, 0, 0.9), 0.157, 0.108), ((0, 0, 0.93), 0.157, 0.108)], belt, ["Hips"], segs=24)
    ellipsoid("Buckle", (0, -0.109, 0.915), (0.024, 0.008, 0.016), gold, ["Hips"], segs=12, rings=6)

    # cổ + đầu hình trứng (hàm thon, cằm)
    limb("Neck", (0, 0.005, 1.32), (0, 0.005, 1.47), [(0, 0.056), (1, 0.05)], skin, ["Neck", "Chest", "Head"])
    rows, cols = 26, 36
    hv = [head_point(head_dir(math.pi * i / rows, 2 * math.pi * j / cols - math.pi)) for i in range(rows + 1) for j in range(cols)]
    hf = [(i * cols + j, (i + 1) * cols + j, (i + 1) * cols + (j + 1) % cols, i * cols + (j + 1) % cols) for i in range(rows) for j in range(cols)]
    new_obj("Head", hv, hf, skin, ["Head"])
    ellipsoid("Nose", on_head(0, -0.028, 0.004), (0.017, 0.016, 0.015), skin, ["Head"], segs=14, rings=8)
    # tai ở hai bên, ngay dưới đường tóc; khuyên vàng ở dái tai trái
    for sx in (1, -1):
        c = head_point(head_dir(math.pi / 2 + 0.06, sx * math.pi / 2 + sx * 0.08)) + Vector((0.008 * sx, 0, 0))
        ellipsoid(f"Ear.{'L' if sx > 0 else 'R'}", c, (0.017, 0.028, 0.04), skin, ["Head"], segs=14, rings=8)
        if sx > 0:
            ellipsoid("Earring", c + Vector((0.012, -0.004, -0.034)), (0.0065, 0.0065, 0.0065), gold, ["Head"], segs=10, rings=6)

    # tóc: hai bên + gáy cắt ngắn ôm đầu (đường chân tóc thật), chỏm tóc dài + mái vuốt dựng nhiều lọn
    shell("HairSide", lambda a: interp(HAIRLINE, a), 0.024, hair_s, ["Head"], edge_in=0.004)
    shell("HairTop", lambda a: interp(CROWN, a) - 0.02, 0.05, hair_t, ["Head"], edge_in=0.026)
    import random
    rnd = random.Random(11)
    up, back = Vector((0, 0, 1)), Vector((0, 1, 0))
    k = 0
    # Mái trước: nhiều lọn dài dựng lên rồi hất ra sau; chỏm và sau: lọn ngắn chải ra sau; hai bên chỏm: chải chéo.
    rows_spec = [
        # (cao độ dz gốc, phạm vi phương vị, số lọn, chiều dài, hướng: "front" | "top" | "back")
        (0.62, 1.0, 9, 0.13, "front"),
        (0.72, 0.8, 7, 0.11, "front"),
        (0.84, 0.6, 5, 0.09, "top"),
        (0.93, 0.5, 3, 0.08, "top"),
        (0.72, 2.6, 8, 0.07, "back"),
    ]
    for dz0, span, count, L, kind in rows_spec:
        for c in range(count):
            ph = -span / 2 + span * (c + 0.5) / count + rnd.uniform(-0.05, 0.05)
            if kind == "back":
                ph = math.pi - span / 2 + span * (c + 0.5) / count
            th = math.acos(max(-1, min(1, dz0 + rnd.uniform(-0.03, 0.03))))
            d = head_dir(th, ph)
            root = head_point(d, 0.035)
            n = (root - HEAD_C).normalized()
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
            L *= rnd.uniform(0.85, 1.15)
            p1 = root + g1 * L * 0.55
            p2 = p1 + g2 * L * 0.55
            pts = bezier(root, p1, p2)
            m = len(pts)
            widths = [0.03 * (1 - 0.85 * (i / (m - 1)) ** 1.3) for i in range(m)]
            thick = [0.013 * (1 - 0.7 * i / (m - 1)) for i in range(m)]
            strand(f"Lock{k}", pts, widths, thick, hair_t if k % 3 else hair_t2, ["Head"])
            k += 1

    # kính râm móc ở cổ áo chữ V (dân chơi), dây chuyền vàng nằm trên ngực + mặt dây
    for sx in (1, -1):
        c = Vector((0.034 * sx, -0.135, 1.228))
        ellipsoid(f"Lens.{'L' if sx > 0 else 'R'}", c, (0.028, 0.007, 0.019), lens, ["Chest"], segs=16, rings=8)
        ring = [c + Vector((0.03 * math.cos(2 * math.pi * i / 16), -0.004, 0.021 * math.sin(2 * math.pi * i / 16))) for i in range(17)]
        limb_path(f"Rim.{'L' if sx > 0 else 'R'}", ring, [0.0028] * len(ring), gold, ["Chest"], segs=6, caps=False)
    limb("Bridge", (0.008, -0.142, 1.236), (-0.008, -0.142, 1.236), [(0, 0.003), (1, 0.003)], gold, ["Chest"], segs=6)
    # dây chuyền: cung vàng ôm sát bề mặt ngực từ sau gáy vòng xuống trước ngực
    chain = []
    for i in range(29):
        a = -1.25 + 2.5 * i / 28  # 0 = chính diện
        z = 1.365 - 0.095 * math.cos(a) ** 2
        rx, ry = (0.1, 0.078) if z > 1.33 else (0.15, 0.107)
        rx, ry = rx + (0.17 - rx) * (1.345 - z) / 0.08 if z < 1.345 else rx, ry + (0.115 - ry) * (1.345 - z) / 0.08 if z < 1.345 else ry
        chain.append(Vector((rx * math.sin(a) * 1.02, -ry * math.cos(a) * 1.06 - 0.006, z)))
    limb_path("Chain", chain, [0.005] * len(chain), gold, ["Chest", "Neck"], segs=8, caps=False)
    ellipsoid("Pendant", chain[14] + Vector((0, -0.006, -0.018)), (0.011, 0.005, 0.015), gold, ["Chest"], segs=10, rings=6)

    for s, sx in (("L", 1), ("R", -1)):
        sh = Vector(BONES[f"UpperArm.{s}"][0])
        el = Vector(BONES[f"LowerArm.{s}"][0])
        wr = Vector(BONES[f"Hand.{s}"][0])
        ha = Vector(BONES[f"Hand.{s}"][1])
        # tay liền một khối vai → cổ tay; trọng lượng chuyển mượt qua vai và khuỷu
        arm_w = chain_weights([f"Shoulder.{s}", (sh, el - sh, 0.05, f"UpperArm.{s}"), (el, wr - el, 0.035, f"LowerArm.{s}")])
        pts, ts = polyline([sh + Vector((-0.02 * sx, 0, -0.025)), el, wr])
        prof = [(0, 0.045), (0.3, 0.049), (0.5, 0.044), (0.62, 0.045), (0.85, 0.04), (1, 0.035)]
        limb_path(f"Arm.{s}", pts, [interp(prof, t) for t in ts], skin, [f"UpperArm.{s}", f"LowerArm.{s}", f"Shoulder.{s}"], weights=arm_w)
        # tay áo ngắn: bắt đầu từ trong thân (bắp vai tròn trùm lên vai), loe nhẹ, hở ở gấu
        sleeve_w = chain_weights(["Chest", (sh + Vector((-0.07 * sx, 0, 0)), Vector((sx, 0, 0)), 0.04, f"Shoulder.{s}"), (sh, el - sh, 0.06, f"UpperArm.{s}")])
        # đỉnh bắp tay áo ≈ đường dốc vai của thân áo → vai liền, không nếp gãy
        spts, sts = polyline([sh + Vector((-0.11 * sx, 0, -0.035)), sh + Vector((-0.035 * sx, 0, -0.02)), sh.lerp(el, 0.45)], 5)
        sprof = [(0, 0.03), (0.3, 0.06), (0.55, 0.066), (1, 0.066)]
        limb_path(f"Sleeve.{s}", spts, [interp(sprof, t) for t in sts], shirt, ["Chest", f"Shoulder.{s}", f"UpperArm.{s}"], caps="start", uv_scale=(1, 0.5), weights=sleeve_w)
        ellipsoid(f"Hand.{s}", wr.lerp(ha, 0.5), (0.037, 0.032, 0.056), skin, [f"Hand.{s}"], segs=16, rings=10)
        ellipsoid(f"Thumb.{s}", wr.lerp(ha, 0.3) + Vector((-0.022 * sx, -0.026, 0)), (0.013, 0.013, 0.027), skin, [f"Hand.{s}"], segs=10, rings=6)
        if s == "L":
            torus("Watch", wr + Vector((0, 0, 0.022)), 0.038, 0.008, gold, ["LowerArm.L"], tilt=0.0)
        # chân jean liền khối hông → cổ chân (đùi đầy, gối thon), rách gối, gấu xắn sáng màu
        hip = Vector(BONES[f"UpperLeg.{s}"][0])
        kn = Vector(BONES[f"LowerLeg.{s}"][0])
        an = Vector(BONES[f"Foot.{s}"][0])
        lpts, lts = polyline([hip + Vector((0, 0, 0.02)), kn, an + Vector((0, 0, 0.05))], 7)
        lprof = [(0, 0.086), (0.25, 0.078), (0.48, 0.064), (0.62, 0.066), (0.85, 0.058), (1, 0.056)]
        leg_w = chain_weights(["Hips", (hip, kn - hip, 0.07, f"UpperLeg.{s}"), (kn, an - kn, 0.04, f"LowerLeg.{s}")])
        limb_path(f"Leg.{s}", lpts, [interp(lprof, t) for t in lts], jeans, [f"UpperLeg.{s}", f"LowerLeg.{s}", "Hips"], weights=leg_w)
        ellipsoid(f"Rip.{s}", on_leg := kn + Vector((0.005 * sx, -0.062, 0.012)), (0.028, 0.006, 0.017), rip, [f"LowerLeg.{s}", f"UpperLeg.{s}"], segs=10, rings=6)
        limb(f"Cuff.{s}", an + Vector((0, 0, 0.035)), an + Vector((0, 0, 0.075)), [(0, 0.06), (1, 0.06)], jeans_l, [f"LowerLeg.{s}"])
        fx = an.x
        ellipsoid(f"Shoe.{s}", (fx, -0.035, 0.05), (0.057, 0.105, 0.062), shoe, [f"Foot.{s}"], segs=18, rings=10, cut=-0.35)
        ellipsoid(f"Sole.{s}", (fx, -0.035, 0.028), (0.063, 0.112, 0.028), sole, [f"Foot.{s}"], segs=18, rings=8)
        ellipsoid(f"Swoosh.{s}", (fx + 0.055 * sx, -0.045, 0.058), (0.006, 0.048, 0.012), accent, [f"Foot.{s}"], segs=10, rings=6)
        ellipsoid(f"Tongue.{s}", (fx, 0.005, 0.1), (0.033, 0.028, 0.02), accent, [f"Foot.{s}", f"LowerLeg.{s}"], segs=10, rings=6)


# ---------------------------------------------------------------- xương + trọng lượng da

def build_armature():
    arm = bpy.data.armatures.new("Armature")
    rig = bpy.data.objects.new("Armature", arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (h, t, parent) in BONES.items():
        b = arm.edit_bones.new(name)
        b.head, b.tail = Vector(h), Vector(t)
        b.roll = 0
        if parent:
            b.parent = arm.edit_bones[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length


def smooth01(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def chain_weights(chain):
    """
    Trọng lượng chuyển mượt qua các khớp: chain = [xương gốc, (khớp, trục, nửa bề rộng dải, xương con), ...].
    Mỗi khớp: phần nằm phía con (theo trục) chuyển dần sang xương con trong dải ±width → vai / khuỷu / gối gập mềm,
    tay áo đi theo cánh tay khi giơ tay.
    """
    root = chain[0]

    def fn(p):
        ws = {root: 1.0}
        last = root
        for joint, axis, width, child in chain[1:]:
            b = smooth01(((p - Vector(joint)).dot(Vector(axis).normalized()) + width) / (2 * width))
            moved = ws[last] * b
            ws[last] -= moved
            ws[child] = ws.get(child, 0.0) + moved
            last = child
        return ws

    return fn


def skin(rig):
    for ob, allowed, wfn in PARTS:
        ob.parent = rig
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = rig
        groups = {n: ob.vertex_groups.new(name=n) for n in allowed}
        for v in ob.data.vertices:
            p = ob.matrix_world @ v.co
            if wfn:
                for n, w in wfn(p).items():
                    if w > 0.01:
                        groups.setdefault(n, ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n)).add([v.index], w, "REPLACE")
                continue
            ws = []
            for n in allowed:
                h, t, _ = BONES[n]
                d = seg_dist(p, Vector(h), Vector(t))
                ws.append((1.0 / (d + 0.01) ** 4, n))
            ws.sort(reverse=True)
            top = ws[:2]
            tot = sum(w for w, _ in top)
            for w, n in top:
                if w / tot > 0.02:
                    groups[n].add([v.index], w / tot, "REPLACE")


# ---------------------------------------------------------------- hoạt ảnh

def local_rot(rig, bone, axis, deg):
    """Quaternion cục bộ của xương tương ứng xoay `deg` độ quanh trục thế giới `axis` (ở tư thế nghỉ)."""
    B = rig.data.bones[bone].matrix_local.to_quaternion()
    Rw = Quaternion(Vector(axis), math.radians(deg))
    return B.inverted() @ Rw @ B


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def pose(rig, frame, spec, hips_z=0.0):
    """spec: {xương: [(trục, độ), ...]} – ghép theo thứ tự; xương không có trong spec → tư thế nghỉ."""
    for pb in rig.pose.bones:
        rots = spec.get(pb.name, [])
        q = Quaternion()
        for axis, deg in rots:
            q = q @ local_rot(rig, pb.name, axis, deg)
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = q
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == "Hips":
            pb.location = Vector((0, hips_z, 0))  # trục Y cục bộ của Hips = lên
            pb.keyframe_insert("location", frame=frame)


def mirror(spec):
    """Đảo trái / phải: đổi tên .L/.R, lật góc quanh Y và Z."""
    out = {}
    for name, rots in spec.items():
        other = name.replace(".L", ".tmp").replace(".R", ".L").replace(".tmp", ".R")
        out[other] = [(a, -d if a in (Y, Z) else d) for a, d in rots]
    return out


def merge(*specs):
    out = {}
    for s in specs:
        for k, v in s.items():
            out.setdefault(k, []).extend(v)
    return out


# Quanh trục Y (trước–sau): tay trái giơ ra ngoài = góc âm, tay phải = góc dương.
ARMS_DOWN = {"UpperArm.L": [(Y, -4)], "UpperArm.R": [(Y, 4)], "LowerArm.L": [(X, -10)], "LowerArm.R": [(X, -10)]}


def action(rig, name, frames, fn, loop=True):
    act = bpy.data.actions.new(name)
    rig.animation_data_create()
    rig.animation_data.action = act
    for f in range(0, frames + 1, 2 if frames > 20 else 1):
        spec, hz = fn(f / frames)
        pose(rig, f, spec, hz)
    if loop:
        spec, hz = fn(0.0)
        pose(rig, frames, spec, hz)
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    strip.name = name
    rig.animation_data.action = None
    return act


def build_actions(rig):
    sin, cos, pi = math.sin, math.cos, math.pi

    def idle(t):
        b = sin(2 * pi * t)
        return merge(ARMS_DOWN, {"Spine": [(X, 1.2 * b)], "Chest": [(X, -1.0 * b), (Z, 1.5 * sin(2 * pi * t + 1))], "Head": [(X, 1.5 * sin(2 * pi * t + 2)), (Z, 3 * sin(2 * pi * t))],
                                 "UpperArm.L": [(X, 2 * b)], "UpperArm.R": [(X, -2 * b)]}), 0.004 * b

    def walk(t, run=False):
        a = 2 * pi * t
        leg = 40 if run else 24
        s = sin(a)
        lift = lambda ph: max(0.0, sin(ph))  # noqa: E731
        knee_l = (75 if run else 40) * lift(a + pi) + 6
        knee_r = (75 if run else 40) * lift(a) + 6
        arm = 45 if run else 20
        elbow = -80 if run else -15
        lean = 12 if run else 3
        sway = 5 if not run else 3  # dáng đi nghênh ngang
        spec = {
            "UpperLeg.L": [(X, -leg * s)], "UpperLeg.R": [(X, leg * s)],
            "LowerLeg.L": [(X, knee_l)], "LowerLeg.R": [(X, knee_r)],
            "Foot.L": [(X, -10 * s)], "Foot.R": [(X, 10 * s)],
            "UpperArm.L": [(X, arm * s), (Y, -6)], "UpperArm.R": [(X, -arm * s), (Y, 6)],
            "LowerArm.L": [(X, elbow)], "LowerArm.R": [(X, elbow)],
            "Hips": [(Z, sway * s)], "Spine": [(X, lean)], "Chest": [(Z, -sway * 1.4 * s), (Y, 2 * s)],
            "Head": [(Z, 2 * s), (X, -lean * 0.6)],
        }
        return spec, -(0.03 if run else 0.018) * abs(cos(a)) + (0.01 if run else 0.004)

    def jump(t):
        crouch = max(0.0, 1 - abs(t - 0.15) / 0.15) + max(0.0, 1 - abs(t - 0.75) / 0.15) * 0.8
        up = max(0.0, sin(pi * (t - 0.25) / 0.45)) if 0.25 < t < 0.7 else 0.0
        spec = {
            "UpperLeg.L": [(X, -40 * crouch - 10 * up)], "UpperLeg.R": [(X, -40 * crouch - 10 * up)],
            "LowerLeg.L": [(X, 70 * crouch + 20 * up)], "LowerLeg.R": [(X, 70 * crouch + 20 * up)],
            "Foot.L": [(X, -25 * crouch)], "Foot.R": [(X, -25 * crouch)],
            "Spine": [(X, 20 * crouch)],
            "UpperArm.L": [(X, 30 * crouch - 150 * up)], "UpperArm.R": [(X, 30 * crouch - 150 * up)],
            "LowerArm.L": [(X, -20)], "LowerArm.R": [(X, -20)],
        }
        return spec, -0.12 * crouch

    def wave(t):
        w = sin(2 * pi * t * 3)
        return merge(ARMS_DOWN, {"UpperArm.R": [(Y, 150)], "LowerArm.R": [(Y, 20 + 25 * w)], "Head": [(Z, -8), (Y, -5)], "Chest": [(Z, -5)]}), 0.0

    def yes(t):
        return merge(ARMS_DOWN, {"Head": [(X, 14 * max(0.0, sin(2 * pi * t * 2)))]}), 0.0

    def no(t):
        return merge(ARMS_DOWN, {"Head": [(Z, 22 * sin(2 * pi * t * 2))]}), 0.0

    def thumbs(t):
        e = min(1.0, t / 0.25, (1 - t) / 0.25)
        return merge(ARMS_DOWN, {"UpperArm.R": [(X, -70 * e), (Y, 10 * e)], "LowerArm.R": [(X, -50 * e)], "Hand.R": [(Y, 60 * e)], "Head": [(Z, -6 * e), (Y, 6 * e)]}), 0.0

    def dance(t):
        # nhảy kiểu "quẩy": lắc hông, nhún gối, tay phải đấm lên trời theo nhịp, tay trái chống hông
        a = 2 * pi * t * 2
        b = sin(a)
        pump = max(0.0, sin(a * 2))
        return {
            "Hips": [(Z, 14 * b)], "Chest": [(Z, -16 * b), (Y, 4 * b)], "Spine": [(X, 6 * pump)],
            "Head": [(X, 10 * pump), (Z, 6 * b)],
            "UpperLeg.L": [(X, -15 * max(0.0, b))], "UpperLeg.R": [(X, -15 * max(0.0, -b))],
            "LowerLeg.L": [(X, 25 * max(0.0, b) + 10)], "LowerLeg.R": [(X, 25 * max(0.0, -b) + 10)],
            "UpperArm.R": [(Y, 60 + 90 * pump), (X, -20)], "LowerArm.R": [(X, -40 + 30 * pump)],
            "UpperArm.L": [(Y, -45), (X, 10)], "LowerArm.L": [(Z, -80), (X, -30)],
        }, -0.04 * pump

    def victory(t):
        e = min(1.0, t / 0.2)
        bob = 0.03 * sin(2 * pi * t * 2)
        return {"UpperArm.L": [(Y, -150 * e)], "UpperArm.R": [(Y, 150 * e)], "LowerArm.L": [(Y, -20 * e)], "LowerArm.R": [(Y, 20 * e)],
                "Head": [(X, -12 * e)], "Spine": [(X, -5 * e)]}, bob

    def defeat(t):
        e = min(1.0, t / 0.3)
        return merge(ARMS_DOWN, {"Spine": [(X, 22 * e)], "Chest": [(X, 10 * e)], "Head": [(X, 28 * e)],
                                 "UpperArm.L": [(X, -8 * e), (Y, 4 * e)], "UpperArm.R": [(X, -8 * e), (Y, -4 * e)]}), -0.02 * e

    def clap(t):
        c = 0.5 + 0.5 * sin(2 * pi * t * 3)
        return {"UpperArm.L": [(X, -55), (Z, -25)], "UpperArm.R": [(X, -55), (Z, 25)],
                "LowerArm.L": [(X, -35), (Z, -30 - 25 * c)], "LowerArm.R": [(X, -35), (Z, 30 + 25 * c)], "Head": [(X, 4)]}, 0.0

    def pickup(t):
        e = sin(pi * min(1.0, t / 0.9)) if t < 0.9 else 0.0
        return merge(ARMS_DOWN, {"Spine": [(X, 45 * e)], "Chest": [(X, 20 * e)], "Head": [(X, -15 * e)],
                                 "UpperLeg.L": [(X, -35 * e)], "UpperLeg.R": [(X, -35 * e)], "LowerLeg.L": [(X, 60 * e)], "LowerLeg.R": [(X, 60 * e)],
                                 "Foot.L": [(X, -25 * e)], "Foot.R": [(X, -25 * e)],
                                 "UpperArm.R": [(X, -50 * e)], "UpperArm.L": [(X, -25 * e)]}), -0.14 * e

    action(rig, "Idle", 60, idle)
    action(rig, "Walk", 30, walk)
    action(rig, "Run", 20, lambda t: walk(t, True))
    action(rig, "Jump", 30, jump, loop=False)
    action(rig, "Wave", 45, wave)
    action(rig, "Yes", 30, yes)
    action(rig, "No", 30, no)
    action(rig, "ThumbsUp", 40, thumbs, loop=False)
    action(rig, "Dance", 60, dance)
    action(rig, "Victory", 40, victory, loop=False)
    action(rig, "Defeat", 60, defeat, loop=False)
    action(rig, "Clap", 30, clap)
    action(rig, "PickUp", 40, pickup, loop=False)


# ---------------------------------------------------------------- hoạt ảnh Mixamo (retarget)

# Xương của mình ← xương Mixamo (Spine của mình ≈ Spine1, Chest ≈ Spine2).
MIXAMO_MAP = {"Hips": "Hips", "Spine": "Spine1", "Chest": "Spine2", "Neck": "Neck", "Head": "Head"}
for _s, _m in (("L", "Left"), ("R", "Right")):
    MIXAMO_MAP.update({f"Shoulder.{_s}": f"{_m}Shoulder", f"UpperArm.{_s}": f"{_m}Arm", f"LowerArm.{_s}": f"{_m}ForeArm", f"Hand.{_s}": f"{_m}Hand",
                       f"UpperLeg.{_s}": f"{_m}UpLeg", f"LowerLeg.{_s}": f"{_m}Leg", f"Foot.{_s}": f"{_m}Foot"})
# Tên file (id trong scripts/mixamo/download.ts) → tên clip chuẩn (thay hoạt ảnh tự sinh cùng tên).
MIXAMO_CLIP = {"idle_breathing": "Idle", "walk": "Walk", "run": "Run", "jump": "Jump", "wave": "Wave", "yes": "Yes", "no": "No",
               "thumbsup": "ThumbsUp", "clap": "Clap", "victory": "Victory", "defeat": "Defeat", "pickup": "PickUp", "dance_hiphop": "Dance"}


def clip_name(file_id):
    return MIXAMO_CLIP.get(file_id) or "".join(w.capitalize() for w in file_id.split("_"))


def retarget(rig, fbx, name):
    """Nhập FBX Mixamo, chép chuyển động sang `rig` thành action `name` (theo hướng xương trong không gian thế giới)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=False)
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == "ARMATURE")
    prefix = next((b.name.split(":")[0] + ":" for b in src.data.bones if ":" in b.name), "")
    smap = {n: prefix + m for n, m in MIXAMO_MAP.items() if prefix + m in src.data.bones}
    sact = src.animation_data.action
    f0, f1 = (int(round(v)) for v in sact.frame_range)

    def rest(arm, bname):
        return (arm.matrix_world @ arm.data.bones[bname].matrix_local).to_quaternion()

    ours = {b.name: rest(rig, b.name) for b in rig.data.bones}
    theirs = {n: rest(src, m) for n, m in smap.items()}
    ydir = lambda q: q @ Vector((0, 1, 0))  # noqa: E731
    # Căn hướng tư thế nghỉ: Mixamo tay dang chữ T, của mình tay buông.
    align = {n: ydir(ours[n]).rotation_difference(ydir(theirs[n])) for n in smap}
    hips_rest = src.matrix_world @ src.data.bones[smap["Hips"]].head_local
    k = BONES["Hips"][0][2] / max(hips_rest.z, 1e-3)

    act = bpy.data.actions.new(name)
    rig.animation_data_create()
    rig.animation_data.action = act
    scene = bpy.context.scene
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        want = {}
        for n in BONES:
            b = rig.data.bones[n]
            if n in smap:
                qp = (src.matrix_world @ src.pose.bones[smap[n]].matrix).to_quaternion()
                want[n] = qp @ theirs[n].inverted() @ align[n] @ ours[n]
            else:
                par = b.parent.name
                want[n] = want[par] @ ours[par].inverted() @ ours[n]
            base = want[b.parent.name] @ ours[b.parent.name].inverted() @ ours[n] if b.parent else ours[n]
            pb = rig.pose.bones[n]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = base.inverted() @ want[n]
            pb.keyframe_insert("rotation_quaternion", frame=f - f0)
        head = src.matrix_world @ src.pose.bones[smap["Hips"]].head
        pbh = rig.pose.bones["Hips"]
        pbh.location = ours["Hips"].inverted() @ ((head - hips_rest) * k)
        pbh.keyframe_insert("location", frame=f - f0)
    rig.animation_data.action = None
    # Thay hoạt ảnh tự sinh cùng tên (nếu có).
    for t in list(rig.animation_data.nla_tracks):
        if t.name == name:
            old = t.strips[0].action if t.strips else None
            rig.animation_data.nla_tracks.remove(t)
            if old and old != act:
                bpy.data.actions.remove(old)
    act.name = name
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act).name = name
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        if a.users == 0 and a != act:
            bpy.data.actions.remove(a)
    return f1 - f0


def load_mixamo(rig, folder):
    import json
    import os

    manifest = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf8"))
    for fid, info in manifest.items():
        path = os.path.join(folder, info["file"])
        if not os.path.exists(path):
            continue
        try:
            n = retarget(rig, path, clip_name(fid))
            print(f"RETARGET {fid} -> {clip_name(fid)} ({n} frame, \"{info['name']}\")")
        except Exception as err:  # một file lỗi không làm hỏng cả nhân vật
            print(f"RETARGET-FAIL {fid}: {err}")


# ---------------------------------------------------------------- xem trước (Workbench)

def preview(path, rig):
    """Ảnh xem trước: <path>_1..5.png = trước mặt, 3/4 + cười, cận mặt ngạc nhiên, đang đi, vẫy tay."""
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.color_type = "MATERIAL"
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.75, 0.85, 0.95, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    bpy.context.collection.objects.link(sun)
    scene.render.resolution_x, scene.render.resolution_y = 640, 800
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    face = bpy.data.objects["Face"]
    rig.animation_data_create()

    def shot(i, loc, look, lens, keys=None, act=None, frame=0):
        for kb in face.data.shape_keys.key_blocks[1:]:
            kb.value = (keys or {}).get(kb.name, 0.0)
        rig.animation_data.action = bpy.data.actions.get(act) if act else None
        for t in rig.animation_data.nla_tracks:
            t.mute = True
        if not act:
            for pb in rig.pose.bones:
                pb.rotation_quaternion = Quaternion()
                pb.location = Vector()
        scene.frame_set(frame)
        cam.location = loc
        cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        scene.render.filepath = f"{path}_{i}.png"
        bpy.ops.render.render(write_still=True)

    if os.environ.get("AC_TURNAROUND"):
        # Xoay quanh: trước, 3/4, nghiêng, sau, cận mặt 3/4, cận mặt nghiêng (kiểm tra tỉ lệ / tóc).
        shot("t1", (0, -3.4, 1.0), (0, 0, 0.9), 42)
        shot("t2", (2.3, -2.5, 1.2), (0, 0, 0.9), 42)
        shot("t3", (3.4, 0, 1.0), (0, 0, 0.9), 42)
        shot("t4", (0, 3.4, 1.0), (0, 0, 0.9), 42)
        shot("t5", (0.6, -0.9, 1.62), (0, 0, 1.56), 55)
        shot("t6", (1.05, -0.05, 1.6), (0, 0, 1.58), 55)
        # cận vai + tay áo: trước, 3/4, nghiêng, sau; tư thế vẫy tay và đang đi
        shot("s1", (0.0, -1.3, 1.3), (0.0, 0, 1.2), 50)
        shot("s2", (0.9, -1.0, 1.35), (0.15, 0, 1.2), 50)
        shot("s3", (1.3, 0.0, 1.3), (0.15, 0, 1.2), 50)
        shot("s4", (0.5, 1.2, 1.35), (0.1, 0, 1.2), 50)
        shot("s5", (-0.6, -1.3, 1.45), (-0.15, 0, 1.3), 50, None, "Wave", 10)
        shot("s6", (1.2, -0.8, 1.3), (0.1, 0, 1.15), 50, None, "Walk", 8)
        shot("s7", (0.0, -2.2, 1.5), (0.0, 0, 1.4), 50, None, "Victory", 30)
        shot("s8", (1.4, -1.2, 1.5), (0.0, 0, 1.4), 50, None, "Cheer", 20)
        return
    shot(1, (0, -3.4, 1.0), (0, 0, 0.9), 42)
    shot(2, (1.6, -2.8, 1.3), (0, 0, 0.95), 42, {"happy": 1.0})
    shot(3, (0.25, -1.0, 1.6), (0, 0, 1.55), 50, {"surprised": 1.0, "oh": 0.4})
    shot(4, (2.8, -1.6, 1.1), (0, 0, 0.9), 42, None, "Walk", 8)
    shot(5, (0.8, -3.0, 1.2), (0, 0, 1.0), 42, {"happy": 0.6, "aa": 0.6}, "Wave", 10)
    shot(6, (-0.9, -3.0, 1.2), (0, 0, 1.0), 42, {"happy": 1.0}, "Dance", 14)
    close = ((0.35, -0.95, 1.52), (0, 0, 1.49), 60)
    for i, keys in enumerate([{}, {"happy": 0.9}, {"happy": 0.9, "aa": 0.7}, {"ee": 1.0}, {"ou": 1.0}, {"sad": 0.9, "oh": 0.5}, {"surprised": 0.9}, {"angry": 0.9, "ih": 0.6}]):
        shot(f"m{i}", *close, keys)


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_body()
    build_face()
    rig = build_armature()
    skin(rig)
    build_actions(rig)
    if a["mixamo"]:
        load_mixamo(rig, a["mixamo"])
    if a["preview"]:
        preview(a["preview"], rig)
    if a["out"]:
        export_glb(a["out"])


def export_glb(path):
    # Giá trị shape key hiện tại thành trọng số morph mặc định trong glTF: về 0, không thì trình xem (không điều khiển
    # khuôn mặt) hiện mọi biểu cảm chồng lên nhau.
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob.data.shape_keys:
            for kb in ob.data.shape_keys.key_blocks[1:]:
                kb.value = 0.0
    # Engine tìm xương theo tên (Head, Hand.R, Palm.R… – SceneEngine HAND_NODES): mesh trùng tên xương sẽ bị chọn
    # nhầm (đồ vật gắn vào mesh đứng yên thay vì bàn tay) → đổi tên mọi mesh, trừ Face.
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob.name != "Face" and not ob.name.endswith("_mesh"):
            ob.name = f"{ob.name}_mesh"
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_morph=True,
        export_morph_normal=False,
        export_skins=True,
        export_apply=False,
        export_yup=True,
    )
    print("EXPORTED", path)


# gen_character.py import file này như thư viện (hình khối, khuôn mặt, xương, hoạt ảnh) – chỉ dựng DanChoi khi chạy trực tiếp.
if __name__ == "__main__":
    main()
