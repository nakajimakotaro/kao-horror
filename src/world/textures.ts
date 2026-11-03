import * as THREE from 'three';

export type TexDrawer = (g: CanvasRenderingContext2D, w: number, h: number) => void;
export interface TexSpec {
  w: number;
  h: number;
  draw: TexDrawer;
  /** pixelated magnification (default true) */
  nearest?: boolean;
  /** clamp instead of repeat (posters, signs) */
  clamp?: boolean;
}

// ── drawing helpers (shared with textures_content.ts) ───────────────────────
let seed = 1;
export function srand(s: number): void { seed = s >>> 0 || 1; }
export function rnd(): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
}
export function noise(g: CanvasRenderingContext2D, w: number, h: number, amount: number, size = 1, dark = true): void {
  for (let y = 0; y < h; y += size) for (let x = 0; x < w; x += size) {
    const v = rnd();
    if (v < 0.5) continue;
    g.fillStyle = dark ? `rgba(0,0,0,${(v - 0.5) * amount})` : `rgba(255,255,255,${(v - 0.5) * amount})`;
    g.fillRect(x, y, size, size);
  }
}
export function stains(g: CanvasRenderingContext2D, w: number, h: number, n: number, color: string, maxR: number): void {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * maxR;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
export const JP_FONT = '"Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic","Noto Sans JP",sans-serif';
export const JP_SERIF = '"Hiragino Mincho ProN","Yu Mincho","Shippori Mincho","Noto Serif JP",serif';
/** Draw wrapped Japanese text (wraps per character). Returns the y after the last line. */
export function wrapText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      if (g.measureText(line + ch).width > maxW && line) {
        g.fillText(line, x, y);
        y += lineH;
        line = ch;
      } else line += ch;
    }
    g.fillText(line, x, y);
    y += lineH;
  }
  return y;
}
function fill(g: CanvasRenderingContext2D, w: number, h: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(0, 0, w, h);
}

// ── procedural toolkit for the structural textures ─────────────────────────
// Static floors/walls/boxes use world-space UVs (World.boxFaces): one repeat
// per metre unless the layout gives `uv`. Everything below therefore tiles:
// noise lattices are periodic over the texture and every stamp, line and
// streak wraps around the edges. Work happens in a float RGB buffer (sRGB
// 0..255) that is written once with putImageData — fast, and no per-pixel
// fillRect calls. Detail is aimed at the 360p + dither screen: broad tonal
// variation, joints, dirt and wear rather than texel-level noise.

type RGB = readonly [number, number, number];
type Rand = () => number;
type F2 = (u: number, v: number) => number;

const TAU = Math.PI * 2;

/** Local deterministic PRNG (mulberry32); leaves the shared srand/rnd stream alone. */
function prng(s: number): Rand {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function sstep(a: number, b: number, v: number): number { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); }
function wrap(v: number, n: number): number { const r = v % n; return r < 0 ? r + n : r; }
function between(R: Rand, a: number, b: number): number { return a + (b - a) * R(); }
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0;
  const ex = px - ax - dx * t, ey = py - ay - dy * t;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Periodic gradient noise: cx × cy lattice cells per tile, output ≈ [-1, 1]. */
class Perlin {
  private readonly cx: number;
  private readonly cy: number;
  private readonly gx: Float32Array;
  private readonly gy: Float32Array;
  constructor(cx: number, cy: number, s: number) {
    this.cx = Math.max(1, Math.round(cx));
    this.cy = Math.max(1, Math.round(cy));
    const n = this.cx * this.cy, R = prng(s);
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = R() * TAU;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }
  /** u, v in tile units — the pattern repeats every 1. */
  at(u: number, v: number): number {
    const cx = this.cx, cy = this.cy, fx = u * cx, fy = v * cy;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    let x0 = ix % cx; if (x0 < 0) x0 += cx;
    let y0 = iy % cy; if (y0 < 0) y0 += cy;
    const x1 = x0 + 1 === cx ? 0 : x0 + 1;
    const r0 = y0 * cx, r1 = (y0 + 1 === cy ? 0 : y0 + 1) * cx;
    const gx = this.gx, gy = this.gy;
    const a00 = gx[r0 + x0] * tx + gy[r0 + x0] * ty;
    const a10 = gx[r0 + x1] * (tx - 1) + gy[r0 + x1] * ty;
    const a01 = gx[r1 + x0] * tx + gy[r1 + x0] * (ty - 1);
    const a11 = gx[r1 + x1] * (tx - 1) + gy[r1 + x1] * (ty - 1);
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const a = a00 + (a10 - a00) * sx, b = a01 + (a11 - a01) * sx;
    return (a + (b - a) * sy) * 1.41;
  }
}

/** Octaves of periodic noise (each doubles the lattice), weights summing to 1. */
class Fbm {
  private readonly oct: Perlin[] = [];
  private readonly amp: number[] = [];
  constructor(cx: number, cy: number, octaves: number, s: number, gain = 0.5) {
    let a = 1, sum = 0;
    for (let o = 0; o < octaves; o++) {
      this.oct.push(new Perlin(cx * 2 ** o, cy * 2 ** o, s * 31 + o * 977));
      this.amp.push(a);
      sum += a;
      a *= gain;
    }
    for (let o = 0; o < octaves; o++) this.amp[o] /= sum;
  }
  at(u: number, v: number): number {
    let s = 0;
    for (let o = 0; o < this.oct.length; o++) s += this.oct[o].at(u, v) * this.amp[o];
    return s;
  }
}

/** Rescale to zero mean / unit deviation, so amounts and thresholds read in σ. */
function norm(f: Float32Array): Float32Array {
  let s = 0, s2 = 0;
  for (let i = 0; i < f.length; i++) { s += f[i]; s2 += f[i] * f[i]; }
  const mean = s / f.length, sd = Math.sqrt(Math.max(1e-9, s2 / f.length - mean * mean));
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - mean) / sd;
  return f;
}
/** Evaluate a tileable function at every texel (u, v ∈ [0, 1)). */
function field(w: number, h: number, fn: F2, normalise = true): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0, i = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++, i++) out[i] = fn((x + 0.5) / w, v);
  }
  return normalise ? norm(out) : out;
}
/** Like field() for smooth, low-frequency functions: sampled on a coarse grid, bilinearly upsampled. */
function coarse(w: number, h: number, fn: F2, step = 4, normalise = true): Float32Array {
  const gw = Math.max(4, Math.round(w / step)), gh = Math.max(4, Math.round(h / step));
  const grid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) grid[j * gw + i] = fn(i / gw, j / gh);
  const out = new Float32Array(w * h);
  for (let y = 0, k = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * gh, j0 = Math.floor(fy) % gh, j1 = (j0 + 1) % gh, ty = fy - Math.floor(fy);
    for (let x = 0; x < w; x++, k++) {
      const fx = ((x + 0.5) / w) * gw, i0 = Math.floor(fx) % gw, i1 = (i0 + 1) % gw, tx = fx - Math.floor(fx);
      const a = grid[j0 * gw + i0] + (grid[j0 * gw + i1] - grid[j0 * gw + i0]) * tx;
      const b = grid[j1 * gw + i0] + (grid[j1 * gw + i1] - grid[j1 * gw + i0]) * tx;
      out[k] = a + (b - a) * ty;
    }
  }
  return normalise ? norm(out) : out;
}
/** field() evaluated exactly per column but only every `step` rows (linear in between, wrapping):
 *  for patterns that change fast across x and slowly along y, like wood grain. Not normalised. */
function fieldRows(w: number, h: number, fn: F2, step: number): Float32Array {
  const rows = Math.max(2, Math.round(h / step)), grid = new Float32Array(rows * w);
  for (let j = 0; j < rows; j++) for (let x = 0; x < w; x++) grid[j * w + x] = fn((x + 0.5) / w, j / rows);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * rows, j0 = Math.floor(fy) % rows, j1 = (j0 + 1) % rows, t = fy - Math.floor(fy);
    for (let x = 0; x < w; x++) out[y * w + x] = grid[j0 * w + x] + (grid[j1 * w + x] - grid[j0 * w + x]) * t;
  }
  return out;
}
/** White noise smoothed by two wrapping box-blur passes per axis: cheap fine relief, or streaks
 *  when rx ≠ ry (feature size ≈ 2r + 1 px). Normalised. */
function blurNoise(w: number, h: number, R: Rand, rx: number, ry: number): Float32Array {
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = R();
  for (let pass = 0; pass < 2; pass++) {
    if (rx > 0) {
      for (let y = 0; y < h; y++) {
        const o = y * w;
        let s = 0;
        for (let k = -rx; k <= rx; k++) s += a[o + wrap(k, w)];
        let add = rx + 1 - w, sub = -rx;   // sliding window ends, wrapped by hand
        for (let x = 0; x < w; x++, add++, sub++) {
          b[o + x] = s;
          s += a[o + (add < 0 ? add + w : add)] - a[o + (sub < 0 ? sub + w : sub)];
        }
      }
      a.set(b);
    }
    if (ry > 0) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -ry; k <= ry; k++) s += a[wrap(k, h) * w + x];
        let add = ry + 1 - h, sub = -ry;
        for (let y = 0; y < h; y++, add++, sub++) {
          b[y * w + x] = s;
          s += a[(add < 0 ? add + h : add) * w + x] - a[(sub < 0 ? sub + h : sub) * w + x];
        }
      }
      a.set(b);
    }
  }
  return norm(a);
}
/** Relief shading of a height field, lit from the top-left (wraps). */
function emboss(hf: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = hf[ym + (x - 1 + w) % w] - hf[yp + (x + 1) % w];
  }
  return norm(out);
}

