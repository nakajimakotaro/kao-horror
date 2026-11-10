"""Characters (NPCs) — PS1/PS2-style low-poly people.

npc_nao, npc_nao_sit, npc_neighbor, npc_clerk, npc_shrine, npc_extra

Run (from the project root):
  Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/characters.py -- --preview
  Blender ... -P tools/blender/models/characters.py -- --only npc_nao,npc_nao_sit --preview

All coordinates are three.js terms (x right, y up, z = front). See tools/blender/common.py.
Conventions (src/world/catalog.json):
  * front = +z, origin = on the floor between the feet (sitting pose: centre of the footprint).
  * everything from the neck up lives under an empty called "head" whose origin is the base of
    the neck; three.js turns head.rotation.y so the NPC looks at the player. Hair and face meshes
    are its children. The body is one mesh called "body".
  * npc_nao / npc_nao_sit: the phone screen material is "emit_phone" (three switches its glow).
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import *  # noqa: E402,F401,F403
import rig_pose  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402


# ═════════════════════════════════════════════════════════════════════════════
#  geometry helpers (everything in three.js coordinates)
# ═════════════════════════════════════════════════════════════════════════════
def V(x, y=None, z=None):
    if y is None:
        return Vector(x)
    return Vector((x, y, z))


def lerp(a, b, t):
    return a + (b - a) * t


def newell(pts):
    """Polygon normal (right-hand rule over the given vertex order)."""
    n = Vector((0.0, 0.0, 0.0))
    k = len(pts)
    for i in range(k):
        a, b = pts[i], pts[(i + 1) % k]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


def rot3(*steps):
    """3x3 rotation from [(deg, 'x'|'y'|'z'), ...] applied in order (three.js axes)."""
    m = Matrix.Identity(3)
    for deg, ax in steps:
        m = Matrix.Rotation(math.radians(deg), 3, ax.upper()) @ m
    return m


def frame_rot(y_axis, x_hint):
    """3x3 rotation whose local +y is `y_axis` and local +x is as close to `x_hint` as possible."""
    Y = Vector(y_axis).normalized()
    X = Vector(x_hint)
    X = (X - Y * X.dot(Y)).normalized()
    Z = X.cross(Y)
    return Matrix((X, Y, Z)).transposed()


def make_mesh(name, verts, faces, mats, fmat=None, smooth=True):
    mats = mats if isinstance(mats, (list, tuple)) else [mats]
    o = mesh_from(name, [tuple(v) for v in verts], faces, mats[0])
    for m_ in mats[1:]:
        o.data.materials.append(m_)
    if fmat:
        for p, i in zip(o.data.polygons, fmat):
            p.material_index = i
    for p in o.data.polygons:
        p.use_smooth = smooth
    return o


def merge_close(o, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return o


def loft(name, rings, mats, closed=True, cap0=None, cap1=None, centers=None, fmat=None, capmat=0,
         smooth=True, merge=False):
    """Skin consecutive rings (lists of points, equal length). Faces are oriented away from the
    ring centres. cap0/cap1: None | 'flat' (one n-gon) | a point (triangle fan to that apex)."""
    R = [[Vector(p) for p in r] for r in rings]
    n = len(R[0])
    C = [Vector(c) for c in centers] if centers else [sum(r, Vector()) / n for r in R]
    verts = [p for r in R for p in r]
    faces, fm = [], []
    segs = n if closed else n - 1
    for i in range(len(R) - 1):
        axis = (C[i] + C[i + 1]) * 0.5
        for j in range(segs):
            j2 = (j + 1) % n
            f = [i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j]
            pts = [verts[k] for k in f]
            cen = sum(pts, Vector()) * 0.25
            if newell(pts).dot(cen - axis) < 0:
                f.reverse()
            faces.append(f)
            fm.append(fmat(i, j) if fmat else 0)
    for cap, ri, nb in ((cap0, 0, 1), (cap1, len(R) - 1, len(R) - 2)):
        if cap is None:
            continue
        if isinstance(cap, str):
            f = [ri * n + j for j in range(n)]
            if newell([verts[k] for k in f]).dot(C[ri] - C[nb]) < 0:
                f.reverse()
            faces.append(f)
            fm.append(capmat)
        else:
            verts.append(Vector(cap))
            ai = len(verts) - 1
            for j in range(segs):
                j2 = (j + 1) % n
                f = [ai, ri * n + j, ri * n + j2]
                pts = [verts[k] for k in f]
                cen = sum(pts, Vector()) / 3
                if newell(pts).dot(cen - C[ri]) < 0:
                    f.reverse()
                faces.append(f)
                fm.append(capmat)
    o = make_mesh(name, verts, faces, mats, fm, smooth)
    if merge:
        merge_close(o)
    return o


def sring(cx, y, cz, rx, rzf, rzb, n=12, sq=2.0, phase=0.0):
    """Horizontal superellipse ring. Angle 0 = +x, 90 deg = +z (front)."""
    e = 2.0 / sq
    out = []
    for j in range(n):
        a = phase + 2 * math.pi * j / n
        c, s = math.cos(a), math.sin(a)
        x = rx * math.copysign(abs(c) ** e, c)
        z = (rzf if s > 0 else rzb) * math.copysign(abs(s) ** e, s)
        out.append(Vector((cx + x, y, cz + z)))
    return out


def body_loft(name, rows, mats, n=16, sq=2.0, phase=0.0, cx=0.0, cap0="flat", cap1="flat", fmat=None,
              capmat=0, smooth=True):
    """rows (bottom -> top): (y, cz, rx, rz_front, rz_back[, sq])."""
    rings, cents = [], []
    for r in rows:
        y, cz, rx, rzf, rzb = r[:5]
        s = r[5] if len(r) > 5 else sq
        rings.append(sring(cx, y, cz, rx, rzf, rzb, n, s, phase))
        cents.append(V(cx, y, cz))
    return loft(name, rings, mats, True, cap0, cap1, cents, fmat, capmat, smooth)


def tube(name, path, radii, mats, n=8, ref=(0, 0, 1), sq=2.0, phase=0.0, cap0=None, cap1=None, fmat=None,
         capmat=0, smooth=True):
    """Tube along a polyline. radii: r or (r_ref, r_side) per point; the first radius is measured
    along `ref` (projected perpendicular to the tube). cap: None | 'flat' | 'round'."""
    P = [Vector(p) for p in path]
    m = len(P)
    if isinstance(radii, (int, float)):
        radii = [radii] * m
    refs = ref if isinstance(ref, list) else [ref] * m
    e = 2.0 / sq
    rings = []
    for i in range(m):
        if i == 0:
            t = P[1] - P[0]
        elif i == m - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        t.normalize()
        rf = Vector(refs[i])
        u = rf - t * rf.dot(t)
        if u.length < 1e-6:
            u = t.orthogonal()
        u.normalize()
        v = t.cross(u)
        r = radii[i]
        ra, rb = (r, r) if isinstance(r, (int, float)) else r
        ring = []
        for j in range(n):
            a = phase + 2 * math.pi * j / n
            c, s = math.cos(a), math.sin(a)
            ring.append(P[i] + u * (ra * math.copysign(abs(c) ** e, c)) + v * (rb * math.copysign(abs(s) ** e, s)))
        rings.append(ring)

    def capspec(cap, end):
        if cap != "round":
            return cap
        k = 0 if end == 0 else m - 1
        d = (P[0] - P[1]).normalized() if end == 0 else (P[-1] - P[-2]).normalized()
        r = radii[k]
        rr = r if isinstance(r, (int, float)) else min(r)
        return P[k] + d * rr * 0.7

    return loft(name, rings, mats, True, capspec(cap0, 0), capspec(cap1, 1), P, fmat, capmat, smooth)


def ellip(name, center, radii, mats, segs=8, rings=6, rot=None, smooth=True):
    """Ellipsoid with radii (rx, ry, rz) in its own frame, turned by `rot` (3x3, three.js axes)."""
    C = Vector(center)
    M = rot or Matrix.Identity(3)
    rx, ry, rz = radii
    R, cents = [], []
    for i in range(1, rings):
        th = math.pi * i / rings - math.pi / 2
        y, r = math.sin(th), math.cos(th)
        R.append([C + M @ Vector((rx * r * math.cos(2 * math.pi * j / segs), ry * y,
                                  rz * r * math.sin(2 * math.pi * j / segs))) for j in range(segs)])
        cents.append(C + M @ Vector((0, ry * y, 0)))
    return loft(name, R, mats, True, C + M @ Vector((0, -ry, 0)), C + M @ Vector((0, ry, 0)), cents,
                smooth=smooth)


def rbox(name, size, center, mats, rot=None, smooth=False):
    """Box of size (w, h, d) centred at `center`, turned by `rot`."""
    C = Vector(center)
    M = rot or Matrix.Identity(3)
    w, h, d = (s / 2 for s in size)
    pts = [C + M @ Vector((sx * w, sy * h, sz * d)) for sy in (-1, 1) for sz in (-1, 1) for sx in (-1, 1)]
    # 0..3 bottom (z-,x-),(z-,x+),(z+,x-),(z+,x+); 4..7 top
    faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
    out = []
    for f in faces:
        p = [pts[k] for k in f]
        cen = sum(p, Vector()) / 4
        if newell(p).dot(cen - C) < 0:
            f = list(reversed(f))
        out.append(f)
    return make_mesh(name, pts, out, mats, None, smooth)


def strip(name, pts, width, mats, normal_hint, smooth=False):
    """Flat ribbon through `pts` (width across the path, facing `normal_hint`)."""
    P = [Vector(p) for p in pts]
    hint = Vector(normal_hint)
    verts = []
    for i in range(len(P)):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        side = hint.cross(t).normalized() * (width / 2)
        verts += [P[i] - side, P[i] + side]
    faces = []
    for i in range(len(P) - 1):
        f = [2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2]
        if newell([verts[k] for k in f]).dot(hint) < 0:
            f.reverse()
        faces.append(f)
    return make_mesh(name, verts, faces, mats, None, smooth)


def quad(name, center, normal, up, w, h, mats):
    """Flat w x h rectangle facing `normal` (double-sided in three.js), its height along `up`."""
    N = Vector(normal).normalized()
    U = Vector(up)
    U = (U - N * U.dot(N)).normalized()
    X = U.cross(N).normalized()
    C = Vector(center)
    q = [C + X * (sx * w / 2) + U * (sy * h / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = [0, 1, 2, 3]
    if newell(q).dot(N) < 0:
        f.reverse()
    return make_mesh(name, q, [f], mats, None, False)


def ray(obj, origin, direction):
    """Ray cast against an (unparented, untransformed) mesh object, three.js in/out."""
    update()
    ok, loc, nor, _ = obj.ray_cast(T(*origin), T(*direction))
    if not ok:
        return None, None
    return Vector((loc.x, loc.z, -loc.y)), Vector((nor.x, nor.z, -nor.y)).normalized()


def ray_any(objs, origin, direction):
    """Nearest hit over several objects: (point, normal) or (None, None)."""
    best, bd = (None, None), 1e9
    o = Vector(origin)
    for ob in objs:
        p, n = ray(ob, origin, direction)
        if p is not None and (p - o).length < bd:
            best, bd = (p, n), (p - o).length
    return best


def drape(objs, pts, lift):
    """Snap control points onto a surface: each item is (point, direction toward the surface)."""
    out = []
    for p, d in pts:
        d = Vector(d).normalized()
        hp, hn = ray_any(objs, Vector(p) - d * 0.25, d)
        out.append(hp + hn * lift if hp is not None else Vector(p))
    return out


def front_hit(obj, x, y, z0=1.0):
    """Point and normal of the surface seen from the front at (x, y)."""
    return ray(obj, (x, y, z0), (0, 0, -1))


def frame_at(nrm, tilt=0.0):
    up = Vector((0, 1, 0))
    u = up.cross(nrm)
    if u.length < 1e-6:
        u = Vector((1, 0, 0))
    u.normalize()
    v = nrm.cross(u).normalized()
    if tilt:
        c, s = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
        u, v = u * c + v * s, v * c - u * s
    return u, v


def finish(objs, name, origin=(0.0, 0.0, 0.0)):
    """Join into one object called `name`, transforms baked, origin at `origin`."""
    objs = [o for o in objs if o is not None]
    o = join(objs, name) if len(objs) > 1 else objs[0]
    o.name = name
    o.data.name = name
    apply_transform(o)
    if any(abs(c) > 1e-9 for c in origin):
        set_origin(o, origin)
    return o


# ═════════════════════════════════════════════════════════════════════════════
#  face / head
# ═════════════════════════════════════════════════════════════════════════════
# skull rows measured from the chin: (y, cz, rx, rz_front, rz_back)
HEAD_ADULT = [
    (0.000, 0.046, 0.018, 0.012, 0.020),
    (0.018, 0.032, 0.040, 0.030, 0.036),
    (0.046, 0.012, 0.058, 0.060, 0.056),
    (0.076, 0.000, 0.068, 0.080, 0.076),
    (0.108, -0.004, 0.073, 0.088, 0.090),
    (0.138, -0.006, 0.076, 0.088, 0.098),
    (0.170, -0.008, 0.075, 0.083, 0.100),
    (0.198, -0.010, 0.066, 0.068, 0.090),
    (0.218, -0.012, 0.044, 0.044, 0.062),
]
HEAD_ADULT_TOP = (0.230, -0.015)

HEAD_CHILD = [
    (0.000, 0.032, 0.022, 0.014, 0.020),
    (0.020, 0.022, 0.048, 0.036, 0.040),
    (0.045, 0.010, 0.066, 0.066, 0.064),
    (0.072, 0.002, 0.076, 0.082, 0.082),
    (0.100, -0.002, 0.081, 0.088, 0.094),
    (0.130, -0.004, 0.083, 0.090, 0.100),
    (0.160, -0.006, 0.082, 0.087, 0.100),
    (0.186, -0.008, 0.072, 0.074, 0.090),
    (0.204, -0.010, 0.048, 0.048, 0.062),
]
HEAD_CHILD_TOP = (0.214, -0.012)


def skull(name, chin, zc, rows, top, mat, k=(1.0, 1.0, 1.0), jaw=1.0, n=12):
    """Lofted head. k scales (x, y, z); jaw widens the lower rows (men)."""
    rings, cents = [], []
    for i, (y, cz, rx, rzf, rzb) in enumerate(rows):
        wj = jaw if i <= 3 else 1.0 + (jaw - 1.0) * 0.4 if i == 4 else 1.0
        yy = chin + y * k[1]
        rings.append(sring(0.0, yy, zc + cz * k[2], rx * k[0] * wj, rzf * k[2], rzb * k[2], n, 2.2, math.pi / 2))
        cents.append(V(0.0, yy, zc + cz * k[2]))
    apex = V(0.0, chin + top[0] * k[1], zc + top[1] * k[2])
    return loft(name, rings, mat, True, "flat", apex, cents)


def eye_disc(name, sk, x, y, w, h, m, tilt=0.0, lift=0.0012, dome=0.0018, n=8):
    P, N = front_hit(sk, x, y)
    u, v = frame_at(N, tilt)
    rim = []
    for j in range(n):
        a = 2 * math.pi * j / n
        q = P + u * (w / 2 * math.cos(a)) + v * (h / 2 * math.sin(a))
        hp, hn = ray(sk, q + N * 0.03, -N)
        rim.append((hp if hp is not None else q) + N * lift)
    apex = P + N * (lift + dome)
    verts = rim + [apex]
    faces = []
    for j in range(n):
        f = [n, j, (j + 1) % n]
        if newell([verts[k] for k in f]).dot(N) < 0:
            f.reverse()
        faces.append(f)
    return make_mesh(name, verts, faces, m, None, False)


def face_line(name, sk, pts2, width, m, lift=0.0022, sub=3):
    """Ribbon laid on the face through front-projected (x, y) points (brows, mouth, lids)."""
    dense = []
    for (x0, y0), (x1, y1) in zip(pts2, pts2[1:]):
        for k in range(sub):
            dense.append((lerp(x0, x1, k / sub), lerp(y0, y1, k / sub)))
    dense.append(pts2[-1])
    pts, nsum = [], Vector()
    for x, y in dense:
        P, N = front_hit(sk, x, y)
        if P is None:
            continue
        pts.append(P + N * lift)
        nsum += N
    return strip(name, pts, width, m, nsum.normalized())


def nose(name, sk, y_top, y_tip, length, width, m):
    top, nt = front_hit(sk, 0.0, y_top)
    base, nb = front_hit(sk, 0.0, y_tip - 0.008)
    tp, tn = front_hit(sk, 0.0, y_tip)
    tip = tp + tn * length
    wl, nl = front_hit(sk, -width / 2, y_tip - 0.004)
    wr, nr = front_hit(sk, width / 2, y_tip - 0.004)
    wl = wl + nl * 0.002
    wr = wr + nr * 0.002
    top = top + nt * 0.001
    verts = [top, wl, tip, wr, base]
    inside = tp - tn * 0.05
    faces = []
    for f in ([0, 1, 2], [0, 2, 3], [1, 4, 2], [2, 4, 3]):
        p = [verts[k] for k in f]
        if newell(p).dot(sum(p, Vector()) / 3 - inside) < 0:
            f = list(reversed(f))
        faces.append(f)
    return make_mesh(name, verts, faces, m, None, True)


def make_face(sk, mats, f):
    """Facial features on skull `sk`. f: dict of feature settings (y measured from the chin)."""
    chin = f["chin"]
    parts = []
    ex, ey, ew, eh = f["eye"]
    style = f.get("eye_style", "oval")
    for s in (-1, 1):
        if style == "slit":   # sleepy single lids: flat ellipse under a heavy lid line
            parts.append(eye_disc("eye", sk, s * ex, chin + ey, ew, eh, mats["eye"], tilt=s * f.get("eye_tilt", 0)))
            parts.append(face_line("lid", sk, [(s * (ex - ew * 0.62), chin + ey + eh * 0.25),
                                               (s * ex, chin + ey + eh * 0.75),
                                               (s * (ex + ew * 0.62), chin + ey + eh * 0.05)],
                                   0.0022, mats["lid"]))
        elif style == "arc":  # kind narrow eyes: a curved dark line
            parts.append(face_line("eye", sk, [(s * (ex - ew / 2), chin + ey - eh * 0.2), (s * ex, chin + ey + eh * 0.35),
                                               (s * (ex + ew / 2), chin + ey - eh * 0.2)], eh * 0.55, mats["eye"]))
        else:
            parts.append(eye_disc("eye", sk, s * ex, chin + ey, ew, eh, mats["eye"], tilt=s * f.get("eye_tilt", 0),
                                  n=f.get("eye_segs", 8)))
            if "glint" in mats:
                parts.append(eye_disc("glint", sk, s * ex - ew * 0.18, chin + ey + eh * 0.2, ew * 0.28, ew * 0.28,
                                      mats["glint"], lift=0.0032, dome=0.0004, n=6))
            if f.get("lash"):
                parts.append(face_line("lash", sk, [(s * (ex - ew * 0.62), chin + ey + eh * 0.18),
                                                    (s * ex, chin + ey + eh * 0.62),
                                                    (s * (ex + ew * 0.66), chin + ey + eh * 0.28)],
                                       0.0018, mats["eye"]))
    if "brow" in f:
        by, bx0, bx1, arch, bw = f["brow"]
        drop = f.get("brow_drop", 0.0)       # outer end lower (sleepy / kind) or higher (stern) when < 0
        for s in (-1, 1):
            parts.append(face_line("brow", sk, [(s * bx0, chin + by), (s * (bx0 + bx1) / 2, chin + by + arch),
                                                (s * bx1, chin + by - drop)], bw, mats["brow"]))
    if "nose" in f:
        ny0, ny1, nl, nw = f["nose"]
        parts.append(nose("nose", sk, chin + ny0, chin + ny1, nl, nw, mats["skin"]))
    if "mouth" in f:
        my, mw, curve, mth = f["mouth"]
        parts.append(face_line("mouth", sk, [(-mw / 2, chin + my + curve), (0.0, chin + my), (mw / 2, chin + my + curve)],
                               mth, mats["mouth"]))
    for i, ln in enumerate(f.get("lines", [])):        # wrinkles etc. [(x, y), ...] mirrored
        for s in (-1, 1):
            parts.append(face_line("line", sk, [(s * x, chin + y) for x, y in ln], 0.0016, mats["line"]))
    if "cheek" in f:
        cx_, cy_, cw, ch = f["cheek"]
        for s in (-1, 1):
            parts.append(eye_disc("cheek", sk, s * cx_, chin + cy_, cw, ch, mats["cheek"], lift=0.0008, dome=0.0006))
    if "ear" in f:
        ey_, ez, ex_, size = f["ear"]
        for s in (-1, 1):
            parts.append(ellip("ear", (s * ex_, chin + ey_, ez), size, mats["skin"], 6, 4, rot3((s * -12, "y"))))
    return parts


def hair_shell(name, rows, m, apex, n=16, cx=0.0, wave=None, dome=True):
    """Hair cap/curtain lofted top -> bottom. rows: (y, half_angle_deg, rx, rz_front, rz_back, cz).
    The half angle is measured from the back (180 = full ring, 90 = back half only).
    wave(i, phi) -> (dr, dy) optional deterministic offsets (use integer frequencies in phi).
    dome rounds the crown between the first row and the apex."""
    rows = list(rows)
    if dome:
        y0, ph0, rx0, rzf0, rzb0, cz0 = rows[0]
        extra = []
        for t in (0.78, 0.45):
            kk = math.sqrt(1.0 - t * t)
            extra.append((lerp(y0, apex[1], t), 180, rx0 * kk, rzf0 * kk, rzb0 * kk, lerp(cz0, apex[2], t)))
        rows = extra + rows
        _w = wave
        wave = (lambda i, phi: (0.0, 0.0) if i < 2 else _w(i - 2, phi)) if _w else None
    rings, cents = [], []
    for i, (y, ph, rx, rzf, rzb, cz) in enumerate(rows):
        ph = math.radians(ph)
        ring = []
        for j in range(n + 1):
            phi = -ph + 2 * ph * j / n
            s, c = math.sin(phi), math.cos(phi)
            rz = rzb if c >= 0 else rzf
            dr, dy = wave(i, phi) if wave else (0.0, 0.0)
            ring.append(V(cx + (rx + dr) * s, y + dy, cz - (rz + dr) * c))
        rings.append(ring)
        cents.append(V(cx, y, cz))
    return loft(name, rings, m, False, V(apex), None, cents, merge=True)


def skull_at(rows, top, k, yrel):
    """Skull section (cz, rx, rzf, rzb) at height yrel above the chin (scaled units)."""
    yb = yrel / k[1]
    rs = list(rows) + [(top[0], top[1], 0.0, 0.0, 0.0)]
    if yb <= rs[0][0]:
        r = rs[0]
    else:
        r = rs[-1]
        for a, b in zip(rs, rs[1:]):
            if a[0] <= yb <= b[0]:
                t = (yb - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
                r = tuple(lerp(a[i], b[i], t) for i in range(5))
                break
    return r[1] * k[2], r[2] * k[0], r[3] * k[2], r[4] * k[2]


def hair_rows(chin, zc, rows, top, k, spec):
    """spec: (yrel, half_angle, t_side, t_front, t_back[, dz]) offsets from the skull surface, or
    ('abs', yrel, half_angle, rx, rzf, rzb, cz) for hair hanging free of the head."""
    out = []
    for sp in spec:
        if sp[0] == "abs":
            _, yr, ph, rx, rzf, rzb, cz = sp
            out.append((chin + yr, ph, rx, rzf, rzb, zc + cz))
            continue
        yr, ph, ts, tf, tb = sp[:5]
        dz = sp[5] if len(sp) > 5 else 0.0
        cz, rx, rzf, rzb = skull_at(rows, top, k, yr)
        out.append((chin + yr, ph, rx + ts, rzf + tf, rzb + tb, zc + cz + dz))
    return out


def surface_box(objs, x, y, size, m, lift=0.0, approach=(0, 0, -1), z0=1.0, rot_z=0.0):
    """Thin box (w, h, t) lying on a surface hit from the front at (x, y)."""
    o = V(x, y, z0) if approach == (0, 0, -1) else V(x, y, 0) - Vector(approach) * 0.6
    P, N = ray_any(objs, o, approach)
    if P is None:
        return None
    up = V(0, 1, 0)
    Y = (up - N * up.dot(N)).normalized()
    if rot_z:
        c, s_ = math.cos(math.radians(rot_z)), math.sin(math.radians(rot_z))
        X0 = Y.cross(N).normalized()
        Y = (Y * c + X0 * s_).normalized()
    X = Y.cross(N).normalized()
    R = Matrix((X, Y, N)).transposed()
    return rbox("patch", size, P + N * (size[2] / 2 + lift), m, R)


def zori(heel, toe, m_sole, m_strap, sole=0.016, w=0.042, h=0.030, width=0.090):
    """Flat sole + V thong strap (gomu-zori / setta) under a foot() of the same w/h/sole."""
    H, Tt = Vector(heel), Vector(toe)
    d = (Tt - H).normalized()
    side = d.cross(V(0, 1, 0)).normalized()        # points to the foot's right
    yaw = math.degrees(math.atan2(d.x, d.z))
    c = (H + Tt) / 2 + d * 0.006
    c.y = sole / 2
    parts = [rbox("zori_sole", (width, sole, (Tt - H).length + 0.028), c, m_sole, rot3((yaw, "y")))]
    _, kh = _foot_at(0.86)
    front = H + (Tt - H) * 0.84
    front.y = sole + h * kh * 1.9 + 0.003
    kw2, _ = _foot_at(0.52)
    for sgn in (-1, 1):
        sp = H + (Tt - H) * 0.50 + side * (sgn * (w * kw2 + 0.004))
        sp.y = sole + 0.004
        mid = (front + sp) / 2
        mid.y = sole + h * 1.95
        parts.append(tube("zori_strap", [front, mid, sp], 0.0045, m_strap, 4))
    parts.append(rbox("zori_knot", (0.012, 0.010, 0.012), front + V(0, -0.002, 0), m_strap, rot3((yaw + 45, "y"))))
    return parts


def assemble(body_parts, face_parts, hair_parts, pivot, extra_head=None):
    """body -> 'body'; head pieces under the empty 'head' (origin = base of the neck)."""
    body = finish(body_parts, "body")
    head = empty("head", tuple(pivot))
    face = finish(face_parts, "face")
    set_parent(face, head)
    if hair_parts:
        hair = finish(hair_parts, "hair")
        set_parent(hair, head)
    for o in extra_head or []:
        set_parent(o, head)
    return body, head


# ═════════════════════════════════════════════════════════════════════════════
#  limbs
# ═════════════════════════════════════════════════════════════════════════════
def hand(name, wrist, direction, palm, thumb, m, k=1.0, curl=0.35, n=6):
    """Mitten hand from the wrist along `direction`; `palm` = palm normal, `thumb` = thumb side."""
    d = Vector(direction).normalized()
    pn = Vector(palm).normalized()
    pn = (pn - d * pn.dot(d)).normalized()
    W = Vector(wrist)
    L = [0.0, 0.045, 0.082, 0.118, 0.150]
    rr = [(0.021, 0.015), (0.033, 0.016), (0.035, 0.014), (0.031, 0.011), (0.017, 0.008)]
    path = []
    for i, s in enumerate(L):
        bend = max(0.0, (s - 0.07)) * curl     # fingers curl toward the palm
        path.append(W + d * (s * k) + pn * (bend * k))
    radii = [(a * k, b * k) for a, b in rr]
    # ref = the width direction (across the knuckles)
    wdir = d.cross(pn).normalized()
    h = tube(name, path, radii, m, n, ref=tuple(wdir), cap1="round")
    tdir = Vector(thumb).normalized()
    t0 = W + d * (0.028 * k) + tdir * (0.020 * k) + pn * (0.006 * k)
    t1 = t0 + (d * 0.032 + tdir * 0.012 + pn * 0.012) * k
    t2 = t1 + (d * 0.022 + pn * 0.010) * k
    th = tube(name + "_thumb", [t0, t1, t2], [0.011 * k, 0.010 * k, 0.008 * k], m, 5, cap1="round")
    return [h, th]


def foot(name, heel, toe, m, w=0.045, h=0.035, sole=0.0, n=6):
    """Foot / shoe from heel to toe resting on y = sole."""
    H, Tt = Vector(heel), Vector(toe)
    d = Tt - H
    length = d.length
    d.normalize()
    path, radii = [], []
    for t, kw, kh in FOOT_PROF:
        p = H + d * (length * t)
        p.y = sole + h * kh
        path.append(p)
        radii.append((h * kh, w * kw))
    return tube(name, path, radii, m, n, ref=(0, 1, 0), sq=2.6, cap0="flat", cap1="round")


FOOT_PROF = [(0.00, 0.62, 0.80), (0.10, 0.92, 1.00), (0.40, 1.00, 0.92), (0.70, 1.00, 0.56), (0.90, 0.82, 0.40),
             (1.00, 0.50, 0.26)]


def _foot_at(t):
    for (t0, w0, h0), (t1, w1, h1) in zip(FOOT_PROF, FOOT_PROF[1:]):
        if t0 <= t <= t1:
            k = (t - t0) / (t1 - t0)
            return lerp(w0, w1, k), lerp(h0, h1, k)
    return FOOT_PROF[-1][1:]


def foot_strap(name, heel, toe, t, m, w=0.045, h=0.035, sole=0.0, width=0.02, thick=0.004, gap=0.003):
    """Band arching over the foot at fraction t (sandal / zori straps)."""
    H, Tt = Vector(heel), Vector(toe)
    d = (Tt - H).normalized()
    side = d.cross(V(0, 1, 0)).normalized()
    kw, kh = _foot_at(t)
    c = H + (Tt - H) * t
    c.y = sole + h * kh
    rw, rh = w * kw * 1.06 + gap, h * kh * 1.06 + gap
    path = [c + side * rw + V(0, -h * kh + 0.002, 0)]
    for a in range(0, 181, 45):
        r = math.radians(a)
        path.append(c + side * (rw * math.cos(r)) + V(0, rh * math.sin(r), 0))
    path.append(c - side * rw + V(0, -h * kh + 0.002, 0))
    verts = []
    for p in path:
        verts += [p - d * (width / 2), p + d * (width / 2)]
    faces = []
    for i in range(len(path) - 1):
        f = [2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2]
        pts = [verts[k] for k in f]
        if newell(pts).dot(sum(pts, Vector()) / 4 - c) < 0:
            f.reverse()
        faces.append(f)
    return make_mesh(name, verts, faces, m, None, False)


# ═════════════════════════════════════════════════════════════════════════════
#  npc_nao — 24. The textured, rigged model in tools/blender/assets/nao/nao_rig.blend (long dark hair
#  with a fringe, choker, a big blue-grey hoodie worn off the shoulders over a black camisole, black
#  skirt, black tights, boots; mixamo-named bones), posed here and baked into plain meshes.
#  Added on top: the phone (screen = emit_phone, facing her face) and the natural-cotton tote with the
#  bell + "103" key.
# ═════════════════════════════════════════════════════════════════════════════
NAO_RIG = os.path.join(ROOT, "tools", "blender", "assets", "nao", "nao_rig.blend")
NAO_HEIGHT = 1.58          # metres, standing, top of the hair
NAO_TEX = 1024             # the 4K Tripo textures, scaled down for the game


def nao_mats():
    return {
        "bag": mat("tote", "#e2d6bc", 0.95),
        "bag_in": mat("tote_inside", "#bfb39a", 0.95),
        "phone": mat("phone_body", "#1d1f25", 0.35, 0.2),
        "screen": mat("emit_phone", "#0b0d10", 0.25, emit="#dfe9ff", emit_strength=1.0),
        "gold": mat("bell_gold", "#d6aa3a", 0.3, 0.8),
        "metal": mat("key_metal", "#b9b9b6", 0.3, 0.9),
        "tag": mat("key_tag", "#f4f4ef", 0.8),
        "ink": mat("tag_ink", "#1a1a1e", 0.8),
    }


def _nao_textures(objs):
    """Matte the Tripo materials and shrink their textures."""
    seen = set()
    for o in objs:
        for i, m in enumerate(o.data.materials):
            if m is None or m.name in seen:
                continue
            seen.add(m.name)
            m.name = "nao_head" if o.name == "HeadMesh" else "nao_body"
            for n in m.node_tree.nodes:
                if n.type == "BSDF_PRINCIPLED":
                    n.inputs["Roughness"].default_value = 0.85
                    n.inputs["Metallic"].default_value = 0.0
                    for s in ("Specular IOR Level",):
                        if s in n.inputs:
                            n.inputs[s].default_value = 0.25
                    for s in ("Roughness", "Metallic"):
                        for l in list(n.inputs[s].links):
                            m.node_tree.links.remove(l)
                elif n.type == "TEX_IMAGE" and n.image is not None and n.image.size[0] > NAO_TEX:
                    n.image.scale(NAO_TEX, NAO_TEX)
                    n.image.file_format = "JPEG"


class NaoRig:
    """Loads the rig; pose it with rig_pose.*, then bake() -> (body, head mesh, F) where F maps armature-space
    points to the final Blender-world points (metres, feet / seat on the floor)."""

    def __init__(self, skirt=0.0):
        self.arm, self.body, self.headm = rig_pose.load_rig(NAO_RIG)
        _nao_textures([self.body, self.headm])
        if skirt > 0.0:
            self.loosen_skirt(skirt)
        rig_pose.smooth_weights(self.body)
        update()
        zs = [(o.matrix_world @ v.co).z for o in (self.body, self.headm) for v in o.data.vertices]
        self.k = NAO_HEIGHT / (max(zs) - min(zs))

    def loosen_skirt(self, frac):
        """The skirt is weighted to the thighs; when the thighs swing up to sit, let it follow them only
        partly (the rest goes to the hips) so the frills do not fan out into spikes. Only the cloth
        outside the tights (farther than ~0.055 from a thigh's core) between the hem and the waist."""
        def f(co):
            if not (0.40 < co.z < 0.64):
                return 0.0
            r = min(math.hypot(co.x - s * 0.055, co.y + 0.035) for s in (-1, 1))
            k = min(1.0, max(0.0, (r - 0.050) / 0.025))
            ramp = min(1.0, (co.z - 0.40) / 0.04)
            return frac * k * ramp
        rig_pose.move_weight(self.body, ("LeftUpLeg", "RightUpLeg"), "Hips", f)

    def bake(self):
        a = self.arm
        body = rig_pose.bake(self.body, "body")
        head = rig_pose.bake(self.headm, "nao_head")
        S = Matrix.Scale(self.k, 4)
        for o in (body, head):
            o.matrix_world = S @ o.matrix_world
            apply_transform(o)
        zmin = min(v.co.z for o in (body, head) for v in o.data.vertices)
        off = Vector((0.0, 0.0, -zmin))
        for o in (body, head):
            o.data.transform(Matrix.Translation(off))
        aw = a.matrix_world.copy()
        F = lambda p: S @ (aw @ Vector(p)) + off   # noqa: E731
        for o in (self.body, self.headm, a):
            bpy.data.objects.remove(o)
        return body, head, F


def b2t(v):
    """Blender world point -> three.js point."""
    return V(v.x, v.z, -v.y)


def nao_finish(body, head_mesh, pivot_b, extra_body=()):
    """body (+ extras) -> 'body'; the head mesh under the empty 'head' whose origin is the base of the skull."""
    parts = [body] + list(extra_body)
    body = finish(parts, "body")
    head = empty("head", tuple(b2t(pivot_b)))
    set_parent(head_mesh, head)
    head_mesh.name = head_mesh.data.name = "face"
    return body, head


def move_xz(roots, dx, dz):
    for o in roots:
        o.location = o.location + T(dx, 0.0, dz)
    update()
    for o in roots:
        if o.type == "MESH":
            apply_transform(o)


def build_nao():
    """Standing. Head a little down toward the phone in her right hand (in front of the chest);
    the left arm hangs with the tote in the hand."""
    R = NaoRig()
    a = R.arm
    # look down at the phone a little
    rig_pose.turn(a, "Neck", (1, 0, 0), 6)
    rig_pose.turn(a, "Head", (1, 0, 0), 8)
    # left arm: hanging, a little away from the hoodie
    rig_pose.aim(a, "LeftShoulder", (1, 0.0, -0.12))
    rig_pose.aim(a, "LeftArm", (0.20, 0.04, -1))
    rig_pose.aim(a, "LeftForeArm", (0.10, -0.10, -1))
    rig_pose.aim(a, "LeftHand", (0.06, -0.10, -1))
    # right arm: elbow by the side, phone in front of the chest
    rig_pose.aim(a, "RightShoulder", (-1, 0.0, -0.10))
    wrist = Vector((-0.040, -0.115, 0.690))
    rig_pose.reach(a, "RightArm", "RightForeArm", wrist, (-0.30, 0.30, 0.45))
    rig_pose.aim(a, "RightHand", (0.30, -0.70, 0.62))
    eye = rig_pose.head_of(a, "Head") + Vector((0.0, -0.09, 0.03))
    rig_pose.face_palm(a, "Right", eye - rig_pose.tail_of(a, "RightHand"))
    palm = (rig_pose.head_of(a, "RightHand") + rig_pose.head_of(a, "RightHandMiddle2")) / 2
    pn = rig_pose.palm_normal(a, "Right")
    along = rig_pose.head_of(a, "RightHandMiddle2") - rig_pose.head_of(a, "RightHand")
    lw1 = rig_pose.tail_of(a, "LeftHand")
    neck = rig_pose.head_of(a, "Head")
    feet = (rig_pose.head_of(a, "LeftFoot") + rig_pose.head_of(a, "RightFoot")) / 2
    body, headm, F = R.bake()
    M = nao_mats()
    # phone: lying on the right palm, long side along the fingers, screen toward her eyes
    N = b2t(pn).normalized()
    pc = b2t(F(palm)) + N * 0.010 + b2t(along).normalized() * 0.015
    ph, _ = phone(M, pc, (b2t(F(eye)) - pc).normalized() * 0.5 + N * 0.5, b2t(along))
    # tote: handles in the left hand, hanging by her leg
    grip = b2t(F(lw1))
    bag_c = grip + V(0.025, -0.300, 0.0)
    extra = ph + tote(M, bag_c, h=0.34)[0]
    top_y = bag_c.y + 0.17
    for zo in (0.06, -0.06):
        path = [V(bag_c.x, top_y - 0.004, bag_c.z + zo), V(bag_c.x + 0.004, (top_y + grip.y) / 2, bag_c.z + zo * 0.6),
                grip + V(0.0, -0.004, zo * 0.15)]
        extra.append(tube("tote_strap", path, [(0.0125, 0.0025)] * len(path), M["bag"], 4, ref=(0, 0, 1), sq=12,
                          phase=math.pi / 4))
    extra += keychain(M, V(bag_c.x + 0.030, top_y - 0.006, bag_c.z + 0.10), V(1, 0, 0.3), k=1.0)
    body, head = nao_finish(body, headm, F(neck), extra)
    fc = b2t(F(feet))
    move_xz([body, head], -fc.x, -fc.z)
    return body, head


def build_nao_sit():
    """Sitting sideways on the floor (yokozuwari: legs folded to her right), filming with the phone held in
    both hands in front of the chest; the tote on the floor at her left."""
    R = NaoRig(skirt=0.65)
    a = R.arm
    # legs folded to her right (-x): knees forward, feet tucked beside the right hip
    rig_pose.aim(a, "RightUpLeg", (-0.38, -1.0, -0.10))
    rig_pose.aim(a, "RightLeg", (-0.55, 0.83, -0.05))
    rig_pose.aim(a, "RightFoot", (-0.35, 0.90, -0.30))
    rig_pose.aim(a, "LeftUpLeg", (0.05, -1.0, 0.02))
    rig_pose.aim(a, "LeftLeg", (-0.85, 0.50, -0.08))
    rig_pose.aim(a, "LeftFoot", (-0.80, 0.45, -0.30))
    # lean a little forward and toward the folded legs' side
    rig_pose.turn(a, "Spine", (1, 0, 0), 6)
    rig_pose.turn(a, "Spine", (0, 1, 0), -4)
    rig_pose.turn(a, "Neck", (1, 0, 0), 6)
    rig_pose.turn(a, "Head", (1, 0, 0), 6)
    # both hands on the phone in front of the chest
    for sd, side in ((1, "Left"), (-1, "Right")):
        rig_pose.aim(a, f"{side}Shoulder", (sd, 0.0, -0.12))
        sp = rig_pose.head_of(a, "Spine2")
        wrist = sp + Vector((sd * 0.050, -0.135, -0.075))
        rig_pose.reach(a, f"{side}Arm", f"{side}ForeArm", wrist, sp + Vector((sd * 0.35, 0.25, -0.35)))
        rig_pose.aim(a, f"{side}Hand", (-sd * 0.30, -0.70, 0.62))
    eye = rig_pose.head_of(a, "Head") + Vector((0.0, -0.09, 0.03))
    palms, pns = [], []
    for side in ("Left", "Right"):
        rig_pose.face_palm(a, side, eye - rig_pose.tail_of(a, f"{side}Hand"))
        palms.append((rig_pose.head_of(a, f"{side}Hand") + rig_pose.head_of(a, f"{side}HandMiddle2")) / 2)
        pns.append(rig_pose.palm_normal(a, side))
    neck = rig_pose.head_of(a, "Head")
    body, headm, F = R.bake()
    M = nao_mats()
    # phone held upright between both palms, screen toward her eyes
    N = b2t(pns[0] + pns[1]).normalized()
    pc = b2t((F(palms[0]) + F(palms[1])) / 2) + N * 0.012 + V(0.0, 0.03, 0.0)
    ph, _ = phone(M, pc, (b2t(F(eye)) - pc).normalized() * 0.5 + N * 0.5, V(0.0, 1.0, 0.0))
    extra = list(ph)
    # tote on the floor at her left, slumped; keys hanging off a handle
    bc = V(0.37, 0.160, -0.08)
    bag_parts, Rb = tote(M, bc, yaw=-28.0, tilt=12.0, h=0.32)
    extra += bag_parts
    top = bc + Rb @ V(0.0, 0.160, 0.0)
    for xo, fl in ((0.016, 1.0), (-0.016, 0.55)):
        loop = []
        for d in range(0, 181, 30):
            r = math.radians(d)
            hgt = 0.095 * math.sin(r)
            loop.append(top + Rb @ V(xo + fl * 0.75 * hgt, hgt * 0.66, 0.075 * math.cos(r)))
        extra.append(tube("tote_strap", loop, [(0.0125, 0.0025)] * len(loop), M["bag"], 4, ref=(0, 1, 0), sq=12,
                          phase=math.pi / 4))
    extra += keychain(M, top + Rb @ V(0.026, 0.035, 0.074), Rb @ V(1, 0, 0.2), k=1.0)
    body, head = nao_finish(body, headm, F(neck), extra)
    recentre_xz([body, head])
    return body, head


def keychain(M, top, outward, k=1.0):
    """Ring, little gold bell, key with a white tag reading 103, hanging from `top`."""
    o = Vector(outward).normalized()
    P = Vector(top)
    parts = [tube("kc_ring", [P + V(0.0, 0.0, -0.008) * k, P + V(0.0, -0.008, -0.012) * k, P + V(0.0, -0.016, -0.004) * k,
                              P + V(0.0, -0.012, 0.006) * k, P + V(0.0, -0.002, 0.006) * k],
                  0.0014 * k, M["metal"], 4)]
    bell_c = P + V(0.0, -0.026, -0.010) * k + o * 0.004
    parts.append(ellip("kc_bell", bell_c, (0.0075 * k, 0.0072 * k, 0.0075 * k), M["gold"], 6, 4))
    parts.append(quad("kc_bell_slit", bell_c + V(0, -0.0035, 0) * k + o * 0.0068 * k, o, V(0, 1, 0), 0.009 * k, 0.0014 * k,
                      M["ink"]))
    # key: bow + blade
    kp = P + V(0.0, -0.030, 0.006) * k + o * 0.002
    parts.append(rbox("kc_key_bow", (0.003 * k, 0.016 * k, 0.014 * k), kp, M["metal"]))
    parts.append(rbox("kc_key_blade", (0.0025 * k, 0.030 * k, 0.006 * k), kp + V(0.0, -0.022, 0.0) * k, M["metal"]))
    # tag on its own little ring
    tp = P + V(0.0, -0.036, 0.020) * k + o * 0.003
    parts.append(rbox("kc_tag", (0.002 * k, 0.020 * k, 0.034 * k), tp, M["tag"]))
    # "103" in marker pen (tiny strokes on the outward face)
    f = tp + o * (0.0012 * k)
    s = 0.0011 * k
    strokes = [  # (dz, dy, len_z, len_y) on the tag face
        (-0.010, 0.0, s, 0.010 * k),                       # 1
        (-0.002, 0.004, 0.006 * k, s), (-0.002, -0.004, 0.006 * k, s),   # 0
        (-0.005, 0.0, s, 0.009 * k), (0.001, 0.0, s, 0.009 * k),
        (0.008, 0.004, 0.006 * k, s), (0.008, 0.0, 0.005 * k, s), (0.008, -0.004, 0.006 * k, s),  # 3
        (0.011, 0.0, s, 0.009 * k),
    ]
    for dz, dy, lz, ly in strokes:
        parts.append(quad("kc_ink", f + V(0.0, dy * k, dz * k), o, V(0, 1, 0), lz, ly, M["ink"]))
    return parts


def phone(M, center, screen_normal, long_axis, size=(0.071, 0.148, 0.0085)):
    """Phone box + screen quad (emit_phone) facing screen_normal."""
    N = Vector(screen_normal).normalized()
    L = Vector(long_axis)
    L = (L - N * L.dot(N)).normalized()
    W = L.cross(N).normalized()
    C = Vector(center)
    w, h, t = size[0] / 2, size[1] / 2, size[2] / 2
    rot = Matrix((W, N, L)).transposed()   # local x=W, y=N, z=L
    parts = [rbox("phone", (size[0], size[2], size[1]), C, M["phone"], rot)]
    sw, sh = w - 0.003, h - 0.005
    q = [C + W * (sx * sw) + L * (sy * sh) + N * (t + 0.0006) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = [0, 1, 2, 3]
    if newell(q).dot(N) < 0:
        f.reverse()
    parts.append(make_mesh("phone_screen", q, [f], M["screen"], None, False))
    return parts, (C, N, L, W)


def tote(M, center, yaw=0.0, tilt=0.0, h=0.36, w=0.33, n=12):
    """Natural-cotton tote (no handles), width along local z, thickness along local x, centred at `center`.
    Returns (parts, rotation)."""
    R = rot3((tilt, "z"), (yaw, "y"))
    c = Vector(center)
    rows = [(-h / 2, 0.018, 0.150), (-h / 2 + 0.03, 0.030, 0.160), (0.0, 0.033, 0.165), (h / 2 - 0.03, 0.024, 0.165),
            (h / 2, 0.015, 0.165)]
    rings = [[c + R @ p for p in sring(0.0, y, 0.0, tx, wz * w / 0.33, wz * w / 0.33, n, 5.0, 0.0)]
             for y, tx, wz in rows]
    parts = [loft("tote", rings, [M["bag"]], True, "flat", "flat", [c + R @ V(0, r[0], 0) for r in rows], smooth=True)]
    parts.append(rbox("tote_mouth", (0.024, 0.004, w - 0.02), c + R @ V(0.0, h / 2 + 0.001, 0.0), M["bag_in"], R))
    return parts, R



def recentre_xz(roots):
    """Move the roots so the footprint (x, z) is centred on the origin; bake the body."""
    mn, mx = bounds_three()
    cx, cz = (mn[0] + mx[0]) / 2, (mn[2] + mx[2]) / 2
    for o in roots:
        o.location = o.location + T(-cx, 0.0, -cz)
    update()
    for o in roots:
        if o.type == "MESH":
            apply_transform(o)



# ═════════════════════════════════════════════════════════════════════════════
#  npc_neighbor — 月見ハツ, 82. Small, a little bent at the back, white hair in a bun,
#  light-blue kappogi, dark monpe, black rubber zori; ladle in the right hand, a small
#  wooden bucket in the left (uchimizu).
# ═════════════════════════════════════════════════════════════════════════════
def build_neighbor():
    M = {
        "skin": mat("skin", "#e0bb9c", 0.8),
        "hair": mat("hair_white", "#e3e0d9", 0.7),
        "tie": mat("hair_tie", "#2b2733", 0.6),
        "eye": mat("eye", "#2a1e1a", 0.4),
        "brow": mat("brow", "#cdc8bf", 0.85),
        "mouth": mat("mouth", "#a5675f", 0.7),
        "line": mat("wrinkle", "#b98e72", 0.9),
        "apron": mat("kappogi", "#9ccbe2", 0.9),
        "apron_d": mat("kappogi_seam", "#7aaac4", 0.9),
        "collar": mat("undercollar", "#3d3a56", 0.85),
        "monpe": mat("monpe", "#4a4354", 0.95),
        "zori": mat("zori_black", "#151515", 0.7),
        "wood": mat("wood", "#ad8455", 0.75),
        "wood_d": mat("wood_dark", "#7c5838", 0.8),
        "hoop": mat("bucket_hoop", "#2f2721", 0.6, 0.3),
        "wet": mat("bucket_water", "#25343a", 0.1),
    }
    chin, zc = 1.222, 0.135
    k = (0.95, 0.93, 0.95)
    pivot = V(0.0, 1.188, 0.096)
    sk = skull("skull", chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, M["skin"], k=k)
    face = [sk] + make_face(sk, M, {
        "chin": chin, "eye": (0.029, 0.108, 0.019, 0.010), "eye_style": "arc",
        "brow": (0.135, 0.016, 0.046, 0.003, 0.0036), "brow_drop": 0.005,
        "nose": (0.110, 0.080, 0.008, 0.017),
        "mouth": (0.050, 0.022, 0.0035, 0.0032),
        "lines": [[(0.017, 0.082), (0.025, 0.066), (0.027, 0.052)], [(0.004, 0.166), (0.030, 0.164)],
                  [(0.050, 0.110), (0.057, 0.104)]],
        "ear": (0.098, zc - 0.015, 0.069, (0.009, 0.026, 0.015)),
    })
    face.append(tube("neck", [V(0, 1.150, 0.080), V(0, 1.196, 0.100), V(0, 1.250, 0.126)],
                     [(0.047, 0.045), (0.046, 0.044), (0.045, 0.043)], M["skin"], 8))
    spec = [(0.200, 180, 0.008, 0.008, 0.010), (0.185, 180, 0.010, 0.010, 0.012), (0.165, 180, 0.011, 0.010, 0.013),
            (0.150, 140, 0.011, 0.011, 0.013), (0.131, 114, 0.010, 0.010, 0.013), (0.113, 96, 0.009, 0.009, 0.012),
            (0.090, 80, 0.009, 0.009, 0.011), (0.066, 70, 0.008, 0.008, 0.010), (0.044, 58, 0.008, 0.008, 0.009),
            (0.030, 46, 0.007, 0.007, 0.008)]
    top = chin + HEAD_ADULT_TOP[0] * k[1]
    hair = [hair_shell("hair_cap", hair_rows(chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, k, spec), M["hair"],
                       (0.0, top + 0.008, zc + HEAD_ADULT_TOP[1] * k[2]), n=16)]
    bun_c = V(0.0, chin + 0.172, zc - 0.118)
    hair.append(ellip("bun", bun_c, (0.040, 0.036, 0.034), M["hair"], 10, 6, rot3((-25, "x"))))
    hair.append(tube("bun_tie", [bun_c + V(0, -0.012, 0.022), bun_c + V(0, -0.006, 0.030)], (0.030, 0.027), M["tie"], 10,
                     ref=(1, 0, 0)))
    B = []
    rows = [
        (0.470, 0.010, 0.205, 0.152, 0.150, 2.2),
        (0.600, 0.012, 0.192, 0.138, 0.136, 2.3),
        (0.760, 0.016, 0.182, 0.126, 0.128, 2.4),
        (0.880, 0.026, 0.172, 0.119, 0.122, 2.4),
        (1.000, 0.044, 0.172, 0.110, 0.134, 2.5),
        (1.080, 0.064, 0.176, 0.096, 0.146, 2.6),
        (1.135, 0.080, 0.166, 0.080, 0.136, 2.6),
        (1.170, 0.092, 0.113, 0.064, 0.100, 2.3),
        (1.192, 0.098, 0.058, 0.050, 0.058, 2.0),
    ]
    apron = body_loft("kappogi", rows, M["apron"], n=16, cap0=None, cap1="flat")
    B.append(apron)
    B.append(body_loft("undercollar", [(1.178, 0.096, 0.064, 0.058, 0.062), (1.222, 0.102, 0.054, 0.051, 0.055)],
                       M["collar"], n=12, cap0=None, cap1=None))
    for x in (-0.095, 0.095):        # patch pockets
        B.append(surface_box([apron], x, 0.700, (0.105, 0.110, 0.006), M["apron_d"], lift=-0.001))
        B.append(surface_box([apron], x, 0.745, (0.106, 0.012, 0.007), M["apron"], lift=-0.0005))
    # bow of the apron strings at the back of the waist
    bp, bn = ray(apron, (0.0, 0.900, -0.6), (0, 0, 1))
    if bp is not None:
        for s_ in (-1, 1):
            B.append(ellip("bow", bp + V(s_ * 0.032, 0.0, -0.012), (0.030, 0.016, 0.010), M["apron"], 6, 4,
                           rot3((s_ * 12, "z"))))
            B.append(rbox("bow_tail", (0.018, 0.090, 0.006), bp + V(s_ * 0.016, -0.050, -0.012), M["apron"],
                          rot3((s_ * 10, "z"))))
        B.append(ellip("bow_knot", bp + V(0, 0, -0.014), (0.012, 0.012, 0.010), M["apron_d"], 6, 4))
    # monpe legs and bare feet in black rubber zori
    for sd in (-1, 1):
        hip, knee, ank = V(sd * 0.085, 0.620, 0.012), V(sd * 0.088, 0.330, 0.040), V(sd * 0.090, 0.085, 0.018)
        B.append(tube("monpe_leg", [hip, knee, ank, ank + V(0, -0.012, 0)], [(0.070, 0.068), (0.064, 0.062),
                                                                            (0.050, 0.049), (0.046, 0.045)],
                      M["monpe"], 10, cap0="flat"))
        heel = V(sd * 0.086, 0.0, -0.060)
        toe = V(sd * 0.108, 0.0, 0.158)
        B.append(foot("foot", heel, toe, M["skin"], w=0.036, h=0.028, sole=0.014))
        B += zori(heel, toe, M["zori"], M["zori"], sole=0.014, w=0.036, h=0.028, width=0.084)
    # arms: kappogi sleeves gathered at the wrist
    rsh, rel, rwr = V(-0.150, 1.118, 0.074), V(-0.190, 0.896, 0.096), V(-0.196, 0.712, 0.162)
    lsh, lel, lwr = V(0.150, 1.118, 0.074), V(0.208, 0.896, 0.084), V(0.238, 0.718, 0.104)
    for sh, el, wr in ((rsh, rel, rwr), (lsh, lel, lwr)):
        sd = 1 if sh.x > 0 else -1
        B.append(tube("arm", [lerp(sh, el, 0.35), el, wr], [0.032, 0.028, 0.022], M["skin"], 8))
        B.append(tube("sleeve", [V(sd * 0.112, 1.112, 0.074), (sh + el) / 2, el, lerp(el, wr, 0.6), wr + (wr - el).normalized() * 0.006],
                      [0.046, 0.058, 0.057, 0.052, 0.036], M["apron"], 10, cap0="flat"))
    # right hand grips the ladle (hishaku), cup hanging by the shin
    g = rwr + V(0.0, -0.045, 0.030)
    B += hand("hand_r", rwr, (V(0, -0.55, 0.85)).normalized(), V(1, 0, 0), V(0, 1, 0), M["skin"], k=0.86, curl=0.9)
    h0, h1 = g + V(0.0, 0.040, -0.020), V(-0.214, 0.400, 0.335)
    B.append(tube("ladle_handle", [h0, h1], 0.0075, M["wood"], 6, cap0="flat", cap1="flat"))
    cup_c = h1 + V(0.0, -0.010, 0.040)
    B.append(cyl("ladle_cup", 0.040, 0.058, tuple(cup_c), M["wood_d"], verts=10, cap=True))
    B.append(cyl("ladle_rim", 0.041, 0.006, tuple(cup_c + V(0, 0.029, 0)), M["wood"], verts=10, cap=True))
    # left hand carries the little wooden bucket (teoke) by its bar
    B += hand("hand_l", lwr, V(0.04, -1, 0.05), V(-1, 0, 0), V(0, 0, 1), M["skin"], k=0.86, curl=0.7)
    bx, bz = 0.262, 0.100
    bar_y = lwr.y - 0.090
    rim_y, bot_y = bar_y - 0.105, bar_y - 0.235
    B.append(cyl("bucket", 0.084, rim_y - bot_y, (bx, (rim_y + bot_y) / 2, bz), M["wood"], verts=12, radius2=0.090))
    wpts = [V(bx + 0.082 * math.cos(2 * math.pi * j / 12), rim_y - 0.025, bz + 0.082 * math.sin(2 * math.pi * j / 12))
            for j in range(12)]
    B.append(make_mesh("bucket_water", wpts, [list(range(12))[::-1]], M["wet"], None, False))
    for hy in (bot_y + 0.022, rim_y - 0.026):
        B.append(cyl("bucket_hoop", 0.0915 if hy > (rim_y + bot_y) / 2 else 0.087, 0.012, (bx, hy, bz), M["hoop"], verts=12,
                     cap=False))
    for sz in (-1, 1):
        B.append(rbox("bucket_post", (0.028, bar_y - rim_y + 0.030, 0.014), V(bx, (bar_y + rim_y) / 2 + 0.008, bz + sz * 0.083),
                      M["wood"]))
    B.append(rbox("bucket_bar", (0.022, 0.020, 0.180), V(bx, bar_y, bz), M["wood_d"]))
    body, head = assemble(B, face, hair, pivot)
    return body, head


# ═════════════════════════════════════════════════════════════════════════════
#  npc_clerk — 坂口, 21. Short black hair, sleepy single-lidded eyes, slouching. Blue and
#  white vertical-stripe uniform with a name tag (さかぐち), black trousers, black trainers.
# ═════════════════════════════════════════════════════════════════════════════
def build_clerk():
    M = {
        "skin": mat("skin", "#e6c2a3", 0.75),
        "hair": mat("hair", "#121015", 0.6),
        "eye": mat("eye", "#1a1414", 0.4),
        "lid": mat("eyelid", "#a9806a", 0.8),
        "brow": mat("brow", "#1c1818", 0.8),
        "mouth": mat("mouth", "#a96b62", 0.7),
        "line": mat("undereye", "#c4977e", 0.9),
        "blue": mat("uniform_blue", "#2f64b2", 0.8),
        "white": mat("uniform_white", "#eef1f4", 0.8),
        "navy": mat("uniform_navy", "#1d3361", 0.8),
        "pants": mat("pants", "#1c1d22", 0.9),
        "shoe": mat("shoes", "#1e1e20", 0.6),
        "sole": mat("shoe_sole", "#d6d6d2", 0.8),
        "tag": mat("nametag", "#f6f6f2", 0.6),
        "ink": mat("nametag_ink", "#202024", 0.8),
        "band": mat("nametag_band", "#2f64b2", 0.6),
    }
    chin, zc = 1.466, 0.074
    k = (1.05, 1.04, 1.05)
    pivot = V(0.0, 1.452, 0.050)
    sk = skull("skull", chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, M["skin"], k=k, jaw=1.08)
    face = [sk] + make_face(sk, M, {
        "chin": chin, "eye": (0.033, 0.116, 0.020, 0.0062), "eye_style": "slit", "eye_tilt": -4,
        "brow": (0.142, 0.017, 0.052, 0.002, 0.0048), "brow_drop": 0.006,
        "nose": (0.120, 0.087, 0.011, 0.020),
        "mouth": (0.057, 0.030, -0.0012, 0.0036),
        "lines": [[(0.024, 0.103), (0.034, 0.100), (0.044, 0.103)]],
        "ear": (0.105, zc - 0.018, 0.078, (0.010, 0.029, 0.017)),
    })
    face.append(tube("neck", [V(0, 1.405, 0.032), V(0, 1.458, 0.052), V(0, 1.515, 0.074)],
                     [(0.054, 0.052), (0.053, 0.051), (0.052, 0.050)], M["skin"], 8))

    def messy(i, phi):
        dr = 0.0025 * math.sin(5 * phi + i) + 0.002 * math.sin(9 * phi + 2 * i) if i <= 4 else 0.001 * math.sin(7 * phi + i)
        dy = -0.012 * abs(math.sin(4.0 * phi + 0.5)) - 0.004 if i == 4 else 0.0
        return dr, dy
    spec = [(0.226, 180, 0.012, 0.012, 0.012), (0.207, 180, 0.015, 0.016, 0.014), (0.187, 180, 0.015, 0.018, 0.014),
            (0.172, 180, 0.014, 0.017, 0.013), (0.162, 180, 0.013, 0.016, 0.013), (0.150, 116, 0.011, 0.012, 0.013),
            (0.132, 100, 0.009, 0.009, 0.012), (0.112, 86, 0.008, 0.008, 0.011), (0.092, 74, 0.007, 0.007, 0.010),
            (0.070, 64, 0.006, 0.006, 0.009), (0.052, 54, 0.005, 0.005, 0.007)]
    top = chin + HEAD_ADULT_TOP[0] * k[1]
    hair = [hair_shell("hair_short", hair_rows(chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, k, spec), M["hair"],
                       (0.0, top + 0.014, zc + HEAD_ADULT_TOP[1] * k[2]), n=18, wave=messy)]
    B = []
    rows = [
        (0.880, 0.008, 0.178, 0.112, 0.108, 2.5),
        (0.960, 0.006, 0.172, 0.106, 0.104, 2.5),
        (1.060, 0.004, 0.168, 0.102, 0.104, 2.5),
        (1.180, 0.008, 0.180, 0.104, 0.118, 2.6),
        (1.290, 0.024, 0.196, 0.106, 0.134, 2.7),
        (1.360, 0.040, 0.202, 0.094, 0.132, 2.8),
        (1.410, 0.050, 0.188, 0.076, 0.106, 2.6),
        (1.440, 0.052, 0.128, 0.062, 0.078, 2.3),
        (1.458, 0.051, 0.068, 0.054, 0.058, 2.0),
    ]
    uni = body_loft("uniform", rows, [M["blue"], M["white"], M["navy"]], n=24, cap0=None, cap1="flat",
                    fmat=lambda i, j: j % 2, capmat=2)
    B.append(uni)
    B.append(body_loft("collar", [(1.440, 0.052, 0.076, 0.064, 0.068), (1.468, 0.054, 0.066, 0.058, 0.062)], M["navy"],
                       n=12, cap0=None, cap1=None))
    # name tag on the left chest: "さかぐち"
    tag = surface_box([uni], 0.098, 1.300, (0.080, 0.032, 0.004), M["tag"])
    if tag:
        B.append(tag)
        B.append(surface_box([tag], 0.098, 1.311, (0.078, 0.007, 0.0012), M["band"]))
        for i in range(4):
            B.append(surface_box([tag], 0.076 + i * 0.0145, 1.296, (0.010, 0.011, 0.0012), M["ink"]))
    for sd in (-1, 1):
        sh, el, wr = V(sd * 0.180, 1.392, 0.050), V(sd * 0.218, 1.090, 0.068), V(sd * 0.228, 0.845, 0.104)
        B.append(tube("sleeve", [V(sd * 0.150, 1.350, 0.046), V(sd * 0.203, 1.262, 0.054), V(sd * 0.219, 1.180, 0.060)],
                      [(0.054, 0.052), (0.064, 0.062), (0.060, 0.058)], [M["blue"], M["white"]], 12, cap0="flat",
                      fmat=lambda i, j: j % 2))
        B.append(tube("arm", [lerp(sh, el, 0.25), (sh + el) / 2, el, (el + wr) / 2, wr], [0.042, 0.040, 0.034, 0.032, 0.026],
                      M["skin"], 8))
        B += hand("hand", wr, (wr - el).normalized() + V(0, -0.2, 0.05), V(-sd, 0, 0.1), V(0, 0, 1), M["skin"], k=1.12,
                  curl=0.45)
        hip, knee, ank = V(sd * 0.094, 0.930, 0.004), V(sd * 0.100, 0.500, 0.018), V(sd * 0.102, 0.090, 0.004)
        B.append(tube("leg", [hip, knee, ank], [(0.084, 0.080), (0.064, 0.060), (0.057, 0.054)], M["pants"], 10))
        heel, toe = V(sd * 0.094, 0.0, -0.085), V(sd * 0.116, 0.0, 0.190)
        B.append(foot("shoe", heel, toe, M["shoe"], w=0.048, h=0.040, sole=0.022))
        d = (toe - heel).normalized()
        c = (heel + toe) / 2 + d * 0.006
        c.y = 0.011
        B.append(rbox("sole", (0.100, 0.022, 0.292), c, M["sole"], rot3((math.degrees(math.atan2(d.x, d.z)), "y"))))
    B.append(ellip("crotch", V(0.0, 0.900, 0.004), (0.150, 0.080, 0.092), M["pants"], 10, 6))
    body, head = assemble(B, face, hair, pivot)
    return body, head


# ═════════════════════════════════════════════════════════════════════════════
#  npc_shrine — 白瀬宗一, 74, the shrine's guji. Short white hair, white hakui with the
#  collar crossed left-over-right (y shape seen from the front), asagi hakama, white tabi
#  in zori, reading glasses hanging from a cord on the chest.
# ═════════════════════════════════════════════════════════════════════════════
def build_shrine():
    M = {
        "skin": mat("skin", "#dcb294", 0.8),
        "hair": mat("hair_white", "#d9d7d2", 0.75),
        "eye": mat("eye", "#221a17", 0.4),
        "lid": mat("eyelid", "#a7816a", 0.8),
        "brow": mat("brow", "#e2dfd8", 0.85),
        "mouth": mat("mouth", "#9c625a", 0.7),
        "line": mat("wrinkle", "#b08a70", 0.9),
        "hakui": mat("hakui", "#f0efe9", 0.85),
        "eri": mat("hakui_collar", "#fbfaf6", 0.8),
        "crease": mat("hakui_crease", "#a3a097", 0.9),
        "hakama": mat("hakama_asagi", "#47a1a9", 0.85),
        "hakama_d": mat("hakama_shade", "#378890", 0.85),
        "tabi": mat("tabi", "#f3f2ee", 0.8),
        "zori": mat("zori", "#6c5a46", 0.8),
        "strap": mat("zori_strap", "#f0efe9", 0.7),
        "frame": mat("glasses_frame", "#3b2b22", 0.4, 0.3),
        "lens": mat("glasses_lens", "#b9c6ce", 0.08, 0.4),
        "cord": mat("glasses_cord", "#5b4a3a", 0.8),
    }
    chin, zc = 1.437, 0.012
    k = (1.02, 1.02, 1.02)
    pivot = V(0.0, 1.418, -0.004)
    sk = skull("skull", chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, M["skin"], k=k, jaw=1.06)
    face = [sk] + make_face(sk, M, {
        "chin": chin, "eye": (0.032, 0.114, 0.016, 0.0068), "eye_style": "slit",
        "brow": (0.140, 0.015, 0.053, 0.004, 0.0068), "brow_drop": 0.003,
        "nose": (0.120, 0.083, 0.012, 0.022),
        "mouth": (0.053, 0.030, -0.0022, 0.0030),
        "lines": [[(0.018, 0.088), (0.027, 0.070), (0.030, 0.052)], [(0.002, 0.172), (0.034, 0.170)],
                  [(0.002, 0.183), (0.028, 0.182)], [(0.053, 0.118), (0.061, 0.111)]],
        "ear": (0.103, zc - 0.022, 0.075, (0.011, 0.032, 0.019)),
    })
    face.append(tube("neck", [V(0, 1.375, -0.012), V(0, 1.425, -0.004), V(0, 1.480, 0.006)],
                     [(0.050, 0.048), (0.049, 0.047), (0.048, 0.046)], M["skin"], 8))
    spec = [(0.222, 180, 0.006, 0.006, 0.008), (0.205, 180, 0.008, 0.008, 0.010), (0.190, 180, 0.009, 0.009, 0.011),
            (0.178, 150, 0.009, 0.009, 0.011), (0.158, 118, 0.008, 0.008, 0.011), (0.136, 100, 0.007, 0.007, 0.010),
            (0.115, 80, 0.006, 0.006, 0.009), (0.088, 70, 0.005, 0.005, 0.008), (0.062, 58, 0.004, 0.004, 0.006)]
    top = chin + HEAD_ADULT_TOP[0] * k[1]
    hair = [hair_shell("hair_short", hair_rows(chin, zc, HEAD_ADULT, HEAD_ADULT_TOP, k, spec), M["hair"],
                       (0.0, top + 0.006, zc + HEAD_ADULT_TOP[1] * k[2]), n=16)]
    B = []
    rows = [
        (0.930, 0.000, 0.168, 0.108, 0.106, 2.4),
        (1.060, 0.000, 0.170, 0.110, 0.106, 2.5),
        (1.180, 0.004, 0.180, 0.118, 0.106, 2.6),
        (1.290, 0.004, 0.194, 0.112, 0.110, 2.7),
        (1.360, 0.000, 0.192, 0.090, 0.094, 2.7),
        (1.395, -0.004, 0.150, 0.070, 0.078, 2.4),
        (1.416, -0.006, 0.072, 0.056, 0.060, 2.0),
    ]
    hakui = body_loft("hakui", rows, M["hakui"], n=16, cap0="flat", cap1="flat")
    B.append(hakui)
    B.append(body_loft("eri_back", [(1.404, -0.006, 0.078, 0.064, 0.068), (1.434, -0.004, 0.066, 0.058, 0.062)], M["eri"],
                       n=12, cap0=None, cap1=None))
    # crossed collar: the wearer's left panel on top -> from his left neck (+x) down to his right waist (-x)
    outer = [(0.058, 1.408), (0.034, 1.360), (0.008, 1.310), (-0.030, 1.255), (-0.070, 1.195), (-0.104, 1.130), (-0.126, 1.060)]
    inner = [(-0.058, 1.408), (-0.036, 1.360), (-0.012, 1.318), (0.004, 1.290)]
    B.append(face_line("eri_l", hakui, outer, 0.034, M["eri"], lift=0.003, sub=2))
    B.append(face_line("eri_r", hakui, inner, 0.032, M["eri"], lift=0.0018, sub=2))
    edge = [(x - 0.017, y - 0.006) for x, y in outer[1:]]
    B.append(face_line("eri_crease", hakui, edge, 0.004, M["crease"], lift=0.0034, sub=2))
    # wide hanging sleeves (tamoto), hands coming out at the bottom front
    for sd in (-1, 1):
        srows = [(1.372, sd * 0.150, -0.004, 0.034, 0.070), (1.340, sd * 0.196, -0.004, 0.040, 0.092),
                 (1.200, sd * 0.214, -0.010, 0.040, 0.124), (1.000, sd * 0.222, -0.018, 0.038, 0.146),
                 (0.850, sd * 0.224, -0.024, 0.036, 0.152), (0.800, sd * 0.224, -0.030, 0.034, 0.146),
                 (0.782, sd * 0.224, -0.036, 0.028, 0.128)]
        rings = [sring(x, y, z, tx, wz, wz, 12, 5.0) for y, x, z, tx, wz in srows]
        B.append(loft("tamoto", rings, M["hakui"], True, "flat", "flat", [V(x, y, z) for y, x, z, tx, wz in srows]))
        sh, el, wr = V(sd * 0.178, 1.370, -0.004), V(sd * 0.214, 1.080, 0.004), V(sd * 0.218, 0.840, 0.072)
        B.append(tube("arm", [lerp(sh, el, 0.3), el, wr], [0.038, 0.033, 0.026], M["skin"], 8))
        B += hand("hand", wr, V(sd * 0.02, -1, 0.10), V(-sd, 0, 0.1), V(0, 0, 1), M["skin"], k=1.06, curl=0.45)
    # hakama: pleated front, flaring to the ankles
    hrows = [(0.060, 0.008, 0.270, 0.205, 0.195), (0.300, 0.006, 0.250, 0.180, 0.172), (0.560, 0.004, 0.225, 0.155, 0.150),
             (0.800, 0.002, 0.198, 0.128, 0.128), (0.960, 0.000, 0.178, 0.116, 0.114), (1.012, 0.000, 0.176, 0.114, 0.112)]
    nH = 24
    rings, cents = [], []
    for i, (y, cz, rx, rzf, rzb) in enumerate(hrows):
        ring = sring(0.0, y, cz, rx, rzf, rzb, nH, 2.3, 0.0)
        depth = 0.014 * (1.0 - i / (len(hrows) - 1)) + 0.003
        for j in range(nH):
            a = 2 * math.pi * j / nH
            if math.sin(a) > 0.25 and j % 2 == 0:
                p = ring[j]
                r = V(p.x, 0, p.z - cz).normalized()
                ring[j] = p + r * depth
        rings.append(ring)
        cents.append(V(0.0, y, cz))
    B.append(loft("hakama", rings, [M["hakama"], M["hakama_d"]], True, None, "flat", cents,
                  fmat=lambda i, j: 1 if (math.sin(2 * math.pi * (j + 0.5) / nH) > 0.25 and j % 2 == 1) else 0,
                  smooth=False))
    B.append(body_loft("himo", [(0.986, 0.0, 0.181, 0.119, 0.117), (1.016, 0.0, 0.179, 0.118, 0.116)], M["hakama_d"],
                       n=16, cap0=None, cap1=None))
    kp, kn = ray(B[-1], (0.0, 1.0, 1.0), (0, 0, -1))
    if kp is not None:
        B.append(rbox("himo_knot", (0.070, 0.026, 0.016), kp + V(0, 0, 0.008), M["hakama_d"]))
        B.append(rbox("himo_knot_v", (0.020, 0.060, 0.014), kp + V(0, -0.012, 0.012), M["hakama_d"]))
    B.append(rbox("koshiita", (0.240, 0.110, 0.016), V(0.0, 1.060, -0.122), M["hakama"], rot3((-6, "x"))))
    # white tabi in zori
    for sd in (-1, 1):
        heel, toe = V(sd * 0.088, 0.0, -0.065), V(sd * 0.110, 0.0, 0.175)
        B.append(foot("tabi", heel, toe, M["tabi"], w=0.042, h=0.034, sole=0.018))
        B += zori(heel, toe, M["zori"], M["strap"], sole=0.018, w=0.042, h=0.034, width=0.092)
    # reading glasses hanging from a cord on the chest
    gl = []
    for sx in (-1, 1):
        f = surface_box([hakui], sx * 0.026, 1.205, (0.044, 0.030, 0.003), M["frame"], lift=0.012)
        if f:
            gl.append(f)
            gl.append(surface_box([f], sx * 0.026, 1.205, (0.036, 0.022, 0.0016), M["lens"]))
    B += gl
    B.append(surface_box([hakui], 0.0, 1.211, (0.012, 0.005, 0.004), M["frame"], lift=0.013))
    for sx in (-1, 1):
        pts = drape([hakui], [(V(sx * 0.050, 1.205, 0.2), V(0, 0, -1)), (V(sx * 0.064, 1.290, 0.2), V(0, 0, -1)),
                              (V(sx * 0.068, 1.370, 0.2), V(0, 0, -1)), (V(sx * 0.064, 1.42, 0.0), V(-sx, -1, 0))], 0.006)
        B.append(tube("cord", pts, 0.0018, M["cord"], 4))
    body, head = assemble(B, face, hair, pivot)
    return body, head


# ═════════════════════════════════════════════════════════════════════════════
#  npc_extra — さき, 7. Blunt-fringe bob (okappa), yellow T-shirt, red suspender skirt,
#  pink sandals, a green insect cage hanging from her neck. ~1.15 m.
# ═════════════════════════════════════════════════════════════════════════════
def build_extra():
    M = {
        "skin": mat("skin", "#f3d4bf", 0.75),
        "hair": mat("hair", "#141118", 0.55),
        "eye": mat("eye", "#1b1414", 0.3),
        "mouth": mat("mouth", "#c76a64", 0.6),
        "cheek": mat("cheek", "#f2a6a2", 0.8),
        "shirt": mat("tshirt_yellow", "#f2c42e", 0.85),
        "skirt": mat("skirt_red", "#c5262f", 0.8),
        "button": mat("button", "#f3e7c4", 0.5),
        "sandal": mat("sandal_pink", "#f08db5", 0.6),
        "cage": mat("cage_green", "#38a347", 0.6),
        "cage_d": mat("cage_dark", "#1f6a2b", 0.6),
        "mesh": mat("cage_mesh", "#a8d8a4", 0.7),
        "cord": mat("cage_cord", "#2d8a3a", 0.7),
        "glint": mat("eye_glint", "#f4f4f4", 0.4),
    }
    chin, zc = 0.935, 0.0
    k = (0.97, 0.97, 0.97)
    pivot = V(0.0, 0.912, -0.008)
    sk = skull("skull", chin, zc, HEAD_CHILD, HEAD_CHILD_TOP, M["skin"], k=k)
    face = [sk] + make_face(sk, M, {
        "chin": chin, "eye": (0.031, 0.094, 0.019, 0.023), "eye_style": "oval", "eye_segs": 12,
        "nose": (0.090, 0.071, 0.005, 0.012),
        "mouth": (0.048, 0.020, 0.0028, 0.0040),
        "cheek": (0.050, 0.068, 0.022, 0.013),
    })
    face.append(tube("neck", [V(0, 0.885, -0.010), V(0, 0.920, -0.006), V(0, 0.965, 0.000)],
                     [(0.034, 0.033), (0.034, 0.033), (0.033, 0.032)], M["skin"], 8))
    spec = [(0.196, 180, 0.013, 0.013, 0.015), (0.176, 180, 0.016, 0.016, 0.018), (0.152, 180, 0.017, 0.017, 0.019),
            (0.134, 180, 0.018, 0.017, 0.020), (0.124, 180, 0.018, 0.017, 0.020),
            ("abs", 0.122, 126, 0.098, 0.095, 0.118, -0.002), ("abs", 0.095, 124, 0.100, 0.094, 0.118, -0.002),
            ("abs", 0.066, 123, 0.101, 0.090, 0.114, -0.002), ("abs", 0.040, 122, 0.100, 0.086, 0.108, -0.002),
            ("abs", 0.028, 122, 0.098, 0.084, 0.104, -0.002)]
    top = chin + HEAD_CHILD_TOP[0] * k[1]
    hair = [hair_shell("hair_okappa", hair_rows(chin, zc, HEAD_CHILD, HEAD_CHILD_TOP, k, spec), M["hair"],
                       (0.0, top + 0.009, zc + HEAD_CHILD_TOP[1] * k[2]), n=18)]
    B = []
    rows = [
        (0.660, 0.000, 0.118, 0.078, 0.074, 2.4),
        (0.740, 0.004, 0.120, 0.083, 0.074, 2.4),
        (0.820, 0.002, 0.126, 0.080, 0.074, 2.5),
        (0.870, -0.002, 0.130, 0.066, 0.068, 2.7),
        (0.898, -0.006, 0.090, 0.050, 0.054, 2.3),
        (0.915, -0.008, 0.044, 0.040, 0.042, 2.0),
    ]
    shirt = body_loft("tshirt", rows, M["shirt"], n=16, cap0="flat", cap1="flat")
    B.append(shirt)
    skirt = body_loft("skirt", [(0.400, 0.006, 0.190, 0.150, 0.140, 2.2), (0.520, 0.004, 0.160, 0.118, 0.110, 2.2),
                                (0.640, 0.002, 0.128, 0.089, 0.083, 2.3), (0.700, 0.002, 0.123, 0.085, 0.079, 2.4),
                                (0.714, 0.002, 0.122, 0.084, 0.078, 2.4)], M["skirt"], n=16, cap0=None, cap1="flat")
    B.append(skirt)
    B.append(ellip("bloomers", V(0.0, 0.590, 0.0), (0.112, 0.070, 0.078), M["skirt"], 8, 5))
    # suspenders: front buttons -> over the shoulders -> crossed at the back
    for sd in (-1, 1):
        front = drape([shirt, skirt], [(V(sd * 0.055, 0.712, 0.3), V(0, 0, -1)), (V(sd * 0.062, 0.800, 0.3), V(0, 0, -1)),
                                       (V(sd * 0.072, 0.872, 0.3), V(0, 0, -1)), (V(sd * 0.078, 0.95, 0.0), V(0, -1, 0))], 0.004)
        back = drape([shirt, skirt], [(V(sd * 0.070, 0.872, -0.3), V(0, 0, 1)), (V(sd * 0.030, 0.800, -0.3), V(0, 0, 1)),
                                      (V(-sd * 0.050, 0.712, -0.3), V(0, 0, 1))], 0.004)
        path = front + back
        B.append(tube("suspender", path, [(0.0024, 0.0135)] * len(path), M["skirt"], 4,
                      ref=[tuple(V(0, 0, 1) if p.z > 0.02 else (V(0, 1, 0) if abs(p.z) <= 0.02 else V(0, 0, -1))) for p in path],
                      sq=12, phase=math.pi / 4))
        bp, bn = ray(skirt, (sd * 0.055, 0.706, 0.4), (0, 0, -1))
        if bp is not None:
            B.append(ellip("button", bp + bn * 0.004, (0.009, 0.009, 0.004), M["button"], 6, 3))
    # arms, short yellow sleeves
    for sd in (-1, 1):
        sh, el, wr = V(sd * 0.118, 0.868, -0.008), V(sd * 0.150, 0.700, -0.004), V(sd * 0.160, 0.548, 0.028)
        B.append(tube("sleeve", [V(sd * 0.098, 0.884, -0.008), V(sd * 0.140, 0.820, -0.006), V(sd * 0.156, 0.770, -0.005)],
                      [(0.046, 0.044), (0.048, 0.046), (0.046, 0.044)], M["shirt"], 10, cap0="flat"))
        B.append(tube("arm", [sh, el, wr], [0.030, 0.025, 0.020], M["skin"], 8))
        B += hand("hand", wr, (wr - el).normalized() + V(0, -0.25, 0.04), V(-sd, 0, 0.15), V(0, 0, 1), M["skin"], k=0.72,
                  curl=0.4)
        hip, knee, ank = V(sd * 0.058, 0.580, 0.000), V(sd * 0.062, 0.310, 0.012), V(sd * 0.064, 0.058, 0.000)
        B.append(tube("leg", [hip, lerp(hip, knee, 0.5), knee, lerp(knee, ank, 0.45), ank],
                      [0.044, 0.038, 0.031, 0.031, 0.024], M["skin"], 8))
        heel, toe = V(sd * 0.060, 0.0, -0.045), V(sd * 0.072, 0.0, 0.122)
        B.append(foot("foot", heel, toe, M["skin"], w=0.030, h=0.023, sole=0.014))
        d = (toe - heel).normalized()
        c = (heel + toe) / 2 + d * 0.004
        c.y = 0.007
        B.append(rbox("sole", (0.068, 0.014, 0.188), c, M["sandal"], rot3((math.degrees(math.atan2(d.x, d.z)), "y"))))
        for t, wdt in ((0.66, 0.024), (0.30, 0.016)):
            B.append(foot_strap("strap", heel, toe, t, M["sandal"], w=0.030, h=0.023, sole=0.014, width=wdt))
    # insect cage hanging on the tummy
    cc = V(0.0, 0.742, 0.132)
    cw, ch_, cd = 0.124, 0.088, 0.074
    B.append(rbox("cage_body", (cw - 0.006, ch_ - 0.016, cd - 0.006), cc, M["mesh"]))
    B.append(rbox("cage_lid", (cw, 0.014, cd), cc + V(0, ch_ / 2 - 0.007, 0), M["cage"]))
    B.append(rbox("cage_base", (cw, 0.012, cd), cc + V(0, -ch_ / 2 + 0.006, 0), M["cage"]))
    for sx in (-1, 1):
        for sz in (-1, 1):
            B.append(rbox("cage_post", (0.008, ch_, 0.008), cc + V(sx * (cw / 2 - 0.004), 0, sz * (cd / 2 - 0.004)), M["cage"]))
    for i in range(5):
        x = -cw / 2 + cw * (i + 1) / 6
        B.append(quad("cage_bar", cc + V(x, -0.002, cd / 2 + 0.0015), V(0, 0, 1), V(0, 1, 0), 0.0035, ch_ - 0.024, M["cage_d"]))
    B.append(rbox("cage_door", (0.040, 0.034, 0.004), cc + V(0.0, -0.006, cd / 2 + 0.002), M["cage"]))
    B.append(rbox("cage_handle", (0.050, 0.008, 0.010), cc + V(0, ch_ / 2 + 0.004, 0), M["cage_d"]))
    for sd in (-1, 1):
        pts = [cc + V(sd * (cw / 2 - 0.006), ch_ / 2, 0.0)]
        pts += drape([shirt], [(V(sd * 0.060, 0.840, 0.3), V(0, 0, -1)), (V(sd * 0.050, 0.885, 0.3), V(0, -0.3, -1))], 0.005)
        pts += [V(sd * 0.046, 0.918, 0.010), V(sd * 0.036, 0.920, -0.030), V(sd * 0.012, 0.920, -0.046), V(0.0, 0.920, -0.047)]
        B.append(tube("cage_cord", pts, 0.0028, M["cord"], 3))
    body, head = assemble(B, face, hair, pivot)
    return body, head


# ═════════════════════════════════════════════════════════════════════════════
if only_requested("npc_nao"):
    run_model("npc_nao", build_nao)
if only_requested("npc_nao_sit"):
    run_model("npc_nao_sit", build_nao_sit)
if only_requested("npc_neighbor"):
    run_model("npc_neighbor", build_neighbor)
if only_requested("npc_clerk"):
    run_model("npc_clerk", build_clerk)
if only_requested("npc_shrine"):
    run_model("npc_shrine", build_shrine)
if only_requested("npc_extra"):
    run_model("npc_extra", build_extra)
