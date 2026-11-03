"""Unit 103 — Western-style room (洋室) and balcony props.

closet, bed, desk, chair, tv_set, low_table, cushion, smartphone, color_box, trash_can,
calendar, aircon, window_sliding, curtains, balcony_rail, ac_outdoor, laundry_pole

Run (from the project root):
  Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/interior_room.py -- --preview
  Blender ... -P tools/blender/models/interior_room.py -- --only bed,closet --preview

All coordinates are three.js terms (x right, y up, z = front). See tools/blender/common.py.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import *  # noqa: E402,F401,F403
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402


# ═════════════════════════════════════════════════════════════════════════════
#  local helpers (three.js coordinates)
# ═════════════════════════════════════════════════════════════════════════════
def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def span_box(name, p0, p1, m, bevel=0.0):
    """Axis aligned box between two corners."""
    size = tuple(abs(p1[i] - p0[i]) for i in range(3))
    pos = tuple((p0[i] + p1[i]) / 2 for i in range(3))
    return box(name, size, pos, m, bevel=bevel)


def bx(name, size, pos, m, bevel=0.0, rot=()):
    """Box rotated about its own center: rot = [(deg, axis), ...] (intrinsic order)."""
    o = box(name, size, pos, m, bevel=bevel)
    for deg, ax in rot:
        rotate(o, deg, ax)
    return o


def fix_normals(obj):
    """Make the faces of a closed mesh consistently point outward."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def face_toward(obj, hint):
    """Flip every face of an open surface if it mostly faces away from `hint` (three vector)."""
    h = T(*hint)
    s = Vector((0, 0, 0))
    for p in obj.data.polygons:
        s += p.normal * p.area
    if s.dot(h) < 0:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()
    return obj


def mesh_mm(name, verts, faces, mats, fmat=None, smooth_shade=False):
    """mesh_from with several materials; fmat = material index per face."""
    o = mesh_from(name, verts, faces, mats[0])
    for m_ in mats[1:]:
        o.data.materials.append(m_)
    if fmat:
        for p, i in zip(o.data.polygons, fmat):
            p.material_index = i
    if smooth_shade:
        shade_smooth(o)
    return o


def lathe(name, prof, m, pos=(0, 0, 0), segs=12, cap0=None, cap1=None, phase=0.0,
          mats=None, ring_mat=None, cap_mat=(0, 0)):
    """Surface of revolution about the y axis through pos. prof = [(r, y), ...] (y relative).
    cap0/cap1 close the first/last ring: 'up' (faces +y) or 'down'."""
    verts, faces, fm = [], [], []
    for (r, y) in prof:
        for s in range(segs):
            a = phase + 2 * math.pi * s / segs
            verts.append((pos[0] + r * math.sin(a), pos[1] + y, pos[2] + r * math.cos(a)))
    for i in range(len(prof) - 1):
        for s in range(segs):
            a = i * segs + s
            b = i * segs + (s + 1) % segs
            faces.append((a, b, b + segs, a + segs))
            fm.append(ring_mat(i) if ring_mat else 0)
    for cap, ring, ci in ((cap0, 0, cap_mat[0]), (cap1, len(prof) - 1, cap_mat[1])):
        if cap:
            idx = [ring * segs + s for s in range(segs)]
            faces.append(tuple(idx if cap == "up" else reversed(idx)))
            fm.append(ci)
    return mesh_mm(name, verts, faces, mats or [m], fm)


def tube(name, pts, r, m, sides=6, caps=True, r_end=None):
    """Round tube along a polyline (parallel-transport frames)."""
    P = [Vector(p) for p in pts]
    n = len(P)
    verts, faces = [], []
    prev = None
    for i in range(n):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        t.normalize()
        if prev is None:
            up = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
            nrm = t.cross(up).normalized()
        else:
            nrm = prev - t * prev.dot(t)
            nrm = nrm.normalized() if nrm.length > 1e-6 else t.orthogonal().normalized()
        b = t.cross(nrm).normalized()
        prev = nrm
        rr = r if r_end is None else r + (r_end - r) * i / (n - 1)
        for s in range(sides):
            a = 2 * math.pi * s / sides
            verts.append(tuple(P[i] + (nrm * math.cos(a) + b * math.sin(a)) * rr))
    for i in range(n - 1):
        for s in range(sides):
            a = i * sides + s
            bb = i * sides + (s + 1) % sides
            faces.append((a, bb, bb + sides, a + sides))
    if caps:
        faces.append(tuple(reversed(range(sides))))
        faces.append(tuple((n - 1) * sides + s for s in range(sides)))
    return mesh_from(name, verts, faces, m)


def ring_tube(name, center, radius, r, m, segs=16, sides=4, axis="z"):
    """Closed torus-like ring (e.g. fan grille wire). axis = ring normal."""
    cx, cy, cz = center
    pts = []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        if axis == "z":
            pts.append(Vector((cx + radius * math.cos(a), cy + radius * math.sin(a), cz)))
        else:  # y
            pts.append(Vector((cx + radius * math.cos(a), cy, cz + radius * math.sin(a))))
    verts, faces = [], []
    for k in range(segs):
        p = pts[k]
        t = (pts[(k + 1) % segs] - pts[k - 1]).normalized()
        nrm = (p - Vector(center)).normalized()
        b = t.cross(nrm).normalized()
        for s in range(sides):
            a = 2 * math.pi * s / sides
            verts.append(tuple(p + (nrm * math.cos(a) + b * math.sin(a)) * r))
    for k in range(segs):
        for s in range(sides):
            a = k * sides + s
            bb = k * sides + (s + 1) % sides
            k2 = (k + 1) % segs
            faces.append((a, bb, k2 * sides + (s + 1) % sides, k2 * sides + s))
    return fix_normals(mesh_from(name, verts, faces, m))


def prism(name, prof, axis, a0, a1, m, mats=None, side_mat=None, cap_mat=0):
    """Extrude a 2D polygon. axis 'x': prof=[(z, y)] over x∈[a0,a1]; 'z': prof=[(x, y)] over z;
    'y': prof=[(x, z)] over y. side_mat(i) gives the material index of side face i."""
    def P(u, v, w):
        if axis == "x":
            return (w, v, u)
        if axis == "z":
            return (u, v, w)
        return (u, w, v)
    n = len(prof)
    verts = [P(u, v, a0) for (u, v) in prof] + [P(u, v, a1) for (u, v) in prof]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    fm = [cap_mat, cap_mat]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        fm.append(side_mat(i) if side_mat else 0)
    return fix_normals(mesh_mm(name, verts, faces, mats or [m], fm))


def blob(name, size, pos, m, k=0.5, segs=12, rings=8, jitter=0.0, seed=0, warp=None):
    """Rounded box / superellipsoid (k<1 squarer). warp(x,y,z) may deform local coords."""
    rnd = random.Random(seed)

    def sq(c):
        return math.copysign(abs(c) ** k, c)
    unit = [(0.0, 1.0, 0.0)]
    for i in range(1, rings):
        phi = math.pi * i / rings
        for s in range(segs):
            th = 2 * math.pi * s / segs
            unit.append((math.sin(phi) * math.sin(th), math.cos(phi), math.sin(phi) * math.cos(th)))
    unit.append((0.0, -1.0, 0.0))
    verts = []
    for (x, y, z) in unit:
        j = 1.0 + (rnd.uniform(-jitter, jitter) if jitter else 0.0)
        X, Y, Z = sq(x) * size[0] / 2 * j, sq(y) * size[1] / 2 * j, sq(z) * size[2] / 2 * j
        if warp:
            X, Y, Z = warp(X, Y, Z)
        verts.append((pos[0] + X, pos[1] + Y, pos[2] + Z))
    faces = []
    for s in range(segs):
        faces.append((0, 1 + s, 1 + (s + 1) % segs))
    for i in range(rings - 2):
        for s in range(segs):
            a = 1 + i * segs + s
            b = 1 + i * segs + (s + 1) % segs
            faces.append((a, a + segs, b + segs, b))
    last = len(verts) - 1
    base = 1 + (rings - 2) * segs
    for s in range(segs):
        faces.append((base + s, last, base + (s + 1) % segs))
    return fix_normals(mesh_from(name, verts, faces, m))


def grid(name, rows, m, mats=None, fmat=None):
    """Open surface from rows of points (each row the same length): quads between rows."""
    nu = len(rows[0])
    verts = [tuple(p) for row in rows for p in row]
    faces, fm = [], []
    for j in range(len(rows) - 1):
        for i in range(nu - 1):
            a = j * nu + i
            faces.append((a, a + 1, a + 1 + nu, a + nu))
            fm.append(fmat(i, j) if fmat else 0)
    return mesh_mm(name, verts, faces, mats or [m], fm)