/** Float RGB working image with wrap-around addressing. */
class Img {
  readonly w: number;
  readonly h: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  constructor(w: number, h: number, c: RGB) {
    this.w = w;
    this.h = h;
    this.r = new Float32Array(w * h).fill(c[0]);
    this.g = new Float32Array(w * h).fill(c[1]);
    this.b = new Float32Array(w * h).fill(c[2]);
  }
  /** Index of the texel containing (x, y), wrapped. */
  at(x: number, y: number): number {
    return wrap(Math.floor(y), this.h) * this.w + wrap(Math.floor(x), this.w);
  }
  set(i: number, c: RGB): void { this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2]; }
  mix(i: number, c: RGB, a: number): void {
    if (!(a > 0)) return;
    if (a > 1) a = 1;
    this.r[i] += (c[0] - this.r[i]) * a;
    this.g[i] += (c[1] - this.g[i]) * a;
    this.b[i] += (c[2] - this.b[i]) * a;
  }
  mul(i: number, k: number): void { this.r[i] *= k; this.g[i] *= k; this.b[i] *= k; }
  /** brightness × (1 + f·k) */
  shade(f: Float32Array, k: number): void { for (let i = 0; i < f.length; i++) this.mul(i, 1 + f[i] * k); }
  /** blend towards c by coverage m × a */
  paint(m: Float32Array, c: RGB, a = 1): void { for (let i = 0; i < m.length; i++) if (m[i] > 0) this.mix(i, c, m[i] * a); }
  /** blend towards c where f exceeds `from` (in σ), ramping to full `a` at `to` */
  tint(f: Float32Array, c: RGB, from: number, to: number, a: number): void {
    for (let i = 0; i < f.length; i++) if (f[i] > from) this.mix(i, c, sstep(from, to, f[i]) * a);
  }
  disc(cx: number, cy: number, r: number, c: RGB, a = 1, soft = 0): void {
    const e = r + 1.5;
    for (let y = Math.floor(cy - e); y <= Math.ceil(cy + e); y++) for (let x = Math.floor(cx - e); x <= Math.ceil(cx + e); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const cov = clamp01((r + 0.5 - Math.sqrt(dx * dx + dy * dy)) / (1 + r * soft));
      if (cov > 0) this.mix(this.at(x, y), c, cov * a);
    }
  }
  seg(x0: number, y0: number, x1: number, y1: number, r: number, c: RGB, a = 1): void {
    const e = r + 1.5;
    for (let y = Math.floor(Math.min(y0, y1) - e); y <= Math.ceil(Math.max(y0, y1) + e); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - e); x <= Math.ceil(Math.max(x0, x1) + e); x++) {
        const cov = clamp01(r + 0.5 - segDist(x + 0.5, y + 0.5, x0, y0, x1, y1));
        if (cov > 0) this.mix(this.at(x, y), c, cov * a);
      }
    }
  }
  /** luminance grain, ± amt/2 levels */
  grain(R: Rand, amt: number): void {
    for (let i = 0; i < this.r.length; i++) {
      const d = (R() - 0.5) * amt;
      this.r[i] += d; this.g[i] += d; this.b[i] += d;
    }
  }
  put(g: CanvasRenderingContext2D): void {
    const id = g.createImageData(this.w, this.h);
    const px = new Uint32Array(id.data.buffer, id.data.byteOffset, this.w * this.h); // RGBA bytes, little-endian
    const q = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
    for (let i = 0; i < px.length; i++) px[i] = (0xff000000 | (q(this.b[i]) << 16) | (q(this.g[i]) << 8) | q(this.r[i])) >>> 0;
    g.putImageData(id, 0, 0);
  }
}

/** Coverage layer 0..1 (max-blended, wraps) for marks coloured in one go. */
class Mask {
  readonly w: number;
  readonly h: number;
  readonly v: Float32Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.v = new Float32Array(w * h);
  }
  plot(x: number, y: number, a: number): void {
    const i = wrap(y, this.h) * this.w + wrap(x, this.w);
    if (a > this.v[i]) this.v[i] = a;
  }
  /** Anti-aliased disc; soft 0 = crisp edge, 1 = fades from the centre. */
  disc(cx: number, cy: number, r: number, a = 1, soft = 0): void {
    const e = r + 1.5;
    for (let y = Math.floor(cy - e); y <= Math.ceil(cy + e); y++) for (let x = Math.floor(cx - e); x <= Math.ceil(cx + e); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const cov = clamp01((r + 0.5 - Math.sqrt(dx * dx + dy * dy)) / (1 + r * soft));
      if (cov > 0) this.plot(x, y, cov * a);
    }
  }
  seg(x0: number, y0: number, x1: number, y1: number, r: number, a = 1): void {
    const e = r + 1.5;
    for (let y = Math.floor(Math.min(y0, y1) - e); y <= Math.ceil(Math.max(y0, y1) + e); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - e); x <= Math.ceil(Math.max(x0, x1) + e); x++) {
        const cov = clamp01(r + 0.5 - segDist(x + 0.5, y + 0.5, x0, y0, x1, y1));
        if (cov > 0) this.plot(x, y, cov * a);
      }
    }
  }
  /** Irregular blot (stain, patch, lichen): radius wobbles with the angle. */
  spot(cx: number, cy: number, r: number, a: number, soft: number, R: Rand): void {
    const amp: number[] = [], ph: number[] = [];
    for (let k = 0; k < 4; k++) { amp.push((R() * 0.32) / (k + 1)); ph.push(R() * TAU); }
    const e = r * 1.6 + 1.5;
    for (let y = Math.floor(cy - e); y <= Math.ceil(cy + e); y++) for (let x = Math.floor(cx - e); x <= Math.ceil(cx + e); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy), th = Math.atan2(dy, dx);
      let m = 1;
      for (let k = 0; k < 4; k++) m += amp[k] * Math.sin((k + 2) * th + ph[k]);
      const re = r * m;
      const cov = clamp01((re + 0.5 - d) / (1 + re * soft));
      if (cov > 0) this.plot(x, y, cov * a);
    }
  }
}

/** Jagged crack that keeps a rough heading, with occasional branches. */
function crack(m: Mask, x: number, y: number, len: number, ang: number, width: number, R: Rand, depth = 0): void {
  const step = 1.4;
  let heading = ang;
  for (let s = 0; s < len; s += step) {
    heading += (R() - 0.5) * 0.14;
    const a = heading + (R() - 0.5) * 1.1;
    const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
    m.seg(x, y, nx, ny, width * 0.5 * (0.45 + 0.55 * (1 - s / len)), 1);
    if (depth < 2 && R() < 0.022) {
      crack(m, nx, ny, len * between(R, 0.2, 0.45), heading + (R() < 0.5 ? -1 : 1) * between(R, 0.5, 1.1), width * 0.7, R, depth + 1);
    }
    x = nx;
    y = ny;
  }
}
/** Crack running right across the tile (along x, or along y) that meets itself at the seam,
 *  so on a long road it reads as one continuous crack rather than a repeated fragment. */
function longCrack(m: Mask, pos: number, vertical: boolean, amp: number, width: number, R: Rand, s: number, span = 1): void {
  const L = vertical ? m.h : m.w, n = Math.ceil((L * span) / 1.5), t0 = span < 1 ? R() * L : 0;
  const n1 = new Perlin(3, 1, s), n2 = new Perlin(11, 1, s + 1);
  let px = 0, py = 0;
  for (let k = 0; k <= n; k++) {
    const t = t0 + (L * span * k) / n, u = t / L;
    const off = amp * (n1.at(u, 0.5) + 0.35 * n2.at(u, 0.5)) + (k > 0 && k < n ? (R() - 0.5) * 1.2 : 0);
    const x = vertical ? pos + off : t, y = vertical ? t : pos + off;
    if (k > 0) {
      m.seg(px, py, x, y, width * 0.5, 1);
      if (R() < 0.012) crack(m, x, y, between(R, 10, 30), (vertical ? 0 : Math.PI / 2) + (R() < 0.5 ? 0 : Math.PI) + (R() - 0.5), width * 0.6, R, 1);
    }
    px = x;
    py = y;
  }
}
/** Run of dirty water flowing down (+y) from (x, y), fading over len px. */
function streak(m: Mask, x: number, y: number, len: number, width: number, a: number, R: Rand): void {
  const ph = R() * TAU, fq = between(R, 0.03, 0.09), sway = between(R, 0.2, 1);
  for (let t = 0; t < len; t += 0.7) {
    const f = 1 - t / len;
    m.disc(x + Math.sin(ph + t * fq) * sway, y + t, width * (0.55 + 0.45 * f), a * Math.pow(f, 0.8), 0.6);
  }
}
/** Rubber/heel scuff: a short bent stroke. */
function scuff(m: Mask, R: Rand, minL: number, maxL: number, r: number): void {
  let x = R() * m.w, y = R() * m.h, a = R() * TAU;
  const n = 2 + Math.floor(R() * 2), a0 = between(R, 0.4, 1);
  for (let k = 0; k < n; k++) {
    const l = between(R, minL, maxL) / n, nx = x + Math.cos(a) * l, ny = y + Math.sin(a) * l;
    m.seg(x, y, nx, ny, r, a0);
    x = nx; y = ny; a += (R() - 0.5) * 0.9;
  }
}

// ── unit 103 ────────────────────────────────────────────────────────────────

/** Old vinyl wallpaper (ビニールクロス): off-white, yellowed unevenly, fine emboss, roll seam. */
function drawWallpaper(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(101);
  const im = new Img(w, h, [214, 208, 194]);
  // uneven yellowing at a 5–20 cm scale (domain-warped, so no round blots on a grid);
  // the broad component stays faint because the paper repeats every metre
  const wa = new Fbm(2, 2, 2, 102), wb = new Fbm(2, 2, 2, 103), mot = new Fbm(2, 2, 3, 104), yel = new Fbm(5, 5, 3, 105);
  im.shade(coarse(w, h, (u, v) => mot.at(u + 0.25 * wa.at(u, v), v + 0.25 * wb.at(u, v))), 0.014);
  im.tint(coarse(w, h, (u, v) => yel.at(u + 0.12 * wb.at(u, v), v + 0.12 * wa.at(u, v)), 3), [194, 178, 138], 0, 2.2, 0.22);
  // fine 織物調 relief
  const e1 = blurNoise(w, h, R, 3, 3), e2 = blurNoise(w, h, R, 1, 1);
  for (let i = 0; i < e1.length; i++) e1[i] += 0.8 * e2[i];
  im.shade(emboss(e1, w, h), 0.022);
  // butt seam of the roll (≈ 92 cm wide): hairline gap, lifted edge, glue stain
  const sn = new Perlin(2, 5, 108);
  for (let y = 0; y < h; y++) {
    const k = clamp01(0.55 + 0.6 * sn.at(0.25, (y + 0.5) / h));
    im.mul(im.at(0, y), 1 - 0.1 * k);
    im.mul(im.at(1, y), 1 + 0.035 * k);
    im.mix(im.at(-1, y), [192, 176, 138], 0.08 * k);
    im.mix(im.at(2, y), [192, 176, 138], 0.06 * k);
  }
  // fly specks / mould dots
  const sp = new Mask(w, h);
  for (let k = 0; k < 60; k++) sp.disc(R() * w, R() * h, between(R, 0.3, 0.8), between(R, 0.3, 0.8));
  im.paint(sp.v, [92, 86, 72], 0.4);
  im.grain(R, 4);
  im.put(g);
}

