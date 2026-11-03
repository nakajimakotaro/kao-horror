"""「顔」 face_head — おもてさまの顔（体のない、白い人間の顔だけの仮面）.

Run (from the project root):
  Blender -b --factory-startup --python-exit-code 1 -P tools/blender/models/face.py -- --preview
  ... -P tools/blender/models/face.py -- --views /some/dir   # extra close-up renders for checking

public/models/face_head.glb contains
  face        the skin: a thin mask, open at the back. Front-projected UV (0..1), smooth shaded.
              The eye apertures are real holes with lid margins (the eyes never close), the mouth
              is a thin lens-shaped hole whose inner lip ring continues into `mouth_inner`.
  mouth_inner dark bag behind the lips (starts exactly on the inner lip ring of `face`).
  eye_L/eye_R eyeballs, origin = eyeball centre. three.js re-creates them with its own textured
              eyeballs (they rotate to follow the player) and only reads their position.

Coordinates are three.js metres: origin = centre of the face at the level of the nose root,
+Z = front, +Y = up. Roughly 1.4x life size (catalog box 0.26 x 0.34 x 0.18 incl. faded margins).

How the shape is made: the surface is the boundary of an implicit solid
    union( intersection(front relief z < Zface(x, y), head ellipsoid), lid spheres )
ray-cast from an interior point O, so every direction (theta, psi) hits it once. The relief
Zface is a mid-line profile with lateral curvature plus anatomical terms (brow ridge, deep
orbits, cheekbones, hollow cheeks, nose, thin lips, chin...). The mesh is a constrained
Delaunay triangulation of a graded point set in (theta, psi) space with the eye/mouth holes
as constraints; it is denser around the eyes, nose and mouth.

Constants marked SHARED are mirrored in src/game/face/FaceVisual.ts (morph targets, eyes,
fallback geometry). Keep them in sync.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import *  # noqa: E402,F401,F403
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils import geometry as mgeo  # noqa: E402

# ── SHARED constants (three.js metres) ─────────────────────────────────────────
EYE_X, EYE_Y, EYE_Z = 0.0435, -0.011, 0.031   # eyeball centre (+x eye; the other is mirrored)
EYE_R = 0.0175                                 # eyeball radius
LID_T = 0.0022                                 # lid thickness over the eyeball
AP_HW, AP_HU, AP_HL = 0.0168, 0.0115, 0.0085   # aperture half width / up / down (wide open)
MOUTH_Y, MOUTH_HW, MOUTH_GAP = -0.0966, 0.033, 0.0007
UV_W, UV_Y0, UV_H = 0.26, -0.19, 0.34          # u = 0.5 + x / UV_W, v = (y - UV_Y0) / UV_H

# ray-cast centre and parameter scale
O = np.array([0.0, -0.02, -0.03])
RHO = 0.13

# ── small math helpers (numpy, vectorised) ─────────────────────────────────────


def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def g2(x, y, cx, cy, sx, sy):
    return np.exp(-((x - cx) / sx) ** 2 - ((y - cy) / sy) ** 2)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1.0 - h) + a * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def hermite_table(pts):
    pts = sorted(pts)
    ys = np.array([p[0] for p in pts], dtype=float)
    vs = np.array([p[1] for p in pts], dtype=float)
    m = np.zeros_like(vs)
    m[1:-1] = (vs[2:] - vs[:-2]) / (ys[2:] - ys[:-2])
    m[0] = (vs[1] - vs[0]) / (ys[1] - ys[0])
    m[-1] = (vs[-1] - vs[-2]) / (ys[-1] - ys[-2])
    return ys, vs, m


def spl(tab, y):
    ys, vs, m = tab
    y = np.clip(y, ys[0], ys[-1])
    i = np.clip(np.searchsorted(ys, y) - 1, 0, len(ys) - 2)
    h = ys[i + 1] - ys[i]
    t = (y - ys[i]) / h
    t2 = t * t
    t3 = t2 * t
    return ((2 * t3 - 3 * t2 + 1) * vs[i] + (t3 - 2 * t2 + t) * h * m[i]
            + (-2 * t3 + 3 * t2) * vs[i + 1] + (t3 - t2) * h * m[i + 1])


def seg_groove(px, py, a, b, w):
    """1 on the segment a-b (fading to 0 at both ends), gaussian falloff of width w."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = np.clip(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0.0, 1.0)
    qx = a[0] + t * dx - px
    qy = a[1] + t * dy - py
    return np.exp(-(qx * qx + qy * qy) / (w * w)) * np.sqrt(np.sin(np.pi * t))


