import * as THREE from 'three';
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
 * 「顔」— おもてさま.
 *
 * A chalk-white, gaunt woman's head with no body: huge round eyeballs bulging out of black,
 * bruised sockets, a tiny nose, a thin dark mouth stretched into a grin that splits open when it
 * screams, blood running from the eyes, the hairline and the mouth, and long, wet, black hair
 * parted in the middle that frames the face and hangs far below the chin.
 *
 * Everything is generated here (no model file):
 *  - skin: a height field z = surfaceZ(x, y) over the front of the head (head shape + relief).
 *    Its grid has one row lying exactly on the mouth line; inside the mouth that row is doubled,
 *    so the lower lip can drop away from the upper lip (real opening, no texture trick).
 *    The eyelids are a sphere around each eyeball with the aperture cut away; the eyeball meshes
 *    poke through it, so the lid line is wherever the two surfaces cross.
 *  - back of the head: a dark shell with the same silhouette.
 *  - hair: ribbon cards laid over the scalp from a centre parting, then falling straight down.
 *  - textures: painted on canvases at start-up (skin, eye, hair).
 *
 * Face-local metres: origin between the eyes, +Y up, +Z towards the viewer (FaceSystem points
 * +Z at the camera). About 1.3x life size, 0.34 m from the crown to the chin.
 */

// ── proportions ──────────────────────────────────────────────────────────────
const HEAD_Y = 0.005, HEAD_Z = -0.045, HEAD_B = 0.172, HEAD_C = 0.112, BACK_C = 0.1;
const EYE_X = 0.045, EYE_Y = -0.004, EYE_Z = 0.037, EYE_R = 0.021, LID_T = 0.0018;
const AP_X = 0.019, AP_Y = 0.0172; // aperture half width / height (wide open, round)
const MOUTH_Y = -0.093, MOUTH_HW = 0.044, MOUTH_LIFT = 0.0065;
const JAW_Y = -0.03, JAW_Z = -0.075, JAW_ANGLE = 0.34;
const TEX_X0 = -0.12, TEX_W = 0.24, TEX_Y0 = -0.18, TEX_H = 0.37;

// morph slots
const M_SMILE_L = 0, M_SMILE_R = 1, M_JAW = 2, M_WIDE = 3, M_STRETCH = 4;

