import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FaceOptions } from './FaceSystem';

export interface FaceVisualState {
  /** 0..1 how close to lethal the stare is */
  gaze: number;
  /** 0..1 flashlight on it */
  lit: number;
  dist: number;
  time: number;
}

export interface FaceVisual {
  object: THREE.Object3D;
  update(dt: number, s: FaceVisualState): void;
  setFade(a: number): void;
  setScream(on: boolean): void;
  dispose(): void;
}

/*
 * 「顔」— おもてさま. A pale, bodiless human face: a thin mask (open at the back) with real eye
 * holes, wet eyeballs that never close and follow the player, and a mouth that can open.
 *
 *  - Geometry: public/models/face_head.glb (tools/blender/models/face.py). Until it is loaded, or
 *    if it is missing, the same surface is built here procedurally (buildFallbackGeometry).
 *  - Look: one shared painted canvas texture for the skin and one for the eyeballs; per-vertex
 *    occlusion + edge fade baked from the geometry; MeshStandardMaterial that is mostly emissive
 *    (it glows faintly in the dark) and gets real light from the flashlight.
 *  - Expressions are morph targets computed here from the rest shape (works for both geometries):
 *    smile L/R, jaw open, eyes wide, scream stretch.
 *
 * Coordinates: face-local metres, origin = centre of the face at the nose root, +Z = front.
 */

// ── SHARED with tools/blender/models/face.py ─────────────────────────────────
const EYE_X = 0.0435, EYE_Y = -0.011, EYE_Z = 0.031;
const EYE_R = 0.0175, LID_T = 0.0022;
const AP_HW = 0.0168, AP_HU = 0.0115, AP_HL = 0.0085;
const MOUTH_Y = -0.0966, MOUTH_HW = 0.033, MOUTH_GAP = 0.0007;
const UV_W = 0.26, UV_Y0 = -0.19, UV_H = 0.34;
const OX = 0, OY = -0.02, OZ = -0.03, RHO = 0.13;
const DOM_UM = 0.236, DOM_VM = 0.182, DOM_VC = -0.01;

// morph target slots
const M_SMILE_L = 0, M_SMILE_R = 1, M_JAW = 2, M_WIDE = 3, M_STRETCH = 4;
const MORPHS = 5;

// ── small math ───────────────────────────────────────────────────────────────
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function ss(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function g2(x: number, y: number, cx: number, cy: number, sx: number, sy: number): number {
  const a = (x - cx) / sx, b = (y - cy) / sy;
  return Math.exp(-a * a - b * b);
}
function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b * (1 - h) + a * h - k * h * (1 - h);
}
const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

interface Tab { ys: number[]; vs: number[]; ms: number[] }
function table(pts: [number, number][]): Tab {
  const s = [...pts].sort((a, b) => a[0] - b[0]);
  const ys = s.map((p) => p[0]), vs = s.map((p) => p[1]);
  const n = ys.length;
  const ms = vs.map((_, i) =>
    i === 0 ? (vs[1] - vs[0]) / (ys[1] - ys[0])
      : i === n - 1 ? (vs[n - 1] - vs[n - 2]) / (ys[n - 1] - ys[n - 2])
        : (vs[i + 1] - vs[i - 1]) / (ys[i + 1] - ys[i - 1]));
  return { ys, vs, ms };
}
function spl(t: Tab, y: number): number {
  const { ys, vs, ms } = t;
  const n = ys.length;
  if (y <= ys[0]) y = ys[0];
  if (y >= ys[n - 1]) y = ys[n - 1];
  let i = 0;
  while (i < n - 2 && y > ys[i + 1]) i++;
  const h = ys[i + 1] - ys[i];
  const u = (y - ys[i]) / h, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * h * ms[i] + (-2 * u3 + 3 * u2) * vs[i + 1] + (u3 - u2) * h * ms[i + 1];
}
function segGroove(px: number, py: number, ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.exp(-(qx * qx + qy * qy) / (w * w)) * Math.sqrt(Math.sin(Math.PI * t));
}

// ── the face surface (port of face.py: zface / shape_f) ─────────────────────
const PROFILE = table([
  [0.2, -0.06], [0.17, -0.018], [0.15, 0.012], [0.125, 0.036], [0.1, 0.052],
  [0.075, 0.061], [0.045, 0.066], [0.02, 0.067], [0.006, 0.065], [-0.01, 0.06],
  [-0.03, 0.058], [-0.05, 0.059], [-0.07, 0.06], [-0.085, 0.058], [-0.097, 0.056],
  [-0.108, 0.057], [-0.12, 0.054], [-0.135, 0.058], [-0.148, 0.051], [-0.158, 0.036],
  [-0.168, 0.013], [-0.18, -0.018], [-0.2, -0.06],
]);
const CURV = table([
  [0.2, 7], [0.15, 6], [0.1, 5], [0.05, 4.2], [0.012, 4], [-0.011, 3.2],
  [-0.035, 2], [-0.06, 2.4], [-0.097, 5], [-0.12, 5.5], [-0.14, 8],
  [-0.16, 10], [-0.2, 10],
]);