/** Printed gypsum ceiling board (化粧石膏ボード, トラバーチン柄): 455 × 910 mm boards. */
function drawCeiling(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(201);
  const im = new Img(w, h, [219, 216, 205]);
  const mot = new Fbm(4, 4, 3, 202), yel = new Fbm(4, 4, 2, 203);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.016);
  im.tint(coarse(w, h, (u, v) => yel.at(u, v)), [206, 196, 164], 0.3, 2.2, 0.2);
  const pits = new Mask(w, h);
  for (let k = 0; k < 300; k++) {
    const x = R() * w, y = R() * h, a = R() * TAU, l = between(R, 0.3, 2.6);
    pits.seg(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, between(R, 0.2, 0.45), between(R, 0.3, 0.9));
  }
  im.paint(pits.v, [150, 144, 130], 0.55);
  // V-grooves every 0.5 m, staggered butt joints every 1 m
  const hh = Math.round(h / 2), hw = Math.round(w / 2);
  for (let x = 0; x < w; x++) for (const y0 of [0, hh]) { im.mul(im.at(x, y0), 0.8); im.mul(im.at(x, y0 + 1), 1.03); }
  for (let y = 0; y < h; y++) {
    if (y % hh <= 1) continue;
    const x0 = y < hh ? 0 : hw;
    im.mul(im.at(x0, y), 0.86);
    im.mul(im.at(x0 + 1, y), 1.03);
  }
  im.grain(R, 3);
  im.put(g);
}

/** Unit-bath ceiling: ribbed ivory plastic panels, seams every 0.5 m, mould specks. */
function drawCeilingBath(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(301);
  const im = new Img(w, h, [225, 221, 207]);
  const hw = Math.round(w / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = x % hw;
    let k = 1 + 0.016 * Math.sin(((x + 0.5) / w) * TAU * 16);
    if (p === 0) k *= 0.74; else if (p === 1) k *= 1.05; else if (p === hw - 1) k *= 0.94;
    im.mul(y * w + x, k);
  }
  const mot = new Fbm(4, 3, 3, 302);
  im.tint(coarse(w, h, (u, v) => mot.at(u, v)), [206, 196, 160], 0.4, 2.4, 0.22);
  const sp = new Mask(w, h);
  for (let k = 0; k < 90; k++) {
    const x = R() < 0.7 ? (R() < 0.5 ? 0 : hw) + (R() - 0.5) * 9 * R() : R() * w;
    sp.disc(x, R() * h, between(R, 0.3, 0.8), between(R, 0.3, 0.9));
  }
  im.paint(sp.v, [58, 60, 54], 0.6);
  im.grain(R, 3);
  im.put(g);
}

/** Unit-bath FRP wall: ivory stipple, caulked panel joint with mould, soap runs. */
function drawWallBath(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(401);
  const im = new Img(w, h, [223, 213, 187]);
  const p1 = new Perlin(20, 20, 402), p2 = new Perlin(56, 56, 403), mot = new Fbm(2, 2, 3, 404);
  im.shade(emboss(field(w, h, (u, v) => 0.6 * p1.at(u, v) + p2.at(u, v)), w, h), 0.024);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.016);
  const st = new Mask(w, h);
  for (let k = 0; k < 12; k++) streak(st, R() * w, R() * h, h * between(R, 0.2, 0.6), between(R, 0.6, 2), between(R, 0.3, 1), R);
  im.paint(st.v, [192, 180, 150], 0.4);
  // vertical panel joint (1 m) with silicone caulk
  for (let y = 0; y < h; y++) {
    im.mul(im.at(-1, y), 0.86);
    im.mix(im.at(0, y), [204, 202, 194], 0.85);
    im.mix(im.at(1, y), [204, 202, 194], 0.6);
    im.mul(im.at(2, y), 0.9);
  }
  const pink = new Mask(w, h), black = new Mask(w, h);
  for (let k = 0; k < 14; k++) pink.spot((R() - 0.5) * 6, R() * h, between(R, 1, 3), 0.6, 0.8, R);
  for (let k = 0; k < 44; k++) black.disc((R() - 0.5) * 5, R() * h, between(R, 0.3, 0.8), between(R, 0.4, 1));
  for (let k = 0; k < 18; k++) black.disc(R() * w, R() * h, between(R, 0.3, 0.6), between(R, 0.3, 0.7));
  im.paint(pink.v, [214, 160, 150], 0.35);
  im.paint(black.v, [60, 58, 52], 0.55);
  im.grain(R, 3);
  im.put(g);
}

/** Unit-bath floor (uv 0.5): grey FRP with a non-slip stud pattern, grime in the channels. */
function drawFloorBath(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(501);
  const im = new Img(w, h, [182, 181, 172]);
  const P = Math.max(4, Math.round(w / 16));
  const hf = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = (x % P) - (P - 1) / 2, py = (y % P) - (P - 1) / 2;
    hf[y * w + x] = sstep(P * 0.38, P * 0.2, Math.max(Math.abs(px), Math.abs(py)));
  }
  im.shade(emboss(hf, w, h), 0.05);
  for (let i = 0; i < hf.length; i++) im.mul(i, 0.97 + 0.03 * hf[i]);
  // grime and dried soap at a few-cm scale (the floor repeats every 50 cm)
  const mot = new Fbm(4, 4, 3, 502), soap = new Fbm(4, 4, 3, 503);
  im.tint(coarse(w, h, (u, v) => mot.at(u, v), 2), [150, 140, 116], 0.5, 2.4, 0.26);
  im.tint(coarse(w, h, (u, v) => soap.at(u, v), 2), [204, 202, 194], 0.7, 2.4, 0.22);
  im.grain(R, 4);
  im.put(g);
}

/** 複合フローリング: 12.5 cm boards along canvas y (world Z), staggered end joints, worn finish. */
function drawFloorWood(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(601);
  const N = 8, bw = w / N;
  const base: RGB = [132, 95, 61];
  // figure: broad soft bands + finer lines whose spacing wanders (no regular pinstripes)
  const band = new Fbm(4, 2, 3, 602), line = new Fbm(8, 3, 3, 605), fine = new Perlin(128, 6, 603);
  const tone: number[] = [], warm: number[] = [], jy: number[] = [], du: number[] = [], dv: number[] = [], slope: number[] = [], freq: number[] = [];
  for (let b = 0; b < N; b++) {
    tone.push(between(R, 0.92, 1.07)); warm.push(between(R, -0.03, 0.04)); jy.push(Math.floor(R() * h));
    du.push(R()); dv.push(R()); slope.push(between(R, -0.08, 0.08)); freq.push(Math.round(between(R, 34, 52)));
  }
  const grain = fieldRows(w, h, (u, v) => {
    const b = Math.min(N - 1, Math.floor(u * N));
    const fb = band.at(u + du[b], v + dv[b]), fl = line.at(u + du[b], v + dv[b]);
    const s1 = 0.5 + 0.5 * Math.sin(TAU * (u * 14 + du[b] * 3 + fb * 1.6));
    const s2 = 0.5 + 0.5 * Math.sin(TAU * (u * freq[b] + du[b] * 7 + fl * 3.2));
    return (1 - 0.09 * s1 * s1) * (1 - 0.1 * s2 ** 4) * (1 + 0.03 * fine.at(u + du[b], v));
  }, 4);
  const im = new Img(w, h, base);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, b = Math.floor(x / bw), lx = x - Math.round(b * bw);
      const dy = wrap(y - jy[b], h);
      let k = tone[b] * (1 + slope[b] * (dy / h - 0.5)) * grain[i];
      if (lx < 1) k *= 0.55; else if (lx < 2) k *= 0.9; else if (lx >= bw - 1) k *= 1.05;
      if (dy === 0) k *= 0.6; else if (dy === 1) k *= 0.93; else if (dy === h - 1) k *= 1.04;
      im.r[i] = base[0] * k * (1 + warm[b]);
      im.g[i] = base[1] * k;
      im.b[i] = base[2] * k * (1 - warm[b]);
    }
  }
  // finish worn dull in patches (mid-scale, so it does not repeat as big blots)
  const wr = new Fbm(4, 4, 3, 604);
  im.tint(coarse(w, h, (u, v) => wr.at(u, v), 2), [150, 124, 94], 0.6, 2.4, 0.22);
  const sc = new Mask(w, h);
  for (let k = 0; k < 50; k++) {
    const x = R() * w, y = R() * h, a = R() * TAU, l = between(R, 4, 24);
    sc.seg(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.35, between(R, 0.3, 0.8));
  }
  im.paint(sc.v, [178, 148, 112], 0.22);
  const st = new Mask(w, h);
  for (let k = 0; k < 4; k++) st.spot(R() * w, R() * h, between(R, 3, 8), 1, 0.7, R);
  im.paint(st.v, [74, 50, 32], 0.25);
  im.grain(R, 4);
  im.put(g);
}

/** Kitchen cushion floor (クッションフロア): printed 25 cm beige marble tiles, yellowed and scuffed. */
function drawFloorKitchen(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(701);
  const N = 4, cell = w / N;
  const im = new Img(w, h, [206, 193, 165]);
  const wv = new Fbm(2, 2, 2, 702), vn = new Fbm(2, 2, 3, 703), mot = new Fbm(4, 4, 3, 704), yel = new Fbm(4, 4, 3, 705);
  // each printed tile shows its own patch of marble
  const ou: number[] = [], ov: number[] = [], tt: number[] = [];
  for (let k = 0; k < N * N; k++) { ou.push(R()); ov.push(R()); tt.push(between(R, 0.97, 1.03)); }
  const vein = coarse(w, h, (u, v) => {
    const k = Math.min(N - 1, Math.floor(v * N)) * N + Math.min(N - 1, Math.floor(u * N));
    const a = u + ou[k], b = v + ov[k];
    return Math.exp(-Math.abs(vn.at(a + 0.3 * wv.at(a, b), b + 0.3 * wv.at(b + 0.37, a))) * 9);
  }, 2, false);
  im.paint(vein, [172, 156, 122], 0.32);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v), 2), 0.02);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const lx = x - Math.round(cx * cell), ly = y - Math.round(cy * cell);
    im.mul(i, tt[cy * N + cx]);
    if (lx < 2 || ly < 2) { im.mix(i, [156, 144, 120], 0.85); if (lx === 0 || ly === 0) im.mul(i, 0.92); }
    else if (lx === 2 || ly === 2) im.mul(i, 1.03);
  }
  im.tint(coarse(w, h, (u, v) => yel.at(u, v), 2), [188, 166, 118], 0.4, 2.2, 0.26);
  const sc = new Mask(w, h);
  for (let k = 0; k < 18; k++) scuff(sc, R, 4, 14, between(R, 0.5, 0.9));
  im.paint(sc.v, [92, 84, 70], 0.3);
  const st = new Mask(w, h);
  for (let k = 0; k < 5; k++) st.spot(R() * w, R() * h, between(R, 4, 10), between(R, 0.5, 1), 0.8, R);
  im.paint(st.v, [150, 120, 80], 0.2);
  im.grain(R, 4);
  im.put(g);
}