# ── the shape ──────────────────────────────────────────────────────────────────
# mid-line profile of the face "plane" (no nose / lips): (y, z)
PROFILE = hermite_table([
    (0.200, -0.060), (0.170, -0.018), (0.150, 0.012), (0.125, 0.036), (0.100, 0.052),
    (0.075, 0.061), (0.045, 0.066), (0.020, 0.067), (0.006, 0.065), (-0.010, 0.060),
    (-0.030, 0.058), (-0.050, 0.059), (-0.070, 0.060), (-0.085, 0.058), (-0.097, 0.056),
    (-0.108, 0.057), (-0.120, 0.054), (-0.135, 0.058), (-0.148, 0.051), (-0.158, 0.036),
    (-0.168, 0.013), (-0.180, -0.018), (-0.200, -0.060),
])
# lateral curvature: z -= a(y) * x^2
CURV = hermite_table([
    (0.200, 7.0), (0.150, 6.0), (0.100, 5.0), (0.050, 4.2), (0.012, 4.0), (-0.011, 3.2),
    (-0.035, 2.0), (-0.060, 2.4), (-0.097, 5.0), (-0.120, 5.5), (-0.140, 8.0),
    (-0.160, 10.0), (-0.200, 10.0),
])


def nose(x, y):
    ax = np.abs(x)
    t = np.clip((-0.002 - y) / 0.048, 0.0, 1.0)            # 0 = nasion .. 1 = tip
    h = (0.0035 + 0.0225 * t ** 1.35) * (1.0 - ss(-0.050, -0.071, y)) * ss(0.012, 0.0, y)
    w = 0.0060 + 0.0050 * t
    ridge = h * np.exp(-(ax / w) ** 2.2)
    tip = 0.0055 * g2(ax, y, 0.0, -0.0485, 0.0105, 0.0095)
    alae = 0.0085 * g2(ax, y, 0.0185, -0.0600, 0.0072, 0.0062)
    er = np.sqrt(((ax - 0.019) / 0.0098) ** 2 + ((y + 0.0598) / 0.0088) ** 2)
    crease = -0.0013 * np.exp(-((er - 1.0) / 0.22) ** 2) * ss(-0.072, -0.060, y)
    nostril = -0.0030 * g2(ax, y, 0.0085, -0.0645, 0.0035, 0.0026)
    return ridge + tip + alae + crease + nostril


def mouth_line(x):
    tt = np.clip(np.abs(x) / MOUTH_HW, 0.0, 1.0)
    return MOUTH_Y - 0.0008 * tt * tt


def lip_heights(x):
    """Mouth line y0, upper / lower vermilion heights, lateral thinning factor (SHARED)."""
    ax = np.abs(x)
    tt = np.clip(ax / MOUTH_HW, 0.0, 1.0)
    inside = np.clip(1.0 - tt * tt, 0.0, 1.0)
    k = np.sqrt(inside)
    hu = 0.0074 * k + 0.0012 * np.exp(-((ax - 0.0078) / 0.0045) ** 2) * inside \
        - 0.0009 * np.exp(-(x / 0.0032) ** 2) + 0.0004
    hl = 0.0102 * k + 0.0004
    return mouth_line(x), hu, hl, k


def lips(x, y):
    ax = np.abs(x)
    y0, hu, hl, k = lip_heights(x)
    su = (y - y0) / hu
    # upper lip: most forward at the vermilion border, sloping back to the lip line
    up = np.where(su <= 0.78, np.sin(0.5 * np.pi * np.clip(su / 0.78, 0, 1)) ** 0.8,
                  np.exp(-((su - 0.78) / 0.30) ** 2))
    up = np.where(su < 0, 0.0, up)
    sl = (y0 - y) / hl
    # lower lip: fuller in the middle, a shadow fold under it
    lo = np.where((sl >= 0) & (sl <= 1), np.sin(np.pi * np.clip(sl, 0, 1) ** 0.85), 0.0)
    lo -= 0.30 * np.exp(-((sl - 1.22) / 0.22) ** 2)
    z = (0.0034 * up + 0.0040 * lo) * k
    z -= 0.0022 * np.exp(-((y - y0) / 0.0014) ** 2) * k               # lips curl inwards
    z -= 0.0022 * g2(ax, y, MOUTH_HW + 0.0015, y0, 0.0045, 0.0042)    # corners
    # philtrum columns and groove
    top, bot = -0.0705, MOUTH_Y + 0.0078
    py_ = np.clip((y - bot) / (top - bot), 0.0, 1.0)
    inph = (y < top) & (y > bot)
    cols = 0.0008 * np.exp(-((ax - (0.0050 + 0.0012 * (1 - py_))) / 0.0018) ** 2)
    groove = -0.0006 * np.exp(-(x / 0.0030) ** 2)
    z += np.where(inph, (cols + groove) * np.sqrt(np.sin(np.pi * py_)), 0.0)
    return z