function nose(x: number, y: number): number {
  const ax = Math.abs(x);
  const t = clamp01((-0.002 - y) / 0.048);
  const h = (0.0035 + 0.0225 * Math.pow(t, 1.35)) * (1 - ss(-0.05, -0.071, y)) * ss(0.012, 0, y);
  const w = 0.006 + 0.005 * t;
  const ridge = h * Math.exp(-Math.pow(ax / w, 2.2));
  const tip = 0.0055 * g2(ax, y, 0, -0.0485, 0.0105, 0.0095);
  const alae = 0.0085 * g2(ax, y, 0.0185, -0.06, 0.0072, 0.0062);
  const er = Math.hypot((ax - 0.019) / 0.0098, (y + 0.0598) / 0.0088);
  const crease = -0.0013 * Math.exp(-(((er - 1) / 0.22) ** 2)) * ss(-0.072, -0.06, y);
  const nostril = -0.003 * g2(ax, y, 0.0085, -0.0645, 0.0035, 0.0026);
  return ridge + tip + alae + crease + nostril;
}
function mouthLine(x: number): number {
  const tt = clamp01(Math.abs(x) / MOUTH_HW);
  return MOUTH_Y - 0.0008 * tt * tt;
}
/** mouth line y0, upper / lower vermilion height, lateral thinning */
function lipHeights(x: number): [number, number, number, number] {
  const ax = Math.abs(x);
  const tt = clamp01(ax / MOUTH_HW);
  const inside = clamp01(1 - tt * tt);
  const k = Math.sqrt(inside);
  const hu = 0.0074 * k + 0.0012 * Math.exp(-(((ax - 0.0078) / 0.0045) ** 2)) * inside - 0.0009 * Math.exp(-((x / 0.0032) ** 2)) + 0.0004;
  const hl = 0.0102 * k + 0.0004;
  return [mouthLine(x), hu, hl, k];
}
function lips(x: number, y: number): number {
  const ax = Math.abs(x);
  const [y0, hu, hl, k] = lipHeights(x);
  const su = (y - y0) / hu;
  let up = su <= 0.78 ? Math.pow(Math.sin(0.5 * Math.PI * clamp01(su / 0.78)), 0.8) : Math.exp(-(((su - 0.78) / 0.3) ** 2));
  if (su < 0) up = 0;
  const sl = (y0 - y) / hl;
  let lo = sl >= 0 && sl <= 1 ? Math.sin(Math.PI * Math.pow(clamp01(sl), 0.85)) : 0;
  lo -= 0.3 * Math.exp(-(((sl - 1.22) / 0.22) ** 2));
  let z = (0.0034 * up + 0.004 * lo) * k;
  z -= 0.0022 * Math.exp(-(((y - y0) / 0.0014) ** 2)) * k;
  z -= 0.0022 * g2(ax, y, MOUTH_HW + 0.0015, y0, 0.0045, 0.0042);
  const top = -0.0705, bot = MOUTH_Y + 0.0078;
  if (y < top && y > bot) {
    const py = clamp01((y - bot) / (top - bot));
    const cols = 0.0008 * Math.exp(-(((ax - (0.005 + 0.0012 * (1 - py))) / 0.0018) ** 2));
    const groove = -0.0006 * Math.exp(-((x / 0.003) ** 2));
    z += (cols + groove) * Math.sqrt(Math.sin(Math.PI * py));
  }
  return z;
}
function lidZ(dx: number, dy: number): number {
  const rl = EYE_R + LID_T;
  const r = Math.hypot(dx, dy);
  return EYE_Z + (r < rl ? Math.sqrt(Math.max(rl * rl - r * r, 0)) : -2 * (r - rl));
}
function zface(x: number, y: number): number {
  const ax = Math.abs(x);
  let z = spl(PROFILE, y) - spl(CURV, y) * x * x;
  z += 0.0025 * g2(ax, y, 0.03, 0.062, 0.02, 0.025);
  z += 0.006 * g2(ax, y, 0.038, 0.012, 0.024, 0.0065);
  z += 0.002 * g2(ax, y, 0, 0.008, 0.012, 0.007);
  const sx = ax < EYE_X ? 0.022 : 0.019;
  z -= 0.022 * Math.exp(-(((ax - EYE_X) / sx) ** 2) - (((y - EYE_Y - 0.002) / 0.0158) ** 2));
  z -= 0.0045 * g2(ax, y, EYE_X - 0.003, EYE_Y + 0.0135, 0.016, 0.006);
  z -= 0.008 * g2(ax, y, 0.024, EYE_Y - 0.001, 0.0065, 0.009);
  z -= 0.0035 * segGroove(ax, y, 0.03, EYE_Y - 0.01, 0.056, EYE_Y - 0.023, 0.004);
  z += 0.0095 * g2(ax, y, 0.057, -0.036, 0.02, 0.0125);
  z += 0.006 * g2(ax, y, 0.08, -0.028, 0.012, 0.01);
  z -= 0.0085 * g2(ax, y, 0.064, -0.082, 0.017, 0.021);
  z -= 0.009 * g2(ax, y, 0.074, 0.034, 0.016, 0.022);
  z += 0.0065 * g2(ax, y, 0, -0.095, 0.034, 0.03);
  z += 0.006 * g2(ax, y, 0, -0.137, 0.017, 0.011);
  z -= 0.0025 * g2(ax, y, 0, -0.117, 0.02, 0.0042);
  z -= 0.003 * segGroove(ax, y, 0.025, -0.064, 0.043, -0.108, 0.0028);
  z += 0.002 * segGroove(ax, y, 0.033, -0.062, 0.051, -0.1, 0.007);
  z += nose(x, y) + lips(x, y);
  for (const s of [1, -1]) {
    const dx = x - s * EYE_X, dy = y - EYE_Y;
    const e = Math.hypot(dx / AP_HW, dy / (dy > 0 ? AP_HU : AP_HL));
    const w = 1 - ss(1, 1.32, e);
    if (w <= 0) continue;
    const a = z - (lidZ(dx, dy) - 0.0022);
    z -= w * 0.5 * (a + Math.sqrt(a * a + 0.0012 * 0.0012));
  }
  return z;
}
function shapeF(x: number, y: number, z: number): number {
  const a = 0.118 * (1 - 0.2 * ss(-0.05, -0.16, y) - 0.05 * ss(0.06, 0.15, y));
  const fHead = (Math.sqrt((x / a) ** 2 + ((y + 0.01) / 0.175) ** 2 + ((z + 0.04) / 0.15) ** 2) - 1) * 0.11;
  if (fHead > 0.02) return fHead; // far outside the head: no need for the relief
  let f = smax(z - zface(x, y), fHead, 0.012);
  for (const s of [1, -1]) {
    const e = Math.hypot(x - s * EYE_X, y - EYE_Y, z - EYE_Z) - (EYE_R + LID_T);
    f = smin(f, e, 0.006);
  }
  return f;
}
/** param (u, v) -> surface point (ray from O, outermost crossing) */
function liftParam(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const psi = v / RHO, cp = Math.cos(psi), th = u / RHO / Math.max(cp, 1e-3);
  const dx = Math.sin(th) * cp, dy = Math.sin(psi), dz = Math.cos(th) * cp;
  const tmax = 0.22, dt = 0.0035;
  let hit = 0;
  for (let t = tmax; t > 0; t -= dt) {
    if (shapeF(OX + dx * t, OY + dy * t, OZ + dz * t) < 0) { hit = t; break; }
  }
  let lo = hit, hi = hit + dt;
  for (let k = 0; k < 16; k++) {
    const m = (lo + hi) * 0.5;
    if (shapeF(OX + dx * m, OY + dy * m, OZ + dz * m) < 0) lo = m; else hi = m;
  }
  const t = (lo + hi) * 0.5;
  return out.set(OX + dx * t, OY + dy * t, OZ + dz * t);
}
function toParam(x: number, y: number, z: number): [number, number] {
  const qx = x - OX, qy = y - OY, qz = z - OZ;
  const th = Math.atan2(qx, qz), psi = Math.atan2(qy, Math.hypot(qx, qz));
  return [th * Math.cos(psi) * RHO, psi * RHO];
}

// ── hole loops (same as face.py) ─────────────────────────────────────────────
function eyeLoop(s: number, n = 32): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, c = Math.cos(a), sn = Math.sin(a);
    const x = AP_HW * c;
    const y = sn >= 0 ? AP_HU * Math.pow(1 - c * c, 0.56) * (1 - 0.1 * c) : -AP_HL * Math.pow(1 - c * c, 0.62) * (1 + 0.08 * c);
    pts.push(new THREE.Vector3(s * EYE_X + s * x, EYE_Y + y, lidZ(s * x, y)));
  }
  return s < 0 ? [pts[0], ...pts.slice(1).reverse()] : pts;
}
function mouthLoop(nHalf = 20): THREE.Vector3[] {
  const xs: number[] = [];
  for (let i = 0; i <= nHalf; i++) xs.push(MOUTH_HW * -Math.cos((Math.PI * i) / nHalf));
  const gap = (x: number): number => MOUTH_GAP * Math.pow(Math.max(0, 1 - (x / MOUTH_HW) ** 2), 0.8);
  const pts: [number, number][] = xs.map((x) => [x, mouthLine(x) - gap(x)]);
  for (const x of xs.slice(1, -1).reverse()) pts.push([x, mouthLine(x) + gap(x)]);
  return pts.map(([x, y]) => new THREE.Vector3(x, y, zface(x, y)));
}

// ── geometry assembly helpers ────────────────────────────────────────────────
interface RawMesh { pos: number[]; idx: number[] }