/** Genkan (uv 0.6): dark 300 mm porcelain tiles with pale grout, tracked-in grit, shoe scuffs. */
function drawGenkan(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(801);
  const N = 2, cell = w / N;
  const im = new Img(w, h, [64, 62, 59]);
  const body = new Fbm(5, 5, 4, 802), dust = new Fbm(4, 4, 3, 803);
  im.shade(field(w, h, (u, v) => body.at(u, v)), 0.06);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.035) im.mix(i, [120, 116, 108], between(R, 0.2, 0.45));
    else if (r < 0.08) im.mul(i, between(R, 0.78, 0.9));
  }
  const tt: number[] = [];
  for (let k = 0; k < N * N; k++) tt.push(between(R, 0.9, 1.1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, tx = Math.floor(x / cell), ty = Math.floor(y / cell);
    const lx = x - Math.round(tx * cell), ly = y - Math.round(ty * cell);
    im.mul(i, tt[ty * N + tx]);
    if (lx === 0 || ly === 0) { im.set(i, [104, 100, 92]); im.mul(i, between(R, 0.85, 1.08)); }
    else if (lx === 1 || ly === 1) im.mul(i, 1.12);
    else if (lx === cell - 1 || ly === cell - 1) im.mul(i, 0.8);
  }
  im.tint(coarse(w, h, (u, v) => dust.at(u, v), 2), [118, 112, 102], 0.3, 2.2, 0.2);
  for (let k = 0; k < 140; k++) im.disc(R() * w, R() * h, 0.35, [150, 144, 132], between(R, 0.3, 0.7));
  const sc = new Mask(w, h);
  for (let k = 0; k < 9; k++) scuff(sc, R, 5, 16, 0.6);
  im.paint(sc.v, [34, 32, 30], 0.45);
  im.grain(R, 4);
  im.put(g);
}

// ── exterior ────────────────────────────────────────────────────────────────

/** Apartment exterior: beige 25 cm lap siding, caulked butt joints, chalking, algae, rain streaks. */
function drawSiding(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(901);
  const rows = 4, rh = h / rows;
  const im = new Img(w, h, [177, 165, 141]);
  const tex = new Fbm(10, 10, 2, 902), grime = new Fbm(8, 3, 3, 903), ch = new Fbm(4, 4, 3, 904), al = new Fbm(6, 6, 2, 905);
  im.shade(field(w, h, (u, v) => tex.at(u, v)), 0.018);
  const tone: number[] = [];
  for (let r = 0; r < rows; r++) tone.push(between(R, 0.975, 1.025));
  const under = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / rh), ly = y - Math.round(r * rh);
    for (let x = 0; x < w; x++) {
      let k = tone[r];
      if (ly < 1) k *= 0.58;
      else if (ly < 4) k *= 0.76 + 0.06 * ly;
      else if (ly >= rh - 1) k *= 1.07;
      under[y * w + x] = ly < 7 ? 1 - ly / 7 : 0;
      im.mul(y * w + x, k);
    }
  }
  // chalky paint, streaky grime, algae tucked under the laps
  im.tint(coarse(w, h, (u, v) => ch.at(u, v), 2), [198, 190, 172], 0.5, 2.4, 0.22);
  im.shade(coarse(w, h, (u, v) => grime.at(u, v), 2), 0.022);
  const af = coarse(w, h, (u, v) => al.at(u, v), 2);
  for (let i = 0; i < af.length; i++) im.mix(i, [100, 108, 84], sstep(0, 1.6, af[i]) * under[i] * 0.4);
  const st = new Mask(w, h);
  for (let k = 0; k < 10; k++) streak(st, R() * w, Math.floor(R() * rows) * rh + 1, h * between(R, 0.15, 0.4), between(R, 0.7, 2), between(R, 0.4, 1), R);
  im.paint(st.v, [98, 94, 82], 0.26);
  im.grain(R, 4);
  im.put(g);
}

/** Convenience-store exterior: white 50 cm metal panels, faint dust runs. */
function drawSidingWhite(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1001);
  const im = new Img(w, h, [214, 215, 210]);
  const tex = new Fbm(12, 12, 2, 1002), mot = new Fbm(6, 2, 3, 1003);
  im.shade(field(w, h, (u, v) => tex.at(u, v)), 0.008);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.012);
  const hw = Math.round(w / 2);
  for (let y = 0; y < h; y++) for (const x0 of [0, hw]) {
    im.mul(im.at(x0 - 1, y), 0.94); im.mul(im.at(x0, y), 0.78); im.mul(im.at(x0 + 1, y), 1.04);
  }
  const st = new Mask(w, h);
  for (let k = 0; k < 7; k++) streak(st, R() * w, R() * h, h * between(R, 0.2, 0.5), between(R, 0.8, 2), between(R, 0.3, 0.8), R);
  im.paint(st.v, [156, 156, 148], 0.22);
  im.grain(R, 3);
  im.put(g);
}

/** Cast-in-place slab (uv 2): broom finish, joints on the 2 m grid, damp patches, hairline cracks. */
function drawConcrete(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1101);
  const im = new Img(w, h, [138, 135, 128]);
  const wa = new Fbm(3, 3, 2, 1102), mot = new Fbm(4, 4, 4, 1103), damp = new Fbm(4, 4, 3, 1104);
  im.shade(coarse(w, h, (u, v) => mot.at(u + 0.1 * wa.at(u, v), v + 0.1 * wa.at(v + 0.5, u))), 0.04);
  // broom finish (刷毛引き): fine streaks across x
  im.shade(blurNoise(w, h, R, 9, 0), 0.03);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.05) im.mul(i, between(R, 0.78, 0.9)); else if (r < 0.1) im.mul(i, between(R, 1.04, 1.1));
  }
  im.tint(coarse(w, h, (u, v) => damp.at(u + 0.1 * wa.at(v, u), v)), [106, 104, 98], 0.5, 2.2, 0.3);
  const st = new Mask(w, h);
  for (let k = 0; k < 4; k++) st.spot(R() * w, R() * h, between(R, 4, 12), between(R, 0.4, 0.8), 0.8, R);
  im.paint(st.v, [86, 84, 78], 0.35);
  const rust = new Mask(w, h);
  rust.spot(R() * w, R() * h, between(R, 2, 5), 0.8, 0.9, R);
  im.paint(rust.v, [132, 92, 60], 0.35);
  const cr = new Mask(w, h);
  for (let k = 0; k < 4; k++) crack(cr, R() * w, R() * h, between(R, 30, 90), R() * TAU, 0.9, R);
  im.paint(cr.v, [70, 68, 62], 0.6);
  for (let x = 0; x < w; x++) for (const y0 of [0, 1]) im.mix(im.at(x, y0), [66, 64, 60], 0.85);
  for (let y = 0; y < h; y++) for (const x0 of [0, 1]) im.mix(im.at(x0, y), [66, 64, 60], 0.85);
  im.grain(R, 5);
  im.put(g);
}

/** Old asphalt (uv 4). Shared with road_tomare, whose background continues it. */
const ASPHALT_RES = 256;
const ASPHALT_UV = 4;
/** Where the 止まれ marking lies (layout.ts: floor 'road_tomare', uv 0). */
const TOMARE_RECT = { x0: 17.8, z0: -6.4, x1: 21.2, z1: -4.1 };
let asphaltMemo: { img: Img; cracks: Float32Array } | null = null;
function asphaltSurface(): { img: Img; cracks: Float32Array } {
  if (asphaltMemo) return asphaltMemo;
  const w = ASPHALT_RES, h = ASPHALT_RES, R = prng(1201);
  const im = new Img(w, h, [70, 70, 72]);
  const wa = new Fbm(3, 3, 2, 1202), mot = new Fbm(4, 4, 4, 1203), wear = new Fbm(6, 6, 3, 1204), dark = new Fbm(5, 5, 3, 1205);
  im.shade(coarse(w, h, (u, v) => mot.at(u + 0.12 * wa.at(u, v), v + 0.12 * wa.at(v + 0.5, u))), 0.032);
  // binder worn off: exposed aggregate reads lighter and greyer; fresher binder darker
  im.tint(coarse(w, h, (u, v) => wear.at(u, v), 3), [98, 98, 98], 0.3, 2.2, 0.3);
  im.tint(coarse(w, h, (u, v) => dark.at(u, v), 3), [52, 52, 54], 0.8, 2.4, 0.35);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.15) { const d = between(R, 8, 32); im.r[i] += d; im.g[i] += d; im.b[i] += d * 1.04; }
    else if (r < 0.3) im.mul(i, between(R, 0.8, 0.93));
  }
  // saw-cut repair patch (補修跡): newer, blacker, smoother binder; tar-sealed seam. Kept out of
  // the texel rows the 止まれ marking samples, so it never shows through the lettering.
  const pw = Math.round(w * 0.22), ph = Math.round(h * 0.15), px0 = Math.floor(R() * w);
  const ty0 = wrap((TOMARE_RECT.z0 / ASPHALT_UV) * h, h), ty1 = wrap((TOMARE_RECT.z1 / ASPHALT_UV) * h, h);
  const free = wrap(ty0 - ty1, h);
  const py0 = Math.floor(free > ph + 8 ? wrap(ty1 + 4 + R() * (free - ph - 8), h) : R() * h);
  const tar = new Mask(w, h);
  for (let y = -1; y <= ph; y++) for (let x = -1; x <= pw; x++) {
    const i = im.at(px0 + x, py0 + y);
    if (x < 0 || y < 0 || x === pw || y === ph) { tar.plot(px0 + x, py0 + y, 1); continue; }
    im.mix(i, [54, 54, 56], 0.55);
  }
  // one meandering longitudinal crack that runs through the seams (continuous along the road),
  // a broken one across it, and a few short hairlines
  const cr = new Mask(w, h), oil = new Mask(w, h);
  longCrack(cr, between(R, 0.15, 0.45) * h, false, 10, 1.2, R, 1206);
  longCrack(cr, between(R, 0.55, 0.9) * w, true, 8, 1, R, 1207, 0.55);
  for (let k = 0; k < 4; k++) crack(cr, R() * w, R() * h, between(R, 25, 60), R() * TAU, between(R, 0.7, 1), R, 1);
  for (let k = 0; k < 6; k++) oil.spot(R() * w, R() * h, between(R, 2, 6), between(R, 0.4, 0.8), 0.9, R);
  im.paint(tar.v, [34, 34, 36], 0.8);
  im.paint(cr.v, [26, 26, 27], 0.72);
  im.paint(oil.v, [34, 33, 34], 0.35);
  im.grain(R, 5);
  asphaltMemo = { img: im, cracks: cr.v };
  return asphaltMemo;
}