def lid_z(dx, dy):
    """Front of the lid sphere; continued steeply downwards outside its disc (continuous)."""
    rl = EYE_R + LID_T
    r = np.sqrt(dx * dx + dy * dy)
    return EYE_Z + np.where(r < rl, np.sqrt(np.maximum(rl * rl - r * r, 0.0)), -2.0 * (r - rl))


def carve_eyes(x, y, z):
    """Keep the relief behind the lid sphere just around the apertures (the lid must be on top)."""
    for sx in (1.0, -1.0):
        dx = x - sx * EYE_X
        dy = y - EYE_Y
        e = np.sqrt((dx / AP_HW) ** 2 + (dy / np.where(dy > 0, AP_HU, AP_HL)) ** 2)
        w = 1.0 - ss(1.0, 1.32, e)
        a = z - (lid_z(dx, dy) - 0.0022)
        z = z - w * 0.5 * (a + np.sqrt(a * a + 0.0012 ** 2))
    return z


def zface(x, y):
    ax = np.abs(x)
    z = spl(PROFILE, y) - spl(CURV, y) * x * x
    z += 0.0025 * g2(ax, y, 0.030, 0.062, 0.020, 0.025)               # frontal eminences
    z += 0.0060 * g2(ax, y, 0.038, 0.012, 0.024, 0.0065)              # brow ridge
    z += 0.0020 * g2(ax, y, 0.000, 0.008, 0.012, 0.007)               # glabella
    sx = np.where(ax < EYE_X, 0.022, 0.019)
    z -= 0.022 * np.exp(-((ax - EYE_X) / sx) ** 2 - ((y - EYE_Y - 0.002) / 0.0158) ** 2)  # orbits
    z -= 0.0045 * g2(ax, y, EYE_X - 0.003, EYE_Y + 0.0135, 0.016, 0.0060)  # sunken upper lid
    z -= 0.008 * g2(ax, y, 0.024, EYE_Y - 0.001, 0.0065, 0.009)        # medial canthus
    z -= 0.0035 * seg_groove(ax, y, (0.030, EYE_Y - 0.010), (0.056, EYE_Y - 0.023), 0.004)  # tear trough
    z += 0.0095 * g2(ax, y, 0.057, -0.036, 0.020, 0.0125)             # cheekbones
    z += 0.0060 * g2(ax, y, 0.080, -0.028, 0.012, 0.010)              # zygomatic arch
    z -= 0.0085 * g2(ax, y, 0.064, -0.082, 0.017, 0.021)              # hollow cheeks
    z -= 0.0090 * g2(ax, y, 0.074, 0.034, 0.016, 0.022)               # temples
    z += 0.0065 * g2(ax, y, 0.0, -0.095, 0.034, 0.030)                # teeth arch
    z += 0.0060 * g2(ax, y, 0.0, -0.137, 0.017, 0.011)                # chin
    z -= 0.0025 * g2(ax, y, 0.0, -0.117, 0.020, 0.0042)               # mentolabial sulcus
    z -= 0.0030 * seg_groove(ax, y, (0.025, -0.064), (0.043, -0.108), 0.0028)  # nasolabial fold
    z += 0.0020 * seg_groove(ax, y, (0.033, -0.062), (0.051, -0.100), 0.007)   # cheek over it
    z += nose(x, y) + lips(x, y)
    return carve_eyes(x, y, z)