/** Lid margins: from the aperture loop down onto (and into) the eyeball. */
function addEyeRims(m: RawMesh, ring0: number[], s: number): void {
  const E = new THREE.Vector3(s * EYE_X, EYE_Y, EYE_Z);
  const r1: number[] = [], r2: number[] = [];
  const d = new THREE.Vector3();
  for (const vi of ring0) {
    d.set(m.pos[vi * 3], m.pos[vi * 3 + 1], m.pos[vi * 3 + 2]).sub(E).normalize();
    r1.push(m.pos.length / 3);
    m.pos.push(E.x + d.x * (EYE_R + 0.0005), E.y + d.y * (EYE_R + 0.0005), E.z + d.z * (EYE_R + 0.0005));
    r2.push(m.pos.length / 3);
    m.pos.push(E.x + d.x * (EYE_R - 0.0012), E.y + d.y * (EYE_R - 0.0012), E.z + d.z * (EYE_R - 0.0012));
  }
  const n = ring0.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.idx.push(ring0[i], ring0[j], r1[j], ring0[i], r1[j], r1[i]);
    m.idx.push(r1[i], r1[j], r2[j], r1[i], r2[j], r2[i]);
  }
}
/** Inner lips (skin) + the dark mouth bag. Returns the first vertex index of the bag. */
function addMouth(m: RawMesh, ring0: number[]): number {
  const inner: number[] = [];
  for (const vi of ring0) {
    const x = m.pos[vi * 3], y = m.pos[vi * 3 + 1], z = m.pos[vi * 3 + 2];
    const y0 = mouthLine(x), t = Math.abs(x) / MOUTH_HW;
    inner.push(m.pos.length / 3);
    m.pos.push(x * 0.975, y0 + (y - y0) * 0.35, z - 0.0042 * (1 - 0.45 * t * t));
  }
  const n = ring0.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.idx.push(ring0[i], ring0[j], inner[j], ring0[i], inner[j], inner[i]);
  }
  // bag (separate vertices so it can be shaded dark)
  const bagStart = m.pos.length / 3;
  const ring: number[] = [];
  const base: [number, number, number][] = inner.map((vi) => [m.pos[vi * 3], m.pos[vi * 3 + 1], m.pos[vi * 3 + 2]]);
  for (const [x, y, z] of base) { ring.push(m.pos.length / 3); m.pos.push(x, y, z); }
  let prev = ring;
  for (const [sxk, infl, dz] of [[0.92, 0.0045, 0.007], [0.74, 0.0105, 0.019], [0.46, 0.009, 0.033]]) {
    const cur: number[] = [];
    for (const [x, y, z] of base) {
      const y0 = mouthLine(x), t = Math.abs(x) / MOUTH_HW;
      const side = y > y0 + 1e-6 ? 1 : y < y0 - 1e-6 ? -1 : 0;
      cur.push(m.pos.length / 3);
      m.pos.push(x * sxk, y + side * Math.sqrt(Math.max(0, 1 - t * t)) * infl, z - dz);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      m.idx.push(prev[i], prev[j], cur[j], prev[i], cur[j], cur[i]);
    }
    prev = cur;
  }
  let cz = 0;
  for (const vi of prev) cz += m.pos[vi * 3 + 2];
  const c = m.pos.length / 3;
  m.pos.push(0, MOUTH_Y, cz / prev.length - 0.006);
  for (let i = 0; i < n; i++) m.idx.push(prev[i], prev[(i + 1) % n], c);
  return bagStart;
}

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[j];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/**
 * Procedural stand-in for face_head.glb: the same surface sampled on a warped grid in the
 * ray-cast parameter space, hole loops snapped in, lid margins / mouth bag added as strips.
 */
function buildFallbackGeometry(): THREE.BufferGeometry {
  const NU = 46, NV = 52;
  const wu = (t: number): number => Math.sign(t) * (0.42 * Math.abs(t) + 0.58 * Math.abs(t) ** 3);
  const us: number[] = [], vs: number[] = [];
  for (let i = 0; i < NU; i++) us.push(DOM_UM * 1.01 * wu(-1 + (2 * i) / (NU - 1)));
  const vc = -0.03;
  for (let j = 0; j < NV; j++) {
    const t = -1 + (2 * j) / (NV - 1);
    const w = 0.45 * Math.abs(t) + 0.55 * Math.abs(t) ** 3;
    vs.push(t < 0 ? vc - (vc - (DOM_VC - DOM_VM * 1.01)) * w : vc + (DOM_VC + DOM_VM * 1.01 - vc) * w);
  }
  const loops3 = [eyeLoop(1), eyeLoop(-1), mouthLoop()];
  const loops2 = loops3.map((L) => L.map((p) => toParam(p.x, p.y, p.z)));
  const P = new Array<THREE.Vector3 | null>(NU * NV).fill(null);
  const UV: [number, number][] = [];
  const tag = new Int8Array(NU * NV); // 0 free, 1 snapped, 2 inside a hole, 3 mouth upper, 4 mouth lower
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const k = j * NU + i;
    let u = us[i], v = vs[j];
    const sp = Math.min(us[Math.min(i + 1, NU - 1)] - us[Math.max(i - 1, 0)], vs[Math.min(j + 1, NV - 1)] - vs[Math.max(j - 1, 0)]) * 0.5;
    for (let h = 0; h < 3; h++) {
      const poly = loops2[h];
      if (pointInPoly(u, v, poly)) { tag[k] = 2; break; }
      // nearest point on the loop
      let best = 1e9, bp = 0, bt = 0;
      for (let a = 0; a < poly.length; a++) {
        const [x1, y1] = poly[a], [x2, y2] = poly[(a + 1) % poly.length];
        const dx = x2 - x1, dy = y2 - y1;
        const t = clamp01(((u - x1) * dx + (v - y1) * dy) / Math.max(dx * dx + dy * dy, 1e-14));
        const d = Math.hypot(x1 + t * dx - u, y1 + t * dy - v);
        if (d < best) { best = d; bp = a; bt = t; }
      }
      const lim = h === 2 ? sp * 1.0 : sp * 0.5;
      if (best < lim) {
        const L = loops3[h];
        const a = L[bp], b = L[(bp + 1) % L.length];
        const q = a.clone().lerp(b, bt);
        const [qu, qv] = toParam(q.x, q.y, q.z);
        u = qu; v = qv;
        P[k] = q;
        tag[k] = h === 2 ? (q.y > mouthLine(q.x) ? 3 : 4) : 1;
        break;
      }
    }
    UV[k] = [u, v];
  }
  const tmp = new THREE.Vector3();
  const raw: RawMesh = { pos: [], idx: [] };
  const remap = new Int32Array(NU * NV).fill(-1);
  const vid = (k: number): number => {
    if (remap[k] < 0) {
      const p = P[k] ?? liftParam(UV[k][0], UV[k][1], tmp);
      remap[k] = raw.pos.length / 3;
      raw.pos.push(p.x, p.y, p.z);
    }
    return remap[k];
  };
  const inDomain = (u: number, v: number): boolean => (u / DOM_UM) ** 2 + ((v - DOM_VC) / DOM_VM) ** 2 < 1;
  const tri = (a: number, b: number, c: number): void => {
    if (tag[a] === 2 || tag[b] === 2 || tag[c] === 2) return;
    const ta = tag[a], tb = tag[b], tc = tag[c];
    const mouthUp = ta === 3 || tb === 3 || tc === 3, mouthLo = ta === 4 || tb === 4 || tc === 4;
    if (mouthUp && mouthLo) return;
    const cu = (UV[a][0] + UV[b][0] + UV[c][0]) / 3, cv = (UV[a][1] + UV[b][1] + UV[c][1]) / 3;
    if (!inDomain(cu, cv)) return;
    for (const poly of loops2) if (pointInPoly(cu, cv, poly)) return;
    const area = (UV[b][0] - UV[a][0]) * (UV[c][1] - UV[a][1]) - (UV[c][0] - UV[a][0]) * (UV[b][1] - UV[a][1]);
    if (area <= 1e-10) return;
    raw.idx.push(vid(a), vid(b), vid(c));
  };
  for (let j = 0; j < NV - 1; j++) for (let i = 0; i < NU - 1; i++) {
    const a = j * NU + i, b = a + 1, c = a + NU + 1, d = a + NU;
    const d1 = Math.hypot(UV[c][0] - UV[a][0], UV[c][1] - UV[a][1]);
    const d2 = Math.hypot(UV[d][0] - UV[b][0], UV[d][1] - UV[b][1]);
    if (d1 <= d2) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
  }
  // loops as their own vertices (the snapped grid edges run along them)
  const ringOf = (L: THREE.Vector3[]): number[] => L.map((p) => { raw.pos.push(p.x, p.y, p.z); return raw.pos.length / 3 - 1; });
  addEyeRims(raw, ringOf(loops3[0]), 1);
  addEyeRims(raw, ringOf(loops3[1]), -1);
  const bagStart = addMouth(raw, ringOf(loops3[2]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(raw.pos, 3));
  g.setIndex(raw.idx);
  g.userData.bagStart = bagStart;
  return g;
}

