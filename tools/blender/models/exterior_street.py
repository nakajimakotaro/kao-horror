"""Apartment exterior details, street furniture and the houses of 月見町.

    Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/exterior_street.py -- --preview
    ... -- --only utility_pole,house_a --preview
    KAO_VIEWS=<dir> ...      (extra debug renders from other angles are written to <dir>)

All coordinates are three.js space (x right, y up, z = front).  Every model's origin is the centre
of its footprint at ground level (fluorescent_light: the centre of its top face) and the front faces +z.
Most of the geometry is collected per object with the small mesh builder `MB` below, so a model ends
up as a handful of nodes with per-face materials instead of hundreds of loose objects.
"""
import os
import sys
import math
import random
from contextlib import contextmanager

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
from common import *  # noqa: F401,F403
import bpy
import bmesh
from mathutils import Vector, Matrix


# ═══════════════════════════════════════════════════════════════════════════
#  mesh builder (three.js coordinates)
# ═══════════════════════════════════════════════════════════════════════════
def _v(p):
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def rotm(rx=0.0, ry=0.0, rz=0.0):
    """3x3 rotation in three.js space (degrees), applied X, then Y, then Z."""
    return (Matrix.Rotation(math.radians(rz), 3, "Z") @ Matrix.Rotation(math.radians(ry), 3, "Y")
            @ Matrix.Rotation(math.radians(rx), 3, "X"))


def newell(pts):
    n = Vector((0.0, 0.0, 0.0))
    k = len(pts)
    for i in range(k):
        a, b = pts[i], pts[(i + 1) % k]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


def clip_poly(poly, a, b, c):
    """Keep the part of a convex 2D polygon where a*x + b*y <= c."""
    out = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        fp = a * p[0] + b * p[1] - c
        fq = a * q[0] + b * q[1] - c
        if fp <= 0:
            out.append(p)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    clean = []
    for p in out:
        if not clean or abs(p[0] - clean[-1][0]) + abs(p[1] - clean[-1][1]) > 1e-7:
            clean.append(p)
    if len(clean) > 1 and abs(clean[0][0] - clean[-1][0]) + abs(clean[0][1] - clean[-1][1]) < 1e-7:
        clean.pop()
    return clean


def stripes2d(x0, x1, y0, y1, width, k=1.0):
    """Diagonal stripes (x - k*y in [i*w, (i+1)*w)) clipped to a rectangle -> [(poly, i)]."""
    rect = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    cs = [x0 - k * y0, x0 - k * y1, x1 - k * y0, x1 - k * y1]
    i = int(math.floor(min(cs) / width))
    res = []
    while i * width < max(cs):
        p = clip_poly(rect, -1.0, k, -i * width)
        p = clip_poly(p, 1.0, -k, (i + 1) * width)
        if len(p) >= 3:
            res.append((p, i))
        i += 1
    return res


