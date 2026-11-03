"""24h convenience store fixtures and the small town shrine (月見神社).

    Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/conbini_shrine.py -- --preview
    ... -- --only torii,komainu --preview
    ... -- --views <dir>        (extra debug renders from other angles, written to <dir>)

All coordinates are three.js space (x right, y up, z = front). Every model's origin is the
centre of its footprint at floor level; the front faces +z.
"""
import os
import sys
import json
import math
import random

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
from common import *  # noqa: F401,F403
import bpy
from mathutils import Vector, Matrix

CATALOG = json.load(open(os.path.join(ROOT, "src", "world", "catalog.json"), encoding="utf-8"))["models"]
D2R = math.pi / 180.0


# ═══════════════════════════════════════════════════════════════════════════
#  geometry helpers (three.js coordinates)
# ═══════════════════════════════════════════════════════════════════════════
def rotm(rx=0.0, ry=0.0, rz=0.0):
    """Rotation (degrees) applied as Z, then X, then Y (yaw last)."""
    return (Matrix.Rotation(ry * D2R, 3, "Y") @ Matrix.Rotation(rx * D2R, 3, "X")
            @ Matrix.Rotation(rz * D2R, 3, "Z"))


def _R(rot):
    if rot is None:
        return None
    return rot if isinstance(rot, Matrix) else rotm(*rot)


def xf(pts, pos=(0, 0, 0), rot=None):
    R = _R(rot)
    out = []
    for p in pts:
        v = Vector(p)
        if R is not None:
            v = R @ v
        out.append((v.x + pos[0], v.y + pos[1], v.z + pos[2]))
    return out


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


_AXIS = {"y": None, "x": (0, 0, -90), "z": (90, 0, 0)}


def _newell(pts):
    n = Vector((0.0, 0.0, 0.0))
    for i in range(len(pts)):
        a = Vector(pts[i])
        b = Vector(pts[(i + 1) % len(pts)])
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


class MB:
    """Collects faces (three.js coords) with per-face materials; build() makes one object."""

    def __init__(self, name):
        self.name = name
        self.v = []
        self.f = []
        self.mats = []

    def mi(self, m):
        for i, x in enumerate(self.mats):
            if x == m:
                return i
        self.mats.append(m)
        return len(self.mats) - 1

    def addv(self, pts):
        b = len(self.v)
        for p in pts:
            self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return b

    def face(self, idx, m, smooth=False):
        self.f.append((tuple(idx), self.mi(m), smooth))

    def oface(self, idx, m, out, smooth=False):
        """Face whose normal is flipped (if needed) to point along `out`."""
        idx = list(idx)
        n = _newell([self.v[i] for i in idx])
        if n.dot(Vector(out)) < 0:
            idx.reverse()
        self.face(idx, m, smooth)

    def poly(self, pts, m, smooth=False, both=False):
        b = self.addv(pts)
        n = len(pts)
        self.face(range(b, b + n), m, smooth)
        if both:
            b2 = self.addv(pts)
            self.face(reversed(range(b2, b2 + n)), m, smooth)

    def quad(self, a, b, c, d, m, both=False):
        self.poly([a, b, c, d], m, both=both)

    def box(self, size, pos, m, rot=None, skip="", fm=None, taper=None, smooth=False):
        w, h, d = size
        hw, hh, hd = w / 2, h / 2, d / 2
        tx, tz = taper if taper else (1.0, 1.0)
        c = [(-hw, -hh, -hd), (hw, -hh, -hd), (hw * tx, hh, -hd * tz), (-hw * tx, hh, -hd * tz),
             (-hw, -hh, hd), (hw, -hh, hd), (hw * tx, hh, hd * tz), (-hw * tx, hh, hd * tz)]
        b = self.addv(xf(c, pos, rot))
        sk = skip.split() if isinstance(skip, str) else list(skip)
        F = (("pz", (4, 5, 6, 7)), ("nz", (1, 0, 3, 2)), ("px", (5, 1, 2, 6)),
             ("nx", (0, 4, 7, 3)), ("py", (7, 6, 2, 3)), ("ny", (0, 1, 5, 4)))
        for k, idx in F:
            if k in sk:
                continue
            mm = fm.get(k, m) if fm else m
            self.face([b + i for i in idx], mm, smooth)

    def box2(self, p0, p1, m, **kw):
        """Axis-aligned box from min corner to max corner."""
        size = tuple(abs(p1[i] - p0[i]) for i in range(3))
        pos = tuple((p0[i] + p1[i]) / 2 for i in range(3))
        self.box(size, pos, m, **kw)

    def cyl(self, r, h, pos, m, seg=8, r2=None, rot=None, axis="y", caps=(True, True), smooth=True,
            a0=0.0, mcap=None, sx=1.0, sz=1.0, open_faces=(), sidemat=None, flip=False):
        r2 = r if r2 is None else r2
        R = rotm(*_AXIS[axis]) if _AXIS[axis] else None
        if rot is not None:
            R = _R(rot) @ R if R is not None else _R(rot)

        def ring(rr, y):
            return [(rr * math.cos(a0 + 2 * math.pi * i / seg) * sx, y,
                     -rr * math.sin(a0 + 2 * math.pi * i / seg) * sz) for i in range(seg)]
        if r2 <= 1e-6:
            b = self.addv(xf(ring(r, -h / 2) + [(0, h / 2, 0)], pos, R))
            for i in range(seg):
                self.face((b + i, b + (i + 1) % seg, b + seg), sidemat(i) if sidemat else m, smooth)
            if caps[0]:
                self.face([b + i for i in reversed(range(seg))], mcap or m)
            return
        if r <= 1e-6:
            b = self.addv(xf([(0, -h / 2, 0)] + ring(r2, h / 2), pos, R))
            for i in range(seg):
                self.face((b, b + 1 + (i + 1) % seg, b + 1 + i), m, smooth)
            if caps[1]:
                self.face([b + 1 + i for i in range(seg)], mcap or m)
            return
        b = self.addv(xf(ring(r, -h / 2) + ring(r2, h / 2), pos, R))
        for i in range(seg):
            if i in open_faces:
                continue
            j = (i + 1) % seg
            q = (b + i, b + j, b + seg + j, b + seg + i)
            self.face(q[::-1] if flip else q, sidemat(i) if sidemat else m, smooth)
        if caps[1]:
            self.face([b + seg + i for i in range(seg)], mcap or m)
        if caps[0]:
            self.face([b + i for i in reversed(range(seg))], mcap or m)

    def sphere(self, r, pos, m, seg=8, rings=6, scale=(1, 1, 1), rot=None, jit=0.0, rng=None, smooth=False,
               mtop=None, cut=None):
        """UV sphere; `cut` (0..1) drops the lowest rings (a dome)."""
        pts = [(0, r, 0)]
        for k in range(1, rings):
            phi = math.pi * k / rings
            y, rr = r * math.cos(phi), r * math.sin(phi)
            for i in range(seg):
                a = 2 * math.pi * i / seg
                pts.append((rr * math.cos(a), y, -rr * math.sin(a)))
        pts.append((0, -r, 0))
        if jit and rng is not None:
            pts = [(x + rng.uniform(-jit, jit) * r, y + rng.uniform(-jit, jit) * r, z + rng.uniform(-jit, jit) * r)
                   for x, y, z in pts]
        pts = [(x * scale[0], y * scale[1], z * scale[2]) for x, y, z in pts]
        b = self.addv(xf(pts, pos, rot))
        top, bot = b, b + 1 + (rings - 1) * seg

        def rv(k, i):
            return b + 1 + (k - 1) * seg + (i % seg)
        last = rings - 1 if cut is None else max(1, int(round((rings - 1) * (1 - cut))))
        for i in range(seg):
            self.face((rv(1, i), rv(1, i + 1), top), mtop or m, smooth)
        for k in range(1, last):
            for i in range(seg):
                self.face((rv(k + 1, i), rv(k + 1, i + 1), rv(k, i + 1), rv(k, i)), m, smooth)
        if cut is None:
            for i in range(seg):
                self.face((bot, rv(rings - 1, i + 1), rv(rings - 1, i)), m, smooth)
        else:
            self.face([rv(last, i) for i in reversed(range(seg))], m)

    def loft(self, path, section, m, closed=False, up=(0, 1, 0), scales=None, smooth=True, caps=True,
             mcap=None, segmat=None):
        """Sweep a closed 2D section (u, v) along a 3D path. segmat(i) may return a material per path segment."""
        n, k = len(path), len(section)
        rings = []
        for i in range(n):
            if closed:
                t = Vector(path[(i + 1) % n]) - Vector(path[(i - 1) % n])
            else:
                t = Vector(path[min(i + 1, n - 1)]) - Vector(path[max(i - 1, 0)])
            t.normalize()
            u = Vector(up)
            if abs(t.dot(u)) > 0.97:
                u = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            nv = (u - t * t.dot(u)).normalized()
            bv = t.cross(nv)
            s = scales[i] if scales else 1.0
            P = Vector(path[i])
            rings.append(self.addv([tuple(P + bv * (a * s) + nv * (c * s)) for a, c in section]))
        segs = n if closed else n - 1
        for i in range(segs):
            a, bb = rings[i], rings[(i + 1) % n]
            cm = (Vector(path[i]) + Vector(path[(i + 1) % n])) / 2
            mm = segmat(i) if segmat else m
            for j in range(k):
                j2 = (j + 1) % k
                idx = [a + j, bb + j, bb + j2, a + j2]
                cen = sum((Vector(self.v[q]) for q in idx), Vector()) / 4
                self.oface(idx, mm, cen - cm, smooth)
        if caps and not closed:
            t0 = Vector(path[0]) - Vector(path[1])
            t1 = Vector(path[-1]) - Vector(path[-2])
            self.oface([rings[0] + j for j in range(k)], mcap or m, t0)
            self.oface([rings[-1] + j for j in range(k)], mcap or m, t1)

    def extrude(self, outline, depth, pos, m, rot=None, mside=None, mback=None, back=True, smooth_side=False):
        """Prism from a CCW (x, y) outline (seen from +z), extruded along z (centred)."""
        n = len(outline)
        pts = [(x, y, depth / 2) for x, y in outline] + [(x, y, -depth / 2) for x, y in outline]
        b = self.addv(xf(pts, pos, rot))
        self.face([b + i for i in range(n)], m)
        if back:
            self.face([b + n + i for i in reversed(range(n))], mback or m)
        for i in range(n):
            j = (i + 1) % n
            self.face((b + n + i, b + n + j, b + j, b + i), mside or m, smooth_side)

    def build(self, parent=None):
        if not self.f:
            return None
        me = bpy.data.meshes.new(self.name)
        me.from_pydata([tuple(T(*p)) for p in self.v], [], [list(f[0]) for f in self.f])
        for m in self.mats:
            me.materials.append(m)
        for poly, f in zip(me.polygons, self.f):
            poly.material_index = f[1]
            poly.use_smooth = f[2]
        me.update()
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            set_parent(obj, parent)
        return obj


def tbox(mb, c, size, m_low, m_high=None, frac=0.0, mtop=None, side=1, sides=(True, True), tx=1.0, tz=1.0,
         top=True, rot=None):
    """Product-style box: front (+z, or -z when side<0), top and optional side faces only.
    The front can be two-tone (m_high on the top `frac`). tx/tz taper the top edge."""
    w, h, d = size
    hw, hh, hd = w / 2, h / 2, d / 2
    pts = [(-hw, -hh, hd), (hw, -hh, hd), (hw * tx, hh, hd * tz), (-hw * tx, hh, hd * tz),
           (-hw, -hh, -hd), (hw, -hh, -hd), (hw * tx, hh, -hd * tz), (-hw * tx, hh, -hd * tz)]
    band = m_high is not None and frac > 0
    if band:
        s = 1 - frac
        pts += [lerp3(pts[0], pts[3], s), lerp3(pts[1], pts[2], s)]
    R = rotm(0, 180 if side < 0 else 0, 0)
    if rot is not None:
        R = R @ _R(rot)
    b = mb.addv(xf(pts, c, R))

    def i(k):
        return b + k
    if band:
        mb.face((i(0), i(1), i(9), i(8)), m_low)
        mb.face((i(8), i(9), i(2), i(3)), m_high)
    else:
        mb.face((i(0), i(1), i(2), i(3)), m_low)
    if top:
        mb.face((i(3), i(2), i(6), i(7)), mtop or (m_high if band else m_low))
    if sides[0]:
        mb.face([i(4), i(0)] + ([i(8)] if band else []) + [i(3), i(7)], m_low)
    if sides[1]:
        mb.face([i(1), i(5), i(6), i(2)] + ([i(9)] if band else []), m_low)


def fquad(mb, c, w, h, m, facing="z"):
    """Single quad centred at c facing +z / -z / +x / -x / +y."""
    x, y, z = c
    hw, hh = w / 2, h / 2
    if facing == "z":
        mb.quad((x - hw, y - hh, z), (x + hw, y - hh, z), (x + hw, y + hh, z), (x - hw, y + hh, z), m)
    elif facing == "-z":
        mb.quad((x + hw, y - hh, z), (x - hw, y - hh, z), (x - hw, y + hh, z), (x + hw, y + hh, z), m)
    elif facing == "x":
        mb.quad((x, y - hh, z + hw), (x, y - hh, z - hw), (x, y + hh, z - hw), (x, y + hh, z + hw), m)
    elif facing == "-x":
        mb.quad((x, y - hh, z - hw), (x, y - hh, z + hw), (x, y + hh, z + hw), (x, y + hh, z - hw), m)
    elif facing == "-y":
        mb.quad((x - hw, y, z - hh), (x + hw, y, z - hh), (x + hw, y, z + hh), (x - hw, y, z + hh), m)
    else:
        mb.quad((x - hw, y, z + hh), (x + hw, y, z + hh), (x + hw, y, z - hh), (x - hw, y, z - hh), m)


def tex_plane(name, w, h, pos, material, rx=0.0, ry=0.0, parent=None):
    """UV 0..1 rectangle facing +z (then tilted rx / turned ry about its centre)."""
    p = plane(name, w, h, pos, material, facing="z")
    if rx:
        rotate(p, rx, "x")
    if ry:
        rotate(p, ry, "y")
    if parent is not None:
        set_parent(p, parent)
    return p


def shide(mb, top, m, length=0.32, width=0.05, steps=4, facing=0.0):
    """紙垂: white zig-zag paper strip hanging from `top` (three coords), turned by `facing` degrees."""
    R = rotm(0, facing, 0)
    seg = length / steps
    for k in range(steps):
        off = (k % 2) * width * 0.85 - width * 0.42
        y0, y1 = -k * seg, -k * seg - seg * 0.97
        q = [(off - width / 2, y1, 0), (off + width / 2, y1, 0), (off + width / 2, y0, 0), (off - width / 2, y0, 0)]
        mb.poly(xf(q, top, R), m, both=True)