// ── shading bake (occlusion from a depth raster + edge fade) ─────────────────
function bakeShade(g: THREE.BufferGeometry, bagStart: number): void {
  const pos = g.attributes.position.array as ArrayLike<number>;
  const idx = g.index!.array as ArrayLike<number>;
  const n = pos.length / 3;
  const CELL = 0.0015, X0 = -0.13, Y0 = -0.19;
  const GW = Math.ceil(0.26 / CELL), GH = Math.ceil(0.34 / CELL);
  const zb = new Float32Array(GW * GH).fill(-1e9);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a >= bagStart || b >= bagStart || c >= bagStart) continue;
    const ax = (pos[a * 3] - X0) / CELL, ay = (pos[a * 3 + 1] - Y0) / CELL, az = pos[a * 3 + 2];
    const bx = (pos[b * 3] - X0) / CELL, by = (pos[b * 3 + 1] - Y0) / CELL, bz = pos[b * 3 + 2];
    const cx = (pos[c * 3] - X0) / CELL, cy = (pos[c * 3 + 1] - Y0) / CELL, cz = pos[c * 3 + 2];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(GW - 1, Math.ceil(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(GH - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i + 0.5, py = j + 0.5;
      const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
      const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const z = w0 * az + w1 * bz + w2 * cz;
      const k = j * GW + i;
      if (z > zb[k]) zb[k] = z;
    }
  }
  // eyeballs fill the apertures
  for (const s of [1, -1]) {
    const ci = (s * EYE_X - X0) / CELL, cj = (EYE_Y - Y0) / CELL, rr = EYE_R / CELL;
    for (let j = Math.floor(cj - rr); j <= Math.ceil(cj + rr); j++) for (let i = Math.floor(ci - rr); i <= Math.ceil(ci + rr); i++) {
      if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
      const dx = (i + 0.5 - ci) * CELL, dy = (j + 0.5 - cj) * CELL, d2 = EYE_R * EYE_R - dx * dx - dy * dy;
      if (d2 <= 0) continue;
      const k = j * GW + i;
      zb[k] = Math.max(zb[k], EYE_Z + Math.sqrt(d2));
    }
  }
  const blur = (sigma: number): Float32Array => {
    const r = Math.ceil(sigma * 2.5);
    const ker = new Float32Array(r * 2 + 1);
    for (let i = -r; i <= r; i++) ker[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    const val = new Float32Array(GW * GH), wt = new Float32Array(GW * GH);
    for (let k = 0; k < zb.length; k++) if (zb[k] > -1e8) { val[k] = zb[k]; wt[k] = 1; }
    const pass = (src: Float32Array, horiz: boolean): Float32Array => {
      const out = new Float32Array(GW * GH);
      for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
        let acc = 0;
        for (let o = -r; o <= r; o++) {
          const ii = horiz ? i + o : i, jj = horiz ? j : j + o;
          if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
          acc += src[jj * GW + ii] * ker[o + r];
        }
        out[j * GW + i] = acc;
      }
      return out;
    };
    const v2 = pass(pass(val, true), false), w2 = pass(pass(wt, true), false);
    for (let k = 0; k < v2.length; k++) v2[k] = w2[k] > 1e-4 ? v2[k] / w2[k] : -1e9;
    return v2;
  };
  const near = blur(3), far = blur(10);
  const sample = (m: Float32Array, x: number, y: number): number => {
    const fx = Math.min(GW - 1.001, Math.max(0, (x - X0) / CELL - 0.5)), fy = Math.min(GH - 1.001, Math.max(0, (y - Y0) / CELL - 0.5));
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const k = j * GW + i;
    return (m[k] * (1 - a) + m[k + 1] * a) * (1 - b) + (m[k + GW] * (1 - a) + m[k + GW + 1] * a) * b;
  };
  const col = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (v >= bagStart) {
      col.set([0.035, 0.022, 0.028, 1], v * 4);
      continue;
    }
    const b1 = sample(near, x, y), b2 = sample(far, x, y);
    const o1 = b1 > -1e8 ? clamp01((b1 - z) / 0.0045) : 0;
    const o2 = b2 > -1e8 ? clamp01((b2 - z) / 0.014) : 0;
    const cv = b1 > -1e8 ? clamp01((z - b1) / 0.004) : 0;
    const sh = Math.max(0.2, Math.min(1.04, 1 - 0.46 * o1 - 0.34 * o2 + 0.05 * cv));
    col.set([sh, sh * 0.985, sh * 0.99, ss(-0.05, 0.016, z)], v * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
}

// ── morph targets (computed from the rest shape) ─────────────────────────────
const JAW_PIVOT_Y = -0.025, JAW_PIVOT_Z = -0.04, JAW_ANGLE = 0.36;
type Field = (x: number, y: number, z: number, out: THREE.Vector3) => void;

function rotX(y: number, z: number, cy: number, cz: number, a: number, out: THREE.Vector3): void {
  const dy = y - cy, dz = z - cz, c = Math.cos(a), s = Math.sin(a);
  out.y = cy + dy * c - dz * s - y;
  out.z = cz + dy * s + dz * c - z;
}
const smileField = (side: number): Field => (x, y, z, o) => {
  o.set(0, 0, 0);
  const c = g2(x, y, side * MOUTH_HW, MOUTH_Y - 0.0008, 0.012, 0.011);
  const ck = g2(x, y, side * 0.046, -0.07, 0.016, 0.016);
  o.x = side * 0.0017 * c;
  o.y = 0.0046 * c + 0.0016 * ck;
  o.z = -0.0012 * c + 0.0011 * ck;
};
const jawField: Field = (x, y, z, o) => {
  o.set(0, 0, 0);
  const ax = Math.abs(x);
  let yj = mouthLine(x), band = 0.0002;
  if (ax > MOUTH_HW) { yj = mouthLine(MOUTH_HW) + (ax - MOUTH_HW) * 0.5; band = 0.0002 + (ax - MOUTH_HW) * 0.8; }
  const w = ss(yj + band, yj - band, y) * ss(-0.06, -0.02, z);
  if (w <= 0) return;
  rotX(y, z, JAW_PIVOT_Y, JAW_PIVOT_Z, JAW_ANGLE * w, o);
};
const wideField: Field = (x, y, z, o) => {
  o.set(0, 0, 0);
  for (const s of [1, -1]) {
    const qx = x - s * EYE_X, qy = y - EYE_Y;
    const e = Math.hypot(qx / AP_HW, qy / (qy > 0 ? AP_HU : AP_HL));
    const wr = e <= 1 ? 1 : Math.exp(-(((e - 1) / 0.6) ** 2));
    if (wr < 1e-3 || z < EYE_Z - 0.006) continue;
    const cf = 1 - ss(0.72, 1.05, Math.abs(qx) / AP_HW);
    const side = ss(-0.002, 0.002, qy);
    const ang = lerp(0.2, -0.3, side) * wr * cf;
    rotX(y, z, EYE_Y, EYE_Z, ang, o);
  }
  o.y += 0.004 * g2(Math.abs(x), y, 0.036, 0.024, 0.028, 0.02) * ss(EYE_Y + 0.008, EYE_Y + 0.016, y);
};
const stretchField: Field = (x, y, z, o) => {
  o.set(0, 0, 0);
  const ax = Math.abs(x), sx = Math.sign(x) || 1;
  const c = g2(ax, y, MOUTH_HW, MOUTH_Y - 0.0008, 0.013, 0.012);
  o.x += sx * 0.0065 * c;
  o.y += -0.0035 * c;
  o.z += -0.0025 * c;
  const y0 = mouthLine(x);
  const ul = clamp01(1 - (x / (MOUTH_HW * 1.1)) ** 2) * ss(y0 - 0.0003, y0 + 0.0008, y) * Math.exp(-(((y - y0) / 0.012) ** 2));
  o.y += 0.0036 * ul;
  o.z += 0.0008 * ul;
  o.x += sx * 0.0016 * g2(ax, y, 0.0185, -0.06, 0.0075, 0.0075);
  o.z -= 0.004 * g2(ax, y, 0.062, -0.082, 0.018, 0.02);
};
const FIELDS: Field[] = [smileField(1), smileField(-1), jawField, wideField, stretchField];

function addMorphs(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position.array as Float32Array;
  const n = pos.length / 3;
  g.computeVertexNormals();
  const n0 = (g.attributes.normal.array as Float32Array).slice();
  const posT: THREE.BufferAttribute[] = [], norT: THREE.BufferAttribute[] = [];
  const o = new THREE.Vector3();
  const tmpG = new THREE.BufferGeometry();
  tmpG.setIndex(g.index);
  for (const field of FIELDS) {
    const d = new Float32Array(n * 3);
    const moved = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      field(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], o);
      d[i * 3] = o.x; d[i * 3 + 1] = o.y; d[i * 3 + 2] = o.z;
      moved[i * 3] = pos[i * 3] + o.x; moved[i * 3 + 1] = pos[i * 3 + 1] + o.y; moved[i * 3 + 2] = pos[i * 3 + 2] + o.z;
    }
    tmpG.setAttribute('position', new THREE.BufferAttribute(moved, 3));
    tmpG.deleteAttribute('normal');
    tmpG.computeVertexNormals();
    const nn = tmpG.attributes.normal.array as Float32Array;
    const dn = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) dn[i] = nn[i] - n0[i];
    posT.push(new THREE.BufferAttribute(d, 3));
    norT.push(new THREE.BufferAttribute(dn, 3));
  }
  g.morphAttributes.position = posT;
  g.morphAttributes.normal = norT;
  g.morphTargetsRelative = true;
}