class MB:
    """Collects faces (three.js coords) with per-face materials; build() makes one Blender object."""

    def __init__(self):
        self.verts = []
        self.faces = []  # (vertex indices, material index, smooth, uvs)
        self.mats = []
        self.M = Matrix.Identity(4)

    # ── bookkeeping ──────────────────────────────────────────────────────────
    def mi(self, m):
        for i, x in enumerate(self.mats):
            if x.name == m.name:
                return i
        self.mats.append(m)
        return len(self.mats) - 1

    @property
    def flip(self):
        return self.M.to_3x3().determinant() < 0

    def tp(self, p):
        return self.M @ _v(p)

    @contextmanager
    def at(self, pos=(0, 0, 0), ry=0.0, rx=0.0, rz=0.0, scale=None):
        """Local frame: points given inside are rotated (X, Y, Z order) then moved to pos."""
        old = self.M.copy()
        S = Matrix.Identity(4)
        if scale is not None:
            S = Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        self.M = old @ Matrix.Translation(_v(pos)) @ rotm(rx, ry, rz).to_4x4() @ S
        try:
            yield self
        finally:
            self.M = old

    def poly(self, pts, m, smooth=False, uv=None):
        P = [self.tp(p) for p in pts]
        uvs = list(uv) if uv else None
        if self.flip:
            P.reverse()
            if uvs:
                uvs.reverse()
        base = len(self.verts)
        self.verts.extend(P)
        self.faces.append((list(range(base, base + len(P))), self.mi(m), smooth, uvs))

    def pdir(self, pts, m, want, smooth=False, uv=None):
        """Polygon oriented so that its normal points along `want` (local coords)."""
        P = [_v(p) for p in pts]
        if newell(P).dot(_v(want)) < 0:
            P.reverse()
            if uv:
                uv = list(uv)[::-1]
        self.poly(P, m, smooth, uv)

    def addv(self, pts):
        base = len(self.verts)
        self.verts.extend(self.tp(p) for p in pts)
        return list(range(base, base + len(pts)))

    def fidx(self, idx, m, smooth=False):
        idx = list(idx)
        if self.flip:
            idx.reverse()
        self.faces.append((idx, self.mi(m), smooth, None))

    def quad_uv(self, bl, br, tr, tl, m):
        """Textured quad (UV 0..1, same convention as common.plane): corners as seen from the front."""
        self.poly([bl, br, tr, tl], m, False, [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])

    # ── primitives ───────────────────────────────────────────────────────────
    _BOXF = (("+x", (1, 0, 0), ((1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1))),
             ("-x", (-1, 0, 0), ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1))),
             ("+y", (0, 1, 0), ((-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1))),
             ("-y", (0, -1, 0), ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1))),
             ("+z", (0, 0, 1), ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))),
             ("-z", (0, 0, -1), ((-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1))))

    def box(self, size, pos, m, R=None, fm=None, skip=()):
        h = _v(size) * 0.5
        c = _v(pos)
        for key, n, corners in self._BOXF:
            if key in skip:
                continue
            pts = [Vector((a * h.x, b * h.y, cc * h.z)) for a, b, cc in corners]
            nn = _v(n)
            if R is not None:
                pts = [R @ p for p in pts]
                nn = R @ nn
            self.pdir([c + p for p in pts], (fm or {}).get(key, m), nn)

    def bb(self, x0, x1, y0, y1, z0, z1, m, fm=None, skip=()):
        """Axis aligned box from min/max."""
        self.box((abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)), ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                 m, fm=fm, skip=skip)

    def cbox(self, size, pos, m, b=0.01, R=None, fm=None):
        """Box with chamfered edges (catches the flashlight on its corners)."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=b, segments=1,
                        affect="EDGES", clamp_overlap=True, profile=0.5)
        bm.normal_update()
        c = _v(pos)
        keys = (("+x", (1, 0, 0)), ("-x", (-1, 0, 0)), ("+y", (0, 1, 0)), ("-y", (0, -1, 0)),
                ("+z", (0, 0, 1)), ("-z", (0, 0, -1)))
        for f in bm.faces:
            pts = [v.co.copy() for v in f.verts]
            mm = m
            if fm:
                for key, vec in keys:
                    if key in fm and f.normal.dot(_v(vec)) > 0.99:
                        mm = fm[key]
            if R is not None:
                pts = [R @ p for p in pts]
            self.poly([c + p for p in pts], mm)
        bm.free()

    def tube(self, p0, p1, r0, m, r1=None, sides=8, caps=True, smooth=True, cap_m=None, ref=None, phase=0.0):
        """Cylinder / frustum between two points."""
        p0, p1 = _v(p0), _v(p1)
        r1 = r0 if r1 is None else r1
        d = p1 - p0
        if d.length < 1e-9:
            return
        d.normalize()
        rv = _v(ref) if ref is not None else (Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0)))
        u = d.cross(rv).normalized()
        w = d.cross(u).normalized()
        ring0, ring1 = [], []
        for i in range(sides):
            a = phase + 2 * math.pi * i / sides
            off = u * math.cos(a) + w * math.sin(a)
            ring0.append(p0 + off * r0)
            ring1.append(p1 + off * r1)
        if r0 < 1e-7 or r1 < 1e-7:  # cone
            tip, ring, base_first = (p1, ring0, True) if r1 < 1e-7 else (p0, ring1, False)
            for i in range(sides):
                j = (i + 1) % sides
                tri = [ring[i], ring[j], tip]
                mid = (ring[i] + ring[j]) / 2
                axis_pt = p0 + d * (mid - p0).dot(d)
                self.pdir(tri, m, mid - axis_pt, smooth=False)
            if caps:
                self.pdir(ring, cap_m or m, -d if base_first else d)
            return
        if smooth:
            i0 = self.addv(ring0)
            i1 = self.addv(ring1)
            for i in range(sides):
                j = (i + 1) % sides
                self.fidx([i0[i], i0[j], i1[j], i1[i]], m, True)
        else:
            for i in range(sides):
                j = (i + 1) % sides
                self.poly([ring0[i], ring0[j], ring1[j], ring1[i]], m)
        if caps:
            self.poly(ring1, cap_m or m)
            self.poly(ring0[::-1], cap_m or m)

    def beam(self, p0, p1, w, h, m, up=(0, 1, 0), caps=True):
        """Rectangular bar between two points (w across, h along `up`)."""
        p0, p1 = _v(p0), _v(p1)
        d = p1 - p0
        if d.length < 1e-9:
            return
        d.normalize()
        s = d.cross(_v(up))
        if s.length < 1e-6:
            s = d.cross(Vector((1, 0, 0)))
            if s.length < 1e-6:
                s = d.cross(Vector((0, 0, 1)))
        s.normalize()
        t = s.cross(d).normalized()
        hw, hh = w / 2, h / 2
        cs = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
        r0 = [p0 + s * a + t * b for a, b in cs]
        r1 = [p1 + s * a + t * b for a, b in cs]
        for i in range(4):
            j = (i + 1) % 4
            q = [r0[i], r0[j], r1[j], r1[i]]
            mid = sum(q, Vector()) / 4
            self.pdir(q, m, mid - (p0 + d * (mid - p0).dot(d)))
        if caps:
            self.pdir(r1, m, d)
            self.pdir(r0, m, -d)

    def rope(self, pts, r, m, sides=6, radii=None, caps=False, smooth=True):
        """Tube along a polyline (vines, cords, bent pipes)."""
        P = [_v(p) for p in pts]
        n = len(P)
        tans = []
        for i in range(n):
            if i == 0:
                t = P[1] - P[0]
            elif i == n - 1:
                t = P[-1] - P[-2]
            else:
                t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
            tans.append(t.normalized())
        ref = Vector((0, 1, 0)) if abs(tans[0].y) < 0.9 else Vector((1, 0, 0))
        u = tans[0].cross(ref).normalized()
        rings = []
        for i in range(n):
            t = tans[i]
            u = (u - t * u.dot(t))
            if u.length < 1e-6:
                u = t.cross(ref)
            u.normalize()
            w = t.cross(u).normalized()
            rr = radii[i] if radii else r
            rings.append([P[i] + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * rr
                          for k in range(sides)])
        if smooth:
            idx = [self.addv(rg) for rg in rings]
            for i in range(n - 1):
                for k in range(sides):
                    k2 = (k + 1) % sides
                    self.fidx([idx[i][k], idx[i][k2], idx[i + 1][k2], idx[i + 1][k]], m, True)
        else:
            for i in range(n - 1):
                for k in range(sides):
                    k2 = (k + 1) % sides
                    self.poly([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], m)
        if caps:
            self.poly(rings[-1], m)
            self.poly(rings[0][::-1], m)

    def grid(self, rows, m, smooth=True, wrap_u=False, wrap_v=False, outward=None):
        """Quad grid from rows of points (shared vertices); `m` may be a function (i, j) -> material."""
        R_, C_ = len(rows), len(rows[0])
        idx = [self.addv(r) for r in rows]
        quads = []
        for i in range(R_ - 1 + (1 if wrap_v else 0)):
            i2 = (i + 1) % R_
            for j in range(C_ - 1 + (1 if wrap_u else 0)):
                j2 = (j + 1) % C_
                quads.append((i, j, i2, j2))
        flip = False
        if outward is not None and quads:
            i, j, i2, j2 = quads[0]
            a, b, c, d = (_v(rows[i][j]), _v(rows[i][j2]), _v(rows[i2][j2]), _v(rows[i2][j]))
            if newell([a, b, c, d]).dot(outward((a + c) / 2)) < 0:
                flip = True
        for i, j, i2, j2 in quads:
            q = [idx[i][j], idx[i][j2], idx[i2][j2], idx[i2][j]]
            if flip:
                q.reverse()
            self.fidx(q, m(i, j) if callable(m) else m, smooth)

    def blob(self, c, radii, m, segs=10, rings=6, jitter=0.0, seed=0, smooth=True, floor=None):
        """Lumpy ellipsoid (bags, foliage, crumpled paper). `floor` clamps the bottom (local y)."""
        rnd = random.Random(seed)
        c = _v(c)
        rows = []
        for k in range(1, rings):
            phi = math.pi * k / rings
            row = []
            for i in range(segs):
                th = 2 * math.pi * i / segs
                j = 1.0 + (rnd.uniform(-jitter, jitter) if jitter else 0.0)
                p = Vector((math.sin(phi) * math.cos(th) * radii[0] * j, math.cos(phi) * radii[1] * j,
                            math.sin(phi) * math.sin(th) * radii[2] * j))
                if floor is not None and p.y < floor:
                    p.y = floor
                row.append(c + p)
            rows.append(row)
        top = c + Vector((0, radii[1], 0))
        bot = c + Vector((0, -radii[1] if floor is None else max(-radii[1], floor), 0))

        def outward(p):
            return p - c
        self.grid(rows, m, smooth, wrap_u=True, outward=outward)
        it = self.addv([top])[0]
        ib = self.addv([bot])[0]
        first = self.addv(rows[0])
        last = self.addv(rows[-1])
        for i in range(segs):
            j = (i + 1) % segs
            for tip, ring, pt, row in ((it, first, top, rows[0]), (ib, last, bot, rows[-1])):
                tri = [ring[i], ring[j], tip]
                n = newell([_v(row[i]), _v(row[j]), pt])
                if n.dot((_v(row[i]) + _v(row[j]) + pt) / 3 - c) < 0:
                    tri.reverse()
                self.fidx(tri, m, smooth)

    def torus(self, c, R, r, m, axis=(1, 0, 0), seg=16, sides=6, smooth=True):
        c = _v(c)
        a = _v(axis).normalized()
        ref = Vector((0, 1, 0)) if abs(a.y) < 0.9 else Vector((1, 0, 0))
        e1 = a.cross(ref).normalized()
        e2 = a.cross(e1).normalized()
        rows = []
        for i in range(seg):
            ph = 2 * math.pi * i / seg
            rad = e1 * math.cos(ph) + e2 * math.sin(ph)
            C = c + rad * R
            rows.append([C + (rad * math.cos(2 * math.pi * j / sides) + a * math.sin(2 * math.pi * j / sides)) * r
                         for j in range(sides)])

        def outward(p):
            v = p - c
            radial = v - a * v.dot(a)
            return p - (c + radial.normalized() * R)
        self.grid(rows, m, smooth, wrap_u=True, wrap_v=True, outward=outward)

    def arc_band(self, c, R, a0, a1, x0, x1, m, seg=8, axis="x", outward_sign=1.0):
        """Curved strip (part of a cylinder around `axis` through c). Angles from +y toward +z (axis x)."""
        c = _v(c)
        rows = []
        for i in range(seg + 1):
            t = math.radians(a0 + (a1 - a0) * i / seg)
            if axis == "x":
                rows.append([c + Vector((x0, R * math.cos(t), R * math.sin(t))),
                             c + Vector((x1, R * math.cos(t), R * math.sin(t)))])
            else:  # axis z: angle from +y toward +x
                rows.append([c + Vector((R * math.sin(t), R * math.cos(t), x0)),
                             c + Vector((R * math.sin(t), R * math.cos(t), x1))])

        def outward(p):
            v = p - c
            if axis == "x":
                v.x = 0
            else:
                v.z = 0
            return v * outward_sign
        self.grid(rows, m, smooth=True, outward=outward)

    def disc(self, c, r, m, seg=12, normal="+z"):
        c = _v(c)
        pts = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            if normal in ("+z", "-z"):
                pts.append(c + Vector((r * math.cos(a), r * math.sin(a), 0)))
            elif normal in ("+x", "-x"):
                pts.append(c + Vector((0, r * math.sin(a), r * math.cos(a))))
            else:
                pts.append(c + Vector((r * math.cos(a), 0, r * math.sin(a))))
        want = {"+z": (0, 0, 1), "-z": (0, 0, -1), "+x": (1, 0, 0), "-x": (-1, 0, 0),
                "+y": (0, 1, 0), "-y": (0, -1, 0)}[normal]
        self.pdir(pts, m, want)

    def annulus(self, c, r0, r1, m, seg=16):
        """Flat ring facing +z."""
        c = _v(c)
        for i in range(seg):
            a, b = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
            self.pdir([c + Vector((r0 * math.cos(a), r0 * math.sin(a), 0)), c + Vector((r1 * math.cos(a), r1 * math.sin(a), 0)),
                       c + Vector((r1 * math.cos(b), r1 * math.sin(b), 0)), c + Vector((r0 * math.cos(b), r0 * math.sin(b), 0))],
                      m, (0, 0, 1))

    def dome(self, c, R, h, m, seg=16, rings=3, smooth=True):
        """Shallow spherical cap facing +z (convex mirrors, lamp lenses)."""
        c = _v(c)
        rows = []
        for k in range(rings):
            r = R * (1 - k / rings)
            z = h * (1 - (r / R) ** 2)
            rows.append([c + Vector((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z))
                         for i in range(seg)])
        self.grid(rows, m, smooth, wrap_u=True, outward=lambda p: Vector((0, 0, 1)))
        tip = self.addv([c + Vector((0, 0, h))])[0]
        ring = self.addv(rows[-1])
        for i in range(seg):
            j = (i + 1) % seg
            tri = [ring[i], ring[j], tip]
            n = newell([_v(rows[-1][i]), _v(rows[-1][j]), c + Vector((0, 0, h))])
            if n.z < 0:
                tri.reverse()
            self.fidx(tri, m, smooth)

    def prism(self, poly, axis, a0, a1, m, caps=True, cap_m=None, side_m=None):
        """Extrude a 2D polygon. axis 'x': poly is (z, y); 'y': (x, z); 'z': (x, y).
        side_m(i) gets the index of the edge poly[i] -> poly[i+1] (original order)."""
        def P(u, v, a):
            if axis == "x":
                return Vector((a, v, u))
            if axis == "y":
                return Vector((u, a, v))
            return Vector((u, v, a))
        ad = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}[axis]
        n = len(poly)
        order = list(range(n))
        if newell([P(u, v, a1) for u, v in poly]).dot(ad) < 0:
            order = order[::-1]
        top = [P(poly[i][0], poly[i][1], a1) for i in order]
        bot = [P(poly[i][0], poly[i][1], a0) for i in order]
        for k in range(n):
            k2 = (k + 1) % n
            # original edge index between order[k] and order[k2]
            a, b = order[k], order[k2]
            orig = a if (b == (a + 1) % n) else b
            sm = side_m(orig) if callable(side_m) else (side_m or m)
            self.poly([bot[k], bot[k2], top[k2], top[k]], sm)
        if caps:
            self.poly(top, cap_m or m)
            self.poly(bot[::-1], cap_m or m)

    def pleat(self, x0, x1, y0, y1, n, z0, z1, m):
        """Zig-zag curtain facing +z."""
        xs = [x0 + (x1 - x0) * i / (2 * n) for i in range(2 * n + 1)]
        for i in range(2 * n):
            za, zb = (z0, z1) if i % 2 == 0 else (z1, z0)
            self.pdir([(xs[i], y0, za), (xs[i + 1], y0, zb), (xs[i + 1], y1, zb), (xs[i], y1, za)], m, (0, 0, 1))

    def tile_rows(self, edge, ts, step, m, up=(0, 1, 0), alt=None, alt_fn=None):
        """Stepped surface (tile / clapboard / shutter rows). edge(t) -> (L, R) points; between ts[i] and
        ts[i+1] one row whose lower edge is lifted by `step` along the surface normal."""
        for i in range(len(ts) - 1):
            A, B = (_v(p) for p in edge(ts[i]))
            D, C = (_v(p) for p in edge(ts[i + 1]))
            nrm = (B - A).cross(D - A)
            if nrm.length < 1e-9:
                nrm = (B - A).cross(C - A)
            nrm.normalize()
            if nrm.dot(_v(up)) < 0:
                nrm = -nrm
            down = ((A + B) / 2 - (C + D) / 2).normalized()
            As, Bs = A + nrm * step, B + nrm * step
            mm = alt_fn(i) if alt_fn else m
            if mm is None:
                mm = m
            if (C - D).length < 1e-6:
                self.pdir([As, Bs, C], mm, nrm)
            else:
                self.pdir([As, Bs, C, D], mm, nrm)
            if (B - A).length > 1e-6:
                self.pdir([A, B, Bs, As], mm, down)

    def corrugate(self, origin, udir, vdir, ulen, vlen, pitch, amp, m, nrm, mfn=None, vtop=None, vbot=None):
        """Corrugated sheet: ribs run along v, the zig-zag profile runs along u."""
        o, U, Vd, N = _v(origin), _v(udir).normalized(), _v(vdir).normalized(), _v(nrm).normalized()
        n = max(2, int(round(ulen / (pitch / 2))))
        us = [ulen * k / n for k in range(n + 1)]

        def P(u, v, k):
            return o + U * u + Vd * v + N * (amp if k % 2 else 0.0)
        for k in range(n):
            u0, u1 = us[k], us[k + 1]
            t0 = vlen if vtop is None else vtop(u0)
            t1 = vlen if vtop is None else vtop(u1)
            b0 = 0.0 if vbot is None else vbot(u0)
            b1 = 0.0 if vbot is None else vbot(u1)
            mm = mfn(k) if mfn else m
            self.pdir([P(u0, b0, k), P(u1, b1, k + 1), P(u1, t1, k + 1), P(u0, t0, k)], mm, N)

    def stripes(self, x0, x1, y0, y1, z, width, mA, mB, k=1.0, facing=1):
        """Diagonal two-colour stripes on a rectangle in a z-plane (facing +z or -z)."""
        for poly, i in stripes2d(x0, x1, y0, y1, width, k):
            self.pdir([(x, y, z) for x, y in poly], mA if i % 2 == 0 else mB, (0, 0, facing))

    # ── output ───────────────────────────────────────────────────────────────
    def build(self, name, parent=None):
        me = bpy.data.meshes.new(name)
        me.from_pydata([(v.x, -v.z, v.y) for v in self.verts], [], [f[0] for f in self.faces])
        for mt in self.mats:
            me.materials.append(mt)
        has_uv = any(f[3] for f in self.faces)
        uvl = me.uv_layers.new(name="UVMap") if has_uv else None
        for i, p in enumerate(me.polygons):
            f = self.faces[i]
            p.material_index = f[1]
            p.use_smooth = f[2]
            if uvl is not None:
                for k, li in enumerate(p.loop_indices):
                    uvl.data[li].uv = f[3][k] if f[3] else (0.0, 0.0)
        me.update()
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            set_parent(obj, parent)
        return obj


def M(name, color, rough=0.8, metal=0.0, emit=None):
    """Material shortcut; emit_* materials get their glow colour at strength 1 (three.js scales it)."""
    return mat(name, color, rough, metal, emit=emit, emit_strength=1.0)


# ═══════════════════════════════════════════════════════════════════════════
#  debug renders
# ═══════════════════════════════════════════════════════════════════════════
def extra_views(model_id):
    out = os.environ.get("KAO_VIEWS")
    if not out:
        return
    os.makedirs(out, exist_ok=True)
    scn = bpy.context.scene
    mn, mx = bounds_three()
    c = [(mn[i] + mx[i]) / 2 for i in range(3)]
    ext = max(mx[i] - mn[i] for i in range(3)) or 1.0
    views = {
        "back": ((c[0] - ext * 1.1, c[1] + ext * 0.6, c[2] - ext * 1.6), c, 40),
        "left": ((c[0] - ext * 1.9, c[1] + ext * 0.25, c[2] + ext * 0.6), c, 40),
        "low": ((c[0] + ext * 0.3, max(mn[1] + 0.3, min(1.6, c[1])), c[2] + ext * 1.7), c, 40),
        "front": ((c[0], c[1] + ext * 0.1, c[2] + ext * 2.0), c, 40),
    }
    # custom cameras: KAO_CAM="name:ex,ey,ez:tx,ty,tz:lens;..."
    for spec in filter(None, os.environ.get("KAO_CAM", "").split(";")):
        nm, e3, t3, ln = spec.split(":")
        views[nm] = (tuple(float(v) for v in e3.split(",")), tuple(float(v) for v in t3.split(",")), float(ln))
    if os.environ.get("KAO_CAM_ONLY"):
        views = {k: v for k, v in views.items() if k not in ("back", "left", "low", "front")}
    # glass drawn see-through in the debug renders (three.js renders it at 22% opacity)
    for m in bpy.data.materials:
        if m.name.startswith("glass"):
            col = list(m.diffuse_color)
            m.diffuse_color = (col[0], col[1], col[2], 0.12)
            if hasattr(m, "surface_render_method"):
                m.surface_render_method = "BLENDED"
            if hasattr(m, "blend_method"):
                m.blend_method = "BLEND"
    for name, (eye, tgt3, lens) in views.items():
        cam_data = bpy.data.cameras.new("vcam")
        cam = bpy.data.objects.new("vcam", cam_data)
        scn.collection.objects.link(cam)
        e, tgt = T(*eye), T(*tgt3)
        cam.rotation_euler = (tgt - e).to_track_quat("-Z", "Y").to_euler()
        cam.location = e
        cam_data.lens = lens
        cam_data.clip_start = 0.01
        scn.camera = cam
        scn.render.engine = "BLENDER_WORKBENCH"
        scn.display.shading.light = "STUDIO"
        scn.display.shading.color_type = "MATERIAL"
        scn.render.resolution_x = 420
        scn.render.resolution_y = 420
        scn.render.filepath = os.path.join(out, f"{model_id}_{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


# ═══════════════════════════════════════════════════════════════════════════
#  window_ext — exterior aluminium window of コーポ月見 (sits flat on the wall)
# ═══════════════════════════════════════════════════════════════════════════
def build_window_ext():
    alu = M("alu", "#b3b7ba", 0.35, 0.6)
    alu_dk = M("alu_dark", "#7a7e81", 0.45, 0.5)
    glass = M("glass", "#a9c2cc", 0.05)
    cur = M("emit_window", "#b7a584", 0.9, emit="#ffc887")
    room = M("room_dark", "#15130f", 1.0)
    lock = M("lock", "#cfd2d4", 0.3, 0.7)
    mb = MB()
    # outer frame (the wall face is at z = -0.005 in the layout, everything visible is in front of it)
    mb.bb(-0.85, 0.85, 1.25, 1.3, -0.06, 0.045, alu)
    mb.bb(-0.85, 0.85, 0.03, 0.08, -0.06, 0.045, alu)
    mb.bb(-0.85, -0.8, 0.08, 1.25, -0.06, 0.045, alu)
    mb.bb(0.8, 0.85, 0.08, 1.25, -0.06, 0.045, alu)
    mb.bb(-0.85, 0.85, 0.0, 0.03, -0.06, 0.06, alu_dk)                    # 水切り
    # dark room, curtain rail and two pleated curtain panels with a thin gap
    mb.pdir([(-0.8, 0.08, 0.001), (0.8, 0.08, 0.001), (0.8, 1.25, 0.001), (-0.8, 1.25, 0.001)], room, (0, 0, 1))
    mb.pleat(-0.8, -0.012, 0.1, 1.215, 7, 0.005, 0.013, cur)
    mb.pleat(0.012, 0.8, 0.1, 1.215, 7, 0.005, 0.013, cur)
    mb.bb(-0.8, 0.8, 1.212, 1.25, 0.0, 0.016, room)
    # inner sash (right pane) and outer sash (left pane), 引き違い
    for (x0, x1, z0, z1, mx0, mx1) in ((-0.03, 0.8, 0.016, 0.028, -0.03, 0.005), (-0.8, 0.03, 0.03, 0.042, -0.005, 0.03)):
        mb.bb(x0, x1, 1.215, 1.25, z0, z1, alu)
        mb.bb(x0, x1, 0.08, 0.115, z0, z1, alu)
        mb.bb(mx0, mx1, 0.115, 1.215, z0, z1 + 0.004, alu)
        side = (x1 - 0.03, x1) if x1 > 0.5 else (x0, x0 + 0.03)
        mb.bb(side[0], side[1], 0.115, 1.215, z0, z1, alu)
        gx0, gx1 = (mx1, x1 - 0.03) if x1 > 0.5 else (x0 + 0.03, mx0)
        gz = (z0 + z1) / 2
        mb.pdir([(gx0, 0.115, gz), (gx1, 0.115, gz), (gx1, 1.215, gz), (gx0, 1.215, gz)], glass, (0, 0, 1))
    mb.bb(0.003, 0.02, 0.63, 0.69, 0.043, 0.05, lock)                     # クレセント錠
    mb.build("window_ext")


# ═══════════════════════════════════════════════════════════════════════════
#  fluorescent_light — corridor ceiling fixture, origin = centre of the top face, hangs down
# ═══════════════════════════════════════════════════════════════════════════
def build_fluorescent_light():
    body = M("fl_body", "#e2e0d7", 0.55)
    dirty = M("fl_body_dirty", "#b9b29c", 0.85)
    tube_m = M("emit_tube", "#eef0ea", 0.3, emit="#eafff2")
    sock = M("fl_socket", "#d3d0c4", 0.5)
    bug = M("fl_bug", "#14110d", 0.7)
    moth = M("fl_moth", "#5b4b37", 0.95)
    screw = M("fl_screw", "#9a9c9c", 0.4, 0.7)
    mb = MB()
    # body: inverted trapezoid along x (逆富士)
    mb.prism([(-0.07, 0.0), (0.07, 0.0), (0.045, -0.042), (-0.045, -0.042)], "x", -0.31, 0.31, body,
             side_m=lambda i: dirty if i == 2 else body)
    mb.tube((-0.28, -0.075, 0.0), (0.28, -0.075, 0.0), 0.0135, tube_m, sides=10)
    for sx in (-1, 1):
        mb.cbox((0.03, 0.058, 0.044), (sx * 0.293, -0.071, 0.0), sock, 0.004)
        mb.tube((sx * 0.2, -0.0425, 0.0), (sx * 0.2, -0.045, 0.0), 0.006, screw, sides=6, smooth=False)
    # insects stuck on the tube and dead ones on the reflector
    rnd = random.Random(7)
    for x, ang in ((-0.21, 200), (-0.12, 250), (-0.03, 300), (0.05, 220), (0.09, 270), (0.16, 320), (0.23, 240)):
        a = math.radians(ang)
        r = 0.0142
        p = (x, -0.075 + r * math.sin(a), r * math.cos(a))
        with mb.at(p, ry=rnd.uniform(-40, 40), rx=-math.degrees(a) + 90):
            mb.bb(-0.006, 0.006, -0.0015, 0.0015, -0.0035, 0.0035, bug)
    for x, z in ((-0.17, 0.02), (0.02, -0.025), (0.21, 0.015)):
        mb.bb(x - 0.005, x + 0.005, -0.0445, -0.0425, z - 0.003, z + 0.003, bug)
    # a moth spread on the underside
    mx, mz = 0.12, 0.012
    mb.pdir([(mx, -0.0435, mz), (mx - 0.018, -0.0435, mz + 0.012), (mx - 0.014, -0.0435, mz - 0.008)], moth, (0, -1, 0))
    mb.pdir([(mx, -0.0435, mz), (mx + 0.014, -0.0435, mz - 0.008), (mx + 0.018, -0.0435, mz + 0.012)], moth, (0, -1, 0))
    mb.build("fluorescent_light")


# ═══════════════════════════════════════════════════════════════════════════
#  mailbox_set — 集合ポスト 4x2 on legs
# ═══════════════════════════════════════════════════════════════════════════
def build_mailbox_set():
    body = M("mb_body", "#8e9498", 0.45, 0.35)
    door = M("mb_door", "#a7adb1", 0.4, 0.35)
    slot = M("mb_slot", "#121314", 0.85)
    dial = M("mb_dial", "#1d1e20", 0.5, 0.2)
    ring = M("mb_ring", "#c9ccce", 0.3, 0.8)
    leg = M("mb_leg", "#4b4f52", 0.55, 0.4)
    rust = M("mb_rust", "#6d5242", 0.95)
    tape = M("mb_tape", "#e0d3a3", 0.9)
    papers = [M("mb_paper_white", "#e9e7df", 0.9), M("mb_paper_yellow", "#e5cd56", 0.9),
              M("mb_paper_red", "#c94a3a", 0.9), M("mb_paper_blue", "#7a9fd0", 0.9)]
    mb = MB()
    mb.cbox((0.9, 0.79, 0.33), (0.0, 0.995, -0.01), body, 0.008)          # box y 0.6..1.39, z -0.175..0.155
    mb.cbox((0.9, 0.014, 0.35), (0.0, 1.393, 0.0), leg, 0.004)              # top lid
    w, h, g = 0.2075, 0.375, 0.01
    cols = [-0.45 + 0.02 + w / 2 + k * (w + g) for k in range(4)]
    rows = [0.6 + 0.02 + h / 2 + r * (h + g) for r in range(2)]
    for r, cy in enumerate(rows):
        for k, cx in enumerate(cols):
            num = f"{r + 1}0{k + 1}"
            mb.bb(cx - w / 2 + 0.004, cx + w / 2 - 0.004, cy - h / 2 + 0.004, cy + h / 2 - 0.004, 0.155, 0.166, door)
            sy = cy + 0.12
            mb.bb(cx - 0.07, cx + 0.07, sy - 0.011, sy + 0.011, 0.166, 0.168, slot)
            mb.bb(cx - 0.076, cx + 0.076, sy + 0.011, sy + 0.021, 0.166, 0.176, door)        # flap hood
            mb.tube((cx + 0.055, cy - 0.1, 0.166), (cx + 0.055, cy - 0.1, 0.179), 0.017, dial, sides=10, smooth=False)
            mb.tube((cx + 0.055, cy - 0.1, 0.166), (cx + 0.055, cy - 0.1, 0.17), 0.022, ring, sides=10, smooth=False)
            mb.bb(cx + 0.053, cx + 0.057, cy - 0.088, cy - 0.08, 0.179, 0.181, ring)               # dial index
            pm = M(f"tex_plate_{num}", "#e9e4d4", 0.6)
            mb.bb(cx - 0.083, cx - 0.017, cy - 0.118, cy - 0.082, 0.166, 0.168, ring)             # plate frame
            mb.quad_uv((cx - 0.08, cy - 0.115, 0.1685), (cx - 0.02, cy - 0.115, 0.1685),
                       (cx - 0.02, cy - 0.085, 0.1685), (cx - 0.08, cy - 0.085, 0.1685), pm)
            if num == "103":  # protagonist's box: stuffed with flyers
                for i, (dx, rz, rx, pm2) in enumerate(((-0.03, 4, -40, papers[0]), (0.01, -6, -55, papers[1]),
                                                      (0.035, 9, -35, papers[2]), (-0.005, -2, -65, papers[3]))):
                    with mb.at((cx + dx, sy + 0.004 + i * 0.002, 0.158), rx=rx, rz=rz):
                        mb.bb(-0.055, 0.055, -0.0012, 0.0012, 0.0, 0.026 + i * 0.004, pm2)
            if num == "201":
                with mb.at((cx + 0.01, sy, 0.16), rx=-50, rz=-5):
                    mb.bb(-0.05, 0.05, -0.001, 0.001, 0.0, 0.026, papers[0])
            if num == "204":  # vacant: slot taped shut
                with mb.at((cx, sy, 0.1765), rz=3):
                    mb.bb(-0.085, 0.085, -0.018, 0.018, 0.0, 0.002, tape)
    # rust stains along the bottom edge and under a slot
    for x0, x1, y0, y1 in ((-0.43, -0.3, 0.6, 0.62), (0.12, 0.33, 0.6, 0.618), (-0.2, -0.17, 0.83, 0.9)):
        mb.pdir([(x0, y0, 0.1562), (x1, y0, 0.1562), (x1, y1, 0.1562), (x0, y1, 0.1562)], rust, (0, 0, 1))
    mb.pdir([(0.4505, 0.61, -0.12), (0.4505, 0.61, 0.1), (0.4505, 0.66, 0.06), (0.4505, 0.66, -0.08)], rust, (1, 0, 0))
    # legs, feet and a brace
    for sx in (-1, 1):
        mb.bb(sx * 0.36 - 0.02, sx * 0.36 + 0.02, 0.0, 0.605, -0.09, -0.05, leg)
        mb.bb(sx * 0.36 - 0.06, sx * 0.36 + 0.06, 0.0, 0.008, -0.14, 0.0, leg)
    mb.bb(-0.34, 0.34, 0.12, 0.15, -0.08, -0.06, leg)
    mb.build("mailbox_set")


# ═══════════════════════════════════════════════════════════════════════════
#  ext_stairs — steel outdoor stair, bottom step at +z, top at -z (meets the 2F corridor slab)
# ═══════════════════════════════════════════════════════════════════════════
def build_ext_stairs():
    paint = M("st_paint", "#4a3226", 0.6, 0.35)
    worn = M("st_paint_worn", "#5d4436", 0.75, 0.3)
    rust = M("st_rust", "#7c4a2a", 0.95, 0.1)
    tread = M("st_tread", "#55463c", 0.65, 0.3)
    nosing = M("st_nosing", "#8b867b", 0.5, 0.5)
    conc = M("st_concrete", "#8f8d87", 0.95)
    mb = MB()
    n = 13
    run = 4.1 / n
    s = 0.2 / run

    def yt(z):  # top edge of the side stringer
        return 0.26 + (2.4 - z) * s
    for k in range(1, n + 1):
        zf = 2.4 - (k - 1) * run
        zb = zf - run - 0.02
        y = 0.2 * k
        mb.bb(-0.55, 0.55, y - 0.032, y, zb, zf, tread)
        mb.bb(-0.55, 0.55, y - 0.085, y - 0.032, zf - 0.008, zf, tread)       # pan lip
        mb.bb(-0.53, 0.53, y, y + 0.006, zf - 0.045, zf - 0.004, rust if k in (1, 2, 6) else nosing)
    # stringers (ささら桁)
    zfoot = 2.4 - 0.06 / s
    poly = [(2.5, 0.0), (2.5, yt(2.5)), (-1.7, yt(-1.7)), (-1.7, yt(-1.7) - 0.32), (zfoot, 0.0)]
    for x0, x1 in ((0.55, 0.6), (-0.6, -0.55)):
        mb.prism(poly, "x", x0, x1, paint, side_m=lambda i: worn if i == 1 else paint)
    # rust patches on the outer faces (parallelograms following the stringer)
    for sx in (-1, 1):
        for z0, z1, a, b in ((2.35, 1.75, 0.06, 0.22), (0.4, 0.1, 0.03, 0.13), (-1.2, -1.55, 0.18, 0.3)):
            pts = [(sx * 0.6005, yt(z0) - b, z0), (sx * 0.6005, yt(z1) - b, z1), (sx * 0.6005, yt(z1) - a, z1),
                   (sx * 0.6005, yt(z0) - a, z0)]
            if z0 > 2.3:
                pts[0] = (sx * 0.6005, max(0.01, yt(z0) - b), z0)
            mb.pdir(pts, rust, (sx, 0, 0))
    # footing, landing beam and support posts
    mb.bb(-0.6, 0.6, 0.0, 0.05, 2.15, 2.5, conc)
    mb.bb(-0.6, 0.6, 2.44, 2.6, -1.8, -1.68, paint)
    for sx in (-1, 1):
        mb.bb(sx * 0.555 - 0.04, sx * 0.555 + 0.04, 0.0, 2.44, -1.66, -1.58, paint)
        mb.bb(sx * 0.545 - 0.055, sx * 0.545 + 0.055, 0.0, 0.012, -1.69, -1.55, rust)
    # handrails: posts, top + mid rails and balusters on both sides; the west side continues on the landing
    rail_h, mid_h = 0.85, 0.42
    z_top = -1.68
    for sx in (-1, 1):
        x = sx * 0.575
        for zp in (2.38, 1.35, 0.3, -0.72, z_top):
            mb.bb(x - 0.02, x + 0.02, yt(zp) - 0.02, yt(zp) + rail_h, zp - 0.02, zp + 0.02, paint)
        mb.tube((x, yt(2.4) + rail_h, 2.4), (x, yt(z_top) + rail_h, z_top), 0.022, paint, sides=8, caps=True)
        mb.tube((x, yt(2.4) + mid_h, 2.4), (x, yt(z_top) + mid_h, z_top), 0.012, paint, sides=6, caps=False)
        zb = 2.25
        while zb > z_top + 0.05:
            mb.bb(x - 0.009, x + 0.009, yt(zb) - 0.01, yt(zb) + rail_h - 0.02, zb - 0.009, zb + 0.009, paint)
            zb -= 0.15
    x = -0.575
    yl = yt(z_top) + rail_h
    mb.tube((x, yl, z_top), (x, yl, -2.48), 0.022, paint, sides=8)
    mb.tube((x, 2.8 + mid_h, z_top), (x, 2.8 + mid_h, -2.48), 0.012, paint, sides=6, caps=False)
    mb.bb(x - 0.02, x + 0.02, 2.8, yl, -2.5, -2.46, paint)
    zb = -1.85
    while zb > -2.45:
        mb.bb(x - 0.009, x + 0.009, 2.8, yl - 0.02, zb - 0.009, zb + 0.009, paint)
        zb -= 0.15
    mb.build("ext_stairs")


# ═══════════════════════════════════════════════════════════════════════════
#  vending_machine — white / blue drink machine, no logos
# ═══════════════════════════════════════════════════════════════════════════
def build_vending_machine():
    white = M("vm_white", "#e8ebed", 0.35, 0.1)
    blue = M("vm_blue", "#1f5cb2", 0.4, 0.15)
    grey = M("vm_grey", "#5c6165", 0.5, 0.3)
    dark = M("vm_dark", "#15171a", 0.6)
    silver = M("vm_silver", "#c2c6c9", 0.25, 0.8)
    flap = M("vm_flap", "#2a2f35", 0.25)
    backlit = M("emit_vending", "#e5ecf1", 0.4, emit="#f2f7ff")
    glass = M("glass", "#cfe0ea", 0.05)
    led = M("emit_led", "#3a0a06", 0.4, emit="#ff4a24")
    btn = M("vm_button", "#dce8f2", 0.3)
    label = M("vm_label", "#f3f3ec", 0.6)
    sticker = M("vm_sticker", "#e7c63a", 0.7)
    pet = M("vm_pet", "#c9dbe3", 0.15)
    capw = M("vm_cap_white", "#f1f1ee", 0.4)
    can_top = M("vm_can_top", "#b9bdc0", 0.25, 0.8)
    cols = ["#c8282a", "#2a62c8", "#eceae2", "#2e7a3a", "#f0a020", "#3a2a20", "#e6d24a", "#7a2a6a",
            "#d8d8d8", "#1a1a1a", "#7ab8e0", "#b84a28"]
    sample_m = [M(f"vm_sample_{i}", c, 0.35, 0.25) for i, c in enumerate(cols)]
    mb = MB()
    # cabinet (behind the display cavity) and plinth
    mb.cbox((1.0, 1.8, 0.49), (0.0, 0.93, -0.115), white, 0.012)
    mb.bb(-0.48, 0.48, 0.0, 0.03, -0.33, 0.3, grey)
    for sx in (-1, 1):  # blue side stripes
        mb.pdir([(sx * 0.5008, 0.05, 0.02), (sx * 0.5008, 0.05, 0.12), (sx * 0.5008, 1.79, 0.12), (sx * 0.5008, 1.79, 0.02)],
                blue, (sx, 0, 0))
    # door pieces around the display window
    mb.bb(-0.5, 0.5, 1.62, 1.83, 0.13, 0.33, blue)                        # header
    mb.bb(-0.47, 0.47, 1.69, 1.705, 0.33, 0.334, white)
    mb.bb(-0.5, 0.5, 0.03, 0.96, 0.13, 0.33, white)                       # lower door
    mb.bb(-0.5, -0.45, 0.96, 1.62, 0.13, 0.33, white)
    mb.bb(0.45, 0.5, 0.96, 1.62, 0.13, 0.33, white)
    mb.pdir([(-0.45, 0.96, 0.131), (0.45, 0.96, 0.131), (0.45, 1.62, 0.131), (-0.45, 1.62, 0.131)], backlit, (0, 0, 1))
    mb.pdir([(-0.45, 1.62, 0.131), (0.45, 1.62, 0.131), (0.45, 1.62, 0.33), (-0.45, 1.62, 0.33)], white, (0, -1, 0))
    rnd = random.Random(11)
    for r, yr in enumerate((0.96, 1.18, 1.40)):
        mb.bb(-0.45, 0.45, yr, yr + 0.035, 0.13, 0.33, white)             # button strip
        mb.bb(-0.45, 0.45, yr + 0.03, yr + 0.035, 0.131, 0.3, white)       # shelf
        mb.pdir([(-0.45, yr + 0.035, 0.335), (0.45, yr + 0.035, 0.335), (0.45, yr + 0.22, 0.335),
                 (-0.45, yr + 0.22, 0.335)], glass, (0, 0, 1))
        for k in range(8):
            cx = -0.385 + k * 0.11
            sold = (r, k) in ((0, 5), (2, 1))
            mb.bb(cx - 0.034, cx + 0.034, yr + 0.009, yr + 0.026, 0.33, 0.341, led if sold else btn)
            mb.bb(cx - 0.03, cx + 0.03, yr + 0.028, yr + 0.033, 0.33, 0.332, label)
            col = sample_m[(r * 5 + k * 3 + rnd.randint(0, 3)) % len(sample_m)]
            y0 = yr + 0.035
            zc = 0.235
            if (k + r) % 3 == 1:   # PET bottle
                mb.tube((cx, y0, zc), (cx, y0 + 0.03, zc), 0.032, pet, sides=8, caps=False)
                mb.tube((cx, y0 + 0.03, zc), (cx, y0 + 0.1, zc), 0.0335, col, sides=8, caps=False)
                mb.tube((cx, y0 + 0.1, zc), (cx, y0 + 0.125, zc), 0.032, pet, sides=8, caps=False)
                mb.tube((cx, y0 + 0.125, zc), (cx, y0 + 0.155, zc), 0.032, pet, r1=0.013, sides=8, caps=False)
                mb.tube((cx, y0 + 0.155, zc), (cx, y0 + 0.175, zc), 0.014, capw if k % 2 else col, sides=8)
            else:                   # can
                hgt = 0.12 if k % 2 else 0.105
                mb.tube((cx, y0, zc), (cx, y0 + hgt, zc), 0.031, col, sides=8, caps=False)
                mb.tube((cx, y0 + hgt, zc), (cx, y0 + hgt + 0.008, zc), 0.031, can_top, r1=0.026, sides=8)
    # money panel (right), outlet (bottom), stickers
    mb.bb(0.22, 0.44, 0.6, 0.93, 0.33, 0.336, silver)
    mb.bb(0.25, 0.41, 0.865, 0.905, 0.336, 0.341, led)                     # LED price/credit display
    mb.bb(0.33, 0.38, 0.76, 0.84, 0.336, 0.343, grey)
    mb.bb(0.351, 0.359, 0.775, 0.825, 0.343, 0.345, dark)                  # coin slot
    mb.bb(0.245, 0.41, 0.685, 0.725, 0.336, 0.346, dark)                   # bill slot
    mb.bb(0.25, 0.3, 0.765, 0.835, 0.336, 0.352, silver)                   # return lever
    mb.bb(0.3, 0.41, 0.615, 0.665, 0.336, 0.352, dark)                     # coin return cup
    mb.bb(0.244, 0.306, 0.61, 0.67, 0.336, 0.34, dark)                     # e-money reader pad
    mb.bb(-0.41, 0.16, 0.11, 0.41, 0.33, 0.352, grey)                      # 取り出し口 frame
    mb.bb(-0.38, 0.13, 0.14, 0.38, 0.352, 0.36, flap)
    mb.bb(-0.2, 0.0, 0.355, 0.37, 0.36, 0.365, silver)                      # flap grip
    mb.bb(-0.5, 0.5, 0.03, 0.1, 0.33, 0.336, blue)
    mb.bb(-0.42, -0.3, 0.5, 0.56, 0.33, 0.333, sticker)
    mb.bb(-0.26, -0.04, 0.47, 0.58, 0.33, 0.333, label)
    for i in range(4):
        mb.bb(-0.24, -0.08 - (i % 2) * 0.04, 0.55 - i * 0.022, 0.556 - i * 0.022, 0.333, 0.335, dark)
    mb.bb(0.42, 0.45, 1.2, 1.26, 0.33, 0.336, silver)                      # door lock
    # back: louvres and the power cord
    for i in range(6):
        mb.bb(-0.3, 0.3, 0.2 + i * 0.05, 0.22 + i * 0.05, -0.366, -0.36, grey)
    mb.tube((0.38, 0.18, -0.362), (0.38, 0.0, -0.362), 0.008, dark, sides=6)
    mb.build("vending_machine")


# ═══════════════════════════════════════════════════════════════════════════
#  bulletin_board — 町内会の掲示板 (felt surface at z = +0.06, posters are added by three.js)
# ═══════════════════════════════════════════════════════════════════════════
def build_bulletin_board():
    wood = M("bb_post", "#5b4431", 0.85)
    frame = M("bb_frame", "#6d5138", 0.8)
    felt = M("bb_felt", "#2f5a3c", 1.0)
    tin = M("bb_tin", "#7d4a33", 0.6, 0.35)
    tin_r = M("bb_tin_rust", "#5c3825", 0.9, 0.2)
    plate = M("bb_plate", "#e7e5db", 0.6)
    ink = M("bb_ink", "#23211d", 0.8)
    scrap = M("bb_scrap", "#d8d1bb", 0.9)
    scrap2 = M("bb_scrap_old", "#c2b78c", 0.95)
    pin_r = M("bb_pin_red", "#c0302a", 0.4)
    pin_b = M("bb_pin_blue", "#2a52b0", 0.4)
    conc = M("bb_concrete", "#8a8882", 0.95)
    mb = MB()
    for sx in (-1, 1):
        mb.bb(sx * 0.82 - 0.045, sx * 0.82 + 0.045, 0.0, 2.06, -0.115, -0.025, wood)
        mb.bb(sx * 0.82 - 0.08, sx * 0.82 + 0.08, 0.0, 0.06, -0.15, 0.01, conc)
        mb.beam((sx * 0.82, 1.92, -0.03), (sx * 0.82, 1.985, 0.125), 0.04, 0.035, wood)   # roof bracket
    mb.bb(-0.9, 0.9, 1.0, 1.9, -0.025, 0.045, frame)                      # backing board
    mb.bb(-0.86, 0.86, 1.04, 1.86, 0.045, 0.06, felt)                     # felt, front face at z = 0.06
    mb.bb(-0.9, 0.9, 1.86, 1.9, 0.045, 0.072, frame)
    mb.bb(-0.9, 0.9, 1.0, 1.04, 0.045, 0.072, frame)
    mb.bb(-0.9, -0.86, 1.04, 1.86, 0.045, 0.072, frame)
    mb.bb(0.86, 0.9, 1.04, 1.86, 0.045, 0.072, frame)
    mb.bb(-0.9, 0.9, 0.985, 1.0, 0.0, 0.1, frame)                         # little ledge
    mb.bb(-0.24, 0.24, 1.866, 1.936, 0.072, 0.078, plate)                 # 町内会 header plate
    for i in range(6):
        cx = -0.175 + i * 0.07
        mb.bb(cx - 0.022, cx + 0.022, 1.883, 1.919, 0.078, 0.0795, ink)
    # roof frame
    mb.bb(-0.92, 0.92, 2.0, 2.06, -0.12, -0.03, wood)
    mb.bb(-0.92, 0.92, 1.955, 1.985, 0.1, 0.13, wood)
    # corrugated tin roof sloping to the front
    yb, yf, zb_, zf_ = 2.13, 1.99, -0.15, 0.15
    vd = Vector((0, yf - yb, zf_ - zb_))
    vlen = vd.length
    nrm = Vector((0, zf_ - zb_, -(yf - yb))).normalized()
    rnd = random.Random(5)
    rust_set = {k for k in range(60) if rnd.random() < 0.18}
    mb.corrugate((-0.95, yb, zb_), (1, 0, 0), vd, 1.9, vlen, 0.09, 0.014, tin, nrm,
                 mfn=lambda k: tin_r if k in rust_set else tin)
    # old scraps of paper, pins
    for x, y, w, h, m in ((-0.41, 1.78, 0.06, 0.05, scrap), (0.43, 1.12, 0.05, 0.07, scrap2), (0.0, 1.06, 0.08, 0.03, scrap2),
                          (-0.83, 1.47, 0.04, 0.09, scrap), (0.82, 1.62, 0.035, 0.06, scrap2)):
        mb.pdir([(x - w / 2, y - h / 2, 0.0605), (x + w / 2, y - h / 2, 0.0605), (x + w / 2, y + h / 2, 0.0605),
                 (x - w / 2, y + h / 2, 0.0605)], m, (0, 0, 1))
    for x, y, m in ((-0.41, 1.8, pin_r), (0.43, 1.15, pin_b), (-0.83, 1.5, pin_r), (0.03, 1.07, pin_b), (-0.02, 1.83, pin_r),
                    (0.6, 1.45, pin_b), (-0.6, 1.08, pin_r)):
        mb.bb(x - 0.005, x + 0.005, y - 0.005, y + 0.005, 0.06, 0.068, m)
    mb.build("bulletin_board")


# ═══════════════════════════════════════════════════════════════════════════
#  curve_mirror — orange pole + round convex mirror (centre y = 2.6, tilted down)
# ═══════════════════════════════════════════════════════════════════════════
def build_curve_mirror():
    orange = M("cm_orange", "#e2661f", 0.5, 0.1)
    orange_dk = M("cm_orange_dark", "#a8481a", 0.6, 0.1)
    mirror = M("mirror", "#9aa2a8", 0.1, 0.9)
    steel = M("cm_steel", "#9a9ea0", 0.4, 0.6)
    conc = M("cm_concrete", "#85837d", 0.95)
    white = M("cm_plate", "#ecebe6", 0.5)
    ink = M("cm_ink", "#222222", 0.8)
    refl = M("cm_reflector", "#d8d8d2", 0.3, 0.3)
    pz = -0.085
    pole = MB()
    pole.tube((0, 0.0, pz), (0, 2.78, pz), 0.038, orange, sides=10)
    pole.tube((0, 2.78, pz), (0, 2.81, pz), 0.041, orange_dk, r1=0.02, sides=10, smooth=False)
    pole.tube((0, 0.0, pz), (0, 0.04, pz), 0.06, conc, r1=0.05, sides=8, smooth=False)
    pole.tube((0, 0.9, pz), (0, 1.15, pz), 0.0395, refl, sides=10, caps=False)         # 反射帯
    pole.bb(-0.035, 0.035, 1.42, 1.58, pz + 0.038, pz + 0.042, white)                    # 管理番号
    for i in range(3):
        pole.bb(-0.022, 0.022 - i * 0.01, 1.53 - i * 0.035, 1.545 - i * 0.035, pz + 0.042, pz + 0.044, ink)
    p = pole.build("pole")

    head = MB()
    for y in (2.47, 2.73):
        head.tube((0, y - 0.02, pz), (0, y + 0.02, pz), 0.047, steel, sides=10, smooth=False)
    head.bb(-0.035, 0.035, 2.54, 2.66, pz, -0.03, steel)                                  # bracket arm
    with head.at((0, 2.6, 0.0), rx=8):
        head.tube((0, 0, -0.045), (0, 0, 0.02), 0.345, orange, sides=20, caps=False)      # rim band
        head.annulus((0, 0, 0.02), 0.298, 0.345, orange, seg=20)
        head.tube((0, 0, -0.045), (0, 0, -0.07), 0.345, orange_dk, r1=0.16, sides=20, caps=True, smooth=True)
        head.dome((0, 0, 0.012), 0.3, 0.036, mirror, seg=20, rings=3)
        head.arc_band((0, 0, 0), 0.352, -78, 78, 0.0, 0.11, orange, seg=10, axis="z")      # hood
        head.bb(-0.04, 0.04, -0.06, 0.06, -0.09, -0.068, steel)                            # back plate
    head.build("mirror_head")


# ═══════════════════════════════════════════════════════════════════════════
#  utility_pole — concrete pole with street lamp, crossarm, insulators and a transformer
# ═══════════════════════════════════════════════════════════════════════════
def build_utility_pole():
    conc = M("up_concrete", "#a3a19a", 0.9)
    dirty = M("up_concrete_dirty", "#77746c", 0.95)
    steel = M("up_steel", "#8d9193", 0.45, 0.6)
    porcelain = M("up_insulator", "#ebebe3", 0.25)
    trans = M("up_transformer", "#a2a7a9", 0.45, 0.35)
    black = M("up_black", "#1b1c1e", 0.6)
    yel = M("up_yellow", "#e5be1c", 0.55)
    blk = M("up_stripe_black", "#18181a", 0.6)
    housing = M("up_lamp_housing", "#d3d5d1", 0.45, 0.2)
    lamp = M("emit_lamp", "#cfd7de", 0.3, emit="#e6efff")
    sign = M("tex_pole_sign", "#1f4fa0", 0.6)
    band = M("up_band", "#c4c7c9", 0.3, 0.8)
    plate = M("up_plate", "#dfe3e4", 0.4, 0.5)
    ink = M("up_ink", "#2a2a2a", 0.8)
    spool = M("up_spool", "#4a3a32", 0.4)
    R0, R1, H = 0.15, 0.095, 9.0

    def rad(y):
        return R0 + (R1 - R0) * y / H

    # ── the pole itself (collider) ──
    pole = MB()
    pole.tube((0, 0.0, 0), (0, 8.97, 0), R0, conc, r1=rad(8.97), sides=12, caps=False)
    pole.tube((0, 8.97, 0), (0, 9.0, 0), rad(8.97) + 0.004, dirty, r1=0.05, sides=12, smooth=False)
    pole.tube((0, 0.0, 0), (0, 0.22, 0), R0 + 0.003, dirty, r1=rad(0.22) + 0.003, sides=12, caps=False)
    # yellow / black wrap: true diagonal stripes, clipped per facet of a 16-gon (6 stripes around -> seamless)
    nseg, y0, y1 = 16, 0.22, 1.78
    circ = 2 * math.pi * (rad((y0 + y1) / 2) + 0.007)
    cw = circ / nseg
    for j in range(nseg):
        a0, a1 = 2 * math.pi * j / nseg, 2 * math.pi * (j + 1) / nseg
        u0 = j * cw

        def P(u, y, a0=a0, a1=a1, u0=u0):
            r = rad(y) + 0.007
            pa = Vector((r * math.sin(a0), y, r * math.cos(a0)))
            pb = Vector((r * math.sin(a1), y, r * math.cos(a1)))
            return pa.lerp(pb, (u - u0) / cw)
        mid = (a0 + a1) / 2
        for poly, i in stripes2d(u0, u0 + cw, y0, y1, circ / 6, k=1.0):
            pole.pdir([P(u, y) for u, y in poly], yel if i % 2 == 0 else blk, (math.sin(mid), 0, math.cos(mid)))
    pole.tube((0, y1 - 0.005, 0), (0, y1 + 0.012, 0), rad(y1) + 0.009, band, sides=12, caps=False)
    pole.tube((0, y0 - 0.012, 0), (0, y0 + 0.005, 0), rad(y0) + 0.009, band, sides=12, caps=False)
    # curved address sign (tex_pole_sign 0.25 x 0.5, centre y = 2.2, facing +z)
    rs = rad(2.2) + 0.006
    amax = 0.125 / rs
    ns = 6
    for i in range(ns):
        a0 = -amax + 2 * amax * i / ns
        a1 = -amax + 2 * amax * (i + 1) / ns
        pole.poly([(rs * math.sin(a0), 1.95, rs * math.cos(a0)), (rs * math.sin(a1), 1.95, rs * math.cos(a1)),
                   (rs * math.sin(a1), 2.45, rs * math.cos(a1)), (rs * math.sin(a0), 2.45, rs * math.cos(a0))],
                  sign, uv=[(i / ns, 0.0), ((i + 1) / ns, 0.0), ((i + 1) / ns, 1.0), (i / ns, 1.0)])
    for y in (1.975, 2.425):
        pole.tube((0, y - 0.008, 0), (0, y + 0.008, 0), rad(y) + 0.009, band, sides=12, caps=False)
    pole.build("pole")

    # ── fittings above head height (no collider: min y > 2) ──
    fx = MB()
    yb = 2.75
    side = 1
    while yb < 7.4:   # 足場ボルト
        r = rad(yb)
        fx.tube((side * (r - 0.01), yb, 0), (side * (r + 0.17), yb, 0), 0.011, steel, sides=6, smooth=False)
        fx.tube((side * (r + 0.165), yb, 0), (side * (r + 0.165), yb + 0.035, 0), 0.01, steel, sides=6, smooth=False)
        yb += 0.45
        side = -side
    fx.bb(-0.05, 0.05, 2.6, 2.78, rad(2.7) - 0.004, rad(2.7) + 0.002, plate)            # pole number plate
    for i in range(3):
        fx.bb(-0.03, 0.03 - i * 0.012, 2.73 - i * 0.045, 2.75 - i * 0.045, rad(2.7) + 0.002, rad(2.7) + 0.004, ink)
    # street lamp arm (the head itself is the lamp_head node)
    ya = 5.2
    fx.tube((0, ya - 0.06, 0), (0, ya + 0.06, 0), rad(ya) + 0.012, steel, sides=12, smooth=False)
    fx.rope([(0, ya, rad(ya) - 0.02), (0, ya + 0.04, 0.4), (0, ya + 0.1, 0.7), (0, ya + 0.1, 0.86)], 0.024, housing, sides=8)
    fx.tube((0, ya - 0.3, rad(ya - 0.3) - 0.01), (0, ya + 0.03, 0.5), 0.013, housing, sides=6)
    fx.tube((0, ya - 0.33, 0), (0, ya - 0.27, 0), rad(ya - 0.3) + 0.01, steel, sides=12, smooth=False)
    fx.rope([(0.035, ya + 0.02, rad(ya) + 0.01), (0.05, 6.2, rad(6.2) + 0.012), (0.06, 7.5, rad(7.5) + 0.012)], 0.009, black, sides=5)
    # low-voltage rack (wire at y 7.6 runs through the spools along x)
    fx.tube((0, 7.57, 0), (0, 7.63, 0), rad(7.6) + 0.01, steel, sides=12, smooth=False)
    fx.bb(-0.2, 0.2, 7.585, 7.615, -0.015, 0.015, steel)
    for sx in (-1, 1):
        fx.tube((sx * 0.17, 7.56, 0), (sx * 0.17, 7.64, 0), 0.03, spool, sides=8)
    # transformer crossarm along x, cut-outs, arrester and the pole transformer
    fx.bb(-0.7, 0.7, 7.215, 7.285, -0.035, 0.035, steel)
    fx.tube((0, 7.22, 0), (0, 7.28, 0), rad(7.25) + 0.012, steel, sides=12, smooth=False)
    for x in (-0.3, -0.56):
        fx.cbox((0.07, 0.2, 0.09), (x, 7.1, 0.0), porcelain, 0.012)
        fx.tube((x, 6.99, 0), (x, 6.88, 0.02), 0.005, black, sides=4, smooth=False)
    fx.tube((0.5, 7.2, 0), (0.5, 6.98, 0), 0.035, trans, sides=8)
    fx.tube((0.5, 6.98, 0), (0.5, 6.93, 0), 0.02, porcelain, sides=8)
    tx = -0.43
    fx.tube((tx, 6.2, 0), (tx, 6.75, 0), 0.2, trans, sides=12)
    fx.tube((tx, 6.75, 0), (tx, 6.81, 0), 0.205, trans, r1=0.16, sides=12, smooth=False)
    fx.tube((tx, 6.15, 0), (tx, 6.2, 0), 0.17, steel, r1=0.2, sides=12, smooth=False)
    for dx in (-0.06, 0.08):
        fx.tube((tx + dx, 6.81, 0.0), (tx + dx, 6.89, 0.0), 0.022, porcelain, sides=8)
    for y in (6.3, 6.65):
        fx.bb(-0.24, -0.08, y - 0.025, y + 0.025, -0.04, 0.04, steel)
    for a in (110, 150, 200, 250):
        aa = math.radians(a)
        fx.bb(tx + 0.21 * math.cos(aa) - 0.01, tx + 0.21 * math.cos(aa) + 0.01, 6.25, 6.7,
              0.21 * math.sin(aa) - 0.03, 0.21 * math.sin(aa) + 0.03, trans)
    fx.rope([(tx + 0.15, 6.4, 0.12), (-0.2, 6.9, 0.1), (-0.12, 7.55, 0.06)], 0.012, black, sides=5)
    # high voltage crossarm along z (wires at z = ±0.45, y = 8.45 run along x)
    fx.bb(-0.035, 0.035, 8.265, 8.335, -0.55, 0.55, steel)
    fx.tube((0, 8.27, 0), (0, 8.33, 0), rad(8.3) + 0.012, steel, sides=12, smooth=False)
    for sz in (-1, 1):
        fx.beam((0, 8.265, sz * 0.38), (0, 7.95, sz * (rad(7.95) + 0.005)), 0.035, 0.008, steel, up=(1, 0, 0))
        z = sz * 0.45
        fx.tube((0, 8.335, z), (0, 8.37, z), 0.012, steel, sides=6, smooth=False)
        fx.tube((0, 8.37, z), (0, 8.4, z), 0.05, porcelain, r1=0.04, sides=10)
        fx.tube((0, 8.4, z), (0, 8.425, z), 0.036, porcelain, sides=10)
        fx.tube((0, 8.425, z), (0, 8.45, z), 0.03, porcelain, r1=0.022, sides=10)
    fx.build("pole_fittings")

    # ── lamp head (light source marker), origin at the centre of the glowing face ──
    lh = MB()
    lh.cbox((0.17, 0.08, 0.44), (0, 5.12, 1.05), housing, 0.015)
    lh.bb(-0.065, 0.065, 5.06, 5.085, 0.86, 1.24, lamp)
    lh.tube((0, 5.16, 0.93), (0, 5.19, 0.93), 0.02, steel, sides=8)
    obj = lh.build("lamp_head")
    set_origin(obj, (0, 5.06, 1.05))


# ═══════════════════════════════════════════════════════════════════════════
#  garbage_station — folding wire-mesh stocker, crow net, two bags inside
# ═══════════════════════════════════════════════════════════════════════════
def build_garbage_station():
    frame = M("gs_frame", "#7b8783", 0.5, 0.5)
    wire = M("gs_mesh", "#9ba4a1", 0.45, 0.55)
    net = M("gs_net", "#2f7d3d", 0.9)
    bag_w = M("gs_bag", "#dfe2dc", 0.35)
    bag_y = M("gs_bag_yellow", "#e1d377", 0.35)
    plate = M("gs_sign", "#eeeee8", 0.6)
    green = M("gs_sign_green", "#2c7a46", 0.6)
    ink = M("gs_ink", "#25282a", 0.8)
    conc = M("gs_concrete", "#8d8b85", 0.95)
    mb = MB()
    X, Z, Yb, Yl = 0.885, 0.57, 0.95, 1.0
    mb.bb(-0.9, 0.9, 0.0, 0.02, -0.585, 0.585, conc)
    for x in (-X, 0.0, X):
        for z in (-Z, Z):
            mb.bb(x - 0.015, x + 0.015, 0.02, Yb, z - 0.015, z + 0.015, frame)
    for y in (0.035, Yb - 0.015):
        for z in (-Z, Z):
            mb.bb(-X, X, y - 0.015, y + 0.015, z - 0.015, z + 0.015, frame)
        for x in (-X, X):
            mb.bb(x - 0.015, x + 0.015, y - 0.015, y + 0.015, -Z, Z, frame)
    for z in (-Z, Z):   # lid frame
        mb.bb(-0.9, 0.9, Yb, Yl, z - 0.015, z + 0.015, frame)
    for x in (-0.9 + 0.015, 0.9 - 0.015):
        mb.bb(x - 0.015, x + 0.015, Yb, Yl, -Z, Z, frame)
    mb.bb(-0.018, 0.018, Yb, Yl, -Z, Z, frame)
    r, sp = 0.0055, 0.15
    xs = [-X + sp * (i + 1) for i in range(int(2 * X / sp))]
    zs = [-Z + sp * (i + 1) for i in range(int(2 * Z / sp))]
    ys = [0.05 + sp * (i + 1) for i in range(int((Yb - 0.05) / sp))]
    for z in (-Z, Z):
        for x in xs:
            mb.tube((x, 0.05, z), (x, Yb - 0.03, z), r, wire, sides=4, caps=False, smooth=False)
        for y in ys:
            mb.tube((-X, y, z), (X, y, z), r, wire, sides=4, caps=False, smooth=False)
    for x in (-X, X):
        for z in zs:
            mb.tube((x, 0.05, z), (x, Yb - 0.03, z), r, wire, sides=4, caps=False, smooth=False)
        for y in ys:
            mb.tube((x, y, -Z), (x, y, Z), r, wire, sides=4, caps=False, smooth=False)
    for x in xs:
        mb.tube((x, Yl - 0.012, -Z), (x, Yl - 0.012, Z), r, wire, sides=4, caps=False, smooth=False)
    for z in zs:
        mb.tube((-X, Yl - 0.012, z), (X, Yl - 0.012, z), r, wire, sides=4, caps=False, smooth=False)
    mb.rope([(-0.16, 0.975, Z), (-0.15, 0.975, Z + 0.035), (0.15, 0.975, Z + 0.035), (0.16, 0.975, Z)], 0.009, frame,
            sides=5, smooth=False)
    for sx in (-1, 1):   # folding joints
        mb.bb(sx * X - 0.025, sx * X + 0.025, 0.46, 0.52, -0.05, 0.05, frame)
    # bags
    mb.blob((-0.38, 0.23, 0.04), (0.33, 0.25, 0.28), bag_w, segs=10, rings=7, jitter=0.09, seed=3, floor=-0.21)
    mb.blob((-0.36, 0.5, 0.07), (0.05, 0.06, 0.045), bag_w, segs=6, rings=4, jitter=0.2, seed=4)
    mb.blob((-0.4, 0.53, 0.02), (0.03, 0.05, 0.025), bag_w, segs=5, rings=4, jitter=0.2, seed=8)
    mb.blob((0.36, 0.25, -0.1), (0.36, 0.27, 0.31), bag_y, segs=10, rings=7, jitter=0.09, seed=6, floor=-0.23)
    mb.blob((0.33, 0.54, -0.06), (0.05, 0.06, 0.045), bag_y, segs=6, rings=4, jitter=0.2, seed=9)
    # crow net rolled up on the lid + a corner hanging down at the back left
    rnd = random.Random(2)
    pts = [(-0.78 + 1.5 * i / 9, 1.047 + rnd.uniform(-0.006, 0.006), -0.38 + rnd.uniform(-0.03, 0.03)) for i in range(10)]
    mb.rope(pts, 0.045, net, sides=7, radii=[0.03 + rnd.uniform(0.0, 0.018) for _ in pts], caps=True)
    rows = []
    for i in range(5):
        y = Yl - 0.09 * i
        rows.append([(-0.86 + 0.09 * j + rnd.uniform(-0.01, 0.01), y + rnd.uniform(-0.01, 0.01),
                      -Z - 0.022 - 0.012 * math.sin(i * 1.3 + j)) for j in range(5)])
    mb.grid(rows, net, smooth=True, outward=lambda p: Vector((0, 0, -1)))
    # rules sign on the front mesh
    zs_ = Z + 0.008
    mb.bb(0.25, 0.65, 0.55, 0.85, zs_, zs_ + 0.006, plate)
    mb.bb(0.25, 0.65, 0.8, 0.85, zs_ + 0.006, zs_ + 0.008, green)
    for i in range(5):
        mb.bb(0.28, 0.62 - (i % 3) * 0.06, 0.74 - i * 0.035, 0.75 - i * 0.035, zs_ + 0.006, zs_ + 0.008, ink)
    mb.build("garbage_station")


# ═══════════════════════════════════════════════════════════════════════════
#  phone_booth — glass booth, green public phone, ceiling light (front door fixed shut)
# ═══════════════════════════════════════════════════════════════════════════
def build_phone_booth():
    frame = M("pb_frame", "#e5e7e3", 0.4, 0.2)
    base = M("pb_base", "#8a8d8e", 0.6, 0.4)
    green = M("pb_green", "#2e8a4b", 0.45)
    phone = M("pb_phone", "#3f9d5c", 0.35)
    glass = M("glass", "#b8d0d8", 0.05)
    lightm = M("emit_booth", "#dfe8df", 0.3, emit="#e8ffe8")
    black = M("pb_black", "#18191a", 0.6)
    grey = M("pb_grey", "#a8acaf", 0.4, 0.4)
    book = M("pb_book", "#e6c51f", 0.8)
    book2 = M("pb_book_blue", "#3a5a9a", 0.8)
    pages = M("pb_pages", "#ecebe2", 0.9)
    shelf = M("pb_shelf", "#cfd2cf", 0.5, 0.2)
    lcd = M("pb_lcd", "#7f9a84", 0.3)
    key = M("pb_key", "#dcdcd6", 0.5)
    H = 0.475
    mb = MB()
    mb.bb(-H, H, 0.0, 0.06, -H, H, base)
    for sx in (-1, 1):
        for sz in (-1, 1):
            mb.bb(sx * (H - 0.03) - 0.03, sx * (H - 0.03) + 0.03, 0.06, 2.12, sz * (H - 0.03) - 0.03, sz * (H - 0.03) + 0.03,
                  frame)
    # back / left / right walls: rails + glass
    # back (-z), right (+x) and left (-x) walls: rails + glass, built in a local frame facing +z
    for ry in (180, 90, -90):
        with mb.at((0, 0, 0), ry=ry):
            for y0, y1 in ((0.06, 0.17), (0.97, 1.02), (1.98, 2.12)):
                mb.bb(-H + 0.03, H - 0.03, y0, y1, H - 0.03, H, frame)
            for ya, yb2 in ((0.17, 0.97), (1.02, 1.98)):
                mb.pdir([(-H + 0.03, ya, H - 0.012), (H - 0.03, ya, H - 0.012), (H - 0.03, yb2, H - 0.012),
                         (-H + 0.03, yb2, H - 0.012)], glass, (0, 0, 1))
    # front folding door (two leaves, closed)
    for x0, x1 in ((-H + 0.03, -0.003), (0.003, H - 0.03)):
        mb.bb(x0, x1, 0.06, 0.18, H - 0.03, H, frame)
        mb.bb(x0, x1, 1.94, 2.12, H - 0.03, H, frame)
        mb.bb(x0, x0 + 0.04, 0.18, 1.94, H - 0.03, H, frame)
        mb.bb(x1 - 0.04, x1, 0.18, 1.94, H - 0.03, H, frame)
        mb.bb(x0, x1, 0.98, 1.02, H - 0.03, H, frame)
        for ya, yb2 in ((0.18, 0.98), (1.02, 1.94)):
            mb.pdir([(x0 + 0.04, ya, H - 0.015), (x1 - 0.04, ya, H - 0.015), (x1 - 0.04, yb2, H - 0.015),
                     (x0 + 0.04, yb2, H - 0.015)], glass, (0, 0, 1))
    mb.tube((0.05, 0.9, H + 0.014), (0.05, 1.3, H + 0.014), 0.011, grey, sides=6)
    for y in (0.92, 1.28):
        mb.bb(0.044, 0.056, y - 0.006, y + 0.006, H, H + 0.014, grey)
    # roof with the green sign band
    mb.bb(-H, H, 2.12, 2.24, -H, H, frame)
    mb.bb(-0.44, 0.44, 2.24, 2.3, -0.44, 0.44, frame)
    for sx in (-1, 1):
        mb.pdir([(-0.42, 2.145, sx * (H + 0.002)), (0.42, 2.145, sx * (H + 0.002)), (0.42, 2.215, sx * (H + 0.002)),
                 (-0.42, 2.215, sx * (H + 0.002))], green, (0, 0, sx))
        mb.pdir([(sx * (H + 0.002), 2.145, -0.42), (sx * (H + 0.002), 2.145, 0.42), (sx * (H + 0.002), 2.215, 0.42),
                 (sx * (H + 0.002), 2.215, -0.42)], green, (sx, 0, 0))
    mb.cbox((0.42, 0.035, 0.28), (0.0, 2.1, 0.0), lightm, 0.008)                        # ceiling light
    # interior: shelf, green phone, phone books
    mb.bb(-0.4, 0.4, 0.92, 0.95, -H + 0.03, -0.17, shelf)
    mb.cbox((0.24, 0.42, 0.15), (0.05, 1.2, -0.37), phone, 0.02)
    mb.bb(-0.03, 0.13, 1.33, 1.37, -0.296, -0.293, lcd)
    for i in range(4):
        for j in range(3):
            kx, ky = 0.0 + j * 0.035, 1.27 - i * 0.03
            mb.bb(kx - 0.012, kx + 0.012, ky - 0.009, ky + 0.009, -0.296, -0.289, key)
    mb.bb(0.11, 0.15, 1.31, 1.37, -0.296, -0.29, grey)                               # coin slot plate
    mb.bb(0.127, 0.133, 1.32, 1.36, -0.29, -0.288, black)
    mb.bb(0.08, 0.15, 1.05, 1.08, -0.296, -0.29, black)                               # coin return
    mb.bb(0.0, 0.1, 1.135, 1.145, -0.296, -0.29, black)                               # card slot
    mb.cbox((0.07, 0.25, 0.07), (-0.11, 1.23, -0.32), phone, 0.015)                     # handset
    mb.bb(-0.135, -0.085, 1.33, 1.37, -0.32, -0.27, phone)
    mb.bb(-0.135, -0.085, 1.09, 1.13, -0.32, -0.27, phone)
    mb.rope([(-0.11, 1.1, -0.31), (-0.12, 1.0, -0.3), (-0.07, 0.97, -0.31), (-0.02, 1.0, -0.33)], 0.012, phone, sides=5)
    mb.bb(-0.3, 0.3, 0.55, 0.58, -H + 0.03, -0.2, shelf)                              # book shelf
    mb.bb(-0.3, -0.28, 0.58, 0.92, -H + 0.03, -0.2, shelf)
    mb.bb(0.28, 0.3, 0.58, 0.92, -H + 0.03, -0.2, shelf)
    mb.bb(-0.24, 0.06, 0.58, 0.64, -0.43, -0.22, book, fm={"+x": pages, "-z": pages})    # yellow directory
    mb.bb(0.08, 0.26, 0.58, 0.61, -0.42, -0.25, book2, fm={"-x": pages})
    mb.bb(-0.16, 0.16, 1.5, 1.6, -H + 0.026, -H + 0.03, pages)                         # instruction plate
    mb.blob((0.22, 0.09, 0.2), (0.05, 0.03, 0.045), pages, segs=6, rings=4, jitter=0.3, seed=12)
    mb.build("phone_booth")


# ═══════════════════════════════════════════════════════════════════════════
#  road_barrier — A-frame barricade, 通行止め board, red flasher
# ═══════════════════════════════════════════════════════════════════════════
def build_road_barrier():
    yel = M("rb_yellow", "#efc21a", 0.5)
    blk = M("rb_black", "#1a1a1a", 0.6)
    board = M("rb_board", "#f0f0eb", 0.5)
    sign = M("tex_road_closed", "#f4f4f0", 0.5)
    lens = M("emit_blink", "#5e0d08", 0.3, emit="#ff2a12")
    body = M("rb_lamp_body", "#202123", 0.5)
    rubber = M("rb_rubber", "#1e1e1e", 0.9)
    bag = M("rb_sandbag", "#7a7257", 0.95)
    steel = M("rb_steel", "#9a9da0", 0.45, 0.5)
    mb = MB()
    for sx in (-1, 1):
        x = sx * 0.9
        for sz in (-1, 1):
            mb.beam((x, 0.9, sz * 0.02), (x, 0.012, sz * 0.2), 0.05, 0.03, yel, up=(0, 0, 1))
            mb.bb(x - 0.045, x + 0.045, 0.0, 0.03, sz * 0.2 - 0.05, sz * 0.2 + 0.05, rubber)
        mb.beam((x, 0.3, -0.155), (x, 0.3, 0.155), 0.04, 0.025, yel)
    for y0, y1 in ((0.78, 0.9), (0.36, 0.46)):
        mb.bb(-1.0, 1.0, y0, y1, -0.025, 0.025, yel, skip=("+z", "-z"))
        mb.stripes(-1.0, 1.0, y0, y1, 0.025, 0.1, yel, blk, k=1.0, facing=1)
        mb.stripes(-1.0, 1.0, y0, y1, -0.025, 0.1, yel, blk, k=-1.0, facing=-1)
    # 通行止め board hung on the top bar
    mb.bb(-0.42, 0.42, 0.4, 0.84, 0.028, 0.042, board)
    mb.quad_uv((-0.4, 0.42, 0.0425), (0.4, 0.42, 0.0425), (0.4, 0.82, 0.0425), (-0.4, 0.82, 0.0425), sign)
    for x in (-0.3, 0.3):
        mb.beam((x, 0.84, 0.035), (x, 0.92, 0.0), 0.012, 0.006, steel, up=(0, 0, 1))
    # flasher on top
    mb.bb(-0.012, 0.012, 0.9, 0.98, -0.012, 0.012, steel)
    mb.tube((0, 0.98, 0), (0, 1.04, 0), 0.055, body, sides=10)
    mb.tube((0, 1.04, 0), (0, 1.16, 0), 0.06, lens, r1=0.052, sides=12, caps=False)
    mb.tube((0, 1.16, 0), (0, 1.185, 0), 0.052, lens, r1=0.03, sides=12, caps=False, smooth=False)
    mb.tube((0, 1.185, 0), (0, 1.2, 0), 0.03, body, r1=0.02, sides=12)
    # sandbag across the right feet
    mb.blob((0.88, 0.065, 0.0), (0.12, 0.06, 0.23), bag, segs=8, rings=5, jitter=0.06, seed=4, floor=-0.05)
    mb.build("road_barrier")


# ═══════════════════════════════════════════════════════════════════════════
#  traffic_cone
# ═══════════════════════════════════════════════════════════════════════════
def build_traffic_cone():
    red = M("tc_red", "#d3271d", 0.55)
    white = M("tc_white", "#ecece6", 0.4)
    base = M("tc_base", "#2a1c1a", 0.85)
    dirt = M("tc_dirt", "#4e3e31", 0.95)
    hole = M("tc_hole", "#300b09", 0.9)
    mb = MB()
    c = 0.05
    h = 0.175
    sq = [(-h + c, -h), (h - c, -h), (h, -h + c), (h, h - c), (h - c, h), (-h + c, h), (-h, h - c), (-h, -h + c)]
    mb.prism(sq, "y", 0.0, 0.035, base, side_m=lambda i: dirt if i in (0, 1, 7) else base)

    def r(y):
        return 0.14 + (0.034 - 0.14) * (y - 0.035) / (0.7 - 0.035)
    secs = [(0.035, 0.27, red), (0.27, 0.33, white), (0.33, 0.42, red), (0.42, 0.56, white), (0.56, 0.7, red)]
    for y0, y1, m in secs:
        mb.tube((0, y0, 0), (0, y1, 0), r(y0), m, r1=r(y1), sides=16, caps=False)
    mb.tube((0, 0.035, 0), (0, 0.05, 0), 0.152, red, r1=0.15, sides=16, caps=False)
    with mb.at((0, 0.7, 0), rx=-90):
        mb.annulus((0, 0, 0), 0.02, 0.034, red, seg=16)
        mb.disc((0, 0, -0.01), 0.021, hole, seg=10)
    mb.build("traffic_cone")


# ═══════════════════════════════════════════════════════════════════════════
#  bicycle — silver mamachari on its stand, front basket and rear carrier (long axis z)
# ═══════════════════════════════════════════════════════════════════════════
def build_bicycle():
    frame = M("bc_frame", "#c2c6c8", 0.3, 0.75)
    tire = M("bc_tire", "#1b1b1c", 0.85)
    rim = M("bc_rim", "#d3d6d7", 0.25, 0.85)
    spoke = M("bc_spoke", "#b7babc", 0.3, 0.8)
    black = M("bc_black", "#202122", 0.6, 0.1)
    saddle = M("bc_saddle", "#1d1c1b", 0.55)
    basket = M("bc_basket", "#2a2b2d", 0.5, 0.3)
    case = M("bc_chaincase", "#2d3135", 0.45, 0.2)
    red = M("bc_reflector", "#b8160f", 0.3)
    lampg = M("bc_lamp_glass", "#e6e2c8", 0.2)
    bagm = M("bc_bag", "#e7e7e1", 0.5)
    mb = MB()
    F = Vector((0, 0.352, 0.53))
    Rr = Vector((0, 0.366, -0.53))
    for C in (F, Rr):
        mb.torus(C, 0.33, 0.022, tire, axis=(1, 0, 0), seg=16, sides=6)
        mb.torus(C, 0.305, 0.009, rim, axis=(1, 0, 0), seg=16, sides=4)
        mb.tube(C + Vector((-0.05, 0, 0)), C + Vector((0.05, 0, 0)), 0.024, frame, sides=8)
        for i in range(12):
            a = 2 * math.pi * (i + 0.5) / 12
            side = 1 if i % 2 else -1
            p0 = C + Vector((side * 0.03, 0.026 * math.cos(a), 0.026 * math.sin(a)))
            p1 = C + Vector((0, 0.3 * math.cos(a + 0.25 * side), 0.3 * math.sin(a + 0.25 * side)))
            mb.tube(p0, p1, 0.0028, spoke, sides=3, caps=False, smooth=False)
    # fenders
    mb.arc_band(F, 0.37, -55, 105, -0.028, 0.028, frame, seg=10)
    mb.arc_band(Rr, 0.37, -140, 12, -0.03, 0.03, frame, seg=10)
    BB = Vector((0, 0.29, -0.03))
    HT0, HT1 = Vector((0, 0.68, 0.37)), Vector((0, 0.86, 0.33))
    ST = Vector((0, 0.8, -0.22))
    mb.tube(HT0, HT1, 0.024, frame, sides=8)
    mb.rope([HT0 + Vector((0, 0.03, -0.01)), (0, 0.52, 0.3), (0, 0.37, 0.17), (0, 0.3, 0.05), BB], 0.021, frame, sides=8)
    mb.rope([HT1 + Vector((0, -0.05, -0.01)), (0, 0.66, 0.22), (0, 0.54, 0.02), (0, 0.55, -0.15)], 0.014, frame, sides=6)
    mb.tube(BB, ST, 0.019, frame, sides=8)
    mb.tube(ST, (0, 0.905, -0.255), 0.013, frame, sides=6)
    for sx in (-1, 1):
        axle = Rr + Vector((sx * 0.05, 0, 0))
        mb.tube(BB + Vector((sx * 0.03, 0, 0)), axle, 0.011, frame, sides=6)
        mb.tube((sx * 0.02, 0.74, -0.2), axle, 0.01, frame, sides=6)
        mb.tube((sx * 0.045, 0.66, 0.38), F + Vector((sx * 0.048, 0, 0)), 0.013, frame, sides=6)
        # rear carrier
        mb.tube((sx * 0.07, 0.75, -0.24), (sx * 0.07, 0.75, -0.8), 0.008, frame, sides=6)
        mb.tube((sx * 0.07, 0.75, -0.74), axle + Vector((sx * 0.01, 0, 0)), 0.007, frame, sides=5)
        mb.tube((sx * 0.07, 0.75, -0.26), (sx * 0.025, 0.72, -0.2), 0.007, frame, sides=5)
        # stand (両立スタンド)
        mb.tube(axle + Vector((sx * 0.012, -0.01, 0)), (sx * 0.13, 0.012, -0.66), 0.009, frame, sides=6)
    for z in (-0.4, -0.6, -0.8):
        mb.tube((-0.07, 0.75, z), (0.07, 0.75, z), 0.007, frame, sides=5)
    mb.tube((-0.13, 0.012, -0.66), (0.13, 0.012, -0.66), 0.009, frame, sides=6)
    mb.tube((0, 0.72, -0.2), (0, 0.72, -0.3), 0.009, frame, sides=5)
    mb.tube((0.0, 0.67, 0.36), (0.0, 0.64, 0.4), 0.03, frame, sides=8)        # fork crown
    # stem, handlebar, grips, levers, bell
    mb.tube(HT1, (0, 0.97, 0.3), 0.014, frame, sides=6)
    mb.rope([(-0.24, 1.0, 0.15), (-0.2, 1.0, 0.22), (-0.1, 0.98, 0.29), (0, 0.97, 0.3), (0.1, 0.98, 0.29),
             (0.2, 1.0, 0.22), (0.24, 1.0, 0.15)], 0.012, frame, sides=6)
    for sx in (-1, 1):
        mb.tube((sx * 0.232, 1.0, 0.16), (sx * 0.258, 1.0, 0.09), 0.017, black, sides=6)
        mb.tube((sx * 0.2, 0.99, 0.22), (sx * 0.265, 0.975, 0.23), 0.006, black, sides=4)
    with mb.at((-0.15, 1.005, 0.27), rx=-90):
        mb.dome((0, 0, 0), 0.026, 0.022, rim, seg=10, rings=2)
    # saddle with springs
    mb.blob((0, 0.935, -0.27), (0.085, 0.03, 0.13), saddle, segs=10, rings=5, seed=1)
    for sx in (-1, 1):
        mb.tube((sx * 0.04, 0.89, -0.33), (sx * 0.04, 0.925, -0.33), 0.013, frame, sides=6)
    # chain case and cranks
    pts = []
    for i in range(7):
        a = math.radians(90 + 180 * i / 6)
        pts.append((Rr.z + 0.065 * math.cos(a), Rr.y + 0.065 * math.sin(a)))
    for i in range(7):
        a = math.radians(270 + 180 * i / 6)
        pts.append((BB.z + 0.11 * math.cos(a), BB.y + 0.11 * math.sin(a)))
    mb.prism(pts, "x", 0.06, 0.08, case)
    mb.beam((0.095, BB.y, BB.z), (0.095, BB.y - 0.15, BB.z + 0.08), 0.02, 0.025, frame, up=(1, 0, 0))
    mb.beam((-0.095, BB.y, BB.z), (-0.095, BB.y + 0.15, BB.z - 0.08), 0.02, 0.025, frame, up=(1, 0, 0))
    mb.bb(0.105, 0.2, BB.y - 0.162, BB.y - 0.138, BB.z + 0.05, BB.z + 0.11, black)
    mb.bb(-0.2, -0.105, BB.y + 0.138, BB.y + 0.162, BB.z - 0.11, BB.z - 0.05, black)
    mb.tube((-0.08, BB.y, BB.z), (0.08, BB.y, BB.z), 0.03, frame, sides=8)
    # basket
    x0, x1, z0, z1, y0, y1 = -0.17, 0.17, 0.42, 0.74, 0.76, 1.03
    corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
    for y in (y0, (y0 + y1) / 2, y1):
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            mb.tube((a[0], y, a[1]), (b[0], y, b[1]), 0.005 if y != y1 else 0.007, basket, sides=4, caps=False, smooth=False)
    for i in range(5):
        x = x0 + (x1 - x0) * (i + 0.5) / 5
        for z in (z0, z1):
            mb.tube((x, y0, z), (x, y1, z), 0.0035, basket, sides=3, caps=False, smooth=False)
    for i in range(4):
        z = z0 + (z1 - z0) * (i + 0.5) / 4
        for x in (x0, x1):
            mb.tube((x, y0, z), (x, y1, z), 0.0035, basket, sides=3, caps=False, smooth=False)
    mb.pdir([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], basket, (0, 1, 0))
    for sx in (-1, 1):
        mb.tube((sx * 0.12, y0, z1 - 0.04), F + Vector((sx * 0.05, 0.01, 0)), 0.006, basket, sides=4)
    mb.tube((0, 0.92, 0.31), (0, 0.92, z0), 0.01, basket, sides=4)
    mb.blob((0.04, 0.82, 0.58), (0.09, 0.06, 0.08), bagm, segs=7, rings=5, jitter=0.22, seed=21)
    # dynamo lamp under the basket, rear reflector
    mb.tube((0, 0.71, 0.7), (0, 0.71, 0.765), 0.032, black, sides=8)
    mb.disc((0, 0.71, 0.766), 0.026, lampg, seg=8)
    mb.tube((0, 0.74, 0.7), (0, 0.76, 0.66), 0.008, black, sides=4)
    a = math.radians(-125)
    rp = Rr + Vector((0, 0.375 * math.cos(a), 0.375 * math.sin(a)))
    mb.bb(-0.025, 0.025, rp.y - 0.02, rp.y + 0.02, rp.z - 0.012, rp.z + 0.004, red)
    mb.bb(-0.03, 0.03, 0.47, 0.53, -0.36, -0.33, black)                      # ring lock
    mb.build("bicycle")


# ═══════════════════════════════════════════════════════════════════════════
#  potted_plants — morning glory curtain, planters, a small bonsai, watering can
# ═══════════════════════════════════════════════════════════════════════════
def build_potted_plants():
    planter = M("pp_planter", "#9b5432", 0.8)
    soil = M("pp_soil", "#3a2a1d", 1.0)
    bamboo = M("pp_bamboo", "#b7a36a", 0.7)
    netm = M("pp_net", "#3f8b4a", 0.8)
    vine = M("pp_vine", "#36622d", 0.8)
    leaf1 = M("pp_leaf", "#3c7a30", 0.75)
    leaf2 = M("pp_leaf_light", "#5a8b33", 0.75)
    leaf3 = M("pp_leaf_dry", "#8a7a3b", 0.85)
    fl1 = M("pp_flower", "#5a3fb2", 0.6)
    fl2 = M("pp_flower_pink", "#a2489c", 0.6)
    fc = M("pp_flower_center", "#ece6f3", 0.6)
    pot = M("pp_pot", "#99552f", 0.85)
    glazed = M("pp_pot_glazed", "#2c3a5a", 0.35)
    stand = M("pp_stand", "#4a3425", 0.85)
    trunk = M("pp_trunk", "#5a4431", 0.9)
    pine = M("pp_pine", "#2c4a28", 0.9)
    canm = M("pp_watering_can", "#3d8e59", 0.5)
    red = M("pp_geranium", "#c8323a", 0.6)
    mb = MB()
    rnd = random.Random(17)
    # long planter (rim as four strips so the soil shows)
    pz0, pz1 = -0.24, -0.02
    mb.bb(-0.68, 0.12, 0.0, 0.18, pz0, pz1, planter)
    for x0, x1, z0, z1 in ((-0.69, 0.13, pz0 - 0.01, pz0 + 0.015), (-0.69, 0.13, pz1 - 0.015, pz1 + 0.01),
                           (-0.69, -0.665, pz0, pz1), (0.105, 0.13, pz0, pz1)):
        mb.bb(x0, x1, 0.18, 0.2, z0, z1, planter)
    mb.bb(-0.665, 0.105, 0.17, 0.185, pz0 + 0.015, pz1 - 0.015, soil)
    nz = -0.14
    for x in (-0.6, 0.06):
        mb.tube((x, 0.15, nz), (x, 1.6, nz), 0.011, bamboo, sides=6)
        for y in (0.5, 0.85, 1.2):
            mb.tube((x, y, nz), (x, y + 0.012, nz), 0.013, bamboo, sides=6, smooth=False)
    mb.tube((-0.65, 1.56, nz), (0.11, 1.56, nz), 0.01, bamboo, sides=6)
    for i in range(7):   # green net
        x = -0.57 + i * 0.1
        mb.tube((x, 0.24, nz), (x, 1.55, nz), 0.0035, netm, sides=3, caps=False, smooth=False)
    for j in range(13):
        y = 0.3 + j * 0.1
        mb.tube((-0.6, y, nz), (0.06, y, nz), 0.0035, netm, sides=3, caps=False, smooth=False)
    vines = []
    for vx, seed in ((-0.5, 1), (-0.22, 2), (-0.02, 3)):
        r2 = random.Random(seed)
        pts = [(vx, 0.18, nz + 0.05)]
        y = 0.3
        while y < 1.45 - seed * 0.08:
            pts.append((vx + r2.uniform(-0.07, 0.07), y, nz + 0.012 + r2.uniform(0, 0.01)))
            y += 0.16
        mb.rope(pts, 0.005, vine, sides=4)
        vines.append(pts)
    # heart shaped leaves
    def leaf(p, s, rz, rx, ry, m):
        with mb.at(p, rx=rx, ry=ry, rz=rz):
            pts = [(0, -s, 0), (0.8 * s, 0.25 * s, 0), (0.45 * s, 0.75 * s, 0), (0, 0.5 * s, 0), (-0.45 * s, 0.75 * s, 0),
                   (-0.8 * s, 0.25 * s, 0)]
            mb.pdir(pts, m, (0, 0, 1))
    for pts in vines:
        for k in range(1, len(pts)):
            for side in (-1, 1):
                p = Vector(pts[k]) + Vector((side * rnd.uniform(0.03, 0.07), rnd.uniform(-0.04, 0.04), 0.012))
                leaf(p, rnd.uniform(0.045, 0.075), rnd.uniform(-50, 50) + 180, rnd.uniform(-35, 10), rnd.uniform(-25, 25),
                     leaf1 if rnd.random() < 0.65 else leaf2)
    for _ in range(10):
        p = (rnd.uniform(-0.58, 0.04), rnd.uniform(0.3, 1.1), nz + 0.02)
        leaf(p, rnd.uniform(0.04, 0.065), rnd.uniform(140, 220), rnd.uniform(-30, 10), rnd.uniform(-20, 20),
             leaf1 if rnd.random() < 0.5 else leaf2)
    # morning glory flowers (trumpets facing the street)
    for _ in range(12):
        p = Vector((rnd.uniform(-0.56, 0.03), rnd.uniform(0.35, 1.35), nz + 0.03))
        m = fl1 if rnd.random() < 0.7 else fl2
        with mb.at(p, rx=rnd.uniform(-25, 15), ry=rnd.uniform(-30, 30)):
            mb.tube((0, 0, -0.012), (0, 0, 0.03), 0.008, m, r1=0.034, sides=6, caps=False, smooth=False)
            mb.disc((0, 0, 0.028), 0.03, m, seg=6)
            mb.disc((0, 0, 0.0295), 0.011, fc, seg=6)
    # fallen leaves
    for _ in range(4):
        leaf((rnd.uniform(-0.6, 0.6), 0.003, rnd.uniform(0.0, 0.2)), 0.04, 0, -90, rnd.uniform(0, 360), leaf3)
    # bonsai on a small stand
    mb.bb(0.28, 0.7, 0.28, 0.31, -0.16, 0.1, stand)
    for x in (0.3, 0.68):
        for z in (-0.14, 0.08):
            mb.bb(x - 0.015, x + 0.015, 0.0, 0.28, z - 0.015, z + 0.015, stand)
    mb.bb(0.29, 0.69, 0.08, 0.1, -0.15, 0.09, stand)
    mb.bb(0.36, 0.62, 0.31, 0.37, -0.1, 0.06, glazed)
    mb.bb(0.37, 0.61, 0.355, 0.372, -0.09, 0.05, soil)
    mb.rope([(0.47, 0.36, -0.02), (0.51, 0.45, 0.0), (0.46, 0.53, -0.02), (0.53, 0.6, -0.01), (0.55, 0.66, 0.0)], 0.016, trunk,
            sides=6, radii=[0.022, 0.018, 0.015, 0.012, 0.01])
    mb.rope([(0.47, 0.52, -0.02), (0.41, 0.57, 0.0), (0.37, 0.6, 0.01)], 0.008, trunk, sides=5)
    mb.rope([(0.52, 0.58, -0.01), (0.6, 0.56, 0.01), (0.64, 0.54, 0.02)], 0.007, trunk, sides=5)
    for c, rr, sd in (((0.56, 0.69, 0.0), (0.1, 0.04, 0.08), 31), ((0.37, 0.62, 0.01), (0.07, 0.032, 0.06), 32),
                      ((0.64, 0.56, 0.02), (0.06, 0.028, 0.05), 33), ((0.47, 0.75, -0.01), (0.06, 0.028, 0.05), 34)):
        mb.blob(c, rr, pine, segs=8, rings=4, jitter=0.15, seed=sd)
    # small round pots: geranium and a spiky plant
    mb.tube((0.18, 0.0, 0.14), (0.18, 0.16, 0.14), 0.075, pot, r1=0.095, sides=10)
    mb.blob((0.18, 0.25, 0.14), (0.12, 0.1, 0.1), leaf1, segs=9, rings=5, jitter=0.18, seed=40)
    for i in range(6):
        a = 2 * math.pi * i / 6
        mb.blob((0.18 + 0.07 * math.cos(a), 0.32 + 0.02 * math.sin(3 * a), 0.14 + 0.06 * math.sin(a)), (0.025, 0.025, 0.025),
                red, segs=5, rings=3, seed=50 + i)
    mb.tube((-0.42, 0.0, 0.13), (-0.42, 0.13, 0.13), 0.065, pot, r1=0.085, sides=10)
    for i in range(9):
        a = 2 * math.pi * i / 9
        tip = (-0.42 + 0.13 * math.cos(a), 0.3 + 0.06 * math.sin(2 * a), 0.13 + 0.1 * math.sin(a))
        mb.pdir([(-0.42 + 0.02 * math.cos(a + 1.2), 0.12, 0.13 + 0.02 * math.sin(a + 1.2)),
                 (-0.42 + 0.02 * math.cos(a - 1.2), 0.12, 0.13 + 0.02 * math.sin(a - 1.2)), tip], leaf2, (math.cos(a), 0.2, math.sin(a)))
    # watering can
    mb.tube((-0.08, 0.0, 0.17), (-0.08, 0.15, 0.17), 0.06, canm, sides=10)
    mb.tube((-0.03, 0.05, 0.17), (0.09, 0.17, 0.17), 0.012, canm, r1=0.009, sides=6)
    mb.tube((0.09, 0.17, 0.17), (0.105, 0.185, 0.17), 0.018, canm, sides=6)
    mb.rope([(-0.13, 0.13, 0.17), (-0.12, 0.21, 0.17), (-0.04, 0.21, 0.17), (-0.03, 0.13, 0.17)], 0.008, canm, sides=4)
    mb.build("potted_plants")


# ═══════════════════════════════════════════════════════════════════════════
#  house kit (local frames: wall plane z = 0, origin at the bottom centre, facing +z)
# ═══════════════════════════════════════════════════════════════════════════
def house_kit(frame_hex="#adb1b4", frame_metal=0.6, frame_rough=0.35, lit_base="#b8a582", lit_emit="#ffc887"):
    return {
        "glass": M("glass", "#9fb6c0", 0.05),
        "frosted": M("glass_frosted", "#d3d9da", 0.85),
        "lit": M("emit_window", lit_base, 0.9, emit=lit_emit),
        "curtain": M("h_curtain", "#6f6556", 0.95),
        "curtain2": M("h_curtain_blue", "#56616c", 0.95),
        "room": M("h_room_dark", "#191714", 1.0),
        "frame": M("h_window_frame", frame_hex, frame_rough, frame_metal),
        "sill": M("h_alu_sill", "#8c9093", 0.4, 0.55),
        "grille": M("h_grille", "#9a9ea1", 0.4, 0.6),
        "ac": M("h_ac", "#e2e2dc", 0.5, 0.1),
        "ac_dark": M("h_ac_dark", "#2a2c2e", 0.6),
        "metal": M("h_metal", "#b8bbbd", 0.3, 0.8),
        "pipe": M("h_pipe_cover", "#d8d1bf", 0.6),
        "black": M("h_black", "#1d1e20", 0.6),
        "meter": M("h_meter", "#c8cac7", 0.5),
        "found": M("h_foundation", "#8b8983", 0.95),
        "conc": M("h_concrete", "#9b9890", 0.95),
        "ink": M("h_ink", "#2a2520", 0.8),
    }


def kit_window(mb, K, w, h, inner="curtain", grille=False, slide=True, sill=True, simple=False, fd=0.07,
               frame=None, grille_m=None, gap=0.13):
    """Aluminium window. inner: lit / curtain / curtain2 / dark / frosted / lit_frosted."""
    fr = frame or K["frame"]
    fw = 0.045
    sk = ("-z",)
    x0, x1, y0, y1 = -w / 2 + fw, w / 2 - fw, fw, h - fw
    mb.bb(-w / 2, w / 2, h - fw, h, 0.0, fd, fr, skip=sk)
    mb.bb(-w / 2, w / 2, 0.0, fw, 0.0, fd, fr, skip=sk)
    mb.bb(-w / 2, x0, y0, y1, 0.0, fd, fr, skip=sk)
    mb.bb(x1, w / 2, y0, y1, 0.0, fd, fr, skip=sk)

    def quad(z, m):
        mb.pdir([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], m, (0, 0, 1))
    glass_m = K["frosted"] if inner in ("frosted", "lit_frosted") else K["glass"]
    cm = {"lit": K["lit"], "curtain": K["curtain"], "curtain2": K["curtain2"]}.get(inner)
    if cm is not None and not simple:
        quad(0.004, K["room"])
        mb.pleat(x0, x1, y0 + 0.03, y1, max(3, int((x1 - x0) / 0.15)), 0.008, 0.02, cm)
    elif cm is not None:
        quad(0.01, cm)
    else:
        quad(0.006, K["lit"] if inner == "lit_frosted" else K["room"])
    if slide:
        mb.bb(-0.028, 0.002, y0, y1, 0.024, 0.042, fr, skip=sk)
        mb.bb(-0.002, 0.028, y0, y1, 0.038, 0.056, fr, skip=sk)
    quad(0.033, glass_m)
    if sill:
        mb.bb(-w / 2 - 0.03, w / 2 + 0.03, -0.035, 0.0, 0.0, fd + 0.035, K["sill"], skip=sk)
    if grille:   # 面格子: vertical bars on two rails that sit on the frame
        gm = grille_m or K["grille"]
        gz = fd + 0.03
        n = max(3, int(round(w / gap)))
        for i in range(n + 1):
            x = -w / 2 + 0.03 + (w - 0.06) * i / n
            mb.bb(x - 0.008, x + 0.008, 0.03, h - 0.03, gz - 0.008, gz + 0.008, gm, skip=("-z", "+y", "-y"))
        for y in (0.06, h - 0.06):
            mb.bb(-w / 2 + 0.02, w / 2 - 0.02, y - 0.012, y + 0.012, fd - 0.01, gz + 0.012, gm, skip=("-z",))


def kit_shutter(mb, w, h, slat_m, box_m, closed=True):
    """Rain shutter: box on top, guide rails, slats (closed) in front of the window opening."""
    mb.bb(-w / 2 - 0.06, w / 2 + 0.06, h, h + 0.24, 0.0, 0.25, box_m, skip=("-z",))
    mb.bb(-w / 2 - 0.06, -w / 2, 0.0, h, 0.0, 0.11, box_m, skip=("-z",))
    mb.bb(w / 2, w / 2 + 0.06, 0.0, h, 0.0, 0.11, box_m, skip=("-z",))
    if closed:
        n = max(4, int(h / 0.1))
        mb.tile_rows(lambda t: ((-w / 2, h * t, 0.06), (w / 2, h * t, 0.06)), [i / n for i in range(n + 1)], 0.014,
                     slat_m, up=(0, 0, 1))
        mb.bb(-w / 2, w / 2, 0.0, 0.05, 0.05, 0.1, box_m)


def kit_ac(mb, K, w=0.78, h=0.56, d=0.27):
    """Air-conditioner outdoor unit, back on z = 0, feet on y = 0."""
    mb.cbox((w, h, d), (0, h / 2 + 0.04, d / 2 + 0.01), K["ac"], 0.012)
    cx, cy = -w * 0.13, h / 2 + 0.04
    mb.disc((cx, cy, d + 0.0125), 0.205, K["ac_dark"], seg=14)
    for k in (-0.1, 0.0, 0.1):
        mb.bb(cx - 0.215, cx + 0.215, cy + k - 0.005, cy + k + 0.005, d + 0.012, d + 0.02, K["ac"])
    mb.bb(cx - 0.006, cx + 0.006, cy - 0.215, cy + 0.215, d + 0.012, d + 0.02, K["ac"])
    mb.bb(w / 2 - 0.12, w / 2 - 0.03, 0.1, 0.2, d + 0.01, d + 0.03, K["metal"])
    for sx in (-1, 1):
        mb.bb(sx * (w / 2 - 0.08) - 0.04, sx * (w / 2 - 0.08) + 0.04, 0.0, 0.04, 0.03, d - 0.01, K["ac_dark"])


def kit_bracket(mb, K, w=0.78, d=0.3):
    """Wall bracket under a hanging AC unit (unit bottom at y = 0)."""
    for sx in (-1, 1):
        x = sx * (w / 2 - 0.1)
        mb.bb(x - 0.02, x + 0.02, -0.03, 0.0, 0.0, d, K["metal"])
        mb.beam((x, -0.4, 0.02), (x, -0.02, d - 0.03), 0.03, 0.015, K["metal"], up=(1, 0, 0))
        mb.bb(x - 0.025, x + 0.025, -0.45, 0.02, 0.0, 0.02, K["metal"])


def kit_heater(mb, K):
    """Gas water heater (給湯器) on the wall; pipes run down 0.45."""
    mb.cbox((0.42, 0.58, 0.2), (0, 0.29, 0.1), K["ac"], 0.012)
    mb.bb(-0.12, 0.12, 0.43, 0.5, 0.2, 0.215, K["ac_dark"])
    mb.bb(-0.16, -0.06, 0.08, 0.12, 0.2, 0.205, K["black"])
    for x in (-0.11, -0.03, 0.05, 0.12):
        mb.tube((x, 0.0, 0.08), (x, -0.45, 0.08), 0.011, K["metal"], sides=5, caps=False, smooth=False)


def kit_meter(mb, K):
    mb.bb(-0.1, 0.1, 0.0, 0.28, 0.0, 0.11, K["meter"])
    mb.bb(-0.065, 0.065, 0.13, 0.23, 0.11, 0.113, K["black"])
    mb.bb(-0.02, 0.02, 0.28, 0.9, 0.02, 0.06, K["meter"])


def kit_nameplate(mb, plate_m, ink_m, w=0.13, h=0.26, chars=2):
    mb.bb(-w / 2, w / 2, 0.0, h, 0.0, 0.02, plate_m)
    ch = h * 0.72 / chars
    for i in range(chars):
        y = h * 0.86 - (i + 0.5) * ch
        mb.bb(-w * 0.26, w * 0.26, y - ch * 0.36, y + ch * 0.36, 0.02, 0.024, ink_m)


def kit_dish(mb, K):
    """BS dish on a short wall arm."""
    mb.tube((0, 0, 0.0), (0, 0, 0.18), 0.016, K["metal"], sides=6)
    mb.bb(-0.05, 0.05, -0.06, 0.06, 0.0, 0.015, K["metal"])
    with mb.at((0, 0.06, 0.2), rx=-30, ry=25):
        mb.dome((0, 0, 0), 0.21, -0.045, K["ac"], seg=12, rings=2)
        mb.tube((0, -0.2, 0.0), (0, -0.04, 0.22), 0.009, K["metal"], sides=4)
        mb.cbox((0.05, 0.05, 0.07), (0, -0.03, 0.24), K["ac"], 0.01)


def clapboard(mb, edge, n, up, m, m2, step=0.022):
    mb.tile_rows(edge, [i / n for i in range(n + 1)], step, m, up=up, alt_fn=lambda i: m2 if i % 5 == 3 else None)


# ═══════════════════════════════════════════════════════════════════════════
#  house_a — beige siding, dark grey gable tile roof (eaves face the street)
# ═══════════════════════════════════════════════════════════════════════════
def build_house_a():
    K = house_kit()
    wall = M("ha_siding", "#d4c5a4", 0.85)
    joint = M("ha_siding_joint", "#b4a686", 0.9)
    roof = M("ha_roof_tile", "#4a4e54", 0.6, 0.2)
    roof2 = M("ha_roof_tile_dark", "#3e4247", 0.65, 0.2)
    ridge = M("ha_ridge", "#383b40", 0.6, 0.2)
    soffit = M("ha_soffit", "#cec8b9", 0.85)
    trim = M("ha_trim", "#3c3732", 0.7)
    band = M("ha_band", "#b9ad92", 0.8)
    gut = M("ha_gutter", "#57534d", 0.5, 0.2)
    door = M("ha_door", "#6a4931", 0.6)
    door_dk = M("ha_door_groove", "#4b3423", 0.7)
    frame_dk = M("ha_frame_dark", "#4a4440", 0.4, 0.5)
    canopy = M("ha_canopy", "#3b3936", 0.6, 0.3)
    shutter = M("ha_shutter", "#a5a198", 0.5, 0.4)
    sbox = M("ha_shutter_box", "#9a968d", 0.5, 0.4)
    plate = M("ha_nameplate", "#cbb68b", 0.6)
    mb = MB()
    BX, BZ, Y0 = 3.5, 3.0, 0.45
    yr, p = 6.95, 0.42
    ye = yr - 3.5 * p
    # foundation, drip strip, walls (pentagon prism = gables included)
    mb.bb(-BX + 0.02, BX - 0.02, 0.0, Y0, -BZ + 0.02, BZ - 0.02, K["found"])
    mb.bb(-BX - 0.015, BX + 0.015, Y0 - 0.03, Y0 + 0.01, -BZ - 0.015, BZ + 0.015, K["sill"])
    mb.prism([(-BZ, Y0), (BZ, Y0), (BZ, 5.55), (0.0, 6.82), (-BZ, 5.55)], "x", -BX, BX, wall)
    for y in (0.95, 1.4, 1.85, 2.3, 2.75, 3.45, 3.9, 4.35, 4.8, 5.25):
        mb.pdir([(-BX, y, BZ + 0.002), (BX, y, BZ + 0.002), (BX, y + 0.012, BZ + 0.002), (-BX, y + 0.012, BZ + 0.002)],
                joint, (0, 0, 1))
        for sx in (-1, 1):
            mb.pdir([(sx * (BX + 0.002), y, -BZ), (sx * (BX + 0.002), y, BZ), (sx * (BX + 0.002), y + 0.012, BZ),
                     (sx * (BX + 0.002), y + 0.012, -BZ)], joint, (sx, 0, 0))
    mb.bb(-BX - 0.025, BX + 0.025, 2.95, 3.08, -BZ - 0.025, BZ + 0.025, band)            # 幕板
    # roof: two stepped tile slopes, soffits, fascia, barge boards, ridge with 鬼瓦
    nr = 12
    ts = [i / nr for i in range(nr + 1)]
    for sz in (1, -1):
        def edge(t, sz=sz):
            y = ye + (yr - ye) * t
            z = sz * 3.5 * (1 - t)
            return ((-4.0, y, z), (4.0, y, z))
        mb.tile_rows(edge, ts, 0.035, roof, alt_fn=lambda i: roof2 if i % 4 == 3 else None)
        mb.pdir([(-4.0, ye - 0.12, sz * 3.5), (4.0, ye - 0.12, sz * 3.5), (4.0, yr - 0.12, 0.0), (-4.0, yr - 0.12, 0.0)],
                soffit, (0, -1, 0))
        mb.bb(-4.0, 4.0, ye - 0.17, ye + 0.03, min(sz * 3.47, sz * 3.5), max(sz * 3.47, sz * 3.5), trim)
        mb.bb(-4.0, 4.0, ye - 0.21, ye - 0.11, min(sz * 3.5, sz * 3.6), max(sz * 3.5, sz * 3.6), gut)
        for sx in (-1, 1):
            mb.beam((sx * 3.98, ye - 0.07, sz * 3.5), (sx * 3.98, yr + 0.0, 0.0), 0.04, 0.24, trim)
    mb.bb(-4.0, 4.0, yr - 0.05, yr + 0.1, -0.15, 0.15, ridge)
    mb.tube((-3.95, yr + 0.1, 0), (3.95, yr + 0.1, 0), 0.085, ridge, sides=6)
    for sx in (-1, 1):
        mb.bb(min(sx * 3.88, sx * 4.0), max(sx * 3.88, sx * 4.0), yr - 0.15, yr + 0.25, -0.2, 0.2, ridge)
    # downpipes at the four corners
    for sx in (-1, 1):
        for sz in (-1, 1):
            x = sx * 3.36
            mb.rope([(sx * 3.75, ye - 0.14, sz * 3.55), (sx * 3.75, ye - 0.4, sz * 3.55), (x, ye - 0.75, sz * (BZ + 0.06)),
                     (x, 0.14, sz * (BZ + 0.06)), (x, 0.04, sz * (BZ + 0.2))], 0.033, gut, sides=6, smooth=False)
            for y in (1.2, 3.6):
                mb.bb(x - 0.045, x + 0.045, y - 0.02, y + 0.02, min(sz * BZ, sz * (BZ + 0.1)), max(sz * BZ, sz * (BZ + 0.1)), gut)
    F = BZ
    # ── front: entrance (door, side light, canopy, porch light, 表札, intercom)
    mb.bb(1.3, 3.2, 0.0, 0.18, F, 3.5, K["conc"])
    mb.bb(1.42, 2.62, 0.18, 0.34, F, 3.24, K["conc"])
    with mb.at((2.0, Y0, F)):
        dw, dh = 0.9, 2.05
        mb.bb(-dw / 2 - 0.05, dw / 2 + 0.05, dh, dh + 0.05, 0.0, 0.08, frame_dk, skip=("-z",))
        mb.bb(-dw / 2 - 0.05, -dw / 2, 0.0, dh, 0.0, 0.08, frame_dk, skip=("-z",))
        mb.bb(dw / 2, dw / 2 + 0.05, 0.0, dh, 0.0, 0.08, frame_dk, skip=("-z",))
        mb.bb(-dw / 2, dw / 2, 0.0, dh, 0.0, 0.045, door, skip=("-z",))
        for x in (-0.22, 0.0, 0.22):
            mb.bb(x - 0.008, x + 0.008, 0.18, dh - 0.18, 0.045, 0.049, door_dk)
        mb.bb(dw / 2 - 0.13, dw / 2 - 0.105, 0.75, 1.35, 0.075, 0.095, K["metal"])
        for y in (0.8, 1.3):
            mb.bb(dw / 2 - 0.125, dw / 2 - 0.11, y - 0.01, y + 0.01, 0.045, 0.075, K["metal"])
        mb.bb(dw / 2 - 0.17, dw / 2 - 0.14, 1.0, 1.08, 0.045, 0.055, K["metal"])
    with mb.at((2.65, Y0, F)):
        kit_window(mb, K, 0.3, 2.05, inner="frosted", slide=False, sill=False)
    mb.bb(1.3, 3.2, 2.72, 2.8, F, 3.5, canopy)
    for x in (1.45, 3.05):
        mb.beam((x, 2.45, F), (x, 2.72, 3.4), 0.03, 0.03, canopy)
    mb.bb(1.33, 1.43, 1.95, 2.14, F, F + 0.08, K["frosted"])
    mb.bb(1.32, 1.44, 2.14, 2.17, F, F + 0.09, K["black"])
    with mb.at((2.95, 1.42, F)):
        kit_nameplate(mb, plate, K["ink"], 0.13, 0.26, 2)
    mb.bb(2.9, 3.0, 1.12, 1.28, F, F + 0.035, K["meter"])
    mb.bb(2.93, 2.97, 1.22, 1.25, F + 0.035, F + 0.04, K["black"])
    # 1F: closed shutter, AC unit with its pipe cover, bathroom window (lit, frosted, grille)
    with mb.at((-1.95, 0.55, F)):
        kit_shutter(mb, 2.1, 2.0, shutter, sbox, closed=True)
    with mb.at((-0.41, 0.0, F)):
        kit_ac(mb, K)
    mb.bb(-0.02, 0.08, 0.3, 0.37, F, F + 0.07, K["pipe"])
    mb.bb(0.01, 0.08, 0.37, 1.3, F, F + 0.07, K["pipe"])
    with mb.at((0.6, 1.55, F)):
        kit_window(mb, K, 0.6, 0.7, inner="lit_frosted", grille=True, slide=False)
    # 2F: lit bedroom window, curtained window with laundry arms, small stair window
    with mb.at((-2.1, 3.55, F)):
        kit_window(mb, K, 1.6, 1.3, inner="lit")
    with mb.at((1.55, 3.55, F)):
        kit_window(mb, K, 1.9, 1.3, inner="curtain")
    for x in (0.75, 2.35):
        mb.beam((x, 3.34, F), (x, 3.44, F + 0.42), 0.03, 0.02, K["metal"])
    mb.tube((0.55, 3.46, F + 0.4), (2.55, 3.46, F + 0.4), 0.016, K["metal"], sides=6)
    with mb.at((-0.35, 3.85, F)):
        kit_window(mb, K, 0.5, 0.75, inner="frosted", slide=False)
    # ── right side (+x): windows, AC on a bracket, meter, BS dish
    with mb.at((BX, 0.95, -1.0), ry=90):
        kit_window(mb, K, 0.7, 0.9, inner="frosted", simple=True)
    with mb.at((BX, 3.6, 0.7), ry=90):
        kit_window(mb, K, 1.2, 1.2, inner="curtain2", simple=True)
    with mb.at((BX, 3.25, -1.6), ry=90):
        kit_ac(mb, K)
        kit_bracket(mb, K)
        mb.bb(0.38, 0.45, 0.2, 0.28, 0.0, 0.07, K["pipe"])
        mb.bb(0.45, 0.52, 0.2, 1.3, 0.0, 0.07, K["pipe"])
    with mb.at((BX, 1.25, 1.9), ry=90):
        kit_meter(mb, K)
    with mb.at((BX, 4.9, 2.3), ry=90):
        kit_dish(mb, K)
    # ── left side (-x): windows, water heater, gas meter
    with mb.at((-BX, 1.0, 0.3), ry=-90):
        kit_window(mb, K, 1.2, 1.1, inner="curtain", simple=True)
    with mb.at((-BX, 3.6, -0.8), ry=-90):
        kit_window(mb, K, 1.2, 1.2, inner="dark", simple=True)
    with mb.at((-BX, 0.95, 1.7), ry=-90):
        kit_heater(mb, K)
    with mb.at((-BX, 0.75, 2.4), ry=-90):
        kit_meter(mb, K)
    # ── back
    for x, y, w, h, inner in ((-1.6, 0.6, 1.7, 1.8, "curtain"), (1.6, 1.4, 0.7, 0.9, "frosted"),
                              (-1.8, 3.6, 1.5, 1.2, "dark"), (1.5, 3.6, 1.5, 1.2, "curtain2")):
        with mb.at((x, y, -BZ), ry=180):
            kit_window(mb, K, w, h, inner=inner, simple=True)
    mb.build("house_a")


# ═══════════════════════════════════════════════════════════════════════════
#  house_b — white walls, brown hip roof, 2F balcony, carport
# ═══════════════════════════════════════════════════════════════════════════
def build_house_b():
    K = house_kit(frame_hex="#4f4842", frame_metal=0.5, frame_rough=0.4)
    wall = M("hb_wall", "#e5e3dc", 0.8)
    roof = M("hb_roof", "#6b4a36", 0.6, 0.15)
    roof2 = M("hb_roof_dark", "#5b3e2d", 0.65, 0.15)
    ridge = M("hb_ridge", "#4d3426", 0.6, 0.15)
    soffit = M("hb_soffit", "#e8e6df", 0.8)
    trim = M("hb_fascia", "#4a3a30", 0.6)
    gut = M("hb_gutter", "#5a4a3e", 0.5, 0.2)
    cap = M("hb_parapet_cap", "#6a6560", 0.5, 0.4)
    floor = M("hb_balcony_floor", "#77736c", 0.9)
    door = M("hb_door", "#3f3a36", 0.5, 0.3)
    alu = M("hb_carport", "#5b544d", 0.4, 0.5)
    towel = M("hb_towel", "#d9a7b1", 0.9)
    plate = M("hb_nameplate", "#3a3a3a", 0.4, 0.3)
    ink_w = M("hb_ink_white", "#e9e9e4", 0.6)
    band = M("hb_band", "#cfccc4", 0.8)
    mb = MB()
    X0, X1, Z0, Z1, Y0, YW = -3.55, 1.45, -3.0, 2.6, 0.45, 5.51
    ye, p = 5.66, 0.4
    RX0, RX1, RZ0, RZ1 = -4.0, 1.9, -3.45, 3.05
    hw = (RX1 - RX0) / 2
    yr = ye + hw * p
    cx = (RX0 + RX1) / 2
    rz0, rz1 = RZ0 + hw, RZ1 - hw
    mb.bb(X0 + 0.02, X1 - 0.02, 0.0, Y0, Z0 + 0.02, Z1 - 0.02, K["found"])
    mb.bb(X0 - 0.015, X1 + 0.015, Y0 - 0.03, Y0 + 0.01, Z0 - 0.015, Z1 + 0.015, K["sill"])
    mb.bb(X0, X1, Y0, YW, Z0, Z1, wall)
    mb.bb(X0 - 0.02, X1 + 0.02, 2.9, 2.96, Z0 - 0.02, Z1 + 0.02, band)
    # hip roof
    A, B, C, D = (RX0, ye, RZ1), (RX1, ye, RZ1), (RX1, ye, RZ0), (RX0, ye, RZ0)
    Rf, Rb = (cx, yr, rz1), (cx, yr, rz0)
    ts = [i / 12 for i in range(13)]
    for eL, eR, rL, rR in ((A, B, Rf, Rf), (C, D, Rb, Rb), (B, C, Rf, Rb), (D, A, Rb, Rf)):
        def edge(t, eL=eL, eR=eR, rL=rL, rR=rR):
            return (_v(eL).lerp(_v(rL), t), _v(eR).lerp(_v(rR), t))
        mb.tile_rows(edge, ts, 0.02, roof, alt_fn=lambda i: roof2 if i % 3 == 2 else None)
    up = Vector((0, 0.045, 0))
    for corner, rp in ((A, Rf), (B, Rf), (C, Rb), (D, Rb)):
        mb.beam(_v(corner) + up, _v(rp) + up, 0.13, 0.07, ridge)
    mb.beam(_v(Rf) + up, _v(Rb) + up, 0.15, 0.09, ridge)
    ys = ye - 0.15
    mb.pdir([(RX0, ys, RZ0), (RX1, ys, RZ0), (RX1, ys, RZ1), (RX0, ys, RZ1)], soffit, (0, -1, 0))
    mb.bb(RX0, RX1, ys - 0.03, ye + 0.02, RZ1 - 0.03, RZ1, trim)
    mb.bb(RX0, RX1, ys - 0.03, ye + 0.02, RZ0, RZ0 + 0.03, trim)
    mb.bb(RX0, RX0 + 0.03, ys - 0.03, ye + 0.02, RZ0, RZ1, trim)
    mb.bb(RX1 - 0.03, RX1, ys - 0.03, ye + 0.02, RZ0, RZ1, trim)
    mb.bb(RX0, RX1, ys - 0.06, ys + 0.04, RZ1, RZ1 + 0.1, gut)
    mb.bb(RX0, RX1, ys - 0.06, ys + 0.04, RZ0 - 0.1, RZ0, gut)
    mb.bb(RX0 - 0.1, RX0, ys - 0.06, ys + 0.04, RZ0, RZ1, gut)
    mb.bb(RX1, RX1 + 0.1, ys - 0.06, ys + 0.04, RZ0, RZ1, gut)
    for (gx, gz, wx, wz) in ((RX0 - 0.05, RZ1 - 0.25, X0 - 0.05, Z1 - 0.3), (RX1 + 0.05, RZ0 + 0.25, X1 + 0.05, Z0 + 0.3)):
        mb.rope([(gx, ys - 0.05, gz), (gx, ys - 0.3, gz), (wx, ys - 0.65, wz), (wx, 0.14, wz)], 0.032, gut, sides=6, smooth=False)
    # ── balcony with parapet, laundry pole, forgotten towel, AC unit; lit 掃き出し窓 behind it
    BXa, BXb, BZb = -3.3, 0.3, 3.5
    mb.bb(BXa, BXb, 2.95, 3.12, Z1, BZb, wall, fm={"+y": floor})
    mb.bb(BXa, BXb, 3.12, 4.12, BZb - 0.12, BZb, wall)
    mb.bb(BXa, BXa + 0.12, 3.12, 4.12, Z1, BZb - 0.12, wall)
    mb.bb(BXb - 0.12, BXb, 3.12, 4.12, Z1, BZb - 0.12, wall)
    mb.bb(BXa - 0.01, BXb + 0.01, 4.12, 4.16, BZb - 0.135, BZb + 0.01, cap)
    mb.bb(BXa - 0.01, BXa + 0.135, 4.12, 4.16, Z1, BZb - 0.135, cap)
    mb.bb(BXb - 0.135, BXb + 0.01, 4.12, 4.16, Z1, BZb - 0.135, cap)
    mb.tube((BXa + 0.1, 2.95, BZb - 0.1), (BXa + 0.1, 0.05, BZb - 0.1), 0.03, gut, sides=6, smooth=False)
    for x in (BXa + 0.5, BXb - 0.5):
        mb.bb(x - 0.015, x + 0.015, 4.16, 4.5, BZb - 0.09, BZb - 0.06, K["metal"])
        mb.bb(x - 0.015, x + 0.015, 4.44, 4.47, BZb - 0.32, BZb - 0.06, K["metal"])
    tz = BZb - 0.27
    mb.tube((BXa + 0.25, 4.47, tz), (BXb - 0.25, 4.47, tz), 0.016, K["metal"], sides=6)
    mb.pdir([(-2.0, 3.97, tz + 0.012), (-1.62, 3.97, tz + 0.012), (-1.62, 4.46, tz + 0.012), (-2.0, 4.46, tz + 0.012)], towel, (0, 0, 1))
    mb.pdir([(-2.0, 4.12, tz - 0.012), (-1.62, 4.12, tz - 0.012), (-1.62, 4.46, tz - 0.012), (-2.0, 4.46, tz - 0.012)], towel, (0, 0, -1))
    with mb.at((-0.35, 3.12, Z1)):
        kit_ac(mb, K)
    with mb.at((-1.75, 3.12, Z1)):
        kit_window(mb, K, 1.8, 2.0, inner="lit", sill=False)
    with mb.at((0.85, 3.65, Z1)):
        kit_window(mb, K, 0.55, 0.85, inner="frosted", slide=False)
    # ── 1F front: entrance (under the balcony), big window, small window, nameplate
    mb.bb(-1.05, 0.2, 0.0, 0.3, Z1, 3.2, K["conc"])
    with mb.at((-0.45, Y0, Z1)):
        dw, dh = 0.85, 2.05
        mb.bb(-dw / 2 - 0.05, dw / 2 + 0.05, dh, dh + 0.05, 0.0, 0.08, alu, skip=("-z",))
        mb.bb(-dw / 2 - 0.05, -dw / 2, 0.0, dh, 0.0, 0.08, alu, skip=("-z",))
        mb.bb(dw / 2, dw / 2 + 0.05, 0.0, dh, 0.0, 0.08, alu, skip=("-z",))
        mb.bb(-dw / 2, dw / 2, 0.0, dh, 0.0, 0.045, door, skip=("-z",))
        mb.bb(-0.08, 0.08, 1.1, 1.85, 0.045, 0.048, K["frosted"])
        mb.bb(dw / 2 - 0.12, dw / 2 - 0.1, 0.8, 1.3, 0.07, 0.09, K["metal"])
        mb.bb(dw / 2 - 0.115, dw / 2 - 0.105, 0.82, 1.28, 0.045, 0.07, K["metal"])
    with mb.at((-2.3, 0.62, Z1)):
        kit_window(mb, K, 1.7, 1.9, inner="curtain")
        mb.bb(-0.92, 0.92, 1.9, 2.12, 0.0, 0.22, alu, skip=("-z",))
    with mb.at((0.85, 1.4, Z1)):
        kit_window(mb, K, 0.55, 0.85, inner="frosted", grille=True, slide=False)
    with mb.at((0.25, 1.3, Z1)):
        kit_nameplate(mb, plate, ink_w, 0.2, 0.12, 1)
    mb.bb(0.2, 0.3, 1.05, 1.21, Z1, Z1 + 0.035, K["meter"])
    # ── carport (two posts on the outer side, frosted polycarbonate roof)
    for z in (-2.05, 2.85):
        mb.bb(3.82, 3.94, 0.0, 2.36, z - 0.06, z + 0.06, alu)
    mb.bb(3.8, 3.96, 2.36, 2.48, -2.45, 3.4, alu)
    for z in (-2.4, -0.95, 0.5, 1.95, 3.35):
        mb.beam((1.55, 2.53, z), (3.9, 2.45, z), 0.05, 0.06, alu)
    mb.pdir([(1.55, 2.57, -2.45), (3.9, 2.49, -2.45), (3.9, 2.49, 3.4), (1.55, 2.57, 3.4)], K["frosted"], (0, 1, 0))
    mb.beam((1.55, 2.52, 3.42), (3.96, 2.44, 3.42), 0.05, 0.11, alu)
    mb.bb(1.45, 4.0, 0.0, 0.02, -2.6, 3.45, K["conc"])
    for x in (2.15, 3.35):
        mb.bb(x - 0.3, x + 0.3, 0.02, 0.12, -1.95, -1.8, K["conc"])
    # ── sides and back
    with mb.at((X1, 1.0, -0.6), ry=90):
        kit_window(mb, K, 0.7, 0.9, inner="frosted", simple=True)
    with mb.at((X1, 3.6, 0.2), ry=90):
        kit_window(mb, K, 1.2, 1.2, inner="curtain", simple=True)
    with mb.at((X1, 0.95, 1.5), ry=90):
        kit_heater(mb, K)
    with mb.at((X1, 0.8, 0.55), ry=90):
        kit_meter(mb, K)
    with mb.at((X0, 1.0, 0.2), ry=-90):
        kit_window(mb, K, 1.3, 1.1, inner="curtain2", simple=True)
    with mb.at((X0, 3.6, -1.0), ry=-90):
        kit_window(mb, K, 1.2, 1.2, inner="dark", simple=True)
    with mb.at((X0, 3.3, 1.3), ry=-90):
        kit_ac(mb, K)
        kit_bracket(mb, K)
    for x, y, w, h, inner in ((-2.2, 0.7, 1.6, 1.6, "curtain"), (0.4, 1.4, 0.7, 0.9, "frosted"),
                              (-2.0, 3.6, 1.4, 1.2, "curtain2"), (0.3, 3.7, 0.9, 1.0, "dark")):
        with mb.at((x, y, Z0), ry=180):
            kit_window(mb, K, w, h, inner=inner, simple=True)
    mb.build("house_b")


# ═══════════════════════════════════════════════════════════════════════════
#  house_c — dusty light-blue corrugated tin, shed roof, older, window grilles
# ═══════════════════════════════════════════════════════════════════════════
def build_house_c():
    K = house_kit(frame_hex="#b7babb")
    tin = M("hc_tin", "#7c96a2", 0.6, 0.35)
    tin2 = M("hc_tin_faded", "#8fa6ae", 0.65, 0.3)
    rust = M("hc_rust", "#7a4b30", 0.95, 0.1)
    roof = M("hc_roof_tin", "#6b4535", 0.55, 0.4)
    roof_r = M("hc_roof_rust", "#57331f", 0.9, 0.2)
    soffit = M("hc_soffit", "#8c8372", 0.9)
    trim = M("hc_trim", "#dcd9ce", 0.7)
    gut = M("hc_gutter", "#9a9c98", 0.5, 0.3)
    canopy = M("hc_canopy", "#4d5c60", 0.6, 0.4)
    mailbox = M("hc_mailbox", "#8a3a2a", 0.6, 0.3)
    door = M("hc_door", "#b9bcbd", 0.35, 0.6)
    plate = M("hc_nameplate", "#b8b4a6", 0.6)
    mb = MB()
    rnd = random.Random(23)
    BX, Z0, Z1, Y0 = 3.2, -2.9, 2.9, 0.4
    yf, p = 5.45, 0.18
    ZF, ZB = 3.5, -3.2
    yb = yf + (ZF - ZB) * p

    def roof_y(z):
        return yf + (ZF - z) * p
    wf, wb = roof_y(Z1) - 0.11, roof_y(Z0) - 0.11
    mb.bb(-BX + 0.02, BX - 0.02, 0.0, Y0, Z0 + 0.02, Z1 - 0.02, K["found"])
    mb.prism([(Z0, Y0), (Z1, Y0), (Z1, wf), (Z0, wb)], "x", -BX, BX, tin)
    faded = {k for k in range(400) if rnd.random() < 0.22}

    def wall_m(k):
        return tin2 if k in faded else tin
    mb.corrugate((-BX, Y0, Z1), (1, 0, 0), (0, 1, 0), 2 * BX, wf - Y0, 0.16, 0.02, tin, (0, 0, 1), mfn=wall_m)
    mb.corrugate((BX, Y0, Z1), (0, 0, -1), (0, 1, 0), Z1 - Z0, 1.0, 0.18, 0.02, tin, (1, 0, 0), mfn=wall_m,
                 vtop=lambda u: roof_y(Z1 - u) - 0.11 - Y0)
    mb.corrugate((-BX, Y0, Z0), (0, 0, 1), (0, 1, 0), Z1 - Z0, 1.0, 0.18, 0.02, tin, (-1, 0, 0), mfn=wall_m,
                 vtop=lambda u: roof_y(Z0 + u) - 0.11 - Y0)
    # rust along the bottom edge of the cladding
    for x0, x1 in ((-3.1, -2.2), (-0.9, -0.3), (2.3, 3.1)):
        mb.pdir([(x0, Y0 + 0.06, Z1 + 0.021), (x1, Y0 + 0.06, Z1 + 0.021), (x1 - 0.1, Y0 + 0.28, Z1 + 0.021),
                 (x0 + 0.15, Y0 + 0.22, Z1 + 0.021)], rust, (0, 0, 1))
    for sx in (-1, 1):   # corner trims
        mb.bb(sx * BX - 0.04, sx * BX + 0.04, Y0, wf, Z1 - 0.04, Z1 + 0.04, trim)
        mb.bb(sx * BX - 0.04, sx * BX + 0.04, Y0, wb, Z0 - 0.04, Z0 + 0.04, trim)
    mb.bb(-BX - 0.03, BX + 0.03, Y0 - 0.02, Y0 + 0.06, Z0 - 0.03, Z1 + 0.03, trim)
    # shed roof (corrugated, ribs down the slope), soffit, fascia, back flashing, barge boards, gutter
    vd = Vector((0, yf - yb, ZF - ZB))
    nrm = Vector((0, ZF - ZB, -(yf - yb))).normalized()
    rset = {k for k in range(200) if rnd.random() < 0.16}
    mb.corrugate((-3.5, yb, ZB), (1, 0, 0), vd, 7.0, vd.length, 0.24, 0.03, roof, nrm,
                 mfn=lambda k: roof_r if k in rset else roof)
    off = -nrm * 0.1
    mb.pdir([_v((-3.5, yb, ZB)) + off, _v((3.5, yb, ZB)) + off, _v((3.5, yf, ZF)) + off, _v((-3.5, yf, ZF)) + off], soffit, -nrm)
    mb.bb(-3.5, 3.5, yf - 0.2, yf + 0.03, ZF - 0.03, ZF, trim)
    mb.bb(-3.5, 3.5, yb - 0.16, yb + 0.06, ZB - 0.04, ZB, trim)
    for sx in (-1, 1):
        mb.beam((sx * 3.48, yb - 0.04, ZB), (sx * 3.48, yf - 0.04, ZF), 0.04, 0.2, trim)
    mb.bb(-3.5, 3.5, yf - 0.24, yf - 0.13, ZF, ZF + 0.1, gut)
    mb.rope([(3.05, yf - 0.2, ZF + 0.05), (3.05, yf - 0.45, ZF + 0.05), (3.05, yf - 0.9, Z1 + 0.09), (3.05, 0.12, Z1 + 0.09),
             (3.05, 0.04, Z1 + 0.25)], 0.033, gut, sides=6, smooth=False)
    F = Z1 + 0.022
    # ── front
    with mb.at((-1.6, 1.1, F)):
        kit_window(mb, K, 1.6, 1.1, inner="curtain", grille=True)
    with mb.at((0.45, 1.45, F)):
        kit_window(mb, K, 0.5, 0.6, inner="frosted", grille=True, slide=False)
    with mb.at((-1.6, 3.5, F)):
        kit_window(mb, K, 1.6, 1.1, inner="lit", grille=True)
    with mb.at((1.5, 3.5, F)):
        kit_window(mb, K, 1.4, 1.1, inner="curtain2", grille=True)
    for xc, y, w in ((-1.6, 2.26, 1.6), (-1.6, 4.66, 1.6), (1.5, 4.66, 1.4)):   # 霧除け hoods over the windows
        x0h, x1h = xc - w / 2 - 0.08, xc + w / 2 + 0.08
        mb.beam((x0h, y + 0.1, F + 0.16), (x1h, y + 0.1, F + 0.16), 0.012, 0.32, canopy, up=(0, 0.35, -1))
        mb.bb(x0h, x1h, y + 0.02, y + 0.05, F + 0.29, F + 0.32, canopy)
    for x in (0.95, 2.05):   # laundry arms + pole under the right 2F window
        mb.beam((x, 3.33, F), (x, 3.42, F + 0.4), 0.03, 0.02, K["metal"])
    mb.tube((0.75, 3.44, F + 0.38), (2.25, 3.44, F + 0.38), 0.015, K["metal"], sides=6)
    # rust streaks under the windows
    for x, y0, y1 in ((-2.35, 0.6, 1.07), (-0.85, 2.7, 3.46), (2.15, 2.9, 3.46), (0.68, 0.9, 1.4), (-2.3, 2.6, 3.46)):
        mb.pdir([(x - 0.03, y0, F - 0.0), (x + 0.03, y0, F - 0.0), (x + 0.02, y1, F - 0.0), (x - 0.02, y1, F - 0.0)], rust, (0, 0, 1))
    # entrance: old aluminium door with frosted panels, steps, tin canopy, mailbox, meter, nameplate
    mb.bb(1.2, 2.55, 0.0, 0.2, Z1, 3.42, K["conc"])
    mb.bb(1.3, 2.45, 0.2, 0.4, Z1, 3.15, K["conc"])
    with mb.at((1.85, 0.4, F)):
        dw, dh = 0.8, 1.95
        mb.bb(-dw / 2 - 0.05, dw / 2 + 0.05, dh, dh + 0.05, 0.0, 0.07, door, skip=("-z",))
        mb.bb(-dw / 2 - 0.05, -dw / 2, 0.0, dh, 0.0, 0.07, door, skip=("-z",))
        mb.bb(dw / 2, dw / 2 + 0.05, 0.0, dh, 0.0, 0.07, door, skip=("-z",))
        mb.bb(-dw / 2, dw / 2, 0.0, 0.5, 0.0, 0.04, door, skip=("-z",))
        mb.bb(-dw / 2, dw / 2, 0.5, dh, 0.0, 0.006, K["room"])
        mb.bb(-dw / 2, dw / 2, 1.2, 1.26, 0.0, 0.04, door, skip=("-z",))
        mb.bb(-0.02, 0.02, 0.5, dh, 0.0, 0.04, door, skip=("-z",))
        for y0, y1 in ((0.5, 1.2), (1.26, dh)):
            mb.pdir([(-dw / 2, y0, 0.03), (dw / 2, y0, 0.03), (dw / 2, y1, 0.03), (-dw / 2, y1, 0.03)], K["frosted"], (0, 0, 1))
        mb.bb(dw / 2 - 0.12, dw / 2 - 0.05, 0.95, 0.99, 0.04, 0.07, K["metal"])
    mb.corrugate((1.15, 2.78, F), (1, 0, 0), (0, -0.1, 0.55), 1.4, math.hypot(0.1, 0.55), 0.12, 0.015, canopy,
                 (0, 0.55, 0.1))
    for x in (1.25, 2.45):
        mb.beam((x, 2.45, F), (x, 2.7, F + 0.45), 0.03, 0.025, K["metal"])
    mb.bb(2.45, 2.75, 1.0, 1.3, F, F + 0.12, mailbox)
    mb.bb(2.5, 2.7, 1.22, 1.24, F + 0.12, F + 0.125, K["black"])
    with mb.at((2.95, 1.4, F)):
        kit_meter(mb, K)
    mb.bb(2.93, 2.97, 2.3, 5.1, F, F + 0.04, K["meter"])
    with mb.at((1.25, 1.35, F)):
        kit_nameplate(mb, plate, K["ink"], 0.1, 0.22, 2)
    # ── sides and back
    with mb.at((BX + 0.022, 1.2, 0.3), ry=90):
        kit_window(mb, K, 0.9, 0.9, inner="dark", grille=True, simple=True)
    with mb.at((BX + 0.022, 3.6, -0.6), ry=90):
        kit_window(mb, K, 1.2, 1.1, inner="curtain", grille=True, simple=True)
    with mb.at((BX + 0.022, 0.0, -1.9), ry=90):
        kit_ac(mb, K)
    with mb.at((-BX - 0.022, 1.2, -0.4), ry=-90):
        kit_window(mb, K, 1.2, 1.0, inner="curtain2", grille=True, simple=True)
    with mb.at((-BX - 0.022, 3.6, 0.5), ry=-90):
        kit_window(mb, K, 0.9, 1.0, inner="dark", grille=True, simple=True)
    with mb.at((-BX - 0.022, 0.9, -2.1), ry=-90):
        kit_heater(mb, K)
    for x, y, w, h, inner in ((-1.5, 1.0, 1.4, 1.1, "curtain"), (1.4, 1.3, 0.6, 0.7, "frosted"),
                              (-1.5, 3.8, 1.4, 1.1, "dark"), (1.4, 3.8, 1.2, 1.1, "curtain2")):
        with mb.at((x, y, Z0), ry=180):
            kit_window(mb, K, w, h, inner=inner, simple=True)
    mb.build("house_c")


# ═══════════════════════════════════════════════════════════════════════════
#  house_old — the neighbour's single-storey wooden house (入母屋 roof, engawa with shoji, 引き戸)
# ═══════════════════════════════════════════════════════════════════════════
def build_house_old():
    K = house_kit(frame_hex="#4a3526", frame_metal=0.0, frame_rough=0.8, lit_base="#ddd5c1", lit_emit="#ffcf8f")
    wood = M("ho_wall_board", "#4a3426", 0.85)
    wood2 = M("ho_wall_board_weathered", "#5b4535", 0.9)
    timber = M("ho_timber", "#3a291e", 0.8)
    roof = M("ho_roof_tile", "#5f6367", 0.45, 0.35)
    roof2 = M("ho_roof_tile_dark", "#53575b", 0.5, 0.35)
    ridge = M("ho_ridge", "#4a4e52", 0.45, 0.35)
    soffit = M("ho_soffit", "#5a4636", 0.85)
    rafter = M("ho_rafter", "#3e2d21", 0.85)
    plaster = M("ho_plaster", "#d8d3c5", 0.9)
    floor = M("ho_engawa_floor", "#6b4b33", 0.6)
    stone = M("ho_stone", "#8c8981", 0.95)
    gutter = M("ho_gutter_copper", "#5e7c6a", 0.5, 0.4)
    propane = M("ho_propane", "#cfd2cf", 0.4, 0.3)
    pcap = M("ho_propane_cap", "#3f5a7a", 0.5, 0.2)
    plate = M("ho_nameplate", "#b59c72", 0.7)
    lpole = M("ho_laundry_pole", "#6f93b8", 0.4, 0.2)
    bucket = M("ho_bucket", "#a6aaac", 0.4, 0.6)
    vent_m = M("ho_vent", "#1c1a18", 0.9)
    mb = MB()
    BX, Z0, ZF, ZE, Y0, YT = 3.7, -3.2, 3.0, 2.0, 0.5, 2.86
    ye, p = 2.45, 0.5
    EX, EZ = 4.5, 4.0
    yr = ye + EZ * p
    xg = 3.2
    yg = ye + (EX - xg) * p
    zg = EZ - (yg - ye) / p
    xb = 3.3
    # ── body blocks
    mb.bb(-BX, BX, 0.0, Y0, Z0, ZF, K["found"])
    mb.bb(-BX, BX, Y0, YT, Z0, ZE, wood)                       # rooms
    mb.bb(0.9, BX, Y0, YT, ZE, ZF, wood)                       # genkan block
    mb.bb(-BX, -3.2, Y0, 2.45, ZE, ZF + 0.12, timber)          # 戸袋
    for z in (ZF + 0.121,):
        for x in (-3.6, -3.45, -3.3):
            mb.pdir([(x - 0.012, 0.6, z), (x + 0.012, 0.6, z), (x + 0.012, 2.35, z), (x - 0.012, 2.35, z)], wood2, (0, 0, 1))
    mb.bb(-3.2, 0.9, 0.47, 0.52, ZE, ZF, floor)                # engawa floor
    mb.bb(-3.2, 0.9, 2.42, 2.48, ZE, ZF, soffit)               # engawa ceiling
    # shoji (lit at night) with kick board, transom and grid
    mb.bb(-3.2, 0.9, 0.52, 0.75, ZE, ZE + 0.012, timber)
    mb.bb(-3.2, 0.9, 2.2, 2.42, ZE, ZE + 0.012, timber)
    mb.pdir([(-3.2, 0.75, ZE + 0.004), (0.9, 0.75, ZE + 0.004), (0.9, 2.2, ZE + 0.004), (-3.2, 2.2, ZE + 0.004)], K["lit"], (0, 0, 1))
    zz = ZE + 0.008
    pw = 4.1 / 4
    for k in range(5):
        x = -3.2 + k * pw
        mb.pdir([(x - 0.018, 0.75, zz), (x + 0.018, 0.75, zz), (x + 0.018, 2.2, zz), (x - 0.018, 2.2, zz)], timber, (0, 0, 1))
        if k < 4:
            for f in (1 / 3, 2 / 3):
                xx = x + pw * f
                mb.pdir([(xx - 0.006, 0.75, zz), (xx + 0.006, 0.75, zz), (xx + 0.006, 2.2, zz), (xx - 0.006, 2.2, zz)], timber, (0, 0, 1))
    for y in (1.04, 1.33, 1.62, 1.91):
        mb.pdir([(-3.2, y - 0.006, zz), (0.9, y - 0.006, zz), (0.9, y + 0.006, zz), (-3.2, y + 0.006, zz)], timber, (0, 0, 1))
    # glass sliding doors of the engawa (two tracks)
    for k in range(4):
        x0 = -3.2 + k * pw
        x1 = x0 + pw + (0.02 if k < 3 else 0.0)
        z0 = ZF - 0.05 if k % 2 == 0 else ZF - 0.01
        z1 = z0 + 0.035
        sk = ("-z",)
        mb.bb(x0, x0 + 0.045, 0.53, 2.42, z0, z1, timber, skip=sk)
        mb.bb(x1 - 0.045, x1, 0.53, 2.42, z0, z1, timber, skip=sk)
        mb.bb(x0, x1, 0.53, 0.8, z0, z1, timber, skip=sk)
        mb.bb(x0, x1, 2.36, 2.42, z0, z1, timber, skip=sk)
        for y in (1.35, 1.85):
            mb.bb(x0, x1, y - 0.0125, y + 0.0125, z0, z1, timber, skip=sk)
        gz = (z0 + z1) / 2
        mb.pdir([(x0 + 0.045, 0.8, gz), (x1 - 0.045, 0.8, gz), (x1 - 0.045, 2.36, gz), (x0 + 0.045, 2.36, gz)], K["glass"], (0, 0, 1))
    mb.bb(-3.2, 0.9, 0.46, 0.53, ZF - 0.07, ZF + 0.05, timber)               # 敷居
    mb.bb(-BX, BX, 2.42, 2.56, ZF - 0.07, ZF + 0.06, timber)                 # 鴨居
    mb.bb(-BX, BX, 2.56, YT, ZF - 0.02, ZF + 0.002, plaster)                 # 小壁
    for x in (-BX + 0.06, -3.2, 0.9, 1.3, 3.1, BX - 0.06):
        mb.bb(x - 0.06, x + 0.06, Y0, 2.56, ZF - 0.06, ZF + 0.06, timber)
    for sx in (-1, 1):
        mb.bb(sx * (BX - 0.06) - 0.065, sx * (BX - 0.06) + 0.065, Y0, YT, Z0 - 0.005, Z0 + 0.12, timber)
    # 濡れ縁 and 沓脱石
    mb.bb(-3.3, 0.95, 0.36, 0.41, ZF + 0.06, ZF + 0.5, wood2)
    for zl in (ZF + 0.17, ZF + 0.28, ZF + 0.39):
        mb.pdir([(-3.3, 0.4105, zl - 0.005), (0.95, 0.4105, zl - 0.005), (0.95, 0.4105, zl + 0.005), (-3.3, 0.4105, zl + 0.005)],
                timber, (0, 1, 0))
    for x in (-3.2, -1.8, -0.4, 0.85):
        mb.bb(x - 0.04, x + 0.04, 0.0, 0.36, ZF + 0.4, ZF + 0.48, timber)
    mb.bb(-1.75, -1.0, 0.0, 0.2, ZF + 0.58, ZF + 0.93, stone)
    # ── entrance 引き戸 (frosted, lattice), lit genkan behind, steps, 表札, bell, lamp
    mb.pdir([(1.36, 0.3, ZF + 0.003), (3.04, 0.3, ZF + 0.003), (3.04, 2.42, ZF + 0.003), (1.36, 2.42, ZF + 0.003)], K["lit"], (0, 0, 1))
    for x0, x1, z0 in ((1.36, 2.22, ZF + 0.005), (2.18, 3.04, ZF + 0.045)):
        z1 = z0 + 0.035
        mb.bb(x0, x0 + 0.05, 0.3, 2.42, z0, z1, timber)
        mb.bb(x1 - 0.05, x1, 0.3, 2.42, z0, z1, timber)
        mb.bb(x0, x1, 0.3, 0.9, z0, z1, timber)
        mb.bb(x0, x1, 2.36, 2.42, z0, z1, timber)
        mb.bb(x0, x1, 1.6, 1.625, z0, z1, timber)
        gz = (z0 + z1) / 2
        mb.pdir([(x0 + 0.05, 0.9, gz), (x1 - 0.05, 0.9, gz), (x1 - 0.05, 2.36, gz), (x0 + 0.05, 2.36, gz)], K["frosted"], (0, 0, 1))
        for i in range(1, 6):
            xx = x0 + 0.05 + (x1 - x0 - 0.1) * i / 6
            mb.pdir([(xx - 0.007, 0.9, z1 + 0.001), (xx + 0.007, 0.9, z1 + 0.001), (xx + 0.007, 2.36, z1 + 0.001),
                     (xx - 0.007, 2.36, z1 + 0.001)], timber, (0, 0, 1))
    mb.bb(1.15, 3.25, 0.0, 0.15, ZF, ZF + 0.75, stone)
    mb.bb(1.3, 3.1, 0.15, 0.28, ZF, ZF + 0.38, stone)
    with mb.at((1.1, 1.45, ZF)):
        kit_nameplate(mb, plate, K["ink"], 0.12, 0.3, 3)
    mb.bb(1.06, 1.14, 1.15, 1.27, ZF, ZF + 0.025, K["ac"])
    mb.bb(1.085, 1.115, 1.19, 1.22, ZF + 0.025, ZF + 0.03, K["black"])
    mb.bb(3.36, 3.4, 2.1, 2.32, ZF, ZF + 0.15, K["black"])
    mb.blob((3.38, 2.06, ZF + 0.16), (0.065, 0.075, 0.065), K["frosted"], segs=8, rings=5)
    mb.tube((3.38, 2.13, ZF + 0.16), (3.38, 2.16, ZF + 0.16), 0.04, K["black"], r1=0.02, sides=8)
    # ── clapboard walls (下見板)
    hgt = YT - Y0
    for sx in (-1, 1):
        x = sx * (BX + 0.002)
        clapboard(mb, lambda t, x=x: ((x, Y0 + hgt * t, Z0), (x, Y0 + hgt * t, ZF)), 12, (sx, 0, 0), wood, wood2)
    clapboard(mb, lambda t: ((BX, Y0 + hgt * t, Z0 - 0.002), (-BX, Y0 + hgt * t, Z0 - 0.002)), 12, (0, 0, -1), wood, wood2)
    for x0, x1 in ((0.96, 1.24), (3.16, 3.64)):
        clapboard(mb, lambda t, x0=x0, x1=x1: ((x0, Y0 + 1.92 * t, ZF + 0.002), (x1, Y0 + 1.92 * t, ZF + 0.002)), 10, (0, 0, 1),
                  wood, wood2)
    # windows with wooden lattice on the sides and the back
    W = BX + 0.025
    for pos, ry, w, h, inner in (((-W, 1.05, -1.2), -90, 0.9, 0.9, "frosted"), ((W, 1.05, 0.8), 90, 0.9, 0.9, "curtain"),
                                 ((-1.6, 1.0, Z0 - 0.025), 180, 1.2, 1.0, "curtain2"), ((1.8, 1.15, Z0 - 0.025), 180, 0.7, 0.7, "frosted")):
        with mb.at(pos, ry=ry):
            kit_window(mb, K, w, h, inner=inner, grille=True, simple=True, grille_m=timber)
    # foundation vents
    for pos, ry in (((-BX - 0.002, 0.25, -2.0), -90), ((-BX - 0.002, 0.25, 1.0), -90), ((BX + 0.002, 0.25, 1.2), 90),
                    ((BX + 0.002, 0.25, -2.2), 90), ((0.0, 0.25, Z0 - 0.002), 180), ((2.2, 0.25, ZF + 0.002), 0)):
        with mb.at(pos, ry=ry):
            mb.pdir([(-0.15, -0.06, 0.0), (0.15, -0.06, 0.0), (0.15, 0.06, 0.0), (-0.15, 0.06, 0.0)], vent_m, (0, 0, 1))
            for xx in (-0.075, 0.0, 0.075):
                mb.pdir([(xx - 0.01, -0.06, 0.002), (xx + 0.01, -0.06, 0.002), (xx + 0.01, 0.06, 0.002), (xx - 0.01, 0.06, 0.002)],
                        K["found"], (0, 0, 1))
    # ── 入母屋 roof
    t_g = 1.0 - zg / EZ
    ts = [t_g * i / 4 for i in range(4)] + [t_g + (1 - t_g) * i / 9 for i in range(10)]

    def xe(t):
        return EX - EZ * t if t <= t_g + 1e-9 else xb
    alt = (lambda i: roof2 if i % 4 == 3 else None)
    for sz in (1, -1):
        def edge(t, sz=sz):
            y = ye + (yr - ye) * t
            z = sz * EZ * (1 - t)
            return ((-xe(t), y, z), (xe(t), y, z))
        mb.tile_rows(edge, ts, 0.04, roof, alt_fn=alt)
    for sx in (1, -1):
        def edge_h(t, sx=sx):
            x = sx * (EX - (EX - xg) * t)
            y = ye + (yg - ye) * t
            zz = EZ - (EX - xg) * t
            return ((x, y, sx * zz), (x, y, -sx * zz))
        mb.tile_rows(edge_h, [i / 4 for i in range(5)], 0.04, roof, alt_fn=alt)
    # soffits (hip lines at 45°), rafters under the front eave, fascia
    ys = ye - 0.1
    ow_f, ow_b, ow_s = EZ - ZF, EZ + Z0, EX - BX
    mb.pdir([(-EX, ys, EZ), (EX, ys, EZ), (EX - ow_f, ys + ow_f * p, ZF), (-EX + ow_f, ys + ow_f * p, ZF)], soffit, (0, -1, 0))
    mb.pdir([(-EX, ys, -EZ), (EX, ys, -EZ), (EX - ow_b, ys + ow_b * p, Z0), (-EX + ow_b, ys + ow_b * p, Z0)], soffit, (0, -1, 0))
    for sx in (-1, 1):
        mb.pdir([(sx * EX, ys, -EZ), (sx * EX, ys, EZ), (sx * BX, ys + ow_s * p, EZ - ow_s), (sx * BX, ys + ow_s * p, -EZ + ow_s)],
                soffit, (0, -1, 0))
    x = -3.3
    while x <= 3.31:
        mb.beam((x, ys + ow_f * p - 0.045, ZF), (x, ys - 0.045, EZ - 0.03), 0.06, 0.08, rafter, caps=True)
        x += 0.55
    mb.bb(-EX, EX, ys - 0.07, ye + 0.03, EZ - 0.035, EZ, rafter)
    mb.bb(-EX, EX, ys - 0.07, ye + 0.03, -EZ, -EZ + 0.035, rafter)
    for sx in (-1, 1):
        mb.bb(min(sx * EX, sx * (EX - 0.035)), max(sx * EX, sx * (EX - 0.035)), ys - 0.07, ye + 0.03, -EZ, EZ, rafter)
    # gable walls (妻) with battens and a vent, barge boards, 懸魚
    for sx in (-1, 1):
        xw = sx * (xg - 0.05)
        top = yr - 0.08
        mb.pdir([(xw, yg - 0.02, -zg + 0.05), (xw, yg - 0.02, zg - 0.05), (xw, top, 0.0)], timber, (sx, 0, 0))
        for zb_ in (-1.6, -0.8, 0.0, 0.8, 1.6):
            yt_ = top - abs(zb_) * (top - yg) / (zg - 0.05)
            mb.pdir([(xw + sx * 0.003, yg, zb_ - 0.02), (xw + sx * 0.003, yg, zb_ + 0.02), (xw + sx * 0.003, yt_, zb_ + 0.02),
                     (xw + sx * 0.003, yt_, zb_ - 0.02)], wood2, (sx, 0, 0))
        mb.pdir([(xw + sx * 0.006, top - 0.55, -0.22), (xw + sx * 0.006, top - 0.55, 0.22), (xw + sx * 0.006, top - 0.32, 0.22),
                 (xw + sx * 0.006, top - 0.32, -0.22)], vent_m, (sx, 0, 0))
        for sz in (-1, 1):
            mb.beam((sx * xb, yg - 0.06, sz * (zg + 0.1)), (sx * xb, yr - 0.01, 0.0), 0.05, 0.26, timber)
            mb.beam((sx * (xb - 0.09), yg + 0.08, sz * (zg + 0.02)), (sx * (xb - 0.09), yr + 0.07, 0.0), 0.14, 0.11, ridge)
            mb.beam((sx * (EX - 0.07), ye + 0.1, sz * (EZ - 0.07)), (sx * xg, yg + 0.07, sz * zg), 0.15, 0.11, ridge)
        mb.beam((sx * xg, yg + 0.04, -zg), (sx * xg, yg + 0.04, zg), 0.1, 0.06, ridge)
        xf = sx * (xb + 0.03)
        mb.pdir([(xf, yr - 0.05, 0.0), (xf, yr - 0.2, 0.14), (xf, yr - 0.42, 0.1), (xf, yr - 0.42, -0.1), (xf, yr - 0.2, -0.14)],
                timber, (sx, 0, 0))
    # main ridge: stacked のし瓦 with plaster lines, round cap, 鬼瓦
    mb.bb(-xb, xb, yr - 0.04, yr + 0.18, -0.17, 0.17, ridge)
    mb.bb(-xb + 0.02, xb - 0.02, yr + 0.17, yr + 0.19, -0.175, 0.175, plaster)
    mb.bb(-xb + 0.05, xb - 0.05, yr + 0.19, yr + 0.32, -0.13, 0.13, ridge)
    mb.tube((-xb + 0.05, yr + 0.35, 0), (xb - 0.05, yr + 0.35, 0), 0.1, ridge, sides=6)
    for sx in (-1, 1):
        mb.bb(min(sx * (xb - 0.05), sx * (xb + 0.07)), max(sx * (xb - 0.05), sx * (xb + 0.07)), yr - 0.1, yr + 0.55, -0.22, 0.22, ridge)
    # copper gutter + downpipe at the front right
    mb.bb(-EX, EX, ys - 0.12, ys - 0.02, EZ, EZ + 0.1, gutter)
    mb.rope([(4.2, ys - 0.06, EZ + 0.05), (4.2, ys - 0.3, EZ + 0.05), (BX + 0.08, 1.9, ZF + 0.12), (BX + 0.08, 0.12, ZF + 0.12),
             (BX + 0.08, 0.04, ZF + 0.3)], 0.032, gutter, sides=6, smooth=False)
    # ── yard things: propane cylinders, laundry stand, bucket, old AC unit
    for z in (-1.1, -0.62):
        x = BX + 0.22
        mb.tube((x, 0.02, z), (x, 1.05, z), 0.17, propane, sides=8, caps=False)
        mb.tube((x, 1.05, z), (x, 1.13, z), 0.17, propane, r1=0.1, sides=8, caps=False, smooth=False)
        mb.tube((x, 1.13, z), (x, 1.26, z), 0.1, pcap, r1=0.085, sides=8)
        mb.tube((x, 0.0, z), (x, 0.05, z), 0.16, K["found"], sides=8, caps=False)
        mb.rope([(x, 1.26, z), (x - 0.1, 1.38, z), (BX + 0.03, 1.38, -0.86)], 0.008, K["black"], sides=4)
    mb.rope([(BX + 0.02, 0.85, -1.4), (BX + 0.42, 0.85, -1.15), (BX + 0.42, 0.85, -0.58), (BX + 0.02, 0.85, -0.32)], 0.008,
            K["metal"], sides=4)
    mb.bb(BX, BX + 0.08, 1.3, 1.46, -0.92, -0.8, K["meter"])
    for xs in (-4.2, -2.5):
        mb.bb(xs - 0.15, xs + 0.15, 0.0, 0.12, ZF + 0.6, ZF + 0.9, K["conc"])
        mb.tube((xs, 0.12, ZF + 0.75), (xs, 1.7, ZF + 0.75), 0.022, K["metal"], sides=6)
        mb.bb(xs - 0.12, xs + 0.12, 1.66, 1.7, ZF + 0.73, ZF + 0.77, K["metal"])
    mb.tube((-4.35, 1.72, ZF + 0.75), (-2.35, 1.72, ZF + 0.75), 0.02, lpole, sides=6)
    mb.tube((3.45, 0.0, 3.45), (3.45, 0.26, 3.45), 0.11, bucket, r1=0.135, sides=10, caps=False, smooth=False)
    mb.disc((3.45, 0.01, 3.45), 0.11, bucket, seg=10, normal="+y")
    mb.rope([(3.33, 0.25, 3.45), (3.38, 0.36, 3.45), (3.52, 0.36, 3.45), (3.57, 0.25, 3.45)], 0.005, K["metal"], sides=4)
    with mb.at((-W, 0.0, -2.3), ry=-90):
        kit_ac(mb, K)
    mb.build("house_old")


# ═══════════════════════════════════════════════════════════════════════════
#  run
# ═══════════════════════════════════════════════════════════════════════════
def _run(model_id, fn):
    run_model(model_id, fn)
    extra_views(model_id)


if only_requested("window_ext"):
    _run("window_ext", build_window_ext)
if only_requested("fluorescent_light"):
    _run("fluorescent_light", build_fluorescent_light)
if only_requested("mailbox_set"):
    _run("mailbox_set", build_mailbox_set)
if only_requested("ext_stairs"):
    _run("ext_stairs", build_ext_stairs)
if only_requested("vending_machine"):
    _run("vending_machine", build_vending_machine)
if only_requested("bulletin_board"):
    _run("bulletin_board", build_bulletin_board)
if only_requested("curve_mirror"):
    _run("curve_mirror", build_curve_mirror)
if only_requested("utility_pole"):
    _run("utility_pole", build_utility_pole)
if only_requested("garbage_station"):
    _run("garbage_station", build_garbage_station)
if only_requested("phone_booth"):
    _run("phone_booth", build_phone_booth)
if only_requested("road_barrier"):
    _run("road_barrier", build_road_barrier)
if only_requested("traffic_cone"):
    _run("traffic_cone", build_traffic_cone)
if only_requested("bicycle"):
    _run("bicycle", build_bicycle)
if only_requested("potted_plants"):
    _run("potted_plants", build_potted_plants)
if only_requested("house_a"):
    _run("house_a", build_house_a)
if only_requested("house_b"):
    _run("house_b", build_house_b)
if only_requested("house_c"):
    _run("house_c", build_house_c)
if only_requested("house_old"):
    _run("house_old", build_house_old)