// ── math ─────────────────────────────────────────────────────────────────────
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function ss(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function gauss(dx: number, dy: number, sx: number, sy: number): number {
  const a = dx / sx, b = dy / sy;
  return Math.exp(-a * a - b * b);
}
/** smooth maximum */
function smax(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * h + k * h * (1 - h);
}
/** 1 along the segment a-b (fading at its ends), gaussian across with width w */
function seg(px: number, py: number, ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return Math.exp(-(qx * qx + qy * qy) / (w * w)) * Math.sin(Math.PI * t);
}
function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x: number, y: number, seed: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise(x * f, y * f, seed + i * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── head shape ───────────────────────────────────────────────────────────────
/** half width of the skull at height y (narrow jaw, pointed chin) */
function skullHalfWidth(y: number): number {
  return 0.103 - 0.008 * ss(0.03, 0.16, y) - 0.03 * ss(-0.02, -0.13, y) - 0.012 * ss(-0.12, -0.172, y);
}
function headS(x: number, y: number): number {
  return Math.pow(Math.abs(x) / skullHalfWidth(y), 2.4) + Math.pow(Math.min(1.2, Math.abs(y - HEAD_Y) / HEAD_B), 2.2);
}
function silhouetteX(y: number): number {
  const t = 1 - Math.pow(Math.min(1, Math.abs(y - HEAD_Y) / HEAD_B), 2.2);
  return skullHalfWidth(y) * Math.pow(Math.max(t, 0), 1 / 2.4);
}
function frontBase(x: number, y: number): number {
  return HEAD_Z + HEAD_C * Math.pow(Math.max(0, 1 - headS(x, y)), 0.45);
}
function backBase(x: number, y: number): number {
  return HEAD_Z - BACK_C * Math.pow(Math.max(0, 1 - headS(x, y)), 0.45);
}
/** inside the head (front or back half), used for laying hair over it */
function insideHead(x: number, y: number, z: number): boolean {
  const dz = z - HEAD_Z;
  const c = dz > 0 ? HEAD_C : BACK_C;
  return headS(x, y) + Math.pow(Math.abs(dz) / c, 1 / 0.45) < 1;
}

function mouthLine(x: number): number {
  const t = Math.min(1, Math.abs(x) / MOUTH_HW);
  return MOUTH_Y + MOUTH_LIFT * t * t;
}

function nose(ax: number, y: number): number {
  const t = clamp01((0.004 - y) / 0.05); // 0 at the bridge, 1 at the tip
  const on = ss(0.014, 0.0, y) * (1 - ss(-0.048, -0.058, y));
  const h = (0.0015 + 0.009 * Math.pow(t, 1.4)) * on;
  const w = 0.005 + 0.004 * t;
  let z = h * Math.exp(-((ax / w) ** 2));
  z += 0.0035 * gauss(ax, y + 0.047, 0.0075, 0.0075); // little tip
  z += 0.003 * gauss(ax - 0.011, y + 0.052, 0.0055, 0.0045); // wings
  z -= 0.0032 * gauss(ax - 0.0062, y + 0.0555, 0.0027, 0.0017); // nostrils
  return z;
}

function lips(x: number, y: number): number {
  const ax = Math.abs(x);
  const t = Math.min(1, ax / MOUTH_HW);
  const k = Math.sqrt(Math.max(0, 1 - t * t));
  const d = y - mouthLine(x);
  let z = 0.0016 * k * Math.exp(-(((d - 0.0026) / 0.0026) ** 2)); // thin upper lip
  z += 0.002 * k * Math.exp(-(((d + 0.0032) / 0.003) ** 2)); // thin lower lip
  z -= 0.0018 * k * Math.exp(-((d / 0.0011) ** 2)); // they roll in at the line
  z -= 0.0022 * gauss(ax - MOUTH_HW - 0.002, d, 0.0045, 0.004); // deep corners
  return z;
}

/** relief added to the head shape (front only) */
function relief(x: number, y: number): number {
  const ax = Math.abs(x);
  let z = 0;
  z += 0.003 * gauss(ax - 0.036, y - 0.032, 0.028, 0.009); // brow
  z += 0.002 * gauss(ax, y - 0.075, 0.045, 0.03); // forehead
  z -= 0.021 * gauss(ax - EYE_X, y - EYE_Y - 0.002, 0.029, 0.027); // deep orbits
  z -= 0.007 * gauss(ax - 0.086, y - 0.03, 0.016, 0.03); // temples
  z += 0.0055 * gauss(ax - 0.068, y + 0.044, 0.02, 0.014); // cheekbones
  z -= 0.011 * gauss(ax - 0.07, y + 0.094, 0.021, 0.026); // hollow cheeks
  z += 0.006 * gauss(ax, y + 0.094, 0.05, 0.03); // teeth arch
  z += 0.0045 * gauss(ax, y + 0.143, 0.018, 0.012); // chin
  z -= 0.0022 * gauss(ax, y + 0.118, 0.02, 0.0042);
  z -= 0.0026 * seg(ax, y, 0.022, -0.05, 0.057, -0.095, 0.003); // nasolabial fold
  z += 0.0018 * seg(ax, y, 0.03, -0.048, 0.064, -0.09, 0.007);
  return z + nose(ax, y) + lips(x, y);
}

/** eyelids: a sphere around each eyeball with the aperture cut out (ap > 1 = opened wider) */
function withLids(x: number, y: number, z: number, ap: number): number {
  const rl = EYE_R + LID_T;
  for (const s of [1, -1]) {
    const dx = x - s * EYE_X, dy = y - EYE_Y;
    const r = Math.hypot(dx, dy);
    if (r > rl + 0.014) continue;
    let lid = r < rl ? EYE_Z + Math.sqrt(rl * rl - r * r) : EYE_Z - 1.1 * (r - rl);
    const e = Math.hypot(dx / (AP_X * ap), dy / (AP_Y * ap));
    lid -= 0.03 * (1 - ss(0.86, 1.04, e));
    z = smax(z, lid, 0.007);
  }
  return z;
}

function surfaceZ(x: number, y: number, ap = 1): number {
  const b = frontBase(x, y);
  const w = ss(0, 0.45, (b - HEAD_Z) / HEAD_C);
  return withLids(x, y, b + relief(x, y) * w, ap);
}

// ── skin mesh ────────────────────────────────────────────────────────────────
const NP = 181, NQ = 241;

/** the mouth row follows the curved mouth line; the bend fades away above and below */
function mouthBend(x: number, yb: number): number {
  const ax = Math.abs(x);
  const b = ax <= MOUTH_HW ? MOUTH_LIFT * (ax / MOUTH_HW) ** 2 : MOUTH_LIFT * Math.exp(-(((ax - MOUTH_HW) / 0.02) ** 2));
  return b * Math.exp(-(((yb - MOUTH_Y) / 0.022) ** 2));
}

interface Skin {
  geo: THREE.BufferGeometry;
  /** rest positions, for the morphs */
  rest: Float32Array;
  jawW: Float32Array;
}

function rowHeights(): number[] {
  const ys: number[] = [];
  for (let j = 0; j < NQ; j++) {
    const q = -1 + (2 * j) / (NQ - 1);
    ys.push(HEAD_Y + HEAD_B * 0.997 * Math.sin((q * Math.PI) / 2));
  }
  let jm = 0;
  for (let j = 1; j < NQ; j++) if (Math.abs(ys[j] - MOUTH_Y) < Math.abs(ys[jm] - MOUTH_Y)) jm = j;
  ys[jm] = MOUTH_Y;
  return ys;
}

function buildSkin(): Skin {
  const ys = rowHeights();
  const jm = ys.indexOf(MOUTH_Y);
  const pos: number[] = [], uv: number[] = [], jaw: number[] = [];
  const id = new Int32Array(NP * NQ);
  const lower = new Int32Array(NP).fill(-1);
  const push = (x: number, y: number, z: number, w: number): number => {
    pos.push(x, y, z);
    uv.push((x - TEX_X0) / TEX_W, (y - TEX_Y0) / TEX_H);
    jaw.push(w);
    return pos.length / 3 - 1;
  };
  const jawWeight = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    let w: number;
    if (ax <= MOUTH_HW) w = y < mouthLine(x) - 1e-7 ? 1 : 0;
    else {
      const d = mouthLine(MOUTH_HW) + (ax - MOUTH_HW) * 0.7 - y;
      w = d <= 0 ? 0 : ss(0, 1, d / (1e-4 + (ax - MOUTH_HW) * 1.3));
    }
    return w * ss(HEAD_Z - 0.005, HEAD_Z + 0.03, z);
  };
  for (let j = 0; j < NQ; j++) {
    const yb = ys[j];
    const half = silhouetteX(yb);
    for (let i = 0; i < NP; i++) {
      const p = -1 + (2 * i) / (NP - 1);
      const x = half * Math.sin(((p * Math.PI) / 2) * 0.997);
      const y = yb + mouthBend(x, yb);
      const z = surfaceZ(x, y);
      id[j * NP + i] = push(x, y, z, jawWeight(x, y, z));
      if (j === jm && Math.abs(x) < MOUTH_HW - 1e-4) lower[i] = push(x, y, z, 1);
    }
  }
  const idx: number[] = [];
  const v = (i: number, j: number, below: boolean): number => (below && j === jm && lower[i] >= 0 ? lower[i] : id[j * NP + i]);
  for (let j = 0; j < NQ - 1; j++) {
    const below = j + 1 === jm;
    for (let i = 0; i < NP - 1; i++) {
      const a = v(i, j, false), b = v(i + 1, j, false), c = v(i + 1, j + 1, below), d = v(i, j + 1, below);
      // keep the diagonal pointing away from the middle so both halves mirror
      if ((i < (NP - 1) / 2) === (j < NQ / 2)) idx.push(a, b, c, a, c, d);
      else idx.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  const rest = new Float32Array(pos);
  geo.setAttribute('position', new THREE.BufferAttribute(rest.slice(), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return { geo, rest, jawW: new Float32Array(jaw) };
}

/** cavity shading: how far each point lies below its blurred surroundings */
function bakeOcclusion(s: Skin): void {
  const n = s.rest.length / 3;
  const col = new Float32Array(n * 3);
  const R1 = 0.005, R2 = 0.013;
  for (let i = 0; i < n; i++) {
    const x = s.rest[i * 3], y = s.rest[i * 3 + 1], z = s.rest[i * 3 + 2];
    let a1 = 0, a2 = 0;
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      a1 += surfaceZ(x + Math.cos(ang) * R1, y + Math.sin(ang) * R1);
      a2 += surfaceZ(x + Math.cos(ang + 0.5) * R2, y + Math.sin(ang + 0.5) * R2);
    }
    const cav = Math.max(0, a1 / 6 - z) * 70 + Math.max(0, a2 / 6 - z) * 22;
    const edge = ss(HEAD_Z - 0.01, HEAD_Z + 0.04, z);
    const o = Math.max(0.25, 1 - cav) * lerp(0.35, 1, edge);
    col[i * 3] = o; col[i * 3 + 1] = o; col[i * 3 + 2] = o;
  }
  s.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

type Morph = (x: number, y: number, z: number, jw: number, out: THREE.Vector3) => void;

function rotateJaw(y: number, z: number, a: number, out: THREE.Vector3): void {
  const dy = y - JAW_Y, dz = z - JAW_Z, c = Math.cos(a), s = Math.sin(a);
  out.y = JAW_Y + dy * c - dz * s - y;
  out.z = JAW_Z + dy * s + dz * c - z;
}
const smileMorph = (side: number): Morph => (x, y, _z, _jw, o) => {
  const c = gauss(x - side * MOUTH_HW, y - mouthLine(MOUTH_HW), 0.015, 0.013);
  const ck = gauss(x - side * 0.06, y + 0.062, 0.018, 0.018);
  o.set(side * 0.0022 * c, 0.0055 * c + 0.0022 * ck, -0.0016 * c + 0.0016 * ck);
};
const jawMorph: Morph = (_x, y, z, jw, o) => {
  o.set(0, 0, 0);
  if (jw > 0) rotateJaw(y, z, JAW_ANGLE * jw, o);
};
const wideMorph: Morph = (x, y, z, _jw, o) => {
  o.set(0, 0, 0);
  if (Math.abs(Math.abs(x) - EYE_X) < 0.04 && Math.abs(y - EYE_Y) < 0.04) o.z = surfaceZ(x, y, 1.14) - z;
  o.y = 0.0035 * gauss(Math.abs(x) - 0.04, y - 0.032, 0.032, 0.016);
};
const stretchMorph: Morph = (x, y, _z, jw, o) => {
  const ax = Math.abs(x), sx = Math.sign(x) || 1;
  const c = gauss(ax - MOUTH_HW, y - mouthLine(MOUTH_HW), 0.017, 0.016);
  o.set(sx * 0.009 * c, -0.004 * c, -0.003 * c);
  // the upper lip peels up off the teeth
  const d = y - mouthLine(x);
  if (jw < 0.5 && ax < MOUTH_HW * 1.1 && d >= 0) o.y += 0.004 * Math.exp(-((d / 0.012) ** 2)) * (1 - (ax / (MOUTH_HW * 1.1)) ** 2);
};
const MORPHS: Morph[] = [smileMorph(1), smileMorph(-1), jawMorph, wideMorph, stretchMorph];

function addMorphs(s: Skin): void {
  const g = s.geo;
  const n = s.rest.length / 3;
  g.computeVertexNormals();
  const n0 = (g.attributes.normal.array as Float32Array).slice();
  const probe = new THREE.BufferGeometry();
  probe.setIndex(g.index);
  const o = new THREE.Vector3();
  const dPos: THREE.BufferAttribute[] = [], dNor: THREE.BufferAttribute[] = [];
  for (const m of MORPHS) {
    const d = new Float32Array(n * 3), moved = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = s.rest[i * 3], y = s.rest[i * 3 + 1], z = s.rest[i * 3 + 2];
      m(x, y, z, s.jawW[i], o);
      d[i * 3] = o.x; d[i * 3 + 1] = o.y; d[i * 3 + 2] = o.z;
      moved[i * 3] = x + o.x; moved[i * 3 + 1] = y + o.y; moved[i * 3 + 2] = z + o.z;
    }
    probe.setAttribute('position', new THREE.BufferAttribute(moved, 3));
    probe.computeVertexNormals();
    const nn = probe.attributes.normal.array as Float32Array;
    const dn = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) dn[i] = nn[i] - n0[i];
    probe.deleteAttribute('normal');
    dPos.push(new THREE.BufferAttribute(d, 3));
    dNor.push(new THREE.BufferAttribute(dn, 3));
  }
  g.morphAttributes.position = dPos;
  g.morphAttributes.normal = dNor;
  g.morphTargetsRelative = true;
  g.computeBoundingSphere();
}

function buildBack(): THREE.BufferGeometry {
  const P = 61, Q = 81;
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j < Q; j++) {
    const yb = HEAD_Y + HEAD_B * 0.997 * Math.sin(((-1 + (2 * j) / (Q - 1)) * Math.PI) / 2);
    const half = silhouetteX(yb);
    for (let i = 0; i < P; i++) {
      const x = half * Math.sin(((-1 + (2 * i) / (P - 1)) * Math.PI) / 2 * 0.997);
      pos.push(x, yb, backBase(x, yb));
    }
  }
  for (let j = 0; j < Q - 1; j++) for (let i = 0; i < P - 1; i++) {
    const a = j * P + i, b = a + 1, c = a + P + 1, d = a + P;
    idx.push(a, c, b, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── eyeballs ─────────────────────────────────────────────────────────────────
function buildEye(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(EYE_R, 40, 30);
  g.rotateX(Math.PI / 2); // a pole on +Z: that is where it looks
  const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    // the cornea bulges a little
    const ang = Math.acos(clamp01(v.z));
    const r = EYE_R + 0.0011 * Math.cos(Math.min(1, ang / 0.55) * Math.PI * 0.5) ** 2;
    p.setXYZ(i, v.x * r, v.y * r, v.z * r);
    const k = v.z >= 0 ? 0.5 : 0.5 / Math.max(Math.hypot(v.x, v.y), 1e-3);
    uv.setXY(i, 0.5 + v.x * k, 0.5 + v.y * k);
  }
  g.computeVertexNormals();
  return g;
}

// ── hair ─────────────────────────────────────────────────────────────────────
/** point on the head surface in direction d from the head centre */
function scalpPoint(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  let lo = 0, hi = 0.3;
  for (let k = 0; k < 26; k++) {
    const m = (lo + hi) / 2;
    if (insideHead(d.x * m, HEAD_Y + d.y * m, HEAD_Z + d.z * m)) lo = m; else hi = m;
  }
  out.set(d.x * lo, HEAD_Y + d.y * lo, HEAD_Z + d.z * lo);
  if (out.z > HEAD_Z + 0.01 && Math.abs(out.x) < silhouetteX(out.y)) out.z = Math.max(out.z, surfaceZ(out.x, out.y));
  return out;
}

interface HairBuf { pos: number[]; nor: number[]; uv: number[]; idx: number[] }

/** a ribbon along pts; normals ns (outward); width tapers to the tip */
function ribbon(h: HairBuf, pts: THREE.Vector3[], ns: THREE.Vector3[], width: number, u0: number, du: number): void {
  const t = new THREE.Vector3(), w = new THREE.Vector3();
  const base = h.pos.length / 3;
  let len = 0;
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push((len += pts[i].distanceTo(pts[i - 1])));
  for (let i = 0; i < pts.length; i++) {
    t.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    w.crossVectors(t, ns[i]).normalize();
    const f = acc[i] / len;
    const hw = (width / 2) * (1 - 0.55 * f * f) * (0.75 + 0.25 * ss(0, 0.06, f));
    for (const sgn of [-1, 1]) {
      h.pos.push(pts[i].x + w.x * hw * sgn, pts[i].y + w.y * hw * sgn, pts[i].z + w.z * hw * sgn);
      h.nor.push(ns[i].x, ns[i].y, ns[i].z);
      h.uv.push(u0 + (sgn > 0 ? du : 0), 1 - f);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = base + i * 2;
    h.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
}

function buildHair(long: boolean): THREE.BufferGeometry {
  const r = random(long ? 4242 : 77);
  const h: HairBuf = { pos: [], nor: [], uv: [], idx: [] };
  const d = new THREE.Vector3(), p = new THREE.Vector3(), out = new THREE.Vector3();
  const dRoot = new THREE.Vector3(), dFall = new THREE.Vector3();
  const N = 120;
  for (const s of [1, -1]) {
    for (let k = 0; k < N; k++) {
      const f = clamp01((k + r() * 0.8) / N); // 0 = at the forehead, 1 = at the back
      const layer = Math.floor(r() * 4);
      const tr = lerp(0.98, 2.4, f) + (r() - 0.5) * 0.05;
      dRoot.set(s * (0.025 + r() * 0.03), Math.sin(tr), Math.cos(tr)).normalize();
      const az = lerp(0.88, 3.08, Math.pow(f, 0.85)) + (r() - 0.5) * 0.08;
      dFall.set(s * Math.sin(az), -0.08 - 0.12 * f, Math.cos(az)).normalize();
      const off = 0.0028 + layer * 0.0022 + r() * 0.001;
      const pts: THREE.Vector3[] = [], ns: THREE.Vector3[] = [];
      // over the scalp
      const HN = 12;
      for (let i = 0; i <= HN; i++) {
        const u = i / HN;
        d.copy(dRoot).lerp(dFall, u).normalize();
        scalpPoint(d, p);
        out.set(p.x, p.y - HEAD_Y, p.z - HEAD_Z).normalize();
        pts.push(p.clone().addScaledVector(out, off + 0.0015 * u));
        ns.push(out.clone());
      }
      // and straight down
      const F = pts[pts.length - 1].clone();
      const n = new THREE.Vector3(F.x, 0, F.z - HEAD_Z).normalize();
      const along = new THREE.Vector3(-n.z, 0, n.x);
      const L = long ? 0.29 + r() * 0.1 - 0.04 * f : 0.07 + r() * 0.04;
      const ph = r() * 6.28, amp = 0.0012 + r() * 0.0018;
      const front = 1 - ss(0.15, 0.4, f);
      const M = long ? 22 : 8;
      for (let i = 1; i <= M; i++) {
        const t = i / M, hgt = t * L;
        const q = F.clone();
        q.y -= hgt;
        q.addScaledVector(n, 0.006 * t + 0.003 * Math.sin(t * 3.1));
        q.addScaledVector(along, Math.sin(ph + t * 9) * amp * t);
        if (long) {
          // the front locks fall inwards in front of where the neck would be
          const below = ss(-0.15, -0.36, q.y) * front;
          q.x *= 1 - 0.32 * below;
          q.z += 0.03 * below;
        }
        // stay on top of the jaw / cheek
        for (let it = 0; it < 40 && insideHead(q.x - n.x * off, q.y, q.z - n.z * off); it++) q.addScaledVector(n, 0.0012);
        if (q.z > HEAD_Z && Math.abs(q.x) < silhouetteX(q.y)) {
          const zs = surfaceZ(q.x, q.y);
          if (q.z < zs + off && Math.abs(q.x) > 0.06) q.addScaledVector(n, 0.0015);
        }
        pts.push(q);
        ns.push(n.clone());
      }
      const width = (f < 0.25 ? 0.014 : 0.02) + r() * 0.012;
      ribbon(h, pts, ns, width, r() * 0.74, 0.26);
    }
  }
  // a few wet strands stuck to the forehead and cheeks
  for (const s of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      const x0 = s * (0.064 + k * 0.006 + r() * 0.004);
      const y0 = 0.1 - 5.5 * x0 * x0 - 0.004;
      const len = 0.07 + r() * 0.1;
      const drift = s * (0.006 + r() * 0.014);
      const pts: THREE.Vector3[] = [], ns: THREE.Vector3[] = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const x = x0 + drift * t * t + Math.sin(t * 7 + k) * 0.0015;
        const y = y0 - len * t;
        const z = Math.max(surfaceZ(x, y), frontBase(x, y) - 0.01) + 0.0014;
        pts.push(new THREE.Vector3(x, y, z));
        const nx = (surfaceZ(x - 0.002, y) - surfaceZ(x + 0.002, y)) / 0.004;
        const ny = (surfaceZ(x, y - 0.002) - surfaceZ(x, y + 0.002)) / 0.004;
        ns.push(new THREE.Vector3(nx, ny, 1).normalize());
      }
      ribbon(h, pts, ns, 0.004 + r() * 0.004, 0.02 + r() * 0.9, 0.06);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(h.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(h.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(h.uv, 2));
  g.setIndex(h.idx);
  return g;
}

// ── textures ─────────────────────────────────────────────────────────────────
const SKIN_W = 640, SKIN_H = Math.round((SKIN_W * TEX_H) / TEX_W);
const tx = (x: number): number => ((x - TEX_X0) / TEX_W) * SKIN_W;
const ty = (y: number): number => (1 - (y - TEX_Y0) / TEX_H) * SKIN_H;
const PX = SKIN_W / TEX_W; // pixels per metre

function hairTop(x: number): number {
  return 0.104 - 5.5 * x * x;
}
function hairSide(y: number): number {
  return 0.083 - 0.011 * ss(0, -0.12, y);
}

function mix(c: number[], to: readonly number[], t: number): void {
  if (t <= 0) return;
  t = Math.min(1, t);
  c[0] += (to[0] - c[0]) * t;
  c[1] += (to[1] - c[1]) * t;
  c[2] += (to[2] - c[2]) * t;
}

/** a blood run: drips down with gravity, wobbling, thinning, ending in a bead */
function drip(g: CanvasRenderingContext2D, r: () => number, x: number, y: number, len: number, w: number, a = 0.9): void {
  let px = tx(x), py = ty(y);
  const steps = Math.max(4, Math.round(len * PX));
  let wob = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    wob += (r() - 0.5) * 0.35;
    wob *= 0.9;
    px += wob * 0.4;
    py += 1;
    const rad = Math.max(0.6, ((w * PX) / 2) * (1 - 0.55 * t) * (0.85 + 0.3 * noise(i * 0.08, x * 99, 3)));
    g.fillStyle = `rgba(${62 + r() * 18},${5 + r() * 5},${7 + r() * 5},${a * (0.75 + 0.25 * (1 - t)) * (0.75 + 0.25 * noise(i * 0.05, x * 50, 8))})`;
    g.beginPath();
    g.arc(px, py, rad, 0, Math.PI * 2);
    g.fill();
  }
  const rb = Math.max(1.2, w * PX * 0.62);
  g.fillStyle = `rgba(48,3,5,${a})`;
  g.beginPath();
  g.ellipse(px, py + rb * 0.4, rb, rb * 1.3, 0, 0, Math.PI * 2);
  g.fill();
}

function paintSkin(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SKIN_W;
  cv.height = SKIN_H;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(SKIN_W, SKIN_H);
  const D = img.data;
  const c = [0, 0, 0];
  const BASE = [206, 203, 194], GREY = [128, 130, 128], GRIME = [150, 146, 134];
  const SOCKET = [20, 13, 13], RIM = [96, 22, 24], BRUISE = [78, 56, 58];
  const LIP = [48, 16, 19], LINE = [10, 3, 5], NOSTRIL = [26, 12, 13], HAIR = [13, 12, 14], STAIN = [84, 18, 20];
  for (let py = 0; py < SKIN_H; py++) {
    const y = TEX_Y0 + (1 - (py + 0.5) / SKIN_H) * TEX_H;
    const sil = Math.max(1e-4, silhouetteX(y));
    for (let px = 0; px < SKIN_W; px++) {
      const x = TEX_X0 + ((px + 0.5) / SKIN_W) * TEX_W, ax = Math.abs(x);
      c[0] = BASE[0]; c[1] = BASE[1]; c[2] = BASE[2];
      // chalky, blotchy, greyer towards the sides
      const m = fbm(x * 60, y * 60, 5) - 0.5, m2 = fbm(x * 180, y * 180, 9) - 0.5;
      c[0] += m * 34 + m2 * 14; c[1] += m * 32 + m2 * 13; c[2] += m * 26 + m2 * 13;
      mix(c, GREY, 0.7 * ss(0.55, 1.0, ax / sil));
      mix(c, GRIME, 0.75 * ss(0.5, 0.78, fbm(x * 25 + 4, y * 25, 21)));
      mix(c, [92, 84, 80], 0.35 * ss(0.62, 0.85, fbm(x * 70 - 3, y * 55, 41)));
      // sockets: black, smudged, bruised; raw red at the lids
      for (const s of [1, -1]) {
        const dx = x - s * EYE_X, dy = y - EYE_Y;
        if (Math.abs(dx) > 0.07 || Math.abs(dy) > 0.07) continue;
        const e = Math.hypot(dx / AP_X, dy / AP_Y) * (1 + 0.12 * (fbm(x * 90, y * 90, 31) - 0.5));
        mix(c, BRUISE, 0.7 * ss(3.9, 2.2, e));
        mix(c, SOCKET, 0.97 * ss(3.0, 1.35, e) ** 1.1);
        mix(c, SOCKET, 0.75 * gauss(dx, dy + 0.026, 0.024, 0.013));
        mix(c, RIM, 0.55 * Math.exp(-(((e - 1.0) / 0.09) ** 2)));
      }
      // nose: just two dark holes and a shadow under the tip
      mix(c, NOSTRIL, 0.95 * gauss(ax - 0.0062, y + 0.0555, 0.0031, 0.002));
      mix(c, BRUISE, 0.35 * gauss(ax, y + 0.06, 0.012, 0.004));
      mix(c, BRUISE, 0.25 * seg(ax, y, 0.022, -0.05, 0.057, -0.095, 0.004));
      // the mouth: thin dark lips, black line, smeared red around it
      const t = ax / MOUTH_HW, d = y - mouthLine(x);
      if (t < 1.4 && Math.abs(d) < 0.04) {
        const k = Math.sqrt(Math.max(0, 1 - Math.min(1, t) ** 2));
        mix(c, STAIN, 0.55 * gauss(ax, d + 0.006, 0.052, 0.016) * (0.6 + 0.8 * fbm(x * 120, y * 120, 12)));
        const lip = (d > 0 ? ss(0.0058 * k + 0.0008, 0.0012, d) : ss(-0.0075 * k - 0.0008, -0.0015, d)) * ss(1.12, 0.85, t);
        mix(c, LIP, 0.9 * lip);
        mix(c, LINE, Math.exp(-((d / 0.0011) ** 2)) * ss(1.15, 0.95, t));
        mix(c, LINE, 0.7 * gauss(ax - MOUTH_HW - 0.001, d, 0.004, 0.0028));
      }
      // hairline: under the hair it is dark
      const hairy = Math.max(ss(-0.004, 0.006, y - hairTop(x)), ss(-0.004, 0.006, ax - hairSide(y)));
      mix(c, HAIR, hairy);
      const gr = (hash(px, py, 1) - 0.5) * 8;
      const o = (py * SKIN_W + px) * 4;
      D[o] = c[0] + gr; D[o + 1] = c[1] + gr; D[o + 2] = c[2] + gr; D[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const r = random(13);
  // faint grey veins at the temples and forehead
  g.lineCap = 'round';
  for (const s of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      let x = tx(s * (0.05 + r() * 0.025)), y = ty(0.05 + r() * 0.04);
      let ang = Math.PI / 2 + s * (0.3 + r() * 0.5);
      g.strokeStyle = `rgba(90,96,120,${0.12 + r() * 0.1})`;
      g.lineWidth = 1 + r();
      g.beginPath();
      g.moveTo(x, y);
      for (let i = 0; i < 30; i++) {
        ang += (r() - 0.5) * 0.6;
        x += Math.cos(ang) * 2.4;
        y += Math.sin(ang) * 2.4;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  // blood: from the hairline down the forehead and over the nose
  for (const [x, len, w, a] of [[-0.007, 0.16, 0.0019, 0.85], [0.016, 0.09, 0.0014, 0.6], [-0.031, 0.06, 0.0012, 0.5]]) {
    drip(g, r, x, hairTop(x) + 0.004, len, w, a);
  }
  // from under the eyes
  for (const s of [1, -1]) {
    const n = s > 0 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const x = s * EYE_X + (k - (n - 1) / 2) * 0.009 + (r() - 0.5) * 0.004;
      drip(g, r, x, EYE_Y - AP_Y * 0.9, 0.025 + r() * (k === 0 ? 0.11 : 0.05), 0.0013 + r() * 0.0012, 0.55 + r() * 0.35);
    }
  }
  // from the mouth down the chin
  for (const [x, len, w] of [[-0.024, 0.07, 0.0022], [-0.006, 0.035, 0.0016], [0.009, 0.09, 0.0026], [0.027, 0.03, 0.0014], [0.038, 0.06, 0.0018]]) {
    drip(g, r, x, mouthLine(x) - 0.004, len, w, 0.8);
  }
  return cv;
}

const IRIS = 0.19; // iris radius in eye uv (the visible eye is about 0.44)

function paintEye(): HTMLCanvasElement {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  const D = img.data;
  const c = [0, 0, 0];
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const u = (px + 0.5) / S - 0.5, v = 0.5 - (py + 0.5) / S;
    const r = Math.hypot(u, v);
    c[0] = 222; c[1] = 216; c[2] = 198;
    mix(c, [176, 112, 100], ss(0.22, 0.46, r)); // raw towards the lids
    const m = fbm(u * 20, v * 20, 3) - 0.5;
    c[0] += m * 10; c[1] += m * 8; c[2] += m * 8;
    if (r < IRIS * 1.15) {
      const a = Math.atan2(v, u);
      const fib = fbm(Math.cos(a) * 6 + 10, Math.sin(a) * 6 + r * 60, 7) - 0.5;
      const iris = [84 + fib * 46, 60 + fib * 34, 38 + fib * 22];
      mix(iris, [34, 22, 14], ss(0.4, 1, r / IRIS));
      mix(iris, [126, 98, 62], 0.35 * Math.exp(-(((r / IRIS - 0.42) / 0.12) ** 2)));
      mix(c, iris, ss(IRIS * 1.06, IRIS * 0.97, r));
      mix(c, [14, 9, 8], 0.85 * Math.exp(-(((r / IRIS - 1) / 0.08) ** 2)));
    }
    const o = (py * S + px) * 4;
    const gr = (hash(px, py, 4) - 0.5) * 5;
    D[o] = c[0] + gr; D[o + 1] = c[1] + gr; D[o + 2] = c[2] + gr; D[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // bloodshot
  const rr = random(5);
  g.lineCap = 'round';
  for (let k = 0; k < 22; k++) {
    const a0 = rr() * Math.PI * 2;
    let x = S / 2 + Math.cos(a0) * S * 0.47, y = S / 2 - Math.sin(a0) * S * 0.47;
    let ang = a0 + Math.PI + (rr() - 0.5) * 0.6;
    const len = 18 + rr() * 34;
    g.strokeStyle = `rgba(150,18,22,${0.45 + rr() * 0.35})`;
    g.lineWidth = 0.8 + rr() * 1.4;
    g.beginPath();
    g.moveTo(x, y);
    for (let i = 0; i < len; i += 2) {
      ang += (rr() - 0.5) * 0.7;
      x += Math.cos(ang) * 2;
      y -= Math.sin(ang) * 2;
      if (Math.hypot(x - S / 2, y - S / 2) < S * IRIS * 1.05) break;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return cv;
}

function paintHair(): HTMLCanvasElement {
  const W = 512, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const r = random(99);
  g.lineCap = 'round';
  g.fillStyle = 'rgba(7,7,8,0.0)';
  for (let k = 0; k < 900; k++) {
    const x0 = r() * W;
    const end = H * (0.62 + r() * 0.38);
    const wet = r() < 0.08;
    const l = wet ? 30 + r() * 26 : 4 + r() * 12;
    g.strokeStyle = `rgba(${l},${l},${l + 6},${0.75 + r() * 0.25})`;
    g.lineWidth = 1.2 + r() * 3;
    const ph = r() * 6, amp = 1 + r() * 3;
    g.beginPath();
    g.moveTo(x0, 0);
    for (let y = 0; y <= end; y += 16) g.lineTo(x0 + Math.sin(ph + y * 0.012) * amp, y);
    g.stroke();
  }
  return cv;
}

// ── materials ────────────────────────────────────────────────────────────────
interface Uniforms {
  uFlat: { value: number };
  uTime: { value: number };
  uPupil: { value: number };
}

const GLITCH = /* glsl */ `
uniform float uFlat;
uniform float uTime;
float kaoHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
vec2 kaoUv(vec2 uv) {
  if (uFlat <= 0.0) return uv;
  float f = floor(uTime * 12.0);
  float tear = step(0.82, kaoHash(vec2(f, 3.0)));
  uv.x += (kaoHash(vec2(floor(uv.y * 90.0), f)) - 0.5) * 0.014 * uFlat * (0.25 + tear);
  return uv;
}
vec3 kaoTv(vec3 c, vec2 uv) {
  if (uFlat <= 0.0) return c;
  float lines = 0.72 + 0.28 * sin(uv.y * 900.0);
  float roll = 0.85 + 0.15 * smoothstep(0.0, 0.15, abs(fract(uv.y * 0.7 - uTime * 0.13) - 0.5));
  float n = kaoHash(floor(uv * vec2(160.0, 240.0)) + floor(uTime * 24.0));
  return c * mix(1.0, lines * roll, uFlat) + (n - 0.5) * 0.22 * uFlat * (0.25 + c);
}
`;

function patchMaterial(m: THREE.MeshStandardMaterial, u: Uniforms, kind: 'skin' | 'eye' | 'hair'): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFlat = u.uFlat;
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uPupil = u.uPupil;
    let mapCode = `vec2 kUv = kaoUv(vMapUv);\nvec4 kTex = texture2D(map, kUv);\n`;
    if (kind === 'eye') mapCode += `kTex.rgb = mix(kTex.rgb, vec3(0.003), 1.0 - smoothstep(uPupil - 0.01, uPupil + 0.004, length(kUv - 0.5)));\n`;
    if (kind === 'hair') mapCode += `if (kTex.a < 0.45) discard;\nkTex.a = 1.0;\n`;
    mapCode += 'diffuseColor *= kTex;';
    let emissive = 'totalEmissiveRadiance *= kTex.rgb;';
    if (kind === 'skin') emissive += '\n#ifdef USE_COLOR\ntotalEmissiveRadiance *= vColor.rgb * vColor.rgb;\n#endif';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLITCH}\nuniform float uPupil;`)
      .replace('#include <map_fragment>', mapCode)
      .replace('#include <emissivemap_fragment>', emissive)
      .replace(
        '#include <opaque_fragment>',
        `outgoingLight = kaoTv(outgoingLight, kUv);\n${kind === 'skin' ? 'if (!gl_FrontFacing) outgoingLight = vec3(0.004, 0.002, 0.002);\n' : ''}#include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `kao-face-${kind}-2`;
}

// ── shared resources ─────────────────────────────────────────────────────────
interface Shared {
  skin: THREE.BufferGeometry;
  back: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  hairLong: THREE.BufferGeometry;
  hairShort: THREE.BufferGeometry;
  skinTex: THREE.CanvasTexture;
  eyeTex: THREE.CanvasTexture;
  hairTex: THREE.CanvasTexture;
}
let shared: Shared | null = null;

function texture(cv: HTMLCanvasElement, color = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function getShared(): Shared {
  if (!shared) {
    const s = buildSkin();
    bakeOcclusion(s);
    addMorphs(s);
    shared = {
      skin: s.geo,
      back: buildBack(),
      eye: buildEye(),
      hairLong: buildHair(true),
      hairShort: buildHair(false),
      skinTex: texture(paintSkin()),
      eyeTex: texture(paintEye()),
      hairTex: texture(paintHair()),
    };
  }
  return shared;
}
// build while the game is idle so the first face does not stall a frame
if (typeof window !== 'undefined') {
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(() => getShared()) : getShared()), 300);
}

const camWorld = new THREE.Vector3();
let camKnown = false;
function captureCamera(_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera): void {
  camWorld.setFromMatrixPosition(cam.matrixWorld);
  camKnown = true;
}

// ── the visual ───────────────────────────────────────────────────────────────
const FWD = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();

export function createFaceVisual(opts: FaceOptions): FaceVisual {
  const sh = getShared();
  const flat = opts.style === 'flat';
  const scale = opts.scale ?? 1;
  const glow = opts.glow ?? 0.55;
  const u: Uniforms = { uFlat: { value: flat ? 1 : 0 }, uTime: { value: 0 }, uPupil: { value: 0.07 } };

  const skinMat = new THREE.MeshStandardMaterial({
    map: sh.skinTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.58, metalness: 0,
    vertexColors: true, transparent: true, opacity: 0, side: THREE.DoubleSide,
  });
  patchMaterial(skinMat, u, 'skin');
  const eyeMat = new THREE.MeshStandardMaterial({
    map: sh.eyeTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.08, metalness: 0, transparent: true, opacity: 0,
  });
  patchMaterial(eyeMat, u, 'eye');
  const hairMat = new THREE.MeshStandardMaterial({
    map: sh.hairTex, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.32, metalness: 0,
    side: THREE.DoubleSide, transparent: true, opacity: 0,
  });
  patchMaterial(hairMat, u, 'hair');
  const backMat = new THREE.MeshStandardMaterial({ color: 0x0a090b, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0 });

  const holder = new THREE.Group(); // FaceSystem places / turns / scales this
  holder.name = 'face';
  const pivot = new THREE.Group(); // lag, tilt, breathing, tremor, lunge
  const body = new THREE.Group(); // size, flat squash
  holder.add(pivot);
  pivot.add(body);
  const skin = new THREE.Mesh(sh.skin, skinMat);
  skin.onBeforeRender = captureCamera;
  const back = new THREE.Mesh(sh.back, backMat);
  const hair = new THREE.Mesh(flat ? sh.hairShort : sh.hairLong, hairMat);
  const eyes = [1, -1].map((s) => {
    const e = new THREE.Mesh(sh.eye, eyeMat);
    e.position.set(s * EYE_X, EYE_Y, EYE_Z);
    return e;
  });
  skin.renderOrder = 4;
  back.renderOrder = 3;
  hair.renderOrder = 5;
  for (const m of [skin, back, hair, ...eyes]) {
    m.frustumCulled = false;
    body.add(m);
  }
  for (const e of eyes) e.renderOrder = 3;

  // personality
  const rnd = Math.random;
  const lopsided = rnd() < 0.5 ? [1, 0.55 + rnd() * 0.3] : [0.55 + rnd() * 0.3, 1];
  const tiltDir = rnd() < 0.5 ? -1 : 1;
  const phase = rnd() * 20;

  let age = 0, fade = 0, fadeCap = 1;
  let scream = false, screamT = 0;
  let smile = 0, jaw = 0, wide = 0, stretch = 0, lock = 0, tilt = 0, squash = flat ? 1 : 0, pupil = 0.07;
  let lagInit = false;
  const lag = new THREE.Quaternion();
  const look = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)];
  const wander = new THREE.Vector2();
  let wanderT = 0;

  const ease = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt));
  const applyFade = (): void => {
    skinMat.opacity = fade;
    eyeMat.opacity = fade;
    hairMat.opacity = fade;
    backMat.opacity = fade;
    const solid = fade >= 0.999;
    for (const m of [skinMat, eyeMat, hairMat, backMat]) {
      if (m.transparent === solid) {
        m.transparent = !solid;
        m.needsUpdate = true;
      }
    }
  };

  return {
    object: holder,

    update(dt, s) {
      age += dt;
      const g = clamp01(s.gaze);
      fade = Math.min(1 - (1 - clamp01(age / 0.6)) ** 3, fadeCap);
      if (scream) screamT += dt;
      const scr = scream ? ss(0, 0.15, screamT) : 0;

      // expression: the longer you look, the wider the grin and the eyes
      smile = ease(smile, (0.25 + 0.75 * ss(0.3, 0.8, g)) * (1 - scr), 1.6, dt);
      jaw = scream ? ease(jaw, 1, 14, dt) : ease(jaw, 0.05 + ss(0.8, 1, g) * 0.25, 1, dt);
      wide = ease(wide, scream ? 1 : 0.15 + ss(0.5, 1, g) * 0.5, scream ? 16 : 2, dt);
      stretch = ease(stretch, scream ? 1 : ss(0.85, 1, g) * 0.25, scream ? 12 : 2, dt);
      const inf = skin.morphTargetInfluences;
      if (inf) {
        inf[M_SMILE_L] = smile * lopsided[0];
        inf[M_SMILE_R] = smile * lopsided[1];
        inf[M_JAW] = jaw;
        inf[M_WIDE] = wide;
        inf[M_STRETCH] = stretch;
      }

      squash = flat ? ease(squash, scream ? 0 : 1, 6, dt) : 0;
      body.scale.set(scale, scale, scale * lerp(1, 0.05, squash));
      u.uFlat.value = flat ? lerp(0.35, 1, squash) : 0;
      u.uTime.value = s.time;

      // the head turns late, tilts, breathes and shakes
      holder.updateWorldMatrix(true, false);
      holder.getWorldQuaternion(_q);
      if (!lagInit || scream) {
        lag.copy(_q);
        lagInit = true;
      } else {
        lag.slerp(_q, 1 - Math.exp(-dt * 3.5));
        const a = lag.angleTo(_q);
        if (a > 0.35) lag.rotateTowards(_q, a - 0.35);
      }
      _q2.copy(_q).invert().multiply(lag);
      tilt = ease(tilt, tiltDir * (0.06 + 0.14 * ss(0.3, 0.85, g)) * (1 - scr), 1.2, dt);
      const t = s.time + phase;
      const shake = 0.008 * ss(0.5, 1, g) ** 2 + 0.05 * scr;
      _e.set(
        Math.sin(t * 0.7) * 0.012 + (rnd() - 0.5) * shake,
        Math.sin(t * 0.53 + 1.1) * 0.01 + (rnd() - 0.5) * shake,
        tilt + Math.sin(t * 0.37) * 0.025 + (rnd() - 0.5) * shake,
      );
      pivot.quaternion.copy(_q2).multiply(_q.setFromEuler(_e));
      let lunge = 0;
      if (scream) {
        holder.getWorldPosition(_v);
        const dc = camKnown ? _v.distanceTo(camWorld) : s.dist;
        lunge = (Math.max(0, dc - 0.3) * ss(0, 0.24, screamT) ** 2) / (holder.scale.x || 1);
      }
      const trem = 0.0012 * ss(0.5, 1, g) ** 2 + 0.005 * scr;
      pivot.position.set(
        (rnd() - 0.5) * trem,
        Math.sin(t * 1.1) * 0.0015 + (rnd() - 0.5) * trem,
        -(1 - fade) * (flat ? 0.006 : 0.05) + lunge + (rnd() - 0.5) * trem,
      );

      // eyes: stare past you, then find you and stay on you (they cannot close)
      holder.updateMatrixWorld(true);
      if (camKnown) _v.copy(camWorld);
      else _v.set(0, 0, s.dist / (holder.scale.x || 1)).applyMatrix4(holder.matrixWorld);
      body.worldToLocal(_v);
      lock = ease(lock, scream ? 1 : ss(0.25, 0.45, g), scream ? 30 : 8, dt);
      wanderT -= dt;
      if (wanderT <= 0) {
        wanderT = 0.6 + rnd() * 1.6;
        const a = rnd() * Math.PI * 2, m = 0.08 + rnd() * 0.1;
        wander.set(Math.cos(a) * m, Math.sin(a) * m * 0.6);
      }
      for (let i = 0; i < 2; i++) {
        _w.copy(_v).sub(eyes[i].position).normalize();
        const away = _v.lengthSq() > 1e-8 ? _v.clone().normalize() : FWD.clone();
        away.x += wander.x;
        away.y += wander.y;
        _w.lerp(away.normalize(), 1 - lock).normalize();
        look[i].lerp(_w, 1 - Math.exp(-dt * (lock > 0.5 ? 28 : 16))).normalize();
        const a = Math.acos(clamp01(look[i].z));
        if (a > 0.3) look[i].lerp(FWD, 1 - 0.3 / a).normalize();
        eyes[i].quaternion.setFromUnitVectors(FWD, look[i]);
        eyes[i].scale.setScalar(1 + 0.08 * scr);
      }
      pupil = ease(pupil, scream ? 0.028 : lerp(0.075, 0.06, ss(0.6, 1, g)), scream ? 18 : 3, dt);
      u.uPupil.value = pupil;

      // glows faintly in the dark, brighter in the flashlight
      const lit = clamp01(s.lit);
      const e = glow * 0.62 * (1 + 0.12 * lit) * (1 + 0.25 * g * g) * (1 + 0.4 * scr) * (1 + Math.sin(t * 0.8) * 0.04) * (flat ? 1.15 : 1);
      skinMat.emissiveIntensity = e;
      eyeMat.emissiveIntensity = e * 1.05;
      hairMat.emissiveIntensity = e * 0.22;
      applyFade();
    },

    setFade(a) {
      fadeCap = clamp01(a);
      fade = Math.min(fade, fadeCap);
      applyFade();
    },

    setScream(on) {
      if (on === scream) return;
      scream = on;
      screamT = 0;
      if (on) {
        jaw = Math.max(jaw, 0.3);
        wide = Math.max(wide, 0.5);
        lock = 1;
      }
    },

    dispose() {
      skinMat.dispose();
      eyeMat.dispose();
      hairMat.dispose();
      backMat.dispose();
    },
  };
}