/** front-projected UV + normals + shade + morphs + bounds */
function finishHead(g: THREE.BufferGeometry, bagStart: number): THREE.BufferGeometry {
  const pos = g.attributes.position.array as ArrayLike<number>;
  const n = pos.length / 3;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = clamp01(0.5 + pos[i * 3] / UV_W);
    uv[i * 2 + 1] = clamp01((pos[i * 3 + 1] - UV_Y0) / UV_H);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  bakeShade(g, bagStart);
  addMorphs(g);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 0.06;
  return g;
}

// ── eyeball geometry ─────────────────────────────────────────────────────────
function buildEyeGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(EYE_R, 24, 18);
  g.rotateX(Math.PI / 2); // poles on ±Z, the front pole is the cornea
  const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = Math.hypot(x, y, z) || 1;
    const nx = x / d, ny = y / d, nz = z / d;
    const ang = Math.acos(Math.max(-1, Math.min(1, nz)));
    const bulge = ang < 0.5 ? 0.0008 * Math.cos((ang / 0.5) * Math.PI * 0.5) ** 2 : 0;
    const r = (EYE_R + bulge) / d;
    p.setXYZ(i, x * r, y * r, z * r);
    const rr = Math.hypot(nx, ny);
    const k = nz >= 0 ? 0.5 : 0.5 / Math.max(rr, 1e-3);
    uv.setXY(i, 0.5 + nx * k, 0.5 + ny * k);
  }
  g.computeVertexNormals();
  return g;
}

// ── textures ─────────────────────────────────────────────────────────────────
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x: number, y: number, seed: number): number {
  return 0.5 * vnoise(x, y, seed) + 0.3 * vnoise(x * 2.03 + 7.1, y * 2.03 - 3.3, seed + 1) + 0.2 * vnoise(x * 4.11 - 1.7, y * 4.11 + 5.9, seed + 2);
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mix3(c: number[], to: readonly number[], t: number): void {
  if (t <= 0) return;
  if (t > 1) t = 1;
  c[0] += (to[0] - c[0]) * t; c[1] += (to[1] - c[1]) * t; c[2] += (to[2] - c[2]) * t;
}
/** wandering, branching stroke (veins) */
function veins(g: CanvasRenderingContext2D, r: () => number, x: number, y: number, ang: number, len: number, width: number, color: string, alpha: number, curl = 0.35, depth = 0): void {
  const pts: [number, number][] = [[x, y]];
  for (let s = 0; s < len; s += 2) {
    ang += (r() - 0.5) * curl;
    x += Math.cos(ang) * 2;
    y += Math.sin(ang) * 2;
    pts.push([x, y]);
  }
  for (const [wMul, aMul] of [[2.4, 0.35], [1, 1]]) {
    g.strokeStyle = color.replace('A', String(alpha * aMul));
    g.lineWidth = width * wMul;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts) g.lineTo(px, py);
    g.stroke();
  }
  if (depth < 2) {
    const nb = depth === 0 ? 2 : 1;
    for (let b = 0; b < nb; b++) {
      const at = pts[Math.floor(pts.length * (0.25 + r() * 0.6))];
      if (!at) continue;
      veins(g, r, at[0], at[1], ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6), len * (0.35 + r() * 0.3), width * 0.65, color, alpha * 0.8, curl, depth + 1);
    }
  }
}

const SKIN_W = 512, SKIN_H = 672;
const sx2px = (x: number): number => (0.5 + x / UV_W) * SKIN_W;
const sy2px = (y: number): number => (1 - (y - UV_Y0) / UV_H) * SKIN_H;