def rope(mb, path, r, m1, m2, sides=6, closed=False, twist=2):
    """Twisted rope look: alternate two materials along the path segments."""
    sec = [(r * math.cos(2 * math.pi * i / sides), r * math.sin(2 * math.pi * i / sides)) for i in range(sides)]
    mb.loft(path, sec, m1, closed=closed, smooth=True, segmat=lambda i: m1 if (i // twist) % 2 == 0 else m2)


def sheet(mb, grid, th, mtop, mbot, medge, closed=False, edges=(True, True, True, True), smooth=False,
          topmat=None):
    """Thick surface from top points grid[i][j]; the underside is `th` lower. `closed` wraps i.
    edges = (i first, i last, j first, j last) side strips (ignored along i when closed)."""
    ni, nj = len(grid), len(grid[0])
    top = [[mb.addv([grid[i][j]]) for j in range(nj)] for i in range(ni)]
    bot = [[mb.addv([(grid[i][j][0], grid[i][j][1] - th, grid[i][j][2])]) for j in range(nj)] for i in range(ni)]
    irange = range(ni) if closed else range(ni - 1)
    for i in irange:
        i2 = (i + 1) % ni
        for j in range(nj - 1):
            mb.oface([top[i][j], top[i2][j], top[i2][j + 1], top[i][j + 1]], topmat(i, j) if topmat else mtop,
                     (0, 1, 0), smooth)
            mb.oface([bot[i][j], bot[i2][j], bot[i2][j + 1], bot[i][j + 1]], mbot, (0, -1, 0), smooth)

    def out(a, b):
        return tuple(grid[a[0]][a[1]][k] - grid[b[0]][b[1]][k] for k in range(3))
    if edges[2]:
        for i in irange:
            i2 = (i + 1) % ni
            mb.oface([top[i][0], top[i2][0], bot[i2][0], bot[i][0]], medge, out((i, 0), (i, 1)))
    if edges[3]:
        for i in irange:
            i2 = (i + 1) % ni
            mb.oface([top[i][nj - 1], top[i2][nj - 1], bot[i2][nj - 1], bot[i][nj - 1]], medge,
                     out((i, nj - 1), (i, nj - 2)))
    if not closed:
        if edges[0]:
            for j in range(nj - 1):
                mb.oface([top[0][j], top[0][j + 1], bot[0][j + 1], bot[0][j]], medge, out((0, j), (1, j)))
        if edges[1]:
            for j in range(nj - 1):
                mb.oface([top[ni - 1][j], top[ni - 1][j + 1], bot[ni - 1][j + 1], bot[ni - 1][j]], medge,
                         out((ni - 1, j), (ni - 2, j)))


def patch(mb, c, r, m, rng, n=7, facing="y", squash=1.0):
    """Irregular flat blob (moss, stains). facing 'y' lies on a top surface; 'z'/'-z'/'x'/'-x' on walls."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * rng.uniform(0.6, 1.0)
        u, v = rr * math.cos(a), rr * math.sin(a) * squash
        if facing == "y":
            pts.append((c[0] + u, c[1], c[2] - v))
        elif facing == "z":
            pts.append((c[0] + u, c[1] + v, c[2]))
        elif facing == "-z":
            pts.append((c[0] - u, c[1] + v, c[2]))
        elif facing == "x":
            pts.append((c[0], c[1] + v, c[2] - u))
        else:
            pts.append((c[0], c[1] + v, c[2] + u))
    mb.poly(pts, m)


def patch_on(mb, c, u, v, r, m, rng, n=7):
    """Irregular blob in the plane spanned by u (right) and v (up); it faces u x v."""
    U, V = Vector(u).normalized(), Vector(v).normalized()
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * rng.uniform(0.6, 1.0)
        pts.append(tuple(Vector(c) + U * (rr * math.cos(a)) + V * (rr * math.sin(a))))
    mb.poly(pts, m)


def disc(mb, c, normal, r, m, seg=10):
    """Flat n-gon centred at c facing `normal`."""
    n = Vector(normal).normalized()
    up = Vector((0, 1, 0)) if abs(n.y) < 0.95 else Vector((0, 0, -1))
    right = up.cross(n).normalized()
    up = n.cross(right)
    pts = [tuple(Vector(c) + right * (r * math.cos(2 * math.pi * i / seg)) + up * (r * math.sin(2 * math.pi * i / seg)))
           for i in range(seg)]
    mb.poly(pts, m)


def seg_tube(mb, p0, p1, r, m, sides=6, r2=None, caps=True):
    """Tube between two points (radius r -> r2)."""
    sec = [(math.cos(2 * math.pi * i / sides), math.sin(2 * math.pi * i / sides)) for i in range(sides)]
    r2 = r if r2 is None else r2
    mid = lerp3(p0, p1, 0.5)
    mb.loft([p0, mid, p1], [(u * 1.0, v * 1.0) for u, v in sec], m, scales=[r, (r + r2) / 2, r2], caps=caps)


def catenary(p0, p1, sag, n=10):
    pts = []
    for i in range(n + 1):
        t = i / n
        p = lerp3(p0, p1, t)
        pts.append((p[0], p[1] - sag * 4 * t * (1 - t), p[2]))
    return pts


# ═══════════════════════════════════════════════════════════════════════════
#  checks & debug views
# ═══════════════════════════════════════════════════════════════════════════
def check(model_id):
    spec = CATALOG.get(model_id, {})
    mn, mx = bounds_three()
    size = [mx[i] - mn[i] for i in range(3)]
    want = spec.get("size")
    msgs = []
    if want:
        for i, ax in enumerate("whd"):
            if abs(size[i] - want[i]) > want[i] * 0.05 + 1e-4:
                msgs.append(f"{ax}={size[i]:.3f} want {want[i]}")
    cx, cz = (mn[0] + mx[0]) / 2, (mn[2] + mx[2]) / 2
    if abs(cx) > 0.02 or abs(cz) > 0.02:
        msgs.append(f"footprint centre off ({cx:.3f}, {cz:.3f})")
    if abs(mn[1]) > 0.005:
        msgs.append(f"min y {mn[1]:.3f}")
    objs = {o.name: o for o in bpy.context.scene.objects}
    for n in list(spec.get("parts", {}).keys()) + list(spec.get("nodes", {}).keys()):
        o = objs.get(n)
        if o is None:
            msgs.append(f"missing node {n}")
        else:
            update()
            w = o.matrix_world.translation
            print(f"[pivot] {model_id}.{n} = ({w.x:.3f}, {w.z:.3f}, {-w.y:.3f})")
    used = set()
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            for m in o.data.materials:
                if m:
                    used.add(m.name)
    for m in spec.get("materials", []):
        if m not in used:
            msgs.append(f"missing material {m}")
    for name in used:
        if name.startswith("emit_"):
            bsdf = bpy.data.materials[name].node_tree.nodes.get("Principled BSDF")
            if bsdf is not None and bsdf.inputs["Emission Strength"].default_value <= 0:
                msgs.append(f"{name} has no emission")
    print(f"[check] {model_id}: size=({size[0]:.3f}, {size[1]:.3f}, {size[2]:.3f}) "
          f"{'OK' if not msgs else 'WARN ' + '; '.join(msgs)}")


def _views_dir():
    if "--views" in sys.argv:
        i = sys.argv.index("--views")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def extra_views(model_id, views):
    """views: list of (suffix, eye_dir (three), target_offset (three), dist_scale)."""
    out = _views_dir()
    if not out:
        return
    os.makedirs(out, exist_ok=True)
    scn = bpy.context.scene
    mn, mx = bounds_three()
    c = [(mn[i] + mx[i]) / 2 for i in range(3)]
    ext = max(mx[i] - mn[i] for i in range(3)) or 1.0
    for suffix, eye_dir, toff, ds in views:
        cam_data = bpy.data.cameras.new("vcam")
        cam = bpy.data.objects.new("vcam", cam_data)
        scn.collection.objects.link(cam)
        tgt = (c[0] + toff[0] * ext, c[1] + toff[1] * ext, c[2] + toff[2] * ext)
        dv = Vector(eye_dir).normalized() * ext * ds
        eye = T(tgt[0] + dv.x, tgt[1] + dv.y, tgt[2] + dv.z)
        d = T(*tgt) - eye
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.location = eye
        cam_data.lens = 40
        cam_data.clip_start = 0.01
        scn.camera = cam
        scn.render.engine = "BLENDER_WORKBENCH"
        scn.display.shading.light = "STUDIO"
        scn.display.shading.color_type = "MATERIAL"
        scn.display.shading.show_backface_culling = "--cull" in sys.argv
        scn.render.resolution_x = 520
        scn.render.resolution_y = 520
        scn.render.filepath = os.path.join(out, f"{model_id}_{suffix}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


def make(model_id, build, views=()):
    run_model(model_id, build)
    check(model_id)
    if "--cull" in sys.argv:   # debug: look for flipped faces (three.js culls back faces)
        views = [("cull_a", (1.1, 0.75, 1.6), (0, 0, 0), 1.9), ("cull_b", (-1.1, 0.6, -1.6), (0, 0, 0), 1.9)]
    if views:
        extra_views(model_id, views)


# ═══════════════════════════════════════════════════════════════════════════
#  shared palettes
# ═══════════════════════════════════════════════════════════════════════════
PROD_COLORS = [
    ("p_red", "#d23a2c"), ("p_orange", "#ec8a2a"), ("p_yellow", "#f2cf3c"), ("p_green", "#4f9a3c"),
    ("p_teal", "#2c9a8e"), ("p_blue", "#2f62b5"), ("p_sky", "#7cc0e6"), ("p_pink", "#e884aa"),
    ("p_purple", "#7c53a8"), ("p_brown", "#8a5a32"), ("p_white", "#f2f1eb"), ("p_black", "#26272a"),
    ("p_silver", "#b8bcc2"), ("p_gold", "#c9a23e"), ("p_cream", "#efe2bc"),
]


def prod_mats():
    return [mat(n, c, 0.55) for n, c in PROD_COLORS]


def glass_mat(name="glass", color="#a8c4cc", alpha=0.3):
    m = mat(name, color, 0.05 if name == "glass" else 0.85, alpha=alpha)
    c = m.diffuse_color
    m.diffuse_color = (c[0], c[1], c[2], 0.25)   # see-through in the Workbench previews
    try:
        m.surface_render_method = "BLENDED"
    except Exception:
        pass
    return m


# ═══════════════════════════════════════════════════════════════════════════
#  CONVENIENCE STORE
# ═══════════════════════════════════════════════════════════════════════════
def build_conbini_counter():
    rng = random.Random(7)
    P = prod_mats()
    white = mat("cnt_white", "#eeeeea", 0.45)
    topm = mat("cnt_top", "#d6d7d2", 0.3)
    edge = mat("cnt_edge", "#8d9093", 0.35, 0.4)
    kick = mat("cnt_kick", "#36383b", 0.7)
    green = mat("cnt_green", "#2c8a4c", 0.5)
    orange = mat("cnt_orange", "#e47a26", 0.5)
    inner = mat("cnt_inner", "#b9bab5", 0.75)
    gray = mat("cnt_gray", "#8b8f93", 0.5, 0.2)
    dark = mat("cnt_dark", "#2a2c30", 0.5)
    black = mat("cnt_black", "#141416", 0.45)
    silver = mat("cnt_silver", "#b7bbbf", 0.3, 0.7)
    paper = mat("cnt_paper", "#f4f3ee", 0.8)
    bag = mat("cnt_bag", "#e9ebe6", 0.6)
    food1 = mat("food_karaage", "#b8732a", 0.7)
    food2 = mat("food_korokke", "#c99a4c", 0.75)
    food3 = mat("food_sausage", "#8e3f22", 0.6)
    bun = mat("food_bun", "#f1ead8", 0.8)
    em_case = mat("emit_case", "#ffe2b0", 0.5, emit="#ffc46e")
    em_pos = mat("emit_pos", "#a6d2f5", 0.4, emit="#8fc8ff")
    glass = glass_mat()

    b = MB("counter")
    # main section (customer side = +z), counter top at 0.82
    X0, X1 = -1.3, 2.0
    W, CX = X1 - X0, (X0 + X1) / 2
    b.box((W - 0.04, 0.08, 0.66), (CX, 0.04, 0.0), kick, skip="ny")
    b.box((W, 0.70, 0.03), (CX, 0.43, 0.345), white, skip="ny")
    b.box((W, 0.045, 0.006), (CX, 0.655, 0.363), green, skip="ny nz")
    b.box((W, 0.022, 0.006), (CX, 0.62, 0.363), orange, skip="ny nz")
    b.box((0.03, 0.70, 0.72), (X1 - 0.015, 0.43, 0.0), white, skip="ny")
    b.box((0.03, 0.70, 0.72), (X0 + 0.015, 0.43, 0.0), white, skip="ny")
    b.box((W - 0.06, 0.02, 0.66), (CX, 0.09, 0.0), inner)
    b.box((W - 0.06, 0.02, 0.6), (CX, 0.42, 0.03), inner)
    b.box((W - 0.06, 0.14, 0.02), (CX, 0.17, -0.335), white)
    b.box((W, 0.04, 0.8), (CX, 0.80, 0.0), topm, fm={"pz": edge, "nz": edge, "px": edge})
    # POP stickers on the customer panel
    for sx in (-1.0, 0.6):
        b.box((0.16, 0.1, 0.004), (sx + 0.05, 0.47, 0.362), P[2], skip="ny nz")
        b.box((0.1, 0.03, 0.004), (sx + 0.05, 0.5, 0.365), P[0], skip="ny nz")
    # low section with the coffee machine (x∈[-2.0,-1.3], deck at 0.54)
    L0, L1 = -2.0, -1.3
    LW, LC = L1 - L0, (L0 + L1) / 2
    b.box((LW - 0.02, 0.08, 0.66), (LC + 0.01, 0.04, 0.0), kick, skip="ny")
    b.box((LW, 0.42, 0.03), (LC, 0.29, 0.345), white, skip="ny")
    b.box((LW, 0.045, 0.006), (LC, 0.4, 0.363), green, skip="ny nz")
    b.box((LW, 0.022, 0.006), (LC, 0.365, 0.363), orange, skip="ny nz")
    b.box((0.03, 0.42, 0.72), (L0 + 0.015, 0.29, 0.0), white, skip="ny")
    b.box((LW, 0.42, 0.03), (LC, 0.29, -0.345), white, skip="ny")
    b.box((LW, 0.04, 0.8), (LC, 0.52, 0.0), topm, fm={"pz": edge, "nz": edge, "nx": edge})
    # coffee machine
    cx, y0 = -1.7, 0.54
    b.box((0.40, 0.05, 0.40), (cx, y0 + 0.025, 0.0), silver, skip="ny")
    b.box((0.40, 0.22, 0.27), (cx, y0 + 0.16, -0.065), black)
    b.box((0.09, 0.22, 0.40), (cx - 0.155, y0 + 0.16, 0.0), black)
    b.box((0.09, 0.22, 0.40), (cx + 0.155, y0 + 0.16, 0.0), black)
    b.box((0.40, 0.27, 0.40), (cx, y0 + 0.405, 0.0), black, fm={"pz": dark})
    b.box((0.30, 0.10, 0.006), (cx, y0 + 0.45, 0.203), gray, skip="ny nz")
    for i, mm in enumerate((paper, P[5], P[1], P[9])):
        b.box((0.045, 0.035, 0.012), (cx - 0.1 + i * 0.067, y0 + 0.44, 0.21), mm, skip="nz")
    b.cyl(0.018, 0.04, (cx, y0 + 0.255, 0.08), silver, seg=6)
    b.cyl(0.034, 0.085, (cx, y0 + 0.0925, 0.06), paper, seg=8, r2=0.042, caps=(False, True))
    b.box((0.22, 0.03, 0.22), (cx, y0 + 0.555, -0.03), dark)
    b.box((0.1, 0.06, 0.2), (-1.42, y0 + 0.03, 0.05), paper)
    for k in range(3):
        b.cyl(0.04, 0.02, (-1.42, y0 + 0.07 + k * 0.022, 0.05), bag if k % 2 else paper, seg=8)
    b.cyl(0.04, 0.24, (-1.42, y0 + 0.2 + 0.0, -0.17), paper, seg=8, r2=0.044)

    # POS registers
    def pos(x):
        b.box((0.13, 0.03, 0.13), (x, 0.835, -0.2), dark, skip="ny")
        b.box((0.04, 0.10, 0.03), (x, 0.9, -0.2), dark)
        b.box((0.32, 0.22, 0.035), (x, 0.975, -0.21), dark, rot=(14, 0, 0), fm={"nz": em_pos})
        b.box((0.42, 0.12, 0.42), (x, 0.71, -0.13), gray, fm={"nz": white})
        b.box((0.12, 0.012, 0.012), (x, 0.69, -0.346), silver)
        b.cyl(0.012, 0.12, (x + 0.13, 0.88, 0.04), dark, seg=6)
        b.box((0.15, 0.10, 0.03), (x + 0.13, 0.985, 0.04), dark, fm={"pz": em_pos})
        b.box((0.13, 0.10, 0.16), (x - 0.21, 0.87, -0.2), dark, skip="ny")
        b.box((0.07, 0.004, 0.05), (x - 0.21, 0.921, -0.29), paper, rot=(-30, 0, 0))
        b.box((0.07, 0.11, 0.06), (x + 0.24, 0.875, -0.12), black, rot=(-15, 0, 0), skip="ny")
        b.box((0.11, 0.035, 0.15), (x - 0.12, 0.845, 0.24), dark, rot=(12, 0, 0), fm={"py": em_pos})
        for k in range(3):
            b.box((0.26, 0.012, 0.18), (x + 0.02, 0.826 + k * 0.012, -0.33 + 0.005 * k), bag)
    pos(-1.0)
    pos(0.6)
    # donation box
    gb = MB("counter_glass")
    gb.box((0.12, 0.15, 0.1), (-0.42, 0.895, 0.27), glass, skip="ny")
    b.box((0.13, 0.02, 0.11), (-0.42, 0.98, 0.27), green, skip="ny")
    b.box((0.06, 0.004, 0.012), (-0.42, 0.991, 0.27), black)
    b.box((0.122, 0.04, 0.004), (-0.42, 0.88, 0.322), P[2], skip="ny")
    for k in range(7):
        b.cyl(0.011, 0.004, (-0.46 + (k % 4) * 0.025, 0.826 + (k // 4) * 0.005, 0.25 + (k % 3) * 0.02),
              P[13] if k % 2 else P[12], seg=6, smooth=False)
    # candy / gum rack on the counter front
    b.box((0.36, 0.02, 0.14), (-0.1, 0.83, 0.31), silver)
    b.box((0.36, 0.08, 0.02), (-0.1, 0.86, 0.25), silver)
    for k in range(6):
        tbox(b, (-0.25 + k * 0.06, 0.865, 0.33), (0.05, 0.07, 0.03), P[(k * 5) % 15], P[(k * 3 + 7) % 15], 0.3,
             sides=(True, True))
        tbox(b, (-0.25 + k * 0.06, 0.92, 0.27), (0.05, 0.06, 0.03), P[(k * 7 + 2) % 15], None, 0)
    # hot snack case
    hx = 1.5
    b.box((0.64, 0.05, 0.5), (hx, 0.845, -0.03), black, skip="ny")
    b.box((0.64, 0.025, 0.5), (hx, 1.0875, -0.03), black)
    b.box((0.6, 0.2, 0.02), (hx, 0.97, -0.27), em_case, fm={"nz": black})
    b.box((0.6, 0.006, 0.44), (hx, 1.072, -0.04), em_case, skip="py")
    for sx in (-1, 1):
        b.box((0.02, 0.2, 0.02), (hx + sx * 0.31, 0.97, 0.21), black)
        b.box((0.02, 0.2, 0.02), (hx + sx * 0.31, 0.97, -0.27), black)
    for t in range(3):
        tx = hx - 0.2 + t * 0.2
        b.box((0.18, 0.012, 0.36), (tx, 0.876, -0.04), silver)
        for k in range(5):
            fx, fz = tx - 0.05 + (k % 3) * 0.05, -0.12 + (k // 3) * 0.12 + (k % 2) * 0.03
            if t == 0:
                b.sphere(0.03, (fx, 0.9, fz), food1, seg=6, rings=4, jit=0.25, rng=rng, scale=(1, 0.75, 1))
            elif t == 1:
                b.sphere(0.04, (fx, 0.895, fz), food2, seg=8, rings=4, scale=(1.2, 0.45, 0.8))
            else:
                b.cyl(0.016, 0.14, (fx - 0.01, 0.9, fz), food3, seg=6, axis="x")
        b.box((0.06, 0.03, 0.004), (tx, 0.885, 0.205), paper, rot=(-27.8, 0, 0))
    gb.box((0.6, 0.215, 0.006), (hx, 0.965, 0.165), glass, rot=(-27.8, 0, 0))
    for sx in (-1, 1):
        gb.box((0.006, 0.19, 0.46), (hx + sx * 0.302, 0.965, -0.03), glass)
    gb.box((0.6, 0.19, 0.006), (hx, 0.965, -0.255), glass)
    # steamer for buns next to the case (clerk side)
    b.box((0.26, 0.2, 0.24), (1.0, 0.92, -0.2), silver, skip="ny")
    for k in range(3):
        b.sphere(0.035, (0.93 + k * 0.07, 0.99, -0.12), bun, seg=6, rings=4, scale=(1, 0.75, 1))
    # microwave on the clerk side under the top
    b.box((0.46, 0.28, 0.34), (1.0, 0.57, -0.16), white, fm={"nz": gray})
    b.box((0.28, 0.18, 0.006), (0.94, 0.57, -0.333), black, skip="pz")
    b.box((0.08, 0.2, 0.006), (1.17, 0.57, -0.333), dark, skip="pz")
    # rolls of receipt paper and boxes on the lower shelf
    for k in range(4):
        b.cyl(0.04, 0.06, (-0.6 + k * 0.1, 0.13, -0.2), paper, seg=8, axis="z")
    for k in range(3):
        tbox(b, (0.1 + k * 0.2, 0.18, -0.15), (0.18, 0.16, 0.3), mat("cnt_carton", "#c49a62", 0.85), None, 0,
             side=-1)
    b.build()
    gb.build()


def build_conbini_back_shelf():
    rng = random.Random(21)
    P = prod_mats()
    white = mat("bs_white", "#eceeea", 0.45)
    door = mat("bs_door", "#dfe1dc", 0.4)
    topm = mat("bs_top", "#c9cbc7", 0.35)
    kick = mat("bs_kick", "#36383b", 0.7)
    back = mat("bs_back", "#34373c", 0.6)
    silver = mat("bs_silver", "#b7bbbf", 0.3, 0.7)
    green = mat("cnt_green", "#2c8a4c", 0.5)
    orange = mat("cnt_orange", "#e47a26", 0.5)
    peg = mat("bs_peg", "#a9adb0", 0.6)
    tag = mat("bs_tag", "#f6f6f0", 0.6)
    W = 3.5
    b = MB("back_shelf")
    # lower cabinet
    b.box((W - 0.04, 0.08, 0.34), (0, 0.04, -0.02), kick, skip="ny")
    b.box((W, 0.77, 0.38), (0, 0.465, -0.01), white, skip="ny")
    for i in range(6):
        x = -W / 2 + W / 12 + i * W / 6
        b.box((W / 6 - 0.02, 0.68, 0.012), (x, 0.47, 0.186), door, skip="ny nz")
        hx = x + (0.2 if i % 2 == 0 else -0.2)
        b.box((0.016, 0.12, 0.016), (hx, 0.6, 0.198), silver)
    b.box((W, 0.03, 0.4), (0, 0.865, 0.0), topm)
    # sides and top frame
    for sx in (-1, 1):
        b.box((0.03, 2.0, 0.4), (sx * (W / 2 - 0.015), 1.0, 0.0), white)
    b.box((W - 0.06, 1.12, 0.02), (0, 1.44, -0.19), back)
    b.box((W - 0.06, 0.12, 0.36), (0, 1.94, -0.02), white, skip="py")
    b.box((W, 0.03, 0.4), (0, 1.985, 0.0), white)
    b.box((W - 0.06, 0.03, 0.004), (0, 1.94, 0.162), green, skip="nz")
    b.box((W - 0.06, 0.015, 0.004), (0, 1.915, 0.162), orange, skip="nz")
    # middle zone: batteries on a pegboard, gift cards, sundries
    b.box((1.3, 0.32, 0.01), (-1.07, 1.05, -0.175), peg)
    for r in range(2):
        for k in range(8):
            x = -1.62 + k * 0.155
            y = 1.12 - r * 0.15
            b.cyl(0.003, 0.06, (x, y + 0.06, -0.14), silver, seg=4, axis="z", caps=(False, False))
            mm = (P[13], P[11], P[0], P[12])[(k + r) % 4]
            b.box((0.1, 0.13, 0.012), (x, y, -0.11), mm)
            b.box((0.05, 0.07, 0.008), (x, y - 0.015, -0.1), (P[11], P[13], P[12], P[0])[(k + r) % 4], skip="nz")
    # gift-card rack (three tiers)
    for r in range(3):
        y = 0.92 + r * 0.095
        z = 0.08 - r * 0.07
        b.box((1.1, 0.012, 0.08), (0.18, y, z), silver)
        for k in range(12):
            x = -0.32 + k * 0.091
            mm = P[(k * 7 + r * 3) % 15]
            b.box((0.06, 0.085, 0.006), (x, y + 0.045, z - 0.02), mm, rot=(-12, 0, 0), skip="ny nz")
            b.box((0.06, 0.02, 0.007), (x, y + 0.07, z - 0.016), P[(k * 3 + r + 10) % 15], rot=(-12, 0, 0),
                  skip="ny nz")
    # sundries on the right (lighter tray, mask boxes)
    b.box((0.36, 0.05, 0.22), (0.98, 0.905, 0.05), P[11])
    for k in range(10):
        b.cyl(0.012, 0.07, (0.83 + (k % 5) * 0.07, 0.95, 0.0 + (k // 5) * 0.08), P[(k * 4) % 15], seg=5)
    for k in range(3):
        tbox(b, (1.32 + k * 0.13, 0.95, 0.02), (0.12, 0.14, 0.18), (P[10], P[6], P[10])[k], P[5], 0.25)
    # cigarette display: 4 rows of packs
    rows = (1.24, 1.41, 1.58, 1.75)
    pack_cols = [(P[10], P[0]), (P[10], P[5]), (P[5], P[10]), (P[13], P[11]), (P[11], P[13]),
                 (P[10], P[3]), (P[12], P[5]), (P[6], P[10]), (P[10], P[13]), (P[0], P[10])]
    for r, y in enumerate(rows):
        b.box((W - 0.08, 0.012, 0.2), (0, y - 0.006, -0.08), silver)
        b.box((W - 0.08, 0.024, 0.006), (0, y + 0.005, 0.02), tag, skip="nz")
        x = -W / 2 + 0.07
        k = 0
        while x < W / 2 - 0.07:
            m1, m2 = pack_cols[(k * 3 + r * 7 + (k // 5)) % len(pack_cols)]
            px0, px1 = x, x + 0.054
            yb, yt, ym = y + 0.02, y + 0.108, y + 0.02 + 0.088 * 0.7
            z = 0.0
            b.quad((px0, yb, z), (px1, yb, z), (px1, ym, z), (px0, ym, z), m1)
            b.quad((px0, ym, z), (px1, ym, z), (px1, yt, z), (px0, yt, z), m2)
            x += 0.064
            k += 1
        # acrylic lip in front of each row
    b.build()


# --- gondola products -------------------------------------------------------
def _fill(mb, rng, P, x0, x1, y, zf, side, hmax, kinds, dmax):
    """Fill the shelf strip [x0,x1] at height y; fronts flush with |z| = zf on `side`."""
    x = x0 + 0.01
    while x < x1 - 0.06:
        kind = rng.choice(kinds)
        if kind == "box":
            w, h, d, n = rng.uniform(0.08, 0.13), rng.uniform(0.12, 0.22), 0.09, rng.randint(2, 4)
        elif kind == "smallbox":
            w, h, d, n = rng.uniform(0.07, 0.1), rng.uniform(0.08, 0.14), 0.07, rng.randint(2, 5)
        elif kind == "bag":
            w, h, d, n = rng.uniform(0.15, 0.2), rng.uniform(0.2, 0.27), 0.08, rng.randint(1, 3)
        elif kind == "cup":
            w, h, d, n = 0.1, 0.1, 0.1, rng.randint(2, 4)
        elif kind == "bottle":
            w, h, d, n = 0.075, rng.uniform(0.17, 0.22), 0.05, rng.randint(2, 4)
        elif kind == "tissue":
            w, h, d, n = 0.24, 0.09, 0.12, 1
        elif kind == "big":
            w, h, d, n = rng.uniform(0.2, 0.26), rng.uniform(0.24, 0.3), 0.2, 1
        else:
            w, h, d, n = 0.1, 0.15, 0.1, 2
        h = min(h, hmax)
        d = min(d, dmax)
        m1 = P[rng.randrange(len(P))]
        m2 = P[rng.randrange(len(P))]
        if m2 == m1:
            m2 = P[(P.index(m1) + 5) % len(P)]
        two = rng.random() < 0.55
        for i in range(n):
            if x + w > x1 - 0.005:
                break
            first, last = i == 0, (i == n - 1) or (x + 2 * w > x1 - 0.005)
            cx = x + w / 2
            cz = side * (zf - d / 2 - 0.004)
            sides = (first, last) if side > 0 else (last, first)
            if kind in ("box", "smallbox", "cup", "bottle"):
                sides = (False, False)
            if kind == "bag":
                tbox(mb, (cx, y + h / 2, cz), (w * 0.96, h, d), m1, m2, 0.13, side=side, sides=sides, tz=0.3)
            elif kind == "cup":
                for s in range(2 if hmax > 0.22 else 1):
                    tbox(mb, (cx, y + 0.05 + s * 0.1, cz), (0.085, 0.1, 0.085), m1, None, 0, mtop=m2,
                         side=side, sides=sides, tx=1.18, tz=1.18)
            elif kind == "bottle":
                tbox(mb, (cx, y + h * 0.42, cz), (w * 0.85, h * 0.84, d), m1, m2, 0.4, side=side, sides=sides)
                tbox(mb, (cx, y + h * 0.92, cz), (w * 0.3, h * 0.16, d * 0.5), m2, None, 0, side=side,
                     sides=(False, False))
            elif kind == "tissue":
                for s in range(int(hmax // 0.095)):
                    tbox(mb, (cx, y + 0.045 + s * 0.093, cz), (w * 0.97, 0.09, d), P[10], m1, 0.35, mtop=m1,
                         side=side, sides=sides)
            elif kind == "big":
                tbox(mb, (cx, y + h / 2, cz), (w * 0.97, h, d), P[10], m1, 0.3, side=side, sides=sides)
            else:
                tbox(mb, (cx, y + h / 2, cz), (w * 0.97, h, d), m1, m2 if two else None, 0.3, mtop=m2,
                     side=side, sides=sides)
            x += w
        x += rng.uniform(0.004, 0.014)


def build_conbini_shelf():
    rng = random.Random(33)
    P = prod_mats()
    white = mat("gd_white", "#eff0ec", 0.5)
    gray = mat("gd_gray", "#c4c6c6", 0.45)
    post = mat("gd_post", "#9da1a4", 0.4, 0.4)
    kick = mat("gd_kick", "#55585b", 0.7)
    rail = mat("gd_rail", "#e1e3e3", 0.4)
    pop_r = mat("gd_pop_red", "#d8332a", 0.5)
    pop_y = mat("gd_pop_yel", "#f5d33a", 0.5)
    b = MB("gondola")
    L = 3.4
    levels = [(0.1, 0.42, 0.33), (0.45, 0.38, 0.32), (0.8, 0.34, 0.32), (1.15, 0.3, 0.27)]
    b.box((L, 0.1, 0.84), (0, 0.05, 0), kick, skip="ny")
    b.box((L, 0.02, 0.84), (0, 0.1, 0), gray, skip="ny")
    b.box((L, 1.35, 0.03), (0, 0.775, 0), white)
    b.box((L, 0.05, 0.06), (0, 1.475, 0), white)
    for x in (-L / 2, -L / 6, L / 6, L / 2):
        b.box((0.04, 1.4, 0.06), (x, 0.75, 0), post)
    for side in (1, -1):
        for li, (y, dep, hmax) in enumerate(levels):
            if li > 0:
                b.box((L, 0.02, dep), (0, y - 0.01, side * (0.02 + dep / 2)), gray)
            b.box((L, 0.045, 0.012), (0, y - 0.005, side * (0.026 + dep)), rail, skip="ny")
            # price tags
            for k in range(9):
                tx = -L / 2 + 0.2 + k * 0.38
                fquad(b, (tx, y - 0.005, side * (0.0335 + dep)), 0.06, 0.026, (pop_y, pop_y, pop_r)[k % 3],
                      "z" if side > 0 else "-z")
    # products: food on +z, daily goods on -z
    front = [["big", "bag", "box"], ["cup"], ["bag", "bag", "box"], ["smallbox", "box"]]
    backk = [["big", "big", "tissue"], ["tissue", "box"], ["bottle", "box"], ["smallbox", "bottle"]]
    for side, kinds in ((1, front), (-1, backk)):
        for li, (y, dep, hmax) in enumerate(levels):
            _fill(b, rng, P, -L / 2 + 0.02, L / 2 - 0.02, y + (0.0 if li == 0 else 0.0), 0.02 + dep, side,
                  hmax, kinds[li], dep - 0.02)
    # end caps (face ±x)
    for sx in (-1, 1):
        xc = sx * (L / 2 + 0.15)
        b.box((0.3, 0.1, 0.84), (xc, 0.05, 0), kick, skip="ny")
        b.box((0.03, 1.35, 0.84), (sx * (L / 2 + 0.015), 0.775, 0), white)
        b.box((0.3, 0.03, 0.84), (xc, 1.485, 0), white)
        for z in (-0.42, 0.42):
            b.box((0.3, 1.4, 0.03), (xc, 0.75, z - 0.015 * (1 if z > 0 else -1)), white)
        b.box((0.012, 0.22, 0.7), (sx * (L / 2 + 0.3), 1.33, 0), pop_r if sx > 0 else pop_y)
        b.box((0.014, 0.08, 0.5), (sx * (L / 2 + 0.302), 1.36, 0), pop_y if sx > 0 else pop_r)
        for li, y in enumerate((0.1, 0.5, 0.88)):
            if li > 0:
                b.box((0.26, 0.02, 0.8), (xc, y - 0.01, 0), gray)
            b.box((0.012, 0.04, 0.8), (sx * (L / 2 + 0.29), y - 0.005, 0), rail)
            m1 = P[(li * 4 + (2 if sx > 0 else 8)) % 15]
            m2 = P[(li * 4 + (6 if sx > 0 else 11)) % 15]
            z = -0.36
            while z < 0.33:
                hh = 0.3 if li < 2 else 0.24
                c = (sx * (L / 2 + 0.16), y + hh / 2, z + 0.055)
                tbox(b, c, (0.11, hh, 0.2), m1, m2, 0.25, rot=(0, 90 * sx, 0), sides=(False, False))
                z += 0.118
    b.build()


def build_conbini_drink_fridge():
    rng = random.Random(44)
    P = prod_mats()
    white = mat("df_white", "#eef0ee", 0.45)
    alu = mat("df_alu", "#c3c7cb", 0.35, 0.6)
    kick = mat("df_kick", "#3c3f42", 0.7)
    grill = mat("df_grill", "#141516", 0.6)
    shelf = mat("df_shelf", "#9aa0a6", 0.4, 0.5)
    rail = mat("df_rail", "#f4f4f0", 0.5)
    em = mat("emit_fridge", "#f2f7ff", 0.4, emit="#eaf3ff")
    glass = glass_mat()
    liq = {
        "tea": mat("dr_tea", "#a8742e", 0.3), "green": mat("dr_green", "#b9c260", 0.3),
        "water": mat("dr_water", "#d8e8f0", 0.2), "cola": mat("dr_cola", "#3a1d14", 0.3),
        "milk": mat("dr_milk", "#f3f1ea", 0.5), "orange": mat("dr_orange", "#f09a2a", 0.3),
        "sport": mat("dr_sport", "#cfe6f2", 0.25), "coffee": mat("dr_coffee", "#5a3a22", 0.3),
    }
    cap_w = mat("dr_cap_white", "#f4f4f2", 0.5)
    b = MB("drink_fridge")
    W, H, Dp = 3.0, 2.1, 0.8
    # cabinet
    b.box((W, 0.12, Dp - 0.04), (0, 0.06, -0.02), kick, skip="ny")
    for k in range(10):
        fquad(b, (-1.2 + k * 0.27, 0.06, 0.3605), 0.12, 0.012, grill)
    b.box((W, 0.12, Dp), (0, 2.04, 0), white)
    b.box((W, 0.13, Dp - 0.02), (0, 1.915, -0.01), white, fm={"pz": em, "ny": em})
    for sx in (-1, 1):
        b.box((0.04, 1.73, Dp), (sx * (W / 2 - 0.02), 0.985, 0), white)
    b.box((W - 0.08, 1.73, 0.02), (0, 0.985, -0.37), em, fm={"nz": white})
    b.box((W - 0.08, 0.02, 0.72), (0, 0.13, -0.02), shelf)
    # shelves
    levels = [0.14, 0.48, 0.82, 1.16, 1.5]
    for y in levels[1:]:
        b.box((W - 0.08, 0.018, 0.64), (0, y - 0.009, -0.04), shelf)
    for y in levels:
        b.box((W - 0.08, 0.03, 0.01), (0, y - 0.005, 0.285), rail)
        for k in range(12):
            fquad(b, (-1.32 + k * 0.24, y - 0.005, 0.2905), 0.05, 0.022, P[(k * 5 + int(y * 10)) % 15])
    # drinks
    def run_items(x0, x1, y, kind, gap=None):
        x = x0
        while x < x1 - 0.05:
            if kind == "2l":
                w, h = 0.1, 0.31
            elif kind == "pack":
                w, h = 0.075, 0.22
            elif kind == "can":
                w, h = 0.068, 0.125
            else:
                w, h = 0.07, 0.215
            n = rng.randint(2, 4)
            sort = rng.choice(list(liq.keys()))
            lab = P[rng.randrange(15)]
            cap = cap_w if rng.random() < 0.6 else P[rng.randrange(15)]
            for i in range(n):
                if x + w > x1 - 0.005:
                    break
                cx = x + w / 2
                if gap and gap[0] < cx < gap[1]:
                    x += w
                    continue
                first, last = i == 0, (i == n - 1)
                z = 0.2
                if kind == "can":
                    for s in range(2):
                        tbox(b, (cx, y + h / 2 + s * h, z), (w * 0.94, h, 0.066), lab, alu, 0.08,
                             sides=(first, last), top=(s == 1))
                elif kind == "pack":
                    tbox(b, (cx, y + h * 0.42, z), (w * 0.95, h * 0.84, 0.07), lab, liq["milk"], 0.3,
                         sides=(first, last), top=False)
                    tbox(b, (cx, y + h * 0.92, z), (w * 0.95, h * 0.16, 0.07), liq["milk"], None, 0,
                         sides=(first, last), tz=0.08)
                else:
                    tbox(b, (cx, y + h * 0.33, z), (w * 0.86, h * 0.66, 0.065), lab, liq[sort], 0.35,
                         sides=(first, last), top=False)
                    tbox(b, (cx, y + h * 0.77, z), (w * 0.86, h * 0.22, 0.065), liq[sort], None, 0,
                         sides=(first, last), tx=0.45, tz=0.45, top=False)
                    tbox(b, (cx, y + h * 0.94, z), (w * 0.34, h * 0.12, 0.024), cap, None, 0, sides=(False, False))
                x += w
            x += rng.uniform(0.004, 0.012)
    kinds = ["2l", "pack", "pet", "pet", "can"]
    for d in range(3):
        dx = -1.0 + d
        for li, y in enumerate(levels):
            gap = (-0.17, 0.17) if (d == 1 and li == 3) else None
            run_items(dx - 0.47, dx + 0.47, y, kinds[li], gap)
            # back stock (darker silhouettes) except behind the gap where the face appears
            if gap:
                for gx0, gx1 in ((dx - 0.47, dx - 0.2), (dx + 0.2, dx + 0.47)):
                    b.box((gx1 - gx0, 0.18, 0.2), ((gx0 + gx1) / 2, y + 0.09, -0.08), P[11], skip="ny nz")
            else:
                b.box((0.92, 0.18, 0.2), (dx, y + 0.09, -0.08), P[11 if li % 2 else 9], skip="ny nz")
    # doors (aluminium frame, glass, handle, stickers)
    fr = MB("doors")
    gl = MB("door_glass")
    for d in range(3):
        dx = -1.0 + d
        x0, x1, y0, y1 = dx - 0.49, dx + 0.49, 0.13, 1.84
        z = 0.38
        fr.box((0.045, y1 - y0, 0.04), (x0 + 0.0225, (y0 + y1) / 2, z), alu)
        fr.box((0.045, y1 - y0, 0.04), (x1 - 0.0225, (y0 + y1) / 2, z), alu)
        fr.box((x1 - x0, 0.05, 0.04), (dx, y0 + 0.025, z), alu)
        fr.box((x1 - x0, 0.05, 0.04), (dx, y1 - 0.025, z), alu)
        fr.box((0.022, 0.5, 0.025), (x1 - 0.07, 1.05, 0.415), alu, smooth=False)
        fr.box((0.02, 0.02, 0.03), (x1 - 0.07, 1.27, 0.4), alu)
        fr.box((0.02, 0.02, 0.03), (x1 - 0.07, 0.83, 0.4), alu)
        gl.box((x1 - x0 - 0.09, y1 - y0 - 0.1, 0.006), (dx, (y0 + y1) / 2, z), glass)
        fquad(fr, (dx - 0.25, 1.7, 0.3845), 0.12, 0.06, P[0])
        fquad(fr, (dx + 0.2, 1.72, 0.3845), 0.08, 0.05, P[2])
    b.build()
    fr.build()
    gl.build()


def magazine(mb, base, w, h, tilt, m_cover, m_title, m_photo, m_edge):
    """A magazine standing face-out; `base` = bottom-front-centre, leaning back by `tilt` degrees."""
    R = rotm(-tilt, 0, 0)
    bx, by, bz = base
    d = 0.008

    def P_(x, y, z):
        v = R @ Vector((x, y, z))
        return (v.x + bx, v.y + by, v.z + bz)
    hw = w / 2
    yt = h * 0.82
    mb.quad(P_(-hw, 0, 0), P_(hw, 0, 0), P_(hw, yt, 0), P_(-hw, yt, 0), m_cover)
    mb.quad(P_(-hw, yt, 0), P_(hw, yt, 0), P_(hw, h, 0), P_(-hw, h, 0), m_title)
    mb.quad(P_(-hw * 0.7, h * 0.12, 0.002), P_(hw * 0.75, h * 0.12, 0.002), P_(hw * 0.75, h * 0.62, 0.002),
            P_(-hw * 0.7, h * 0.62, 0.002), m_photo)
    mb.quad(P_(-hw, h, 0), P_(hw, h, 0), P_(hw, h, -d), P_(-hw, h, -d), m_edge)


def build_conbini_magazine():
    rng = random.Random(55)
    P = prod_mats()
    white = mat("mg_white", "#eceeea", 0.5)
    kick = mat("mg_kick", "#3c3f42", 0.7)
    lip = mat("mg_lip", "#c9ccce", 0.4, 0.3)
    paper = mat("mg_paper", "#f1efe6", 0.8)
    skin = mat("mg_photo_skin", "#e2b89a", 0.7)
    W = 3.0
    b = MB("magazine_rack")
    b.box((W - 0.04, 0.08, 0.36), (0, 0.04, 0.0), kick, skip="ny")
    b.box((W, 0.02, 0.38), (0, 0.09, 0.0), white)
    b.box((W, 1.0, 0.03), (0, 0.5, -0.185), white)
    outline = [(-0.2, 0.0), (0.2, 0.0), (0.2, 0.42), (0.1, 0.45), (0.06, 0.72), (-0.02, 0.75), (-0.06, 1.0),
               (-0.2, 1.0)]
    for sx in (-1, 1):
        b.extrude(outline, 0.03, (sx * (W / 2 - 0.015), 0, 0), white, rot=(0, -90, 0))
    tiers = [(0.1, 0.165, 0.2, 10, 0.02), (0.42, 0.08, 0.28, 16, 0.3), (0.7, -0.01, 0.285, 20, 0.33)]
    for ti, (y, zf, h, tilt, _) in enumerate(tiers):
        if ti > 0:
            b.box2((-W / 2 + 0.03, y - 0.02, -0.17), (W / 2 - 0.03, y, zf + 0.02), white)
            b.box((W - 0.06, 0.045, 0.012), (0, y + 0.012, zf + 0.012), lip)
        x = -W / 2 + 0.05
        while x < W / 2 - 0.12:
            w = rng.uniform(0.15, 0.17) if ti == 0 else rng.uniform(0.2, 0.225)
            if x + w > W / 2 - 0.04:
                break
            hh = h * rng.uniform(0.94, 1.0)
            cover = P[rng.randrange(15)]
            title = P[rng.randrange(15)]
            photo = skin if rng.random() < 0.4 else P[rng.randrange(15)]
            magazine(b, (x + w / 2, y + 0.002, zf), w, hh, tilt, cover, title, photo, paper)
            x += w + rng.uniform(0.008, 0.03)
        for k in range(1, 6):
            b.box((0.006, 0.06, 0.006), (-W / 2 + k * W / 6, y + 0.03, zf + 0.01), lip)
    b.build()


def build_atm():
    gray = mat("atm_gray", "#b9bdc1", 0.45, 0.2)
    light = mat("atm_light", "#d7dadd", 0.4, 0.1)
    dark = mat("atm_dark", "#4a4e53", 0.5, 0.2)
    black = mat("atm_black", "#141517", 0.4)
    blue = mat("atm_blue", "#2f5f9e", 0.45)
    white = mat("atm_white", "#f2f3f0", 0.5)
    silver = mat("atm_silver", "#c2c6ca", 0.3, 0.7)
    green = mat("atm_led", "#3fbf5a", 0.4)
    yellow = mat("atm_yellow", "#f2cf3c", 0.5)
    em = mat("emit_screen", "#7fb8f0", 0.3, emit="#6fb0ff")
    b = MB("atm")
    b.box((0.56, 0.06, 0.58), (0, 0.03, -0.02), black, skip="ny")
    b.box((0.6, 0.86, 0.6), (0, 0.49, -0.025), gray, fm={"pz": light})
    b.box((0.6, 0.04, 0.65), (0, 0.94, 0.0), dark, fm={"py": gray})
    b.box((0.6, 0.51, 0.42), (0, 1.195, -0.115), gray, fm={"pz": light})
    b.box((0.5, 0.39, 0.04), (0, 1.13, 0.2), dark, rot=(-32, 0, 0))
    b.box((0.36, 0.26, 0.01), (0, 1.15, 0.215), em, rot=(-32, 0, 0), skip="nz")
    for sx in (-1, 1):
        b.box((0.02, 0.46, 0.3), (sx * 0.29, 1.18, 0.17), dark)
    b.box((0.42, 0.14, 0.02), (-0.09, 1.375, 0.105), blue, skip="ny")
    b.box((0.24, 0.035, 0.006), (-0.09, 1.375, 0.117), white, skip="ny nz")
    b.cyl(0.05, 0.02, (0.21, 1.385, 0.105), silver, seg=10, axis="z")
    b.cyl(0.042, 0.01, (0.21, 1.385, 0.118), mat("mirror", "#9aa0a4", 0.1, 0.9), seg=10, axis="z")
    # slots on the front of the lower cabinet
    b.box((0.11, 0.035, 0.01), (0.14, 0.86, 0.278), green, skip="nz")
    b.box((0.08, 0.008, 0.012), (0.14, 0.86, 0.282), black, skip="nz")
    b.box((0.17, 0.035, 0.01), (-0.12, 0.86, 0.278), dark, skip="nz")
    b.box((0.15, 0.01, 0.012), (-0.12, 0.86, 0.282), black, skip="nz")
    b.box((0.06, 0.012, 0.012), (0.14, 0.8, 0.28), black, skip="nz")
    # cash shutter on the ledge
    b.box((0.34, 0.006, 0.12), (0, 0.963, 0.2), silver, skip="ny")
    b.box((0.3, 0.007, 0.08), (0, 0.964, 0.2), black, skip="ny")
    # access panel seams and kick
    b.box((0.5, 0.004, 0.006), (0, 0.45, 0.276), dark, skip="nz")
    b.box((0.012, 0.03, 0.01), (0.22, 0.55, 0.278), silver)
    b.box((0.08, 0.08, 0.004), (-0.24, 1.25, 0.095), yellow, skip="nz")
    b.build()


def build_copy_machine():
    white = mat("cp_white", "#eceeed", 0.45)
    light = mat("cp_light", "#d6d8d7", 0.45)
    gray = mat("cp_gray", "#a4a8a7", 0.45)
    dark = mat("cp_dark", "#3a3c3e", 0.5)
    black = mat("cp_black", "#151617", 0.5)
    blue = mat("cp_blue", "#2a62b0", 0.45)
    silver = mat("cp_silver", "#c0c4c8", 0.3, 0.7)
    paper = mat("cp_paper", "#f7f7f2", 0.8)
    green = mat("cp_green", "#3cae54", 0.4)
    em = mat("emit_screen", "#9fd3ff", 0.3, emit="#8cc8ff")
    b = MB("copier")
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.cyl(0.02, 0.04, (sx * 0.25, 0.02, sz * 0.22 - 0.03), black, seg=6)
    b.box((0.58, 0.5, 0.55), (0, 0.29, -0.035), light, skip="ny")
    for i, y in enumerate((0.13, 0.28, 0.43)):
        b.box((0.56, 0.135, 0.01), (0, y, 0.245), white, skip="nz")
        b.box((0.16, 0.025, 0.006), (0, y + 0.03, 0.252), dark, skip="nz")
        b.box((0.03, 0.06, 0.004), (0.24, y, 0.251), (paper, gray, paper)[i], skip="nz")
    b.box((0.6, 0.36, 0.55), (0, 0.72, -0.035), white)
    b.box((0.6, 0.012, 0.004), (0, 0.895, 0.242), blue, skip="nz")
    b.box((0.44, 0.1, 0.01), (-0.04, 0.72, 0.242), black, skip="nz")
    b.box((0.3, 0.004, 0.2), (-0.06, 0.69, 0.16), paper)
    b.box((0.6, 0.1, 0.55), (0, 0.95, -0.035), light)
    b.box((0.56, 0.06, 0.5), (0, 1.03, -0.05), white)
    b.box((0.4, 0.012, 0.22), (-0.03, 1.07, -0.12), gray, rot=(-8, 0, 0))
    b.box((0.36, 0.008, 0.2), (-0.03, 1.08, -0.12), paper, rot=(-8, 0, 0))
    # operation panel (tilted toward the user)
    b.box((0.46, 0.04, 0.17), (0.04, 0.985, 0.225), dark, rot=(25, 0, 0))
    b.box((0.2, 0.012, 0.11), (-0.04, 1.01, 0.225), em, rot=(25, 0, 0), skip="ny")
    b.box((0.05, 0.014, 0.05), (0.18, 1.007, 0.24), green, rot=(25, 0, 0), skip="ny")
    for k in range(6):
        b.box((0.022, 0.012, 0.022), (0.1 + (k % 2) * 0.03, 1.003, 0.19 + (k // 2) * 0.035), gray,
              rot=(25, 0, 0), skip="ny")
    # coin unit on the right side
    b.box((0.05, 0.42, 0.32), (0.325, 0.75, 0.02), gray, fm={"px": light})
    b.box((0.006, 0.05, 0.012), (0.351, 0.86, 0.06), black, skip="nx")
    b.box((0.006, 0.04, 0.06), (0.351, 0.76, 0.06), silver, skip="nx")
    b.box((0.006, 0.07, 0.1), (0.351, 0.65, 0.04), dark, skip="nx")
    b.box((0.006, 0.02, 0.06), (0.351, 0.95, 0.04), green, skip="nx")
    # output tray on the left side
    b.box((0.05, 0.015, 0.3), (-0.325, 0.62, -0.03), gray, rot=(0, 0, 12))
    b.box((0.04, 0.006, 0.24), (-0.322, 0.633, -0.03), paper, rot=(0, 0, 12))
    b.build()


def build_conbini_sign():
    white = mat("sg_white", "#e4e6e3", 0.45)
    alu = mat("sg_alu", "#b9bdc1", 0.35, 0.6)
    green = mat("sg_green", "#1f6f3a", 0.45)
    orange = mat("sg_orange", "#e0731a", 0.45)
    dark = mat("sg_dark", "#3a3d40", 0.6)
    em = mat("emit_conbini_sign", "#ffffff", 0.4, emit="#ffffff")
    b = MB("sign_box")
    W, H, D = 6.0, 0.9, 0.25
    b.box((W - 0.36, H - 0.08, D - 0.03), (0, H / 2, -0.015), white, skip="pz")
    b.box((W - 0.36, 0.04, D), (0, H - 0.02, 0), green, fm={"ny": white})
    b.box((W - 0.36, 0.04, D), (0, 0.02, 0), orange, fm={"py": white})
    for sx in (-1, 1):
        b.box((0.18, H, D), (sx * (W / 2 - 0.09), H / 2, 0), alu)
        b.box((0.004, H * 0.7, D * 0.6), (sx * (W / 2 + 0.002), H / 2, 0), dark, skip="nx" if sx > 0 else "px")
    for x in (-2.0, 0.0, 2.0):
        b.box((0.08, 0.5, 0.02), (x, 0.45, -0.115), dark)
    b.build()
    tex_plane("sign_face", 5.6, 0.86, (0, H / 2, D / 2 - 0.005), em)


def build_auto_door():
    alu = mat("ad_alu", "#b9bec2", 0.35, 0.65)
    dark = mat("ad_dark", "#2c2e31", 0.5)
    black = mat("ad_black", "#101112", 0.4)
    rail = mat("ad_rail", "#6e7377", 0.5, 0.5)
    green = mat("ad_sticker", "#2c8a4c", 0.5)
    white = mat("ad_white", "#f2f3ef", 0.5)
    red = mat("ad_red", "#b02a24", 0.4)
    glass = glass_mat()
    f = MB("door_frame")
    f.box((0.06, 2.2, 0.12), (-0.97, 1.1, 0), alu)
    f.box((0.06, 2.2, 0.12), (0.97, 1.1, 0), alu)
    f.box((2.0, 0.2, 0.12), (0, 2.3, 0), alu, fm={"ny": dark})
    f.box((0.3, 0.05, 0.05), (0, 2.175, 0.03), black)
    f.box((0.2, 0.02, 0.01), (0, 2.16, 0.055), red, skip="nz")
    f.box((1.88, 0.012, 0.1), (0, 0.006, 0), rail, skip="ny")
    f.build()
    for name, cx, sgn in (("pane_l", -0.47, -1), ("pane_r", 0.47, 1)):
        p = MB(name)
        w, y0, y1, z = 0.94, 0.015, 2.145, 0.04
        p.box((0.05, y1 - y0, 0.035), (cx - w / 2 + 0.025, (y0 + y1) / 2, z), alu)
        p.box((0.05, y1 - y0, 0.035), (cx + w / 2 - 0.025, (y0 + y1) / 2, z), alu)
        p.box((w - 0.1, 0.05, 0.035), (cx, y1 - 0.025, z), alu)
        p.box((w - 0.1, 0.1, 0.035), (cx, y0 + 0.05, z), alu)
        p.box((w - 0.1, y1 - y0 - 0.15, 0.008), (cx, (y0 + 0.1 + y1 - 0.05) / 2, z), glass)
        # sticker band (outside and inside) and the 自動ドア plate
        for zz, sk in ((z + 0.0045, "nz"), (z - 0.0045, "pz")):
            for k in range(6):
                p.box((0.05, 0.05, 0.002), (cx - 0.32 + k * 0.13, 1.05, zz), green, skip=sk)
            p.box((0.3, 0.1, 0.002), (cx - sgn * 0.12, 1.38, zz), white, skip=sk)
            p.box((0.26, 0.03, 0.0025), (cx - sgn * 0.12, 1.38, zz + (0.0005 if sk == "nz" else -0.0005)), green,
                  skip=sk)
        o = p.build()
        set_origin(o, (cx, 1.1, z))


def build_trash_bins():
    body = mat("tb_body", "#6a6158", 0.6, 0.2)
    top = mat("tb_top", "#4c453f", 0.55, 0.2)
    dark = mat("tb_dark", "#0f0f10", 0.8)
    blue = mat("tb_blue", "#2f6db5", 0.45)
    orange = mat("tb_orange", "#e07a22", 0.45)
    green = mat("tb_green", "#3a8a45", 0.45)
    white = mat("tb_white", "#efefe9", 0.5)
    silver = mat("tb_silver", "#b7bbbf", 0.3, 0.6)
    bag = mat("tb_bag", "#dfe3e1", 0.6)
    can = mat("tb_can", "#c23128", 0.4, 0.5)
    b = MB("trash_bins")
    b.box((1.36, 0.05, 0.4), (0, 0.025, -0.02), dark, skip="ny")
    b.box((1.4, 0.85, 0.4), (0, 0.475, -0.025), body, skip="ny")
    b.box((1.44, 0.03, 0.45), (0, 0.915, 0.0), top)
    b.box((1.4, 0.06, 0.38), (0, 0.96, -0.03), top, taper=(1.0, 0.7))
    for i, (x, col) in enumerate(((-0.465, blue), (0.0, orange), (0.465, green))):
        b.box((0.42, 0.34, 0.012), (x, 0.7, 0.178), col, skip="nz")
        b.box((0.3, 0.07, 0.004), (x, 0.82, 0.186), white, skip="nz")
        b.box((0.22, 0.02, 0.005), (x, 0.82, 0.188), col, skip="nz")
        if i < 2:
            b.cyl(0.075, 0.01, (x, 0.66, 0.185), dark, seg=10, axis="z")
        else:
            b.box((0.24, 0.07, 0.01), (x, 0.66, 0.185), dark, skip="nz")
            b.box((0.12, 0.06, 0.03), (x + 0.03, 0.66, 0.195), bag, rot=(0, 0, 10))
        b.box((0.42, 0.42, 0.006), (x, 0.27, 0.178), body, skip="nz")
        b.box((0.08, 0.02, 0.02), (x, 0.43, 0.19), silver)
        b.cyl(0.012, 0.01, (x + 0.15, 0.43, 0.185), silver, seg=6, axis="z")
    b.box((0.012, 0.86, 0.01), (-0.2325, 0.47, 0.178), dark, skip="nz")
    b.box((0.012, 0.86, 0.01), (0.2325, 0.47, 0.178), dark, skip="nz")
    b.build()


def build_car_stop():
    conc = mat("cs_concrete", "#9c9a92", 0.95)
    grime = mat("cs_grime", "#6f6d66", 0.95)
    yellow = mat("cs_yellow", "#f2c62a", 0.4)
    dark = mat("cs_dark", "#3b3a37", 0.9)
    b = MB("car_stop")
    prof = [(-0.075, 0.0), (0.075, 0.0), (0.06, 0.09), (0.035, 0.12), (-0.035, 0.12), (-0.06, 0.09)]
    b.extrude(prof, 0.6, (0, 0, 0), conc, rot=(0, 90, 0), mside=conc)
    b.extrude([(x * 1.04, y * 1.0 + (0.002 if y > 0 else 0)) for x, y in prof][:6], 0.08, (-0.18, 0, 0), yellow,
              rot=(0, 90, 0))
    b.extrude([(x * 1.04, y * 1.0 + (0.002 if y > 0 else 0)) for x, y in prof][:6], 0.08, (0.18, 0, 0), yellow,
              rot=(0, 90, 0))
    for x in (-0.25, 0.0, 0.25):
        if x == 0.0:
            continue
        b.cyl(0.012, 0.004, (x, 0.121, 0), dark, seg=6)
    b.extrude([(x * 1.01, y) for x, y in [(-0.075, 0.0), (0.075, 0.0), (0.07, 0.03), (-0.07, 0.03)]], 0.598,
              (0, 0, 0), grime, rot=(0, 90, 0))
    b.build()


# ═══════════════════════════════════════════════════════════════════════════
#  SHRINE (月見神社)
# ═══════════════════════════════════════════════════════════════════════════
def build_torii():
    ver = mat("torii_vermilion", "#c0412b", 0.6)
    ver_d = mat("torii_vermilion_dirty", "#8a3225", 0.75)
    ver_f = mat("torii_vermilion_faded", "#b25a44", 0.75)
    black = mat("torii_black", "#1b1918", 0.6)
    plaque = mat("tex_shrine_plaque", "#ffffff", 0.6)
    # pillars with black 亀腹 bases: separate meshes so each gets its own collider
    for name, x in (("pillar_l", -1.8), ("pillar_r", 1.8)):
        p = MB(name)
        p.cyl(0.35, 0.1, (x, 0.05, 0), black, seg=12, r2=0.345, caps=(False, False))
        p.cyl(0.345, 0.14, (x, 0.17, 0), black, seg=12, r2=0.3, caps=(False, False))
        p.cyl(0.3, 0.1, (x, 0.29, 0), black, seg=12, r2=0.2, caps=(False, True))
        p.cyl(0.16, 0.8, (x, 0.74, 0), ver_d, seg=12, caps=(False, False))
        off = 3 if x > 0 else 0
        p.cyl(0.16, 2.72, (x, 2.5, 0), ver, seg=12, caps=(False, False),
              sidemat=lambda i, off=off: ver_f if (i + off) % 5 == 0 else ver)
        p.cyl(0.2, 0.12, (x, 3.92, 0), black, seg=12)
        p.build()

    def dy(x):
        return 0.16 * (abs(x) / 2.3) ** 2.4
    k = MB("kasagi")
    xs = [-2.3 + 4.6 * i / 16 for i in range(17)]
    k.loft([(x, 4.10 + dy(x), 0) for x in xs], [(-0.21, 0), (0.21, 0), (0.21, 0.12), (-0.21, 0.12)], ver,
           smooth=False)
    k.loft([(x, 4.22 + dy(x), 0) for x in xs], [(-0.25, 0), (0.25, 0), (0.25, 0.08), (0, 0.13), (-0.25, 0.08)],
           black, smooth=False)
    xs3 = [-2.12 + 4.24 * i / 12 for i in range(13)]
    k.loft([(x, 3.88 + dy(x) * 0.85, 0) for x in xs3], [(-0.17, 0), (0.17, 0), (0.17, 0.22), (-0.17, 0.22)], ver,
           smooth=False)
    k.build()
    n = MB("nuki")
    n.box((4.4, 0.18, 0.15), (0, 3.3, 0), ver)
    for sx in (-1, 1):
        n.box((0.06, 0.22, 0.17), (sx * 1.99, 3.3, 0), black)
    n.box((0.2, 0.52, 0.14), (0, 3.65, 0), ver)
    n.box((0.48, 0.68, 0.05), (0, 3.64, 0.095), black, rot=(8, 0, 0))
    n.build()
    tex_plane("plaque", 0.4, 0.6, (0, 3.64, 0.1245), plaque, rx=8)


def build_stone_lantern():
    rng = random.Random(5)
    st = mat("stone", "#8e8c84", 0.95)
    st_d = mat("stone_dark", "#6b6962", 0.95)
    st_l = mat("stone_light", "#a5a398", 0.95)
    moss = mat("moss", "#55693a", 1.0)
    moss_l = mat("moss_light", "#71813f", 1.0)
    inner = mat("stone_inner", "#2c2b29", 1.0)
    b = MB("lantern")
    b.box((0.6, 0.08, 0.6), (0, 0.04, 0), st_d, skip="ny")
    for cx, cz in ((-0.25, 0.25), (0.26, -0.24), (0.25, 0.25)):
        patch(b, (cx, 0.0815, cz), 0.045, moss, rng)
    b.cyl(0.29, 0.06, (0, 0.11, 0), st, seg=6, smooth=False, caps=(False, False))
    b.cyl(0.29, 0.08, (0, 0.18, 0), st, seg=6, r2=0.16, smooth=False, caps=(False, True),
          sidemat=lambda i: moss if i in (1, 3) else st)
    b.cyl(0.075, 0.73, (0, 0.585, 0), st, seg=8, caps=(False, False))
    b.cyl(0.088, 0.05, (0, 0.6, 0), st_l, seg=8)
    b.cyl(0.08, 0.06, (0, 0.98, 0), st, seg=6, r2=0.2, smooth=False, caps=(False, False))
    b.cyl(0.21, 0.06, (0, 1.04, 0), st_d, seg=6, smooth=False, caps=(True, False))
    b.cyl(0.21, 0.05, (0, 1.095, 0), st, seg=6, r2=0.185, smooth=False, sidemat=lambda i: moss_l if i == 4 else st)
    # 火袋: hollow fire box, open front and back
    R = 0.16
    for i in range(6):
        a = i * math.pi / 3
        b.box((0.035, 0.3, 0.035), (R * 0.95 * math.cos(a), 1.27, -R * 0.95 * math.sin(a)), st)
    b.cyl(0.15, 0.006, (0, 1.123, 0), inner, seg=6, smooth=False)
    ap = R * math.cos(math.pi / 6)
    for i in range(6):
        if i in (1, 4):
            continue
        an = (i + 0.5) * math.pi / 3
        nx, nz = math.cos(an), -math.sin(an)
        ry = math.degrees(math.atan2(nx, nz))
        b.box((R * 0.9, 0.26, 0.025), (nx * (ap - 0.012), 1.27, nz * (ap - 0.012)), st, rot=(0, ry, 0))
        disc(b, (nx * (ap + 0.001), 1.29, nz * (ap + 0.001)), (nx, 0, nz), 0.035, inner, seg=8)
    # 笠 with mossy faces and 蕨手 bumps
    b.cyl(0.3, 0.05, (0, 1.445, 0), st_d, seg=6, r2=0.295, smooth=False)
    b.cyl(0.295, 0.14, (0, 1.54, 0), st, seg=6, r2=0.06, smooth=False, caps=(False, True),
          sidemat=lambda i: moss_l if i == 4 else (moss if i in (1, 2) else st))
    for i in range(6):
        a = i * math.pi / 3
        b.sphere(0.028, (0.278 * math.cos(a), 1.49, -0.278 * math.sin(a)), st, seg=5, rings=3)
    # 宝珠
    b.cyl(0.06, 0.03, (0, 1.625, 0), st, seg=8)
    b.cyl(0.045, 0.035, (0, 1.6575, 0), st, seg=8, r2=0.07)
    b.sphere(0.06, (0, 1.725, 0), st_l, seg=8, rings=5)
    b.cyl(0.035, 0.03, (0, 1.785, 0), st_l, seg=8, r2=0.0)
    b.build()


def build_chozuya():
    rng = random.Random(9)
    wood = mat("chz_wood", "#6a4e38", 0.85)
    wood_d = mat("chz_wood_dark", "#3e2c20", 0.9)
    tile = mat("chz_tile", "#3d4044", 0.65)
    tile_d = mat("chz_tile_dark", "#23252a", 0.65)
    soffit = mat("chz_soffit", "#2a1f17", 0.9)
    st = mat("chz_stone", "#7f7d75", 0.95)
    st_d = mat("chz_stone_dark", "#5d5b55", 0.95)
    moss = mat("moss", "#55693a", 1.0)
    water = mat("water", "#2a3438", 0.08)
    stream = mat("chz_stream", "#b9d4dc", 0.1)
    bam = mat("bamboo", "#9c9a48", 0.55)
    bam_d = mat("bamboo_dark", "#6f6d33", 0.6)
    ladle = mat("ladle_wood", "#c9a874", 0.7)
    paper = mat("paper_white", "#ecebe2", 0.8)
    ink = mat("ink", "#1d1b19", 0.9)
    b = MB("chozuya")
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * 0.85, sz * 0.45
            b.box((0.22, 0.1, 0.22), (x, 0.05, z), st_d, skip="ny")
            b.box((0.12, 2.0, 0.12), (x, 1.1, z), wood, skip="ny")
    for sz in (-1, 1):
        b.box((2.0, 0.14, 0.1), (0, 2.03, sz * 0.45), wood_d)
    for sx in (-1, 1):
        b.box((0.1, 0.14, 1.04), (sx * 0.85, 2.03, 0), wood_d)
        b.box((0.08, 0.36, 0.08), (sx * 0.85, 2.28, 0), wood_d)
        b.poly([(sx * 0.85, 2.1, -0.45), (sx * 0.85, 2.1, 0.45), (sx * 0.85, 2.44, 0)][::sx], wood)
        b.poly([(sx * 0.85, 2.1, -0.45), (sx * 0.85, 2.1, 0.45), (sx * 0.85, 2.44, 0)][::-sx], wood)
    b.box((2.04, 0.08, 0.08), (0, 2.44, 0), wood_d)
    # tiled gable roof (照り, ends lifted)
    def yroof(t, x):
        return 2.52 - 0.40 * (1 - (1 - t) ** 1.4) + 0.05 * (abs(x) / 1.1) ** 2 * t
    xs = [-1.1, -0.55, 0.0, 0.55, 1.1]
    ts = [0.0, 0.5, 1.0]
    for sz in (1, -1):
        g = [[(x, yroof(t, x), sz * t * 0.7) for t in ts] for x in xs]
        sheet(b, g, 0.07, tile, soffit, tile_d)
        for k in range(11):
            x = -1.0 + k * 0.2
            path = [(x, yroof(t, x) + 0.012, sz * t * 0.7) for t in (0.02, 0.5, 0.98)]
            b.loft(path, [(-0.022, 0), (0.022, 0), (0.016, 0.03), (-0.016, 0.03)], tile_d, smooth=False)
        b.box((2.16, 0.06, 0.05), (0, yroof(1.0, 0) - 0.01, sz * 0.675), tile_d)
        for sx in (-1, 1):
            path = [(sx * 1.06, yroof(t, 1.1) - 0.05, sz * t * 0.68) for t in (0.0, 0.5, 1.0)]
            b.loft(path, [(-0.06, -0.02), (0.06, -0.02), (0.06, 0.02), (-0.06, 0.02)], wood_d, smooth=False,
                   up=(0, 1, 0))
    b.box((2.18, 0.1, 0.16), (0, 2.55, 0), tile_d)
    for sx in (-1, 1):
        b.box((0.08, 0.17, 0.24), (sx * 1.07, 2.535, 0), tile_d)
        b.poly([(sx * 1.13, 2.36, -0.06), (sx * 1.13, 2.36, 0.06), (sx * 1.13, 2.24, 0)][::sx], wood_d)
    # stone basin with water
    b.box((1.24, 0.18, 0.62), (0, 0.09, 0), st_d, skip="ny")
    b.box((1.1, 0.42, 0.5), (0, 0.39, 0), st, skip="ny py")
    b.box((1.1, 0.1, 0.07), (0, 0.65, 0.215), st)
    b.box((1.1, 0.1, 0.07), (0, 0.65, -0.215), st)
    b.box((0.07, 0.1, 0.36), (0.515, 0.65, 0), st)
    b.box((0.07, 0.1, 0.36), (-0.515, 0.65, 0), st)
    fquad(b, (0, 0.645, 0), 0.96, 0.36, water, "y")
    fquad(b, (0, 0.38, 0.2505), 0.6, 0.22, st_d, "z")
    fquad(b, (0, 0.38, -0.2505), 0.6, 0.22, st_d, "-z")
    for c in ((-0.45, 0.7005, 0.22), (0.3, 0.7005, -0.22), (0.5, 0.7005, 0.1), (-0.55, 0.1805, -0.28),
              (0.55, 0.1805, 0.27)):
        patch(b, c, 0.05, moss, rng)
    # bamboo spout and the trickle of water
    b.cyl(0.035, 1.05, (-0.66, 0.525, -0.12), bam, seg=6, caps=(False, True))
    for y in (0.35, 0.68, 0.98):
        b.cyl(0.039, 0.025, (-0.66, y, -0.12), bam_d, seg=6)
    seg_tube(b, (-0.66, 0.97, -0.12), (-0.37, 0.89, -0.05), 0.025, bam, sides=6)
    b.loft([(-0.36, 0.885, -0.05), (-0.345, 0.8, -0.048), (-0.335, 0.7, -0.046), (-0.33, 0.645, -0.045)],
           [(0.008 * math.cos(a), 0.008 * math.sin(a)) for a in (0, 2.1, 4.2)], stream, caps=False)
    # ladle rack and 柄杓
    for sz in (-1, 1):
        b.cyl(0.015, 1.02, (0.0, 0.715, sz * 0.07), bam, seg=6, axis="x")
    for i, x in enumerate((-0.3, -0.1, 0.1, 0.3)):
        d = 1 if i % 2 == 0 else -1
        b.cyl(0.042, 0.07, (x, 0.765, -d * 0.03), ladle, seg=8, smooth=False)
        b.box((0.018, 0.016, 0.36), (x, 0.745, d * 0.17), ladle, rot=(d * 4, 0, 0))
    # 手水の作法 board hanging from the back beam
    for sx in (-1, 1):
        b.box((0.01, 0.2, 0.01), (sx * 0.2, 1.86, -0.47), ink)
    b.box((0.52, 0.34, 0.02), (0, 1.62, -0.48), wood_d)
    fquad(b, (0, 1.62, -0.4905), 0.46, 0.28, paper, "-z")
    for k in range(6):
        fquad(b, (0.17 - k * 0.07, 1.6, -0.4915), 0.012, 0.2, ink, "-z")
    b.build()


def build_komainu():
    rng = random.Random(13)
    st = mat("kom_stone", "#8a887e", 0.95)
    st_d = mat("kom_stone_dark", "#66645d", 0.95)
    st_l = mat("kom_stone_light", "#a19f93", 0.95)
    st_g = mat("kom_stone_green", "#7a8068", 0.95)
    moss = mat("moss", "#4f6535", 1.0)
    mouth = mat("kom_mouth", "#1c1512", 1.0)
    p = MB("pedestal")
    p.box((0.6, 0.22, 0.88), (0, 0.11, 0), st_d, skip="ny")
    p.box((0.52, 0.3, 0.78), (0, 0.37, 0), st)
    fquad(p, (0, 0.37, 0.3905), 0.38, 0.18, st_d)
    fquad(p, (0, 0.37, -0.3905), 0.38, 0.18, st_d, "-z")
    p.box((0.56, 0.06, 0.84), (0, 0.55, 0), st_l)
    for c in ((-0.25, 0.2205, 0.4), (0.24, 0.2205, 0.4), (0.25, 0.2205, -0.2), (-0.22, 0.5805, 0.35)):
        patch(p, c, 0.04, moss, rng)
    p.build()
    f = MB("komainu")
    f.box((0.44, 0.06, 0.66), (0, 0.61, -0.02), st_d)
    for sx in (-1, 1):
        f.sphere(0.13, (sx * 0.12, 0.75, -0.13), st, seg=8, rings=6, scale=(0.95, 0.85, 1.25))
        f.sphere(0.05, (sx * 0.15, 0.665, 0.03), st, seg=6, rings=4, scale=(1.0, 0.55, 1.4))
    f.sphere(0.2, (0, 0.9, -0.03), st, seg=8, rings=6, scale=(0.78, 1.1, 0.85), rot=(15, 0, 0))
    f.sphere(0.13, (0, 0.93, 0.1), st_l, seg=8, rings=6, scale=(1.0, 1.15, 0.8))
    for sx in (-1, 1):
        f.cyl(0.05, 0.28, (sx * 0.085, 0.79, 0.15), st, seg=7, r2=0.045, rot=(-12, 0, 0))
        f.sphere(0.055, (sx * 0.085, 0.665, 0.2), st, seg=7, rings=4, scale=(1.0, 0.6, 1.3))
        for t in (-1, 0, 1):
            f.sphere(0.016, (sx * 0.085 + t * 0.03, 0.66, 0.265), st_l, seg=5, rings=3)
    hy, hz = 1.14, 0.13
    f.sphere(0.15, (0, hy, hz), st, seg=9, rings=7, scale=(1.0, 0.88, 0.95))
    mane = [(-0.15, 1.15, 0.05), (0.15, 1.15, 0.05), (-0.12, 1.24, 0.03), (0.12, 1.24, 0.03), (0, 1.265, 0.0),
            (-0.15, 1.05, 0.06), (0.15, 1.05, 0.06), (-0.09, 1.0, 0.0), (0.09, 1.0, 0.0), (0, 1.16, -0.07),
            (-0.08, 1.22, -0.05), (0.08, 1.22, -0.05), (0, 1.05, -0.07), (-0.13, 0.95, -0.02), (0.13, 0.95, -0.02)]
    for (x, y, z) in mane:
        f.sphere(0.065, (x, y, z), st_g if rng.random() < 0.4 else st, seg=6, rings=4, jit=0.15, rng=rng)
    for sx in (-1, 1):
        f.sphere(0.045, (sx * 0.14, 1.215, 0.12), st_d, seg=6, rings=4, scale=(0.7, 0.5, 1.2), rot=(0, 0, sx * 30))
    f.box((0.24, 0.04, 0.05), (0, 1.19, 0.245), st_l, rot=(-10, 0, 0))
    for sx in (-1, 1):
        f.sphere(0.032, (sx * 0.062, 1.155, 0.25), st_l, seg=6, rings=4)
        f.sphere(0.013, (sx * 0.062, 1.155, 0.278), mouth, seg=5, rings=3)
    f.sphere(0.04, (0, 1.12, 0.3), st_d, seg=6, rings=4, scale=(1.1, 0.7, 0.6))
    f.box((0.17, 0.05, 0.09), (0, 1.09, 0.26), st)
    f.box((0.14, 0.06, 0.07), (0, 1.045, 0.255), mouth)
    f.box((0.15, 0.03, 0.09), (0, 1.0, 0.245), st, rot=(14, 0, 0))
    for sx in (-1, 1):
        f.cyl(0.012, 0.035, (sx * 0.05, 1.052, 0.29), st_l, seg=4, r2=0.0, rot=(180, 0, 0))
        f.cyl(0.01, 0.03, (sx * 0.045, 1.02, 0.285), st_l, seg=4, r2=0.0)
    f.sphere(0.09, (0, 0.86, -0.3), st, seg=7, rings=5, scale=(0.9, 1.5, 0.6), rot=(-20, 0, 0))
    f.sphere(0.07, (0, 1.03, -0.34), st_g, seg=6, rings=4, jit=0.15, rng=rng, scale=(1.0, 1.2, 0.8))
    f.sphere(0.05, (0.05, 1.13, -0.33), st, seg=6, rings=4, jit=0.15, rng=rng)
    f.sphere(0.05, (-0.05, 1.13, -0.33), st, seg=6, rings=4, jit=0.15, rng=rng)
    for c, r in (((0.02, 1.27, 0.12), 0.05), ((-0.03, 1.02, -0.18), 0.05)):
        patch(f, c, r, moss, rng, n=6)
    f.build()


def build_haiden():
    rng = random.Random(17)
    wood = mat("hd_wood", "#5a4331", 0.85)
    wood_d = mat("hd_wood_dark", "#33251b", 0.9)
    wood_g = mat("hd_wood_gray", "#76695a", 0.9)
    wood_w = mat("hd_wood_worn", "#8a7a66", 0.9)
    black = mat("hd_black", "#151312", 0.7)
    roof = mat("hd_roof_patina", "#4c7a6c", 0.7, 0.2)
    roof_d = mat("hd_roof_patina_dark", "#3d6559", 0.7, 0.2)
    roof_e = mat("hd_roof_edge", "#2e3f39", 0.7, 0.3)
    soffit = mat("hd_soffit", "#23190f", 0.95)
    stone = mat("hd_stone", "#7b7970", 0.95)
    paper = mat("hd_paper", "#bdb194", 0.9)
    void = mat("hd_void", "#0b0907", 1.0)
    gold = mat("hd_gold", "#c9a443", 0.35, 0.8)
    white = mat("hd_white", "#efeee6", 0.85)
    straw = mat("hd_straw", "#c8b06a", 0.9)
    straw_d = mat("hd_straw_dark", "#9c8548", 0.9)
    red = mat("hd_rope_red", "#b0242a", 0.7)
    b = MB("haiden")
    FX, FZ0, FZ1, FY = 3.5, -2.9, 2.0, 0.8
    # raised floor, posts, dark crawl space
    b.box2((-FX, FY - 0.1, FZ0), (FX, FY, FZ1), wood_g, fm={"ny": soffit})
    b.box2((-FX, FY - 0.2, FZ1 - 0.08), (FX, FY - 0.1, FZ1), wood_d, skip="py")
    b.box2((-3.3, 0.0, -2.7), (3.3, FY - 0.1, 1.7), void, skip="ny py")
    for x, z in ((-3.4, 1.9), (-1.7, 1.9), (0.0, 1.9), (1.7, 1.9), (3.4, 1.9), (-3.4, -0.45), (3.4, -0.45),
                 (-3.4, -2.8), (0.0, -2.8), (3.4, -2.8)):
        b.box((0.3, 0.08, 0.3), (x, 0.04, z), stone, skip="ny")
        b.box((0.14, FY - 0.18, 0.14), (x, (FY - 0.1 + 0.08) / 2, z), wood_d,
              skip="ny py" + (" nz" if z > 1 else (" pz" if z < -2 else "")))
    # hall walls
    WX, WZ0, WZ1 = 3.0, -2.5, 1.5
    b.box2((-WX, FY, WZ0 - 0.06), (WX, 3.85, WZ0 + 0.06), wood)
    for sx in (-1, 1):
        b.box2((sx * WX - 0.06, FY, WZ0), (sx * WX + 0.06, 4.05, WZ1), wood)
    b.box2((-WX, 3.5, WZ1 - 0.06), (WX, 4.3, WZ1 + 0.03), wood)
    b.box2((-WX, 2.95, WZ1 - 0.04), (WX, 3.5, WZ1 + 0.02), wood_d)
    for k in range(10):
        x = -2.7 + k * 0.6
        fquad(b, (x, 3.22, WZ1 + 0.021), 0.035, 0.4, wood)
    for x in (-3.0, -1.0, 1.0, 3.0):
        b.cyl(0.12, 3.1, (x, FY + 1.55, WZ1), wood_d, seg=8, caps=(False, False))
        b.cyl(0.12, 3.05, (x, FY + 1.525, WZ0), wood_d, seg=8, caps=(False, False))
    for sx in (-1, 1):
        b.cyl(0.12, 3.1, (sx * WX, FY + 1.55, -0.5), wood_d, seg=8, caps=(False, False))
    # nageshi bands on the sides and back
    b.box2((-WX - 0.08, 2.9, WZ0 - 0.1), (WX + 0.08, 3.02, WZ0 - 0.06), wood_d, skip="py")
    for sx in (-1, 1):
        b.box2((sx * WX - 0.09, 2.9, WZ0), (sx * WX + 0.09, 3.02, WZ1), wood_d)
    b.box2((-WX, 2.95, WZ1), (WX, 3.07, WZ1 + 0.1), wood_d)
    b.box2((-WX, FY, WZ1), (WX, FY + 0.1, WZ1 + 0.08), wood_d)
    # front bays: lattice doors (paper behind the centre bay, darkness behind the sides)
    for bx in (-2.0, 0.0, 2.0):
        x0, x1, y0, y1 = bx - 0.88, bx + 0.88, FY + 0.1, 2.95
        fquad(b, (bx, (y0 + y1) / 2, WZ1 - 0.02), x1 - x0, y1 - y0, paper if bx == 0 else void)
        b.box2((x0, y0, WZ1 - 0.02), (x0 + 0.06, y1, WZ1 + 0.05), wood_d, skip="nz")
        b.box2((x1 - 0.06, y0, WZ1 - 0.02), (x1, y1, WZ1 + 0.05), wood_d, skip="nz")
        b.box2((bx - 0.03, y0, WZ1 - 0.02), (bx + 0.03, y1, WZ1 + 0.05), wood_d, skip="nz")
        b.box2((x0, y0, WZ1 - 0.02), (x1, y0 + 0.28, WZ1 + 0.04), wood_d, skip="nz")
        for kk in range(1, 10):
            x = x0 + kk * (x1 - x0) / 10
            if abs(x - bx) < 0.05:
                continue
            b.box((0.024, y1 - y0 - 0.28, 0.035), (x, (y0 + 0.28 + y1) / 2, WZ1 + 0.012), wood_d,
                  skip="nz py ny")
        for kk in range(1, 6):
            y = y0 + 0.28 + kk * (y1 - y0 - 0.28) / 6
            b.box((x1 - x0, 0.024, 0.035), (bx, y, WZ1 + 0.012), wood_d, skip="nz px nx")
        if bx == 0:
            for sx in (-1, 1):
                b.box((0.05, 0.14, 0.012), (sx * 0.07, 1.75, WZ1 + 0.055), gold, skip="nz")
    # 斗栱 brackets on the front columns
    for x in (-3.0, -1.0, 1.0, 3.0):
        b.box((0.24, 0.12, 0.24), (x, 3.96, WZ1), wood_d)
        b.box((0.7, 0.1, 0.14), (x, 4.07, WZ1 + 0.05), wood_d, skip="nz")
        b.box((0.12, 0.1, 0.5), (x, 4.17, WZ1 + 0.25), wood_d, skip="nz")
    # 奉納 donor boards on the side walls
    for sx in (-1, 1):
        b.box((0.03, 0.5, 1.3), (sx * (WX + 0.075), 2.25, -0.6), wood_d)
        fquad(b, (sx * (WX + 0.091), 2.25, -0.6), 1.2, 0.42, white, "x" if sx > 0 else "-x")
        for k in range(7):
            fquad(b, (sx * (WX + 0.092), 2.25, -1.05 + k * 0.15), 0.016, 0.34, black, "x" if sx > 0 else "-x")
    # veranda railing (高欄)
    for sx in (-1, 1):
        for x in (0.95, 1.75, 2.6, 3.45):
            b.box((0.07, 0.6, 0.07), (sx * x, FY + 0.3, FZ1 - 0.04), wood_d, skip="ny nz")
        b.box2((sx * 0.95, 1.3, FZ1 - 0.07), (sx * 3.48, 1.36, FZ1 - 0.01), black)
        b.box2((sx * 0.95, 1.02, FZ1 - 0.06), (sx * 3.48, 1.06, FZ1 - 0.02), wood_d)
        for z in (0.9, -0.3, -1.5, -2.85):
            b.box((0.07, 0.6, 0.07), (sx * (FX - 0.04), FY + 0.3, z), wood_d, skip="ny " + ("nx" if sx > 0 else "px"))
        b.box2((sx * (FX - 0.07), 1.3, -2.88), (sx * (FX - 0.01), 1.36, FZ1 - 0.01), black)
        b.box2((sx * (FX - 0.06), 1.02, -2.88), (sx * (FX - 0.02), 1.06, FZ1 - 0.01), wood_d)
    # five wooden steps, stringers, handrails with 擬宝珠
    SX = 0.85
    rise = FY / 6
    for k in range(1, 6):
        yt = FY - k * rise
        z0 = FZ1 + (k - 1) * 0.24
        b.box2((-SX, yt - 0.04, z0), (SX, yt, z0 + 0.27), wood_g, fm={"py": wood_w})
        b.box2((-SX + 0.02, yt - rise, z0 + 0.02), (SX - 0.02, yt - 0.04, z0 + 0.05), wood_d, skip="ny")
    prof = [(FZ1 + 1.26, 0.0), (FZ1 + 1.26, 0.16), (FZ1, FY + 0.06), (FZ1, FY - 0.18)]
    for sx in (-1, 1):
        b.extrude(prof, 0.06, (sx * (SX + 0.03), 0, 0), wood_d, rot=(0, -90, 0))
        b.box((0.09, 0.78, 0.09), (sx * 0.95, 0.39, FZ1 + 1.2), wood_d, skip="ny")
        b.sphere(0.06, (sx * 0.95, 0.83, FZ1 + 1.2), gold, seg=6, rings=4, scale=(1, 1.3, 1))
        b.cyl(0.012, 0.06, (sx * 0.95, 0.92, FZ1 + 1.2), gold, seg=6, r2=0.0)
        seg_tube(b, (sx * 0.95, 0.74, FZ1 + 1.2), (sx * 0.95, 1.33, FZ1 - 0.04), 0.03, black, sides=5)
    # 向拝 columns, beams
    KZ = 3.2
    for sx in (-1, 1):
        x = sx * 1.0
        b.box((0.32, 0.18, 0.32), (x, 0.09, KZ), stone, skip="ny")
        b.cyl(0.1, 2.82, (x, 1.59, KZ), wood, seg=8, caps=(False, False))
        b.box((0.24, 0.12, 0.24), (x, 3.06, KZ), wood_d)
        b.box2((x - 0.08, 3.0, WZ1 + 0.05), (x + 0.08, 3.14, KZ + 0.1), wood_d)
    b.box((2.5, 0.18, 0.18), (0, 3.21, KZ), wood_d)
    # 注連縄 + 紙垂 + 房 across the hall front
    rz = WZ1 + 0.13
    path = catenary((-2.9, 3.03, rz), (2.9, 3.03, rz), 0.14, 11)
    sc = [0.045 + 0.035 * math.sin(math.pi * i / 11) for i in range(12)]
    b.loft(path, [(math.cos(2 * math.pi * i / 5), math.sin(2 * math.pi * i / 5)) for i in range(5)], straw,
           scales=sc, segmat=lambda i: straw if i % 2 == 0 else straw_d)
    for x in (-2.0, -0.7, 0.7, 2.0):
        yy = 3.03 - 0.14 * 4 * ((x + 2.9) / 5.8) * (1 - (x + 2.9) / 5.8)
        shide(b, (x, yy - 0.06, rz + 0.07), white, length=0.42, width=0.07, steps=4)
    for x in (-1.35, 0.0, 1.35):
        yy = 3.03 - 0.14 * 4 * ((x + 2.9) / 5.8) * (1 - (x + 2.9) / 5.8)
        b.cyl(0.035, 0.22, (x, yy - 0.17, rz), straw, seg=6, r2=0.012)
    # lower hip roof of the 入母屋 (a ring with lifted corners)
    OUT = [(4.0, 3.5), (4.0, -3.5), (-4.0, -3.5), (-4.0, 3.5)]
    INN = [(2.5, 1.0), (2.5, -1.6), (-2.5, -1.6), (-2.5, 1.0)]
    NSEG = [6, 8, 6, 8]
    ring = []
    corners = []
    for sd in range(4):
        a, c2 = OUT[sd], OUT[(sd + 1) % 4]
        ia, ib = INN[sd], INN[(sd + 1) % 4]
        for kk in range(NSEG[sd]):
            u = kk / NSEG[sd]
            if kk == 0:
                corners.append(len(ring))
            w = abs(2 * u - 1) ** 2
            ring.append(((a[0] + (c2[0] - a[0]) * u, a[1] + (c2[1] - a[1]) * u),
                         (ia[0] + (ib[0] - ia[0]) * u, ia[1] + (ib[1] - ia[1]) * u), w))
    TS = [0.0, 0.3, 1.0]
    grid = []
    for (o, i_, w) in ring:
        ye = 3.55 + 0.35 * w ** 1.5
        grid.append([(o[0] + (i_[0] - o[0]) * t, ye + (5.0 - ye) * t ** 1.25, o[1] + (i_[1] - o[1]) * t)
                     for t in TS])
    sheet(b, grid, 0.28, roof, soffit, roof_e, closed=True, edges=(False, False, True, False),
          topmat=lambda i, j: roof_d if i % 5 == 2 else roof)
    for ci in corners:
        path = [(p[0], p[1] + 0.07, p[2]) for p in grid[ci]]
        b.loft(path, [(-0.08, -0.04), (0.08, -0.04), (0.08, 0.05), (-0.08, 0.05)], roof_d, smooth=False)
    # upper gable roof, gable walls, 破風, 懸魚, ridge
    def gslope(z_e, z_r):
        g = []
        for x in (-2.78, -1.4, 0.0, 1.4, 2.78):
            lift = 0.08 * (abs(x) / 2.78) ** 2
            g.append([(x, 4.92 + 1.38 * t ** 1.25 + lift * (1 - t), z_e + (z_r - z_e) * t) for t in (0.0, 0.5, 1.0)])
        sheet(b, g, 0.22, roof, soffit, roof_e, topmat=lambda i, j: roof_d if i == 1 else roof)
        return g
    gf = gslope(1.15, -0.3)
    gb = gslope(-1.75, -0.3)
    for sx in (-1, 1):
        tri = [(sx * 2.5, 4.95, 1.0), (sx * 2.5, 4.95, -1.6), (sx * 2.5, 6.12, -0.3)]
        b.poly(tri if sx > 0 else tri[::-1], wood_d)
        b.poly([(sx * 2.51, 5.15, 0.55), (sx * 2.51, 5.15, -1.15), (sx * 2.51, 5.85, -0.3)][::sx], wood)
        for g in (gf, gb):
            col = g[-1] if sx > 0 else g[0]
            path = [(sx * 2.81, p[1] - 0.07, p[2]) for p in col]
            b.loft(path, [(-0.03, -0.11), (0.03, -0.11), (0.03, 0.06), (-0.03, 0.06)], black, smooth=False)
        b.poly([(sx * 2.85, 6.1, -0.42), (sx * 2.85, 6.1, -0.18), (sx * 2.85, 5.85, -0.24), (sx * 2.85, 5.75, -0.3),
                (sx * 2.85, 5.85, -0.36)][::sx], gold)
        b.poly([(sx * 2.85, 6.1, -0.42), (sx * 2.85, 6.1, -0.18), (sx * 2.85, 5.85, -0.24), (sx * 2.85, 5.75, -0.3),
                (sx * 2.85, 5.85, -0.36)][::-sx], gold)
    b.box2((-2.95, 6.22, -0.48), (2.95, 6.44, -0.12), roof_d)
    b.box2((-2.95, 6.44, -0.4), (2.95, 6.5, -0.2), roof_e)
    for sx in (-1, 1):
        b.box((0.16, 0.34, 0.48), (sx * 2.88, 6.43, -0.3), roof_e)
    b.build()
    # 本坪鈴 (bell node, origin at its top) with the red/white 鈴緒 as a child
    bl = MB("bell")
    bl.cyl(0.028, 0.03, (0, 3.105, KZ), gold, seg=6)
    bl.sphere(0.13, (0, 2.97, KZ), gold, seg=10, rings=6, scale=(1.0, 0.92, 1.0), smooth=True)
    bl.cyl(0.131, 0.02, (0, 2.94, KZ), black, seg=10, caps=(False, False))
    bo = bl.build()
    set_origin(bo, (0, 3.12, KZ))
    rp = MB("suzu_o")
    pth = [(0.012 * math.sin(i * 0.9), 2.86 - i * (1.8 / 9), KZ + 0.012 * i) for i in range(10)]
    rope(rp, pth, 0.04, red, white, sides=6, twist=1)
    end = pth[-1]
    rp.sphere(0.055, (end[0], end[1] - 0.02, end[2]), red, seg=8, rings=5)
    rp.cyl(0.06, 0.2, (end[0], end[1] - 0.16, end[2]), red, seg=8, r2=0.03, smooth=False)
    ro = rp.build()
    set_parent(ro, bo)


def build_saisen_box():
    wood = mat("ss_wood", "#5b3b25", 0.75)
    wood_d = mat("ss_wood_dark", "#38231a", 0.8)
    worn = mat("ss_wood_worn", "#7c5739", 0.75)
    brass = mat("ss_brass", "#b08a3a", 0.4, 0.7)
    dark = mat("ss_dark", "#0e0a07", 1.0)
    b = MB("saisen")
    for sx in (-1, 1):
        b.box((0.09, 0.06, 0.6), (sx * 0.5, 0.03, 0), wood_d)
    b.box((1.14, 0.5, 0.54), (0, 0.31, 0), wood, fm={"py": dark})
    for sx in (-1, 1):
        b.box((0.08, 0.5, 0.02), (sx * 0.53, 0.31, 0.275), wood_d, skip="nz")
        b.box((0.08, 0.5, 0.02), (sx * 0.53, 0.31, -0.275), wood_d, skip="pz")
    for zz in (0.275, -0.275):
        b.box((1.14, 0.07, 0.02), (0, 0.095, zz), wood_d)
        b.box((1.14, 0.05, 0.02), (0, 0.535, zz), wood_d)
    b.box((1.2, 0.16, 0.07), (0, 0.64, 0.265), worn)
    b.box((1.2, 0.16, 0.07), (0, 0.64, -0.265), worn)
    b.box((0.07, 0.16, 0.46), (0.565, 0.64, 0), worn)
    b.box((0.07, 0.16, 0.46), (-0.565, 0.64, 0), worn)
    for k in range(4):
        z = 0.19 - k * 0.05
        y = 0.695 - k * 0.03
        for sz in (-1, 1):
            b.box((1.06, 0.02, 0.036), (0, y, sz * z), wood, rot=(-sz * 32, 0, 0), skip="ny")
    # brass crest and corner fittings
    b.cyl(0.11, 0.012, (0, 0.32, 0.291), brass, seg=14, axis="z", smooth=False)
    b.cyl(0.085, 0.014, (0, 0.32, 0.292), wood_d, seg=14, axis="z", smooth=False)
    for a in range(3):
        an = a * 2 * math.pi / 3
        b.sphere(0.022, (0.04 * math.cos(an), 0.32 + 0.04 * math.sin(an), 0.3), brass, seg=6, rings=4,
                 scale=(1, 1, 0.4))
    for sx in (-1, 1):
        for y in (0.13, 0.5):
            b.box((0.1, 0.1, 0.008), (sx * 0.525, y, 0.289), brass, skip="nz")
        for zz in (-1, 1):
            b.box((0.075, 0.165, 0.075), (sx * 0.5625, 0.6425, zz * 0.2625), brass)
    b.build()


def build_shrine_office():
    rng = random.Random(23)
    wall = mat("so_wall", "#5d4433", 0.85)
    wall_d = mat("so_batten", "#3b2a1e", 0.9)
    conc = mat("so_concrete", "#8d8b84", 0.95)
    tile = mat("so_tile", "#3a3d42", 0.65)
    tile_d = mat("so_tile_dark", "#24262a", 0.65)
    soffit = mat("so_soffit", "#2a2018", 0.95)
    inner = mat("so_inner_wall", "#d6ccb4", 0.9)
    ceil = mat("so_ceiling", "#c9c2ae", 0.9)
    floor_ = mat("so_floor", "#6a5642", 0.8)
    counter = mat("so_counter", "#7a5a3c", 0.6)
    shelf = mat("so_shelf", "#8a6a48", 0.7)
    white = mat("so_white", "#f0eee6", 0.8)
    red = mat("so_red", "#b3262a", 0.6)
    felt = mat("so_felt", "#7d1a1e", 0.95)
    gold = mat("so_gold", "#c9a443", 0.4, 0.6)
    alu = mat("so_alu", "#a9adb1", 0.35, 0.6)
    black = mat("so_black", "#151515", 0.6)
    card = mat("so_cardboard", "#b48a58", 0.9)
    ema = mat("ema_wood", "#d9b77c", 0.8)
    em = mat("emit_office_light", "#f4fbff", 0.4, emit="#eaf6ff")
    frosted = glass_mat("glass_frosted", "#d9e0e2", 0.7)
    sign = mat("tex_juyosho", "#ffffff", 0.7)
    om = [mat("om_red", "#c42a2e", 0.6), mat("om_blue", "#2c4f9e", 0.6), mat("om_white", "#efefe8", 0.6),
          mat("om_pink", "#e48aa8", 0.6), mat("om_purple", "#6d3d8f", 0.6), mat("om_green", "#3b7d4a", 0.6),
          mat("om_gold", "#c9a443", 0.4, 0.5)]
    b = MB("shrine_office")
    X, Z0, Z1, T_ = 2.3, -1.6, 1.6, 0.1
    WY0, WY1 = 0.25, 2.55
    WX0, WX1, WWY0, WWY1 = -1.5, 1.5, 0.9, 1.95
    # foundation
    b.box2((-X - 0.02, 0, Z0 - 0.02), (X + 0.02, WY0, Z0 + 0.12), conc, skip="ny")
    b.box2((-X - 0.02, 0, Z0), (-X + 0.1, WY0, Z1 + 0.02), conc, skip="ny")
    b.box2((X - 0.1, 0, Z0), (X + 0.02, WY0, Z1 + 0.02), conc, skip="ny")
    b.box2((-X, 0, Z1 - 0.1), (X, WY0, Z1 + 0.02), conc, skip="ny")
    # walls (room-side faces cream)
    b.box2((-X, WY0, Z0), (X, WY1, Z0 + T_), wall)
    b.box2((-X, WY0, Z0), (-X + T_, WY1, Z1), wall, fm={"px": inner})
    b.box2((X - T_, WY0, Z0), (X, WY1, Z1), wall, fm={"nx": inner})
    b.box2((-X, WY0, Z1 - T_), (WX0, WY1, Z1), wall, fm={"nz": inner})
    b.box2((WX1, WY0, Z1 - T_), (X, WY1, Z1), wall, fm={"nz": inner})
    b.box2((WX0, WY0, Z1 - T_), (WX1, WWY0, Z1), wall, fm={"nz": inner})
    b.box2((WX0, WWY1, Z1 - T_), (WX1, WY1, Z1), wall, fm={"nz": inner})
    # battens + corner posts
    for k in range(11):
        x = -2.05 + k * 0.41
        b.box((0.035, WY1 - WY0, 0.025), (x, (WY0 + WY1) / 2, Z0 - 0.012), wall_d, skip="pz py ny")
    for sx in (-1, 1):
        for k in range(7):
            z = -1.35 + k * 0.45
            b.box((0.025, WY1 - WY0, 0.035), (sx * (X + 0.012), (WY0 + WY1) / 2, z), wall_d,
                  skip=("nx" if sx > 0 else "px") + " py ny")
        for sz in (-1, 1):
            b.box((0.12, WY1 - WY0 + 0.05, 0.12), (sx * (X - 0.03), (WY0 + WY1) / 2, sz * (Z1 - 0.03)), wall_d)
    for x in (-2.0, -1.75, 1.75, 2.0):
        b.box((0.035, WY1 - WY0, 0.025), (x, (WY0 + WY1) / 2, Z1 + 0.012), wall_d, skip="nz py ny")
    # room behind the window (floor y=0, depth 1.4)
    RZ0 = 0.2
    fquad(b, (0, 0.004, (RZ0 + Z1 - T_) / 2), 2 * (X - T_), Z1 - T_ - RZ0, floor_, "y")
    fquad(b, (0, 1.2, RZ0), 2 * (X - T_), 2.4, inner, "z")
    fquad(b, (0, 2.4, (RZ0 + Z1 - T_) / 2), 2 * (X - T_), Z1 - T_ - RZ0, ceil, "-y")
    fquad(b, (0, 0.125, Z1 - T_ - 0.001), 2 * (X - T_), 0.25, wall_d, "-z")
    # window frame, rails, counter
    b.box2((WX0 - 0.07, WWY0, Z1 - 0.12), (WX0, WWY1 + 0.07, Z1 + 0.03), wall_d)
    b.box2((WX1, WWY0, Z1 - 0.12), (WX1 + 0.07, WWY1 + 0.07, Z1 + 0.03), wall_d)
    b.box2((WX0 - 0.07, WWY1, Z1 - 0.12), (WX1 + 0.07, WWY1 + 0.07, Z1 + 0.03), wall_d)
    b.box2((WX0, WWY1 - 0.025, Z1 - 0.08), (WX1, WWY1, Z1 - 0.02), alu)
    b.box2((WX0 - 0.06, 0.875, Z1 - 0.2), (WX1 + 0.06, 0.925, Z1 + 0.27), counter)
    for x in (-1.2, 1.2):
        b.box((0.05, 0.2, 0.2), (x, 0.77, Z1 + 0.11), wall_d)
    # wares on the counter: omamori trays, ema, ofuda, price board, call bell
    TOP = 0.925
    for tx in (-1.0, 0.95):
        b.box((0.66, 0.02, 0.2), (tx, TOP + 0.01, Z1 + 0.15), felt)
        for k in range(14):
            r_, c_ = k // 7, k % 7
            col = om[(k * 3 + (2 if tx > 0 else 0)) % len(om)]
            tbox(b, (tx - 0.27 + c_ * 0.09, TOP + 0.02 + 0.035, Z1 + 0.09 + r_ * 0.1), (0.045, 0.07, 0.012), col,
                 om[6], 0.22, sides=(False, False), rot=(-12, 0, 0))
    pent = [(-0.05, 0.0), (0.05, 0.0), (0.05, 0.05), (0.0, 0.07), (-0.05, 0.05)]
    for k in range(3):
        b.extrude(pent, 0.008, (0.25 + k * 0.12, TOP, Z1 + 0.12 + k * 0.02), ema, rot=(-15, 0, 0))
    for k in range(3):
        tbox(b, (-0.35 + k * 0.07, TOP + 0.085, Z1 + 0.12), (0.055, 0.17, 0.012), white, gold, 0.12,
             sides=(True, True), rot=(-8, 0, 0))
    b.box((0.26, 0.2, 0.012), (-0.02, TOP + 0.1, Z1 + 0.2), white, rot=(-18, 0, 0))
    for k in range(4):
        b.box((0.004, 0.14, 0.004), (0.07 - k * 0.055, TOP + 0.1, Z1 + 0.208), black, rot=(-18, 0, 0))
    b.sphere(0.03, (0.62, TOP + 0.012, Z1 + 0.2), gold, seg=8, rings=4, cut=0.5)
    # interior: back shelves, desk, phone, clock, calendar, fluorescent light
    for y in (0.85, 1.25, 1.65):
        b.box2((-1.8, y - 0.025, RZ0), (1.8, y, RZ0 + 0.3), shelf)
        x = -1.74
        while x < 1.6:
            kind = rng.random()
            if kind < 0.35:
                w = rng.uniform(0.18, 0.3)
                tbox(b, (x + w / 2, y + 0.07, RZ0 + 0.15), (w, 0.14, 0.22), white, red, 0.25)
            elif kind < 0.6:
                w = rng.uniform(0.2, 0.32)
                tbox(b, (x + w / 2, y + 0.09, RZ0 + 0.15), (w, 0.18, 0.24), card, None, 0)
            elif kind < 0.85:
                w = 0.16
                for s2 in range(3):
                    b.box((w, 0.03, 0.22), (x + w / 2, y + 0.015 + s2 * 0.03, RZ0 + 0.15), white if s2 % 2 else gold,
                          skip="ny nz")
            else:
                w = 0.06
                tbox(b, (x + w / 2, y + 0.12, RZ0 + 0.2), (0.05, 0.24, 0.05), om[0], gold, 0.15)
            x += w + 0.03
    for x in (-1.8, 0.0, 1.8):
        b.box2((x - 0.015, 0.0, RZ0), (x + 0.015, 1.72, RZ0 + 0.3), shelf)
    b.box2((0.9, 0.0, 0.62), (1.9, 0.72, 1.12), counter, skip="ny")
    b.box((0.2, 0.08, 0.16), (1.6, 0.76, 0.85), black)
    b.box((0.18, 0.03, 0.05), (1.6, 0.815, 0.85), black)
    b.box((0.3, 0.004, 0.22), (1.2, 0.722, 0.9), white, rot=(0, 12, 0))
    b.box((0.26, 0.09, 0.2), (1.25, 0.765, 0.7), gold)
    b.cyl(0.15, 0.03, (1.3, 2.02, RZ0 + 0.02), black, seg=12, axis="z", smooth=False)
    b.cyl(0.13, 0.032, (1.3, 2.02, RZ0 + 0.022), white, seg=12, axis="z", smooth=False)
    b.box((0.008, 0.09, 0.006), (1.3, 2.05, RZ0 + 0.04), black)
    b.box((0.07, 0.008, 0.006), (1.33, 2.02, RZ0 + 0.04), black)
    fquad(b, (-X + T_ + 0.002, 1.5, 0.95), 0.32, 0.46, white, "x")
    fquad(b, (-X + T_ + 0.003, 1.68, 0.95), 0.32, 0.1, red, "x")
    b.box((1.3, 0.05, 0.14), (0, 2.375, 0.95), white, skip="py")
    b.cyl(0.018, 1.2, (-0.0, 2.33, 0.92), em, seg=6, axis="x")
    b.cyl(0.018, 1.2, (-0.0, 2.33, 0.98), em, seg=6, axis="x")
    # sign above the window
    b.box2((-0.57, 2.03, Z1), (0.57, 2.39, Z1 + 0.04), wall_d)
    # back door and side window (frosted)
    b.box2((-1.0, WY0, Z0 - 0.05), (-0.1, 2.15, Z0), wall_d, skip="pz")
    for k in range(2):
        fquad(b, (-0.78 + k * 0.45, 1.25, Z0 - 0.051), 0.38, 1.6, frosted, "-z")
    b.box((1.2, 0.12, 0.34), (-0.55, 0.06, Z0 - 0.19), conc, skip="ny")
    b.box2((X, 1.15, -0.9), (X + 0.05, 1.85, -0.1), wall_d, skip="nx")
    fquad(b, (X + 0.051, 1.5, -0.5), 0.66, 0.56, frosted, "x")
    for k in range(3):
        b.box((0.02, 0.56, 0.02), (X + 0.06, 1.5, -0.7 + k * 0.2), wall_d)
    b.box((0.08, 0.3, 0.2), (-X - 0.04, 1.6, -0.8), alu)
    b.cyl(0.03, 2.3, (X + 0.08, 1.4, Z1 + 0.12), alu, seg=6)
    # tiled gable roof
    def yroof(t):
        return 3.18 - 0.6 * t
    for sz in (1, -1):
        g = [[(x, yroof(t), sz * t * 2.0) for t in (0.0, 1.0)] for x in (-2.5, 2.5)]
        sheet(b, g, 0.12, tile, soffit, tile_d)
        for k in range(15):
            x = -2.38 + k * 0.34
            L = math.hypot(2.0, 0.6)
            ang = math.degrees(math.atan2(0.6, 2.0))
            b.box((0.05, 0.035, L - 0.05), (x, yroof(0.5) + 0.018, sz * 1.0), tile_d, rot=(sz * ang, 0, 0),
                  skip="ny pz nz")
        b.box2((-2.5, yroof(1.0) - 0.06, sz * 1.97 - 0.03), (2.5, yroof(1.0) + 0.02, sz * 1.97 + 0.03), tile_d)
        for sx in (-1, 1):
            L = math.hypot(2.0, 0.6)
            ang = math.degrees(math.atan2(0.6, 2.0))
            b.box((0.05, 0.18, L), (sx * 2.5, yroof(0.5) - 0.08, sz * 1.0), wall_d, rot=(sz * ang, 0, 0))
    b.box2((-2.52, 3.16, -0.13), (2.52, 3.3, 0.13), tile_d)
    for sx in (-1, 1):
        tri = [(sx * X, WY1, -1.6), (sx * X, WY1, 1.6), (sx * X, 3.05, 0.0)]
        b.poly(tri if sx > 0 else tri[::-1], wall)
    b.build()
    tex_plane("juyosho_sign", 1.0, 0.3, (0, 2.21, Z1 + 0.042), sign)


def ema_board(mb, apex, w, hr, ht, m, rz=0.0, ry=0.0, deco=None, rng=None):
    """Pentagonal 絵馬 hanging from `apex` (top point), both faces; returns nothing."""
    out = [(-w / 2, -(ht + hr)), (w / 2, -(ht + hr)), (w / 2, -ht), (0.0, 0.0), (-w / 2, -ht)]
    R = rotm(0, ry, rz)
    front = xf([(x, y, 0.004) for x, y in out], apex, R)
    back = xf([(x, y, -0.004) for x, y in out], apex, R)
    mb.poly(front, m)
    mb.poly(back[::-1], m)
    if deco and rng is not None:
        kind, cm = deco
        z = 0.0055
        if kind == "sun":
            c = xf([(rng.uniform(-0.02, 0.02), -(ht + hr * 0.45), z)], apex, R)[0]
            n = R @ Vector((0, 0, 1))
            disc(mb, c, tuple(n), w * 0.18, cm, seg=8)
        elif kind == "horse":
            pts = [(-0.04, -0.09), (0.03, -0.09), (0.045, -0.06), (0.03, -0.045), (-0.01, -0.06), (-0.04, -0.07)]
            mb.poly(xf([(x * w / 0.15, y * (ht + hr) / 0.105, z) for x, y in pts], apex, R), cm)
        else:
            for kk in range(3):
                x = -w * 0.25 + kk * w * 0.25
                q = [(x - 0.004, -(ht + hr) + 0.012, z), (x + 0.004, -(ht + hr) + 0.012, z),
                     (x + 0.004, -ht - 0.008, z), (x - 0.004, -ht - 0.008, z)]
                mb.poly(xf(q, apex, R), cm)


def build_ema_rack():
    rng = random.Random(29)
    wood = mat("er_wood", "#6b4e36", 0.85)
    wood_d = mat("er_wood_dark", "#3d2c1f", 0.9)
    roofm = mat("er_roof", "#3f5e52", 0.75, 0.2)
    roof_e = mat("er_roof_edge", "#2b3d36", 0.75)
    soffit = mat("er_soffit", "#2a2018", 0.95)
    ema = mat("ema_wood", "#d9b77c", 0.8)
    ema_o = mat("ema_wood_old", "#b8955e", 0.85)
    ema_g = mat("ema_wood_gray", "#9c8a6c", 0.9)
    ink = mat("ema_ink", "#24201c", 0.9)
    red = mat("ema_red", "#b3262a", 0.6)
    brown = mat("ema_brown", "#5a3a22", 0.8)
    b = MB("ema_rack")
    for sx in (-1, 1):
        x = sx * 0.92
        b.box((0.1, 0.08, 0.6), (x, 0.04, 0), wood_d, skip="ny")
        b.box((0.08, 1.62, 0.08), (x, 0.89, 0), wood)
        b.box((0.04, 0.36, 0.04), (x, 0.24, 0.12), wood_d, rot=(-38, 0, 0))
        b.box((0.04, 0.36, 0.04), (x, 0.24, -0.12), wood_d, rot=(38, 0, 0))
    for y in (0.72, 1.02, 1.32):
        b.box((1.84, 0.04, 0.04), (0, y, 0), wood)
    b.box((2.0, 0.08, 0.1), (0, 1.66, 0), wood_d)
    for sz in (1, -1):
        g = [[(x, 1.89 - 0.22 * t + 0.02 * (abs(x)) * t, sz * t * 0.3) for t in (0.0, 1.0)] for x in (-1.0, 0.0, 1.0)]
        sheet(b, g, 0.03, roofm, soffit, roof_e)
    b.box((2.02, 0.03, 0.06), (0, 1.885, 0), roof_e)
    mats = [ema, ema, ema_o, ema_o, ema_g]
    decos = [("sun", red), ("horse", brown), ("text", ink), ("text", ink), None, None]
    # front: ~34 overlapping plaques (keep the centre of the middle rail clear for the special ones)
    for y in (0.72, 1.02, 1.32):
        x = -0.84
        while x < 0.85:
            if y == 1.02 and -0.3 < x < 0.3:
                x += 0.1
                continue
            layer = rng.randint(0, 2)
            ema_board(b, (x + rng.uniform(-0.01, 0.01), y - 0.035, 0.03 + layer * 0.011), 0.15, 0.075, 0.03,
                      rng.choice(mats), rz=rng.uniform(-10, 10), deco=rng.choice(decos), rng=rng)
            x += rng.uniform(0.09, 0.13)
    for y in (0.72, 1.02, 1.32):
        x = -0.8
        while x < 0.8:
            ema_board(b, (x, y - 0.035, -0.03 - rng.randint(0, 1) * 0.011), 0.15, 0.075, 0.03, rng.choice(mats),
                      rz=rng.uniform(-10, 10), ry=180, deco=rng.choice(decos), rng=rng)
            x += rng.uniform(0.18, 0.3)
    b.build()
    # the three special 絵馬 (textures set from three.js)
    for i, x in enumerate((-0.19, 0.0, 0.19)):
        name = f"ema_special_{i + 1}"
        apex = (x, 1.02 - 0.025, 0.075)
        bd = MB(name + "_board")
        ema_board(bd, apex, 0.17, 0.13, 0.04, ema)
        bd.box((0.006, 0.03, 0.004), (x, 1.02 - 0.012, 0.075), red)
        bo = bd.build()
        pl = plane(name + "_face", 0.16, 0.12, (x, apex[1] - 0.04 - 0.065, 0.0802),
                   mat(f"tex_ema_{i + 1}", "#ffffff", 0.8))
        o = join([bo, pl], name)
        set_origin(o, apex)


def build_shinboku():
    rng = random.Random(31)
    bark = mat("sb_bark", "#4a3a2c", 0.95)
    bark_d = mat("sb_bark_dark", "#30251c", 0.95)
    bark_m = mat("sb_bark_moss", "#47552f", 1.0)
    leaf = mat("sb_leaf", "#22351f", 0.9)
    leaf2 = mat("sb_leaf_2", "#2d4426", 0.9)
    leaf3 = mat("sb_leaf_3", "#1a2817", 0.9)
    straw = mat("sb_straw", "#c9b06c", 0.9)
    straw_d = mat("sb_straw_dark", "#a08850", 0.9)
    paper = mat("sb_paper", "#f1efe6", 0.8)
    fence = mat("sb_fence", "#6f6050", 0.9)
    fence_d = mat("sb_fence_dark", "#4a3f34", 0.9)
    ink = mat("sb_ink", "#1f1c19", 0.9)
    t = MB("trunk")
    NS = 10
    rings = [(0.0, 1.08), (0.25, 0.92), (0.6, 0.76), (1.1, 0.68), (2.0, 0.65), (3.5, 0.6), (5.0, 0.54),
             (6.5, 0.47), (8.0, 0.4), (9.5, 0.32), (11.0, 0.24)]
    base = []
    for k, (y, r) in enumerate(rings):
        cx, cz = 0.08 * math.sin(y / 3.0), 0.05 * math.sin(y / 4.0 + 1)
        pts = []
        for i in range(NS):
            a = 2 * math.pi * i / NS
            rr = r * (1 + rng.uniform(-0.12, 0.12)) * (1 + (0.14 if (k < 3 and i % 2 == 0) else 0))
            pts.append((cx + rr * math.cos(a), y, cz - rr * math.sin(a)))
        base.append(t.addv(pts))
    for k in range(len(rings) - 1):
        for i in range(NS):
            j = (i + 1) % NS
            if rings[k][0] < 1.6 and (i + k) % 3 == 0:
                m = bark_m
            elif (i * 7 + k) % 5 == 0:
                m = bark_d
            else:
                m = bark
            t.face((base[k] + i, base[k] + j, base[k + 1] + j, base[k + 1] + i), m, True)
    t.face([base[-1] + i for i in range(NS)], bark)
    for i in range(7):
        ph = i * 2 * math.pi / 7 + 0.3
        L = 0.9 + 0.1 * ((i * 3) % 4)
        path = []
        for s_ in (0.0, 0.3, 0.65, 1.0):
            rr = 0.5 + L * s_
            path.append((rr * math.cos(ph), 0.04 + 1.25 * (1 - s_) ** 1.7, -rr * math.sin(ph)))
        t.loft(path, [(-0.3, -0.12), (0.3, -0.12), (0.12, 0.25), (0.0, 0.42), (-0.12, 0.25)],
               bark_d if i % 2 else bark, scales=[1.15, 0.85, 0.5, 0.22], smooth=True)
    t.build()
    br = MB("branches")
    for (y0, ph, L, up) in ((6.2, 0.4, 1.4, 1.6), (7.0, 2.6, 1.3, 1.8), (7.8, 4.4, 1.2, 1.9), (8.6, 1.5, 1.1, 2.0),
                            (9.4, 3.6, 0.9, 1.6)):
        p0 = (0.4 * math.cos(ph) * 0.5, y0, -0.4 * math.sin(ph) * 0.5)
        p1 = (L * 0.6 * math.cos(ph), y0 + up * 0.6, -L * 0.6 * math.sin(ph))
        p2 = (L * math.cos(ph), y0 + up, -L * math.sin(ph))
        br.loft([p0, p1, p2], [(math.cos(a), math.sin(a)) for a in (0, 1.25, 2.5, 3.75, 5.0)], bark,
                scales=[0.16, 0.1, 0.05])
    br.build()
    fo = MB("foliage")
    clumps = [((0.1, 15.3, 0.0), 0.85), ((-0.65, 14.5, 0.45), 1.05), ((0.7, 13.9, -0.4), 1.1),
              ((-0.55, 12.9, -0.6), 1.2), ((0.65, 12.2, 0.65), 1.2), ((-0.8, 11.4, 0.2), 1.1),
              ((0.75, 10.6, -0.55), 1.15), ((-0.3, 10.0, 0.75), 1.15), ((0.85, 9.2, 0.3), 1.05),
              ((-0.75, 8.6, -0.55), 1.1), ((0.2, 8.0, -0.85), 1.0), ((-0.2, 7.4, 0.5), 0.95),
              ((0.0, 11.8, 0.0), 1.0)]
    for k, (c, r) in enumerate(clumps):
        fo.sphere(r, c, (leaf, leaf2, leaf3)[k % 3], seg=7, rings=5, jit=0.18, rng=rng, scale=(1, 0.58, 1),
                  rot=(rng.uniform(-12, 12), rng.uniform(0, 90), rng.uniform(-12, 12)))
    for i, v in enumerate(fo.v):
        fo.v[i] = (max(-1.98, min(1.98, v[0])), min(16.0, v[1]), max(-1.98, min(1.98, v[2])))
    fo.build()
    # 注連縄, 紙垂, 房
    sm = MB("shimenawa")
    RR = 0.76
    path = [(RR * math.cos(2 * math.pi * i / 20), 2.2 - 0.06 * max(0, -math.sin(2 * math.pi * i / 20)),
             -RR * math.sin(2 * math.pi * i / 20)) for i in range(20)]
    rope(sm, path, 0.1, straw, straw_d, sides=6, closed=True, twist=1)
    for a in (-70, -25, 25, 70):
        an = math.radians(270 + a)
        nx, nz = math.cos(an), -math.sin(an)
        shide(sm, (nx * (RR + 0.1), 2.08, nz * (RR + 0.1)), paper, length=0.48, width=0.08, steps=4,
              facing=math.degrees(math.atan2(nx, nz)))
    for a in (-48, 0, 48):
        an = math.radians(270 + a)
        nx, nz = math.cos(an), -math.sin(an)
        sm.cyl(0.05, 0.3, (nx * (RR + 0.05), 1.93, nz * (RR + 0.05)), straw, seg=6, r2=0.015)
    sm.build()
    fc = MB("fence")
    F = 1.88
    for side in range(4):
        for k in range(4):
            u = -F + k * (2 * F / 4)
            x, z = [(u, F), (F, -u), (-u, -F), (-F, u)][side]
            fc.box((0.08, 0.65, 0.08), (x, 0.325, z), fence_d, skip="ny", taper=(0.8, 0.8))
    for y in (0.28, 0.52):
        fc.box((2 * F, 0.05, 0.04), (0, y, F), fence)
        fc.box((2 * F, 0.05, 0.04), (0, y, -F), fence)
        fc.box((0.04, 0.05, 2 * F), (F, y, 0), fence)
        fc.box((0.04, 0.05, 2 * F), (-F, y, 0), fence)
    fc.box((0.16, 0.36, 0.02), (0.5, 0.45, F + 0.035), paper)
    fquad(fc, (0.5, 0.45, F + 0.046), 0.02, 0.28, ink)
    fc.build()


def build_cedar_tree():
    rng = random.Random(37)
    bark = mat("cd_bark", "#4b3a2e", 0.95)
    leaf = mat("cd_leaf", "#1f3320", 0.9)
    leaf2 = mat("cd_leaf_2", "#284229", 0.9)
    leafu = mat("cd_leaf_under", "#142114", 0.95)
    t = MB("trunk")
    t.cyl(0.3, 0.5, (0, 0.25, 0), bark, seg=7, r2=0.225, caps=(False, False))
    t.cyl(0.225, 6.0, (0, 3.5, 0), bark, seg=7, r2=0.17, caps=(False, False))
    t.cyl(0.17, 6.0, (0, 9.5, 0), bark, seg=7, r2=0.06, caps=(False, False))
    t.build()
    f = MB("leaves")
    layers = [(5.5, 8.1, 1.3), (6.9, 9.5, 1.15), (8.3, 10.8, 0.98), (9.6, 11.9, 0.8), (10.8, 13.0, 0.6),
              (11.9, 14.0, 0.38)]
    for k, (y0, y1, R) in enumerate(layers):
        n = 8 if k == 0 else 10
        a0 = 0.0 if k == 0 else rng.uniform(0, 2 * math.pi)
        ox, oz = (0.0, 0.0) if k == 0 else (rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06))
        rim = []
        for i in range(n):
            a = a0 + 2 * math.pi * i / n
            rr = R * (1.0 if i % 2 == 0 else 0.74) * (rng.uniform(0.9, 1.0) if (i % 2 == 0 and k > 0) else 1.0)
            rim.append((ox + rr * math.cos(a), y0 - (0.18 if i % 2 == 0 else 0.0), oz - rr * math.sin(a)))
        b0 = f.addv(rim + [(ox * 0.3, y1, oz * 0.3)])
        for i in range(n):
            f.face((b0 + i, b0 + (i + 1) % n, b0 + n), leaf if (i + k) % 2 == 0 else leaf2)
        f.face([b0 + i for i in reversed(range(n))], leafu)
    for i, v in enumerate(f.v):
        f.v[i] = (max(-1.3, min(1.3, v[0])), v[1], max(-1.3, min(1.3, v[2])))
    f.build()


def build_hokora():
    rng = random.Random(41)
    st = mat("hk_stone", "#7d7b72", 0.95)
    st_d = mat("hk_stone_dark", "#5c5a54", 0.95)
    moss = mat("moss", "#4f6535", 1.0)
    moss_l = mat("moss_light", "#6b7c40", 1.0)
    wood = mat("hk_wood", "#5a4636", 0.9)
    wood_d = mat("hk_wood_dark", "#3a2d23", 0.9)
    wood_g = mat("hk_wood_gray", "#6f6558", 0.9)
    roofm = mat("hk_roof", "#3f3a33", 0.85)
    roof_mo = mat("hk_roof_moss", "#4a5a33", 1.0)
    brass = mat("hk_brass", "#8f7a3c", 0.5, 0.5)
    dark = mat("hk_dark", "#120e0b", 1.0)
    straw = mat("hk_straw", "#b9a466", 0.9)
    paper = mat("hk_paper", "#e9e6da", 0.85)
    cup = mat("hk_cup", "#d8d4c6", 0.4)
    stain = mat("hk_tea_stain", "#6b5434", 0.8)
    vase = mat("hk_vase", "#cfcabb", 0.5)
    twig = mat("hk_twig", "#4a3a2a", 0.9)
    dleaf = mat("hk_dead_leaf", "#6b5a36", 0.9)
    dleaf2 = mat("hk_dead_leaf_dark", "#3f3b25", 0.9)
    b = MB("hokora")
    b.box((1.0, 0.16, 0.9), (0, 0.08, 0), st_d, skip="ny")
    b.box((0.8, 0.36, 0.72), (0, 0.34, -0.04), st, skip="ny")
    for c in ((-0.45, 0.1605, 0.38), (0.44, 0.1605, -0.3), (0.42, 0.1605, 0.4), (-0.3, 0.5205, 0.26),
              (0.32, 0.5205, -0.33)):
        patch(b, c, 0.06, moss, rng)
    patch(b, (-0.25, 0.3, 0.3205), 0.08, moss_l, rng, facing="z", squash=0.6)
    # wooden body
    b.box((0.6, 0.05, 0.5), (0, 0.545, -0.12), wood_d)
    b.box((0.48, 0.44, 0.36), (0, 0.79, -0.15), wood)
    for sx in (-1, 1):
        for zz in (0.03, -0.33):
            b.box((0.05, 0.46, 0.05), (sx * 0.24, 0.8, zz), wood_d)
        b.box((0.2, 0.38, 0.02), (sx * 0.105, 0.78, 0.04), wood_g)
        for k in range(3):
            fquad(b, (sx * 0.105 + (k - 1) * 0.05, 0.89, 0.0505), 0.018, 0.14, dark)
        b.cyl(0.012, 0.01, (sx * 0.025, 0.76, 0.055), brass, seg=6, axis="z")
    b.box((0.52, 0.03, 0.03), (0, 1.0, 0.04), wood_d)
    b.box((0.56, 0.03, 0.13), (0, 0.585, 0.1), wood_d)
    # 流造 roof (long front slope), chigi and katsuogi
    def yr(t, front):
        return 1.4 - (0.34 if front else 0.25) * (1 - (1 - t) ** 1.3)
    blobs = {True: [(-0.3, 0.78, 0.13), (0.12, 0.88, 0.1), (0.36, 0.5, 0.08), (-0.06, 0.32, 0.07),
                    (0.3, 0.9, 0.07)],
             False: [(0.2, 0.7, 0.1), (-0.28, 0.5, 0.08)]}
    for front in (True, False):
        zs = 0.57 if front else -0.3

        def surf(x, t, front=front, zs=zs):
            return Vector((x, yr(t, front) + 0.02 * abs(x) * t, -0.15 + zs * t))
        g = [[tuple(surf(x, t)) for t in (0.0, 0.35, 0.7, 1.0)] for x in (-0.5, -0.25, 0.0, 0.25, 0.5)]
        sheet(b, g, 0.04, roofm, wood_d, wood_d)
        for (x, t, r) in blobs[front]:
            v = surf(x, t - 0.02) - surf(x, t + 0.02)
            u = Vector((1, 0, 0)) if front else Vector((-1, 0, 0))
            nrm = u.cross(v).normalized()
            if nrm.y < 0:
                u = -u
                nrm = -nrm
            patch_on(b, tuple(surf(x, t) + nrm * 0.012), u, v, r, roof_mo if r > 0.075 else moss_l, rng, n=8)
    b.box((1.04, 0.05, 0.09), (0, 1.42, -0.15), roofm)
    for sx in (-1, 1):
        for d in (-1, 1):
            b.box((0.02, 0.17, 0.03), (sx * 0.49, 1.43, -0.15 + d * 0.035), wood_d, rot=(d * 32, 0, 0))
    for x in (-0.22, 0.0, 0.22):
        b.cyl(0.025, 0.12, (x, 1.47, -0.15), wood_d, seg=6, axis="z", smooth=False)
    # small 注連縄 with two 紙垂
    path = catenary((-0.26, 1.02, 0.09), (0.26, 1.02, 0.09), 0.05, 8)
    b.loft(path, [(math.cos(a), math.sin(a)) for a in (0, 2.1, 4.2)], straw, scales=[0.016] * 9)
    for x in (-0.12, 0.12):
        shide(b, (x, 0.99, 0.1), paper, length=0.14, width=0.03, steps=3)
    # offerings: a cracked teacup with its shard, withered sakaki in two vases
    cx, cz, cy = 0.1, 0.24, 0.52
    b.cyl(0.032, 0.06, (cx, cy + 0.03, cz), cup, seg=8, caps=(True, False), open_faces=(5, 6), smooth=False)
    b.cyl(0.029, 0.055, (cx, cy + 0.0325, cz), stain, seg=8, caps=(False, False), open_faces=(5, 6), flip=True,
          smooth=False)
    b.box((0.03, 0.006, 0.02), (cx + 0.07, cy + 0.003, cz + 0.03), cup, rot=(0, 30, 10))
    for sx in (-1, 1):
        vx, vz = sx * 0.3, 0.22
        b.cyl(0.03, 0.1, (vx, cy + 0.05, vz), vase, seg=8, r2=0.026, caps=(False, True), mcap=dark)
        for k in range(3):
            ang = (k - 1) * 18 + sx * 6
            L = 0.22 - k * 0.03
            top = (vx + math.sin(math.radians(ang)) * L * 0.6, cy + 0.1 + L, vz + 0.02 * (k - 1))
            seg_tube(b, (vx, cy + 0.09, vz), top, 0.004, twig, sides=3, caps=False)
            for q in range(2):
                lc = lerp3((vx, cy + 0.1, vz), top, 0.6 + q * 0.35)
                b.poly(xf([(-0.012, -0.02, 0), (0.012, -0.02, 0), (0.008, 0.02, 0), (-0.008, 0.02, 0)],
                          lc, rotm(rng.uniform(-30, 30), rng.uniform(0, 180), rng.uniform(-60, 60))),
                       dleaf if (k + q) % 2 else dleaf2, both=True)
    for k in range(4):
        lc = (rng.uniform(-0.4, 0.4), 0.163, rng.uniform(0.3, 0.42))
        b.poly(xf([(-0.015, 0, -0.025), (0.015, 0, -0.025), (0.01, 0, 0.025), (-0.01, 0, 0.025)][::-1], lc,
                  rotm(0, rng.uniform(0, 180), 0)), dleaf)
    b.build()


def namako(mb, origin, right, up, normal, w, h, base, joint, spacing=0.32, jw=0.035, holes=()):
    """なまこ壁: dark tiles with raised white diagonal joints on a wall rectangle (w x h)."""
    O, Rt, Up, N = Vector(origin), Vector(right), Vector(up), Vector(normal)

    def P(u, v, off):
        return tuple(O + Rt * u + Up * v + N * off)
    b0 = mb.addv([P(0, 0, 0.008), P(w, 0, 0.008), P(w, h, 0.008), P(0, h, 0.008)])
    mb.oface([b0, b0 + 1, b0 + 2, b0 + 3], base, tuple(N))
    step = spacing * math.sqrt(2)
    c = -h
    while c < w:
        for sgn in (1, -1):
            if sgn > 0:
                ua, ub = max(0.0, c), min(w, h + c)
                pa, pb = (ua, ua - c), (ub, ub - c)
            else:
                cc = c + h
                ua, ub = max(0.0, cc - h), min(w, cc)
                pa, pb = (ua, cc - ua), (ub, cc - ub)
            if ub - ua < 0.02:
                continue
            if any(hx0 < (pa[0] + pb[0]) / 2 < hx1 for hx0, hx1 in holes):
                continue
            d = Vector((pb[0] - pa[0], pb[1] - pa[1])).normalized()
            nrm = Vector((-d.y, d.x)) * (jw / 2)
            q = [P(pa[0] + nrm.x, pa[1] + nrm.y, 0.014), P(pb[0] + nrm.x, pb[1] + nrm.y, 0.014),
                 P(pb[0] - nrm.x, pb[1] - nrm.y, 0.014), P(pa[0] - nrm.x, pa[1] - nrm.y, 0.014)]
            b0 = mb.addv(q)
            mb.oface([b0, b0 + 1, b0 + 2, b0 + 3], joint, tuple(N))
        c += step


def build_kura():
    rng = random.Random(43)
    plaster = mat("kr_plaster", "#e6e2d6", 0.9)
    plaster_s = mat("kr_plaster_stain", "#bdb7a6", 0.95)
    plaster_d = mat("kr_plaster_dirty", "#a29d8f", 0.95)
    tilem = mat("kr_namako_tile", "#33363a", 0.6)
    joint = mat("kr_namako_joint", "#e9e5da", 0.85)
    stone = mat("kr_stone", "#7c7a72", 0.95)
    stone_d = mat("kr_stone_dark", "#5d5b55", 0.95)
    roof = mat("kr_tile", "#2a2b2d", 0.6)
    roof_d = mat("kr_tile_dark", "#1a1b1c", 0.6)
    soffit = mat("kr_soffit", "#d9d4c6", 0.95)
    black = mat("kr_black", "#1c1c1c", 0.8)
    iron = mat("kr_iron", "#3a3633", 0.6, 0.6)
    rust = mat("kr_rust", "#6b3f25", 0.8, 0.3)
    void = mat("kr_void", "#0c0b0a", 1.0)
    moss = mat("moss", "#4f6535", 1.0)
    b = MB("kura")
    X, Z = 2.2, 2.6
    b.box2((-X - 0.1, 0, -Z - 0.1), (X + 0.1, 0.42, Z + 0.1), stone, skip="ny")
    for k in range(9):
        x = -X + 0.25 + k * 0.5
        fquad(b, (x, 0.21, Z + 0.1005), 0.015, 0.42, stone_d)
        fquad(b, (-x, 0.21, -Z - 0.1005), 0.015, 0.42, stone_d, "-z")
    for k in range(10):
        z = -Z + 0.3 + k * 0.5
        fquad(b, (X + 0.1005, 0.21, z), 0.015, 0.42, stone_d, "x")
        fquad(b, (-X - 0.1005, 0.21, z), 0.015, 0.42, stone_d, "-x")
    for c in ((-2.25, 0.4205, 2.65), (2.24, 0.4205, 1.0), (-2.25, 0.4205, -1.5), (1.0, 0.4205, -2.65)):
        patch(b, c, 0.07, moss, rng, squash=0.5)
    b.box2((-X, 0.42, -Z), (X, 4.0, Z), plaster, skip="ny py")
    # なまこ壁 on all four sides (front split around the door)
    H0, H1 = 0.42, 1.85
    namako(b, (-X, H0, Z), (1, 0, 0), (0, 1, 0), (0, 0, 1), 2 * X, H1 - H0, tilem, joint, holes=((1.25, 3.15),))
    namako(b, (X, H0, -Z), (-1, 0, 0), (0, 1, 0), (0, 0, -1), 2 * X, H1 - H0, tilem, joint)
    namako(b, (X, H0, Z), (0, 0, -1), (0, 1, 0), (1, 0, 0), 2 * Z, H1 - H0, tilem, joint)
    namako(b, (-X, H0, -Z), (0, 0, 1), (0, 1, 0), (-1, 0, 0), 2 * Z, H1 - H0, tilem, joint)
    for sx in (-1, 1):
        b.box2((sx * X - 0.06, H1, -Z - 0.06), (sx * X + 0.06, H1 + 0.06, Z + 0.06), plaster)
    b.box2((-X - 0.06, H1, Z - 0.06), (X + 0.06, H1 + 0.06, Z + 0.06), plaster)
    b.box2((-X - 0.06, H1, -Z - 0.06), (X + 0.06, H1 + 0.06, -Z + 0.06), plaster)
    # rain streaks and splash dirt on the plaster
    for k in range(7):
        x = rng.uniform(-2.0, 2.0)
        fquad(b, (x, 3.4, Z + 0.002), rng.uniform(0.05, 0.12), rng.uniform(0.6, 1.1), plaster_s)
        z = rng.uniform(-2.3, 2.3)
        fquad(b, (X + 0.002, 3.4, z), rng.uniform(0.05, 0.12), rng.uniform(0.6, 1.2), plaster_s, "x")
        fquad(b, (-X - 0.002, 3.4, -z), rng.uniform(0.05, 0.12), rng.uniform(0.6, 1.2), plaster_s, "-x")
    fquad(b, (0, 1.95, -Z - 0.002), 4.3, 0.18, plaster_d, "-z")
    # 鉢巻 (thick cornice)
    b.box2((-X - 0.1, 4.0, -Z - 0.1), (X + 0.1, 4.32, Z + 0.1), plaster, fm={"ny": plaster_s})
    # gable walls with crest and a barred window
    for sz in (-1, 1):
        tri = [(-X - 0.1, 4.32, sz * (Z + 0.1)), (X + 0.1, 4.32, sz * (Z + 0.1)), (0, 5.62, sz * (Z + 0.1))]
        b.poly(tri if sz > 0 else tri[::-1], plaster)
    for sz in (1, -1):
        zz = sz * (Z + 0.1)
        n = (0, 0, sz)
        disc(b, (0, 5.12, zz + sz * 0.002), n, 0.22, black, seg=16)
        disc(b, (0, 5.12, zz + sz * 0.004), n, 0.16, plaster, seg=16)
        disc(b, (0, 5.12, zz + sz * 0.006), n, 0.07, black, seg=12)
    b.box2((-0.36, 4.42, Z + 0.1), (0.36, 4.86, Z + 0.2), black, skip="nz")
    fquad(b, (0, 4.64, Z + 0.2005), 0.56, 0.32, void)
    for k in range(5):
        b.box((0.025, 0.32, 0.025), (-0.2 + k * 0.1, 4.64, Z + 0.215), iron)
    # gable roof (black tiles), ribs, ridge with onigawara, bargeboards
    def yr(t):
        return 5.72 - 1.42 * t
    for sx in (-1, 1):
        g = [[(sx * 2.55 * t, yr(t), z) for t in (0.0, 1.0)] for z in (3.0, -3.0)]
        if sx < 0:
            g = g[::-1]
        sheet(b, g, 0.18, roof, soffit, roof_d)
        L = math.hypot(2.55, 1.42)
        ang = math.degrees(math.atan2(1.42, 2.55))
        for k in range(23):
            z = -2.85 + k * 0.26
            b.box((L - 0.05, 0.05, 0.08), (sx * 1.275, yr(0.5) + 0.03, z), roof_d, rot=(0, 0, -sx * ang),
                  skip="ny px nx")
        b.box2((sx * 2.55 - 0.06, yr(1.0) - 0.06, -3.0), (sx * 2.55 + 0.06, yr(1.0) + 0.06, 3.0), roof_d)
        for sz in (-1, 1):
            b.box((L, 0.26, 0.1), (sx * 1.275, yr(0.5) - 0.12, sz * 2.96), plaster, rot=(0, 0, -sx * ang))
    b.box2((-0.18, 5.62, -3.02), (0.18, 5.88, 3.02), roof_d)
    for sz in (-1, 1):
        b.box((0.5, 0.42, 0.12), (0, 5.79, sz * 2.94), roof_d)
    # heavy double doors with stepped frame, iron straps and a padlock
    DZ = Z
    for k, (w, h, d, m) in enumerate(((1.9, 2.3, 0.08, black), (1.74, 2.2, 0.15, plaster), (1.58, 2.1, 0.2, black))):
        y0 = 0.42
        b.box2((-w / 2, y0 + h - 0.08, DZ), (w / 2, y0 + h, DZ + d), m)
        b.box2((-w / 2, y0, DZ), (-w / 2 + 0.08, y0 + h, DZ + d), m)
        b.box2((w / 2 - 0.08, y0, DZ), (w / 2, y0 + h, DZ + d), m)
    for sx in (-1, 1):
        b.box2((sx * 0.71 if sx < 0 else 0.005, 0.45, DZ), (-0.005 if sx < 0 else 0.71, 2.44, DZ + 0.17),
               plaster_d, fm={"pz": plaster})
        for y in (0.8, 1.6, 2.2):
            b.box2((sx * 0.68 if sx < 0 else 0.06, y - 0.03, DZ + 0.17), (-0.06 if sx < 0 else 0.68, y + 0.03,
                   DZ + 0.185), iron)
    b.box((0.06, 0.18, 0.04), (0, 1.45, DZ + 0.19), iron)
    b.box((0.16, 0.13, 0.06), (0, 1.3, DZ + 0.22), iron)
    b.box((0.02, 0.1, 0.02), (-0.05, 1.41, DZ + 0.22), rust)
    b.box((0.02, 0.1, 0.02), (0.05, 1.41, DZ + 0.22), rust)
    b.box((0.12, 0.02, 0.02), (0, 1.46, DZ + 0.22), rust)
    fquad(b, (0, 1.29, DZ + 0.2505), 0.02, 0.05, void)
    # door canopy (庇) and the stone step
    for sx in (-1, 1):
        b.box((0.08, 0.08, 0.36), (sx * 0.95, 2.82, DZ + 0.2), black)
    g = [[(x, 3.02 - 0.22 * t, DZ + 0.02 + 0.36 * t) for t in (0.0, 1.0)] for x in (-1.1, 1.1)]
    sheet(b, g, 0.06, roof, black, roof_d)
    b.box((1.6, 0.2, 0.3), (0, 0.1, Z + 0.25), stone, skip="ny")
    # small shuttered windows on the long sides
    for sx in (-1, 1):
        b.box2((sx * X - 0.12 if sx < 0 else X, 2.8, -0.45), (-X if sx < 0 else X + 0.12, 3.4, 0.45), black)
        b.box2((sx * X - 0.16 if sx < 0 else X, 2.85, -0.4), (-X if sx < 0 else X + 0.16, 3.35, 0.4), plaster,
               fm={"px" if sx > 0 else "nx": plaster_s})
    b.build()


def build_bench():
    rng = random.Random(47)
    w1 = mat("bn_wood", "#7a654f", 0.9)
    w2 = mat("bn_wood_2", "#6a5644", 0.9)
    w3 = mat("bn_wood_3", "#857058", 0.9)
    wd = mat("bn_wood_dark", "#4a3b2e", 0.9)
    stain = mat("bn_stain", "#3e342b", 0.95)
    rust = mat("bn_rust", "#5a3a26", 0.8, 0.3)
    moss = mat("moss", "#55693a", 1.0)
    b = MB("bench")
    for x in (-0.66, 0.66):  # (geometry shifted +0.02 z at build end)
        b.box((0.06, 0.4, 0.06), (x, 0.2, 0.17), wd, skip="ny")
        b.box((0.06, 0.8, 0.06), (x, 0.402, -0.19), wd, rot=(-6, 0, 0))
        b.box((0.06, 0.06, 0.46), (x, 0.37, -0.01), wd)
        b.box((0.05, 0.05, 0.36), (x, 0.12, -0.01), wd)
    b.box((1.32, 0.05, 0.04), (0, 0.12, -0.17), wd)
    for k, z in enumerate((0.165, 0.05, -0.065)):
        b.box((1.6, 0.03, 0.105), (0, 0.415, z), (w1, w2, w3)[k], smooth=False)
        for x in (-0.66, 0.66):
            fquad(b, (x, 0.431, z), 0.012, 0.012, rust, "y")
    for k, y in enumerate((0.58, 0.73)):
        z = -0.19 - (y - 0.402) * math.tan(math.radians(6)) + 0.045
        b.box((1.6, 0.1, 0.025), (0, y, z), (w3, w1)[k], rot=(-6, 0, 0))
    patch(b, (0.3, 0.4305, 0.05), 0.07, stain, rng, squash=0.6)
    patch(b, (-0.5, 0.4305, 0.15), 0.05, stain, rng, squash=0.5)
    patch(b, (0.2, 0.1455, -0.17), 0.04, moss, rng, squash=0.4)
    b.v = [(x, y, z + 0.021) for x, y, z in b.v]
    b.build()


# ═══════════════════════════════════════════════════════════════════════════
#  main
# ═══════════════════════════════════════════════════════════════════════════
if only_requested("conbini_counter"):
    make("conbini_counter", build_conbini_counter,
         views=[("back", (-0.4, 0.6, -1.0), (0, 0, 0), 1.2), ("case", (0.3, 0.3, 1.0), (0.35, 0.1, 0), 0.5)])
if only_requested("conbini_back_shelf"):
    make("conbini_back_shelf", build_conbini_back_shelf, views=[("front", (0.0, 0.2, 1.0), (0, 0, 0), 1.3)])
if only_requested("conbini_shelf"):
    make("conbini_shelf", build_conbini_shelf,
         views=[("back", (-0.8, 0.5, -1.0), (0, 0, 0), 1.3), ("end", (1.0, 0.3, 0.2), (0, 0, 0), 1.0)])
if only_requested("conbini_drink_fridge"):
    make("conbini_drink_fridge", build_conbini_drink_fridge, views=[("front", (0.0, 0.1, 1.0), (0, 0, 0), 1.2)])
if only_requested("conbini_magazine"):
    make("conbini_magazine", build_conbini_magazine, views=[("back", (-0.6, 0.6, -1.0), (0, 0, 0), 1.3)])
if only_requested("atm"):
    make("atm", build_atm, views=[("front", (0.0, 0.3, 1.0), (0, 0, 0), 1.6)])
if only_requested("copy_machine"):
    make("copy_machine", build_copy_machine, views=[("left", (-1.0, 0.5, 0.6), (0, 0, 0), 1.6)])
if only_requested("conbini_sign"):
    make("conbini_sign", build_conbini_sign, views=[("front", (0.0, 0.0, 1.0), (0, 0, 0), 1.0)])
if only_requested("auto_door"):
    make("auto_door", build_auto_door, views=[("front", (0.0, 0.0, 1.0), (0, 0, 0), 1.4)])
if only_requested("trash_bins"):
    make("trash_bins", build_trash_bins)
if only_requested("car_stop"):
    make("car_stop", build_car_stop)
if only_requested("torii"):
    make("torii", build_torii, views=[("front", (0.0, 0.25, 1.0), (0, 0.1, 0), 1.2)])
if only_requested("stone_lantern"):
    make("stone_lantern", build_stone_lantern, views=[("front", (0.0, 0.2, 1.0), (0, 0.15, 0), 0.9)])
if only_requested("chozuya"):
    make("chozuya", build_chozuya, views=[("back", (-0.5, 0.5, -1.0), (0, -0.1, 0), 1.2)])
if only_requested("komainu"):
    make("komainu", build_komainu, views=[("front", (0.25, 0.15, 1.0), (0, 0.2, 0), 0.9),
                                          ("side", (1.0, 0.2, 0.0), (0, 0.2, 0), 1.0)])
if only_requested("haiden"):
    make("haiden", build_haiden, views=[("front", (0.0, 0.15, 1.0), (0, -0.05, 0), 1.3),
                                        ("bell", (0.15, 0.0, 1.0), (0, -0.2, 0.45), 0.35)])
if only_requested("saisen_box"):
    make("saisen_box", build_saisen_box)
if only_requested("shrine_office"):
    make("shrine_office", build_shrine_office, views=[("window", (0.15, 0.05, 1.0), (0, -0.1, 0.1), 0.9),
                                                      ("back", (-0.6, 0.5, -1.0), (0, 0, 0), 1.2)])
if only_requested("ema_rack"):
    make("ema_rack", build_ema_rack, views=[("front", (0.0, 0.1, 1.0), (0, 0.05, 0), 0.75)])
if only_requested("shinboku"):
    make("shinboku", build_shinboku, views=[("base", (0.3, 0.3, 1.0), (0, -0.36, 0), 0.4)])
if only_requested("cedar_tree"):
    make("cedar_tree", build_cedar_tree)
if only_requested("hokora"):
    make("hokora", build_hokora, views=[("front", (0.1, 0.25, 1.0), (0, 0, 0), 1.0)])
if only_requested("kura"):
    make("kura", build_kura, views=[("front", (0.2, 0.1, 1.0), (0, 0, 0), 1.3)])
if only_requested("bench"):
    make("bench", build_bench)
