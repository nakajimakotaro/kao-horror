"""103号室の玄関・キッチン・ユニットバスの小道具。

    door_entrance door_bath door_sliding_glass fridge microwave kitchen_counter washer
    shoebox breaker_panel light_switch ceiling_light ceiling_light_small toilet bath_sink
    bathtub shower_curtain shoes flashlight medicine_bag notebook

Run:
    Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/interior_kitchen_bath.py -- --preview
    ... -- --only fridge,toilet --preview

All coordinates are three.js space (x right, y up, z = front), see tools/blender/common.py.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import *  # noqa: E402,F401,F403
import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402


# ═══════════════════════════════════════════════════════════════════════════
#  local helpers (common.py is shared and must not be edited)
# ═══════════════════════════════════════════════════════════════════════════
_mat = mat


def mat(name, color="#bbbbbb", rough=0.8, metal=0.0, **kw):  # noqa: F811
    """common.mat with metalness capped: the game has no environment map, so very metallic
    surfaces would render almost black except for the flashlight highlight."""
    return _mat(name, color, max(rough, 0.25), min(metal, 0.55), **kw)


AXIS = {"x": Vector((1, 0, 0)), "y": Vector((0, 0, 1)), "z": Vector((0, -1, 0))}


def bx(name, x0, x1, y0, y1, z0, z1, m=None, bevel=0.0):
    """Box from min/max extents (three.js space)."""
    return box(name, (x1 - x0, y1 - y0, z1 - z0), ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), m, bevel=bevel)


def cy_(name, r, y0, y1, x, z, m=None, n=12, r2=None, cap=True):
    """Vertical cylinder / frustum (r at y0, r2 at y1)."""
    return cyl(name, r, y1 - y0, (x, (y0 + y1) / 2, z), m, verts=n, axis="y", radius2=r2, cap=cap)


def cz_(name, r, z0, z1, x, y, m=None, n=12, r2=None, cap=True):
    """Cylinder along z (r at z0, r2 at z1)."""
    return cyl(name, r, z1 - z0, (x, y, (z0 + z1) / 2), m, verts=n, axis="z", radius2=r2, cap=cap)


def cx_(name, r, x0, x1, y, z, m=None, n=12, r2=None, cap=True):
    """Cylinder along x (r at x0, r2 at x1)."""
    return cyl(name, r, x1 - x0, ((x0 + x1) / 2, y, z), m, verts=n, axis="x", radius2=r2, cap=cap)


def mk(name, verts, faces, mats, fmat=None, uvs=None, smooth=False, sharp=35.0):
    """Mesh object from three-space verts. mats: material list, fmat: material index per face,
    uvs: {face_index: [(u, v) per corner]} (other faces get (0, 0))."""
    if not isinstance(mats, (list, tuple)):
        mats = [mats]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(T(*v)) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    for m in mats:
        me.materials.append(m)
    if fmat:
        for p, i in zip(me.polygons, fmat):
            p.material_index = i
    if uvs is not None:
        lay = me.uv_layers.new(name="UVMap")
        for p in me.polygons:
            uv = uvs.get(p.index)
            for k, li in enumerate(p.loop_indices):
                lay.data[li].uv = uv[k] if uv else (0.0, 0.0)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if smooth:
        smooth_by_angle(obj, sharp)
    return obj


def smooth_by_angle(obj, deg=35.0):
    for p in obj.data.polygons:
        p.use_smooth = True
    obj.data.set_sharp_from_angle(angle=math.radians(deg))
    return obj


def sring(cx, y, cz, rx, rz, n=24, p=2.0, phase=0.0):
    """Superellipse ring in the XZ plane (p=2 ellipse, larger p = rounder rectangle)."""
    e = 2.0 / p
    out = []
    for i in range(n):
        t = phase + 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        out.append((cx + rx * math.copysign(abs(c) ** e, c), y, cz + rz * math.copysign(abs(s) ** e, s)))
    return out


def rect_ring(cx, y, cz, hx, hz, n=24, phase=0.0):
    """Rectangle sampled with the same angular parameter as sring (so rings can be lofted)."""
    out = []
    for i in range(n):
        t = phase + 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        k = max(abs(c), abs(s))
        out.append((cx + hx * c / k, y, cz + hz * s / k))
    return out


def loft(name, rings, mats, band=None, loop=False, cap0=None, cap1=None, smooth=True, sharp=35.0):
    """Skin consecutive rings (equal point counts). band[i] = material index between ring i and i+1.
    Rings going up with points running +x -> +z give outward normals. cap0/cap1 = material index of
    an n-gon closing the first/last ring (None = open)."""
    n = len(rings[0])
    R = len(rings)
    verts = [p for r in rings for p in r]
    faces, fm = [], []
    for i in range(R if loop else R - 1):
        i2 = (i + 1) % R
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            c, d = i2 * n + (j + 1) % n, i2 * n + j
            faces.append((a, d, c, b))
            fm.append(band[i] if band else 0)
    if cap0 is not None:
        faces.append(tuple(range(n)))
        fm.append(cap0)
    if cap1 is not None:
        faces.append(tuple(range((R - 1) * n, R * n))[::-1])
        fm.append(cap1)
    return mk(name, verts, faces, mats, fm, smooth=smooth, sharp=sharp)


def frame_plate(name, outer, inner, y0, y1, mats, band=None, smooth=False):
    """Flat plate with a hole: outer/inner are lists of (x, z) with the same parametrisation."""
    rings = [[(x, y0, z) for x, z in inner], [(x, y0, z) for x, z in outer],
             [(x, y1, z) for x, z in outer], [(x, y1, z) for x, z in inner]]
    return loft(name, rings, mats, band=band, loop=True, smooth=smooth)


def xz(ring):
    return [(p[0], p[2]) for p in ring]


def tube(name, pts, r, m, seg=8, caps=True, smooth=True):
    """Sweep a circle along a polyline (three-space points)."""
    P = [Vector(p) for p in pts]
    n = len(P)
    tang = []
    for i in range(n):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        tang.append(t.normalized())
    up = Vector((0, 1, 0)) if abs(tang[0].y) < 0.9 else Vector((1, 0, 0))
    nrm = tang[0].cross(up).normalized()
    rings = []
    for i in range(n):
        if i > 0:
            ax = tang[i - 1].cross(tang[i])
            if ax.length > 1e-7:
                nrm = Matrix.Rotation(tang[i - 1].angle(tang[i]), 3, ax.normalized()) @ nrm
        b = tang[i].cross(nrm).normalized()
        rr = r[i] if isinstance(r, (list, tuple)) else r
        rings.append([tuple(P[i] + (nrm * math.cos(2 * math.pi * k / seg) + b * math.sin(2 * math.pi * k / seg)) * rr)
                      for k in range(seg)])
    return loft(name, rings, m, cap0=0 if caps else None, cap1=0 if caps else None, smooth=smooth, sharp=60)


def torus(name, R, r, c, axis, m, nu=8, nv=4):
    """Torus around `axis` ('x','y','z' in three space) centred at c."""
    a = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}[axis]
    u = Vector((0, 1, 0)) if axis != "y" else Vector((1, 0, 0))
    u = (u - a * u.dot(a)).normalized()
    w = a.cross(u)
    C = Vector(c)
    verts, faces = [], []
    for i in range(nu):
        th = 2 * math.pi * i / nu
        radial = u * math.cos(th) + w * math.sin(th)
        for j in range(nv):
            ph = 2 * math.pi * j / nv
            verts.append(tuple(C + radial * (R + r * math.cos(ph)) + a * (r * math.sin(ph))))
    for i in range(nu):
        for j in range(nv):
            i2, j2 = (i + 1) % nu, (j + 1) % nv
            faces.append((i * nv + j, i2 * nv + j, i2 * nv + j2, i * nv + j2))
    return mk(name, verts, faces, m, smooth=True, sharp=80)


def obox(name, p0, p1, w, t, m, up=(0, 1, 0), roll=0.0):
    """Box whose long axis runs from p0 to p1 (w across `up`, t the remaining axis)."""
    p0, p1 = Vector(p0), Vector(p1)
    xd = p1 - p0
    L = xd.length
    xd.normalize()
    u = Vector(up)
    if abs(xd.dot(u)) > 0.97:
        u = Vector((1, 0, 0)) if abs(xd.x) < 0.9 else Vector((0, 0, 1))
    zd = xd.cross(u).normalized()
    yd = zd.cross(xd).normalized()
    if roll:
        rm = Matrix.Rotation(math.radians(roll), 3, xd)
        yd, zd = rm @ yd, rm @ zd
    c = (p0 + p1) / 2
    verts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                verts.append(tuple(c + xd * (sx * L / 2) + yd * (sy * w / 2) + zd * (sz * t / 2)))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    o = mk(name, verts, faces, m)
    fix_normals(o)
    return o


def quad(name, c, u, v, w, h, m):
    """Single quad centred at c spanning w along u and h along v (three-space vectors)."""
    C, U, V = Vector(c), Vector(u).normalized(), Vector(v).normalized()
    pts = [C - U * w / 2 - V * h / 2, C + U * w / 2 - V * h / 2, C + U * w / 2 + V * h / 2, C - U * w / 2 + V * h / 2]
    return mk(name, [tuple(p) for p in pts], [(0, 1, 2, 3)], m)


def fix_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def paint(obj, m, pred):
    """Give faces whose (normal, centre) in three space satisfy pred the material m."""
    me = obj.data
    names = [x.name if x else None for x in me.materials]
    if m.name in names:
        idx = names.index(m.name)
    else:
        me.materials.append(m)
        idx = len(me.materials) - 1
    update()
    mw = obj.matrix_world
    r3 = mw.to_3x3()
    for p in me.polygons:
        n = (r3 @ p.normal).normalized()
        c = mw @ p.center
        if pred((n.x, n.z, -n.y), (c.x, c.z, -c.y)):
            p.material_index = idx
    return obj


def xform(objs, rot=None, pivot=(0, 0, 0), move=(0, 0, 0)):
    """Rotate (list of (axis, deg) in three space) about pivot, then translate; bakes into the mesh."""
    if not isinstance(objs, (list, tuple)):
        objs = [objs]
    update()
    pv = T(*pivot)
    M = Matrix.Identity(4)
    for ax, deg in (rot or []):
        M = Matrix.Rotation(math.radians(deg), 4, AXIS[ax]) @ M
    full = Matrix.Translation(T(*move)) @ Matrix.Translation(pv) @ M @ Matrix.Translation(-pv)
    for o in objs:
        o.matrix_world = full @ o.matrix_world
        apply_transform(o)
    return objs


def grp(objs, name):
    """Join (dropping Nones) and return the single object."""
    return join([o for o in objs if o is not None], name)


def part(objs, name, pivot):
    o = grp(objs, name)
    set_origin(o, pivot)
    return o


# ═══════════════════════════════════════════════════════════════════════════
#  shared sub-builders
# ═══════════════════════════════════════════════════════════════════════════
def flashlight_pieces(prefix, lens_m):
    """Flashlight along z, centred at the origin, lens at -z (length 0.2, diameter 0.05)."""
    black = mat("fl_black", "#1b1b1d", 0.55, 0.1)
    grip = mat("fl_grip", "#2e2e31", 0.75, 0.05)
    silver = mat("fl_silver", "#b9bbbd", 0.28, 0.85)
    bezel = mat("fl_bezel", "#8a8d90", 0.3, 0.85)
    orange = mat("fl_switch", "#d4692a", 0.5)
    tail = mat("fl_tail", "#5a5d60", 0.35, 0.7)
    o = []
    o.append(cz_(prefix + "head", 0.0248, -0.094, -0.05, 0, 0, silver, n=16, r2=0.019, cap=False))
    o.append(loft(prefix + "bezel", [
        [(math.cos(a) * 0.0258, math.sin(a) * 0.0258, -0.093) for a in [2 * math.pi * k / 16 for k in range(16)]],
        [(math.cos(a) * 0.0258, math.sin(a) * 0.0258, -0.1) for a in [2 * math.pi * k / 16 for k in range(16)]],
        [(math.cos(a) * 0.0222, math.sin(a) * 0.0222, -0.1) for a in [2 * math.pi * k / 16 for k in range(16)]],
        [(math.cos(a) * 0.0222, math.sin(a) * 0.0222, -0.0965) for a in [2 * math.pi * k / 16 for k in range(16)]],
    ], [bezel, lens_m], cap1=1, smooth=True, sharp=40))
    o.append(cz_(prefix + "neck", 0.019, -0.05, -0.04, 0, 0, silver, n=16, r2=0.0172))
    o.append(cz_(prefix + "body", 0.017, -0.041, 0.079, 0, 0, black, n=14))
    for i, z in enumerate((-0.022, -0.008, 0.006, 0.020, 0.034, 0.048)):
        o.append(cz_(prefix + f"knurl{i}", 0.0179, z, z + 0.006, 0, 0, grip, n=14, cap=False))
    o.append(bx(prefix + "swbase", -0.0065, 0.0065, 0.0155, 0.0195, -0.034, -0.010, grip, 0.0015))
    o.append(bx(prefix + "slider", -0.0045, 0.0045, 0.0185, 0.0228, -0.029, -0.020, orange, 0.001))
    o.append(cz_(prefix + "tail", 0.0184, 0.078, 0.1, 0, 0, tail, n=14))
    o.append(cz_(prefix + "tailring", 0.0188, 0.083, 0.087, 0, 0, black, n=14))
    o.append(bx(prefix + "loop", -0.0025, 0.0025, -0.0035, 0.0035, 0.0995, 0.1002, black))
    for ob in o:
        smooth_by_angle(ob, 40)
    return o


def shoe_pieces(prefix, kind, col, sole_col, x, z, yaw, low=False, strap_col=None):
    """One shoe, toe toward +z before `yaw` (deg, about y), placed at (x, 0, z)."""
    out = []
    bev = 0.0 if low else 1.0
    if kind == "sneaker":
        up = mat(f"shoe_{col}", col, 0.75)
        so = mat(f"sole_{sole_col}", sole_col, 0.8)
        inner = mat("shoe_inner", "#2a2624", 0.9)
        lace = mat("shoe_lace", "#e8e6df", 0.8)
        out.append(bx(prefix + "sole", -0.047, 0.047, 0.0, 0.024, -0.13, 0.13, so, 0.008 * bev))
        out.append(bx(prefix + "upper", -0.042, 0.042, 0.022, 0.092, -0.125, 0.035, up, 0.016 * bev))
        out.append(bx(prefix + "toe", -0.04, 0.04, 0.022, 0.06, 0.015, 0.122, up, 0.016 * bev))
        out.append(bx(prefix + "collar", -0.03, 0.03, 0.0915, 0.0945, -0.11, -0.035, inner))
        out.append(bx(prefix + "heeltab", -0.012, 0.012, 0.06, 0.118, -0.131, -0.119, up, 0.003 * bev))
        if not low:
            for k in range(3):
                zz = -0.024 + k * 0.022
                out.append(bx(prefix + f"lace{k}", -0.026, 0.026, 0.0905 - k * 0.004, 0.0945 - k * 0.004, zz - 0.004, zz + 0.004, lace))
            out.append(bx(prefix + "stripe", -0.0435, 0.0435, 0.03, 0.036, -0.10, 0.02, so))
    elif kind == "sandal":
        bed = mat(f"sandal_{col}", col, 0.7)
        so = mat(f"sole_{sole_col}", sole_col, 0.85)
        st = mat(f"strap_{strap_col or sole_col}", strap_col or sole_col, 0.6)
        out.append(bx(prefix + "sole", -0.046, 0.046, 0.0, 0.012, -0.125, 0.125, so, 0.006 * bev))
        out.append(bx(prefix + "bed", -0.044, 0.044, 0.012, 0.022, -0.122, 0.122, bed, 0.004 * bev))
        out.append(bx(prefix + "strapL", -0.047, -0.042, 0.018, 0.05, -0.005, 0.07, st))
        out.append(bx(prefix + "strapR", 0.042, 0.047, 0.018, 0.05, -0.005, 0.07, st))
        out.append(bx(prefix + "strapT", -0.047, 0.047, 0.046, 0.055, -0.005, 0.07, st, 0.003 * bev))
    elif kind == "leather":
        up = mat(f"leather_{col}", col, 0.35, 0.05)
        so = mat(f"sole_{sole_col}", sole_col, 0.8)
        inner = mat("shoe_inner", "#2a2624", 0.9)
        out.append(bx(prefix + "sole", -0.043, 0.043, 0.0, 0.02, -0.13, 0.135, so, 0.005 * bev))
        out.append(bx(prefix + "upper", -0.039, 0.039, 0.018, 0.075, -0.125, 0.02, up, 0.014 * bev))
        out.append(bx(prefix + "toe", -0.035, 0.035, 0.018, 0.05, 0.0, 0.13, up, 0.014 * bev))
        out.append(bx(prefix + "collar", -0.028, 0.028, 0.0745, 0.0775, -0.115, -0.03, inner))
    elif kind == "boot":
        up = mat(f"boot_{col}", col, 0.6)
        so = mat(f"sole_{sole_col}", sole_col, 0.8)
        inner = mat("shoe_inner", "#2a2624", 0.9)
        out.append(bx(prefix + "sole", -0.045, 0.045, 0.0, 0.025, -0.13, 0.13, so, 0.006 * bev))
        out.append(bx(prefix + "shaft", -0.042, 0.042, 0.022, 0.21, -0.125, -0.01, up, 0.012 * bev))
        out.append(bx(prefix + "toe", -0.04, 0.04, 0.022, 0.07, -0.02, 0.125, up, 0.016 * bev))
        out.append(bx(prefix + "collar", -0.034, 0.034, 0.2095, 0.2125, -0.115, -0.02, inner))
    xform(out, rot=[("y", yaw)], move=(x, 0, z))
    return out


# ═══════════════════════════════════════════════════════════════════════════
#  door_entrance  (0.92 x 2.10 x 0.14) — steel apartment door, +Z = corridor side
# ═══════════════════════════════════════════════════════════════════════════
def build_door_entrance():
    frame_m = mat("door_frame", "#938d81", 0.55, 0.1)
    leaf_m = mat("door_leaf", "#b4ac9b", 0.5, 0.1)
    leaf_in = mat("door_leaf_in", "#bcb5a5", 0.55, 0.08)
    dirt = mat("door_dirt", "#9a917f", 0.8, 0.2)
    scuff = mat("door_scuff", "#7b7468", 0.85, 0.1)
    steel = mat("door_steel", "#b8bbbc", 0.3, 0.85)
    steel2 = mat("door_steel_dark", "#8e9294", 0.35, 0.8)
    dark = mat("door_dark", "#18191b", 0.35, 0.2)
    lens = mat("door_scope_lens", "#2a3036", 0.1, 0.4)
    board = mat("door_plate_board", "#3c3a36", 0.5, 0.3)
    tex = mat("tex_plate", "#e9e4d4", 0.6)
    sticker_w = mat("door_sticker_w", "#e3dfd2", 0.8)
    sticker_b = mat("door_sticker_b", "#5c7ea3", 0.75)
    closer_m = mat("door_closer", "#8b8c88", 0.45, 0.6)
    chain_m = mat("door_chain", "#a7aaab", 0.3, 0.9)

    # ── frame (static; the hinge-side jamb is rebated so the leaf can swing out) ──
    fr = [
        bx("jamb_l_in", -0.46, -0.40, 0.0, 2.0, -0.07, 0.0, frame_m, 0.003),
        bx("jamb_l_out", -0.46, -0.428, 0.0, 2.0, 0.0, 0.07, frame_m, 0.003),
        bx("jamb_r", 0.40, 0.46, 0.0, 2.0, -0.07, 0.07, frame_m, 0.003),
        bx("head", -0.46, 0.46, 2.0, 2.1, -0.07, 0.07, frame_m, 0.003),
        bx("stop_r", 0.386, 0.40, 0.012, 2.0, -0.07, -0.027, frame_m, 0.002),
        bx("stop_l", -0.40, -0.388, 0.012, 2.0, -0.07, -0.027, frame_m, 0.002),
        bx("stop_h", -0.40, 0.40, 1.986, 2.0, -0.07, -0.027, frame_m, 0.002),
        bx("sill", -0.40, 0.40, 0.0, 0.012, -0.07, -0.027, steel2, 0.002),
        bx("sill_out", -0.40, 0.40, 0.0, 0.004, 0.027, 0.07, steel2),
        # chain base on the latch-side stop (inside)
        bx("chain_base", 0.380, 0.386, 1.33, 1.405, -0.062, -0.038, steel, 0.0015),
        torus("chain_staple", 0.006, 0.0018, (0.377, 1.372, -0.05), "z", chain_m, 8, 4),
    ]
    frame = grp(fr, "frame")

    # ── leaf ──
    lf = [bx("leaf", -0.40, 0.40, 0.006, 1.996, -0.025, 0.025, leaf_m, 0.005)]
    paint(lf[0], leaf_in, lambda n, c: n[2] < -0.9)
    # dirt / scuffs (outside lower band, inside lower band)
    lf.append(plane("dirt_out", 0.79, 0.20, (0, 0.11, 0.0258), dirt))
    lf.append(plane("dirt_in", 0.79, 0.12, (0, 0.07, -0.0258), dirt, facing="-z"))
    lf.append(plane("scuff1", 0.07, 0.035, (0.12, 0.16, 0.0262), scuff))
    lf.append(plane("scuff2", 0.05, 0.02, (-0.18, 0.09, 0.0262), scuff))
    lf.append(plane("scuff3", 0.04, 0.03, (0.05, 0.12, -0.0262), scuff, facing="-z"))

    def lever(prefix, x, y, zf, s):
        return [
            cz_(prefix + "rose", 0.027, zf, zf + s * 0.006, x, y, steel, n=16),
            cz_(prefix + "neck", 0.009, zf + s * 0.005, zf + s * 0.032, x, y, steel, n=10),
            bx(prefix + "bar", x - 0.125, x + 0.012, y - 0.009, y + 0.009,
               min(zf + s * 0.030, zf + s * 0.044), max(zf + s * 0.030, zf + s * 0.044), steel, 0.004),
            bx(prefix + "tip", x - 0.128, x - 0.108, y - 0.016, y + 0.009,
               min(zf + s * 0.031, zf + s * 0.043), max(zf + s * 0.031, zf + s * 0.043), steel, 0.004),
        ]

    lf += lever("out_", 0.32, 0.95, 0.025, 1)
    lf += lever("in_", 0.32, 0.95, -0.025, -1)
    # outside: key cylinder, scope, room plate, newspaper slot, stickers
    lf.append(cz_("keycyl", 0.019, 0.025, 0.031, 0.32, 1.10, steel, n=14))
    lf.append(bx("keyhole", 0.3185, 0.3215, 1.092, 1.108, 0.031, 0.0318, dark))
    lf.append(cz_("scope_out", 0.011, 0.025, 0.033, 0.0, 1.45, steel, n=12))
    lf.append(cz_("scope_out_lens", 0.006, 0.033, 0.0336, 0.0, 1.45, lens, n=10))
    lf.append(bx("plate_board", -0.066, 0.066, 1.567, 1.633, 0.025, 0.029, board, 0.0015))
    lf.append(plane("plate", 0.12, 0.06, (0.0, 1.6, 0.0296), tex))
    lf.append(bx("slot_frame", -0.165, 0.165, 0.862, 0.938, 0.025, 0.028, steel, 0.0015))
    lf.append(bx("slot_flap", -0.15, 0.15, 0.874, 0.926, 0.028, 0.031, steel2, 0.0015))
    lf.append(bx("slot_lip", -0.05, 0.05, 0.874, 0.882, 0.031, 0.036, steel, 0.0015))
    lf.append(plane("sticker1", 0.07, 0.035, (-0.12, 1.02, 0.0258), sticker_w))
    lf.append(plane("sticker2", 0.05, 0.035, (0.13, 1.63, 0.0258), sticker_b))
    # inside: scope, newspaper box, thumbturn plate, chain receiver, closer, gas sticker
    lf.append(cz_("scope_in", 0.017, -0.039, -0.025, 0.0, 1.45, steel, n=14))
    lf.append(cz_("scope_in_lens", 0.0095, -0.0396, -0.039, 0.0, 1.45, lens, n=12))
    lf.append(bx("news_box", -0.175, 0.175, 0.82, 0.96, -0.066, -0.025, leaf_in, 0.004))
    lf.append(bx("news_slot", -0.155, 0.155, 0.958, 0.9612, -0.058, -0.035, dark))
    lf.append(bx("tt_plate", 0.300, 0.340, 1.062, 1.138, -0.029, -0.025, steel, 0.003))
    lf.append(bx("chain_rcv", 0.20, 0.33, 1.343, 1.367, -0.031, -0.025, steel, 0.002))
    lf.append(bx("chain_rcv_slot", 0.215, 0.318, 1.3525, 1.3575, -0.0316, -0.031, dark))
    lf.append(bx("closer_body", -0.37, -0.11, 1.900, 1.955, -0.066, -0.025, closer_m, 0.008))
    lf.append(bx("closer_arm", -0.16, 0.06, 1.957, 1.967, -0.058, -0.048, steel2, 0.002))
    lf.append(cy_("closer_pin", 0.009, 1.955, 1.97, -0.15, -0.053, steel2, n=8))
    lf.append(plane("gas_sticker", 0.06, 0.04, (-0.2, 1.62, -0.0258), sticker_w, facing="-z"))
    leaf = part(lf, "leaf", (-0.40, 1.0, 0.0))

    tt = part([bx("tt_knob", 0.303, 0.337, 1.094, 1.106, -0.041, -0.029, steel, 0.003),
               cz_("tt_hub", 0.010, -0.034, -0.029, 0.32, 1.10, steel, n=12)], "thumbturn", (0.32, 1.10, -0.029))
    set_parent(tt, leaf)

    # ── chains (frame side): hooked into the leaf receiver / hanging from the base ──
    def chain(name, pts, knob_at):
        links = []
        for i in range(len(pts) - 1):
            links.append(obox(f"{name}_l{i}", pts[i], pts[i + 1], 0.0075, 0.0026, chain_m, roll=90 * (i % 2)))
        k = Vector(knob_at)
        links.append(cz_(f"{name}_knob", 0.0055, k.z - 0.004, k.z + 0.004, k.x, k.y, chain_m, n=8))
        return grp(links, name)

    a = Vector((0.375, 1.368, -0.05))
    b = Vector((0.222, 1.355, -0.036))
    hooked = []
    for i in range(9):
        t = i / 8
        p = a.lerp(b, t)
        p.y -= 0.014 * math.sin(math.pi * t)
        hooked.append(tuple(p))
    chain("chain_hooked", hooked, (0.222, 1.355, -0.036))
    hanging = [(0.375 - 0.002 * i, 1.368 - 0.021 * i, -0.05 + 0.001 * i) for i in range(10)]
    chain("chain_hanging", hanging, (0.357, 1.168, -0.041))
    return frame


# ═══════════════════════════════════════════════════════════════════════════
#  door_bath  (0.78 x 2.02 x 0.10) — unit bath door, +Z = kitchen side
# ═══════════════════════════════════════════════════════════════════════════
def build_door_bath():
    frame_m = mat("bd_frame", "#d3d3cf", 0.5, 0.2)
    leaf_m = mat("bd_leaf", "#f0efe9", 0.45)
    trim = mat("bd_trim", "#dcdbd5", 0.5)
    glass = mat("glass_frosted", "#dfe6e8", 0.85)
    louver_dark = mat("bd_louver_dark", "#3b3d3f", 0.9)
    chrome = mat("bd_chrome", "#c8cacb", 0.22, 0.9)
    yellowed = mat("bd_yellowed", "#dcd8c6", 0.7)
    smudge = mat("bd_smudge", "#d0cec6", 0.8)
    mold = mat("bd_mold", "#2c2e2a", 0.9)

    fr = [
        bx("jamb_l_in", -0.39, -0.35, 0.0, 2.02, -0.05, 0.0, frame_m, 0.002),
        bx("jamb_l_out", -0.39, -0.37, 0.0, 2.02, 0.0, 0.05, frame_m, 0.002),
        bx("jamb_r", 0.35, 0.39, 0.0, 2.02, -0.05, 0.05, frame_m, 0.002),
        bx("head", -0.39, 0.39, 1.98, 2.02, -0.05, 0.05, frame_m, 0.002),
        bx("sill", -0.35, 0.35, 0.0, 0.035, -0.05, 0.05, frame_m, 0.003),
        bx("stop_r", 0.338, 0.35, 0.035, 1.98, -0.05, -0.017, frame_m),
        bx("stop_h", -0.35, 0.35, 1.968, 1.98, -0.05, -0.017, frame_m),
        bx("strike", 0.346, 0.351, 0.90, 1.0, -0.012, 0.012, chrome),
    ]
    for i, (x, z) in enumerate(((-0.33, -0.045), (0.31, -0.042), (-0.2, -0.047))):
        fr.append(bx(f"mold{i}", x, x + 0.012 + 0.01 * (i % 2), 0.035, 0.0365, z, z + 0.006, mold))
    frame = grp(fr, "frame")

    # leaf panel with a real window hole (upper narrow frosted glass) and a bottom louver
    y0, y1 = 0.04, 1.975
    gx0, gx1, gy0, gy1 = -0.24, 0.24, 1.60, 1.80
    t0, t1 = -0.015, 0.015
    lf = [
        bx("leaf", -0.35, 0.35, y0, gy0, t0, t1, leaf_m, 0.003),
        bx("leaf_top", -0.35, 0.35, gy1, y1, t0, t1, leaf_m, 0.003),
        bx("leaf_wl", -0.35, gx0, gy0, gy1, t0, t1, leaf_m),
        bx("leaf_wr", gx1, 0.35, gy0, gy1, t0, t1, leaf_m),
        bx("glass", gx0, gx1, gy0, gy1, -0.003, 0.003, glass),
    ]
    for s in (1, -1):
        zf = t1 if s > 0 else t0
        z0, z1 = sorted((zf, zf + s * 0.006))
        lf += [bx(f"wtrim_b{s}", gx0 - 0.02, gx1 + 0.02, gy0 - 0.02, gy0, z0, z1, trim, 0.0015),
               bx(f"wtrim_t{s}", gx0 - 0.02, gx1 + 0.02, gy1, gy1 + 0.02, z0, z1, trim, 0.0015),
               bx(f"wtrim_l{s}", gx0 - 0.02, gx0, gy0, gy1, z0, z1, trim),
               bx(f"wtrim_r{s}", gx1, gx1 + 0.02, gy0, gy1, z0, z1, trim)]
        # louver (garari) near the bottom
        lz0, lz1 = sorted((zf, zf + s * 0.0015))
        lf.append(bx(f"louver_bg{s}", -0.24, 0.24, 0.09, 0.23, lz0, lz1, louver_dark))
        for k in range(5):
            yy = 0.105 + k * 0.027
            sz0, sz1 = sorted((zf, zf + s * 0.007))
            lf.append(bx(f"slat{s}_{k}", -0.235, 0.235, yy, yy + 0.012, sz0, sz1, leaf_m))
        fz0, fz1 = sorted((zf, zf + s * 0.008))
        lf += [bx(f"lframe_b{s}", -0.25, 0.25, 0.08, 0.09, fz0, fz1, trim),
               bx(f"lframe_t{s}", -0.25, 0.25, 0.23, 0.24, fz0, fz1, trim),
               bx(f"lframe_l{s}", -0.25, -0.24, 0.09, 0.23, fz0, fz1, trim),
               bx(f"lframe_r{s}", 0.24, 0.25, 0.09, 0.23, fz0, fz1, trim)]
        # round knob
        kz = zf + s * 0.003
        lf.append(cz_(f"rose{s}", 0.028, min(zf, kz), max(zf, kz), 0.28, 0.95, chrome, n=16))
        lf.append(cz_(f"kneck{s}", 0.010, min(zf, zf + s * 0.014), max(zf, zf + s * 0.014), 0.28, 0.95, chrome, n=10))
        lf.append(sphere(f"knob{s}", 0.025, (0.28, 0.95, zf + s * 0.0235), chrome, segs=12, rings=8, scale=(1, 1, 0.48)))
    lf.append(plane("yellow_in", 0.69, 0.06, (0, 0.075, t0 - 0.0008), yellowed, facing="-z"))
    lf.append(plane("smudge_out", 0.08, 0.10, (0.27, 1.0, t1 + 0.0008), smudge))
    lf.append(cz_("lockbtn", 0.0045, -0.0512, -0.0498, 0.28, 0.95, louver_dark, n=8))
    for o in lf:
        if o.name.startswith("knob"):
            smooth_by_angle(o, 60)
    leaf = part(lf, "leaf", (-0.35, 1.0, 0.0))
    return frame, leaf


# ═══════════════════════════════════════════════════════════════════════════
#  door_sliding_glass  (0.86 x 2.00 x 0.08) — pocket sliding door, panel slides into the wall (-x)
# ═══════════════════════════════════════════════════════════════════════════
def build_door_sliding_glass():
    frame_m = mat("sd_frame", "#6f5338", 0.6)
    wood = mat("sd_wood", "#8c6a45", 0.55)
    wood_d = mat("sd_wood_grain", "#7a5a39", 0.6)
    glass = mat("glass_frosted", "#e4e8e6", 0.85)
    pull = mat("sd_pull", "#2a2622", 0.4, 0.6)
    rail = mat("sd_rail", "#3a3632", 0.6, 0.3)

    fr = [
        bx("jamb_r", 0.40, 0.43, 0.0, 2.0, -0.04, 0.04, frame_m, 0.002),
        bx("jamb_l_f", -0.43, -0.40, 0.0, 2.0, 0.02, 0.04, frame_m, 0.002),
        bx("jamb_l_b", -0.43, -0.40, 0.0, 2.0, -0.04, -0.02, frame_m, 0.002),
        bx("head", -0.43, 0.43, 1.96, 2.0, -0.04, 0.04, frame_m, 0.002),
        bx("sill", -0.43, 0.43, 0.0, 0.010, -0.04, 0.04, frame_m, 0.002),
        bx("rail", -0.43, 0.43, 0.010, 0.0115, -0.004, 0.004, rail),
        bx("head_groove", -0.40, 0.40, 1.958, 1.9605, -0.017, 0.017, rail),
    ]
    frame = grp(fr, "frame")

    y0, y1 = 0.012, 1.956
    t0, t1 = -0.015, 0.015
    pn = [
        bx("panel", -0.40, -0.33, y0, y1, t0, t1, wood, 0.002),
        bx("stile_r", 0.33, 0.40, y0, y1, t0, t1, wood, 0.002),
        bx("rail_b", -0.33, 0.33, y0, 0.17, t0, t1, wood, 0.002),
        bx("rail_t", -0.33, 0.33, 1.876, y1, t0, t1, wood, 0.002),
        bx("rail_m", -0.33, 0.33, 0.98, 1.02, t0 + 0.003, t1 - 0.003, wood),
        bx("glass_lo", -0.33, 0.33, 0.17, 0.98, -0.003, 0.003, glass),
        bx("glass_hi", -0.33, 0.33, 1.02, 1.876, -0.003, 0.003, glass),
    ]
    for s in (1, -1):
        zf = t1 if s > 0 else t0
        z0, z1 = sorted((zf, zf + s * 0.004))
        # glazing beads
        for nm, a in (("lo", (0.17, 0.98)), ("hi", (1.02, 1.876))):
            pn += [bx(f"bead_{nm}_b{s}", -0.33, 0.33, a[0], a[0] + 0.012, z0 - s * 0.012, z1 - s * 0.012, wood_d),
                   bx(f"bead_{nm}_t{s}", -0.33, 0.33, a[1] - 0.012, a[1], z0 - s * 0.012, z1 - s * 0.012, wood_d)]
        # grain strips on the stiles
        for k, gx in enumerate((-0.385, -0.352, 0.348, 0.372)):
            pn.append(bx(f"grain{s}_{k}", gx, gx + 0.006, y0 + 0.05, y1 - 0.05, min(zf, zf + s * 0.0008), max(zf, zf + s * 0.0008), wood_d))
        # recessed pull (hikite)
        pz0, pz1 = sorted((zf, zf + s * 0.002))
        pn.append(bx(f"hikite{s}", 0.35, 0.38, 0.88, 1.02, pz0, pz1, pull, 0.001))
        pn.append(bx(f"hikite_in{s}", 0.355, 0.375, 0.89, 1.01, min(zf + s * 0.002, zf + s * 0.0025), max(zf + s * 0.002, zf + s * 0.0025), rail))
    pn.append(bx("edge_pull", 0.40, 0.402, 0.90, 1.0, -0.008, 0.008, pull))
    panel = part(pn, "panel", (0.0, (y0 + y1) / 2, 0.0))
    return frame, panel


# ═══════════════════════════════════════════════════════════════════════════
#  fridge  (0.60 x 1.50 x 0.65) — 2-door, hollow fridge compartment, right hinge door
# ═══════════════════════════════════════════════════════════════════════════
def build_fridge():
    body_m = mat("fr_body", "#d8dad7", 0.35, 0.12)
    door_m = mat("fr_door", "#e0e2df", 0.3, 0.1)
    liner = mat("fr_liner", "#eef1ef", 0.5)
    top_m = mat("fr_top", "#262728", 0.45, 0.15)
    gasket = mat("fr_gasket", "#4b4e50", 0.85)
    shelf_m = mat("fr_shelf", "#c4d3d8", 0.25, 0.05)
    trim = mat("fr_trim", "#f5f6f3", 0.4)
    clear = mat("fr_clear", "#d9e6e8", 0.3)
    metal = mat("fr_metal", "#b9bcbd", 0.35, 0.5)
    dark = mat("fr_dark", "#1e1f21", 0.75)
    yellowed = mat("fr_yellowed", "#c9c8bb", 0.6)
    emit = mat("emit_fridge", "#eef6ff", 0.4, emit="#eef6ff", emit_strength=1.0)
    egg_lid = mat("glass", "#e8f0ee", 0.1)
    # shared food palette (few materials = few draw calls)
    white = mat("food_white", "#f0efe9", 0.6)
    red = mat("food_red", "#c42c2a", 0.45)
    blue = mat("food_blue", "#3f74c4", 0.5)
    yellow = mat("food_yellow", "#e2c044", 0.5)
    green = mat("food_green", "#6fa060", 0.4)
    brown = mat("food_brown", "#7a4a1f", 0.3)
    darkbr = mat("food_dark", "#2a1c15", 0.35)
    cream = mat("food_cream", "#efe6c4", 0.6)
    egg = mat("food_egg", "#e9d9bf", 0.6)
    aqua = mat("food_aqua", "#b4d3e1", 0.25)

    def can(nm, x, y, z, r=0.033, h=0.122):
        rg = [sring(x, y, z, r * 0.9, r * 0.9, 10), sring(x, y + 0.008, z, r, r, 10), sring(x, y + 0.03, z, r, r, 10),
              sring(x, y + 0.095, z, r, r, 10), sring(x, y + h - 0.008, z, r, r, 10), sring(x, y + h, z, r * 0.85, r * 0.85, 10)]
        return loft(nm, rg, [metal, yellow], band=[0, 0, 1, 0, 0], cap0=0, cap1=0, smooth=True, sharp=40)

    def bottle(nm, x, z, r, h, body, cap, label, yb):
        rg = [sring(x, yb, z, r, r, 8), sring(x, yb + h * 0.35, z, r, r, 8), sring(x, yb + h * 0.6, z, r, r, 8),
              sring(x, yb + h * 0.78, z, r, r, 8), sring(x, yb + h * 0.9, z, r * 0.42, r * 0.42, 8),
              sring(x, yb + h * 0.9, z, r * 0.45, r * 0.45, 8), sring(x, yb + h, z, r * 0.45, r * 0.45, 8)]
        return loft(nm, rg, [body, label, cap], band=[0, 1, 0, 0, 2, 2], cap0=0, cap1=2, smooth=True, sharp=50)

    # ── body shell, open at the front (fridge + freezer compartments) ──
    sh = []
    wl = bx("wall_l", -0.30, -0.26, 0.0, 1.42, -0.325, 0.27, body_m, 0.006)
    paint(wl, liner, lambda n, c: n[0] > 0.9)
    wr = bx("wall_r", 0.26, 0.30, 0.0, 1.42, -0.325, 0.27, body_m, 0.006)
    paint(wr, liner, lambda n, c: n[0] < -0.9)
    top = bx("top", -0.30, 0.30, 1.42, 1.50, -0.325, 0.27, body_m, 0.006)
    paint(top, liner, lambda n, c: n[1] < -0.9)
    paint(top, top_m, lambda n, c: n[1] > 0.5)
    back = bx("back", -0.26, 0.26, 0.0, 1.42, -0.325, -0.28, body_m)
    paint(back, liner, lambda n, c: n[2] > 0.9)
    div = bx("divider", -0.26, 0.26, 0.50, 0.55, -0.28, 0.27, body_m)
    paint(div, liner, lambda n, c: abs(n[1]) > 0.9)
    flo = bx("freezer_floor", -0.26, 0.26, 0.035, 0.065, -0.28, 0.27, body_m)
    paint(flo, liner, lambda n, c: n[1] > 0.9)
    sh += [wl, wr, top, back, div, flo, bx("base", -0.26, 0.26, 0.0, 0.035, -0.28, 0.225, dark),
           bx("grille", -0.26, 0.26, 0.0, 0.035, 0.225, 0.262, gasket)]
    for k in range(5):
        sh.append(bx(f"grille_slot{k}", -0.24 + k * 0.1, -0.17 + k * 0.1, 0.012, 0.022, 0.262, 0.2635, dark))
    sh.append(plane("side_dirt_l", 0.6, 0.10, (-0.3012, 0.06, -0.03), yellowed, facing="-x"))
    sh.append(plane("side_dirt_r", 0.6, 0.08, (0.3012, 0.05, -0.03), yellowed, facing="x"))
    # interior: shelves on rails, light panel, temperature dial
    for i, sy in enumerate((0.85, 1.15)):
        sh.append(bx(f"shelf{i}", -0.256, 0.256, sy - 0.008, sy, -0.278, 0.16, shelf_m))
        sh.append(bx(f"shelf_trim{i}", -0.257, 0.257, sy - 0.024, sy + 0.004, 0.156, 0.172, trim, 0.003))
        sh.append(bx(f"rail_l{i}", -0.26, -0.252, sy - 0.018, sy - 0.008, -0.27, 0.15, liner))
        sh.append(bx(f"rail_r{i}", 0.252, 0.26, sy - 0.018, sy - 0.008, -0.27, 0.15, liner))
    for i, ry in enumerate((0.70, 1.00)):
        sh.append(bx(f"rib_l{i}", -0.26, -0.254, ry, ry + 0.008, -0.27, 0.15, liner))
        sh.append(bx(f"rib_r{i}", 0.254, 0.26, ry, ry + 0.008, -0.27, 0.15, liner))
    sh.append(bx("lamp", -0.085, 0.085, 1.404, 1.42, 0.02, 0.135, emit, 0.003))
    sh.append(bx("lamp_rim", -0.095, 0.095, 1.414, 1.42, 0.01, 0.145, trim))
    sh.append(bx("dial_box", 0.15, 0.255, 1.36, 1.42, -0.06, 0.11, trim))
    sh.append(cz_("dial", 0.016, 0.11, 0.118, 0.205, 1.39, metal, n=10))
    sh.append(bx("dial_mark", 0.2035, 0.2065, 1.39, 1.404, 0.118, 0.1195, dark))
    sh.append(bx("drain_hole", -0.02, 0.02, 0.551, 0.553, -0.27, -0.24, dark))

    # ── food, bottom compartment (floor 0.55): milk, tupperware, a fallen can ──
    f = [bx("milk", -0.205, -0.135, 0.55, 0.745, -0.17, -0.10, white),
         bx("milk_band", -0.2055, -0.1345, 0.62, 0.70, -0.1705, -0.0995, blue),
         mk("milk_gable", [(-0.205, 0.745, -0.17), (-0.135, 0.745, -0.17), (-0.135, 0.745, -0.10), (-0.205, 0.745, -0.10),
                           (-0.205, 0.775, -0.135), (-0.135, 0.775, -0.135)],
            [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (0, 4, 3)], white),
         bx("milk_fin", -0.205, -0.135, 0.775, 0.79, -0.137, -0.133, white),
         bx("tup1", -0.02, 0.15, 0.55, 0.60, -0.23, -0.10, clear, 0.006),
         bx("tup1_lid", -0.022, 0.152, 0.60, 0.612, -0.232, -0.098, blue),
         bx("tup1_food", -0.012, 0.142, 0.585, 0.5995, -0.222, -0.108, brown),
         bx("tup2", 0.0, 0.13, 0.612, 0.652, -0.21, -0.12, clear, 0.006),
         bx("tup2_lid", -0.002, 0.132, 0.652, 0.662, -0.212, -0.118, green)]
    lying = can("can_lying", 0.0, 0.0, 0.0)
    xform(lying, rot=[("z", 90), ("y", 12)], move=(0.19, 0.583, 0.07))
    f.append(lying)

    # ── middle compartment (shelf 0.85): 6-egg pack (clear lid), the flashlight node, barley tea ──
    f.append(bx("egg_case", -0.205, -0.105, 0.85, 0.858, -0.13, 0.03, white))
    for r in range(3):
        for cc in range(2):
            f.append(sphere(f"egg{r}{cc}", 0.021, (-0.18 + cc * 0.05, 0.878, -0.10 + r * 0.05), egg, segs=8, rings=5, scale=(1, 1.22, 1)))
    f.append(bx("egg_lid", -0.207, -0.103, 0.858, 0.906, -0.132, 0.032, egg_lid))
    f.append(cy_("mugicha", 0.046, 0.85, 1.02, 0.19, -0.17, brown, n=12))
    f.append(cy_("pitcher_top", 0.046, 1.02, 1.075, 0.19, -0.17, aqua, n=12, cap=False))
    f.append(cy_("pitcher_lid", 0.049, 1.075, 1.10, 0.19, -0.17, red, n=12, r2=0.044))
    f.append(bx("pitcher_handle", 0.232, 0.244, 0.93, 1.05, -0.18, -0.16, aqua))

    # ── top compartment (shelf 1.15): cans, mayo, natto — centre kept clear for the face ──
    f.append(can("beer0", -0.205, 1.15, 0.07))
    f.append(can("beer1", -0.205, 1.15, -0.05))
    f.append(cz_("mayo", 0.026, -0.14, 0.03, 0.205, 1.176, cream, n=10, r2=0.024))
    f.append(cz_("mayo_cap", 0.016, 0.03, 0.06, 0.205, 1.176, red, n=8, r2=0.008))
    for k in range(3):
        f.append(bx(f"natto{k}", 0.155, 0.245, 1.15 + k * 0.026, 1.174 + k * 0.026, -0.25, -0.17, white if k != 1 else yellow))
    for o in f:
        if o.name.startswith(("egg", "mugicha", "pitcher", "mayo")):
            smooth_by_angle(o, 40)
    body = grp(sh + f, "body")

    # flashlight node lying on the middle shelf (x=+0.12, y=0.87, z=+0.05): simple version of `flashlight`
    silver = mat("fl_silver", "#b9bbbd", 0.3, 0.55)
    black = mat("fl_black", "#1b1b1d", 0.55, 0.1)
    orange = mat("fl_switch", "#d4692a", 0.5)
    lens = mat("fr_fl_lens", "#d3d6cf", 0.2, 0.1)
    fl = [loft("ff_head", [[(math.cos(a) * 0.0245, math.sin(a) * 0.0245, -0.1) for a in [2 * math.pi * k / 12 for k in range(12)]],
                           [(math.cos(a) * 0.019, math.sin(a) * 0.019, -0.05) for a in [2 * math.pi * k / 12 for k in range(12)]],
                           [(math.cos(a) * 0.0172, math.sin(a) * 0.0172, -0.04) for a in [2 * math.pi * k / 12 for k in range(12)]]],
                  [silver, lens], cap0=1, smooth=True, sharp=40),
          cz_("ff_body", 0.017, -0.041, 0.079, 0, 0, black, n=12),
          cz_("ff_knurl0", 0.0179, 0.0, 0.008, 0, 0, gasket, n=12, cap=False),
          cz_("ff_knurl1", 0.0179, 0.03, 0.038, 0, 0, gasket, n=12, cap=False),
          bx("ff_slider", -0.0045, 0.0045, 0.0165, 0.0225, -0.03, -0.018, orange),
          cz_("ff_tail", 0.0184, 0.078, 0.1, 0, 0, silver, n=12)]
    for o in fl:
        smooth_by_angle(o, 40)
    fl = grp(fl, "flashlight_in_fridge")
    xform(fl, rot=[("x", 2.2), ("y", 78)], move=(0.12, 0.8724, 0.05))
    set_origin(fl, (0.12, 0.8724, 0.05))

    # ── door (right hinge at x=+0.30, z=+0.325) ──
    d = [bx("door_slab", -0.30, 0.30, 0.515, 1.495, 0.275, 0.325, door_m, 0.008),
         bx("door_liner", -0.255, 0.255, 0.56, 1.41, 0.262, 0.276, liner),
         bx("gsk_l", -0.292, -0.262, 0.522, 1.488, 0.268, 0.2755, gasket),
         bx("gsk_r", 0.262, 0.292, 0.522, 1.488, 0.268, 0.2755, gasket),
         bx("gsk_b", -0.262, 0.262, 0.522, 0.552, 0.268, 0.2755, gasket),
         bx("gsk_t", -0.262, 0.262, 1.418, 1.488, 0.268, 0.2755, gasket),
         bx("door_handle", -0.292, -0.274, 0.80, 1.16, 0.325, 0.337, metal, 0.004),
         plane("door_yellow", 0.59, 0.05, (0, 0.545, 0.3258), yellowed)]
    # Nao's memo held by a magnet, and a delivery flyer
    memo_p = plane("memo", 0.085, 0.11, (-0.09, 1.22, 0.3262), cream)
    xform(memo_p, rot=[("z", 4)], pivot=(-0.09, 1.22, 0.3262))
    d.append(memo_p)
    for k in range(4):
        ln = plane(f"memo_line{k}", 0.055 - 0.01 * (k % 2), 0.004, (-0.093, 1.245 - k * 0.018, 0.3266), blue)
        xform(ln, rot=[("z", 4)], pivot=(-0.09, 1.22, 0.3262))
        d.append(ln)
    d.append(cz_("magnet1", 0.012, 0.325, 0.334, -0.087, 1.272, red, n=10))
    fl1 = plane("flyer", 0.10, 0.14, (0.12, 1.02, 0.3262), red)
    xform(fl1, rot=[("z", -6)], pivot=(0.12, 1.02, 0.3262))
    d.append(fl1)
    fl2 = plane("flyer_band", 0.09, 0.03, (0.123, 1.04, 0.3266), yellow)
    xform(fl2, rot=[("z", -6)], pivot=(0.12, 1.02, 0.3262))
    d.append(fl2)
    d.append(cz_("magnet2", 0.011, 0.325, 0.333, 0.115, 1.085, blue, n=10))

    def pocket(px, y0, h):
        return [bx(px + "_bot", -0.245, 0.245, y0, y0 + 0.008, 0.196, 0.262, clear),
                bx(px + "_front", -0.245, 0.245, y0, y0 + h, 0.196, 0.204, clear),
                bx(px + "_rim", -0.246, 0.246, y0 + h - 0.008, y0 + h, 0.195, 0.205, trim),
                bx(px + "_l", -0.245, -0.237, y0, y0 + h * 0.85, 0.196, 0.262, clear),
                bx(px + "_r", 0.237, 0.245, y0, y0 + h * 0.85, 0.196, 0.262, clear)]

    d += pocket("pk1", 0.585, 0.085) + pocket("pk2", 0.94, 0.06) + pocket("pk3", 1.25, 0.05)
    # bottom pocket: PET bottles (green tea, water, cola)
    d.append(bottle("pet_tea", -0.17, 0.232, 0.031, 0.20, green, white, darkbr, 0.593))
    d.append(bottle("pet_water", -0.06, 0.232, 0.035, 0.29, aqua, blue, white, 0.593))
    d.append(bottle("pet_cola", 0.07, 0.232, 0.031, 0.20, darkbr, red, red, 0.593))
    # middle pocket: condiments
    d.append(cy_("soy", 0.022, 0.948, 1.10, 0.15, 0.229, darkbr, n=8))
    d.append(cy_("soy_cap", 0.013, 1.10, 1.122, 0.15, 0.229, red, n=8))
    d.append(cy_("mayo_d", 0.024, 0.948, 1.09, 0.20, 0.232, cream, n=8, r2=0.026))
    d.append(cy_("mayo_d_cap", 0.016, 1.09, 1.115, 0.20, 0.232, red, n=8, r2=0.008))
    d.append(cy_("ketchup", 0.024, 0.948, 1.08, -0.19, 0.230, red, n=8))
    d.append(cy_("ketchup_cap", 0.017, 1.08, 1.10, -0.19, 0.230, white, n=8))
    # top pocket: butter
    d.append(bx("butter", -0.20, -0.08, 1.258, 1.30, 0.205, 0.255, yellow))
    d.append(bx("butter_band", -0.2005, -0.0795, 1.27, 1.282, 0.2045, 0.2555, white))
    for o in d:
        if o.name.startswith(("soy", "mayo", "ketchup", "magnet")):
            smooth_by_angle(o, 40)
    part(d, "door", (0.30, 1.0, 0.325))

    # ── freezer drawer (slideZ) ──
    dr = [bx("drawer_front", -0.30, 0.30, 0.04, 0.505, 0.275, 0.325, door_m, 0.008),
          bx("drawer_handle", -0.20, 0.20, 0.476, 0.497, 0.325, 0.337, metal, 0.005),
          bx("drawer_gasket", -0.29, 0.29, 0.05, 0.495, 0.268, 0.2752, gasket),
          bx("bin_bot", -0.25, 0.25, 0.07, 0.078, -0.25, 0.268, clear),
          bx("bin_l", -0.25, -0.242, 0.07, 0.42, -0.25, 0.268, clear),
          bx("bin_r", 0.242, 0.25, 0.07, 0.42, -0.25, 0.268, clear),
          bx("bin_back", -0.25, 0.25, 0.07, 0.42, -0.25, -0.242, clear),
          bx("gyoza", -0.22, -0.02, 0.078, 0.108, -0.21, 0.05, white),
          bx("gyoza_band", -0.2205, -0.0195, 0.09, 0.1, -0.2105, 0.0505, red),
          bx("ice_tray", 0.02, 0.22, 0.078, 0.11, -0.22, 0.03, aqua),
          bx("rice1", -0.20, -0.10, 0.108, 0.135, 0.07, 0.17, white),
          bx("rice2", -0.08, 0.02, 0.078, 0.105, 0.08, 0.18, white),
          cy_("icecream", 0.04, 0.078, 0.14, 0.14, 0.13, yellow, n=10, r2=0.045),
          cy_("icecream_lid", 0.046, 0.14, 0.146, 0.14, 0.13, white, n=10)]
    part(dr, "drawer", (0.0, 0.27, 0.30))
    return body


# ═══════════════════════════════════════════════════════════════════════════
#  microwave  (0.46 x 0.28 x 0.34)
# ═══════════════════════════════════════════════════════════════════════════
def build_microwave():
    body = mat("mw_body", "#e9e9e4", 0.4)
    door = mat("mw_door", "#f0f0eb", 0.35)
    panel_m = mat("mw_panel", "#d6d6d1", 0.45)
    win = mat("mw_window", "#17191b", 0.12, 0.3)
    shine = mat("mw_shine", "#3a3f44", 0.1, 0.3)
    dark = mat("mw_dark", "#121314", 0.5)
    btn = mat("mw_button", "#bdbdb8", 0.5)
    start = mat("mw_start", "#e39a55", 0.45)
    knob = mat("mw_knob", "#cdcdc8", 0.35, 0.2)
    feet = mat("mw_feet", "#2a2a2a", 0.8)
    disp = mat("emit_mw_display", "#7dffb6", 0.4, emit="#7dffb6", emit_strength=1.0)
    grease = mat("mw_grease", "#d3cdbb", 0.7)
    o = [bx("case", -0.23, 0.23, 0.012, 0.28, -0.17, 0.152, body, 0.012)]
    o.append(bx("door", -0.226, 0.092, 0.018, 0.274, 0.152, 0.166, door, 0.004))
    o.append(bx("window", -0.19, 0.058, 0.058, 0.236, 0.166, 0.1685, win, 0.002))
    o.append(quad("shine", (-0.10, 0.19, 0.1688), (1, 0.55, 0), (-0.55, 1, 0), 0.008, 0.11, shine))
    o.append(bx("handle", 0.066, 0.086, 0.06, 0.236, 0.166, 0.178, knob, 0.004))
    o.append(bx("panel", 0.096, 0.226, 0.018, 0.274, 0.152, 0.163, panel_m, 0.003))
    o.append(bx("bezel", 0.111, 0.211, 0.218, 0.256, 0.163, 0.1648, dark))
    o.append(plane("display", 0.09, 0.03, (0.161, 0.237, 0.1653), disp))
    for k, xx in enumerate((0.125, 0.161, 0.197)):
        o.append(bx(f"btn{k}", xx - 0.014, xx + 0.014, 0.191, 0.204, 0.163, 0.1665, btn, 0.0015))
    o.append(cz_("dial", 0.026, 0.163, 0.176, 0.161, 0.135, knob, n=16))
    o.append(bx("dial_ptr", 0.1595, 0.1625, 0.137, 0.158, 0.176, 0.1768, dark))
    o.append(bx("start", 0.118, 0.204, 0.040, 0.076, 0.163, 0.169, start, 0.003))
    for i, (fx, fz) in enumerate(((-0.19, -0.13), (0.19, -0.13), (-0.19, 0.12), (0.19, 0.12))):
        o.append(cy_(f"foot{i}", 0.012, 0.0, 0.013, fx, fz, feet, n=8))
    for k in range(7):
        zz = -0.13 + k * 0.022
        o.append(bx(f"vent_l{k}", -0.2312, -0.2295, 0.15, 0.245, zz, zz + 0.008, dark))
    for k in range(9):
        xx = -0.16 + k * 0.035
        o.append(bx(f"vent_t{k}", xx, xx + 0.012, 0.2795, 0.2808, -0.15, -0.09, dark))
    o.append(plane("grease", 0.2, 0.06, (-0.06, 0.2806, 0.07), grease, facing="y"))
    return grp(o, "microwave")


# ═══════════════════════════════════════════════════════════════════════════
#  kitchen_counter  (1.60 x 0.92 x 0.62) — sink left, IH right, drawer under the IH
# ═══════════════════════════════════════════════════════════════════════════
def build_kitchen_counter():
    steel = mat("kc_steel", "#b5b9bc", 0.3, 0.75)
    sink_m = mat("kc_sink", "#9ea3a7", 0.35, 0.7)
    chrome = mat("kc_chrome", "#d2d5d7", 0.18, 0.9)
    dark = mat("kc_dark", "#232527", 0.6)
    cab = mat("kc_cabinet", "#cbb48f", 0.6)
    cab_in = mat("kc_cabinet_in", "#8f877a", 0.8)
    door_m = mat("kc_door", "#d7c4a2", 0.55)
    door_stain = mat("kc_door_stain", "#b7a283", 0.7)
    kick = mat("kc_black", "#1c1c1e", 0.5)
    handle = mat("kc_chrome", "#d2d5d7", 0.18, 0.9)
    ih = mat("kc_ih", "#121314", 0.15, 0.1)
    ih_ring = mat("kc_ih_ring", "#7c7f82", 0.4)
    ih_btn = mat("kc_kettle_grey", "#7f8285", 0.4, 0.3)
    led = mat("kc_cup_red", "#c22a2d", 0.5)
    o = []
    # countertop with a rectangular hole for the sink
    o += [bx("top_back", -0.80, 0.80, 0.82, 0.85, -0.31, -0.17, steel),
          bx("top_front", -0.80, 0.80, 0.82, 0.85, 0.19, 0.31, steel),
          bx("top_left", -0.80, -0.74, 0.82, 0.85, -0.17, 0.19, steel),
          bx("top_mid", -0.28, 0.80, 0.82, 0.85, -0.17, 0.19, steel),
          bx("lip", -0.80, 0.80, 0.795, 0.85, 0.30, 0.31, steel, 0.002),
          bx("splash", -0.80, 0.80, 0.85, 0.92, -0.31, -0.295, steel, 0.002),
          bx("splash_seal", -0.80, 0.80, 0.85, 0.854, -0.295, -0.289, dark)]
    # sink basin (rect top flush with the hole, rounded bottom)
    n = 32
    cxs, czs = -0.51, 0.01
    o.append(loft("sink", [rect_ring(cxs, 0.85, czs, 0.23, 0.18, n),
                           sring(cxs, 0.83, czs, 0.228, 0.178, n, 7),
                           sring(cxs, 0.70, czs, 0.215, 0.165, n, 6),
                           sring(cxs, 0.685, czs, 0.20, 0.15, n, 5)],
                  [sink_m], cap1=0, smooth=True, sharp=50))
    o.append(cy_("drain_ring", 0.050, 0.684, 0.687, -0.51, -0.03, chrome, n=16))
    o.append(cy_("drain_hole", 0.040, 0.685, 0.6885, -0.51, -0.03, dark, n=16))
    o.append(cy_("drain_basket", 0.026, 0.686, 0.690, -0.51, -0.03, sink_m, n=12))
    # faucet (single lever) on the deck behind the sink
    fx, fz = -0.51, -0.235
    o.append(cy_("fau_base", 0.026, 0.85, 0.862, fx, fz, chrome, n=14))
    o.append(cy_("fau_body", 0.018, 0.862, 0.935, fx, fz, chrome, n=14))
    o.append(cy_("fau_cap", 0.019, 0.935, 0.942, fx, fz, chrome, n=14, r2=0.012))
    o.append(obox("fau_lever", (fx, 0.938, fz + 0.005), (fx, 0.951, fz + 0.07), 0.016, 0.008, chrome))
    o.append(tube("fau_spout", [(fx, 0.912, fz + 0.012), (fx, 0.916, fz + 0.07), (fx, 0.912, fz + 0.13), (fx, 0.896, fz + 0.16)], 0.0105, chrome, seg=8))
    o.append(cy_("fau_tip", 0.012, 0.884, 0.896, fx, fz + 0.162, chrome, n=10))
    # IH (one burner)
    o.append(bx("ih", 0.18, 0.62, 0.85, 0.858, -0.22, 0.20, ih, 0.003))
    o.append(loft("ih_ring", [sring(0.40, 0.8585, -0.03, 0.105, 0.105, 32), sring(0.40, 0.8585, -0.03, 0.095, 0.095, 32)],
                  [ih_ring], smooth=False))
    for k, xx in enumerate((0.33, 0.39, 0.45)):
        o.append(bx(f"ih_btn{k}", xx, xx + 0.035, 0.858, 0.8592, 0.155, 0.175, ih_btn))
    o.append(cy_("ih_led", 0.004, 0.858, 0.8594, 0.53, 0.165, led, n=8))
    # cabinet
    o += [bx("cab_l", -0.80, -0.782, 0.0, 0.82, -0.31, 0.28, cab),
          bx("cab_r", 0.782, 0.80, 0.0, 0.82, -0.31, 0.28, cab),
          bx("cab_back", -0.782, 0.782, 0.08, 0.82, -0.31, -0.295, cab_in),
          bx("cab_bottom", -0.782, 0.782, 0.08, 0.098, -0.295, 0.28, cab_in),
          bx("cab_div", -0.009, 0.009, 0.098, 0.82, -0.295, 0.28, cab_in),
          bx("cab_shelf", 0.009, 0.782, 0.598, 0.61, -0.295, 0.28, cab_in),
          bx("cab_rail", -0.782, 0.782, 0.795, 0.82, 0.26, 0.28, cab_in),
          bx("kick", -0.782, 0.782, 0.0, 0.08, 0.20, 0.22, kick)]
    o += [bx("door_l1", -0.79, -0.403, 0.09, 0.79, 0.28, 0.298, door_m, 0.004),
          bx("door_l2", -0.397, -0.01, 0.09, 0.79, 0.28, 0.298, door_m, 0.004),
          bx("door_r", 0.01, 0.79, 0.09, 0.59, 0.28, 0.298, door_m, 0.004),
          bx("hdl_l1", -0.428, -0.418, 0.64, 0.76, 0.298, 0.312, handle, 0.003),
          bx("hdl_l2", -0.382, -0.372, 0.64, 0.76, 0.298, 0.312, handle, 0.003),
          bx("hdl_r", 0.32, 0.48, 0.545, 0.555, 0.298, 0.312, handle, 0.003),
          plane("stain_l", 0.25, 0.07, (-0.6, 0.13, 0.2985), door_stain),
          plane("stain_r", 0.12, 0.04, (0.62, 0.11, 0.2985), door_stain)]
    # ── items (kept low: the model is 0.92 tall) ──
    kettle_w = mat("kc_dish", "#f0efe9", 0.3)
    kettle_g = mat("kc_kettle_grey", "#7f8285", 0.4, 0.3)
    black = mat("kc_black", "#1c1c1e", 0.5)
    o += [cy_("ket_base", 0.072, 0.85, 0.862, 0.71, -0.16, black, n=16),
          cy_("ket_body", 0.068, 0.862, 0.945, 0.71, -0.16, kettle_w, n=16, r2=0.058),
          cy_("ket_lid", 0.05, 0.945, 0.953, 0.71, -0.16, kettle_g, n=14),
          bx("ket_knob", 0.70, 0.72, 0.953, 0.962, -0.175, -0.145, black, 0.003),
          bx("ket_handle", 0.695, 0.725, 0.875, 0.945, -0.24, -0.226, black, 0.004),
          bx("ket_handle_t", 0.695, 0.725, 0.932, 0.946, -0.236, -0.205, black, 0.003),
          obox("ket_spout", (0.71, 0.925, -0.098), (0.71, 0.94, -0.078), 0.022, 0.014, kettle_w)]
    cup = mat("kc_dish", "#f0efe9", 0.3)
    cup_red = mat("kc_cup_red", "#c22a2d", 0.5)
    lid = mat("kc_mug", "#d7c49a", 0.4)
    o += [cy_("cup", 0.040, 0.85, 0.948, 0.71, 0.13, cup, n=14, r2=0.048),
          cy_("cup_band", 0.0445, 0.89, 0.915, 0.71, 0.13, cup_red, n=14, r2=0.0466),
          cy_("cup_lid", 0.049, 0.948, 0.951, 0.71, 0.13, lid, n=14)]
    det = mat("kc_detergent", "#a3c94f", 0.3)
    det_cap = mat("kc_cup_red", "#c22a2d", 0.5)
    sponge_y = mat("kc_sponge_y", "#e9cf3d", 0.9)
    sponge_g = mat("kc_detergent", "#a3c94f", 0.3)
    o += [bx("detergent", -0.71, -0.655, 0.85, 0.948, -0.262, -0.226, det, 0.012),
          cy_("det_cap", 0.011, 0.948, 0.962, -0.6825, -0.244, det_cap, n=10),
          bx("sponge_y", -0.64, -0.55, 0.85, 0.868, -0.27, -0.215, sponge_y, 0.004),
          bx("sponge_g", -0.64, -0.55, 0.868, 0.878, -0.27, -0.215, sponge_g, 0.003)]
    # drying rack with a few dishes
    tray = mat("kc_dish", "#f0efe9", 0.3)
    wire = mat("kc_chrome", "#d2d5d7", 0.18, 0.9)
    dish = mat("kc_dish", "#f0efe9", 0.3)
    dish_b = mat("kc_dish_blue", "#bfd0de", 0.3)
    bowl = mat("kc_bowl", "#7a4d3a", 0.35)
    mug = mat("kc_mug", "#d7c49a", 0.4)
    chop = mat("kc_bowl", "#7a4d3a", 0.35)
    rx0, rx1, rz0, rz1 = -0.215, 0.10, -0.175, 0.125
    o.append(bx("rack_tray", rx0, rx1, 0.85, 0.862, rz0, rz1, tray, 0.004))
    o.append(bx("rack_spout", rx0 - 0.02, rx0, 0.852, 0.858, 0.06, 0.09, tray))
    for yy in (0.868, 0.912):
        o += [bx(f"rw_f{yy}", rx0 + 0.005, rx1 - 0.005, yy, yy + 0.004, rz1 - 0.009, rz1 - 0.005, wire),
              bx(f"rw_b{yy}", rx0 + 0.005, rx1 - 0.005, yy, yy + 0.004, rz0 + 0.005, rz0 + 0.009, wire),
              bx(f"rw_l{yy}", rx0 + 0.005, rx0 + 0.009, yy, yy + 0.004, rz0 + 0.005, rz1 - 0.005, wire),
              bx(f"rw_r{yy}", rx1 - 0.009, rx1 - 0.005, yy, yy + 0.004, rz0 + 0.005, rz1 - 0.005, wire)]
    for k in range(7):
        xx = rx0 + 0.01 + k * (rx1 - rx0 - 0.02) / 6
        o.append(bx(f"rw_vf{k}", xx - 0.002, xx + 0.002, 0.862, 0.914, rz1 - 0.009, rz1 - 0.005, wire))
        o.append(bx(f"rw_vb{k}", xx - 0.002, xx + 0.002, 0.862, 0.914, rz0 + 0.005, rz0 + 0.009, wire))
    for k in range(5):
        zz = rz0 + 0.01 + k * (rz1 - rz0 - 0.02) / 4
        o.append(bx(f"rw_vl{k}", rx0 + 0.005, rx0 + 0.009, 0.862, 0.914, zz - 0.002, zz + 0.002, wire))
        o.append(bx(f"rw_vr{k}", rx1 - 0.009, rx1 - 0.005, 0.862, 0.914, zz - 0.002, zz + 0.002, wire))
    o.append(cy_("plate1", 0.085, 0.866, 0.878, -0.10, -0.03, dish, n=18, r2=0.088))
    o.append(cy_("plate2", 0.075, 0.878, 0.888, -0.105, -0.035, dish_b, n=18, r2=0.078))
    o.append(cy_("chawan", 0.055, 0.866, 0.912, 0.035, -0.09, bowl, n=14, r2=0.03))
    o.append(cy_("chawan_foot", 0.026, 0.912, 0.92, 0.035, -0.09, bowl, n=12))
    o.append(cy_("mug", 0.038, 0.866, 0.95, 0.045, 0.06, mug, n=14))
    o.append(cy_("mug_in", 0.033, 0.947, 0.9505, 0.045, 0.06, dark, n=14))
    o.append(obox("mug_handle", (0.085, 0.885, 0.06), (0.085, 0.93, 0.06), 0.012, 0.008, mug))
    o.append(obox("chop1", (-0.20, 0.915, 0.10), (0.03, 0.918, 0.07), 0.006, 0.006, chop))
    o.append(obox("chop2", (-0.20, 0.915, 0.108), (0.03, 0.919, 0.08), 0.006, 0.006, chop))
    for ob in o:
        if ob.name.startswith(("ket_", "cup", "det_cap", "plate", "chawan", "mug", "fau_")):
            smooth_by_angle(ob, 40)
    body = grp(o, "counter")

    # drawer under the IH (pivot = drawer centre)
    bin_m = mat("kc_drawer_in", "#e2ddd2", 0.7)
    dr = [bx("drawer_front", 0.01, 0.79, 0.615, 0.785, 0.28, 0.298, door_m, 0.004),
          bx("drawer_handle", 0.32, 0.48, 0.695, 0.705, 0.298, 0.312, handle, 0.003),
          bx("dbin_bot", 0.03, 0.77, 0.62, 0.628, -0.24, 0.28, bin_m),
          bx("dbin_l", 0.03, 0.04, 0.62, 0.755, -0.24, 0.28, bin_m),
          bx("dbin_r", 0.76, 0.77, 0.62, 0.755, -0.24, 0.28, bin_m),
          bx("dbin_back", 0.03, 0.77, 0.62, 0.755, -0.24, -0.23, bin_m),
          bx("dbin_sheet", 0.05, 0.75, 0.628, 0.6285, -0.225, 0.27, mat("kc_drawer_sheet", "#b9c7c0", 0.8))]
    part(dr, "drawer", (0.4, 0.7, 0.289))
    return body


# ═══════════════════════════════════════════════════════════════════════════
#  washer  (0.60 x 0.98 x 0.60) — top loader, lid hinged at the back
# ═══════════════════════════════════════════════════════════════════════════
def build_washer():
    white = mat("wa_body", "#e7e8e4", 0.4)
    tub = mat("wa_tub", "#a9aeb2", 0.3, 0.7)
    tub_rim = mat("wa_tub_rim", "#e2e4e4", 0.4)
    hole = mat("wa_tub_hole", "#3b3f42", 0.8)
    puls = mat("wa_pulsator", "#d4d7d8", 0.4)
    base_m = mat("wa_base", "#55585b", 0.7)
    lid_m = mat("wa_lid", "#eceeed", 0.35)
    glass = mat("glass", "#9fb4bd", 0.05)
    panel_face = mat("wa_panel_face", "#c9cdd0", 0.4)
    disp = mat("wa_display", "#1d2a26", 0.3)
    b_red = mat("wa_btn_power", "#c84a3a", 0.5)
    b_blue = mat("wa_btn_start", "#3f6fb2", 0.5)
    b_grey = mat("wa_btn", "#9a9ea2", 0.5)
    dust = mat("wa_dust", "#cfcfc8", 0.8)
    label = mat("wa_label", "#b9bcbe", 0.4, 0.5)
    n = 32
    rings = [sring(0, 0.045, 0, 0.29, 0.29, n, 6), sring(0, 0.06, 0, 0.30, 0.30, n, 6),
             sring(0, 0.90, 0, 0.30, 0.30, n, 6), sring(0, 0.92, 0, 0.288, 0.288, n, 6),
             sring(0, 0.92, 0, 0.226, 0.226, n, 2), sring(0, 0.914, 0, 0.214, 0.214, n, 2),
             sring(0, 0.89, 0, 0.214, 0.214, n, 2), sring(0, 0.875, 0, 0.22, 0.22, n, 2),
             sring(0, 0.42, 0, 0.22, 0.22, n, 2), sring(0, 0.40, 0, 0.20, 0.20, n, 2)]
    # bands: 0 bottom bevel, 1 side, 2 top bevel, 3 top deck, 4 lip, 5 balancer, 6 rim->tub, 7 tub wall, 8 tub floor edge
    body = loft("washer_shell", rings, [white, tub, tub_rim], band=[0, 0, 0, 0, 2, 2, 2, 1, 1], cap1=1, smooth=True, sharp=40)
    o = [body]
    o.append(bx("base", -0.28, 0.28, 0.0, 0.046, -0.28, 0.28, base_m))
    for i, (fx, fz) in enumerate(((-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25))):
        o.append(cy_(f"foot{i}", 0.018, 0.0, 0.012, fx, fz, base_m, n=8))
    # perforations: three rows of dark squares on the inside of the tub wall
    for r, yy in enumerate((0.52, 0.64, 0.76)):
        for k in range(16):
            a = 2 * math.pi * (k + 0.5 * (r % 2)) / 16
            c = (math.cos(a) * 0.2185, yy, math.sin(a) * 0.2185)
            o.append(quad(f"hole{r}_{k}", c, (-math.sin(a), 0, math.cos(a)), (0, 1, 0), 0.012, 0.012, hole))
    o.append(cy_("pulsator", 0.15, 0.40, 0.418, 0, 0, puls, n=20, r2=0.14))
    o.append(cy_("puls_cap", 0.04, 0.418, 0.43, 0, 0, puls, n=12, r2=0.03))
    for k in range(4):
        a = math.pi / 2 * k + 0.4
        o.append(obox(f"fin{k}", (math.cos(a) * 0.04, 0.425, math.sin(a) * 0.04), (math.cos(a) * 0.135, 0.421, math.sin(a) * 0.135), 0.014, 0.01, puls))
    # control panel at the back (wedge)
    pv = []
    for x in (-0.29, 0.29):
        pv += [(x, 0.92, -0.30), (x, 0.98, -0.30), (x, 0.978, -0.27), (x, 0.951, -0.226), (x, 0.92, -0.226)]
    pfaces = [(0, 1, 2, 3, 4), (9, 8, 7, 6, 5), (0, 5, 6, 1), (1, 6, 7, 2), (2, 7, 8, 3), (3, 8, 9, 4), (4, 9, 5, 0)]
    panel = mk("panel", pv, pfaces, [white, panel_face], [0, 0, 0, 0, 1, 0, 0])
    fix_normals(panel)
    o.append(panel)
    # buttons on the slanted face (y 0.978->0.951, z -0.27->-0.226)
    u = Vector((1, 0, 0))
    v = Vector((0, 0.951 - 0.978, -0.226 + 0.27)).normalized()
    nn = u.cross(v).normalized()
    if nn.y < 0:
        nn = -nn

    def on_face(s, x, w, h, m, nm):
        c = Vector((x, 0.978 + (0.951 - 0.978) * s, -0.27 + 0.044 * s)) + nn * 0.0012
        o.append(quad(nm, tuple(c), tuple(u), tuple(v), w, h, m))

    on_face(0.45, -0.20, 0.07, 0.022, disp, "disp")
    on_face(0.5, -0.09, 0.03, 0.02, b_grey, "b1")
    on_face(0.5, -0.04, 0.03, 0.02, b_grey, "b2")
    on_face(0.5, 0.01, 0.03, 0.02, b_grey, "b3")
    on_face(0.5, 0.09, 0.045, 0.026, b_blue, "b_start")
    on_face(0.5, 0.22, 0.03, 0.026, b_red, "b_power")
    o.append(bx("label", -0.07, 0.07, 0.86, 0.885, 0.2995, 0.3015, label))
    o.append(plane("dust", 0.5, 0.06, (0, 0.09, 0.3012), dust))
    shell = grp(o, "body")

    # lid with a see-through window
    outer = xz(sring(0, 0, 0.035, 0.285, 0.255, n, 6))
    inner = xz(sring(0, 0, 0.045, 0.19, 0.16, n, 5))
    lid = [frame_plate("lid", outer, inner, 0.92, 0.95, [lid_m])]
    lid.append(mk("lid_glass", [(x, 0.936, z) for x, z in inner][::-1], [tuple(range(n))], glass))
    lid.append(bx("lid_grip", -0.08, 0.08, 0.912, 0.935, 0.282, 0.295, label, 0.003))
    lid.append(bx("lid_hinge_l", -0.25, -0.17, 0.935, 0.952, -0.228, -0.205, panel_face, 0.003))
    lid.append(bx("lid_hinge_r", 0.17, 0.25, 0.935, 0.952, -0.228, -0.205, panel_face, 0.003))
    part(lid, "lid", (0.0, 0.95, -0.22))
    return shell


# ═══════════════════════════════════════════════════════════════════════════
#  shoebox  (0.90 x 1.00 x 0.36) — wood-grain genkan cabinet, double doors
# ═══════════════════════════════════════════════════════════════════════════
def build_shoebox():
    wood = mat("sb_wood", "#97734f", 0.6)
    wood_d = mat("sb_wood_dark", "#7d5c3d", 0.65)
    wood_l = mat("sb_wood_light", "#a6825c", 0.6)
    inner = mat("sb_inner", "#bba98e", 0.8)
    plinth = mat("sb_plinth", "#3a2d22", 0.8)
    knob = mat("sb_knob", "#b9b7b0", 0.3, 0.8)
    o = [bx("side_l", -0.45, -0.432, 0.0, 0.97, -0.18, 0.16, wood),
         bx("side_r", 0.432, 0.45, 0.0, 0.97, -0.18, 0.16, wood),
         bx("back", -0.432, 0.432, 0.06, 0.97, -0.18, -0.17, inner),
         bx("plinth", -0.432, 0.432, 0.0, 0.06, -0.17, 0.14, plinth),
         bx("floor", -0.432, 0.432, 0.06, 0.075, -0.17, 0.16, inner),
         bx("top", -0.45, 0.45, 0.97, 1.0, -0.18, 0.18, wood_d, 0.004)]
    for i, sy in enumerate((0.32, 0.565, 0.79)):
        o.append(bx(f"shelf{i}", -0.432, 0.432, sy - 0.015, sy, -0.17, 0.155, inner))
    for i, gx in enumerate((-0.3, -0.05, 0.22)):
        o.append(plane(f"topgrain{i}", 0.012, 0.34, (gx, 1.0008, 0.0), wood, facing="y"))
    # shoes inside (cheap versions); floor y=0.075, shelves at 0.32 / 0.565 / 0.79
    lvl0 = []
    lvl0 += shoe_pieces("s1l_", "leather", "#1c1a19", "#2a2420", -0.37, -0.005, 0, low=True)
    lvl0 += shoe_pieces("s1r_", "leather", "#1c1a19", "#2a2420", -0.28, -0.005, 0, low=True)
    lvl0 += shoe_pieces("s2l_", "boot", "#5b4632", "#2a2420", -0.15, -0.01, 0, low=True)
    lvl0 += shoe_pieces("s2r_", "boot", "#5b4632", "#2a2420", -0.055, -0.01, 0, low=True)
    lvl0 += shoe_pieces("s3l_", "sneaker", "#3f5f8a", "#e8e6e0", 0.11, -0.005, 0, low=True)
    lvl0 += shoe_pieces("s3r_", "sneaker", "#3f5f8a", "#e8e6e0", 0.21, -0.005, 0, low=True)
    xform(lvl0, move=(0, 0.075, 0))
    lvl1 = []
    lvl1 += shoe_pieces("s4l_", "sneaker", "#e9e7e1", "#e8e6e0", -0.33, 0.0, 0, low=True)
    lvl1 += shoe_pieces("s4r_", "sneaker", "#e9e7e1", "#e8e6e0", -0.23, 0.0, 0, low=True)
    lvl1 += shoe_pieces("s5l_", "sandal", "#4a3c30", "#2a2420", 0.22, 0.0, 0, low=True, strap_col="#2b2b2d")
    lvl1 += shoe_pieces("s5r_", "sandal", "#4a3c30", "#2a2420", 0.32, 0.0, 0, low=True, strap_col="#2b2b2d")
    xform(lvl1, move=(0, 0.32, 0))
    lvl2 = []
    lvl2 += shoe_pieces("s6l_", "sandal", "#e6d8c8", "#e8e6e0", -0.30, 0.01, 0, low=True, strap_col="#c98f8f")
    lvl2 += shoe_pieces("s6r_", "sandal", "#e6d8c8", "#e8e6e0", -0.20, 0.01, 0, low=True, strap_col="#c98f8f")
    lvl2 += shoe_pieces("s7l_", "leather", "#6a4429", "#2a2420", 0.0, 0.0, 0, low=True)
    lvl2 += shoe_pieces("s7r_", "leather", "#6a4429", "#2a2420", 0.09, 0.0, 0, low=True)
    xform(lvl2, move=(0, 0.565, 0))
    o += lvl0 + lvl1 + lvl2
    o.append(bx("shoe_carton", 0.17, 0.41, 0.565, 0.68, -0.16, 0.10, mat("sb_carton", "#b98e5c", 0.85), 0.004))
    o.append(bx("carton_label", 0.22, 0.30, 0.60, 0.64, 0.1002, 0.1006, mat("sb_env_w", "#efece2", 0.85)))
    box_m = mat("sb_shoecare", "#2c4a3a", 0.6)
    o.append(bx("care_box", 0.05, 0.25, 0.79, 0.86, -0.12, 0.06, box_m, 0.004))
    o.append(cy_("spray", 0.025, 0.79, 0.95, 0.32, -0.05, mat("sb_tray", "#d8cdb6", 0.35), n=10))
    o.append(cy_("spray_cap", 0.02, 0.95, 0.965, 0.32, -0.05, mat("sb_keytag", "#c8402d", 0.5), n=10))
    # things on top (low: the model is 1.0 tall)
    tray = mat("sb_tray", "#d8cdb6", 0.35)
    key = mat("sb_knob", "#b9b7b0", 0.3, 0.8)
    tag = mat("sb_keytag", "#c8402d", 0.5)
    pot = mat("sb_pot", "#b46a43", 0.7)
    soil = mat("sb_plinth", "#3a2d22", 0.8)
    leaf = mat("sb_leaf", "#4f8a43", 0.7)
    env_w = mat("sb_env_w", "#efece2", 0.85)
    env_c = mat("sb_env_w", "#efece2", 0.85)
    env_b = mat("sb_env_b", "#b9cfe0", 0.85)
    flyer = mat("sb_flyer", "#e0583a", 0.8)
    o.append(bx("tray", -0.33, -0.19, 1.0, 1.012, -0.04, 0.07, tray, 0.004))
    o.append(bx("tray_in", -0.32, -0.20, 1.012, 1.013, -0.03, 0.06, mat("sb_tray", "#d8cdb6", 0.35)))
    o.append(torus("key_ring", 0.012, 0.0015, (-0.285, 1.0145, 0.01), "y", key, 10, 3))
    o.append(obox("key_blade", (-0.27, 1.015, 0.012), (-0.225, 1.015, 0.03), 0.004, 0.012, key, up=(0, 0, 1)))
    o.append(bx("key_tag", -0.30, -0.27, 1.013, 1.017, 0.02, 0.05, tag, 0.0015))
    o.append(cy_("pot", 0.036, 1.0, 1.028, 0.30, -0.06, pot, n=12, r2=0.044))
    o.append(cy_("soil", 0.04, 1.024, 1.027, 0.30, -0.06, soil, n=12))
    for k in range(8):
        a = 2 * math.pi * k / 8 + 0.3
        p0 = (0.30 + math.cos(a) * 0.006, 1.029, -0.06 + math.sin(a) * 0.006)
        p1 = (0.30 + math.cos(a) * (0.04 + 0.008 * (k % 2)), 1.035 + 0.002 * (k % 3), -0.06 + math.sin(a) * (0.04 + 0.008 * (k % 2)))
        o.append(obox(f"leaf{k}", p0, p1, 0.003, 0.02, leaf, roll=12))
    for i, (ex, ez, rr, mm) in enumerate(((0.02, 0.03, 4, env_w), (0.03, 0.025, -7, env_c), (0.015, 0.035, 12, flyer), (0.025, 0.02, -2, env_b))):
        e = bx(f"mail{i}", ex - 0.06, ex + 0.06, 1.0 + i * 0.004, 1.004 + i * 0.004, ez - 0.10, ez + 0.10, mm)
        xform(e, rot=[("y", rr)], pivot=(ex, 1.0, ez))
        o.append(e)
    for ob in o:
        if ob.name.startswith(("pot", "soil", "spray")):
            smooth_by_angle(ob, 40)
    body = grp(o, "body")

    def door(nm, x0, x1, hinge_x):
        d = [bx(nm + "_panel", x0, x1, 0.065, 0.965, 0.16, 0.18, wood, 0.003)]
        for k in range(4):
            gx = x0 + 0.05 + k * 0.1
            d.append(plane(f"{nm}_grain{k}", 0.006 + 0.004 * (k % 2), 0.86, (gx, 0.515, 0.1808), wood_d if k % 2 else wood_l))
        kx = x1 - 0.035 if hinge_x < 0 else x0 + 0.035
        d.append(cz_(nm + "_knob_base", 0.009, 0.18, 0.184, kx, 0.80, knob, n=10))
        d.append(sphere(nm + "_knob", 0.011, (kx, 0.80, 0.189), knob, segs=10, rings=6, scale=(1, 1, 0.6)))
        smooth_by_angle(d[-1], 60)
        return part(d, nm, (hinge_x, 0.5, 0.18))

    door("door_l", -0.448, -0.002, -0.45)
    door("door_r", 0.002, 0.448, 0.45)
    return body


# ═══════════════════════════════════════════════════════════════════════════
#  breaker_panel  (0.36 x 0.28 x 0.10) — origin = bottom centre of the box
# ═══════════════════════════════════════════════════════════════════════════
def build_breaker_panel():
    box_m = mat("bp_box", "#ebeae5", 0.5)
    inner = mat("bp_inner", "#d4d4cf", 0.6)
    plate_m = mat("bp_plate", "#b7b8b5", 0.5, 0.3)
    brk = mat("bp_breaker", "#e6e5e0", 0.45)
    brk_main = mat("bp_breaker", "#e6e5e0", 0.45)
    lever_m = mat("bp_lever", "#2b2c2e", 0.5)
    lever_main = mat("bp_lever", "#2b2c2e", 0.5)
    band = mat("bp_band", "#4f8a5b", 0.5)
    test = mat("bp_test", "#e2c23a", 0.5)
    label = mat("bp_label", "#f5f3ea", 0.8)
    ink = mat("bp_wire_black", "#1c1c1c", 0.6)
    w_bk = mat("bp_wire_black", "#1c1c1c", 0.6)
    w_wh = mat("bp_wire_white", "#e2e2dc", 0.6)
    w_rd = mat("bp_wire_red", "#b2302a", 0.6)
    cover_m = mat("bp_cover", "#efeee8", 0.45)
    notch = mat("bp_plate", "#b7b8b5", 0.5, 0.3)
    sticker = mat("bp_label", "#f5f3ea", 0.8)
    stripe = mat("bp_wire_red", "#b2302a", 0.6)
    o = [bx("back", -0.18, 0.18, 0.0, 0.28, -0.05, -0.042, box_m),
         bx("side_l", -0.18, -0.17, 0.0, 0.28, -0.042, 0.035, box_m),
         bx("side_r", 0.17, 0.18, 0.0, 0.28, -0.042, 0.035, box_m),
         bx("top", -0.17, 0.17, 0.27, 0.28, -0.042, 0.035, box_m),
         bx("bottom", -0.17, 0.17, 0.0, 0.01, -0.042, 0.035, box_m)]
    paint(o[0], inner, lambda n, c: n[2] > 0.9)
    paint(o[1], inner, lambda n, c: n[0] > 0.9)
    paint(o[2], inner, lambda n, c: n[0] < -0.9)
    paint(o[3], inner, lambda n, c: n[1] < -0.9)
    paint(o[4], inner, lambda n, c: n[1] > 0.9)
    o.append(bx("mount", -0.165, 0.165, 0.03, 0.25, -0.042, -0.036, plate_m))
    o.append(bx("main_body", -0.155, -0.075, 0.07, 0.21, -0.036, 0.010, brk_main, 0.003))
    o.append(bx("main_band", -0.15, -0.08, 0.188, 0.198, 0.010, 0.0108, band))
    o.append(bx("main_test", -0.10, -0.088, 0.088, 0.098, 0.010, 0.013, test, 0.001))
    o.append(bx("main_window", -0.15, -0.12, 0.085, 0.10, 0.010, 0.0106, ink))
    subs = (-0.03, 0.015, 0.06, 0.105)
    for i, sx in enumerate(subs):
        o.append(bx(f"sub{i}", sx - 0.018, sx + 0.018, 0.095, 0.185, -0.036, 0.006, brk, 0.002))
        o.append(bx(f"lab{i}", sx - 0.016, sx + 0.016, 0.068, 0.084, -0.036, -0.0352, label))
        o.append(bx(f"ink{i}", sx - 0.01, sx + 0.01, 0.0745, 0.0775, -0.0352, -0.0348, ink))
        wm = (w_bk, w_wh, w_rd, w_bk)[i]
        o.append(tube(f"wire{i}", [(sx, 0.095, -0.03), (sx + 0.004, 0.05, -0.033), (sx + 0.01, 0.012, -0.036)], 0.0032, wm, seg=5))
    o.append(bx("spare", 0.13, 0.16, 0.095, 0.185, -0.036, -0.02, plate_m, 0.002))
    o.append(tube("main_in1", [(-0.13, 0.21, -0.03), (-0.13, 0.24, -0.034), (-0.12, 0.268, -0.038)], 0.005, w_bk, seg=6))
    o.append(tube("main_in2", [(-0.10, 0.21, -0.03), (-0.10, 0.24, -0.034), (-0.09, 0.268, -0.038)], 0.005, w_wh, seg=6))
    o.append(tube("bus", [(-0.075, 0.12, -0.02), (-0.06, 0.12, -0.02), (0.13, 0.12, -0.02)], 0.003, w_rd, seg=5, caps=True))
    body = grp(o, "box")

    def lever(name, x, y, z, w, length, t, m):
        lv = bx(name + "_g", x - w / 2, x + w / 2, y - t / 2, y + t / 2, z, z + length, m, 0.0015)
        xform(lv, rot=[("x", -30)], pivot=(x, y, z))
        lv.name = name
        lv.data.name = name
        set_origin(lv, (x, y, z))
        return lv

    lever("sw_main", -0.115, 0.14, 0.010, 0.030, 0.024, 0.012, lever_main)
    for i, sx in enumerate(subs):
        lever(f"sw_{i + 1}", sx, 0.14, 0.006, 0.012, 0.022, 0.008, lever_m)

    cv = [bx("cover_panel", -0.177, 0.177, 0.003, 0.277, 0.035, 0.05, cover_m, 0.004),
          bx("cover_notch", 0.152, 0.170, 0.115, 0.165, 0.05, 0.0515, notch, 0.001),
          plane("cover_sticker", 0.09, 0.035, (0.0, 0.225, 0.0504), sticker),
          plane("cover_stripe", 0.09, 0.006, (0.0, 0.2395, 0.0507), stripe)]
    for k in range(6):
        xx = -0.10 + k * 0.04
        cv.append(bx(f"cover_vent{k}", xx, xx + 0.022, 0.02, 0.026, 0.0496, 0.0503, notch))
    part(cv, "cover", (-0.18, 0.14, 0.05))
    return body


# ═══════════════════════════════════════════════════════════════════════════
#  light_switch  (0.08 x 0.12 x 0.02) — origin = plate bottom centre, back = wall
# ═══════════════════════════════════════════════════════════════════════════
def build_light_switch():
    plate_m = mat("ls_plate", "#eeece4", 0.45)
    frame_m = mat("ls_frame", "#e1dfd6", 0.5)
    rocker_m = mat("ls_rocker", "#f4f3ed", 0.4)
    ind = mat("ls_indicator", "#d98a3a", 0.4)
    grime = mat("ls_grime", "#e0ddd3", 0.8)
    o = [bx("plate", -0.04, 0.04, 0.0, 0.12, -0.01, -0.003, plate_m, 0.002),
         bx("frame", -0.026, 0.026, 0.018, 0.102, -0.003, 0.0, frame_m),
         plane("grime", 0.03, 0.012, (0.003, 0.010, -0.0029), grime)]
    plate = grp(o, "plate")
    r = [bx("rocker_g", -0.023, 0.023, 0.021, 0.099, 0.0, 0.0055, rocker_m, 0.0015),
         bx("rocker_ind", -0.004, 0.004, 0.028, 0.034, 0.0055, 0.0061, ind),
         plane("rocker_grime", 0.03, 0.02, (0.0, 0.040, 0.0057), grime)]
    xform(r, rot=[("x", -6)], pivot=(0, 0.06, 0.0))
    part(r, "rocker", (0.0, 0.06, 0.0))
    return plate


# ═══════════════════════════════════════════════════════════════════════════
#  ceiling lights — origin = top centre, hanging down
# ═══════════════════════════════════════════════════════════════════════════
def build_ceiling_light():
    base = mat("cl_base", "#e3e2dd", 0.5)
    body = mat("cl_body", "#f2f1ec", 0.45)
    trim = mat("cl_trim", "#c7c4bb", 0.4, 0.3)
    emit = mat("emit_ceiling", "#f4f1e8", 0.5, emit="#fff4e2", emit_strength=1.0)
    n = 32
    o = [cy_("adapter", 0.12, -0.012, 0.0, 0, 0, base, n=20),
         cy_("housing", 0.252, -0.031, -0.010, 0, 0, body, n=n, r2=0.24),
         cy_("trim", 0.262, -0.034, -0.027, 0, 0, trim, n=n, cap=False)]
    cover = loft("cover", [sring(0, -0.03, 0, 0.258, 0.258, n), sring(0, -0.05, 0, 0.252, 0.252, n),
                           sring(0, -0.072, 0, 0.232, 0.232, n), sring(0, -0.09, 0, 0.19, 0.19, n),
                           sring(0, -0.099, 0, 0.12, 0.12, n), sring(0, -0.1, 0, 0.05, 0.05, n)][::-1],
                 [emit], cap0=0, smooth=True, sharp=50)
    o.append(cover)
    o.append(loft("inner_ring", [sring(0, -0.0995, 0, 0.125, 0.125, n), sring(0, -0.0995, 0, 0.118, 0.118, n)],
                  [mat("cl_ring", "#e6e1d4", 0.5)], smooth=False))
    return grp(o, "ceiling_light")


def build_ceiling_light_small():
    base = mat("cls_base", "#efeee9", 0.45)
    emit = mat("emit_ceiling", "#f4f1e8", 0.5, emit="#fff4e2", emit_strength=1.0)
    bug = mat("cls_bug", "#1d1813", 0.9)
    n = 24
    o = [loft("canopy", [sring(0, -0.022, 0, 0.13, 0.13, n), sring(0, -0.006, 0, 0.13, 0.13, n), sring(0, 0.0, 0, 0.122, 0.122, n)],
              [base], cap0=0, cap1=0, smooth=True, sharp=40)]
    globe = loft("globe", [sring(0, -0.022, 0, 0.118, 0.118, n), sring(0, -0.045, 0, 0.117, 0.117, n),
                           sring(0, -0.075, 0, 0.107, 0.107, n), sring(0, -0.1, 0, 0.083, 0.083, n),
                           sring(0, -0.114, 0, 0.05, 0.05, n), sring(0, -0.1195, 0, 0.018, 0.018, n)][::-1],
                 [emit], cap0=0, smooth=True, sharp=60)
    o.append(globe)
    for i, (bxp, bzp, rr, ln) in enumerate(((0.007, 0.004, 20, 0.010), (-0.006, -0.008, -40, 0.007), (0.002, 0.010, 75, 0.008), (-0.009, 0.004, 10, 0.012))):
        b = bx(f"bug{i}", bxp - ln / 2, bxp + ln / 2, -0.1203, -0.1197, bzp - 0.0018, bzp + 0.0018, bug)
        xform(b, rot=[("y", rr)], pivot=(bxp, -0.12, bzp))
        o.append(b)
    return grp(o, "ceiling_light_small")


# ═══════════════════════════════════════════════════════════════════════════
#  toilet  (0.42 x 0.80 x 0.72) — washlet, tank with hand-wash spout, hollow bowl + water
# ═══════════════════════════════════════════════════════════════════════════
def build_toilet():
    white = mat("to_white", "#f4f4f0", 0.25)
    stain = mat("to_stain", "#d7cfb4", 0.4)
    seat_m = mat("to_seat", "#ecebe5", 0.35)
    lid_m = mat("to_lid", "#f6f6f2", 0.3)
    wl = mat("to_washlet", "#efeee8", 0.35)
    chrome = mat("to_chrome", "#c9ccce", 0.2, 0.9)
    dark = mat("to_dark", "#26292b", 0.6)
    water = mat("water", "#2a3438", 0.08)
    b_blue = mat("to_btn_blue", "#4a78b8", 0.5)
    b_pink = mat("to_btn_pink", "#d77a9a", 0.5)
    b_orng = mat("to_btn_orange", "#e08a2e", 0.5)
    n = 28
    P = 2.3
    rings = [sring(0, 0.0, 0.03, 0.115, 0.16, n, P), sring(0, 0.10, 0.035, 0.12, 0.17, n, P),
             sring(0, 0.22, 0.065, 0.145, 0.21, n, P), sring(0, 0.32, 0.10, 0.165, 0.232, n, P),
             sring(0, 0.375, 0.112, 0.168, 0.232, n, P), sring(0, 0.385, 0.112, 0.165, 0.229, n, P),
             sring(0, 0.385, 0.08, 0.142, 0.178, n, P), sring(0, 0.37, 0.078, 0.14, 0.175, n, P),
             sring(0, 0.33, 0.07, 0.128, 0.158, n, P), sring(0, 0.29, 0.05, 0.10, 0.12, n, P),
             sring(0, 0.268, 0.035, 0.082, 0.095, n, P), sring(0, 0.258, 0.03, 0.074, 0.085, n, P)]
    bowl = loft("bowl", rings, [white, stain], band=[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1], cap0=0, smooth=True, sharp=50)
    o = [bowl]
    mk("water", [p for p in rings[-1]][::-1], [tuple(range(n))], water)
    o.append(bx("rear", -0.14, 0.14, 0.0, 0.384, -0.26, -0.11, white, 0.03))
    o.append(bx("tank", -0.21, 0.21, 0.40, 0.76, -0.36, -0.19, white, 0.02))
    # tank lid with a small hand-wash basin and spout
    outer = xz(sring(0, 0, -0.2725, 0.208, 0.087, n, 8))
    inner = xz(sring(0, 0, -0.268, 0.12, 0.052, n, 2))
    o.append(frame_plate("tank_lid", outer, inner, 0.76, 0.778, [white], smooth=False))
    o.append(loft("hand_basin", [sring(0, 0.778, -0.268, 0.12, 0.052, n, 2), sring(0, 0.77, -0.268, 0.105, 0.044, n, 2),
                                 sring(0, 0.762, -0.268, 0.06, 0.025, n, 2)],
                  [white, dark], cap1=1, smooth=True, sharp=50))
    o.append(tube("spout", [(0, 0.776, -0.345), (0, 0.797, -0.338), (0, 0.799, -0.30), (0, 0.789, -0.281)], 0.0085, chrome, seg=8))
    # flush lever (front-left of the tank)
    o.append(cz_("lever_base", 0.014, -0.19, -0.182, -0.155, 0.70, chrome, n=12))
    o.append(obox("lever", (-0.155, 0.70, -0.178), (-0.205, 0.694, -0.175), 0.013, 0.008, chrome))
    # supply pipe + stop valve
    o.append(tube("supply", [(-0.17, 0.41, -0.30), (-0.17, 0.30, -0.30), (-0.17, 0.26, -0.32), (-0.17, 0.25, -0.358)], 0.0075, chrome, seg=8))
    o.append(cx_("valve", 0.014, -0.185, -0.155, 0.27, -0.31, chrome, n=10))
    o.append(bx("valve_handle", -0.19, -0.15, 0.284, 0.29, -0.315, -0.305, chrome))
    # washlet body + side panel with buttons
    o.append(bx("washlet", -0.165, 0.165, 0.383, 0.452, -0.19, -0.126, wl, 0.012))
    o.append(bx("side_panel", 0.172, 0.21, 0.375, 0.432, -0.13, 0.07, wl, 0.01))
    for i, (zz, m) in enumerate(((-0.09, b_blue), (-0.05, b_pink), (-0.01, b_orng), (0.03, b_blue))):
        o.append(bx(f"btn{i}", 0.18, 0.202, 0.432, 0.4355, zz, zz + 0.026, m, 0.001))
    o.append(bx("wl_dark", -0.06, 0.06, 0.40, 0.42, -0.1262, -0.1258, dark))
    for s in (-1, 1):
        o.append(sphere(f"boltcap{s}", 0.012, (s * 0.122, 0.0097, 0.0), white, segs=8, rings=4, scale=(1, 0.8, 1)))
    seat_out = xz(sring(0, 0, 0.112, 0.168, 0.232, n, P))
    seat_in = xz(sring(0, 0, 0.088, 0.118, 0.163, n, P))
    frame_plate("seat", seat_out, seat_in, 0.385, 0.403, [seat_m], smooth=True)
    for ob in o:
        if ob.name in ("tank", "rear", "washlet", "side_panel") or ob.name.startswith("boltcap"):
            smooth_by_angle(ob, 40)
    body = grp(o, "body")
    # lid (pivot = back end of the seat)
    lr = [sring(0, 0.404, 0.112, 0.166, 0.230, n, P), sring(0, 0.416, 0.112, 0.166, 0.230, n, P),
          sring(0, 0.42, 0.115, 0.15, 0.21, n, P)]
    lid = [loft("lid_g", lr, [lid_m], cap0=0, cap1=0, smooth=True, sharp=40)]
    lid.append(bx("lid_hinge", -0.07, 0.07, 0.404, 0.42, -0.124, -0.11, lid_m, 0.004))
    part(lid, "lid", (0.0, 0.42, -0.12))
    return body


# ═══════════════════════════════════════════════════════════════════════════
#  bath_sink  (0.60 x 1.90 x 0.42) — pedestal basin, mirror (y 1.15-1.75), shelf, lamp
# ═══════════════════════════════════════════════════════════════════════════
def build_bath_sink():
    white = mat("bs_white", "#f3f3ef", 0.25)
    frame_m = mat("bs_frame", "#d8d8d3", 0.45, 0.2)
    mirror = mat("mirror", "#a7adb2", 0.1, 0.9)
    chrome = mat("bs_chrome", "#d3d6d8", 0.18, 0.9)
    dark = mat("bs_dark", "#24272a", 0.6)
    red = mat("bs_red", "#c8322e", 0.4)
    blue = mat("bs_blue", "#2f63b5", 0.4)
    shelf_m = mat("bs_shelf", "#e9ecec", 0.35)
    lamp = mat("bs_white", "#f3f3ef", 0.25)
    lamp_cover = mat("bs_lamp_cover", "#f5f1df", 0.6)
    scale = mat("bs_scale", "#e4dec9", 0.6)
    n = 28
    P = 3.0
    rings = [sring(0, 0.62, -0.10, 0.15, 0.10, n, P), sring(0, 0.70, -0.03, 0.22, 0.17, n, P),
             sring(0, 0.78, 0.0, 0.25, 0.205, n, P), sring(0, 0.80, 0.0, 0.248, 0.203, n, P),
             sring(0, 0.80, 0.02, 0.21, 0.15, n, P), sring(0, 0.785, 0.02, 0.20, 0.142, n, P),
             sring(0, 0.74, 0.015, 0.16, 0.11, n, P), sring(0, 0.705, 0.01, 0.09, 0.065, n, P),
             sring(0, 0.695, 0.01, 0.04, 0.035, n, 2)]
    o = [loft("basin", rings, [white, scale, dark], band=[0, 0, 0, 0, 0, 0, 1, 1], cap0=0, cap1=2, smooth=True, sharp=50)]
    o.append(cy_("drain", 0.022, 0.6955, 0.698, 0.0, 0.01, chrome, n=12))
    o.append(cy_("drain_hole", 0.015, 0.698, 0.6985, 0.0, 0.01, dark, n=10))
    o.append(loft("pedestal", [sring(0, 0.0, -0.125, 0.11, 0.08, n, 4), sring(0, 0.05, -0.125, 0.10, 0.075, n, 4),
                               sring(0, 0.62, -0.12, 0.13, 0.09, n, 4)], [white], cap1=0, smooth=True, sharp=50))
    # two-handle faucet
    o.append(cx_("fau_bar", 0.013, -0.085, 0.085, 0.825, -0.172, chrome, n=10))
    for s, m in ((-1, red), (1, blue)):
        o.append(cy_(f"fau_leg{s}", 0.012, 0.80, 0.825, s * 0.07, -0.172, chrome, n=10))
        o.append(cy_(f"fau_hub{s}", 0.011, 0.835, 0.85, s * 0.07, -0.172, chrome, n=10))
        o.append(bx(f"fau_x1{s}", s * 0.07 - 0.022, s * 0.07 + 0.022, 0.846, 0.854, -0.176, -0.168, chrome, 0.002))
        o.append(bx(f"fau_x2{s}", s * 0.07 - 0.004, s * 0.07 + 0.004, 0.846, 0.854, -0.194, -0.150, chrome, 0.002))
        o.append(cy_(f"fau_capc{s}", 0.007, 0.854, 0.858, s * 0.07, -0.172, m, n=10))
    o.append(tube("spout", [(0, 0.83, -0.172), (0, 0.858, -0.155), (0, 0.862, -0.11), (0, 0.848, -0.088)], 0.0095, chrome, seg=8))
    # mirror with its frame, the lamp above and the shelf below
    o.append(bx("mirror_frame", -0.265, 0.265, 1.125, 1.775, -0.21, -0.196, frame_m, 0.004))
    plane("mirror", 0.5, 0.6, (0.0, 1.45, -0.1955), mirror)
    o.append(bx("lamp_body", -0.20, 0.20, 1.80, 1.90, -0.21, -0.13, lamp, 0.01))
    o.append(bx("lamp_cover", -0.185, 0.185, 1.796, 1.81, -0.20, -0.14, lamp_cover, 0.003))
    o.append(bx("lamp_pull", -0.004, 0.004, 1.74, 1.796, -0.142, -0.138, dark))
    o.append(bx("shelf", -0.30, 0.30, 1.055, 1.068, -0.21, -0.105, shelf_m, 0.003))
    o.append(bx("shelf_lip", -0.30, 0.30, 1.068, 1.077, -0.111, -0.105, shelf_m))
    for s in (-1, 1):
        o.append(bx(f"bracket{s}", s * 0.22 - 0.01, s * 0.22 + 0.01, 1.025, 1.055, -0.21, -0.14, frame_m, 0.002))
    cupm = mat("bs_cup", "#8fb7cf", 0.35)
    o.append(cy_("cup", 0.030, 1.068, 1.15, -0.19, -0.155, cupm, n=12, r2=0.033))
    o.append(cy_("cup_in", 0.0285, 1.147, 1.1495, -0.19, -0.155, mat("bs_dark", "#24272a", 0.6), n=12))
    tb1 = mat("bs_tb_blue", "#3c6fb4", 0.4)
    tb2 = mat("bs_tb_pink", "#e07a9b", 0.4)
    bristle = mat("bs_white", "#f3f3ef", 0.25)
    o.append(obox("tb1", (-0.196, 1.08, -0.16), (-0.215, 1.245, -0.172), 0.008, 0.006, tb1))
    o.append(obox("tb1_head", (-0.2135, 1.232, -0.162), (-0.2155, 1.252, -0.163), 0.010, 0.012, bristle))
    o.append(obox("tb2", (-0.182, 1.08, -0.15), (-0.162, 1.24, -0.138), 0.008, 0.006, tb2))
    o.append(obox("tb2_head", (-0.164, 1.226, -0.146), (-0.161, 1.246, -0.144), 0.010, 0.012, bristle))
    o.append(obox("razor", (-0.02, 1.072, -0.150), (0.08, 1.072, -0.162), 0.006, 0.012, mat("bs_white", "#f3f3ef", 0.25), up=(0, 0, 1)))
    o.append(bx("razor_head", 0.08, 0.092, 1.068, 1.078, -0.178, -0.146, mat("bs_dark", "#24272a", 0.6)))
    paste = obox("paste", (0.13, 1.076, -0.152), (0.245, 1.076, -0.16), 0.03, 0.014, mat("bs_white", "#f3f3ef", 0.25), up=(0, 0, 1))
    o.append(paste)
    o.append(obox("paste_band", (0.20, 1.076, -0.155), (0.235, 1.076, -0.157), 0.0305, 0.0145, red, up=(0, 0, 1)))
    o.append(cz_("paste_cap", 0.008, -0.165, -0.15, 0.25, 1.076, mat("bs_blue", "#2f63b5", 0.4), n=8))
    o.append(cy_("wash_bottle", 0.02, 1.068, 1.17, 0.0, -0.175, mat("bs_bottle", "#d4e6d0", 0.4), n=10))
    o.append(cy_("wash_cap", 0.012, 1.17, 1.19, 0.0, -0.175, cupm, n=10))
    for ob in o:
        if ob.name.startswith(("cup", "wash", "fau_leg", "fau_hub")):
            smooth_by_angle(ob, 40)
    return grp(o, "bath_sink")


# ═══════════════════════════════════════════════════════════════════════════
#  bathtub  (0.72 x 0.55 x 1.60) — cream resin, empty, drain + plug on a chain
# ═══════════════════════════════════════════════════════════════════════════
def build_bathtub():
    cream = mat("bt_cream", "#efe6cf", 0.35)
    stain = mat("bt_stain", "#ddd2ae", 0.5)
    floor_m = mat("bt_floor", "#e6dcc0", 0.45)
    groove = mat("bt_groove", "#d6cbab", 0.5)
    chrome = mat("bt_chrome", "#cfd2d4", 0.2, 0.9)
    dark = mat("bt_dark", "#1c1c1c", 0.7)
    rubber = mat("bt_plug", "#202020", 0.8)
    n = 40
    P = 12
    rings = [sring(0, 0.0, 0, 0.355, 0.795, n, P), sring(0, 0.53, 0, 0.36, 0.80, n, P),
             sring(0, 0.55, 0, 0.352, 0.792, n, P), sring(0, 0.55, 0, 0.31, 0.758, n, P),
             sring(0, 0.535, 0, 0.30, 0.75, n, P), sring(0, 0.30, 0, 0.29, 0.72, n, P),
             sring(0, 0.14, 0.02, 0.27, 0.66, n, P), sring(0, 0.11, 0.03, 0.255, 0.635, n, P),
             sring(0, 0.10, 0.03, 0.245, 0.62, n, P)]
    o = [loft("tub", rings, [cream, stain, floor_m], band=[0, 0, 0, 0, 0, 0, 1, 1], cap1=2, smooth=True, sharp=40)]
    o.append(plane("apron_groove", 1.2, 0.01, (-0.3604, 0.47, 0.0), groove, facing="-x"))
    o.append(plane("apron_seam", 0.004, 0.40, (-0.3602, 0.24, 0.45), groove, facing="-x"))
    o.append(cy_("drain_ring", 0.035, 0.1, 0.104, 0.0, 0.52, chrome, n=16))
    o.append(cy_("drain_hole", 0.025, 0.101, 0.1045, 0.0, 0.52, dark, n=14))
    o.append(cz_("overflow", 0.035, 0.722, 0.728, 0.0, 0.42, chrome, n=16))
    o.append(cz_("overflow_hole", 0.02, 0.7215, 0.7222, 0.0, 0.40, dark, n=12))
    o.append(cy_("plug", 0.028, 0.10, 0.12, 0.10, 0.45, rubber, n=12, r2=0.022))
    o.append(torus("plug_ring", 0.006, 0.0015, (0.10, 0.123, 0.45), "x", chrome, 8, 3))
    o.append(tube("plug_chain", [(0.10, 0.128, 0.45), (0.085, 0.104, 0.53), (0.045, 0.106, 0.63), (0.02, 0.15, 0.674),
                                 (0.008, 0.30, 0.712), (0.0, 0.405, 0.72)], 0.0022, chrome, seg=4, caps=False))
    for ob in o:
        if ob.name in ("plug",):
            smooth_by_angle(ob, 40)
    return grp(o, "bathtub")


# ═══════════════════════════════════════════════════════════════════════════
#  shower_curtain  (0.04 x 2.00 x 1.60) — rod along z at y=1.95, curtain scales toward z=-0.8
# ═══════════════════════════════════════════════════════════════════════════
def build_shower_curtain():
    rod_m = mat("sc_rod", "#dadddd", 0.3, 0.6)
    cur = mat("sc_curtain", "#a9c6d6", 0.7)
    hem = mat("sc_hem", "#c9dae3", 0.7)
    mold = mat("sc_mold", "#8aa3a3", 0.8)
    spot = mat("sc_spot", "#3c4440", 0.9)
    ring_m = mat("sc_ring", "#eef0f0", 0.4)
    o = [cz_("rod", 0.012, -0.8, 0.8, 0.0, 1.95, rod_m, n=12),
         bx("flange_n", -0.02, 0.02, 1.915, 1.985, -0.8, -0.79, rod_m, 0.002),
         bx("flange_s", -0.02, 0.02, 1.915, 1.985, 0.79, 0.8, rod_m, 0.002),
         cy_("support", 0.007, 1.962, 2.19, 0.0, 0.0, rod_m, n=8),
         bx("support_plate", -0.02, 0.02, 2.19, 2.2, -0.03, 0.03, rod_m),
         bx("support_clamp", -0.016, 0.016, 1.935, 1.968, -0.012, 0.012, rod_m, 0.004)]
    rod = grp(o, "rod")
    # pleated curtain (zigzag columns), rows: top hem / body / mold band
    cols = 37
    zs = [-0.79 + 1.58 * k / (cols - 1) for k in range(cols)]
    ys = [1.938, 1.905, 1.20, 0.42, 0.25]
    amp = [0.010, 0.012, 0.016, 0.0185, 0.019]
    verts = []
    for r, y in enumerate(ys):
        for k, z in enumerate(zs):
            s = 1 if k % 2 == 0 else -1
            yy = y - (0.012 * math.sin(k * 1.7) if r == len(ys) - 1 else 0)
            verts.append((s * amp[r], yy, z))
    faces, fm = [], []
    for r in range(len(ys) - 1):
        for k in range(cols - 1):
            a = r * cols + k
            faces.append((a, a + 1, a + cols + 1, a + cols))
            if r == 0:
                fm.append(1)
            elif r == len(ys) - 2:
                fm.append(3 if k % 7 in (2, 5) or k % 11 == 0 else 2)
            else:
                fm.append(0)
    c = [mk("curtain_g", verts, faces, [cur, hem, mold, spot], fm)]
    for k in range(12):
        z = -0.77 + k * (1.54 / 11)
        c.append(torus(f"ring{k}", 0.016, 0.0018, (0.0, 1.95, z), "z", ring_m, 8, 3))
    part(c, "curtain", (0.0, 1.95, -0.8))
    return rod


# ═══════════════════════════════════════════════════════════════════════════
#  shoes  (0.50 x 0.12 x 0.35) — a pair of sneakers and a pair of slides, toes toward +x (door)
# ═══════════════════════════════════════════════════════════════════════════
def build_shoes():
    o = []
    o += shoe_pieces("snkL_", "sneaker", "#cfd2d4", "#f1efe8", -0.12, -0.128, 91)
    o += shoe_pieces("snkR_", "sneaker", "#cfd2d4", "#f1efe8", -0.125, -0.03, 89)
    o += shoe_pieces("sndL_", "sandal", "#6e5a45", "#1d1e20", 0.13, 0.03, 92, strap_col="#2a2f38")
    o += shoe_pieces("sndR_", "sandal", "#6e5a45", "#1d1e20", 0.125, 0.137, 88, strap_col="#2a2f38")
    return grp(o, "shoes")


# ═══════════════════════════════════════════════════════════════════════════
#  flashlight  (0.05 x 0.05 x 0.20) — lens at -z (emit_lens), origin = centre
# ═══════════════════════════════════════════════════════════════════════════
def build_flashlight():
    lens = mat("emit_lens", "#d9d5c4", 0.15, emit="#fff3d0", emit_strength=1.0)
    return grp(flashlight_pieces("fl_", lens), "flashlight")


# ═══════════════════════════════════════════════════════════════════════════
#  medicine_bag  (0.14 x 0.20 x 0.04) — puffy paper pharmacy bag, tex on the front
# ═══════════════════════════════════════════════════════════════════════════
def build_medicine_bag():
    tex = mat("tex_medicine_bag", "#f6f6f2", 0.85)
    paper = mat("mb_paper", "#efeee8", 0.85)
    fold = mat("mb_fold", "#e2e0d8", 0.85)
    staple = mat("mb_staple", "#a9acae", 0.3, 0.8)
    nx, ny = 6, 8
    W, H = 0.14, 0.195

    def bulge(u, v):
        return math.sin(math.pi * u) ** 0.6 * math.sin(math.pi * min(1.0, v * 1.1)) ** 0.5 * (1 - 0.75 * v ** 5)

    verts, faces, fm, uvs = [], [], [], {}
    for side in (1, -1):
        base = len(verts)
        for j in range(ny + 1):
            for i in range(nx + 1):
                u, v = i / nx, j / ny
                z = side * (0.0035 + 0.0166 * bulge(u, v))
                verts.append((-W / 2 + W * u, H * v, z))
        for j in range(ny):
            for i in range(nx):
                a = base + j * (nx + 1) + i
                f = (a, a + 1, a + nx + 2, a + nx + 1)
                faces.append(f if side > 0 else f[::-1])
                fm.append(0 if side > 0 else 1)
                if side > 0:
                    uvs[len(faces) - 1] = [(i / nx, j / ny), ((i + 1) / nx, j / ny), ((i + 1) / nx, (j + 1) / ny), (i / nx, (j + 1) / ny)]
    back = (nx + 1) * (ny + 1)
    # side and bottom strips (front edge to back edge)
    for i in range(nx):
        a, b = i, i + 1
        faces.append((a + back, b + back, b, a))
        fm.append(1)
    for j in range(ny):
        for col in (0, nx):
            a, b = j * (nx + 1) + col, (j + 1) * (nx + 1) + col
            faces.append((a, b, b + back, a + back) if col == 0 else (b, a, a + back, b + back))
            fm.append(1)
    # top: crimped edge
    for i in range(nx):
        a, b = ny * (nx + 1) + i, ny * (nx + 1) + i + 1
        faces.append((a, b, b + back, a + back))
        fm.append(2)
    bag = mk("bag", verts, faces, [tex, paper, fold], fm, uvs=uvs, smooth=True, sharp=50)
    o = [bag]
    # flap folded over to the back
    fv, ff = [], []
    vf = 0.165 / H
    for i in range(nx + 1):
        u = i / nx
        fv.append((-W / 2 + W * u, 0.2, -0.0015))
        fv.append((-W / 2 + W * u, 0.165, -(0.0035 + 0.0166 * bulge(u, vf)) - 0.0012))
    for i in range(nx):
        a = 2 * i
        ff.append((a, a + 2, a + 3, a + 1))
    o.append(mk("flap", fv, ff, fold))
    o.append(mk("fold_cap", [(-0.07, 0.195, 0.0035), (0.07, 0.195, 0.0035), (0.07, 0.2, -0.0015), (-0.07, 0.2, -0.0015)],
                [(0, 1, 2, 3)], fold))
    o.append(bx("staple", -0.008, 0.008, 0.186, 0.1885, 0.0034, 0.0052, staple))
    return grp(o, "medicine_bag")


# ═══════════════════════════════════════════════════════════════════════════
#  notebook  (0.16 x 0.02 x 0.22) — closed, tex_notebook on the cover (top)
# ═══════════════════════════════════════════════════════════════════════════
def build_notebook():
    cover = mat("nb_cover", "#2e4a6b", 0.6)
    spine = mat("nb_spine", "#1d3049", 0.7)
    pages = mat("nb_pages", "#ece6d4", 0.9)
    page_line = mat("nb_page_line", "#d2cbb6", 0.9)
    tex = mat("tex_notebook", "#2e4a6b", 0.6)
    o = [bx("cover_b", -0.08, 0.08, 0.0, 0.0016, -0.11, 0.11, cover),
         bx("pages", -0.077, 0.078, 0.0016, 0.0176, -0.1075, 0.1075, pages),
         bx("cover_t", -0.08, 0.08, 0.0176, 0.0192, -0.11, 0.11, cover),
         bx("spine", -0.0815, -0.068, -0.0001, 0.0196, -0.1102, 0.1102, spine),
         plane("cover_tex", 0.148, 0.22, (0.006, 0.0197, 0.0), tex, facing="y")]
    for k in range(3):
        yy = 0.005 + k * 0.004
        o.append(plane(f"pl_r{k}", 0.215, 0.0008, (0.0782, yy, 0.0), page_line, facing="x"))
        o.append(plane(f"pl_f{k}", 0.15, 0.0008, (0.0005, yy, 0.1077), page_line))
    return grp(o, "notebook")


# ═══════════════════════════════════════════════════════════════════════════

if only_requested("door_entrance"):
    run_model("door_entrance", build_door_entrance)
if only_requested("door_bath"):
    run_model("door_bath", build_door_bath)
if only_requested("door_sliding_glass"):
    run_model("door_sliding_glass", build_door_sliding_glass)
if only_requested("fridge"):
    run_model("fridge", build_fridge)
if only_requested("microwave"):
    run_model("microwave", build_microwave)
if only_requested("kitchen_counter"):
    run_model("kitchen_counter", build_kitchen_counter)
if only_requested("washer"):
    run_model("washer", build_washer)
if only_requested("shoebox"):
    run_model("shoebox", build_shoebox)
if only_requested("breaker_panel"):
    run_model("breaker_panel", build_breaker_panel)
if only_requested("light_switch"):
    run_model("light_switch", build_light_switch)
if only_requested("ceiling_light"):
    run_model("ceiling_light", build_ceiling_light)
if only_requested("ceiling_light_small"):
    run_model("ceiling_light_small", build_ceiling_light_small)
if only_requested("toilet"):
    run_model("toilet", build_toilet)
if only_requested("bath_sink"):
    run_model("bath_sink", build_bath_sink)
if only_requested("bathtub"):
    run_model("bathtub", build_bathtub)
if only_requested("shower_curtain"):
    run_model("shower_curtain", build_shower_curtain)
if only_requested("shoes"):
    run_model("shoes", build_shoes)
if only_requested("flashlight"):
    run_model("flashlight", build_flashlight)
if only_requested("medicine_bag"):
    run_model("medicine_bag", build_medicine_bag)
if only_requested("notebook"):
    run_model("notebook", build_notebook)