/** The convenience-store lot. Mapped ONCE over its whole rect (uv 0, layout.ts), so the
 *  oil stains, tyre marks and kerb grating sit at fixed spots without repeating. */
const PARKING_RECT = { x0: 22, z0: -7.2, x1: 38.1, z1: -3 };
function drawParking(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1301);
  const { x0, z0, x1, z1 } = PARKING_RECT;
  const sx = w / (x1 - x0), sy = h / (z1 - z0);
  const px = (x: number): number => (x - x0) * sx, py = (z: number): number => (z - z0) * sy;
  const cellsX = Math.max(2, Math.round((x1 - x0) / 2)), cellsY = Math.max(2, Math.round((z1 - z0) / 2));
  const im = new Img(w, h, [60, 60, 62]);
  const mot = new Fbm(cellsX, cellsY, 4, 1302), wa = new Fbm(cellsX, cellsY, 2, 1303);
  im.shade(coarse(w, h, (u, v) => mot.at(u + 0.06 * wa.at(u, v), v + 0.2 * wa.at(v, u))), 0.06);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.12) { const d = between(R, 5, 18); im.r[i] += d; im.g[i] += d; im.b[i] += d; }
    else if (r < 0.24) im.mul(i, between(R, 0.85, 0.94));
  }
  // walkway to the door: binder polished by feet
  const walk = new Mask(w, h);
  walk.spot(px(28.8), py(-5.2), 1.6 * sx, 1, 1, R);
  im.paint(walk.v, [84, 84, 84], 0.25);
  // oil drips where cars stand (nose-in, engines just past the wheel stops)
  const oil = new Mask(w, h);
  for (const xm of [32.0, 34.4, 36.8]) {
    for (let k = 0; k < 4; k++) oil.spot(px(xm + (R() - 0.5) * 0.7), py(-5.9 + (R() - 0.5) * 0.6), between(R, 0.1, 0.28) * sx, between(R, 0.4, 0.9), 0.9, R);
  }
  im.paint(oil.v, [28, 28, 30], 0.75);
  // tyre scuffs from turning in off the street
  const ty = new Mask(w, h);
  for (let k = 0; k < 3; k++) {
    const cxm = between(R, 28, 36), czm = between(R, -2.4, -1.2), rad = between(R, 3.2, 4.4);
    const a0 = between(R, -2.3, -1.7), a1 = a0 + between(R, 0.5, 0.8);
    for (const dr of [0, 1.5]) {
      let lx = 0, lz = 0;
      for (let t = 0; t <= 24; t++) {
        const a = a0 + (a1 - a0) * (t / 24);
        const xx = px(cxm + Math.cos(a) * (rad + dr)), zz = py(czm + Math.sin(a) * (rad + dr));
        if (t > 0) ty.seg(lx, lz, xx, zz, 0.08 * sx, 0.5 + 0.5 * Math.sin(t * 0.6 + k));
        lx = xx; lz = zz;
      }
    }
  }
  im.paint(ty.v, [38, 38, 40], 0.22);
  // ghost of an old stall line from before the re-striping
  const ghost = new Mask(w, h);
  ghost.seg(px(28.6), py(-6.9), px(28.6), py(-3.7), 0.05 * sx, 1);
  const gn = new Perlin(16, 2, 1304);
  for (let i = 0; i < w * h; i++) if (ghost.v[i] > 0) im.mix(i, [120, 120, 116], ghost.v[i] * 0.3 * clamp01(0.6 + gn.at((i % w) / w, Math.floor(i / w) / h)));
  const cr = new Mask(w, h);
  for (let k = 0; k < 3; k++) crack(cr, between(R, 0.05, 0.95) * w, between(R, 0.2, 0.8) * h, between(R, 30, 70), R() * TAU, 1, R);
  im.paint(cr.v, [26, 26, 27], 0.75);
  // kerb-side drainage grating (グレーチング)
  const gx0 = Math.round(px(23.3)), gx1 = Math.round(px(24.3)), gy0 = Math.round(py(-3.5)), gy1 = Math.round(py(-3.14));
  for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
    const i = im.at(x, y);
    if (x === gx0 || x === gx1 || y === gy0 || y === gy1) im.set(i, [84, 84, 82]);
    else im.set(i, (x - gx0) % 2 ? [18, 18, 20] : [90, 86, 80]);
    if (R() < 0.25) im.mix(i, [104, 66, 44], 0.5);
  }
  im.grain(R, 5);
  im.put(g);
}

/** Thermoplastic white line paint: glass-bead grit, dirt, worn through in places. */
function drawRoadLine(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1401);
  const im = new Img(w, h, [221, 221, 211]);
  const dirt = new Fbm(3, 3, 3, 1402), wear = new Fbm(4, 4, 3, 1403);
  im.shade(coarse(w, h, (u, v) => dirt.at(u, v)), 0.045);
  const wf = field(w, h, (u, v) => wear.at(u, v));
  for (let i = 0; i < wf.length; i++) {
    const r = R();
    if (r < 0.1) im.mul(i, 1.05); else if (r < 0.22) im.mul(i, 0.9);
    im.mix(i, [76, 76, 78], sstep(1.1, 1.8, wf[i]) * 0.85);
  }
  im.grain(R, 6);
  im.put(g);
}

/** 「止まれ」 marking. Mapped once over its rect (uv 0); canvas top = north, so it reads upright to
 *  a player facing north. The asphalt under it is sampled from the asphalt texture at the same
 *  world position (asphalt uv 4) at the same texel size, so it continues the road around it. */
function drawRoadTomare(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1501);
  const { img: A, cracks } = asphaltSurface();
  // glyph coverage: draw the letters stretched along the direction of travel, then read them back
  g.save();
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineJoin = 'round';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const fs = 64, chars = ['止', 'ま', 'れ'], cw = w / chars.length;
  g.font = `bold ${fs}px ${JP_FONT}`;
  chars.forEach((ch, k) => {
    const m = g.measureText(ch);
    const gl = m.actualBoundingBoxLeft || 0, gr = m.actualBoundingBoxRight || fs;
    const ga = m.actualBoundingBoxAscent || fs * 0.88, gd = m.actualBoundingBoxDescent || fs * 0.12;
    const gw = Math.max(1, gl + gr), gh = Math.max(1, ga + gd);
    g.setTransform((cw * 0.8) / gw, 0, 0, (h * 0.84) / gh, cw * (k + 0.5), h / 2);
    g.lineWidth = fs * 0.05;
    g.fillText(ch, -(gr - gl) / 2, (ga - gd) / 2);
    g.strokeText(ch, -(gr - gl) / 2, (ga - gd) / 2);
  });
  g.restore();
  const cov = g.getImageData(0, 0, w, h).data;
  const im = new Img(w, h, [0, 0, 0]);
  const { x0, z0, x1, z1 } = TOMARE_RECT;
  // wear: small flakes gone to the asphalt, thinned areas where the binder pokes through, grime
  const chip = new Fbm(16, 11, 2, 1502), thin = new Fbm(6, 4, 3, 1503), grime = new Fbm(4, 3, 3, 1504);
  const chipF = coarse(w, h, (u, v) => chip.at(u, v), 2), thinF = coarse(w, h, (u, v) => thin.at(u, v));
  const grimeF = coarse(w, h, (u, v) => grime.at(u, v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const wx = x0 + ((x + 0.5) / w) * (x1 - x0), wz = z0 + ((y + 0.5) / h) * (z1 - z0);
    const j = A.at((wx / ASPHALT_UV) * A.w, (wz / ASPHALT_UV) * A.h);
    im.r[i] = A.r[j]; im.g[i] = A.g[j]; im.b[i] = A.b[j];
    const c = cov[i * 4 + 3] / 255;
    if (c <= 0) continue;
    let a = c * (1 - sstep(1.3, 1.8, chipF[i])) * (1 - 0.9 * cracks[j]);
    const t = sstep(0.2, 1.4, thinF[i]);
    if (R() < t * 0.45) a *= 0.25;
    const dirt = clamp01(0.4 + 0.3 * grimeF[i] + 0.25 * t);
    const paint: RGB = [232 - 46 * dirt, 231 - 46 * dirt, 220 - 48 * dirt];
    im.mix(i, paint, a * 0.96);
  }
  im.grain(R, 6);
  im.put(g);
}