def slab(name, top, bot, mats, smooth_shade=False):
    """Closed slab between two point grids (top[j][i], bot[j][i]); materials: top, bottom, rim."""
    nv, nu = len(top) - 1, len(top[0]) - 1
    W = nu + 1
    verts = [tuple(p) for row in top for p in row]
    off = len(verts)
    verts += [tuple(p) for row in bot for p in row]
    faces, fm = [], []
    for j in range(nv):
        for i in range(nu):
            a = j * W + i
            faces.append((a, a + 1, a + 1 + W, a + W))
            fm.append(0)
            faces.append((off + a, off + a + W, off + a + 1 + W, off + a + 1))
            fm.append(1)
    ring = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + \
           [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
    for k in range(len(ring)):
        i0, j0 = ring[k]
        i1, j1 = ring[(k + 1) % len(ring)]
        a, b = j0 * W + i0, j1 * W + i1
        faces.append((a, b, off + b, off + a))
        fm.append(2)
    o = mesh_mm(name, verts, faces, mats, fm, smooth_shade)
    return fix_normals(o)


def panel_hole(name, x0, x1, y0, y1, cx, cy, r, z0, z1, m, m_in, segs=20):
    """Solid rectangular plate (x0..x1, y0..y1, z0..z1) with a round through-hole."""
    angs = {round(2 * math.pi * i / segs, 6) for i in range(segs)}
    for (x, y) in ((x1, y1), (x0, y1), (x0, y0), (x1, y0)):
        angs.add(round(math.atan2(y - cy, x - cx) % (2 * math.pi), 6))
    angs = sorted(angs)

    def hit(a):
        dx, dy = math.cos(a), math.sin(a)
        ts = []
        if abs(dx) > 1e-9:
            ts += [(x1 - cx) / dx, (x0 - cx) / dx]
        if abs(dy) > 1e-9:
            ts += [(y1 - cy) / dy, (y0 - cy) / dy]
        t = min(t for t in ts if t > 1e-9)
        return cx + dx * t, cy + dy * t
    n = len(angs)
    verts = []
    for a in angs:
        ox, oy = hit(a)
        ix, iy = cx + r * math.cos(a), cy + r * math.sin(a)
        verts += [(ix, iy, z1), (ox, oy, z1), (ix, iy, z0), (ox, oy, z0)]
    faces, fm = [], []
    for k in range(n):
        a, b = 4 * k, 4 * ((k + 1) % n)
        faces.append((a, a + 1, b + 1, b))          # front
        fm.append(0)
        faces.append((a + 2, b + 2, b + 3, a + 3))  # back
        fm.append(0)
        faces.append((a + 1, a + 3, b + 3, b + 1))  # outer edge
        fm.append(0)
        faces.append((a, b, b + 2, a + 2))          # inner tunnel
        fm.append(1)
    return fix_normals(mesh_mm(name, verts, faces, [m, m_in], fm))


def paint(obj, m, pred):
    """Give faces whose (center, normal) in three coords satisfy pred the material m."""
    update()
    mats = obj.data.materials
    names = [x.name for x in mats]
    if m.name not in names:
        mats.append(m)
        names.append(m.name)
    idx = names.index(m.name)
    mw = obj.matrix_world
    r3 = mw.to_3x3()
    for p in obj.data.polygons:
        c = mw @ p.center
        nn = (r3 @ p.normal).normalized()
        if pred((c.x, c.z, -c.y), (nn.x, nn.z, -nn.y)):
            p.material_index = idx
    return obj


def finish(objs, name, origin=(0.0, 0.0, 0.0)):
    """Join into one object called `name`, transforms baked, origin (pivot) at `origin`."""
    objs = [o for o in objs if o is not None]
    o = join(objs, name) if len(objs) > 1 else objs[0]
    o.name = name
    o.data.name = name
    apply_transform(o)
    if any(abs(c) > 1e-9 for c in origin):
        set_origin(o, origin)
    return o


def rot_world(obj, deg, axis="y", pivot=(0.0, 0.0, 0.0)):
    """Rotate about a WORLD three.js axis through `pivot` (common.rotate turns about local axes)."""
    ax = {"x": (1, 0, 0), "y": (0, 0, 1), "z": (0, -1, 0)}[axis]
    update()
    P = T(*pivot)
    R = Matrix.Translation(P) @ Matrix.Rotation(math.radians(deg), 4, Vector(ax)) @ Matrix.Translation(-P)
    obj.matrix_world = R @ obj.matrix_world
    update()
    return obj


def group_at(objs, name, pos, yaw=0.0):
    """Join pieces modelled around the origin, then turn by yaw (deg about y) and move to pos."""
    o = finish(objs, name)
    if yaw:
        rotate(o, yaw, "y")
    o.location = T(*pos)
    update()
    return o


# ═════════════════════════════════════════════════════════════════════════════
#  closet  (1.8 x 2.2 x 0.7) — sliding doors, hollow inside with clothes & boxes
# ═════════════════════════════════════════════════════════════════════════════
def build_closet():
    frame = mat("closet_frame", "#e6e3db", 0.55)
    skin = mat("closet_wall", "#d6d0c3", 0.9)
    inner = mat("closet_inner", "#b6a68a", 0.85)
    floor_m = mat("closet_floor", "#95866a", 0.8)
    stain = mat("closet_stain", "#6f6450", 0.95)
    track = mat("closet_track", "#55524c", 0.6)
    door_m = mat("closet_door", "#efede7", 0.5)
    door_ln = mat("closet_door_line", "#c4c0b6", 0.6)
    pull_in = mat("closet_dark", "#2c2c2e", 0.5)       # pulls, marker ink, vacuum grip
    chrome = mat("closet_pipe", "#c3c6c9", 0.3, 0.5)
    pull_rim = chrome
    card = mat("cardboard", "#a07b4b", 0.95)
    card_dk = stain
    tape_m = mat("packing_tape", "#cdb782", 0.4)
    ink = pull_in
    case_m = mat("closet_case", "#cfd2cf", 0.4)
    case_fr = mat("closet_case_front", "#e8e9e5", 0.35)   # also the box label
    label_m = case_fr
    case_grip = track
    vac = mat("vacuum", "#5c6870", 0.5)
    vac_acc = mat("vacuum_accent", "#b84a3a", 0.5)
    blanket_m = mat("closet_blanket", "#6f7f98", 0.95)

    b = []
    # carcass (inner plywood) + wallpaper-coloured outer skins
    b.append(span_box("c_side_l", (-0.9, 0, -0.35), (-0.85, 2.2, 0.33), inner))
    b.append(span_box("c_side_r", (0.85, 0, -0.35), (0.9, 2.2, 0.33), inner))
    b.append(plane("c_skin_r", 0.68, 2.2, (0.9006, 1.1, -0.01), skin, facing="x"))
    b.append(plane("c_skin_l", 0.68, 2.2, (-0.9006, 1.1, -0.01), skin, facing="-x"))
    b.append(span_box("c_back", (-0.85, 0.05, -0.35), (0.85, 2.1, -0.32), inner))
    b.append(span_box("c_floor", (-0.85, 0, -0.32), (0.85, 0.05, 0.26), floor_m))
    b.append(span_box("c_top", (-0.85, 2.1, -0.32), (0.85, 2.2, 0.26), inner))
    # front casing, head (鴨居) and sill (敷居) with two tracks
    b.append(span_box("c_case_l", (-0.9, 0, 0.26), (-0.845, 2.2, 0.355), frame, bevel=0.004))
    b.append(span_box("c_case_r", (0.845, 0, 0.26), (0.9, 2.2, 0.355), frame, bevel=0.004))
    b.append(span_box("c_head", (-0.85, 2.1, 0.26), (0.85, 2.2, 0.355), frame, bevel=0.004))
    b.append(span_box("c_sill", (-0.85, 0, 0.26), (0.85, 0.04, 0.355), frame))
    for z in (0.29, 0.32):
        b.append(span_box("c_groove", (-0.85, 0.0398, z - 0.006), (0.85, 0.0412, z + 0.006), track))
        b.append(span_box("c_groove_top", (-0.85, 2.0988, z - 0.006), (0.85, 2.1002, z + 0.006), track))
    # stains on the back panel / floor
    b.append(plane("c_stain1", 0.32, 0.24, (0.45, 0.62, -0.3194), stain))
    b.append(plane("c_stain2", 0.18, 0.5, (-0.2, 1.3, -0.3194), stain))
    b.append(plane("c_stain3", 0.5, 0.22, (0.1, 0.0508, 0.05), stain, facing="y"))

    # hanger pipe and upper shelf (枕棚)
    b.append(cyl("c_pipe", 0.0125, 1.7, (0, 1.75, -0.03), chrome, verts=8, axis="x"))
    for sx in (-1, 1):
        b.append(cyl("c_flange", 0.028, 0.012, (sx * 0.844, 1.75, -0.03), chrome, verts=10, axis="x"))
    b.append(span_box("c_shelf", (-0.85, 1.87, -0.32), (0.85, 1.89, 0.12), inner))
    b.append(span_box("c_shelf_lip", (-0.85, 1.85, 0.11), (0.85, 1.89, 0.13), frame))
    b.append(blob("c_blanket", (0.56, 0.13, 0.36), (-0.42, 1.955, -0.1), blanket_m, k=0.45, segs=10, rings=6))
    b.append(blob("c_blanket2", (0.5, 0.08, 0.32), (-0.44, 2.055, -0.12), mat("cloth4", "#9f8966", 0.95),
                  k=0.45, segs=10, rings=6))
    b.append(bx("c_shelfbox", (0.44, 0.19, 0.34), (0.36, 1.985, -0.12), card, bevel=0.003, rot=[(-4, "y")]))
    b.append(bx("c_shelfbox_t", (0.452, 0.004, 0.06), (0.36, 2.08, -0.12), tape_m, rot=[(-4, "y")]))

    # clothes on hangers (width along z, thin along x)
    y0, zc = 1.70, -0.03
    garments = [
        (-0.77, 0.07, 1.02, 0.44, "#2a3245"),   # navy long coat
        (-0.67, 0.06, 0.95, 0.46, "#1e1e21"),   # black coat
        (-0.55, 0.08, 0.66, 0.44, "#76787b"),   # grey hoodie
        (-0.44, 0.03, 0.76, 0.42, "#dcdad3"),   # white shirt
        (-0.33, 0.05, 0.70, 0.43, "#9f8966"),   # beige jacket
        (-0.21, 0.03, 0.74, 0.41, "#6f8fae"),   # light blue shirt
        (-0.08, 0.06, 0.82, 0.45, "#3d4a3a"),   # dark green parka
        (0.06, 0.03, 0.62, 0.38, "#7a2f36"),    # dark red cardigan
    ]
    for i, (x, t, L, W, col) in enumerate(garments):
        s = W / 2
        prof = [(-0.24 * s, 0.0), (-s, -0.055), (-1.03 * s, -0.22), (-0.95 * s, -L), (0.95 * s, -L),
                (1.03 * s, -0.22), (s, -0.055), (0.24 * s, 0.0)]
        prof = [(zc + z, y0 + y) for z, y in prof]
        b.append(prism(f"c_cloth{i}", prof, "x", x - t / 2, x + t / 2, mat(f"cloth{i}", col, 0.95)))
        b.append(tube(f"c_hook{i}", [(x, y0 - 0.01, zc), (x, 1.73, zc), (x, 1.758, zc + 0.014),
                                     (x, 1.768, zc + 0.001), (x, 1.764, zc - 0.013), (x, 1.75, zc - 0.019)],
                      0.0022, chrome, sides=4))

    # floor: two plastic drawer cases (left)
    for k, (ya, yb) in enumerate(((0.05, 0.3), (0.3, 0.55))):
        b.append(span_box(f"c_case{k}", (-0.83, ya, -0.3), (-0.38, yb - 0.004, 0.2), case_m, bevel=0.006))
        b.append(span_box(f"c_casefr{k}", (-0.82, ya + 0.015, 0.2), (-0.39, yb - 0.02, 0.212), case_fr, bevel=0.003))
        b.append(span_box(f"c_casegrip{k}", (-0.67, yb - 0.06, 0.211), (-0.54, yb - 0.045, 0.2145), case_grip))
    # cardboard boxes (right of centre)
    b.append(span_box("c_card1", (0.2, 0.05, -0.3), (0.64, 0.4, 0.14), card, bevel=0.004))
    b.append(span_box("c_card1_seam", (0.2, 0.4, -0.085), (0.64, 0.4012, -0.079), card_dk))
    b.append(span_box("c_card1_tape", (0.197, 0.33, -0.112), (0.643, 0.4022, -0.052), tape_m))
    b.append(plane("c_card1_label", 0.15, 0.08, (0.36, 0.27, 0.1406), label_m))
    b.append(plane("c_card1_ink", 0.1, 0.012, (0.35, 0.28, 0.1409), ink))
    b.append(plane("c_card1_ink2", 0.07, 0.01, (0.335, 0.255, 0.1409), ink))
    b.append(bx("c_card2", (0.34, 0.2, 0.28), (0.43, 0.5, -0.1), card, bevel=0.004, rot=[(9, "y")]))
    b.append(bx("c_card2_t", (0.35, 0.004, 0.05), (0.43, 0.6, -0.1), tape_m, rot=[(9, "y")]))
    # stick vacuum leaning in the right corner
    b.append(span_box("c_vac_head", (0.67, 0.05, 0.03), (0.84, 0.095, 0.15), vac, bevel=0.012))
    b.append(tube("c_vac_pole", [(0.76, 0.08, 0.09), (0.785, 1.08, -0.27)], 0.013, vac, sides=6))
    motor = blob("c_vac_motor", (0.075, 0.26, 0.085), (0, 0, 0), vac, k=0.6, segs=8, rings=6)
    rotate(motor, -20, "x")
    motor.location = T(0.776, 0.7, -0.13)
    b.append(motor)
    b.append(cyl("c_vac_ring", 0.03, 0.03, (0.776, 0.86, -0.19), vac_acc, verts=8))
    b.append(span_box("c_vac_grip", (0.765, 1.06, -0.29), (0.805, 1.12, -0.25), pull_in))
    finish(b, "body")

    # sliding doors: door_r on the front rail (z=+0.32), door_l on the rear rail (z=+0.29)
    def door(name, cx, cz, pull_x):
        d = box(name, (0.9, 2.06, 0.025), (cx, 1.07, cz), door_m, bevel=0.004)
        zf = cz + 0.0125
        parts = [d]
        for (xa, xb) in ((cx - 0.45, cx - 0.428), (cx + 0.428, cx + 0.45)):
            parts.append(span_box(name + "_st", (xa, 0.04, zf), (xb, 2.1, zf + 0.0015), door_ln))
        parts.append(span_box(name + "_rt", (cx - 0.45, 2.075, zf), (cx + 0.45, 2.1, zf + 0.0015), door_ln))
        parts.append(span_box(name + "_rb", (cx - 0.45, 0.04, zf), (cx + 0.45, 0.075, zf + 0.0015), door_ln))
        parts.append(span_box(name + "_pr", (pull_x - 0.019, 0.93, zf), (pull_x + 0.019, 1.07, zf + 0.0025), pull_rim, bevel=0.002))
        parts.append(span_box(name + "_pi", (pull_x - 0.012, 0.942, zf + 0.0005), (pull_x + 0.012, 1.058, zf + 0.0032), pull_in))
        return finish(parts, name, origin=(cx, 1.07, cz))
    door("door_r", 0.45, 0.32, 0.815)
    door("door_l", -0.45, 0.29, -0.815)


# ═════════════════════════════════════════════════════════════════════════════
#  bed  (1.0 x 0.85 x 2.05) — head at -Z, 0.18 m gap underneath, messy comforter
# ═════════════════════════════════════════════════════════════════════════════
def build_bed():
    wood = mat("bed_wood", "#7b5636", 0.65)
    wood_dk = mat("bed_wood_dark", "#553923", 0.7)
    slat_m = mat("bed_under", "#2e2117", 0.95)
    sheet = mat("bed_sheet", "#c3cbd2", 0.9)
    cover = mat("futon_cover", "#2a3858", 0.95)
    cover_dk = mat("futon_cover_dark", "#1f2a44", 0.95)
    lining = mat("futon_lining", "#8f9cb5", 0.95)
    pillow_m = mat("pillow", "#e0dcd2", 0.95)
    white = mat("bed_white", "#e6e4de", 0.6)
    b = []
    # headboard with a small shelf top (宮付き)
    b.append(span_box("b_head", (-0.5, 0.18, -1.025), (0.5, 0.8, -0.875), wood, bevel=0.008))
    b.append(span_box("b_head_lip", (-0.5, 0.8, -1.025), (0.5, 0.815, -1.0), wood_dk))
    b.append(plane("b_head_panel", 0.84, 0.24, (0, 0.62, -0.8742), wood_dk))
    b.append(span_box("b_outlet", (0.26, 0.69, -0.875), (0.36, 0.74, -0.869), white, bevel=0.002))
    for x in (0.288, 0.332):
        b.append(span_box("b_outlet_slot", (x - 0.008, 0.705, -0.8692), (x + 0.008, 0.725, -0.8685), slat_m))
    # posts / legs at the four corners
    for xa, xb in ((-0.5, -0.44), (0.44, 0.5)):
        b.append(span_box("b_leg_h", (xa, 0.0, -1.025), (xb, 0.2, -0.965), wood_dk))
        b.append(span_box("b_leg_f", (xa, 0.0, 0.965), (xb, 0.46, 1.025), wood_dk, bevel=0.004))
    # footboard and side rails (bottom edge at y=0.18 → open gap underneath)
    b.append(span_box("b_foot", (-0.44, 0.18, 0.985), (0.44, 0.42, 1.022), wood, bevel=0.005))
    for xa, xb in ((-0.5, -0.47), (0.47, 0.5)):
        b.append(span_box("b_rail", (xa, 0.18, -0.875), (xb, 0.33, 0.965), wood, bevel=0.004))
    b.append(span_box("b_under", (-0.47, 0.235, -0.875), (0.47, 0.26, 0.985), slat_m))
    for i in range(7):
        z = -0.8 + i * 0.29
        b.append(span_box("b_slat", (-0.47, 0.22, z - 0.04), (0.47, 0.235, z + 0.04), wood_dk))
    # mattress (fitted sheet)
    mt = span_box("b_mattress", (-0.468, 0.26, -0.872), (0.468, 0.45, 0.982), sheet)
    apply_bevel(mt, 0.035, segments=2)
    b.append(mt)
    # pillow
    pil = blob("b_pillow", (0.6, 0.14, 0.37), (0, 0, 0), pillow_m, k=0.42, segs=12, rings=6,
               warp=lambda x, y, z: (x, y - 0.04 * math.exp(-((x - 0.05) ** 2 + z * z) / 0.018) * (1 if y > 0 else 0), z))
    rotate(pil, 11, "y")
    pil.location = T(0.04, 0.515, -0.665)
    b.append(pil)

    # comforter: one thick slab draped over both sides, lumpy and pushed toward the foot
    hw, base, r = 0.47, 0.505, 0.05
    nu, nv = 14, 12

    def y_end(z, side):
        if side > 0:   # room side: hangs lower toward the foot
            return 0.34 - 0.11 * smooth(-0.2, 0.7, z) + 0.025 * math.sin(7 * z)
        return 0.37 + 0.02 * math.sin(5 * z + 1)

    def top_pt(u, v):
        s = -0.74 + 1.48 * u
        z = -0.36 + 1.36 * v
        xi = max(-hw, min(hw, s))
        lump = (0.075 * math.exp(-((xi - 0.12) ** 2 / 0.045 + (z - 0.2) ** 2 / 0.06))
                + 0.05 * math.exp(-((xi + 0.2) ** 2 / 0.03 + (z - 0.62) ** 2 / 0.04))
                + 0.035 * math.exp(-((0.7 * xi + 0.7 * (z - 0.42)) ** 2) / 0.004)
                + 0.028 * math.exp(-((0.5 * xi - 0.85 * (z - 0.08)) ** 2) / 0.003)     # second crease
                + 0.045 * math.exp(-((xi - 0.28) ** 2 / 0.012 + (z - 0.82) ** 2 / 0.02))  # kicked-up bump
                + 0.012 * math.sin(9 * z + 3 * xi) * math.cos(7 * xi))
        droop = 0.07 * smooth(0.9, 1.0, v)
        e = abs(s) - hw
        if e <= 0:
            fade = 1.0 - (abs(s) / hw) ** 4
            return Vector((s, base + lump * fade - droop, z))
        side = 1 if s > 0 else -1
        q = e / (0.74 - hw)
        arc = r * math.pi / 2
        total = arc + (base - r - y_end(z, side))
        e2 = q * total
        if e2 < arc:
            th = e2 / r
            x = side * (hw + r * math.sin(th))
            y = base - r * (1 - math.cos(th))
        else:
            x = side * (hw + r)
            y = base - r - (e2 - arc)
        return Vector((x, y - droop * 0.5, z))
    top = [[top_pt(i / nu, j / nv) for i in range(nu + 1)] for j in range(nv + 1)]

    def nrm(i, j):
        a = top[j][min(i + 1, nu)] - top[j][max(i - 1, 0)]
        c = top[min(j + 1, nv)][i] - top[max(j - 1, 0)][i]
        n = c.cross(a)
        return n.normalized() if n.length > 1e-9 else Vector((0, 1, 0))
    bot = [[top[j][i] - nrm(i, j) * 0.05 for i in range(nu + 1)] for j in range(nv + 1)]
    b.append(slab("b_comforter", top, bot, [cover, cover_dk, cover]))
    # folded-back flap at the head end (shows the lining) and the rolled fold
    fu, fv = 8, 3

    def flap_pt(u, v):
        x = -0.47 + 0.94 * u
        z_edge = -0.13 + 0.27 * u + 0.03 * math.sin(7 * u)     # thrown back diagonally
        z = -0.36 + (z_edge + 0.36) * v
        y = (top_pt((x + 0.74) / 1.48, (z + 0.36) / 1.36).y + 0.048 + 0.01 * math.sin(5 * x)
             + 0.03 * v * u * u)                                # free corner lifts a little
        return Vector((x, y, z))
    ftop = [[flap_pt(i / fu, j / fv) for i in range(fu + 1)] for j in range(fv + 1)]
    fbot = [[p - Vector((0, 0.04, 0)) for p in row] for row in ftop]
    b.append(slab("b_flap", ftop, fbot, [lining, cover, cover]))
    b.append(cyl("b_fold", 0.046, 0.94, (0, 0.53, -0.365), cover, verts=10, axis="x"))

    # things on the headboard shelf (y=0.8)
    b.append(span_box("b_clock", (-0.37, 0.8, -1.0), (-0.25, 0.848, -0.955), mat("clock_body", "#3a3b3e", 0.5), bevel=0.004))
    b.append(plane("b_clock_lcd", 0.09, 0.028, (-0.31, 0.826, -0.9546), mat("clock_lcd", "#55665a", 0.3)))
    b.append(bx("b_pills", (0.05, 0.004, 0.1), (0.13, 0.802, -0.955), mat("pill_sheet", "#b9bdc2", 0.35, 0.4), rot=[(25, "y")]))
    b.append(cyl("b_bottle", 0.021, 0.055, (0.24, 0.8275, -0.965), mat("pill_bottle", "#8f5f28", 0.4), verts=10))
    b.append(cyl("b_bottle_cap", 0.022, 0.012, (0.24, 0.861, -0.965), white, verts=10))
    b.append(blob("b_tissue", (0.2, 0.045, 0.11), (-0.04, 0.8225, -0.955), mat("tissue_pack", "#e9e9e6", 0.95), k=0.5, segs=8, rings=4))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  desk  (1.0 x 1.2 x 0.55) — top at 0.72, drawer on the right, monitor, PC on the floor
# ═════════════════════════════════════════════════════════════════════════════
def build_desk():
    top_m = mat("desk_top", "#5e4430", 0.6)
    steel = mat("desk_steel", "#2b2c2e", 0.5, 0.3)
    drawer_m = mat("desk_drawer", "#6b4e37", 0.6)
    drawer_in = mat("desk_drawer_in", "#8a8478", 0.8)
    black = mat("desk_black", "#18191b", 0.4)
    plastic = mat("desk_plastic", "#2e3033", 0.5)
    keys = mat("desk_keys", "#4b4e53", 0.5)
    paper = mat("desk_paper", "#e9e7e0", 0.9)
    sticky = mat("desk_sticky", "#e3cf4a", 0.9)
    lamp_m = mat("desk_lamp", "#d9d8d2", 0.45)
    mug_m = mat("desk_mug", "#26272a", 0.4)
    pad_m = mat("desk_mousepad", "#2c3440", 0.95)
    cable_m = mat("desk_cable", "#151515", 0.6)
    tap_m = mat("desk_tap", "#e2e1dc", 0.5)
    pen_m = mat("desk_pen", "#2b4f8f", 0.5)
    scr = mat("screen_pc", "#050607", 0.25)
    b = []
    b.append(span_box("d_top", (-0.5, 0.69, -0.275), (0.5, 0.72, 0.275), top_m, bevel=0.004))
    for xa, xb in ((-0.5, -0.465), (0.465, 0.5)):
        for za, zb in ((-0.26, -0.225), (0.225, 0.26)):
            b.append(span_box("d_leg", (xa, 0.012, za), (xb, 0.69, zb), steel))
        b.append(span_box("d_foot", (xa, 0.0, -0.268), (xb, 0.03, 0.268), steel, bevel=0.003))
        b.append(span_box("d_side_bar", (xa, 0.645, -0.225), (xb, 0.69, 0.225), steel))
    b.append(span_box("d_back_bar", (-0.465, 0.645, -0.26), (0.465, 0.69, -0.235), steel))
    b.append(span_box("d_low_bar", (-0.465, 0.12, -0.255), (-0.1, 0.15, -0.235), steel))
    # drawer housing
    b.append(span_box("d_dr_bot", (0.135, 0.585, -0.24), (0.465, 0.592, 0.255), steel))
    b.append(span_box("d_dr_side", (0.128, 0.585, -0.24), (0.135, 0.69, 0.255), steel))
    b.append(span_box("d_dr_back", (0.135, 0.592, -0.245), (0.465, 0.69, -0.238), steel))
    # monitor
    b.append(span_box("d_mon_base", (-0.11, 0.7222, -0.235), (0.11, 0.734, -0.075), black, bevel=0.004))
    b.append(span_box("d_mon_neck", (-0.025, 0.734, -0.205), (0.025, 0.9, -0.18), black))
    b.append(span_box("d_mon_back", (-0.15, 0.89, -0.192), (0.15, 1.07, -0.165), plastic, bevel=0.01))
    b.append(span_box("d_mon_panel", (-0.2925, 0.8225, -0.165), (0.2925, 1.1775, -0.145), black, bevel=0.003))
    b.append(plane("d_screen", 0.55, 0.32, (0, 1.006, -0.1438), scr))
    stk = plane("d_sticky", 0.05, 0.05, (0, 0, 0), sticky)
    rotate(stk, 7, "z")
    stk.location = T(-0.245, 0.853, -0.1432)
    b.append(stk)
    # keyboard (rows of keys) + papers
    ky = 0.7225
    b.append(span_box("d_kb", (-0.23, ky, 0.035), (0.19, ky + 0.018, 0.165), plastic, bevel=0.003))
    for k in range(4):
        z = 0.044 + k * 0.024
        b.append(span_box("d_keys", (-0.222, ky + 0.018, z), (0.182, ky + 0.025, z + 0.019), keys))
    for xa, xb in ((-0.222, -0.11), (-0.1, 0.06), (0.07, 0.182)):
        b.append(span_box("d_keys", (xa, ky + 0.018, 0.14), (xb, ky + 0.025, 0.159), keys))
    b.append(bx("d_paper1", (0.21, 0.0015, 0.297), (-0.2, 0.7208, 0.1), paper, rot=[(14, "y")]))
    b.append(bx("d_paper2", (0.21, 0.0015, 0.297), (0.14, 0.7212, -0.05), paper, rot=[(-28, "y")]))
    b.append(bx("d_paper3", (0.18, 0.0015, 0.12), (-0.3, 0.7224, -0.08), mat("desk_paper2", "#d8d3c4", 0.9), rot=[(35, "y")]))
    b.append(bx("d_pen", (0.008, 0.008, 0.14), (-0.1, 0.727, -0.04), pen_m, rot=[(62, "y")]))
    # mouse pad, mouse and its cable
    b.append(span_box("d_pad", (0.2, 0.72, 0.03), (0.39, 0.7232, 0.21), pad_m))
    b.append(blob("d_mouse", (0.058, 0.034, 0.1), (0.3, 0.74, 0.125), plastic, k=0.75, segs=10, rings=6))
    b.append(tube("d_mouse_cable", [(0.3, 0.734, 0.075), (0.29, 0.7255, 0.02), (0.25, 0.725, -0.08),
                                    (0.22, 0.725, -0.2), (0.21, 0.725, -0.262), (0.205, 0.7, -0.281),
                                    (0.215, 0.5, -0.281), (0.25, 0.42, -0.262), (0.27, 0.38, -0.242)],
                  0.0035, cable_m, sides=4))
    # mug (black) near the right front corner
    b.append(lathe("d_mug", [(0.036, 0.0), (0.04, 0.006), (0.04, 0.095), (0.0365, 0.095), (0.035, 0.012)],
                   mug_m, pos=(0.42, 0.72, 0.16), segs=12, cap0="down", cap1="up",
                   mats=[mug_m, mat("coffee", "#2a1a10", 0.2)], cap_mat=(0, 1)))
    b.append(tube("d_mug_handle", [(0.458, 0.795, 0.16), (0.478, 0.79, 0.16), (0.484, 0.76, 0.16),
                                   (0.476, 0.735, 0.16), (0.458, 0.732, 0.16)], 0.006, mug_m, sides=4))
    # desk lamp (back left)
    b.append(cyl("d_lamp_base", 0.06, 0.022, (-0.37, 0.731, -0.17), lamp_m, verts=14))
    b.append(tube("d_lamp_arm1", [(-0.37, 0.742, -0.17), (-0.36, 1.02, -0.215)], 0.008, lamp_m, sides=6))
    b.append(sphere("d_lamp_joint", 0.015, (-0.36, 1.02, -0.215), lamp_m, segs=8, rings=5))
    b.append(tube("d_lamp_arm2", [(-0.36, 1.02, -0.215), (-0.275, 1.15, -0.075)], 0.007, lamp_m, sides=6))
    shade = cyl("d_lamp_shade", 0.055, 0.07, (0, 0, 0), lamp_m, verts=12, radius2=0.024)
    rotate(shade, -38, "x")
    shade.location = T(-0.27, 1.15, -0.058)
    b.append(shade)
    b.append(tube("d_lamp_cable", [(-0.37, 0.726, -0.225), (-0.36, 0.722, -0.27), (-0.35, 0.69, -0.282),
                                   (-0.3, 0.3, -0.282), (-0.24, 0.04, -0.262), (-0.12, 0.012, -0.245)],
                  0.0035, cable_m, sides=4))
    # PC tower on the floor (right) + power strip
    b.append(span_box("d_pc", (0.205, 0.0, -0.24), (0.395, 0.43, 0.18), black, bevel=0.006))
    b.append(span_box("d_pc_vent", (0.218, 0.04, 0.18), (0.382, 0.31, 0.1838), plastic))
    for k in range(6):
        b.append(span_box("d_pc_slit", (0.226, 0.06 + k * 0.04, 0.1838), (0.374, 0.068 + k * 0.04, 0.1846), black))
    b.append(cyl("d_pc_btn", 0.009, 0.004, (0.3, 0.385, 0.182), mat("desk_led_dim", "#3b5f8a", 0.4), verts=10, axis="z"))
    for x in (0.27, 0.33):
        b.append(span_box("d_pc_usb", (x - 0.007, 0.352, 0.18), (x + 0.007, 0.358, 0.1825), mat("usb_port", "#0b0b0c", 0.5)))
    b.append(span_box("d_tap", (-0.12, 0.0, -0.268), (0.16, 0.034, -0.226), tap_m, bevel=0.004))
    for k in range(4):
        b.append(span_box("d_tap_sw", (-0.1 + k * 0.065, 0.034, -0.255), (-0.085 + k * 0.065, 0.04, -0.24),
                          mat("tap_switch", "#d8823a", 0.5)))
    b.append(tube("d_cable_mon", [(0.05, 0.93, -0.193), (0.06, 0.8, -0.24), (0.08, 0.73, -0.271), (0.1, 0.69, -0.281),
                                  (0.2, 0.5, -0.281), (0.29, 0.42, -0.262), (0.31, 0.38, -0.242)], 0.005, cable_m, sides=5))
    b.append(tube("d_cable_pc", [(0.33, 0.12, -0.24), (0.33, 0.06, -0.255), (0.25, 0.02, -0.258), (0.16, 0.017, -0.25)],
                  0.0045, cable_m, sides=4))
    finish(b, "body")

    # drawer (slides +Z 0.3)
    dr = [span_box("drawer", (0.142, 0.598, 0.258), (0.458, 0.686, 0.274), drawer_m, bevel=0.003)]
    dr.append(span_box("dr_handle", (0.25, 0.637, 0.28), (0.35, 0.645, 0.287), steel))
    for x in (0.256, 0.344):
        dr.append(span_box("dr_post", (x - 0.004, 0.637, 0.274), (x + 0.004, 0.645, 0.28), steel))
    dr.append(span_box("dr_bottom", (0.148, 0.598, -0.21), (0.452, 0.604, 0.258), drawer_in))
    dr.append(span_box("dr_side_l", (0.148, 0.604, -0.21), (0.156, 0.665, 0.258), drawer_in))
    dr.append(span_box("dr_side_r", (0.444, 0.604, -0.21), (0.452, 0.665, 0.258), drawer_in))
    dr.append(span_box("dr_back", (0.156, 0.604, -0.21), (0.444, 0.665, -0.202), drawer_in))
    dr.append(bx("dr_env", (0.12, 0.003, 0.23), (0.23, 0.6055, -0.04), paper, rot=[(4, "y")]))
    dr.append(bx("dr_pen1", (0.008, 0.008, 0.14), (0.33, 0.608, 0.05), pen_m, rot=[(8, "y")]))
    dr.append(bx("dr_pen2", (0.008, 0.008, 0.13), (0.35, 0.608, 0.06), mat("desk_pen_red", "#9a2a2a", 0.5), rot=[(-5, "y")]))
    dr.append(span_box("dr_sticky", (0.37, 0.604, -0.14), (0.43, 0.618, -0.08), sticky))
    dr.append(span_box("dr_usb", (0.38, 0.604, 0.12), (0.4, 0.611, 0.165), mat("usb_stick", "#3a3c40", 0.4, 0.3)))
    finish(dr, "drawer", origin=(0.3, 0.65, 0.03))


# ═════════════════════════════════════════════════════════════════════════════
#  chair  (0.55 x 0.95 x 0.55) — black office chair, faces +Z
# ═════════════════════════════════════════════════════════════════════════════
def build_chair():
    blk = mat("chair_black", "#1f2023", 0.55)
    fabric = mat("chair_fabric", "#26272b", 0.95)
    mesh_m = mat("chair_mesh", "#2e3035", 0.9)
    metal = mat("chair_metal", "#8b8f94", 0.35, 0.5)
    caster = mat("chair_caster", "#121213", 0.5)
    b = []
    for i in range(5):
        a = i * 72 + 18
        leg = span_box("ch_leg", (-0.022, 0.055, 0.03), (0.022, 0.09, 0.245), blk, bevel=0.005)
        set_origin(leg, (0, 0.075, 0))
        rotate(leg, a, "y")
        b.append(leg)
        stem = span_box("ch_stem", (-0.009, 0.045, 0.232), (0.009, 0.06, 0.25), caster)
        set_origin(stem, (0, 0.05, 0))
        rotate(stem, a, "y")
        b.append(stem)
        w = cyl("ch_wheel", 0.026, 0.026, (0, 0.026, 0.245), caster, verts=10, axis="x")
        set_origin(w, (0, 0.026, 0))
        rotate(w, a, "y")
        b.append(w)
    b.append(cyl("ch_hub", 0.045, 0.05, (0, 0.085, 0), blk, verts=12))
    b.append(cyl("ch_cover", 0.031, 0.2, (0, 0.2, 0), blk, verts=10, radius2=0.026))
    b.append(cyl("ch_lift", 0.02, 0.13, (0, 0.355, 0), metal, verts=10))
    b.append(span_box("ch_mech", (-0.1, 0.4, -0.12), (0.1, 0.432, 0.1), blk))
    b.append(tube("ch_lever", [(0.09, 0.415, 0.03), (0.19, 0.41, 0.06), (0.215, 0.405, 0.08)], 0.006, blk, sides=5))
    b.append(sphere("ch_knob", 0.013, (0.218, 0.405, 0.083), blk, segs=6, rings=4))
    b.append(span_box("ch_shell", (-0.22, 0.43, -0.2), (0.22, 0.445, 0.21), blk))
    b.append(blob("ch_seat", (0.5, 0.085, 0.47), (0, 0.48, 0.015), fabric, k=0.3, segs=12, rings=6))
    # back support + backrest
    b.append(span_box("ch_bk_bar", (-0.03, 0.42, -0.25), (0.03, 0.445, -0.12), blk))
    b.append(bx("ch_bk_up", (0.07, 0.3, 0.025), (0, 0.59, -0.26), blk, rot=[(-6, "x")]))
    back = blob("ch_back", (0.46, 0.39, 0.075), (0, 0, 0), mesh_m, k=0.35, segs=12, rings=6,
                warp=lambda x, y, z: (x, y, z + 0.06 * (x / 0.23) ** 2))
    rotate(back, -9, "x")
    back.location = T(0, 0.75, -0.235)
    b.append(back)
    b.append(bx("ch_lumbar", (0.4, 0.05, 0.02), (0, 0.66, -0.2), blk, rot=[(-9, "x")]))
    # armrests
    for sx in (-1, 1):
        b.append(span_box("ch_arm_bar", (min(sx * 0.1, sx * 0.25), 0.415, -0.06), (max(sx * 0.1, sx * 0.25), 0.435, -0.02), blk))
        b.append(span_box("ch_arm_post", (sx * 0.252 - 0.014, 0.42, -0.07), (sx * 0.252 + 0.014, 0.64, -0.03), blk))
        b.append(span_box("ch_arm_pad", (sx * 0.25 - 0.026, 0.64, -0.15), (sx * 0.25 + 0.026, 0.665, 0.1), blk, bevel=0.008))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  tv_set  (1.2 x 0.95 x 0.42) — black wood TV board + 32" TV (screen_tv)
# ═════════════════════════════════════════════════════════════════════════════
def build_tv_set():
    rnd = random.Random(7)
    wood = mat("tvb_wood", "#2c2622", 0.55)
    wood_edge = mat("tvb_wood_edge", "#433830", 0.55)
    back_m = mat("tvb_back", "#141211", 0.9)
    tv_black = mat("tv_black", "#141416", 0.35)
    tv_back = mat("tv_back", "#26272a", 0.6)
    scr = mat("screen_tv", "#050607", 0.25)
    console = mat("console_white", "#e4e3de", 0.45)
    dark = mat("tvb_device", "#1c1d1f", 0.5)
    cable_m = mat("tv_cable", "#151515", 0.6)
    dvd_cols = [mat(f"dvd{i}", c, 0.5) for i, c in enumerate(["#2a5a9a", "#c8c4bc", "#8a2a2a", "#1f1f22", "#3f6a3a", "#c49a3a"])]
    b = []
    b.append(span_box("t_top", (-0.6, 0.37, -0.21), (0.6, 0.4, 0.21), wood, bevel=0.004))
    b.append(span_box("t_top_edge", (-0.598, 0.372, 0.21), (0.598, 0.398, 0.2118), wood_edge))
    for xa, xb in ((-0.6, -0.57), (0.57, 0.6)):
        b.append(span_box("t_side", (xa, 0.0, -0.2), (xb, 0.37, 0.2), wood))
        b.append(span_box("t_side_edge", (xa + 0.002, 0.002, 0.2), (xb - 0.002, 0.368, 0.2015), wood_edge))
    b.append(span_box("t_bottom", (-0.57, 0.04, -0.2), (0.57, 0.065, 0.2), wood))
    b.append(span_box("t_plinth", (-0.57, 0.0, -0.19), (0.57, 0.04, 0.17), back_m))
    b.append(span_box("t_back", (-0.57, 0.065, -0.2), (0.57, 0.37, -0.19), back_m))
    b.append(span_box("t_div", (0.14, 0.065, -0.19), (0.16, 0.37, 0.2), wood))
    b.append(span_box("t_shelf", (-0.57, 0.205, -0.19), (0.14, 0.225, 0.2), wood))
    b.append(span_box("t_shelf_edge", (-0.57, 0.206, 0.2), (0.14, 0.224, 0.2015), wood_edge))
    # game console (upper left) — white with a black band and a blue dot
    b.append(span_box("t_console", (-0.52, 0.225, -0.15), (-0.22, 0.29, 0.13), console, bevel=0.006))
    b.append(span_box("t_console_band", (-0.522, 0.252, -0.152), (-0.218, 0.262, 0.132), dark))
    b.append(span_box("t_console_led", (-0.3, 0.27, 0.13), (-0.27, 0.274, 0.132), mat("console_led", "#3a6fd0", 0.4)))
    b.append(span_box("t_game_case", (-0.18, 0.225, -0.1), (-0.045, 0.24, 0.09), mat("game_case", "#2a5aa0", 0.5)))
    # DVD recorder (lower left)
    b.append(span_box("t_recorder", (-0.53, 0.065, -0.17), (-0.08, 0.13, 0.17), dark, bevel=0.004))
    b.append(plane("t_rec_disp", 0.11, 0.022, (-0.2, 0.1, 0.1705), mat("rec_display", "#2a3a33", 0.3)))
    b.append(span_box("t_rec_tray", (-0.48, 0.105, 0.17), (-0.3, 0.109, 0.1712), mat("rec_line", "#0c0c0d", 0.5)))
    for k in range(3):
        b.append(cyl("t_rec_btn", 0.005, 0.003, (-0.12 + k * 0.012, 0.08, 0.171), mat("rec_btn", "#55585c", 0.4), verts=6, axis="z"))
    for k in range(3):   # loose discs lying beside
        b.append(bx("t_dvd_flat", (0.135, 0.015, 0.19), (0.04, 0.0725 + k * 0.015, 0.0), dvd_cols[(k + 2) % 6], rot=[(rnd.uniform(-8, 8), "y")]))
    # DVDs standing in the right compartment, spines to the front
    x = 0.168
    i = 0
    while x < 0.5:
        t = 0.0145
        b.append(span_box("t_dvd", (x, 0.065, 0.17 - 0.135), (x + t, 0.065 + 0.19, 0.17), dvd_cols[rnd.randrange(6)]))
        if i % 3 == 0:
            b.append(span_box("t_dvd_lbl", (x + 0.002, 0.2, 0.17), (x + t - 0.002, 0.23, 0.1706), mat("dvd_label", "#d8d5cc", 0.6)))
        x += t + 0.001
        i += 1
    b.append(bx("t_dvd_lean", (0.0145, 0.19, 0.135), (0.535, 0.155, 0.1), dvd_cols[1], rot=[(-24, "z")]))
    # TV
    b.append(span_box("t_tv_panel", (-0.375, 0.495, -0.01), (0.375, 0.945, 0.04), tv_black, bevel=0.003))
    b.append(plane("t_screen", 0.72, 0.42, (0, 0.72, 0.0406), scr))
    b.append(span_box("t_tv_back", (-0.25, 0.56, -0.06), (0.25, 0.86, -0.01), tv_back, bevel=0.01))
    b.append(span_box("t_tv_neck", (-0.04, 0.4, -0.05), (0.04, 0.53, -0.02), tv_back))
    b.append(span_box("t_tv_foot", (-0.17, 0.4, -0.12), (0.17, 0.412, 0.07), tv_back, bevel=0.003))
    b.append(span_box("t_tv_led", (0.315, 0.499, 0.04), (0.323, 0.503, 0.0412), mat("tv_led", "#7a1a1a", 0.4)))
    b.append(tube("t_tv_cable", [(0.12, 0.62, -0.061), (0.13, 0.47, -0.1), (0.15, 0.406, -0.16), (0.17, 0.404, -0.2),
                                 (0.185, 0.39, -0.214), (0.2, 0.3, -0.214)], 0.005, cable_m, sides=5))
    # a game controller left on the board
    pad = [blob("t_pad", (0.14, 0.035, 0.07), (0, 0.0175, 0), mat("pad_body", "#2b2c30", 0.5), k=0.6, segs=10, rings=5)]
    for sx in (-1, 1):
        pad.append(blob("t_pad_grip", (0.045, 0.03, 0.07), (sx * 0.055, 0.016, 0.035), mat("pad_body"), k=0.8, segs=6, rings=4))
    b.append(group_at(pad, "t_controller", (0.36, 0.4, 0.1), yaw=-18))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  low_table  (0.8 x 0.36 x 0.55) — white top at y=0.36, mug, remote, chu-hi can
# ═════════════════════════════════════════════════════════════════════════════
def build_low_table():
    white = mat("lt_white", "#e8e6e0", 0.45)
    white_dk = mat("lt_white_edge", "#cfccc4", 0.5)
    leg_m = mat("lt_leg", "#c4a074", 0.6)
    remote_m = mat("remote", "#2a2a2c", 0.45)
    btn = mat("remote_btn", "#55585c", 0.5)
    red = mat("remote_red", "#b02a2a", 0.5)
    mug_m = mat("lt_mug", "#e9e8e2", 0.35)
    navy = mat("lt_mug_band", "#2b3a66", 0.4)
    tea = mat("lt_tea", "#4a2e1a", 0.15)
    can_m = mat("can_silver", "#c9d0d5", 0.3, 0.6)
    can_band = mat("can_band", "#d8c94a", 0.4)
    can_top = mat("can_top", "#9aa0a5", 0.3, 0.6)
    mag = [mat("lt_mag1", "#b84a4a", 0.6), mat("lt_mag2", "#3a5a8a", 0.6)]
    b = []
    b.append(span_box("lt_top", (-0.4, 0.33, -0.275), (0.4, 0.36, 0.275), white, bevel=0.01))
    b.append(span_box("lt_apron", (-0.36, 0.295, -0.235), (0.36, 0.33, 0.235), white_dk))
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.append(span_box("lt_leg", (sx * 0.345 - 0.0175, 0.0, sz * 0.215 - 0.0175),
                              (sx * 0.345 + 0.0175, 0.33, sz * 0.215 + 0.0175), leg_m, bevel=0.003))
    b.append(span_box("lt_shelf", (-0.33, 0.07, -0.2), (0.33, 0.085, 0.2), white))
    b.append(bx("lt_mag_a", (0.21, 0.008, 0.28), (-0.15, 0.089, 0.0), mag[0], rot=[(6, "y")]))
    b.append(bx("lt_mag_b", (0.21, 0.008, 0.28), (-0.13, 0.097, 0.01), mag[1], rot=[(-9, "y")]))
    b.append(span_box("lt_tissue", (0.06, 0.085, -0.06), (0.3, 0.165, 0.06), mat("tissue_box", "#e9e7df", 0.8)))
    b.append(blob("lt_tissue_pop", (0.07, 0.05, 0.04), (0.18, 0.18, 0.0), mat("tissue", "#f5f5f2", 1.0), k=0.9, segs=6, rings=4, jitter=0.25, seed=3))
    # mug (white with navy band), with tea
    b.append(lathe("lt_mug", [(0.037, 0.0), (0.041, 0.006), (0.041, 0.035), (0.041, 0.06), (0.041, 0.09), (0.0375, 0.09), (0.036, 0.012)],
                   mug_m, pos=(-0.26, 0.36, -0.12), segs=12, cap0="down", cap1="up",
                   mats=[mug_m, navy, tea], ring_mat=lambda i: 1 if i == 2 else 0, cap_mat=(0, 2)))
    b.append(tube("lt_mug_handle", [(-0.222, 0.435, -0.12), (-0.2, 0.43, -0.12), (-0.194, 0.40, -0.12),
                                    (-0.203, 0.375, -0.12), (-0.222, 0.372, -0.12)], 0.006, mug_m, sides=4))
    # TV remote
    rm = [span_box("lt_remote", (-0.025, 0.0, -0.09), (0.025, 0.02, 0.09), remote_m, bevel=0.005)]
    rm.append(span_box("lt_rm_power", (-0.016, 0.02, -0.078), (-0.004, 0.0235, -0.068), red))
    for k in range(4):
        rm.append(span_box("lt_rm_row", (-0.017, 0.02, -0.045 + k * 0.022), (0.017, 0.0228, -0.035 + k * 0.022), btn))
    rm.append(cyl("lt_rm_pad", 0.011, 0.003, (0, 0.0215, 0.055), btn, verts=8))
    b.append(group_at(rm, "lt_remote_g", (-0.02, 0.36, 0.13), yaw=18))
    # half-drunk chu-hi can
    b.append(lathe("lt_can", [(0.026, 0.0), (0.033, 0.009), (0.033, 0.03), (0.033, 0.09), (0.033, 0.106), (0.0285, 0.12), (0.0275, 0.1225)],
                   can_m, pos=(0.3, 0.36, 0.165), segs=14, cap0="down", cap1="up",
                   mats=[can_m, can_band, can_top], ring_mat=lambda i: 1 if i == 2 else 0, cap_mat=(2, 2)))
    b.append(span_box("lt_can_tab", (0.293, 0.4825, 0.158), (0.307, 0.4845, 0.178), can_top))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  cushion  (0.5 x 0.08 x 0.5) — dusty red zabuton
# ═════════════════════════════════════════════════════════════════════════════
def build_cushion():
    red = mat("zabuton", "#8a3b3b", 0.95)
    red_dk = mat("zabuton_side", "#6c2b2d", 0.95)
    tie = mat("zabuton_tie", "#c8b27a", 0.8)
    tassel = mat("zabuton_tassel", "#a8873e", 0.8)
    n, half, h = 8, 0.24, 0.081

    def puff(x, z):
        px = 1 - abs(x / half) ** 2.6
        pz = 1 - abs(z / half) ** 2.6
        return max(0.0, px * pz) ** 0.42, px, pz

    def top(u, v):   # lens-shaped: both faces puffy, seam band around the edge at y≈0.02
        x, z = (u - 0.5) * 2 * half, (v - 0.5) * 2 * half
        g, px, pz = puff(x, z)
        y = 0.027 + (h - 0.027) * g
        y -= 0.012 * math.exp(-(x * x + z * z) / 0.0015)                       # centre tie dimple
        y -= 0.011 * math.exp(-((x - 0.07) ** 2 + (z + 0.05) ** 2) / 0.012)    # sat-on dent
        return Vector((x * (1 + 0.02 * pz), y, z * (1 + 0.02 * px)))

    def bottom(u, v):
        x, z = (u - 0.5) * 2 * half, (v - 0.5) * 2 * half
        g, px, pz = puff(x, z)
        return Vector((x * (1 + 0.02 * pz), 0.019 - 0.018 * g, z * (1 + 0.02 * px)))
    t = [[top(i / n, j / n) for i in range(n + 1)] for j in range(n + 1)]
    bt = [[bottom(i / n, j / n) for i in range(n + 1)] for j in range(n + 1)]
    b = [slab("cu_body", t, bt, [red, red_dk, red_dk])]
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.append(tube("cu_tassel", [(sx * 0.236, 0.023, sz * 0.236), (sx * 0.25, 0.018, sz * 0.25)], 0.006, tassel,
                          sides=5, r_end=0.0105))
    b.append(span_box("cu_tie1", (-0.016, 0.066, -0.003), (0.016, 0.071, 0.003), tie))
    b.append(span_box("cu_tie2", (-0.003, 0.066, -0.016), (0.003, 0.071, 0.016), tie))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  smartphone  (0.075 x 0.012 x 0.155) — screen_phone on top, white cable
# ═════════════════════════════════════════════════════════════════════════════
def build_smartphone():
    body_m = mat("phone_body", "#1a1b1e", 0.35, 0.2)
    edge_m = mat("phone_edge", "#3a3c40", 0.3, 0.5)
    scr = mat("screen_phone", "#050607", 0.2)
    cam = mat("phone_dark", "#0b0b0c", 0.3)
    cable = mat("phone_cable", "#e8e8e4", 0.6)
    b = [span_box("p_body", (-0.0375, 0.0, -0.0775), (0.0375, 0.0108, 0.0775), body_m, bevel=0.0045)]
    b.append(plane("p_screen", 0.069, 0.149, (0, 0.0113, 0), scr, facing="y"))
    b.append(cyl("p_punch", 0.0025, 0.0006, (0, 0.0116, -0.068), cam, verts=8))
    b.append(span_box("p_btn_pwr", (0.0372, 0.0035, -0.03), (0.0384, 0.0075, -0.012), edge_m))
    b.append(span_box("p_btn_vol", (-0.0384, 0.0035, -0.045), (-0.0372, 0.0075, -0.015), edge_m))
    # charging cable plugged into the bottom end (+z)
    b.append(span_box("p_plug", (-0.0055, 0.0018, 0.0772), (0.0055, 0.0088, 0.096), cable, bevel=0.0015))
    b.append(tube("p_cable", [(0.0, 0.0045, 0.095), (0.0, 0.0028, 0.107), (0.006, 0.0024, 0.12), (0.019, 0.0024, 0.13),
                              (0.033, 0.0024, 0.135)], 0.0022, cable, sides=5))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  color_box  (0.42 x 0.88 x 0.3) — 3-tier white box, books, photo frame (tex_photo)
# ═════════════════════════════════════════════════════════════════════════════
def build_color_box():
    rnd = random.Random(11)
    white = mat("cb_white", "#ebe9e3", 0.6)
    back_m = mat("cb_back", "#cfcbc2", 0.8)
    inner_box = mat("cb_fabric_box", "#8f8577", 0.95)
    frame_m = mat("cb_frame", "#4a3626", 0.6)
    photo = mat("tex_photo", "#ffffff", 0.8)
    book_cols = [mat(f"book{i}", c, 0.8) for i, c in enumerate(
        ["#7a2a2a", "#2b3a5a", "#d9d2bf", "#3a5a3a", "#6a6a6a", "#8a5a2a", "#c9b26a"])]
    band = mat("book_band", "#e9e4d6", 0.8)
    H = 0.70
    b = []
    for xa, xb in ((-0.21, -0.192), (0.192, 0.21)):
        b.append(span_box("cb_side", (xa, 0.0, -0.145), (xb, H, 0.145), white))
    b.append(span_box("cb_top", (-0.192, H - 0.018, -0.145), (0.192, H, 0.145), white))
    b.append(span_box("cb_bottom", (-0.192, 0.012, -0.145), (0.192, 0.03, 0.145), white))
    b.append(span_box("cb_kick", (-0.192, 0.0, 0.12), (0.192, 0.012, 0.135), back_m))
    shelves = [0.244, 0.468]
    for y in shelves:
        b.append(span_box("cb_shelf", (-0.192, y, -0.145), (0.192, y + 0.018, 0.145), white))
    b.append(span_box("cb_back", (-0.21, 0.0, -0.15), (0.21, H, -0.145), back_m))
    # bottom tier: magazines stacked + fabric inner box
    for k in range(4):
        b.append(bx("cb_mag", (0.15, 0.009, 0.21), (-0.1, 0.035 + k * 0.01, 0.0),
                    book_cols[(k * 3) % 7], rot=[(rnd.uniform(-6, 6), "y")]))
    b.append(span_box("cb_inbox", (0.0, 0.03, -0.13), (0.188, 0.215, 0.15), inner_box, bevel=0.006))
    b.append(span_box("cb_inbox_hole", (0.07, 0.17, 0.15), (0.12, 0.19, 0.1508), mat("cb_hole", "#2a2622", 0.9)))

    def book_row(x0, x1, y0, zf, hmin, hmax, tmin, tmax, dmin, dmax):
        x = x0
        while x < x1:
            t = rnd.uniform(tmin, tmax)
            if x + t > x1:
                break
            h = rnd.uniform(hmin, hmax)
            d = rnd.uniform(dmin, dmax)
            m = book_cols[rnd.randrange(7)]
            b.append(span_box("cb_book", (x, y0, zf - d), (x + t, y0 + h, zf), m))
            if rnd.random() < 0.45:
                b.append(span_box("cb_book_band", (x + 0.002, y0 + h * 0.72, zf), (x + t - 0.002, y0 + h * 0.8, zf + 0.0008), band))
            x += t + 0.0015
        return x
    # middle tier: paperbacks and hard covers, two leaning
    y_mid = shelves[0] + 0.018
    xe = book_row(-0.19, 0.06, y_mid, 0.13, 0.15, 0.19, 0.018, 0.04, 0.11, 0.15)
    b.append(bx("cb_book_lean", (0.03, 0.17, 0.13), (xe + 0.04, y_mid + 0.083, 0.06), book_cols[2], rot=[(-18, "z")]))
    b.append(bx("cb_book_lean2", (0.022, 0.15, 0.12), (xe + 0.075, y_mid + 0.072, 0.06), book_cols[5], rot=[(-21, "z")]))
    # top tier: manga volumes + a small tin
    y_top = shelves[1] + 0.018
    book_row(-0.19, 0.08, y_top, 0.12, 0.172, 0.176, 0.017, 0.019, 0.112, 0.112)
    b.append(cyl("cb_tin", 0.04, 0.09, (0.14, y_top + 0.045, 0.02), mat("cb_tin", "#9a3a2a", 0.4, 0.4), verts=12))
    b.append(cyl("cb_tin_lid", 0.041, 0.012, (0.14, y_top + 0.094, 0.02), mat("cb_tin_lid", "#b8b2a6", 0.35, 0.5), verts=12))
    # on top: photo frame (leaning back) and a small cactus
    x0, y0, z0 = -0.06, H, 0.035
    fr = [span_box("cb_frame_back", (x0 - 0.075, y0, z0 - 0.008), (x0 + 0.075, y0 + 0.19, z0), frame_m)]
    fr.append(span_box("cb_frame_l", (x0 - 0.075, y0, z0), (x0 - 0.06, y0 + 0.19, z0 + 0.007), frame_m))
    fr.append(span_box("cb_frame_r", (x0 + 0.06, y0, z0), (x0 + 0.075, y0 + 0.19, z0 + 0.007), frame_m))
    fr.append(span_box("cb_frame_t", (x0 - 0.06, y0 + 0.175, z0), (x0 + 0.06, y0 + 0.19, z0 + 0.007), frame_m))
    fr.append(span_box("cb_frame_b", (x0 - 0.06, y0, z0), (x0 + 0.06, y0 + 0.015, z0 + 0.007), frame_m))
    fr.append(plane("cb_photo", 0.12, 0.16, (x0, y0 + 0.095, z0 + 0.0006), photo))
    frame = finish(fr, "cb_photo_frame", origin=(x0, y0, z0 + 0.007))
    rotate(frame, -12, "x")
    update()
    b.append(frame)
    # strut behind the frame
    back_pt = frame.matrix_world @ T(0, 0.11, -0.008 - 0.007)
    bp = (back_pt.x, back_pt.z, -back_pt.y)
    b.append(tube("cb_strut", [bp, (x0, y0 + 0.004, bp[2] - 0.06)], 0.005, frame_m, sides=4))
    # cactus in a terracotta pot
    b.append(lathe("cb_pot", [(0.026, 0.0), (0.034, 0.05), (0.036, 0.052), (0.03, 0.052), (0.028, 0.04)],
                   mat("cb_pot", "#a85a3a", 0.85), pos=(0.13, H, 0.0), segs=10, cap0="down", cap1="up",
                   mats=[mat("cb_pot"), mat("cb_soil", "#3a2a1e", 1.0)], cap_mat=(0, 1)))
    b.append(blob("cb_cactus", (0.04, 0.075, 0.04), (0.13, H + 0.08, 0.0), mat("cb_cactus", "#3f6a3a", 0.8), k=0.9, segs=8, rings=5))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  trash_can  (0.26 x 0.34 x 0.26) — grey cylinder, crumpled paper and receipts
# ═════════════════════════════════════════════════════════════════════════════
def build_trash_can():
    rnd = random.Random(5)
    grey = mat("trash_grey", "#8b8e91", 0.6)
    grey_dk = mat("trash_grey_dark", "#5d6063", 0.7)
    rim_m = mat("trash_rim", "#a6a9ab", 0.5)
    inner_m = mat("trash_inner", "#707376", 0.7)
    paper = mat("trash_paper", "#e6e3da", 0.95)
    paper2 = mat("trash_paper2", "#c7c1b3", 0.95)
    receipt = mat("trash_receipt", "#f1f0ea", 0.9)
    prof = [(0.112, 0.0), (0.114, 0.012), (0.12, 0.13), (0.128, 0.322), (0.131, 0.334), (0.13, 0.34),
            (0.123, 0.34), (0.121, 0.33), (0.107, 0.022)]
    # rings: 0 = scuffed foot, 3-5 = rolled rim, 6-7 = inside wall
    b = [lathe("tr_can", prof, grey, segs=16, cap0="down", cap1="up", mats=[grey, rim_m, grey_dk, inner_m],
               ring_mat=lambda i: {0: 2, 3: 1, 4: 1, 5: 1, 6: 3, 7: 3}.get(i, 0), cap_mat=(2, 2))]
    # paper fill surface
    segs = 10
    verts = [(0.0, 0.275, 0.0)]
    for rr, yb in ((0.06, 0.27), (0.114, 0.26)):
        for s in range(segs):
            a = 2 * math.pi * s / segs
            verts.append((rr * math.sin(a), yb + rnd.uniform(-0.012, 0.012), rr * math.cos(a)))
    faces = [(0, 1 + s, 1 + (s + 1) % segs) for s in range(segs)]
    for s in range(segs):
        a, c = 1 + s, 1 + (s + 1) % segs
        faces.append((a, a + segs, c + segs, c))
    fill = mesh_from("tr_fill", verts, faces, paper2)
    face_toward(fill, (0, 1, 0))
    b.append(fill)
    balls = [((0.03, 0.305, 0.025), 0.042, paper), ((-0.05, 0.3, -0.03), 0.036, paper2),
             ((0.0, 0.315, -0.06), 0.03, paper), ((-0.045, 0.31, 0.055), 0.032, mat("tissue_w", "#f6f6f4", 1.0)),
             ((0.07, 0.307, -0.045), 0.028, paper), ((-0.08, 0.29, 0.01), 0.026, mat("trash_paper_y", "#e0d48a", 0.9))]
    for i, (p, rr, m) in enumerate(balls):
        b.append(blob(f"tr_ball{i}", (2 * rr, 1.8 * rr, 2 * rr), p, m, k=1.0, segs=7, rings=5, jitter=0.28, seed=20 + i))
    # receipts: curled thin strips
    for i, (p0, ang, ln, curl) in enumerate((((0.045, 0.27, 0.06), 30, 0.12, 0.9), ((-0.02, 0.28, -0.07), 200, 0.1, -1.1))):
        pts, side = [], Vector((math.cos(math.radians(ang)), 0, -math.sin(math.radians(ang))))
        fwd = Vector((math.sin(math.radians(ang)), 0, math.cos(math.radians(ang))))
        rows = []
        for k in range(6):
            t = k / 5
            c = Vector(p0) + fwd * (ln * 0.35 * t) + Vector((0, ln * 0.6 * math.sin(t * 1.4), 0)) \
                + fwd * (curl * 0.025 * math.sin(t * 3.0))
            rows.append([c - side * 0.028, c + side * 0.028])
        b.append(grid(f"tr_receipt{i}", rows, receipt))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  calendar  (0.32 x 0.46 x 0.01) — one sheet, tex_calendar over the whole front
# ═════════════════════════════════════════════════════════════════════════════
def build_calendar():
    tex = mat("tex_calendar", "#ffffff", 0.9)
    back = mat("cal_back", "#cfcabd", 0.9)
    pages = mat("cal_pages", "#ece9e0", 0.9)
    pin = mat("cal_pin", "#c0302a", 0.4)
    b = [span_box("cal_back", (-0.16, 0.0, -0.005), (0.16, 0.46, -0.0025), back)]
    b.append(span_box("cal_pages", (-0.158, 0.003, -0.0025), (0.158, 0.457, -0.0002), pages))
    b.append(plane("cal_front", 0.32, 0.46, (0.0, 0.23, 0.0), tex))
    b.append(cyl("cal_pin", 0.0065, 0.005, (0.0, 0.442, 0.0025), pin, verts=8, axis="z"))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  aircon  (0.8 x 0.28 x 0.24) — wall unit, origin bottom centre, louver part
# ═════════════════════════════════════════════════════════════════════════════
def build_aircon():
    white = mat("ac_white", "#ecebe6", 0.45)
    side_m = mat("ac_side", "#dcdbd4", 0.5)
    louver_m = mat("ac_louver", "#dedcd5", 0.45)
    inner = mat("ac_inner", "#3a3d40", 0.7)
    mold = mat("ac_mold", "#2a2d2a", 0.9)
    seam = mat("ac_seam", "#b9b8b1", 0.5)
    dark = mat("ac_window", "#2a3034", 0.3)
    led = mat("emit_led", "#1d5a2a", 0.4, emit="#3cff6a", emit_strength=1.0)
    led_off = mat("ac_led_off", "#5a3a1a", 0.4)
    prof = [(-0.12, 0.0), (-0.04, 0.0), (-0.04, 0.014), (-0.025, 0.014), (-0.025, 0.062), (0.058, 0.05),
            (0.058, 0.014), (0.075, 0.014), (0.075, 0.0), (0.09, 0.0), (0.106, 0.016), (0.116, 0.045),
            (0.12, 0.09), (0.12, 0.18), (0.116, 0.215), (0.105, 0.243), (0.085, 0.264), (0.055, 0.278),
            (0.03, 0.28), (-0.12, 0.28)]
    solid = [(-0.12, 0.0), (0.09, 0.0)] + [p for p in prof[10:]]
    b = []
    body = prism("ac_body", prof, "x", -0.385, 0.385, white)
    # cavity faces of the outlet → dark
    paint(body, inner, lambda c, n: -0.041 < c[2] < 0.076 and 0.0 < c[1] < 0.065 and abs(n[0]) < 0.5)
    b.append(body)
    for xa, xb in ((-0.4, -0.385), (0.385, 0.4)):
        b.append(prism("ac_end", solid, "x", xa, xb, side_m))
    # inner end walls of the outlet and vertical vanes
    for xa, xb in ((-0.385, -0.34), (0.34, 0.385)):
        b.append(span_box("ac_outlet_end", (xa, 0.0, -0.04), (xb, 0.062, 0.075), white))
    for k in range(9):
        x = -0.28 + k * 0.07
        b.append(span_box("ac_vane", (x - 0.002, 0.016, -0.018), (x + 0.002, 0.055, 0.052), inner))
    b.append(plane("ac_mold1", 0.12, 0.05, (-0.1, 0.0605, 0.017), mold, facing="y"))
    # front details: seam grooves, display window, LEDs
    b.append(span_box("ac_seam1", (-0.385, 0.088, 0.1185), (0.385, 0.092, 0.1215), seam))
    b.append(span_box("ac_seam2", (-0.385, 0.247, 0.1015), (0.385, 0.25, 0.1065), seam))
    b.append(plane("ac_win", 0.085, 0.018, (0.3, 0.125, 0.1204), dark))
    b.append(plane("ac_led_on", 0.008, 0.005, (0.272, 0.125, 0.1207), led))
    b.append(plane("ac_led_tmr", 0.008, 0.005, (0.288, 0.125, 0.1207), led_off))
    b.append(plane("ac_dust", 0.7, 0.012, (0.0, 0.0905, 0.1203), mat("ac_dust", "#c8c6bc", 0.8)))
    finish(b, "body")
    # louver: covers the outlet when closed; pivot on its back edge, rotX +35 swings the front edge down
    lv = [span_box("louver", (-0.345, 0.003, -0.038), (0.345, 0.0125, 0.073), louver_m, bevel=0.002)]
    lv.append(span_box("lv_edge", (-0.345, 0.0028, 0.06), (0.345, 0.0035, 0.073), mat("ac_lv_dirt", "#c5c3ba", 0.6)))
    finish(lv, "louver", origin=(0.0, 0.0078, -0.038))


# ═════════════════════════════════════════════════════════════════════════════
#  window_sliding  (2.2 x 2.0 x 0.12) — aluminium sash, pane_r slides -X
# ═════════════════════════════════════════════════════════════════════════════
def build_window_sliding():
    alu = mat("sash_alu", "#a9adb0", 0.4, 0.35)
    alu_dk = mat("sash_alu_dark", "#7c8084", 0.45, 0.35)
    glass = mat("glass", "#a8bcc4", 0.05)
    gasket = mat("sash_gasket", "#1e1f20", 0.7)
    dirt = mat("sash_dirt", "#5f5a50", 0.95)
    lock_m = mat("crescent", "#c4c6c8", 0.3, 0.5)
    b = []
    b.append(span_box("w_sill", (-1.1, 0.0, -0.06), (1.1, 0.035, 0.06), alu))
    for z in (-0.02, 0.02):
        b.append(span_box("w_rail", (-1.065, 0.035, z - 0.003), (1.065, 0.046, z + 0.003), alu_dk))
    b.append(span_box("w_sill_dirt1", (-1.065, 0.0352, -0.058), (1.065, 0.0362, -0.03), dirt))
    b.append(span_box("w_sill_dirt2", (-1.065, 0.0352, -0.012), (1.065, 0.0362, 0.012), dirt))
    b.append(span_box("w_head", (-1.1, 1.955, -0.06), (1.1, 2.0, 0.06), alu))
    for z in (-0.02, 0.02):
        b.append(span_box("w_head_groove", (-1.065, 1.953, z - 0.016), (1.065, 1.9552, z + 0.016), gasket))
    for xa, xb in ((-1.1, -1.065), (1.065, 1.1)):
        b.append(span_box("w_jamb", (xa, 0.035, -0.06), (xb, 1.955, 0.06), alu))
    finish(b, "body")

    def pane(name, x0, x1, zc, meet_left):
        zs = (zc - 0.014, zc + 0.014)
        parts = [span_box(name, (x0, 0.046, zs[0]), (x1, 0.096, zs[1]), alu)]   # bottom rail (first → keeps the name)
        parts.append(span_box(name + "_top", (x0, 1.91, zs[0]), (x1, 1.946, zs[1]), alu))
        ml, mr = (0.035, 0.035)
        parts.append(span_box(name + "_stl", (x0, 0.096, zs[0]), (x0 + ml, 1.91, zs[1]), alu))
        parts.append(span_box(name + "_str", (x1 - mr, 0.096, zs[0]), (x1, 1.91, zs[1]), alu))
        gx0, gx1, gy0, gy1 = x0 + ml, x1 - mr, 0.096, 1.91
        parts.append(plane(name + "_glass", gx1 - gx0, gy1 - gy0, ((gx0 + gx1) / 2, (gy0 + gy1) / 2, zc), glass))
        g = 0.007
        for (p0, p1) in (((gx0, gy0, zc - 0.004), (gx1, gy0 + g, zc + 0.004)), ((gx0, gy1 - g, zc - 0.004), (gx1, gy1, zc + 0.004)),
                         ((gx0, gy0, zc - 0.004), (gx0 + g, gy1, zc + 0.004)), ((gx1 - g, gy0, zc - 0.004), (gx1, gy1, zc + 0.004))):
            parts.append(span_box(name + "_gk", p0, p1, gasket))
        # finger grip on the outer stile (room side = -z)
        gx = x1 - 0.0175 if meet_left else x0 + 0.0175
        parts.append(span_box(name + "_grip", (gx - 0.007, 0.85, zs[0] - 0.002), (gx + 0.007, 1.15, zs[0]), alu_dk))
        return parts
    # fixed left pane on the rear (room-side) rail with the crescent lock
    pl = pane("pane_l", -1.07, 0.01, -0.02, meet_left=False)
    zr = -0.02 - 0.014
    pl.append(span_box("pl_lock_base", (-0.022, 0.97, zr - 0.009), (0.004, 1.03, zr), lock_m, bevel=0.002))
    cres = prism("pl_crescent", [(math.cos(a) * 0.022, math.sin(a) * 0.022) for a in
                                 [math.radians(d) for d in range(-80, 81, 20)]], "z", zr - 0.014, zr - 0.009, lock_m)
    cres.location = T(-0.004, 1.0, 0.0)
    pl.append(cres)
    pl.append(bx("pl_lever", (0.01, 0.05, 0.008), (-0.014, 1.03, zr - 0.017), lock_m, rot=[(25, "z")]))
    finish(pl, "pane_l", origin=(-0.53, 1.0, -0.02))
    # sliding right pane on the front rail (opens toward -X)
    pr = pane("pane_r", -0.01, 1.07, 0.02, meet_left=True)
    pr.append(span_box("pr_keeper", (0.012, 0.985, -0.004), (0.03, 1.015, 0.006), lock_m))
    finish(pr, "pane_r", origin=(0.53, 1.0, 0.02))


# ═════════════════════════════════════════════════════════════════════════════
#  curtains  (2.4 x 2.25 x 0.12) — rail + two pleated blackout curtains (scaleX parts)
# ═════════════════════════════════════════════════════════════════════════════
def build_curtains():
    rail_m = mat("curtain_rail", "#dedad0", 0.5)
    bracket = mat("curtain_bracket", "#c9c5bb", 0.5)
    ca = mat("curtain_a", "#2c3549", 0.95)
    cb = mat("curtain_b", "#222a3b", 0.95)
    head = mat("curtain_head", "#3b4458", 0.9)
    hem = mat("curtain_hem", "#1b2130", 0.95)
    hook = mat("curtain_hook", "#d9d6cc", 0.5)
    b = [span_box("cr_rail", (-1.2, 2.2, -0.012), (1.2, 2.224, 0.016), rail_m, bevel=0.003)]
    for sx in (-1, 1):
        b.append(span_box("cr_cap", (sx * 1.2 - 0.012 if sx > 0 else -1.2, 2.196, -0.016), (1.2 if sx > 0 else -1.188, 2.228, 0.02), rail_m))
    for x in (-1.0, 0.0, 1.0):
        b.append(span_box("cr_bracket", (x - 0.012, 2.205, -0.06), (x + 0.012, 2.25, -0.008), bracket))
    finish(b, "body")
    rows_y = [2.19, 2.12, 1.55, 0.9, 0.3, 0.12, 0.02]

    def curtain(name, xa, xb, zc, seed, pivot_x):
        rnd = random.Random(seed)
        N = 12
        rows = []
        for j, y in enumerate(rows_y):
            amp = 0.016 if j == 0 else 0.028 + 0.01 * (1 - y / 2.12)
            row = []
            for i in range(N + 1):
                u = i / N
                x = xa + (xb - xa) * u
                jx = 0.0 if j < 2 or i in (0, N) else rnd.uniform(-0.012, 0.012) * (1 - y / 2.2)
                z = zc + (amp if i % 2 == 0 else -amp) + (rnd.uniform(-0.004, 0.004) if j > 1 else 0.0)
                row.append(Vector((x + jx, y, z)))
            rows.append(row)

        def fm(i, j):
            if j == 0:
                return 2
            if j == len(rows_y) - 2:
                return 3
            return i % 2
        c = grid(name, rows, ca, mats=[ca, cb, head, hem], fmat=fm)
        face_toward(c, (0, 0, 1))
        parts = [c]
        for i in range(0, N + 1, 2):
            x = xa + (xb - xa) * i / N
            parts.append(span_box(name + "_hook", (x - 0.006, 2.185, -0.004), (x + 0.006, 2.205, 0.012), hook))
        return finish(parts, name, origin=(pivot_x, 2.2, 0.0))
    curtain("curtain_l", -1.2, 0.025, 0.01, 3, -1.2)
    curtain("curtain_r", -0.025, 1.2, 0.02, 4, 1.2)


# ═════════════════════════════════════════════════════════════════════════════
#  balcony_rail  (4.0 x 1.1 x 0.08) — aluminium railing with vertical bars
# ═════════════════════════════════════════════════════════════════════════════
def build_balcony_rail():
    rnd = random.Random(9)
    alu = mat("rail_alu", "#a3a7aa", 0.45, 0.35)
    alu_dk = mat("rail_alu_dark", "#7e8285", 0.5, 0.35)
    grime = mat("rail_grime", "#5c5a54", 0.9)
    b = [span_box("r_top", (-2.0, 1.055, -0.04), (2.0, 1.1, 0.04), alu, bevel=0.006)]
    b.append(span_box("r_top_grime", (-2.0, 1.054, -0.035), (2.0, 1.0545, 0.035), grime))
    b.append(span_box("r_mid", (-2.0, 1.0, -0.02), (2.0, 1.025, 0.02), alu_dk))
    b.append(span_box("r_bot", (-2.0, 0.08, -0.025), (2.0, 0.11, 0.025), alu_dk))
    b.append(span_box("r_bot_grime", (-2.0, 0.1102, -0.02), (2.0, 0.1108, 0.02), grime))
    for x in (-1.975, 0.0, 1.975):   # end posts stay inside ±2.0 so neighbouring rails never overlap
        hb = 0.025 if x else 0.04
        b.append(span_box("r_post", (x - 0.022, 0.0, -0.03), (x + 0.022, 1.055, 0.03), alu))
        b.append(span_box("r_post_base", (x - hb, 0.0, -0.035), (x + hb, 0.012, 0.035), alu_dk))
    x = -1.94
    while x < 1.95:
        if abs(x) > 0.035:
            m = grime if rnd.random() < 0.08 else (alu_dk if rnd.random() < 0.2 else alu)
            b.append(span_box("r_bar", (x - 0.007, 0.11, -0.012), (x + 0.007, 1.0, 0.012), m))
        x += 0.11
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  ac_outdoor  (0.75 x 0.56 x 0.28) — outdoor unit with a round fan grille
# ═════════════════════════════════════════════════════════════════════════════
def build_ac_outdoor():
    shell = mat("aco_shell", "#e2ded2", 0.6)
    base_m = mat("aco_base", "#9c998f", 0.6)
    dark = mat("aco_dark", "#25272a", 0.8)
    fan_m = mat("aco_fan", "#3d4044", 0.6)
    grille = mat("aco_grille", "#2d2f32", 0.6)
    fin_a = mat("aco_fin_a", "#5b6064", 0.6, 0.3)
    fin_b = mat("aco_fin_b", "#8b9093", 0.5, 0.3)
    label = mat("aco_label", "#cdd1d2", 0.5)
    pipe = mat("aco_pipe", "#d8d0b8", 0.8)
    dust = mat("aco_dust", "#bdb8a8", 0.9)
    block = mat("aco_block", "#202122", 0.8)
    rust = mat("aco_rust", "#7a5a3a", 0.9)
    cx, cy, rr = -0.1, 0.31, 0.18
    b = []
    for x in (-0.28, 0.28):
        b.append(span_box("aco_block", (x - 0.05, 0.0, -0.14), (x + 0.05, 0.06, 0.14), block))
    b.append(span_box("aco_back", (-0.375, 0.06, -0.14), (0.375, 0.56, 0.04), shell, bevel=0.006))
    b.append(span_box("aco_baseband", (-0.377, 0.06, -0.142), (0.377, 0.085, 0.132), base_m))
    b.append(panel_hole("aco_front", -0.375, 0.375, 0.085, 0.56, cx, cy, rr, 0.04, 0.13, shell, dark, segs=20))
    b.append(cyl("aco_chamber", rr, 0.004, (cx, cy, 0.042), dark, verts=20, axis="z"))
    # fan
    b.append(cyl("aco_hub", 0.04, 0.035, (cx, cy, 0.075), fan_m, verts=10, axis="z"))
    for k in range(3):
        bl = bx("aco_blade", (0.13, 0.085, 0.005), (cx + 0.095, cy, 0.075), fan_m, rot=[(25, "x")])
        rot_world(bl, k * 120 + 15, "z", (cx, cy, 0.075))
        b.append(bl)
    # grille: rings + spokes in front of the hole
    for rad in (0.06, 0.115, 0.17):
        b.append(ring_tube("aco_ring", (cx, cy, 0.135), rad, 0.0045, grille, segs=18, sides=3))
    for k in range(4):
        sp = bx("aco_spoke", (0.36, 0.012, 0.008), (cx, cy, 0.134), grille)
        rotate(sp, 45 + k * 45, "z")
        b.append(sp)
    b.append(cyl("aco_cap", 0.03, 0.01, (cx, cy, 0.135), grille, verts=10, axis="z"))
    # right part of the front: label plate and vent slits
    b.append(plane("aco_label", 0.11, 0.06, (0.25, 0.47, 0.1306), label))
    b.append(plane("aco_label_txt", 0.08, 0.008, (0.245, 0.48, 0.1309), dark))
    for k in range(6):
        b.append(plane("aco_vent", 0.15, 0.009, (0.25, 0.17 + k * 0.03, 0.1306), dark))
    # right side: valve cover and insulated pipes
    b.append(span_box("aco_valve", (0.375, 0.12, -0.12), (0.392, 0.3, 0.02), shell, bevel=0.003))
    b.append(tube("aco_pipe1", [(0.386, 0.16, -0.03), (0.386, 0.1, -0.035), (0.386, 0.075, -0.07), (0.386, 0.07, -0.142)], 0.011, pipe, sides=6))
    b.append(tube("aco_pipe2", [(0.386, 0.2, -0.08), (0.386, 0.13, -0.09), (0.386, 0.1, -0.115), (0.386, 0.096, -0.142)], 0.009, pipe, sides=6))
    # back and left: heat-exchanger fins (alternating stripes) + guard wires
    rows, n = [], 18
    for k in range(n + 1):
        y = 0.1 + k * (0.43 / n)
        rows.append([Vector((0.3, y, -0.1405)), Vector((-0.36, y, -0.1405))])
    fins = grid("aco_fins", rows, fin_a, mats=[fin_a, fin_b], fmat=lambda i, j: j % 2)
    face_toward(fins, (0, 0, -1))
    b.append(fins)
    rows = []
    for k in range(n + 1):
        y = 0.1 + k * (0.43 / n)
        rows.append([Vector((-0.3755, y, -0.13)), Vector((-0.3755, y, 0.02))])
    lfins = grid("aco_lfins", rows, fin_a, mats=[fin_a, fin_b], fmat=lambda i, j: j % 2)
    face_toward(lfins, (-1, 0, 0))
    b.append(lfins)
    for y in (0.2, 0.33, 0.46):
        b.append(span_box("aco_guard", (-0.36, y - 0.003, -0.146), (0.3, y + 0.003, -0.141), grille))
    # dust on top, rust streaks at the bottom corners
    b.append(plane("aco_dust", 0.66, 0.15, (0.0, 0.5602, -0.02), dust, facing="y"))
    b.append(plane("aco_rust1", 0.05, 0.06, (-0.33, 0.115, 0.1304), rust))
    b.append(plane("aco_rust2", 0.04, 0.05, (0.34, 0.11, 0.1304), rust))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
#  laundry_pole  (2.0 x 1.8 x 0.3) — stands, pole, hangers, pinch hanger
# ═════════════════════════════════════════════════════════════════════════════
def build_laundry_pole():
    base_m = mat("lp_base", "#3e4044", 0.7)
    steel = mat("lp_steel", "#b9bec2", 0.35, 0.45)
    holder = mat("lp_holder", "#7e8287", 0.6)
    cap = mat("lp_cap", "#3a6ea5", 0.5)
    pole_m = mat("lp_pole", "#c7ced2", 0.3, 0.45)
    hcols = [mat("hanger_blue", "#7fb0d8", 0.5), mat("hanger_white", "#e6e6e2", 0.5), mat("hanger_pink", "#d89aaa", 0.5)]
    pinch_m = mat("pinch_frame", "#8cc0d8", 0.5)
    pin_cols = [mat("pin_white", "#e7e3d6", 0.5), mat("pin_pink", "#e8a3b5", 0.5), mat("pin_mint", "#8fd0c8", 0.5)]
    towel_m = mat("towel", "#c4c2b9", 0.95)
    sock_m = mat("sock", "#2c2c30", 0.95)
    b = []
    py = 1.65
    for sx in (-1, 1):
        x = sx * 0.88
        b.append(span_box("lp_base", (x - 0.12, 0.0, -0.15), (x + 0.12, 0.07, 0.15), base_m, bevel=0.012))
        b.append(cyl("lp_post", 0.016, 1.72, (x, 0.07 + 0.86, 0), steel, verts=8))
        b.append(cyl("lp_post_cap", 0.019, 0.02, (x, 1.79, 0), holder, verts=8))
        for hy in (py, 1.5):
            b.append(span_box("lp_hold_b", (x - 0.02, hy - 0.03, -0.028), (x + 0.02, hy - 0.016, 0.03), holder))
            for zz in (-0.028, 0.03):
                b.append(span_box("lp_hold_p", (x - 0.02, hy - 0.03, zz - 0.006), (x + 0.02, hy + 0.025, zz), holder))
    b.append(cyl("lp_pole", 0.016, 1.96, (0, py, 0), pole_m, verts=10, axis="x"))
    for sx in (-1, 1):
        b.append(cyl("lp_pole_cap", 0.018, 0.022, (sx * 0.989, py, 0), cap, verts=10, axis="x"))

    def hook_pts(x, y_bot):
        return [(x, y_bot, 0.0), (x, py - 0.04, 0.0), (x, py - 0.008, 0.021), (x, py + 0.023, 0.009),
                (x, py + 0.025, -0.008), (x, py + 0.008, -0.022), (x, py - 0.008, -0.02)]
    # three empty plastic hangers
    for i, (x, m) in enumerate(((-0.55, hcols[0]), (-0.31, hcols[1]), (0.6, hcols[2]))):
        b.append(tube(f"lp_hhook{i}", hook_pts(x, py - 0.065), 0.0025, steel, sides=4))
        top_y, sh_y, bar_y, w = py - 0.07, py - 0.155, py - 0.165, 0.2
        for (xa, ya, xb, yb) in ((x, top_y, x - w, sh_y), (x, top_y, x + w, sh_y)):
            ln = math.hypot(xb - xa, yb - ya)
            ang = math.degrees(math.atan2(yb - ya, xb - xa))
            b.append(bx(f"lp_harm{i}", (ln, 0.014, 0.008), ((xa + xb) / 2, (ya + yb) / 2, 0.0), m, rot=[(ang, "z")]))
        b.append(span_box(f"lp_hbar{i}", (x - w, bar_y - 0.006, -0.004), (x + w, bar_y + 0.006, 0.004), m))
        b.append(span_box(f"lp_hcap{i}", (x - 0.025, top_y - 0.012, -0.007), (x + 0.025, top_y + 0.01, 0.007), m))
    # pinch hanger with clothes pegs, a towel and a forgotten sock
    px, fy = 0.12, 1.36
    b.append(tube("lp_phook", hook_pts(px, fy + 0.07), 0.003, pinch_m, sides=4))
    b.append(span_box("lp_pstem", (px - 0.008, fy, -0.008), (px + 0.008, fy + 0.075, 0.008), pinch_m))
    hw, hd = 0.22, 0.13
    for (p0, p1) in (((px - hw, fy - 0.006, -hd), (px + hw, fy + 0.006, -hd + 0.012)),
                     ((px - hw, fy - 0.006, hd - 0.012), (px + hw, fy + 0.006, hd)),
                     ((px - hw, fy - 0.006, -hd), (px - hw + 0.012, fy + 0.006, hd)),
                     ((px + hw - 0.012, fy - 0.006, -hd), (px + hw, fy + 0.006, hd)),
                     ((px - hw, fy - 0.004, -0.005), (px + hw, fy + 0.004, 0.005)),
                     ((px - 0.005, fy - 0.004, -hd), (px + 0.005, fy + 0.004, hd))):
        b.append(span_box("lp_pframe", p0, p1, pinch_m))
    k = 0
    for zz in (-hd + 0.006, hd - 0.006):
        for i in range(6):
            x = px - hw + 0.03 + i * (2 * hw - 0.06) / 5
            b.append(span_box("lp_pin", (x - 0.006, fy - 0.058, zz - 0.009), (x + 0.006, fy - 0.006, zz + 0.009), pin_cols[k % 3]))
            k += 1
    # towel hanging from two front pegs
    tx0, tx1 = px - 0.14, px + 0.11
    rows = []
    for j in range(5):
        y = fy - 0.045 - j * 0.085
        rows.append([Vector((tx0 + (tx1 - tx0) * i / 3, y, hd - 0.004 + 0.012 * math.sin(i * 2.1 + j) * (j / 4)))
                     for i in range(4)])
    tw = grid("lp_towel", rows, towel_m)
    face_toward(tw, (0, 0, 1))
    b.append(tw)
    b.append(span_box("lp_sock", (px + 0.13, fy - 0.24, -hd - 0.004), (px + 0.17, fy - 0.045, -hd + 0.012), sock_m))
    b.append(bx("lp_sock_toe", (0.04, 0.03, 0.016), (px + 0.16, fy - 0.245, -hd + 0.004), sock_m, rot=[(-30, "z")]))
    finish(b, "body")


# ═════════════════════════════════════════════════════════════════════════════
if only_requested("closet"):
    run_model("closet", build_closet)
if only_requested("bed"):
    run_model("bed", build_bed)
if only_requested("desk"):
    run_model("desk", build_desk)
if only_requested("chair"):
    run_model("chair", build_chair)
if only_requested("tv_set"):
    run_model("tv_set", build_tv_set)
if only_requested("low_table"):
    run_model("low_table", build_low_table)
if only_requested("cushion"):
    run_model("cushion", build_cushion)
if only_requested("smartphone"):
    run_model("smartphone", build_smartphone)
if only_requested("color_box"):
    run_model("color_box", build_color_box)
if only_requested("trash_can"):
    run_model("trash_can", build_trash_can)
if only_requested("calendar"):
    run_model("calendar", build_calendar)
if only_requested("aircon"):
    run_model("aircon", build_aircon)
if only_requested("window_sliding"):
    run_model("window_sliding", build_window_sliding)
if only_requested("curtains"):
    run_model("curtains", build_curtains)
if only_requested("balcony_rail"):
    run_model("balcony_rail", build_balcony_rail)
if only_requested("ac_outdoor"):
    run_model("ac_outdoor", build_ac_outdoor)
if only_requested("laundry_pole"):
    run_model("laundry_pole", build_laundry_pole)