def shape_f(p):
    """Implicit solid: < 0 inside."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    f_front = z - zface(x, y)
    a = 0.118 * (1.0 - 0.20 * ss(-0.05, -0.16, y) - 0.05 * ss(0.06, 0.15, y))
    f_head = (np.sqrt((x / a) ** 2 + ((y + 0.01) / 0.175) ** 2 + ((z + 0.04) / 0.15) ** 2) - 1.0) * 0.11
    f = smax(f_front, f_head, 0.012)
    for sx in (1.0, -1.0):
        e = np.sqrt((x - sx * EYE_X) ** 2 + (y - EYE_Y) ** 2 + (z - EYE_Z) ** 2) - (EYE_R + LID_T)
        f = smin(f, e, 0.006)
    return f


# ── parameter space: sinusoidal (theta, psi) around O, scaled by RHO ──────────
def dirs(uv):
    psi = uv[:, 1] / RHO
    cp = np.cos(psi)
    th = (uv[:, 0] / RHO) / np.maximum(cp, 1e-3)
    return np.stack([np.sin(th) * cp, np.sin(psi), np.cos(th) * cp], -1)


def to_param(p):
    q = np.asarray(p, dtype=float) - O
    th = np.arctan2(q[:, 0], q[:, 2])
    psi = np.arctan2(q[:, 1], np.hypot(q[:, 0], q[:, 2]))
    return np.stack([th * np.cos(psi) * RHO, psi * RHO], -1)


def lift(uv):
    d = dirs(uv)
    n = len(d)
    tmax, steps = 0.30, 300
    dt = tmax / steps
    hit = np.full(n, np.nan)
    for i in range(steps + 1):
        t = tmax - i * dt
        todo = np.isnan(hit)
        if not todo.any():
            break
        f = shape_f(O + d[todo] * t)
        idx = np.nonzero(todo)[0][f < 0]
        hit[idx] = t
    hit = np.nan_to_num(hit, nan=0.0)
    lo, hi = hit.copy(), hit + dt
    for _ in range(32):
        mid = 0.5 * (lo + hi)
        inside = shape_f(O + d * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return O + d * (0.5 * (lo + hi))[:, None]


# ── loops (holes and the outer rim) ───────────────────────────────────────────
DOM_UM, DOM_VM, DOM_VC = 0.236, 0.182, -0.010


def aperture_xy(n, hu=AP_HU, hl=AP_HL, hw=AP_HW):
    """Almond of the wide-open eye around the eye centre, CCW, starting at the lateral corner."""
    out = []
    for i in range(n):
        a = 2.0 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        x = hw * c
        if s >= 0:
            y = hu * (1.0 - c * c) ** 0.56 * (1.0 - 0.10 * c)      # peak a little to the nose side
        else:
            y = -hl * (1.0 - c * c) ** 0.62 * (1.0 + 0.08 * c)     # lowest a little to the outside
        out.append((x, y))
    return out


def eye_loop(sx, n=32):
    pts = []
    for (x, y) in aperture_xy(n):
        px, py = sx * EYE_X + sx * x, EYE_Y + y
        lz = lid_z(np.array(px - sx * EYE_X), np.array(py - EYE_Y))
        pts.append((px, py, float(lz)))
    if sx < 0:      # mirrored -> keep CCW (seen from the front)
        pts = [pts[0]] + pts[1:][::-1]
    return pts


def mouth_loop(n_half=20):
    """Thin lens, CCW seen from the front: lower edge left->right, upper edge right->left."""
    xs = [MOUTH_HW * (-math.cos(math.pi * i / n_half)) for i in range(n_half + 1)]
    pts = []
    for x in xs:                                   # lower edge incl. both corners
        t = abs(x) / MOUTH_HW
        gap = MOUTH_GAP * max(0.0, 1.0 - t * t) ** 0.8
        y = float(mouth_line(np.array(x))) - gap
        pts.append((x, y))
    for x in xs[1:-1][::-1]:                       # upper edge back
        t = abs(x) / MOUTH_HW
        gap = MOUTH_GAP * max(0.0, 1.0 - t * t) ** 0.8
        y = float(mouth_line(np.array(x))) + gap
        pts.append((x, y))
    xy = np.array(pts)
    z = zface(xy[:, 0], xy[:, 1])
    return [(float(a), float(b), float(c)) for (a, b), c in zip(pts, z)]


def outer_loop(n=84):
    return [(DOM_UM * math.sin(2 * math.pi * i / n), DOM_VC - DOM_VM * math.cos(2 * math.pi * i / n))
            for i in range(n)]


def lip_lines(n=15):
    """Feature polylines (vermilion borders, fullest line of each lip) for the triangulation."""
    out = []
    for frac, sign, span in ((1.0, 1.0, 0.86), (0.55, 1.0, 0.70), (1.0, -1.0, 0.86), (0.55, -1.0, 0.72)):
        xs = np.linspace(-span * MOUTH_HW, span * MOUTH_HW, n)
        y0, hu, hl, _k = lip_heights(xs)
        ys = y0 + sign * frac * (hu if sign > 0 else hl)
        zs = zface(xs, ys)
        out.append([(float(a), float(b), float(c)) for a, b, c in zip(xs, ys, zs)])
    return out


def dist_to_line(pts, line):
    d = np.full(len(pts), 1e9)
    for i in range(len(line) - 1):
        a = np.array(line[i])
        b = np.array(line[i + 1])
        ab = b - a
        t = np.clip(((pts - a) @ ab) / max(ab @ ab, 1e-14), 0, 1)
        q = a + t[:, None] * ab
        d = np.minimum(d, np.linalg.norm(pts - q, axis=1))
    return d


def point_in_poly(pts, poly):
    """pts (N,2), poly list of (x,y). Even-odd rule."""
    x, y = pts[:, 0], pts[:, 1]
    inside = np.zeros(len(pts), dtype=bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = ((y1 > y) != (y2 > y))
        xint = (x2 - x1) * (y - y1) / ((y2 - y1) if y2 != y1 else 1e-12) + x1
        inside ^= cond & (x < xint)
    return inside


def dist_to_loop(pts, poly):
    d = np.full(len(pts), 1e9)
    n = len(poly)
    for i in range(n):
        a = np.array(poly[i])
        b = np.array(poly[(i + 1) % n])
        ab = b - a
        t = np.clip(((pts - a) @ ab) / max(ab @ ab, 1e-14), 0, 1)
        q = a + t[:, None] * ab
        d = np.minimum(d, np.linalg.norm(pts - q, axis=1))
    return d


# ── sizing (target edge length, metres on the surface) ────────────────────────
def size3d(p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    ax = np.abs(x)
    h = np.full(len(p), 0.021)
    eo = np.sqrt((ax / 0.090) ** 2 + ((y + 0.028) / 0.130) ** 2)
    h = np.minimum(h, 0.0090 + 0.07 * np.maximum(0.0, eo - 1.0))
    de = np.sqrt(((ax - EYE_X) / 1.2) ** 2 + (y - EYE_Y) ** 2)
    h = np.minimum(h, 0.0031 + 0.30 * np.maximum(0.0, de - 0.018))
    dnx = np.maximum(0.0, ax - 0.022)
    dny = np.maximum(0.0, np.maximum(y - 0.0, -0.072 - y))
    h = np.minimum(h, 0.0042 + 0.30 * np.hypot(dnx, dny))
    h = np.minimum(h, 0.0034 + 0.30 * np.maximum(0.0, np.hypot(ax / 1.3, y + 0.052) - 0.012))   # nose tip
    dmx = np.maximum(0.0, ax - 0.040)
    dmy = np.maximum(0.0, np.abs(y - MOUTH_Y) - 0.014)
    h = np.minimum(h, 0.0038 + 0.30 * np.hypot(dmx, dmy))
    h = np.where(z < 0.0, np.maximum(h, 0.014), h)
    return h


def build_sizer():
    nu, nv = 72, 56
    us = np.linspace(-DOM_UM * 1.02, DOM_UM * 1.02, nu)
    vs = np.linspace(DOM_VC - DOM_VM * 1.02, DOM_VC + DOM_VM * 1.02, nv)
    uu, vv = np.meshgrid(us, vs)
    uv = np.stack([uu.ravel(), vv.ravel()], -1)
    p = lift(uv)
    hp = size3d(p) * RHO / np.linalg.norm(p - O, axis=1)
    grid = hp.reshape(nv, nu)

    def h_at(u, v):
        fu = (u - us[0]) / (us[-1] - us[0]) * (nu - 1)
        fv = (v - vs[0]) / (vs[-1] - vs[0]) * (nv - 1)
        i = int(min(max(math.floor(fu), 0), nu - 2))
        j = int(min(max(math.floor(fv), 0), nv - 2))
        a, b = min(max(fu - i, 0.0), 1.0), min(max(fv - j, 0.0), 1.0)
        return ((1 - a) * (1 - b) * grid[j, i] + a * (1 - b) * grid[j, i + 1]
                + (1 - a) * b * grid[j + 1, i] + a * b * grid[j + 1, i + 1])
    return h_at


def quadtree(u0, v0, size, h_at, out, rng, depth=0):
    cu, cv = u0 + size / 2, v0 + size / 2
    if depth < 11 and size > 1.35 * h_at(cu, cv):
        h2 = size / 2
        for a, b in ((0, 0), (h2, 0), (0, h2), (h2, h2)):
            quadtree(u0 + a, v0 + b, h2, h_at, out, rng, depth + 1)
    else:
        j = size * 0.2
        out.append((cu + rng.uniform(-j, j), cv + rng.uniform(-j, j), size))


# ── mesh assembly ─────────────────────────────────────────────────────────────
def triangulate(loops2d, interior, lines2d=()):
    verts = []
    edges = []
    for loop in loops2d:
        base = len(verts)
        verts.extend(loop)
        n = len(loop)
        edges.extend((base + i, base + (i + 1) % n) for i in range(n))
    for line in lines2d:
        base = len(verts)
        verts.extend(line)
        edges.extend((base + i, base + i + 1) for i in range(len(line) - 1))
    nb = len(verts)
    verts.extend(interior)
    res = mgeo.delaunay_2d_cdt([Vector(v) for v in verts], edges, [], 0, 1e-7, True)
    out_v, _e, out_f, orig_v = res[0], res[1], res[2], res[3]
    remap = {}
    for oi, origs in enumerate(orig_v):
        for k in origs:
            remap[k] = oi
    return [(v.x, v.y) for v in out_v], out_f, remap, nb


def relax(verts, faces, fixed, keep_out, iters=1):
    v = np.array(verts)
    nbr = [set() for _ in range(len(v))]
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            nbr[a].add(b)
            nbr[b].add(a)
    for _ in range(iters):
        nv = v.copy()
        for i in range(len(v)):
            if i in fixed or not nbr[i]:
                continue
            m = v[list(nbr[i])].mean(axis=0)
            nv[i] = v[i] * 0.45 + m * 0.55
        v = nv
    return [tuple(p) for i, p in enumerate(v) if i not in fixed and keep_out(p)]


def build_face():
    rng = np.random.default_rng(7)
    h_at = build_sizer()

    eyeL = eye_loop(1.0)
    eyeR = eye_loop(-1.0)
    mouth = mouth_loop()
    holes3d = [eyeL, eyeR, mouth]
    holes2d = [[tuple(q) for q in to_param(np.array(h))] for h in holes3d]
    outer = outer_loop()
    lines3d = lip_lines()
    lines2d = [[tuple(q) for q in to_param(np.array(L))] for L in lines3d]

    # graded interior points on the +u half, mirrored
    raw = []
    quadtree(0.0, DOM_VC - DOM_VM, 2 * DOM_VM, h_at, raw, rng)     # u in [0, 2*VM] covers [0, UM]
    pts = []
    for (u, v, s) in raw:
        if u < 0.3 * s:
            pts.append((0.0, v))
        else:
            pts.append((u, v))
            pts.append((-u, v))
    pts = np.array(pts)

    def keep_out(p):
        p = np.atleast_2d(np.asarray(p))
        hloc = np.array([h_at(a, b) for a, b in p])
        ok = ((p[:, 0] / DOM_UM) ** 2 + ((p[:, 1] - DOM_VC) / DOM_VM) ** 2) < 1.0
        ok &= dist_to_loop(p, outer) > 0.6 * hloc
        for h in holes2d:
            ok &= ~point_in_poly(p, h)
            ok &= dist_to_loop(p, h) > 0.6 * hloc
        for L in lines2d:
            ok &= dist_to_line(p, L) > 0.55 * hloc
        return ok

    pts = pts[keep_out(pts)]
    loops2d = holes2d + [outer]
    interior = [tuple(p) for p in pts]
    for _ in range(2):
        verts, faces, remap, nb = triangulate(loops2d, interior, lines2d)
        fixed = set(remap[k] for k in range(nb) if k in remap)
        relaxed = relax(verts, faces, fixed, lambda p: True)
        arr = np.array(relaxed)
        arr = arr[keep_out(arr)]
        interior = [tuple(p) for p in arr]
    verts, faces, remap, nb = triangulate(loops2d, interior, lines2d)

    # keep triangles inside the outer loop and outside the holes
    V2 = np.array(verts)
    tris = [f for f in faces if len(f) == 3]
    cent = np.array([V2[list(f)].mean(axis=0) for f in tris])
    ok = point_in_poly(cent, outer)
    for h in holes2d:
        ok &= ~point_in_poly(cent, h)
    tris = [t for t, k in zip(tris, ok) if k]

    # lift; loop vertices use their exact 3D positions
    P = lift(V2)
    base = 0
    for loop3 in holes3d + [outer] + lines3d:
        if loop3 is outer:
            base += len(outer)
            continue
        for i, p in enumerate(loop3):
            oi = remap.get(base + i)
            if oi is not None:
                P[oi] = p
        base += len(loop3)
    loop_idx = []
    base = 0
    for loop in loops2d:
        loop_idx.append([remap[base + i] for i in range(len(loop))])
        base += len(loop)

    used = sorted(set(i for t in tris for i in t))
    newi = {o: n for n, o in enumerate(used)}
    verts3 = [tuple(P[o]) for o in used]
    faces = [tuple(newi[i] for i in t) for t in tris]
    loop_idx = [[newi[i] for i in L] for L in loop_idx]

    # lid margins: two rings into the eyeball (the second is hidden inside it)
    for li, sx in ((0, 1.0), (1, -1.0)):
        E = np.array([sx * EYE_X, EYE_Y, EYE_Z])
        L = loop_idx[li]
        r1, r2 = [], []
        for vi in L:
            b = np.array(verts3[vi])
            d = (b - E) / np.linalg.norm(b - E)
            r1.append(len(verts3))
            verts3.append(tuple(E + d * (EYE_R + 0.0005)))
            r2.append(len(verts3))
            verts3.append(tuple(E + d * (EYE_R - 0.0012)))
        n = len(L)
        for i in range(n):
            j = (i + 1) % n
            faces.append((L[i], L[j], r1[j], r1[i]))
            faces.append((r1[i], r1[j], r2[j], r2[i]))

    # inner lips: one ring curling back towards the lip line
    L = loop_idx[2]
    inner = []
    for vi in L:
        x, y, z = verts3[vi]
        y0 = float(mouth_line(np.array(x)))
        t = abs(x) / MOUTH_HW
        inner.append(len(verts3))
        verts3.append((x * 0.975, y0 + (y - y0) * 0.35, z - 0.0042 * (1.0 - 0.45 * t * t)))
    n = len(L)
    for i in range(n):
        j = (i + 1) % n
        faces.append((L[i], L[j], inner[j], inner[i]))

    report(verts3, faces, holes3d)
    skin = mesh_from("face", verts3, faces, mat("tex_face", "#d9d6cf", 0.55))
    set_uv_front(skin)
    shade_smooth(skin)

    # mouth bag: rings going back from the inner lip ring, then a cap
    ring0 = [verts3[i] for i in inner]
    bag_v = list(ring0)
    bag_f = []
    prev = list(range(len(ring0)))
    for (sxk, infl, dz) in ((0.92, 0.0045, 0.007), (0.74, 0.0105, 0.019), (0.46, 0.009, 0.033)):
        cur = []
        for (x, y, z) in ring0:
            y0 = float(mouth_line(np.array(x)))
            t = abs(x) / MOUTH_HW
            side = 1.0 if y > y0 + 1e-6 else (-1.0 if y < y0 - 1e-6 else 0.0)
            prof = max(0.0, 1.0 - t * t) ** 0.5
            cur.append(len(bag_v))
            bag_v.append((x * sxk, y0 + (y - y0) + side * prof * infl, z - dz))
        for i in range(len(cur)):
            j = (i + 1) % len(cur)
            bag_f.append((prev[i], prev[j], cur[j], cur[i]))
        prev = cur
    cz = sum(bag_v[i][2] for i in prev) / len(prev) - 0.006
    c = len(bag_v)
    bag_v.append((0.0, MOUTH_Y, cz))
    for i in range(len(prev)):
        j = (i + 1) % len(prev)
        bag_f.append((prev[i], prev[j], c))
    bag = mesh_from("mouth_inner", bag_v, bag_f, mat("face_inner", "#0b0708", 0.9))
    set_uv_front(bag)
    shade_smooth(bag)

    # eyeballs (origin at the centre; front pole = iris)
    for name, sx in (("eye_L", 1.0), ("eye_R", -1.0)):
        e = eyeball(name)
        e.location = T(sx * EYE_X, EYE_Y, EYE_Z)

    return skin


def report(verts3, faces, holes3d):
    """Print boundary loops and whether the hole edges are on the outer surface."""
    from collections import Counter
    cnt = Counter()
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            cnt[(min(a, b), max(a, b))] += 1
    bnd = [e for e, c in cnt.items() if c == 1]
    bad = [e for e, c in cnt.items() if c > 2]
    adj = {}
    for a, b in bnd:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, loops = set(), []
    for v in adj:
        if v in seen:
            continue
        stack, comp = [v], 0
        while stack:
            u = stack.pop()
            if u in seen:
                continue
            seen.add(u)
            comp += 1
            stack.extend(adj[u])
        loops.append(comp)
    print(f"[face] verts={len(verts3)} faces={len(faces)} boundary loops={sorted(loops)} nonmanifold={len(bad)}")
    for li, sx in ((0, 1.0), (1, -1.0)):
        E = np.array([sx * EYE_X, EYE_Y, EYE_Z])
        b = np.array(holes3d[li])
        n = (b - E) / np.linalg.norm(b - E, axis=1)[:, None]
        f_out = shape_f(b + n * 0.0006)
        print(f"[face] eye{li} boundary: outside-probe min f={f_out.min():.5f} (should be > 0)")
    b = np.array(holes3d[2])
    f_out = shape_f(b + np.array([0, 0, 0.0006]))
    print(f"[face] mouth boundary: outside-probe min f={f_out.min():.5f}")


def set_uv_front(obj):
    me = obj.data
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co      # blender coords (x, -z, y)
            x, y = co.x, co.z
            uv.data[li].uv = (min(1.0, max(0.0, 0.5 + x / UV_W)), min(1.0, max(0.0, (y - UV_Y0) / UV_H)))


def eyeball(name, segs=12, rings=8):
    """UV sphere around its own origin with the pole on +Z (three). Front-planar UV."""
    verts = [(0.0, 0.0, EYE_R)]
    for r in range(1, rings):
        a = math.pi * r / rings
        for s in range(segs):
            b = 2 * math.pi * s / segs
            verts.append((EYE_R * math.sin(a) * math.cos(b), EYE_R * math.sin(a) * math.sin(b), EYE_R * math.cos(a)))
    verts.append((0.0, 0.0, -EYE_R))
    faces = []
    for s in range(segs):
        faces.append((0, 1 + s, 1 + (s + 1) % segs))
    for r in range(rings - 2):
        o0 = 1 + r * segs
        o1 = o0 + segs
        for s in range(segs):
            s2 = (s + 1) % segs
            faces.append((o0 + s, o1 + s, o1 + s2, o0 + s2))
    last = len(verts) - 1
    o0 = 1 + (rings - 2) * segs
    for s in range(segs):
        faces.append((o0 + s, last, o0 + (s + 1) % segs))
    m_white = mat("face_eye", "#d8d2bc", 0.2)
    m_iris = mat("face_iris", "#120d0c", 0.2)
    obj = mesh_from(name, verts, faces, m_white)
    obj.data.materials.append(m_iris)
    for poly in obj.data.polygons:
        c = poly.center      # blender coords; three z = -blender y
        if -c.y > EYE_R * 0.86:
            poly.material_index = 1
    me = obj.data
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (0.5 + co.x / (2 * EYE_R), 0.5 + co.z / (2 * EYE_R))
    shade_smooth(obj)
    return obj


# ── checking renders ──────────────────────────────────────────────────────────
def render_views(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    scn = bpy.context.scene
    cam_data = bpy.data.cameras.new("vcam")
    cam = bpy.data.objects.new("vcam", cam_data)
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam_data.lens = 85
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "STUDIO"
    scn.display.shading.color_type = "MATERIAL"
    scn.display.shading.show_cavity = True
    scn.render.resolution_x = 560
    scn.render.resolution_y = 640
    tgt = T(0.0, -0.025, 0.02)
    views = {
        "front": (0.0, -0.025, 0.95),
        "q34": (0.55, 0.05, 0.75),
        "side": (0.95, -0.025, 0.02),
        "low": (0.12, -0.45, 0.80),
    }
    for name, (x, y, z) in views.items():
        eye = T(x, y, z)
        cam.location = eye
        cam.rotation_euler = (tgt - eye).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = os.path.join(out_dir, f"face_{name}.png")
        bpy.ops.render.render(write_still=True)

    # flashlight look: one spot light next to the camera, black world (like the game at night)
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scn.render.engine = eng
            break
        except TypeError:
            continue
    world = bpy.data.worlds.new("dark")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.0, 0.0, 0.0, 1.0)
        bg.inputs[1].default_value = 0.0
    scn.world = world
    ld = bpy.data.lights.new("flash", "SPOT")
    ld.energy = 6.0
    ld.spot_size = 1.0
    ld.spot_blend = 0.6
    lamp = bpy.data.objects.new("flash", ld)
    scn.collection.objects.link(lamp)
    shots = {
        "flash_front": ((0.0, 0.05, 0.85), (0.10, -0.12, 0.0), T(0.0, -0.03, 0.03)),
        "flash_close": ((0.0, -0.01, 0.42), (0.08, -0.10, 0.0), T(0.0, -0.03, 0.04)),
        "flash_high": ((0.25, 0.55, 0.65), (0.10, -0.10, 0.0), T(0.0, -0.03, 0.03)),
        "flash_mouth": ((0.20, -0.08, 0.36), (0.06, 0.10, 0.0), T(0.0, -0.095, 0.05)),
        "flash_profile": ((0.40, -0.06, 0.06), (0.0, 0.10, 0.10), T(0.0, -0.07, 0.05)),
    }
    for name, (cpos, loff, target) in shots.items():
        eye = T(*cpos)
        cam.location = eye
        cam.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()
        lamp.location = T(cpos[0] + loff[0], cpos[1] + loff[1], cpos[2] + loff[2])
        lamp.rotation_euler = (target - lamp.location).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = os.path.join(out_dir, f"face_{name}.png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(lamp)


if only_requested("face_head"):
    run_model("face_head", build_face)
    if "--views" in sys.argv:
        i = sys.argv.index("--views")
        render_views(sys.argv[i + 1])