function paintSkin(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SKIN_W;
  cv.height = SKIN_H;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(SKIN_W, SKIN_H);
  const d = img.data;
  const c = [0, 0, 0];
  const BASE = [214, 210, 202], EDGE = [176, 182, 188];
  const SOCKET = [96, 80, 92], LIDRIM = [162, 104, 112], WET = [112, 60, 68];
  const LIP = [140, 110, 124], LIPDARK = [98, 72, 88], LINE = [34, 20, 26], NOSTRIL = [40, 29, 33];
  for (let py = 0; py < SKIN_H; py++) {
    const y = UV_Y0 + (1 - (py + 0.5) / SKIN_H) * UV_H;
    for (let px = 0; px < SKIN_W; px++) {
      const x = ((px + 0.5) / SKIN_W - 0.5) * UV_W, ax = Math.abs(x);
      const o = (py * SKIN_W + px) * 4;
      // ragged oval: the face dissolves into the dark (forehead earlier than the chin)
      const oy = y < -0.028 ? (y + 0.028) / 0.147 : (y + 0.028) / 0.124;
      const od = Math.hypot(x / 0.094, oy) + (fbm(x * 38 + 11, y * 38, 3) - 0.5) * 0.16;
      const alpha = 1 - ss(0.8, 1.05, od);
      if (alpha <= 0.003) { d[o + 3] = 0; continue; }
      c[0] = BASE[0]; c[1] = BASE[1]; c[2] = BASE[2];
      mix3(c, EDGE, ss(0.3, 1.0, od));
      const m1 = fbm(x * 95 + 3.1, y * 95 - 1.7, 11) - 0.5;
      const m2 = fbm(x * 30 - 5, y * 30 + 2, 17) - 0.5;
      c[0] += m1 * 12 + m2 * 9; c[1] += m1 * 10 + m2 * 2; c[2] += m1 * 11 + m2 * 12;
      // eye sockets (sunken, bruised), lid margins (raw, never closed), wet inner rims
      for (const s of [1, -1]) {
        const dx = x - s * EYE_X, dy = y - EYE_Y;
        if (Math.abs(dx) > 0.06 || Math.abs(dy) > 0.05) continue;
        const e = Math.hypot(dx / AP_HW, dy / (dy > 0 ? AP_HU : AP_HL));
        const sock = g2(dx, dy, s * -0.002, 0.003, 0.027, 0.022);
        const ring = Math.exp(-(((e - 1.3) / 0.38) ** 2));
        const under = g2(dx, dy, s * 0.002, -0.0145, 0.019, 0.0062);
        mix3(c, SOCKET, 0.42 * sock + 0.36 * ring + 0.42 * under);
        mix3(c, LIDRIM, 0.6 * Math.exp(-(((e - 1.04) / 0.075) ** 2)));
        if (e < 1.02) mix3(c, WET, ss(1.02, 0.9, e));
      }
      // nose: nostrils and alar shadows
      mix3(c, NOSTRIL, 0.92 * g2(ax, y, 0.0088, -0.0648, 0.0036, 0.0022));
      const er = Math.hypot((ax - 0.019) / 0.0098, (y + 0.0598) / 0.0088);
      mix3(c, SOCKET, 0.16 * Math.exp(-(((er - 1) / 0.18) ** 2)) * ss(-0.072, -0.06, y));
      // nasolabial folds, under the lower lip
      mix3(c, SOCKET, 0.18 * segGroove(ax, y, 0.025, -0.064, 0.043, -0.108, 0.0035));
      mix3(c, SOCKET, 0.12 * g2(ax, y, 0, -0.112, 0.018, 0.004));
      // lips: bloodless purple-grey, darker into the line
      if (ax < MOUTH_HW * 1.15 && Math.abs(y - MOUTH_Y) < 0.02) {
        const [y0, hu, hl] = lipHeights(x);
        const su = (y - y0) / hu, sl = (y0 - y) / hl;
        const edge = ss(1.08, 0.86, ax / MOUTH_HW);
        const mU = ss(1.07, 0.93, su) * ss(-0.1, 0.0, su);
        const mL = ss(1.08, 0.9, sl) * ss(-0.1, 0.0, sl);
        const m = Math.max(mU, mL) * (0.35 + 0.65 * edge);
        mix3(c, LIP, 0.85 * m);
        mix3(c, LIPDARK, 0.7 * m * Math.exp(-(((y - y0) / 0.0032) ** 2)));
        mix3(c, LINE, Math.exp(-(((y - y0) / 0.00075) ** 2)) * ss(1.1, 0.9, ax / MOUTH_HW));
        mix3(c, SOCKET, 0.35 * g2(ax, y, MOUTH_HW + 0.0012, y0, 0.0035, 0.003));
      }
      const gr = (hash2(px, py, 5) - 0.5) * 9;
      d[o] = c[0] + gr; d[o + 1] = c[1] + gr; d[o + 2] = c[2] + gr;
      d[o + 3] = alpha * 255;
    }
  }
  g.putImageData(img, 0, 0);
  // veins under translucent skin: temples, forehead, eyelids
  g.globalCompositeOperation = 'source-atop';
  const r = rng(19);
  const VEIN = 'rgba(82,98,138,A)', LIDV = 'rgba(112,72,104,A)';
  for (const s of [1, -1]) {
    for (let k = 0; k < 3; k++) {
      veins(g, r, sx2px(s * (0.068 + r() * 0.012)), sy2px(0.06 + r() * 0.025), Math.PI / 2 + s * (0.25 + r() * 0.3), 40 + r() * 40, 1.1, VEIN, 0.2);
    }
    veins(g, r, sx2px(s * 0.016), sy2px(0.085), Math.PI / 2 + s * 0.15, 45, 1.0, VEIN, 0.12);
    for (let k = 0; k < 4; k++) {
      const a = -Math.PI * (0.2 + 0.6 * r());
      veins(g, r, sx2px(s * EYE_X + Math.cos(a) * 0.014 * s), sy2px(EYE_Y + 0.013), a, 10 + r() * 8, 0.6, LIDV, 0.28, 0.5);
    }
    for (let k = 0; k < 3; k++) {
      veins(g, r, sx2px(s * (EYE_X + (r() - 0.5) * 0.02)), sy2px(EYE_Y - 0.012), Math.PI / 2 + (r() - 0.5), 12 + r() * 10, 0.6, LIDV, 0.22, 0.5);
    }
  }
  // dry, cracked lips
  g.lineWidth = 0.7;
  for (let x = -MOUTH_HW * 0.85; x <= MOUTH_HW * 0.85; x += 0.0028 + r() * 0.0016) {
    const [y0, hu, hl] = lipHeights(x);
    const tilt = -x * 0.08;
    g.strokeStyle = `rgba(62,42,52,${0.22 + r() * 0.18})`;
    g.beginPath();
    g.moveTo(sx2px(x), sy2px(y0 + hu * 0.12));
    g.lineTo(sx2px(x + tilt + (r() - 0.5) * 0.001), sy2px(y0 + hu * (0.55 + r() * 0.35)));
    g.moveTo(sx2px(x), sy2px(y0 - hl * 0.1));
    g.lineTo(sx2px(x + tilt * 1.4 + (r() - 0.5) * 0.001), sy2px(y0 - hl * (0.5 + r() * 0.4)));
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  return cv;
}

function paintEye(): HTMLCanvasElement {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const c = [0, 0, 0];
  const IR = 0.326; // iris radius on the unit disc (sin 19°): small
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const cx = ((px + 0.5) / S - 0.5) * 2, cy = (0.5 - (py + 0.5) / S) * 2;
    const r = Math.hypot(cx, cy);
    c[0] = 226; c[1] = 217; c[2] = 192;
    mix3(c, [196, 180, 140], ss(0.3, 1.0, r));                       // yellowed towards the corners
    mix3(c, [206, 150, 144], 0.5 * ss(0.6, 1.0, Math.abs(cx)) * ss(0.2, 0.8, r));
    const m = fbm(cx * 6, cy * 6, 31) - 0.5;
    c[0] += m * 14; c[1] += m * 10; c[2] += m * 8;
    if (r < IR * 1.12) {
      const ang = Math.atan2(cy, cx);
      const fib = fbm(ang * 9 + 40, r * 22, 41) - 0.5;
      const iris = [66 + fib * 30, 58 + fib * 24, 54 + fib * 20];
      mix3(iris, [40, 34, 32], ss(0.6, 1.0, r / IR));
      mix3(iris, [92, 84, 74], 0.4 * Math.exp(-(((r / IR - 0.55) / 0.08) ** 2)));
      mix3(c, iris, ss(IR * 1.1, IR * 0.96, r));
      mix3(c, [26, 21, 20], 0.75 * Math.exp(-(((r / IR - 1.0) / 0.07) ** 2)));
    }
    mix3(c, [150, 136, 112], 0.5 * ss(0.85, 1.0, r));
    const gr = (hash2(px, py, 9) - 0.5) * 6;
    const o = (py * S + px) * 4;
    d[o] = c[0] + gr; d[o + 1] = c[1] + gr; d[o + 2] = c[2] + gr; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // bloodshot: vessels from the corners towards the iris
  const r = rng(77);
  for (let k = 0; k < 16; k++) {
    const side = k % 2 ? 1 : -1;
    const a0 = (side > 0 ? 0 : Math.PI) + (r() - 0.5) * 1.5;
    const sx = S / 2 + Math.cos(a0) * S * 0.5, sy = S / 2 - Math.sin(a0) * S * 0.5;
    veins(g, r, sx, sy, a0 + Math.PI + (r() - 0.5) * 0.5, 30 + r() * 46, 1.3 + r() * 0.8, 'rgba(146,26,30,A)', 0.55 + r() * 0.25, 0.42);
  }
  return cv;
}

// ── materials ────────────────────────────────────────────────────────────────
const FX_PARS = /* glsl */ `
uniform float uFlat;
uniform float uTime;
float faceHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 faceUv(vec2 uv) {
  if (uFlat <= 0.0) return uv;
  float frame = floor(uTime * 14.0);
  float tear = step(0.86, faceHash(vec2(frame, 7.1)));
  uv.x += (faceHash(vec2(floor(uv.y * 110.0), frame)) - 0.5) * 0.012 * uFlat * (0.3 + tear);
  return uv;
}
vec3 faceFlat(vec3 c, vec2 uv) {
  if (uFlat <= 0.0) return c;
  float scan = 0.7 + 0.3 * sin(uv.y * 950.0);
  float roll = 0.84 + 0.16 * smoothstep(0.0, 0.12, abs(fract(uv.y * 0.8 - uTime * 0.11) - 0.5));
  float n = faceHash(floor(uv * vec2(170.0, 220.0)) + floor(uTime * 24.0) * 1.37);
  c *= mix(1.0, scan * roll, uFlat);
  c += (n - 0.5) * 0.24 * uFlat * (0.2 + c);
  return c;
}
`;

interface FaceUniforms {
  uFlat: { value: number };
  uTime: { value: number };
  uPupil: { value: number };
}

function patch(m: THREE.MeshStandardMaterial, u: FaceUniforms, eye: boolean): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFlat = u.uFlat;
    sh.uniforms.uTime = u.uTime;
    if (eye) sh.uniforms.uPupil = u.uPupil;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FX_PARS}${eye ? 'uniform float uPupil;\n' : ''}`)
      .replace('#include <map_fragment>', eye
        ? `vec2 fUv = faceUv(vMapUv);
           vec4 faceTex = texture2D(map, fUv);
           float pr = length(fUv - 0.5);
           faceTex.rgb = mix(faceTex.rgb, vec3(0.004, 0.003, 0.003), 1.0 - smoothstep(uPupil - 0.012, uPupil + 0.004, pr));
           diffuseColor *= faceTex;`
        : `vec2 fUv = faceUv(vMapUv);
           vec4 faceTex = texture2D(map, fUv);
           diffuseColor *= faceTex;`)
      .replace('#include <emissivemap_fragment>', eye
        ? 'totalEmissiveRadiance *= faceTex.rgb;'
        : `totalEmissiveRadiance *= faceTex.rgb;
           #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
             totalEmissiveRadiance *= vColor.rgb * vColor.rgb;
           #endif`)
      .replace('#include <opaque_fragment>', 'outgoingLight = faceFlat(outgoingLight, fUv);\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => (eye ? 'kao-face-eye-1' : 'kao-face-skin-1');
}