/** Concrete block wall (uv 0.8 = 2 × 4 blocks of 390 × 190 + 10 mm joints): moss, 雨だれ, efflorescence. */
function drawBlockWall(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1601);
  const BX = w / 2, BY = h / 4, J = Math.max(2, Math.round(w / 64));
  const tone: number[] = [];
  for (let k = 0; k < 8; k++) tone.push(between(R, 0.92, 1.07));
  const im = new Img(w, h, [150, 147, 138]);
  const body = new Fbm(8, 8, 3, 1602), moss = new Fbm(5, 5, 3, 1603);
  const bf = field(w, h, (u, v) => body.at(u, v));
  const mf = coarse(w, h, (u, v) => moss.at(u, v), 2);
  const joint = new Uint8Array(w * h), low = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / BY), ly = y - Math.round(row * BY), off = row % 2 ? BX / 2 : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, xx = wrap(x + off, w), col = Math.floor(xx / BX), lx = Math.floor(xx - col * BX);
      low[i] = sstep(BY * 0.55, BY - J, ly);
      if (lx >= BX - J || ly >= BY - J) {
        joint[i] = 1;
        im.set(i, [126, 122, 112]);
        if (ly === Math.round(BY) - J) im.mul(i, 0.74);
        else if (lx === Math.round(BX) - J && ly < BY - J) im.mul(i, 0.84);
        im.mul(i, 1 + 0.03 * bf[i]);
      } else {
        let k = tone[row * 2 + col] * (1 + 0.05 * bf[i]);
        if (ly === 0 || lx === 0) k *= 1.06;
        else if (ly >= BY - J - 1 || lx >= BX - J - 1) k *= 0.92;
        im.mul(i, k);
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.035) im.mul(i, between(R, 0.8, 0.92)); else if (r < 0.05) im.mul(i, 1.05);
  }
  // algae/moss: in the joints, and creeping up from the lower arris where water sits
  for (let i = 0; i < w * h; i++) {
    const a = joint[i] ? sstep(-0.3, 1.4, mf[i]) * 0.5 : sstep(0.2, 1.6, mf[i]) * low[i] * 0.42;
    im.mix(i, [80, 88, 62], a);
  }
  const st = new Mask(w, h);
  for (let k = 0; k < 12; k++) {
    const row = Math.floor(R() * 4);
    streak(st, R() * w, row * BY + BY - J / 2, BY * between(R, 0.6, 2.2), between(R, 0.8, 2.6), between(R, 0.4, 1), R);
  }
  im.paint(st.v, [64, 66, 56], 0.34);
  const ef = new Mask(w, h);
  for (let k = 0; k < 3; k++) {
    const row = Math.floor(R() * 4);
    streak(ef, R() * w, row * BY + BY - J, BY * between(R, 0.3, 0.8), between(R, 1, 2.5), between(R, 0.5, 0.9), R);
  }
  im.paint(ef.v, [206, 204, 194], 0.3);
  const li = new Mask(w, h);
  for (let k = 0; k < 10; k++) li.spot(R() * w, R() * h, between(R, 1, 3), 1, 0.4, R);
  im.paint(li.v, [176, 180, 160], 0.3);
  im.grain(R, 5);
  im.put(g);
}

/** Courses of cut stone with random block lengths (rows given as fractions of the tile). */
interface Course { y0: number; hgt: number; off: number; starts: number[]; lens: number[]; idx: Int16Array; tone: number[]; col: RGB[] }
function courses(w: number, h: number, rows: number[], len: [number, number], palette: RGB[], R: Rand): Course[] {
  const out: Course[] = [];
  let y0 = 0;
  for (let k = 0; k < rows.length; k++) {
    const hgt = k === rows.length - 1 ? h - y0 : Math.round(rows[k] * h);
    const starts: number[] = [], lens: number[] = [], tone: number[] = [], col: RGB[] = [];
    const idx = new Int16Array(w), lo = Math.round(len[0] * w), hi = Math.round(len[1] * w);
    for (let x = 0; x < w;) {
      let L = Math.round(between(R, lo, hi));
      if (w - x - L < lo) L = w - x;
      for (let t = 0; t < L; t++) idx[x + t] = starts.length;
      starts.push(x); lens.push(L); tone.push(between(R, 0.94, 1.06)); col.push(palette[Math.floor(R() * palette.length)]);
      x += L;
    }
    // shift the course so its joints do not line up with the course above (or below, at the seam)
    const near = [out[k - 1], k === rows.length - 1 ? out[0] : undefined].filter((c): c is Course => !!c);
    let off = 0, best = -1;
    for (let tries = 0; tries < 40 && best < w * 0.1; tries++) {
      const o = Math.floor(R() * w);
      let d = w;
      for (const c of near) for (const a of c.starts) for (const b of starts) {
        const g0 = Math.abs(wrap(a + c.off - (b + o), w));
        d = Math.min(d, g0, w - g0);
      }
      if (d > best) { best = d; off = o; }
    }
    out.push({ y0, hgt, off, starts, lens, idx, tone, col });
    y0 += hgt;
  }
  return out;
}
interface MasonryOpts {
  seed: number;
  rows: number[];
  len: [number, number];
  /** joint width as a fraction of the tile */
  joint: number;
  palette: RGB[];
  /** px of rounded, darker arris */
  round: number;
  /** joint fill: bare soil → moss */
  soil: RGB;
  mossy: RGB;
  moss: number;
  /** lighter, foot-polished centres (paving) */
  polish: number;
  /** dark rain streaks (walls) */
  streaks: number;
}
function drawMasonry(g: CanvasRenderingContext2D, w: number, h: number, o: MasonryOpts): void {
  const R = prng(o.seed);
  const J = Math.max(2, Math.round(w * o.joint));
  const cs = courses(w, h, o.rows, o.len, o.palette, R);
  const body = new Fbm(6, 6, 3, o.seed + 1), moss = new Fbm(4, 4, 3, o.seed + 2);
  const bf = coarse(w, h, (u, v) => body.at(u, v), 2);
  const mf = coarse(w, h, (u, v) => moss.at(u, v));
  const im = new Img(w, h, [0, 0, 0]);
  const edge = new Float32Array(w * h).fill(-1);
  for (const c of cs) for (let ly = 0; ly < c.hgt; ly++) {
    const y = c.y0 + ly;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, xx = wrap(x - c.off, w), s = c.idx[xx], lx = xx - c.starts[s], L = c.lens[s];
      if (lx < J || ly < J) {
        const m = clamp01(0.45 + 0.4 * mf[i]);
        im.set(i, [o.soil[0] + (o.mossy[0] - o.soil[0]) * m, o.soil[1] + (o.mossy[1] - o.soil[1]) * m, o.soil[2] + (o.mossy[2] - o.soil[2]) * m]);
        im.mul(i, between(R, 0.75, 1.15));
        continue;
      }
      const e = Math.min(lx - J, L - 1 - lx, ly - J, c.hgt - 1 - ly);
      edge[i] = e;
      let k = c.tone[s] * (1 + 0.05 * bf[i]);
      if (e < o.round) k *= 1 - 0.2 * (1 - e / o.round);
      if (ly - J < 2) k *= 1.06;
      if (o.polish > 0) {
        const cx = ((lx - J) / (L - J)) * 2 - 1, cy = ((ly - J) / (c.hgt - J)) * 2 - 1;
        k *= 1 + o.polish * (1 - clamp01(cx * cx + cy * cy));
      }
      const cc = c.col[s];
      im.set(i, [cc[0] * k, cc[1] * k, cc[2] * k]);
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (edge[i] < 0) continue;
    const r = R();
    if (r < 0.04) im.mul(i, between(R, 0.76, 0.88)); else if (r < 0.075) im.mul(i, between(R, 1.05, 1.12));
    if (edge[i] <= 4) im.mix(i, [70, 80, 52], sstep(-0.2, 1.2, mf[i]) * (1 - edge[i] / 5) * o.moss);
  }
  const li = new Mask(w, h), lo = new Mask(w, h);
  for (let k = 0; k < 14; k++) (k % 3 ? li : lo).spot(R() * w, R() * h, between(R, 1, 3.5), between(R, 0.5, 1), 0.5, R);
  im.paint(li.v, [178, 182, 168], 0.35);
  im.paint(lo.v, [182, 172, 120], 0.3);
  if (o.streaks > 0) {
    const st = new Mask(w, h);
    for (let k = 0; k < o.streaks; k++) streak(st, R() * w, R() * h, h * between(R, 0.15, 0.45), between(R, 1, 3), between(R, 0.4, 1), R);
    im.paint(st.v, [58, 60, 52], 0.3);
  }
  const cr = new Mask(w, h);
  for (let k = 0; k < 2; k++) crack(cr, R() * w, R() * h, between(R, 15, 40), R() * TAU, 0.9, R);
  for (let i = 0; i < w * h; i++) if (edge[i] >= 0 && cr.v[i] > 0) im.mix(i, [40, 40, 36], cr.v[i] * 0.7);
  im.grain(R, 5);
  im.put(g);
}
/** Shrine boundary wall (uv 1): weathered ashlar, open joints, moss and lichen. */
const FENCE: MasonryOpts = {
  seed: 1701, rows: [0.3, 0.38, 0.32], len: [0.34, 0.7], joint: 0.022,
  palette: [[132, 128, 119], [126, 123, 116], [136, 129, 118], [122, 120, 114]],
  round: 4, soil: [38, 38, 34], mossy: [50, 58, 36], moss: 0.5, polish: 0, streaks: 10,
};
/** Shrine approach paving (参道, uv 1): granite slabs in courses across the path, mossy joints. */
const PAVING: MasonryOpts = {
  seed: 1801, rows: [0.28, 0.4, 0.32], len: [0.26, 0.7], joint: 0.022,
  palette: [[146, 142, 134], [140, 138, 132], [148, 142, 132], [136, 134, 129]],
  round: 3, soil: [58, 54, 44], mossy: [58, 66, 42], moss: 0.4, polish: 0.05, streaks: 0,
};

/** 玉砂利 / crushed stone (uv 1.5–2): overlapping shaded pebbles over dark grit. */
function drawGravel(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(1901);
  const im = new Img(w, h, [84, 80, 72]);
  for (let i = 0; i < w * h; i++) im.mul(i, between(R, 0.8, 1.15));
  const pal: RGB[] = [[200, 197, 189], [184, 181, 173], [176, 167, 150], [160, 158, 152], [152, 157, 162], [134, 131, 124]]; // light → dark
  // patches where lighter or darker stones dominate (raked unevenly, washed in by rain)
  const zone = new Fbm(4, 4, 2, 1903);
  const n = Math.round((w * h) / 15);
  for (let p = 0; p < n; p++) {
    const cx = R() * w, cy = R() * h, r = between(R, 2.1, 3.9), ry = r * between(R, 0.62, 1), rot = R() * Math.PI;
    const z = zone.at(cx / w, cy / h);
    const c = pal[Math.min(pal.length - 1, Math.floor(clamp01(R() + z * 0.6) * pal.length))], t = between(R, 0.88, 1.08);
    const cs = Math.cos(rot) / r, sn = Math.sin(rot) / r, ext = r * 1.3 + 0.5, e = r / ry;
    for (let y = Math.floor(cy - ext); y <= Math.ceil(cy + ext); y++) {
      const row = (y < 0 ? y + h : y >= h ? y - h : y) * w, dy = y + 0.5 - cy;
      for (let x = Math.floor(cx - ext); x <= Math.ceil(cx + ext); x++) {
        const dx = x + 0.5 - cx;
        const ex = dx * cs + dy * sn, ey = (dy * cs - dx * sn) * e, q = ex * ex + ey * ey;
        if (q > 1.7) continue;
        const i = row + (x < 0 ? x + w : x >= w ? x - w : x);
        if (q >= 1) { im.mul(i, 0.8 + 0.2 * ((q - 1) / 0.7)); continue; }
        const k = t * (1 + (0.3 * (-0.45 * dx - 0.9 * dy)) / r) * (1 - 0.3 * q * q);
        im.r[i] = c[0] * k; im.g[i] = c[1] * k; im.b[i] = c[2] * k;
      }
    }
  }
  const dm = new Fbm(3, 3, 3, 1902);
  im.tint(coarse(w, h, (u, v) => dm.at(u, v)), [96, 90, 76], 0.5, 2, 0.3);
  im.grain(R, 5);
  im.put(g);
}

/** Yard soil (uv 3): damp patches, crumbs, small stones, sparse weeds. */
function drawDirt(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2001);
  const im = new Img(w, h, [98, 86, 68]);
  const wa = new Fbm(2, 2, 2, 2002), mot = new Fbm(3, 3, 4, 2003), damp = new Fbm(2, 2, 3, 2004);
  im.shade(coarse(w, h, (u, v) => mot.at(u + 0.3 * wa.at(u, v), v + 0.3 * wa.at(v, u))), 0.07);
  im.tint(coarse(w, h, (u, v) => damp.at(u, v)), [74, 65, 52], 0.4, 2, 0.34);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.12) im.mul(i, between(R, 0.8, 0.92)); else if (r < 0.2) im.mul(i, between(R, 1.06, 1.16));
  }
  for (let k = 0; k < Math.round((w * h) / 55); k++) {
    const x = R() * w, y = R() * h, r = between(R, 0.4, 1.2), t = between(R, 0.85, 1.15);
    im.disc(x + 0.6, y + 0.8, r, [52, 46, 36], 0.5);
    im.disc(x, y, r, [140 * t, 134 * t, 122 * t], 0.9);
  }
  for (let c = 0; c < 18; c++) {
    const cx = R() * w, cy = R() * h, n = 4 + Math.floor(R() * 10), dry = R() < 0.3;
    for (let k = 0; k < n; k++) {
      const a = R() * TAU, l = between(R, 1.5, 4), ox = cx + (R() - 0.5) * 3, oy = cy + (R() - 0.5) * 3;
      const col: RGB = dry ? [120, 112, 64] : [between(R, 50, 80), between(R, 72, 104), between(R, 34, 50)];
      im.seg(ox, oy, ox + Math.cos(a) * l, oy + Math.sin(a) * l, 0.45, col, 0.85);
    }
  }
  im.grain(R, 5);
  im.put(g);
}

/** Unkempt grass (uv ≈ 2): dense blades, soil showing through, dry patches. */
function drawGrass(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2101);
  const im = new Img(w, h, [48, 62, 34]);
  const mot = new Fbm(3, 3, 3, 2102), dry = new Fbm(2, 2, 3, 2103), soil = new Fbm(3, 3, 3, 2104);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.1);
  im.tint(coarse(w, h, (u, v) => soil.at(u, v)), [78, 68, 50], 0.8, 2, 0.6);
  for (let k = 0; k < Math.round((w * h) / 6); k++) {
    const x = R() * w, y = R() * h, a = -Math.PI / 2 + (R() - 0.5) * 2.2, l = between(R, 2, 5);
    const col: RGB = R() < 0.08 ? [128, 120, 70] : [between(R, 44, 84), between(R, 74, 122), between(R, 30, 52)];
    im.seg(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.45, col, 0.8);
  }
  im.tint(coarse(w, h, (u, v) => dry.at(u, v)), [118, 112, 68], 0.6, 2, 0.35);
  im.grain(R, 6);
  im.put(g);
}

/** Batten-seam steel roof (瓦棒葺き, uv 2): ribs every 40 cm, faded paint, rust and rust runs. */
function drawRoofMetal(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2201);
  const ribs = 5;
  const im = new Img(w, h, [72, 79, 86]);
  const can = new Fbm(ribs, 2, 2, 2202), fade = new Fbm(4, 4, 3, 2203), rust = new Fbm(8, 6, 3, 2204);
  const cf = field(w, h, (u, v) => can.at(u, v)), rf = field(w, h, (u, v) => rust.at(u, v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, ph = wrap(((x + 0.5) / w) * ribs, 1);
    let k = 1 + 0.03 * cf[i];
    if (ph < 0.045) k *= 1.28; else if (ph < 0.09) k *= 0.7; else if (ph < 0.15) k *= 0.88;
    im.mul(i, k);
    if (ph < 0.2) rf[i] += 0.6;   // rust starts along the seams
  }
  im.tint(coarse(w, h, (u, v) => fade.at(u, v), 2), [116, 122, 126], 0.3, 2.2, 0.24);
  im.tint(rf, [98, 70, 54], 1.1, 2.2, 0.65);
  const st = new Mask(w, h);
  for (let k = 0; k < 16; k++) streak(st, R() * w, R() * h, h * between(R, 0.1, 0.35), between(R, 0.5, 1.4), between(R, 0.4, 0.9), R);
  im.paint(st.v, [98, 70, 54], 0.32);
  im.grain(R, 4);
  im.put(g);
}

/** Painted steel panel with 角波 ribs (corridor railing): chalky cream paint, grime runs, rust. */
function drawMetalPanel(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2301);
  const im = new Img(w, h, [194, 186, 164]);
  const P = Math.max(8, Math.round(w / 8));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (x % P) / P;
    im.mul(y * w + x, p < 0.6 ? 1 : p < 0.7 ? 1.1 : p < 0.82 ? 1.04 : p < 0.92 ? 0.8 : 0.92);
  }
  const mot = new Fbm(2, 2, 3, 2302);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.035);
  const gr = new Mask(w, h);
  for (let k = 0; k < 10; k++) streak(gr, R() * w, R() * h, h * between(R, 0.15, 0.5), between(R, 0.8, 2.2), between(R, 0.3, 0.8), R);
  im.paint(gr.v, [140, 132, 110], 0.3);
  const rs = new Mask(w, h), run = new Mask(w, h);
  for (let k = 0; k < 10; k++) {
    const x = R() * w, y = R() * h;
    rs.spot(x, y, between(R, 0.6, 2), 1, 0.5, R);
    streak(run, x, y, between(R, 6, 30), between(R, 0.5, 1.2), between(R, 0.4, 0.9), R);
  }
  im.paint(run.v, [150, 104, 70], 0.3);
  im.paint(rs.v, [118, 66, 38], 0.85);
  const pl = new Mask(w, h);
  for (let k = 0; k < 5; k++) pl.spot(R() * w, R() * h, between(R, 1.5, 4), 1, 0.2, R);
  im.paint(pl.v, [162, 160, 152], 0.55);
  im.grain(R, 4);
  im.put(g);
}

/** Dark painted steel (posts, gutters): scratches, rust blooms, rain runs. */
function drawMetalDark(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2401);
  const im = new Img(w, h, [58, 52, 47]);
  const mot = new Fbm(2, 3, 3, 2402), rust = new Fbm(6, 8, 3, 2403);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.05);
  im.tint(field(w, h, (u, v) => rust.at(u, v)), [92, 60, 42], 1.0, 2.2, 0.6);
  const sc = new Mask(w, h);
  for (let k = 0; k < 10; k++) {
    const x = R() * w, y = R() * h, a = R() * TAU, l = between(R, 2, 8);
    sc.seg(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 0.35, between(R, 0.5, 1));
  }
  im.paint(sc.v, [100, 96, 90], 0.35);
  const st = new Mask(w, h);
  for (let k = 0; k < 6; k++) streak(st, R() * w, R() * h, h * between(R, 0.2, 0.5), between(R, 0.5, 1.2), between(R, 0.4, 0.9), R);
  im.paint(st.v, [40, 36, 32], 0.3);
  im.grain(R, 4);
  im.put(g);
}

/** Old dark timber: grain along canvas y (posts stand vertical), grey weathering, drying checks. */
function drawWoodDark(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2501);
  const im = new Img(w, h, [68, 48, 33]);
  const fig = new Fbm(3, 2, 3, 2502), fine = new Perlin(96, 4, 2503), weather = new Fbm(6, 2, 3, 2504);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, s = 0.5 + 0.5 * Math.sin(TAU * (u * 22 + fig.at(u, v) * 1.3));
      im.mul(y * w + x, (1 - 0.18 * s * s * s) * (1 + 0.06 * fine.at(u, v)));
    }
  }
  im.tint(coarse(w, h, (u, v) => weather.at(u, v)), [104, 98, 88], 0.2, 2, 0.34);
  const ck = new Mask(w, h);
  for (let k = 0; k < 7; k++) {
    let x = R() * w, y = R() * h;
    const len = between(R, 16, 60);
    for (let t = 0; t < len; t++) { const nx = x + (R() - 0.5) * 0.6; ck.seg(x, y, nx, y + 1, 0.4, 1); x = nx; y += 1; }
  }
  im.paint(ck.v, [26, 18, 12], 0.8);
  im.grain(R, 4);
  im.put(g);
}