// ── shared state ─────────────────────────────────────────────────────────────
interface Shared {
  skinTex: THREE.CanvasTexture;
  eyeTex: THREE.CanvasTexture;
  eyeGeo: THREE.BufferGeometry;
  head: THREE.BufferGeometry | null;
  fromGlb: boolean;
  eyes: [THREE.Vector3, THREE.Vector3];
}
let shared: Shared | null = null;
let glbState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
const live = new Set<{ skin: THREE.Mesh; eyes: THREE.Mesh[] }>();
const camWorld = new THREE.Vector3();
let camKnown = false;

function makeTexture(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

function getShared(): Shared {
  if (!shared) {
    shared = {
      skinTex: makeTexture(paintSkin()),
      eyeTex: makeTexture(paintEye()),
      eyeGeo: buildEyeGeometry(),
      head: null,
      fromGlb: false,
      eyes: [new THREE.Vector3(EYE_X, EYE_Y, EYE_Z), new THREE.Vector3(-EYE_X, EYE_Y, EYE_Z)],
    };
  }
  return shared;
}

function headGeometry(): THREE.BufferGeometry {
  const s = getShared();
  if (!s.head) {
    const g = buildFallbackGeometry();
    s.head = finishHead(g, g.userData.bagStart as number);
  }
  return s.head;
}

function useGlb(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  let face: THREE.Mesh | null = null, bag: THREE.Mesh | null = null;
  const eyes: THREE.Vector3[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (o.name === 'face' && m.isMesh) face = m;
    else if (o.name === 'mouth_inner' && m.isMesh) bag = m;
    else if (o.name === 'eye_L' || o.name === 'eye_R') eyes[o.name === 'eye_L' ? 0 : 1] = o.getWorldPosition(new THREE.Vector3());
  });
  if (!face) throw new Error('no "face" mesh');
  const parts = [face as THREE.Mesh, ...(bag ? [bag as THREE.Mesh] : [])];
  const pos: number[] = [], idx: number[] = [];
  let bagStart = Infinity;
  for (const m of parts) {
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const p = g.attributes.position;
    const base = pos.length / 3;
    if (m === bag) bagStart = base;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const head = finishHead(g, bagStart === Infinity ? pos.length / 3 : bagStart);
  const s = getShared();
  const old = s.head;
  s.head = head;
  s.fromGlb = true;
  if (eyes[0] && eyes[1]) { s.eyes[0].copy(eyes[0]); s.eyes[1].copy(eyes[1]); }
  for (const f of live) {
    f.skin.geometry = head;
    f.skin.updateMorphTargets();
    f.eyes.forEach((e, i) => e.position.copy(s.eyes[i]));
  }
  old?.dispose();
}

function loadGlb(): void {
  if (glbState !== 'idle' || typeof window === 'undefined') return;
  glbState = 'loading';
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  new GLTFLoader().load(
    `${base}models/face_head${(import.meta.env?.VITE_MODEL_EXT as string | undefined) ?? '.glb'}`,
    (gltf) => {
      try {
        useGlb(gltf.scene);
        glbState = 'ready';
      } catch (e) {
        console.warn('[face] face_head.glb unusable, keeping the procedural head', e);
        glbState = 'failed';
      }
    },
    undefined,
    (err) => {
      console.warn('[face] face_head.glb not loaded, using the procedural head', err);
      glbState = 'failed';
    },
  );
}
// fetch early so the first face already uses the modelled head; paint the textures when idle
if (typeof window !== 'undefined') {
  setTimeout(() => {
    loadGlb();
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(() => getShared()); else setTimeout(() => getShared(), 200);
  }, 0);
}

function captureCamera(_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera): void {
  camWorld.setFromMatrixPosition(cam.matrixWorld);
  camKnown = true;
}

// ── the visual ───────────────────────────────────────────────────────────────
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();

/** A pale bodiless face that stares, smiles, opens its mouth and screams. */
export function createFaceVisual(opts: FaceOptions): FaceVisual {
  loadGlb();
  const sh = getShared();
  const flat = opts.style === 'flat';
  const scale = opts.scale ?? 1;
  const glow = opts.glow ?? 0.55;

  const u: FaceUniforms = { uFlat: { value: flat ? 1 : 0 }, uTime: { value: 0 }, uPupil: { value: 0.12 } };
  const skinMat = new THREE.MeshStandardMaterial({
    map: sh.skinTex, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0,
    roughness: 0.62, metalness: 0, vertexColors: true, transparent: true, opacity: 0,
    alphaTest: 0.02, depthWrite: true, side: THREE.FrontSide,
  });
  patch(skinMat, u, false);
  const eyeMat = new THREE.MeshStandardMaterial({
    map: sh.eyeTex, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0,
    roughness: 0.16, metalness: 0, transparent: true, opacity: 0, depthWrite: true,
  });
  patch(eyeMat, u, true);

  const holder = new THREE.Group(); // FaceSystem moves / turns / scales this
  holder.name = 'face';
  const pivot = new THREE.Group(); // lag, tilt, breathing, tremor, lunge
  const body = new THREE.Group(); // size and the flat squash
  holder.add(pivot);
  pivot.add(body);
  const skin = new THREE.Mesh(headGeometry(), skinMat);
  skin.renderOrder = 4;
  skin.frustumCulled = false;
  skin.onBeforeRender = captureCamera;
  const eyes = [0, 1].map((i) => {
    const e = new THREE.Mesh(sh.eyeGeo, eyeMat);
    e.position.copy(sh.eyes[i]);
    e.renderOrder = 3;
    e.frustumCulled = false;
    body.add(e);
    return e;
  });
  body.add(skin);
  const entry = { skin, eyes };
  live.add(entry);

  // per-face character
  const rnd = Math.random;
  const asym = rnd() < 0.5 ? [1, 0.55 + rnd() * 0.25] : [0.55 + rnd() * 0.25, 1];
  const tiltDir = rnd() < 0.5 ? -1 : 1;
  const phase = rnd() * 10;

  let age = 0;
  let fadeCap = 1;
  let scream = false, screamT = 0;
  let smile = 0, jaw = 0, wide = 0, stretch = 0, lock = 0, tilt = 0, flatK = flat ? 1 : 0;
  let pupil = 0.12;
  let lagInit = false;
  const lagWorld = new THREE.Quaternion();
  const eyeDir = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)];
  const wander = new THREE.Vector2();
  let wanderT = 0;
  let fade = 0;

  const approach = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  const apply = (): void => {
    skinMat.opacity = fade;
    eyeMat.opacity = fade;
  };

  return {
    object: holder,

    update(dt, s) {
      age += dt;
      const g = clamp01(s.gaze);
      // appearance: ease in from the dark, then follow setFade (dying)
      const appear = 1 - (1 - clamp01(age / 0.6)) ** 3;
      fade = Math.min(appear, fadeCap);
      if (scream) screamT += dt;
      const scr = scream ? ss(0, 0.16, screamT) : 0;

      // ── expression ──
      smile = approach(smile, ss(0.38, 0.8, g) * (1 - scr), 1.6, dt);
      jaw = scream ? approach(jaw, 1, 14, dt) : approach(jaw, ss(0.85, 1, g) * 0.32, 0.9, dt);
      wide = approach(wide, scream ? 1 : ss(0.55, 1, g) * 0.22, scream ? 16 : 2, dt);
      stretch = approach(stretch, scream ? 1 : ss(0.9, 1, g) * 0.15, scream ? 12 : 2, dt);
      const inf = skin.morphTargetInfluences;
      if (inf && inf.length >= MORPHS) {
        inf[M_SMILE_L] = smile * asym[0] * 0.85;
        inf[M_SMILE_R] = smile * asym[1] * 0.85;
        inf[M_JAW] = jaw;
        inf[M_WIDE] = wide;
        inf[M_STRETCH] = stretch;
      }

      // ── body: size, flat squash (a flat face comes out of its surface when it screams) ──
      flatK = flat ? approach(flatK, scream ? 0 : 1, 6, dt) : 0;
      body.scale.set(scale, scale, scale * lerp(1, 0.05, flatK));
      u.uFlat.value = flat ? lerp(0.35, 1, flatK) : 0;
      u.uTime.value = s.time;

      // ── head motion: lag behind the instant lookAt, tilt, breathing, tremor ──
      holder.updateWorldMatrix(true, false);
      holder.getWorldQuaternion(_q);
      if (!lagInit || scream) { lagWorld.copy(_q); lagInit = true; }
      else {
        lagWorld.slerp(_q, 1 - Math.exp(-dt * 4));
        const ang = lagWorld.angleTo(_q);
        if (ang > 0.3) lagWorld.rotateTowards(_q, ang - 0.3);
      }
      _q2.copy(_q).invert().multiply(lagWorld);
      tilt = approach(tilt, tiltDir * 0.13 * ss(0.35, 0.85, g) * (1 - scr), 1.1, dt);
      const t = s.time + phase;
      const trem = 0.0011 * ss(0.5, 1, g) ** 2 + 0.0045 * scr;
      const rt = 0.007 * ss(0.5, 1, g) ** 2 + 0.045 * scr;
      _e.set(
        Math.sin(t * 0.83) * 0.006 + (rnd() - 0.5) * rt,
        Math.sin(t * 0.57 + 1.3) * 0.008 + (rnd() - 0.5) * rt,
        tilt + Math.sin(t * 0.41) * 0.02 + (rnd() - 0.5) * rt,
      );
      pivot.quaternion.copy(_q2).multiply(_q.setFromEuler(_e));
      let lunge = 0;
      if (scream) {
        holder.getWorldPosition(_v);
        const dCam = camKnown ? _v.distanceTo(camWorld) : s.dist;
        const hs = holder.scale.x || 1;
        lunge = (Math.max(0, dCam - 0.3) * ss(0, 0.24, screamT) ** 2) / hs;
      }
      pivot.position.set(
        (rnd() - 0.5) * trem,
        Math.sin(t * 1.15) * 0.0013 + (rnd() - 0.5) * trem,
        -(1 - fade) * (flat ? 0.006 : 0.04) + lunge + (rnd() - 0.5) * trem,
      );

      // ── eyes: drift and stare past you, then lock on (they never blink) ──
      holder.updateMatrixWorld(true);
      if (camKnown) _v.copy(camWorld);
      else _v.set(0, 0, s.dist / (holder.scale.x || 1)).applyMatrix4(holder.matrixWorld);
      pivot.worldToLocal(_v).divideScalar(scale);
      lock = approach(lock, scream ? 1 : ss(0.3, 0.5, g), scream ? 30 : 9, dt);
      wanderT -= dt;
      if (wanderT <= 0) {
        wanderT = 0.7 + rnd() * 1.8;
        const a = rnd() * Math.PI * 2, m = 0.06 + rnd() * 0.07;
        wander.set(Math.cos(a) * m, Math.sin(a) * m * 0.6);
      }
      for (let i = 0; i < 2; i++) {
        const c = sh.eyes[i];
        _v2.copy(_v).sub(c).normalize();                       // exactly at the camera (vergence)
        const far = _v.length() > 1e-4 ? _v.clone().normalize() : Z_AXIS.clone();
        far.x += wander.x; far.y += wander.y; far.normalize(); // parallel stare that misses you
        _v2.lerp(far, 1 - lock).normalize();
        eyeDir[i].lerp(_v2, 1 - Math.exp(-dt * (lock > 0.5 ? 30 : 20))).normalize();
        const ang = Math.acos(clamp01(eyeDir[i].z));
        if (ang > 0.27) eyeDir[i].lerp(Z_AXIS, 1 - 0.27 / ang).normalize();
        eyes[i].quaternion.setFromUnitVectors(Z_AXIS, eyeDir[i]);
      }
      pupil = approach(pupil, scream ? 0.034 : lerp(0.118, 0.13, ss(0.85, 1, g)), scream ? 18 : 3, dt);
      u.uPupil.value = pupil;

      // ── glow: faint in the dark, catches the flashlight ──
      const lit = clamp01(s.lit);
      const pulse = 1 + Math.sin(t * 0.7) * 0.035;
      const e = glow * 0.82 * (1 + 0.55 * lit) * (1 + 0.25 * g * g) * (1 + 0.45 * scr) * pulse * (flat ? 1.15 : 1);
      skinMat.emissiveIntensity = e;
      eyeMat.emissiveIntensity = e * 0.86;
      apply();
    },

    setFade(a) {
      fadeCap = clamp01(a);
      fade = Math.min(fade, fadeCap);
      apply();
    },

    setScream(on) {
      if (on === scream) return;
      scream = on;
      screamT = 0;
      if (on) { jaw = Math.max(jaw, 0.25); wide = Math.max(wide, 0.4); lock = 1; }
    },

    dispose() {
      live.delete(entry);
      skinMat.dispose();
      eyeMat.dispose();
    },
  };
}