/** Balcony partition (隔て板, uv 0: once per face): fibre-cement board in an aluminium frame, warning label. */
function drawPartition(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2601);
  const im = new Img(w, h, [217, 213, 200]);
  const gm = new Fbm(4, 6, 3, 2604);
  im.shade(blurNoise(w, h, R, 2, 2), 0.015);
  const gf = coarse(w, h, (u, v) => gm.at(u, v));
  for (let y = 0; y < h; y++) {
    const b = sstep(0.68, 1, (y + 0.5) / h);
    for (let x = 0; x < w; x++) { const i = y * w + x; im.mix(i, [150, 140, 120], b * clamp01(0.55 + 0.35 * gf[i]) * 0.45); }
  }
  const st = new Mask(w, h);
  for (let k = 0; k < 6; k++) streak(st, between(R, 0.1, 0.9) * w, between(R, 0.03, 0.1) * h, h * between(R, 0.15, 0.45), between(R, 1, 3), between(R, 0.3, 0.7), R);
  im.paint(st.v, [168, 160, 142], 0.3);
  const F = Math.max(3, Math.round(w * 0.035));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, e = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (e < F) { im.set(i, [146, 144, 138]); if (e === 0) im.mul(i, 0.8); else if (e === 1) im.mul(i, 1.08); }
    else if (e === F) im.mul(i, 0.78);
    else if (e === F + 1) im.mul(i, 0.92);
  }
  for (const [sx, sy] of [[F / 2, F / 2], [w - F / 2, F / 2], [F / 2, h - F / 2], [w - F / 2, h - F / 2], [F / 2, h / 2], [w - F / 2, h / 2]]) {
    im.disc(sx, sy, 0.9, [96, 94, 90], 0.9);
  }
  im.grain(R, 3);
  im.put(g);
  // label (at eye level, ~1.35 m)
  const lx = Math.round(w * 0.15), ly = Math.round(h * 0.13), lw = w - 2 * lx, lh = Math.round(h * 0.25);
  g.fillStyle = '#f3f1ea';
  g.fillRect(lx, ly, lw, lh);
  g.strokeStyle = '#b8261d';
  g.lineWidth = Math.max(1, Math.round(w * 0.012));
  g.strokeRect(lx + 2.5, ly + 2.5, lw - 5, lh - 5);
  g.fillStyle = '#b8261d';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(w * 0.085)}px ${JP_FONT}`;
  const lines = ['非常の際は', 'ここを破って', '隣戸へ', '避難できます'];
  const step = lh / (lines.length + 0.6);
  lines.forEach((t, k) => g.fillText(t, w / 2, ly + step * (k + 0.8), lw - 8));
  g.fillStyle = '#5a5550';
  g.font = `bold ${Math.round(w * 0.055)}px ${JP_FONT}`;
  g.fillText('物を置かないでください', w / 2, ly + lh + Math.round(h * 0.04), lw);
}

// ── convenience store ───────────────────────────────────────────────────────

function drawConbiniWall(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2701);
  const im = new Img(w, h, [229, 228, 222]);
  const p1 = new Perlin(20, 20, 2702), p2 = new Perlin(56, 56, 2703), mot = new Fbm(2, 2, 3, 2704);
  im.shade(field(w, h, (u, v) => p1.at(u, v) + 0.8 * p2.at(u, v)), 0.012);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.012);
  const sc = new Mask(w, h);
  for (let k = 0; k < 8; k++) { const x = R() * w, y = R() * h, l = between(R, 4, 14); sc.seg(x, y, x + l, y + (R() - 0.5) * 2, 0.5, between(R, 0.3, 0.7)); }
  im.paint(sc.v, [160, 160, 156], 0.15);
  im.grain(R, 2);
  im.put(g);
}

/** Store floor (uv 0.6): 300 mm vinyl tiles with marbled speckle, heel scuffs. */
function drawConbiniFloor(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2801);
  const N = 2, cell = w / N;
  const im = new Img(w, h, [213, 211, 203]);
  const wv = new Fbm(2, 2, 2, 2802), mb = new Fbm(2, 2, 4, 2803);
  const ou: number[] = [], ov: number[] = [], tt: number[] = [];
  for (let k = 0; k < N * N; k++) { ou.push(R()); ov.push(R()); tt.push(between(R, 0.975, 1.025)); }
  im.paint(coarse(w, h, (u, v) => {
    const k = Math.min(N - 1, Math.floor(v * N)) * N + Math.min(N - 1, Math.floor(u * N));
    const a = u + ou[k], b = v + ov[k];
    return Math.exp(-Math.abs(mb.at(a + 0.3 * wv.at(a, b), b + 0.3 * wv.at(b, a))) * 14);
  }, 2, false), [188, 184, 174], 0.35);
  for (let i = 0; i < w * h; i++) {
    const r = R();
    if (r < 0.025) im.mix(i, [170, 166, 158], 0.35); else if (r < 0.045) im.mul(i, 1.03);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, tx = Math.floor(x / cell), ty = Math.floor(y / cell);
    const lx = x - Math.round(tx * cell), ly = y - Math.round(ty * cell);
    im.mul(i, tt[ty * N + tx]);
    if (lx === 0 || ly === 0) im.mul(i, 0.8); else if (lx === 1 || ly === 1) im.mul(i, 1.02);
  }
  const sc = new Mask(w, h);
  for (let k = 0; k < 14; k++) scuff(sc, R, 3, 10, 0.5);
  im.paint(sc.v, [70, 70, 70], 0.3);
  im.grain(R, 3);
  im.put(g);
}

/** Store ceiling (uv 0.6): rock-wool acoustic board in a 600 mm T-bar grid. */
function drawConbiniCeiling(g: CanvasRenderingContext2D, w: number, h: number): void {
  const R = prng(2901);
  const im = new Img(w, h, [226, 226, 221]);
  const fs = new Mask(w, h);
  for (let k = 0; k < 220; k++) {
    let x = R() * w, y = R() * h, a = R() * TAU;
    const n = 1 + Math.floor(R() * 3);
    for (let j = 0; j < n; j++) {
      const l = between(R, 1, 3), nx = x + Math.cos(a) * l, ny = y + Math.sin(a) * l;
      fs.seg(x, y, nx, ny, 0.3, between(R, 0.5, 1));
      x = nx; y = ny; a += (R() - 0.5) * 1.6;
    }
  }
  for (let k = 0; k < 350; k++) fs.disc(R() * w, R() * h, 0.25, between(R, 0.3, 0.7));
  im.paint(fs.v, [172, 172, 166], 0.6);
  const mot = new Fbm(2, 2, 3, 2902);
  im.shade(coarse(w, h, (u, v) => mot.at(u, v)), 0.012);
  const T = Math.max(2, Math.round(w / 40));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < T || y < T) im.set(i, [238, 238, 235]);
    else if (x === T || y === T) im.mul(i, 0.88);
  }
  im.grain(R, 2);
  im.put(g);
}

// ── structural textures ─────────────────────────────────────────────────────
// Sizes keep roughly 64–256 texels per repeat; comments give the layout's `uv`
// (metres per repeat) where it is not the default 1.
export const BASE_TEXTURES: Record<string, TexSpec> = {
  none: { w: 4, h: 4, draw: (g, w, h) => fill(g, w, h, '#ffffff') },
  // unit 103
  wallpaper: { w: 256, h: 256, draw: drawWallpaper },
  ceiling: { w: 128, h: 128, draw: drawCeiling },
  ceiling_bath: { w: 128, h: 128, draw: drawCeilingBath },
  wall_bath: { w: 128, h: 128, draw: drawWallBath },
  floor_wood: { w: 256, h: 256, draw: drawFloorWood },
  floor_kitchen: { w: 256, h: 256, draw: drawFloorKitchen },
  floor_tile_genkan: { w: 128, h: 128, draw: drawGenkan },        // uv 0.6
  floor_bath: { w: 128, h: 128, draw: drawFloorBath },            // uv 0.5
  // town
  siding: { w: 128, h: 128, draw: drawSiding },
  siding_white: { w: 128, h: 128, draw: drawSidingWhite },
  concrete: { w: 256, h: 256, draw: drawConcrete },               // uv 2
  asphalt: { w: ASPHALT_RES, h: ASPHALT_RES, draw: (g) => asphaltSurface().img.put(g) }, // uv 4
  parking: { w: 512, h: 128, draw: drawParking },                 // uv 0 (16.1 × 4.2 m lot)
  road_line: { w: 64, h: 64, draw: drawRoadLine },
  road_tomare: { w: 218, h: 147, clamp: true, draw: drawRoadTomare }, // uv 0 (3.4 × 2.3 m, same texel size as asphalt)
  block_wall: { w: 128, h: 128, draw: drawBlockWall },            // uv 0.8
  stone_fence: { w: 128, h: 128, draw: (g, w, h) => drawMasonry(g, w, h, FENCE) },
  gravel: { w: 256, h: 256, draw: drawGravel },                   // uv 1.5–2
  stone_path: { w: 256, h: 256, draw: (g, w, h) => drawMasonry(g, w, h, PAVING) },
  dirt: { w: 128, h: 128, draw: drawDirt },                       // uv 3
  grass: { w: 128, h: 128, draw: drawGrass },
  roof_metal: { w: 128, h: 128, draw: drawRoofMetal },            // uv 2
  metal_panel: { w: 128, h: 128, draw: drawMetalPanel },
  metal_dark: { w: 64, h: 64, draw: drawMetalDark },
  wood_dark: { w: 128, h: 128, draw: drawWoodDark },
  partition: { w: 160, h: 240, clamp: true, draw: drawPartition },  // uv 0
  // convenience store
  conbini_floor: { w: 128, h: 128, draw: drawConbiniFloor },      // uv 0.6
  conbini_ceiling: { w: 128, h: 128, draw: drawConbiniCeiling },  // uv 0.6
  conbini_wall: { w: 128, h: 128, draw: drawConbiniWall },
};

export class TextureLib {
  private readonly specs = new Map<string, TexSpec>();
  private readonly cache = new Map<string, THREE.Texture>();
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  maxAnisotropy = 1;

  constructor(...sets: Record<string, TexSpec>[]) {
    for (const s of sets) for (const [k, v] of Object.entries(s)) this.specs.set(k, v);
  }

  has(id: string): boolean {
    return this.specs.has(id);
  }

  register(id: string, spec: TexSpec): void {
    this.specs.set(id, spec);
    const old = this.cache.get(id);
    if (old) {
      this.redraw(id);
    }
  }

  /** Re-run the drawer of an existing texture (e.g. dynamic text). */
  redraw(id: string): void {
    const spec = this.specs.get(id);
    const tex = this.cache.get(id) as THREE.CanvasTexture | undefined;
    const cv = this.canvases.get(id);
    if (!spec || !tex || !cv) return;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    spec.draw(g, cv.width, cv.height);
    tex.needsUpdate = true;
  }

  canvas(id: string): HTMLCanvasElement | undefined {
    this.get(id);
    return this.canvases.get(id);
  }

  get(id: string): THREE.Texture {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const spec = this.specs.get(id) ?? placeholder(id);
    const cv = document.createElement('canvas');
    cv.width = spec.w;
    cv.height = spec.h;
    const g = cv.getContext('2d')!;
    spec.draw(g, cv.width, cv.height);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (spec.clamp) {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    } else {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    }
    tex.magFilter = spec.nearest === false ? THREE.LinearFilter : THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = Math.min(4, this.maxAnisotropy);
    this.cache.set(id, tex);
    this.canvases.set(id, cv);
    return tex;
  }
}

function placeholder(id: string): TexSpec {
  return {
    w: 64, h: 64, clamp: true,
    draw: (g, w, h) => {
      g.fillStyle = '#c8c0b0'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#7a2020'; g.font = `9px ${JP_FONT}`; g.textAlign = 'center';
      wrapText(g, id, w / 2, 20, w - 6, 11);
    },
  };
}
