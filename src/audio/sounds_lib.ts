import type { SoundDef } from './sounds';
import { SR } from './synth';

// ─────────────────────────────────────────────────────────────────────────────
// Full procedural sound library. Every sound is synthesized from math into an
// AudioBuffer (no sample files). Keys here override CORE_SOUNDS with the same id.
//
// - Array-based DSP (whole-buffer Float32Array passes) instead of per-sample
//   closure chains: most sounds render in a few ms, the long ambience loops in
//   a few tens of ms (the whole library in well under a second on a desktop).
// - Deterministic: every sound seeds its own PRNG in begin().
// - Loops are built circularly: LFOs are periodic in the loop length, events
//   wrap around the end, and every IIR filter / reverb is pre-run over the
//   buffer's own tail so its state at sample 0 equals the state after the last
//   sample. The loop point is seamless without a crossfade (no level dip in
//   noise beds, no phasing on tones). Beds may use a lower sample rate.
// - Mains hums use 60 Hz harmonics (the story is set in Kansai).
// ─────────────────────────────────────────────────────────────────────────────

export const SOUND_LIBRARY: Record<string, SoundDef> = {};
function add(defs: Record<string, SoundDef>): void {
  Object.assign(SOUND_LIBRARY, defs);
}

type Buf = Float32Array;
type Stereo = [Buf, Buf];
type Mode3 = [number, number, number];
const TAU = Math.PI * 2;

// ── render state ────────────────────────────────────────────────────────────
let R = SR; // sample rate of the sound being rendered
let S = 1; // PRNG state
/** Start a sound: choose its sample rate and seed its PRNG. */
function begin(seedv: number, rate = SR): void {
  R = rate;
  S = Math.imul(seedv | 0 || 7, 0x9e3779b1) >>> 0 || 1;
  for (let i = 0; i < 4; i++) rnd();
}
/** xorshift32 → [-1, 1) */
function rnd(): number {
  S ^= S << 13; S ^= S >>> 17; S ^= S << 5;
  return (S >>> 0) / 2147483648 - 1;
}
const uni = (a: number, b: number): number => a + (b - a) * (rnd() * 0.5 + 0.5);
const pick = <T>(xs: T[]): T => xs[Math.min(xs.length - 1, Math.floor(uni(0, xs.length)))];
const len = (sec: number): number => Math.max(1, Math.round(sec * R));
const buf = (sec: number): Buf => new Float32Array(len(sec));
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

// ── oscillators ─────────────────────────────────────────────────────────────
const TL = 8192;
const TAB = (() => {
  const t = new Float32Array(TL + 1);
  for (let i = 0; i <= TL; i++) t[i] = Math.sin((i / TL) * TAU);
  return t;
})();
/** fast sine of a phase measured in cycles */
function sn(ph: number): number {
  const x = (ph - Math.floor(ph)) * TL;
  const i = x | 0;
  const a = TAB[i];
  return a + (TAB[i + 1] - a) * (x - i);
}
/** wavetable from harmonic amplitudes [h1, h2, ...] */
function wtab(h: number[]): Float32Array {
  const t = new Float32Array(TL + 1);
  for (let i = 0; i <= TL; i++) { let v = 0; for (let k = 0; k < h.length; k++) v += h[k] * Math.sin(((k + 1) * i * TAU) / TL); t[i] = v; }
  return t;
}
function look(tab: Float32Array, ph: number): number {
  const x = (ph - Math.floor(ph)) * TL;
  const i = x | 0;
  const a = tab[i];
  return a + (tab[i + 1] - a) * (x - i);
}
/** soft clipper (tanh-like, exactly ±1 beyond ±3) */
const sat = (x: number): number => (x <= -3 ? -1 : x >= 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));

// ── envelopes ───────────────────────────────────────────────────────────────
/** linear attack a, then exponential decay with time constant d */
const ad = (t: number, a: number, d: number): number => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d));
/** raised-cosine gate: rises over a from t0, holds until t1, falls over r */
function gate(t: number, t0: number, t1: number, a: number, r: number): number {
  if (t <= t0 || t >= t1 + r) return 0;
  if (t < t0 + a) return 0.5 - 0.5 * Math.cos((Math.PI * (t - t0)) / a);
  if (t <= t1) return 1;
  return 0.5 + 0.5 * Math.cos((Math.PI * (t - t1)) / r);
}
/** multiply in place by f(t) */
function shape(a: Buf, f: (t: number) => number): Buf {
  for (let i = 0; i < a.length; i++) a[i] *= f(i / R);
  return a;
}

// ── noise & mixing ──────────────────────────────────────────────────────────
function white(n: number, g = 1): Buf {
  const a = new Float32Array(n);
  let x = S;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; a[i] = ((x >>> 0) / 2147483648 - 1) * g; }
  S = x;
  return a;
}
/** add src×g into dst starting at `at` seconds (wrapping for loops) */
function mix(dst: Buf, src: Buf, at = 0, g = 1, wrap = false): Buf {
  const n = dst.length, i0 = Math.round(at * R);
  for (let k = 0; k < src.length; k++) {
    const j = i0 + k;
    if (wrap) dst[((j % n) + n) % n] += src[k] * g;
    else if (j >= 0 && j < n) dst[j] += src[k] * g;
  }
  return dst;
}
/** equal-power pan of a mono source into a stereo pair, optionally moving: p(t) in [-1, 1] */
function pan(dst: Stereo, src: Buf, at: number, g: number, p: number | ((t: number) => number), wrap = false): void {
  const n = dst[0].length, dl = dst[0], dr = dst[1], i0 = Math.round(at * R), m = src.length;
  let gl = 0, gr = 0;
  for (let k = 0; k < m; k++) {
    if (k === 0 || (typeof p !== 'number' && (k & 63) === 0)) {
      const th = ((clamp(typeof p === 'number' ? p : p(k / R), -1, 1) + 1) * Math.PI) / 4;
      gl = Math.cos(th) * g; gr = Math.sin(th) * g;
    }
    let j = i0 + k;
    if (j >= n || j < 0) { if (!wrap) continue; j = ((j % n) + n) % n; }
    const v = src[k];
    dl[j] += v * gl;
    dr[j] += v * gr;
  }
}
/** circular rotation (decorrelated copy of a periodic bed) */
function rot(a: Buf, k: number): Buf {
  const n = a.length, o = new Float32Array(n);
  k = ((Math.round(k) % n) + n) % n;
  o.set(a.subarray(k));
  o.set(a.subarray(0, k), n - k);
  return o;
}
function mono(s: Stereo): Buf {
  const o = new Float32Array(s[0].length);
  for (let i = 0; i < o.length; i++) o[i] = (s[0][i] + s[1][i]) * 0.5;
  return o;
}
function scale(a: Buf, g: number): Buf {
  for (let i = 0; i < a.length; i++) a[i] *= g;
  return a;
}
/** scale so that the peak equals p */
function pn(a: Buf, p = 1): Buf {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m > 1e-12 ? scale(a, p / m) : a;
}
/**
 * Slow random modulation with unit RMS: white noise smoothed below f Hz (two one-poles),
 * generated at a reduced control rate and interpolated. Periodic over n samples when w > 0.
 */
function smooth(n: number, f: number, w = 0): Buf {
  const D = clamp(Math.floor(R / (f * 40)), 1, 256), nc = Math.max(2, Math.ceil(n / D)), Rc = (R * nc) / n;
  const c = white(nc), k = 1 - Math.exp((-TAU * f) / Rc);
  for (let pass = 0; pass < 2; pass++) {
    let y = 0;
    if (w > 0) for (let i = 0; i < nc; i++) y += k * (c[i] - y);
    for (let i = 0; i < nc; i++) { y += k * (c[i] - y); c[i] = y; }
  }
  let e = 0;
  for (let i = 0; i < nc; i++) e += c[i] * c[i];
  const g = 1 / Math.sqrt(e / nc + 1e-20);
  if (D === 1 && nc === n) return scale(c, g);
  const o = new Float32Array(n), r = nc / n;
  for (let i = 0; i < n; i++) {
    const x = i * r, c0 = x | 0, c1 = c0 + 1 < nc ? c0 + 1 : w > 0 ? 0 : nc - 1;
    o[i] = (c[c0] + (c[c1] - c[c0]) * (x - c0)) * g;
  }
  return o;
}

// ── filters (in place; w > 0 pre-runs over the last w samples = circular) ───
type BQ = [number, number, number, number, number];
function coef(type: 'lp' | 'hp' | 'bp' | 'pk', f: number, q = 0.707, db = 0): BQ {
  const w = (TAU * clamp(f, 5, R * 0.475)) / R, cw = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, db / 40);
  let b0: number, b1: number, b2: number, a0: number, a2: number;
  const a1 = -2 * cw;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a2 = 1 - al; }
  else { b0 = 1 + al * A; b1 = a1; b2 = 1 - al * A; a0 = 1 + al / A; a2 = 1 - al / A; }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function bq(a: Buf, c: BQ, w = 0): Buf {
  const [b0, b1, b2, a1, a2] = c, n = a.length;
  let z1 = 0, z2 = 0;
  for (let i = Math.max(0, n - w); i < n; i++) { const x = a[i], y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; }
  for (let i = 0; i < n; i++) { const x = a[i], y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; a[i] = y; }
  return a;
}
const lp = (a: Buf, f: number, q = 0.707, w = 0): Buf => bq(a, coef('lp', f, q), w);
const hp = (a: Buf, f: number, q = 0.707, w = 0): Buf => bq(a, coef('hp', f, q), w);
/** band-pass with 0 dB peak */
const bp = (a: Buf, f: number, q = 1, w = 0): Buf => bq(a, coef('bp', f, q), w);
const pk = (a: Buf, f: number, q: number, db: number, w = 0): Buf => bq(a, coef('pk', f, q, db), w);
function lp1(a: Buf, f: number, w = 0): Buf {
  const k = 1 - Math.exp((-TAU * f) / R), n = a.length;
  let y = 0;
  for (let i = Math.max(0, n - w); i < n; i++) y += k * (a[i] - y);
  for (let i = 0; i < n; i++) { y += k * (a[i] - y); a[i] = y; }
  return a;
}
function hp1(a: Buf, f: number, w = 0): Buf {
  const k = 1 - Math.exp((-TAU * f) / R), n = a.length;
  let y = 0;
  for (let i = Math.max(0, n - w); i < n; i++) y += k * (a[i] - y);
  for (let i = 0; i < n; i++) { y += k * (a[i] - y); a[i] -= y; }
  return a;
}
/** TPT state-variable filter with a time-varying cutoff fc(t) Hz (updated every 16 samples). bp has 0 dB peak. */
function svf(a: Buf, fc: (t: number) => number, q: number, mode: 'lp' | 'bp' | 'hp', w = 0): Buf {
  const n = a.length, k = 1 / q, m = mode === 'lp' ? 0 : mode === 'bp' ? 1 : 2, hi = R * 0.45;
  let s1 = 0, s2 = 0, g1 = 0, g2 = 0, g3 = 0;
  for (let pass = w > 0 ? 0 : 1; pass < 2; pass++) {
    const from = pass === 0 ? Math.max(0, n - w) : 0;
    for (let i = from; i < n; i++) {
      if (i === from || (i & 15) === 0) {
        const f = fc(i / R), g = Math.tan((Math.PI * (f < 8 ? 8 : f > hi ? hi : f)) / R);
        g1 = 1 / (1 + g * (g + k)); g2 = g * g1; g3 = g * g2;
      }
      const x = a[i], v3 = x - s2, v1 = g1 * s1 + g2 * v3, v2 = s2 + g2 * s1 + g3 * v3;
      s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
      if (pass === 1) a[i] = m === 0 ? v2 : m === 1 ? v1 * k : x - k * v1 - v2;
    }
  }
  return a;
}
/** parallel 2-pole resonators [f, tau, gain] (≈unit gain at resonance), summed into a new buffer */
function reson(src: Buf, list: Mode3[], w = 0): Buf {
  const n = src.length, o = new Float32Array(n);
  for (const [f, tau, g] of list) {
    if (f >= R * 0.47) continue;
    const th = (TAU * f) / R, r = Math.exp(-1 / (tau * R)), b1 = 2 * r * Math.cos(th), b2 = -r * r, k = g * (1 - r) * 2 * Math.sin(th);
    let y1 = 0, y2 = 0;
    for (let i = Math.max(0, n - w); i < n; i++) { const y = k * src[i] + b1 * y1 + b2 * y2; y2 = y1; y1 = y; }
    for (let i = 0; i < n; i++) { const y = k * src[i] + b1 * y1 + b2 * y2; y2 = y1; y1 = y; o[i] += y; }
  }
  return o;
}

/** parallel resonators normalized so a unit impulse rings each mode [f, tau, amp] at amplitude amp */
function ringBank(exc: Buf, list: Mode3[]): Buf {
  const n = exc.length, o = new Float32Array(n);
  for (const [f, tau, g] of list) {
    if (f >= R * 0.47) continue;
    const th = (TAU * f) / R, r = Math.exp(-1 / (tau * R)), b1 = 2 * r * Math.cos(th), b2 = -r * r, k = g * Math.sin(th);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const y = k * exc[i] + b1 * y1 + b2 * y2; y2 = y1; y1 = y; o[i] += y; }
  }
  return o;
}

// ── excitations ─────────────────────────────────────────────────────────────
/** exponentially decaying sine (f Hz, decay time constant tau) added at `at` */
function ring(dst: Buf, at: number, f: number, tau: number, amp: number, wrap = false): void {
  if (f >= R * 0.47 || amp === 0) return;
  const w = (TAU * f) / R, r = Math.exp(-1 / (tau * R)), c = Math.cos(w) * r, s = Math.sin(w) * r, n = dst.length, i0 = Math.round(at * R);
  const m = Math.min(Math.ceil(tau * R * 7), wrap ? n : n - i0);
  let x = amp, y = 0;
  for (let k = 0; k < m; k++) {
    const j = i0 + k;
    if (wrap) dst[j % n] += y;
    else if (j >= 0) dst[j] += y;
    const nx = c * x - s * y;
    y = s * x + c * y;
    x = nx;
  }
}
/** exponentially decaying white-noise burst */
function burst(dst: Buf, at: number, tau: number, amp: number, wrap = false): void {
  const n = dst.length, i0 = Math.round(at * R), m = Math.ceil(tau * R * 7), d = Math.exp(-1 / (tau * R));
  let e = amp;
  for (let k = 0; k < m; k++) {
    const j = i0 + k, v = rnd() * e;
    e *= d;
    if (wrap) dst[j % n] += v;
    else if (j >= 0 && j < n) dst[j] += v;
  }
}
/** struck object: a coloured noise click (low-passed at `tone`) plus decaying modes [f, tau, amp] */
function hit(dst: Buf, at: number, amp: number, modes: Mode3[], click = 0.0015, tone = 4000, wrap = false): void {
  if (click > 0) {
    const c = new Float32Array(Math.ceil(click * R * 7) + 8);
    burst(c, 0, click, 1);
    lp(c, tone);
    mix(dst, c, at, amp, wrap);
  }
  for (const [f, tau, a] of modes) ring(dst, at, f, tau, amp * a, wrap);
}
/** random metallic modes around `f0` (ratios typical of thin metal parts) */
function metal(f0: number, tau: number, n = 4): Mode3[] {
  const r = [1, 1.47, 2.09, 2.56, 3.39, 4.17, 5.23];
  const o: Mode3[] = [];
  for (let i = 0; i < n; i++) o.push([f0 * r[i] * uni(0.97, 1.03), tau * Math.pow(0.78, i), uni(0.4, 1) / (1 + i * 0.35)]);
  return o;
}
/**
 * Stick-slip friction pulses (creaks, squeaks, scrapes): pulses at rate(t)/s with jitter, shaped by
 * amp(t), rung through resonators; the result peaks at `level`.
 */
function creak(dst: Buf, at: number, dur: number, rate: (t: number) => number, amp: (t: number) => number, res: Mode3[], level: number, jitter = 0.15, wrap = false): void {
  const e = new Float32Array(len(dur) + 1);
  let t = 0;
  while (t < dur) {
    const i = Math.round(t * R);
    if (i < e.length) e[i] += amp(t) * uni(0.6, 1);
    t += (1 / Math.max(5, rate(t))) * (1 + rnd() * jitter);
  }
  mix(dst, pn(reson(e, res), level), at, 1, wrap);
}
/** water bubble: a rising sine chirp (Minnaert resonance) */
function bubble(dst: Buf, at: number, f0: number, tau: number, amp: number, rise = 2.5, wrap = false): void {
  const n = dst.length, i0 = Math.round(at * R), m = Math.ceil(tau * R * 6);
  let ph = 0;
  for (let k = 0; k < m; k++) {
    const t = k / R, f = f0 * (1 + (rise * t) / (tau * 2));
    ph += f / R;
    const v = Math.sin(TAU * ph) * amp * ad(t, 0.0006, tau);
    const j = i0 + k;
    if (wrap) dst[j % n] += v;
    else if (j >= 0 && j < n) dst[j] += v;
  }
}

// ── space ───────────────────────────────────────────────────────────────────
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491];
const APS = [556, 441, 341];
/**
 * Freeverb-style reverb → [L, R] = dry·src + wet·tail. t60: decay time (s); scale: room size
 * (delay scale); damp: HF damping 0..1. With `loop`, the network is pre-run once (circular).
 */
function verb(src: Buf, o: { t60?: number; scale?: number; damp?: number; wet?: number; dry?: number; loop?: boolean } = {}): Stereo {
  const n = src.length, t60 = o.t60 ?? 1.2, sc = (o.scale ?? 1) * (R / 44100), damp = o.damp ?? 0.35, wet = o.wet ?? 0.3, dry = o.dry ?? 1;
  const W = o.loop ? Math.min(n, Math.round(1.6 * t60 * R)) : 0;
  const res: Stereo = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const acc = new Float32Array(n);
    let g2 = 0;
    for (const d0 of COMBS) {
      const D = Math.max(8, Math.round((d0 + ch * 23) * sc)), g = Math.pow(10, (-3 * D) / (R * t60)), line = new Float32Array(D);
      g2 += g * g;
      let p = 0, f = 0;
      for (let pass = W ? 0 : 1; pass < 2; pass++) {
        const wr = pass === 1;
        for (let i = wr ? 0 : n - W; i < n; i++) {
          const y = line[p];
          f = y * (1 - damp) + f * damp;
          line[p] = src[i] + f * g;
          if (++p === D) p = 0;
          if (wr) acc[i] += y;
        }
      }
    }
    for (const d0 of APS) {
      const D = Math.max(4, Math.round((d0 + ch * 23) * sc)), line = new Float32Array(D);
      let p = 0;
      for (let pass = W ? 0 : 1; pass < 2; pass++) {
        const wr = pass === 1;
        for (let i = wr ? 0 : n - W; i < n; i++) {
          const x = acc[i], b = line[p];
          line[p] = x + b * 0.5;
          if (++p === D) p = 0;
          if (wr) acc[i] = b - x;
        }
      }
    }
    const k = wet * Math.sqrt(Math.max(0.02, 1 - g2 / COMBS.length) / COMBS.length);
    const r = res[ch];
    for (let i = 0; i < n; i++) r[i] = src[i] * dry + acc[i] * k;
  }
  return res;
}
/** reverb for a stereo source: the mono sum feeds the tail, added onto both channels */
function sverb(st: Stereo, o: { t60?: number; scale?: number; damp?: number; wet?: number; loop?: boolean }): Stereo {
  const w = verb(mono(st), { ...o, dry: 0 });
  for (let i = 0; i < st[0].length; i++) { st[0][i] += w[0][i]; st[1][i] += w[1][i]; }
  return st;
}
/** a single feedback echo (slap-back off a wall) */
function echo(a: Buf, sec: number, fb: number, g: number, cut = 2500, w = 0): Buf {
  const D = Math.max(1, Math.round(sec * R)), n = a.length, line = new Float32Array(D), k = 1 - Math.exp((-TAU * cut) / R);
  let p = 0, f = 0;
  const step = (x: number): number => { const y = line[p]; f += k * (y - f); line[p] = x + f * fb; if (++p === D) p = 0; return y; };
  for (let i = Math.max(0, n - w); i < n; i++) step(a[i]);
  for (let i = 0; i < n; i++) a[i] += step(a[i]) * g;
  return a;
}

// ── output ──────────────────────────────────────────────────────────────────
/** Finish a sound: remove DC, de-click the ends (one-shots), sanitize, normalize, wrap in an AudioBuffer. */
function out(ctx: BaseAudioContext, chans: Buf[], o: { peak?: number; fade?: number; loop?: boolean } = {}): AudioBuffer {
  const n = chans[0].length, loop = !!o.loop;
  let m = 0, bad = 0;
  for (const a of chans) {
    hp1(a, 14, loop ? Math.min(n, len(1)) : 0);
    if (!loop) {
      const fi = Math.min(n, 24);
      for (let i = 0; i < fi; i++) a[i] *= i / fi;
      const fo = Math.min(n, Math.round((o.fade ?? 0.012) * R));
      for (let i = 0; i < fo; i++) a[n - 1 - i] *= i / fo;
    }
    for (let i = 0; i < n; i++) {
      const v = a[i] < 0 ? -a[i] : a[i];
      if (!(v < 1e30)) { a[i] = 0; bad++; } else if (v > m) m = v;
    }
  }
  if (bad) console.warn(`[audio] ${bad} non-finite samples zeroed`);
  const k = m > 1e-9 ? (o.peak ?? 0.95) / m : 1;
  const b = ctx.createBuffer(chans.length, n, R);
  for (let c = 0; c < chans.length; c++) {
    const d = b.getChannelData(c), a = chans[c];
    for (let i = 0; i < n; i++) d[i] = a[i] * k;
  }
  return b;
}

// ═════════════════════════════════════════════════════════════════════════════
// Footsteps (variations come from playback rate 0.9–1.1)
// ═════════════════════════════════════════════════════════════════════════════
add({
  // socks on apartment flooring: soft heel thump, board body, sole roll
  step_wood: { volume: 0.7, render: (c) => {
    begin(101);
    const a = buf(0.24);
    const th = buf(0.06); burst(th, 0, 0.006, 1); lp(th, 380); lp(th, 700); mix(a, th, 0, 1.6);
    hit(a, 0.002, 0.55, [[92, 0.045, 1], [176, 0.032, 0.55], [405, 0.02, 0.32], [770, 0.012, 0.18], [1480, 0.006, 0.07]], 0.0012, 1400);
    const to = buf(0.05); burst(to, 0, 0.004, 1); lp(to, 1100); mix(a, to, 0.05, 0.45);
    hit(a, 0.052, 0.18, [[230, 0.02, 1], [520, 0.012, 0.5]], 0, 0);
    const sc = white(len(0.12)); bp(sc, 2600, 0.8); shape(sc, (t) => gate(t, 0, 0.03, 0.01, 0.06)); mix(a, sc, 0.01, 0.06);
    return out(c, [a]);
  } },
  // hard heel click on tiles / unit-bath floor, small hard-room flutter
  step_tile: { volume: 0.52, render: (c) => {
    begin(102);
    const a = buf(0.22);
    hit(a, 0, 0.9, [[2950, 0.006, 0.5], [4480, 0.004, 0.3], [1650, 0.008, 0.3]], 0.0008, 7000);
    const th = buf(0.05); burst(th, 0, 0.005, 1); lp(th, 450); mix(a, th, 0.001, 1);
    ring(a, 0.001, 145, 0.025, 0.35);
    hit(a, 0.058, 0.45, [[3300, 0.004, 0.5], [2100, 0.006, 0.3]], 0.0006, 6000);
    echo(a, 0.0093, 0.35, 0.28, 5000);
    return out(c, [a]);
  } },
  // shoe on concrete / asphalt: heel thud, gritty scuff, toe slap, corridor slap-back
  step_concrete: { volume: 0.9, render: (c) => {
    begin(103);
    const a = buf(0.3);
    const th = buf(0.08); burst(th, 0, 0.012, 1); lp(th, 650); mix(a, th, 0, 1.2);
    ring(a, 0, 112, 0.03, 0.35);
    hit(a, 0.001, 0.35, [[1900, 0.004, 0.4], [3100, 0.003, 0.3]], 0.0007, 5000);
    const gr = buf(0.16);
    for (let i = 0; i < gr.length; i++) if (rnd() > 0.93) gr[i] = rnd() * (ad(i / R, 0.008, 0.035) + 0.6 * ad(i / R - 0.06, 0.004, 0.02));
    bp(gr, 3200, 0.7); mix(a, gr, 0.004, 0.9);
    const to = buf(0.06); burst(to, 0, 0.006, 1); lp(to, 1400); mix(a, to, 0.06, 0.5);
    echo(a, 0.023, 0.2, 0.16, 3000);
    return out(c, [a]);
  } },
  // shrine gravel / dirt: granular crunch of many small stones
  step_gravel: { volume: 0.55, render: (c) => {
    begin(104);
    const a = buf(0.36);
    const g = buf(0.32);
    for (let k = 0; k < 80; k++) {
      const t = Math.pow(Math.abs(rnd()), 1.5) * 0.24 + 0.002;
      burst(g, t, uni(0.0003, 0.0011), uni(0.2, 1) * (ad(t, 0.025, 0.08) + 0.15));
    }
    bp(g, 2700, 0.6); mix(a, g, 0, 1);
    for (let k = 0; k < 14; k++) {
      const t = Math.pow(Math.abs(rnd()), 1.3) * 0.2 + 0.004;
      ring(a, t, uni(900, 2400), uni(0.0015, 0.004), uni(0.05, 0.18) * ad(t, 0.02, 0.09));
    }
    const th = buf(0.08); burst(th, 0, 0.014, 1); lp(th, 320); mix(a, th, 0, 0.9);
    return out(c, [a]);
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// UI
// ═════════════════════════════════════════════════════════════════════════════
add({
  ui_confirm: { volume: 0.32, bus: 'ui', render: (c) => {
    begin(201);
    const a = buf(0.16);
    hit(a, 0, 1, [[1046.5, 0.03, 1], [2101, 0.014, 0.25], [3140, 0.006, 0.12]], 0.0008, 3000);
    lp(a, 5000);
    return out(c, [a]);
  } },
  ui_open: { volume: 0.38, bus: 'ui', render: (c) => {
    begin(202);
    const a = buf(0.36);
    const sw = white(a.length); svf(sw, (t) => 700 + 4200 * clamp(t / 0.16, 0, 1), 1.4, 'bp'); shape(sw, (t) => gate(t, 0, 0.1, 0.07, 0.1));
    mix(a, sw, 0, 0.3);
    hit(a, 0.11, 0.5, [[587.3, 0.05, 1], [1174.7, 0.02, 0.2]], 0.001, 2000);
    hit(a, 0.17, 0.35, [[880, 0.05, 1], [1760, 0.02, 0.15]], 0.001, 2000);
    return out(c, [a]);
  } },
  ui_deny: { volume: 0.3, bus: 'ui', render: (c) => {
    begin(203);
    const a = buf(0.3);
    for (const t0 of [0, 0.12]) {
      const i0 = Math.round(t0 * R);
      for (let i = 0; i < len(0.085); i++) { const t = i / R; a[i0 + i] += sat(3 * sn(155 * t)) * gate(t, 0, 0.07, 0.004, 0.01); }
    }
    lp(a, 1600);
    return out(c, [a]);
  } },
  // tiny tick per typed character (~30 per second)
  text_tick: { volume: 0.26, bus: 'ui', render: (c) => {
    begin(204);
    const a = buf(0.03);
    hit(a, 0, 1, [[1750, 0.0035, 1], [3600, 0.0018, 0.3]], 0.0004, 6000);
    return out(c, [a], { fade: 0.004 });
  } },
  // objective updated: low, soft two-note bell (D4 → A3)
  objective: { volume: 0.9, bus: 'ui', render: (c) => {
    begin(205);
    const a = buf(2.6);
    const bell = (t0: number, f: number, g: number): void =>
      hit(a, t0, g, [[f, 1.1, 1], [f * 2.003, 0.55, 0.32], [f * 3.01, 0.28, 0.12], [f * 4.18, 0.14, 0.06], [f * 0.5, 1.4, 0.18]], 0.002, 1500);
    bell(0, 293.66, 1);
    bell(0.3, 220, 0.95);
    lp(a, 3500);
    return out(c, verb(a, { t60: 1.6, wet: 0.35, damp: 0.5 }));
  } },
  // picked something up: grab rustle + soft rising fifth
  item_get: { volume: 0.25, bus: 'ui', render: (c) => {
    begin(206);
    const a = buf(1.3);
    const ru = white(len(0.12)); bp(ru, 2400, 0.7); shape(ru, (t) => gate(t, 0, 0.04, 0.015, 0.06)); mix(a, ru, 0, 0.25);
    const tone = (t0: number, f: number, g: number): void => hit(a, t0, g, [[f, 0.42, 1], [f * 2, 0.16, 0.22], [f * 3, 0.07, 0.08], [f * 4.07, 0.035, 0.05]], 0.0008, 3000);
    tone(0.05, 659.25, 0.8);
    tone(0.15, 987.77, 0.75);
    return out(c, verb(a, { t60: 1.0, wet: 0.25 }));
  } },
  // page turn: swish + paper crackle + flap
  paper: { volume: 0.58, bus: 'ui', render: (c) => {
    begin(207);
    const a = buf(0.5);
    const sw = white(a.length); svf(sw, (t) => 1300 + 3000 * clamp(t / 0.3, 0, 1), 0.9, 'bp'); shape(sw, (t) => gate(t, 0.01, 0.2, 0.07, 0.12)); mix(a, sw, 0, 0.7);
    const cr = new Float32Array(a.length);
    for (let i = 0; i < cr.length; i++) if (rnd() > 0.985) cr[i] = rnd() * gate(i / R, 0, 0.26, 0.05, 0.08);
    hp(cr, 2200); mix(a, cr, 0, 1.4);
    const fl = buf(0.08); burst(fl, 0, 0.012, 1); lp(fl, 700); mix(a, fl, 0.3, 0.5);
    return out(c, [a]);
  } },
  // till: scanner beep, receipt printer, drawer, coins
  register: { volume: 0.26, bus: 'ui', render: (c) => {
    begin(208);
    const a = buf(1.25);
    for (let i = 0; i < len(0.1); i++) { const t = i / R; a[i] += (sn(2950 * t) + 0.18 * sn(8850 * t)) * gate(t, 0, 0.085, 0.003, 0.01) * 0.5; }
    const pr = white(len(0.32)); bp(pr, 3200, 1.5);
    for (let i = 0; i < pr.length; i++) { const t = i / R; pr[i] *= (0.6 + 0.4 * sn(110 * t)) * gate(t, 0, 0.3, 0.02, 0.02); }
    mix(a, pr, 0.2, 0.25);
    hit(a, 0.6, 0.6, [[150, 0.06, 1], [340, 0.04, 0.5], [900, 0.02, 0.25]], 0.004, 900);
    let t = 0.64;
    for (let k = 0; k < 6; k++) { hit(a, t, uni(0.15, 0.35), metal(uni(3200, 4400), 0.05, 4), 0.0004, 8000); t += uni(0.025, 0.06); }
    return out(c, [a]);
  } },
  // checkpoint: soft warm swell with a bell
  checkpoint: { volume: 0.26, bus: 'ui', render: (c) => {
    begin(209);
    const a = buf(2.6);
    for (let i = 0; i < a.length; i++) { const t = i / R; a[i] += (sn(220 * t) + 0.6 * sn(329.63 * t) + 0.4 * sn(440 * t) + 0.12 * sn(659.25 * t)) * ad(t, 0.25, 0.7) * 0.35; }
    hit(a, 0.02, 0.5, [[880, 0.8, 1], [1760.5, 0.3, 0.2], [2643, 0.12, 0.06]], 0.001, 3000);
    return out(c, verb(a, { t60: 1.8, wet: 0.35, damp: 0.5 }));
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Apartment: doors, fittings, furniture
// ═════════════════════════════════════════════════════════════════════════════
/** rolling rumble of a sliding panel (door / window / drawer runners) */
function roll(dur: number, cut: number, bumpHz: number, depth: number): Buf {
  const r = white(len(dur));
  lp(r, cut); lp(r, cut * 1.6);
  const m = smooth(r.length, bumpHz);
  for (let i = 0; i < r.length; i++) r[i] *= 1 - depth + depth * Math.min(2, Math.abs(m[i]));
  return r;
}
/** a few small clinks (cutlery, chain links, coins) */
function clinks(dst: Buf, t: number, count: number, f0: number, f1: number, g: number, gap: [number, number], tau = 0.03): void {
  for (let k = 0; k < count; k++) {
    hit(dst, t, g * uni(0.35, 1) * (1 - (0.5 * k) / count), metal(uni(f0, f1), tau, 3), 0.0003, 9000);
    t += uni(gap[0], gap[1]);
  }
}
add({
  // wide rocker switch: soft press + snap
  switch_click: { volume: 0.63, render: (c) => {
    begin(301);
    const a = buf(0.12);
    hit(a, 0, 0.45, [[3600, 0.004, 0.6], [1900, 0.005, 0.4], [420, 0.01, 0.25]], 0.0006, 8000);
    hit(a, 0.011, 1, [[3900, 0.005, 0.7], [2150, 0.006, 0.5], [6100, 0.002, 0.3], [460, 0.012, 0.35]], 0.0005, 9000);
    return out(c, [a]);
  } },
  // steel apartment door: handle + latch, hinge creak, draught
  door_open: { volume: 0.45, render: (c) => {
    begin(302);
    const a = buf(1.2);
    hit(a, 0, 0.6, metal(1250, 0.06, 5), 0.0008, 6000);
    hit(a, 0.065, 0.9, [[1650, 0.05, 1], [2730, 0.035, 0.6], [4130, 0.02, 0.4], [85, 0.08, 0.5]], 0.001, 5000);
    creak(a, 0.16, 0.8, (t) => 85 + 50 * Math.sin(t * 5.5) + 25 * t, (t) => gate(t, 0, 0.6, 0.12, 0.2), [[640, 0.02, 1], [1380, 0.012, 0.7], [2150, 0.008, 0.35]], 0.32, 0.12);
    const air = white(len(0.9)); lp(air, 320); shape(air, (t) => gate(t, 0.05, 0.4, 0.3, 0.4)); mix(a, pn(air, 0.18), 0.15);
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.5, wet: 0.12 }))]);
  } },
  // heavy slam: air push, thud, steel panel modes, latch
  door_close: { volume: 0.95, render: (c) => {
    begin(303);
    const a = buf(1.0);
    const air = white(len(0.2)); lp(air, 380); shape(air, (t) => gate(t, 0, 0.14, 0.12, 0.03)); mix(a, pn(air, 0.12), 0);
    const th = buf(0.2); burst(th, 0, 0.03, 1); lp(th, 1300); mix(a, pn(th, 0.9), 0.13);
    hit(a, 0.13, 1, [[68, 0.18, 0.8], [140, 0.12, 0.5], [236, 0.1, 0.4], [410, 0.07, 0.35], [690, 0.05, 0.28], [1180, 0.04, 0.2], [1960, 0.03, 0.12]], 0, 0);
    hit(a, 0.142, 0.5, [[2200, 0.03, 1], [3500, 0.022, 0.7], [5100, 0.012, 0.4]], 0.0006, 7000);
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.5, wet: 0.18 }))]);
  } },
  // thumb-turn deadbolt
  door_lock: { volume: 0.36, render: (c) => {
    begin(304);
    const a = buf(0.45);
    const fr = white(len(0.06)); bp(fr, 2200, 2); shape(fr, (t) => gate(t, 0, 0.05, 0.01, 0.01)); mix(a, pn(fr, 0.2), 0);
    hit(a, 0.06, 1, [[1650, 0.05, 1], [2900, 0.035, 0.6], [4400, 0.02, 0.35], [190, 0.03, 0.5]], 0.0008, 6000);
    hit(a, 0.088, 0.3, [[2400, 0.03, 1], [3800, 0.02, 0.6]], 0.0005, 7000);
    return out(c, [a]);
  } },
  // door chain slid along its guard and hooked
  chain: { volume: 0.3, render: (c) => {
    begin(305);
    const a = buf(0.8);
    const sc = white(len(0.42)); bp(sc, 4200, 1); shape(sc, (t) => gate(t, 0, 0.36, 0.05, 0.05)); mix(a, pn(sc, 0.1), 0.02);
    clinks(a, 0.02, 9, 3000, 4600, 0.5, [0.03, 0.06], 0.025);
    hit(a, 0.5, 0.9, [[2600, 0.04, 1], [3900, 0.03, 0.6], [900, 0.03, 0.4]], 0.0006, 7000);
    return out(c, [a]);
  } },
  // door yanked against the chain (twice)
  chain_rattle: { volume: 0.8, render: (c) => {
    begin(306);
    const a = buf(1.1);
    for (const [t0, g] of [[0, 1], [0.42, 0.65]]) {
      const th = buf(0.1); burst(th, 0, 0.02, 1); lp(th, 600); mix(a, pn(th, g * 0.8), t0);
      hit(a, t0, g * 0.8, [[80, 0.1, 1], [165, 0.08, 0.6], [320, 0.05, 0.4]], 0, 0);
      hit(a, t0 + 0.01, g * 0.7, [[1900, 0.04, 1], [3100, 0.035, 0.7], [4700, 0.02, 0.5], [6200, 0.012, 0.3]], 0.0005, 8000);
      clinks(a, t0 + 0.03, 8, 2800, 4800, g * 0.4, [0.012, 0.035], 0.02);
    }
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.5, wet: 0.12 }))]);
  } },
  // sliding door / closet: wooden rollers on a rail
  slide_open: { volume: 0.58, render: (c) => {
    begin(307);
    const a = buf(0.75);
    hit(a, 0, 0.35, [[520, 0.015, 1], [1100, 0.01, 0.5]], 0.001, 3000);
    const r = roll(0.62, 520, 24, 0.35); shape(r, (t) => gate(t, 0, 0.5, 0.07, 0.1)); mix(a, pn(r, 0.7), 0.02);
    const rt = new Float32Array(r.length);
    for (let i = 0; i < rt.length; i++) if (rnd() > 0.996) rt[i] = rnd() * gate(i / R, 0, 0.5, 0.07, 0.1);
    mix(a, pn(reson(rt, [[2400, 0.006, 1], [3700, 0.004, 0.6]]), 0.12), 0.02);
    return out(c, [a]);
  } },
  slide_close: { volume: 0.95, render: (c) => {
    begin(308);
    const a = buf(0.75);
    const r = roll(0.42, 520, 24, 0.35); shape(r, (t) => gate(t, 0, 0.36, 0.05, 0.03)); mix(a, pn(r, 0.55), 0);
    const th = buf(0.08); burst(th, 0, 0.01, 1); lp(th, 800); mix(a, pn(th, 0.6), 0.4);
    hit(a, 0.4, 0.8, [[140, 0.05, 1], [310, 0.04, 0.6], [680, 0.025, 0.35], [1250, 0.015, 0.2]], 0, 0);
    return out(c, [mono(verb(a, { t60: 0.4, scale: 0.5, wet: 0.12 }))]);
  } },
  // aluminium sash window: grip click, rattly rollers, glass rattle, outside air
  window_open: { volume: 0.45, render: (c) => {
    begin(309);
    const a = buf(1.15);
    hit(a, 0, 0.35, [[1800, 0.02, 1], [2900, 0.012, 0.5]], 0.0006, 6000);
    const r = roll(0.9, 900, 30, 0.45);
    for (let i = 0; i < r.length; i++) { const t = i / R; r[i] *= (0.8 + 0.2 * sn(21 * t)) * gate(t, 0, 0.75, 0.1, 0.12); }
    mix(a, pn(r, 0.6), 0.06);
    const g = new Float32Array(r.length);
    for (let i = 0; i < g.length; i++) if (rnd() > 0.9975) g[i] = rnd() * gate(i / R, 0, 0.75, 0.1, 0.1);
    mix(a, pn(reson(g, [[1850, 0.01, 1], [2650, 0.008, 0.8], [3700, 0.006, 0.5]]), 0.22), 0.06);
    const air = white(len(0.8)); lp(air, 500); shape(air, (t) => gate(t, 0.1, 0.5, 0.3, 0.2)); mix(a, pn(air, 0.14), 0.25);
    return out(c, [a]);
  } },
  window_close: { volume: 1.0, render: (c) => {
    begin(310);
    const a = buf(1.1);
    const r = roll(0.62, 900, 30, 0.45);
    for (let i = 0; i < r.length; i++) { const t = i / R; r[i] *= (0.8 + 0.2 * sn(21 * t)) * gate(t, 0, 0.56, 0.08, 0.04); }
    mix(a, pn(r, 0.5), 0);
    hit(a, 0.6, 0.9, [[95, 0.08, 1], [210, 0.06, 0.6], [470, 0.04, 0.4], [1150, 0.03, 0.25], [2300, 0.02, 0.15]], 0.002, 2500);
    clinks(a, 0.61, 6, 1700, 3600, 0.3, [0.015, 0.03], 0.012);
    return out(c, [a]);
  } },
  // curtain runners along the rail + fabric swish
  curtain: { volume: 0.28, render: (c) => {
    begin(311);
    const a = buf(0.95);
    const sw = white(len(0.85)); bp(sw, 2300, 0.6);
    const m = smooth(sw.length, 12);
    for (let i = 0; i < sw.length; i++) sw[i] *= (0.75 + 0.25 * m[i]) * gate(i / R, 0, 0.6, 0.1, 0.2);
    mix(a, pn(sw, 0.5), 0.02);
    const ru = new Float32Array(sw.length);
    for (let i = 0; i < ru.length; i++) if (rnd() > 0.9985) ru[i] = uni(0.4, 1) * gate(i / R, 0, 0.6, 0.05, 0.15);
    mix(a, pn(reson(ru, [[3300, 0.004, 1], [5200, 0.003, 0.6]]), 0.3), 0.02);
    const lo = white(len(0.85)); lp(lo, 400); shape(lo, (t) => gate(t, 0, 0.6, 0.15, 0.2)); mix(a, pn(lo, 0.25), 0.02);
    return out(c, [a]);
  } },
  // drawer (kitchen cutlery / desk stationery)
  drawer_open: { volume: 0.7, render: (c) => {
    begin(313);
    const a = buf(0.6);
    const sl = roll(0.3, 1200, 45, 0.5); bp(sl, 900, 1); shape(sl, (t) => gate(t, 0, 0.24, 0.03, 0.05)); mix(a, pn(sl, 0.45), 0);
    hit(a, 0.27, 0.5, [[220, 0.03, 1], [480, 0.02, 0.5], [1050, 0.012, 0.3]], 0.002, 2500);
    clinks(a, 0.08, 6, 2500, 5200, 0.3, [0.02, 0.07], 0.04);
    return out(c, [a]);
  } },
  drawer_close: { volume: 0.6, render: (c) => {
    begin(314);
    const a = buf(0.55);
    const sl = roll(0.2, 1200, 45, 0.5); bp(sl, 900, 1); shape(sl, (t) => gate(t, 0, 0.17, 0.02, 0.02)); mix(a, pn(sl, 0.35), 0);
    const th = buf(0.06); burst(th, 0, 0.008, 1); lp(th, 1000); mix(a, pn(th, 0.7), 0.19);
    hit(a, 0.19, 0.8, [[160, 0.05, 1], [350, 0.03, 0.55], [760, 0.02, 0.3]], 0, 0);
    clinks(a, 0.205, 4, 2500, 5200, 0.25, [0.015, 0.04], 0.04);
    return out(c, [a]);
  } },
  // plastic lid (toilet / washer)
  lid_open: { volume: 0.46, render: (c) => {
    begin(315);
    const a = buf(0.55);
    creak(a, 0, 0.22, (t) => 130 + 80 * t, (t) => gate(t, 0, 0.18, 0.03, 0.04), [[900, 0.01, 1], [1700, 0.007, 0.6]], 0.2, 0.2);
    hit(a, 0.3, 0.55, [[380, 0.03, 1], [820, 0.02, 0.6], [1650, 0.012, 0.35]], 0.0015, 3000);
    return out(c, [a]);
  } },
  lid_close: { volume: 0.57, render: (c) => {
    begin(316);
    const a = buf(0.5);
    const air = white(len(0.1)); lp(air, 600); shape(air, (t) => gate(t, 0, 0.07, 0.06, 0.01)); mix(a, pn(air, 0.1), 0);
    hit(a, 0.08, 1, [[260, 0.05, 1], [590, 0.035, 0.7], [1240, 0.02, 0.45], [2100, 0.012, 0.3]], 0.0015, 2500);
    hit(a, 0.15, 0.22, [[270, 0.03, 1], [610, 0.02, 0.6]], 0.001, 2500);
    return out(c, [mono(verb(a, { t60: 0.4, scale: 0.4, wet: 0.12 }))]);
  } },
  // small cupboard door (shoe cabinet, breaker cover)
  cabinet_open: { volume: 0.5, render: (c) => {
    begin(317);
    const a = buf(0.45);
    hit(a, 0, 0.5, [[1500, 0.015, 1], [2600, 0.01, 0.6], [300, 0.03, 0.5]], 0.0008, 5000);
    creak(a, 0.03, 0.22, (t) => 200 - 150 * t, (t) => gate(t, 0, 0.16, 0.04, 0.05), [[1100, 0.008, 1], [2300, 0.006, 0.5]], 0.12, 0.2);
    return out(c, [a]);
  } },
  cabinet_close: { volume: 0.63, render: (c) => {
    begin(318);
    const a = buf(0.4);
    const th = buf(0.05); burst(th, 0, 0.006, 1); lp(th, 1200); mix(a, pn(th, 0.5), 0);
    hit(a, 0, 0.8, [[210, 0.04, 1], [470, 0.03, 0.6], [990, 0.015, 0.3]], 0, 0);
    hit(a, 0.015, 0.35, [[2100, 0.01, 1], [3600, 0.008, 0.5]], 0.0005, 7000);
    return out(c, [a]);
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Apartment: appliances, gadgets, visitors
// ═════════════════════════════════════════════════════════════════════════════
/** glass bottles clinking in a fridge door pocket */
function bottles(dst: Buf, times: number[], g: number): void {
  for (const t of times) {
    const f = uni(1850, 2400);
    hit(dst, t, g * uni(0.5, 1), [[f, 0.1, 1], [f * 2.71, 0.05, 0.5], [f * 5.08, 0.025, 0.25]], 0.0004, 8000);
  }
}
add({
  // gasket unsticks with a soft pop, bottles rattle in the door
  fridge_open: { volume: 0.42, render: (c) => {
    begin(321);
    const a = buf(0.8);
    const pop = buf(0.2); burst(pop, 0, 0.03, 1); lp(pop, 260); lp(pop, 400); mix(a, pn(pop, 0.8), 0);
    const su = white(len(0.15)); bp(su, 650, 1.2); shape(su, (t) => ad(t, 0.004, 0.04)); mix(a, pn(su, 0.25), 0.002);
    bottles(a, [0.1, 0.16, 0.23], 0.3);
    const sw = white(len(0.5)); lp(sw, 350); shape(sw, (t) => gate(t, 0.05, 0.25, 0.15, 0.2)); mix(a, pn(sw, 0.15), 0.05);
    return out(c, [a]);
  } },
  fridge_close: { volume: 0.88, render: (c) => {
    begin(322);
    const a = buf(0.65);
    const th = buf(0.25); burst(th, 0, 0.05, 1); lp(th, 300); lp(th, 450); mix(a, pn(th, 1), 0);
    hit(a, 0, 0.6, [[95, 0.07, 1], [180, 0.06, 0.6], [340, 0.04, 0.4]], 0, 0);
    bottles(a, [0.02, 0.07, 0.12], 0.25);
    const pf = white(len(0.12)); bp(pf, 800, 1); shape(pf, (t) => ad(t, 0.003, 0.03)); mix(a, pn(pf, 0.2), 0.005);
    return out(c, [a]);
  } },
  // compressor: 60 Hz-grid hum, motor beating at 3 Hz, fan air and a faint whine (6 s loop)
  fridge_hum: { volume: 0.22, loop: true, bus: 'amb', render: (c) => {
    begin(323, 22050);
    const L = 6, n = len(L);
    const nz = white(n); lp(nz, 260, 0.707, n); lp(nz, 400, 0.707, n); pn(nz, 0.35);
    const wh = white(n); bp(wh, 1130, 14, n); pn(wh, 0.03);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / R, wob = 1 + 0.06 * sn(0.5 * t);
      a[i] = (0.45 * sn(120 * t) + 0.15 * sn(240 * t) + 0.06 * sn(360 * t) + 0.25 * sn(58.5 * t) + 0.2 * sn(117 * t)) * wob + nz[i] + wh[i];
    }
    return out(c, [a], { loop: true });
  } },
  // piezo "pii pii pii"
  microwave_beep: { volume: 0.15, render: (c) => {
    begin(324);
    const a = buf(1.05);
    for (const t0 of [0, 0.33, 0.66]) {
      const i0 = Math.round(t0 * R);
      for (let i = 0; i < len(0.22); i++) { const t = i / R; a[i0 + i] += sat(2.5 * sn(2580 * t)) * gate(t, 0, 0.2, 0.003, 0.004); }
    }
    const b = a.slice(); bp(b, 2580, 2.5);
    for (let i = 0; i < a.length; i++) a[i] = a[i] * 0.35 + b[i];
    return out(c, [a]);
  } },
  // CRT on/off: relay click, degauss "whump", HV crackle, static burst
  tv_on: { volume: 0.56, render: (c) => {
    begin(325);
    const a = buf(0.9);
    hit(a, 0, 0.6, [[1800, 0.01, 1], [3200, 0.006, 0.6]], 0.0006, 7000);
    for (let i = 0; i < a.length; i++) {
      const t = i / R - 0.03;
      if (t > 0) a[i] += (sat(1.5 * sn(60 * t)) * 0.6 + 0.25 * sn(180 * t)) * ad(t, 0.01, 0.22) * 0.7;
    }
    const cr = new Float32Array(a.length);
    for (let i = 0; i < cr.length; i++) if (rnd() > 0.995) cr[i] = rnd() * ad(i / R - 0.03, 0.005, 0.15);
    hp(cr, 3000); mix(a, pn(cr, 0.35), 0);
    const st = white(len(0.25)); hp(st, 900); shape(st, (t) => ad(t, 0.002, 0.07)); mix(a, pn(st, 0.3), 0.04);
    return out(c, [a]);
  } },
  // TV snow: hiss with a faint 60 Hz field buzz (4 s loop)
  tv_static: { volume: 0.16, loop: true, render: (c) => {
    begin(326);
    const L = 4, n = len(L);
    const a = white(n); lp(a, 7500, 0.707, n); hp(a, 180, 0.707, n);
    const m = smooth(n, 6, n);
    for (let i = 0; i < n; i++) { const t = i / R; a[i] = a[i] * (0.88 + 0.08 * m[i] + 0.04 * sn(2 * t)) + 0.05 * sat(2 * sn(60 * t)); }
    return out(c, [a], { loop: true });
  } },
  // lever, valve, rushing water with gurgles, drain, refill hiss
  toilet_flush: { volume: 0.56, render: (c) => {
    begin(327);
    const a = buf(4.8);
    hit(a, 0, 0.6, [[700, 0.02, 1], [1500, 0.015, 0.6], [2600, 0.01, 0.4]], 0.001, 4000);
    hit(a, 0.09, 0.4, [[420, 0.03, 1], [980, 0.02, 0.5]], 0.001, 3000);
    const rush = white(len(3.4)); lp(rush, 2600);
    const body = rush.slice(); bp(body, 620, 0.8);
    const sw = smooth(rush.length, 3);
    for (let i = 0; i < rush.length; i++) { const t = i / R; rush[i] = (rush[i] * 0.6 + body[i] * 1.2) * gate(t, 0, 1.6, 0.25, 1.4) * (0.8 + 0.2 * sw[i]); }
    mix(a, pn(rush, 0.75), 0.15);
    for (let k = 0; k < 70; k++) {
      const t = uni(0.3, 3.3), late = t > 2.2;
      bubble(a, t, late ? uni(150, 420) : uni(300, 950), uni(0.012, 0.04), uni(0.05, 0.25) * (late ? 1.4 : 1), 2.5);
    }
    const fill = white(len(2.4)); bp(fill, 2600, 1.4); shape(fill, (t) => gate(t, 0, 1.6, 0.4, 0.6)); mix(a, pn(fill, 0.12), 2.3);
    for (let k = 0; k < 25; k++) bubble(a, uni(2.6, 4.4), uni(900, 2200), uni(0.006, 0.015), uni(0.03, 0.1), 3);
    return out(c, [mono(verb(a, { t60: 0.6, scale: 0.4, wet: 0.2 }))]);
  } },
  // single drop into water, small tiled-room tail
  water_drip: { volume: 0.25, render: (c) => {
    begin(328);
    const a = buf(0.7);
    burst(a, 0, 0.0002, 0.25);
    bubble(a, 0.0015, 1050, 0.02, 1, 2.5);
    return out(c, [mono(verb(a, { t60: 0.8, scale: 0.45, wet: 0.35, damp: 0.3 }))]);
  } },
  // breaker thrown back on: loud snap, metal box, appliances humming awake
  breaker: { volume: 1.0, render: (c) => {
    begin(329);
    const a = buf(0.8);
    hit(a, 0, 1, [[950, 0.03, 1], [1700, 0.02, 0.7], [3200, 0.012, 0.5], [5200, 0.008, 0.35]], 0.0008, 9000);
    hit(a, 0, 0.6, [[160, 0.06, 1], [330, 0.05, 0.6]], 0.003, 1500);
    for (let i = 0; i < a.length; i++) {
      const t = i / R - 0.04;
      if (t > 0) a[i] += (0.6 * sat(2 * sn(120 * t)) + 0.3 * sn(60 * t)) * ad(t, 0.02, 0.12) * 0.3;
    }
    return out(c, [mono(verb(a, { t60: 0.4, scale: 0.4, wet: 0.15 }))]);
  } },
  // tactile switch: press + release
  flashlight_click: { volume: 0.75, render: (c) => {
    begin(330);
    const a = buf(0.1);
    hit(a, 0, 1, [[2700, 0.006, 0.8], [4300, 0.004, 0.5], [6100, 0.003, 0.3], [880, 0.012, 0.3]], 0.0006, 9000);
    hit(a, 0.032, 0.45, [[3100, 0.005, 0.8], [5000, 0.003, 0.4], [900, 0.01, 0.2]], 0.0005, 9000);
    return out(c, [a]);
  } },
  // unscrew cap, batteries out, new ones in, screw cap
  battery_swap: { volume: 0.47, render: (c) => {
    begin(331);
    const a = buf(1.35);
    const scr = (t0: number, d: number, g: number): void => {
      const s = white(len(d)); bp(s, 3000, 1.5);
      for (let i = 0; i < s.length; i++) { const t = i / R; s[i] *= (0.5 + 0.5 * Math.max(0, sn(32 * t))) * gate(t, 0, d - 0.04, 0.02, 0.04); }
      mix(a, pn(s, g), t0);
    };
    scr(0, 0.25, 0.3);
    hit(a, 0.3, 0.5, [[1200, 0.02, 1], [2300, 0.012, 0.5]], 0.001, 4000);
    hit(a, 0.42, 0.45, [[3500, 0.03, 1], [7300, 0.012, 0.4]], 0.0004, 9000);
    hit(a, 0.47, 0.35, [[3900, 0.025, 1], [8000, 0.01, 0.3]], 0.0004, 9000);
    hit(a, 0.72, 0.6, [[1500, 0.015, 1], [2700, 0.01, 0.6], [400, 0.02, 0.4]], 0.0008, 5000);
    hit(a, 0.8, 0.45, [[1700, 0.015, 1], [2900, 0.01, 0.5]], 0.0008, 5000);
    scr(0.9, 0.25, 0.28);
    hit(a, 1.18, 0.6, [[1300, 0.015, 1], [2500, 0.01, 0.6]], 0.0008, 5000);
    return out(c, [a]);
  } },
  // door viewer: tiny squeak of the cover, metal tick, eye-cup bump
  peephole: { volume: 0.7, render: (c) => {
    begin(332);
    const a = buf(0.4);
    creak(a, 0, 0.13, (t) => 620 + 900 * t, (t) => gate(t, 0, 0.1, 0.02, 0.03), [[2100, 0.004, 1], [3400, 0.003, 0.5]], 0.35, 0.05);
    hit(a, 0.14, 0.6, [[3800, 0.015, 1], [6100, 0.01, 0.5], [1500, 0.012, 0.3]], 0.0004, 9000);
    const k = buf(0.04); burst(k, 0, 0.004, 1); lp(k, 500); mix(a, pn(k, 0.3), 0.16);
    return out(c, [a]);
  } },
  // phone buzzing on a table: two bursts then silence (loops as a pattern)
  phone_vibrate: { volume: 0.7, render: (c) => {
    begin(333);
    const a = buf(2.0);
    for (const [t0, t1] of [[0.02, 0.55], [0.8, 1.33]]) {
      const d = t1 - t0;
      let ph = 0;
      for (let i = Math.round(t0 * R); i < Math.round((t1 + 0.06) * R); i++) {
        const t = i / R - t0, f = 120 + 48 * clamp(t / 0.06, 0, 1) - (t > d ? (40 * (t - d)) / 0.06 : 0);
        ph += f / R;
        const s = sn(ph);
        a[i] += (sat(3 * s) * 0.6 + (s > 0.6 ? rnd() * 0.6 : 0)) * gate(t, 0, d, 0.03, 0.05);
      }
    }
    lp(a, 3500); pk(a, 230, 2, 6);
    return out(c, [a]);
  } },
  // generic electronic trill ring (two bursts then a pause; loops as a pattern)
  ringtone: { volume: 0.25, render: (c) => {
    begin(334);
    const a = buf(3.0);
    for (const t0 of [0.02, 1.22]) {
      const i0 = Math.round(t0 * R);
      let ph = 0;
      for (let i = 0; i < len(0.92); i++) {
        const t = i / R, hi = Math.floor(t * 16) % 2 === 0;
        ph += (hi ? 1318.5 : 1046.5) / R;
        a[i0 + i] += (sn(ph) + 0.3 * sn(3 * ph) + 0.12 * sn(5 * ph)) * gate(t, 0, 0.88, 0.006, 0.02) * (hi ? 1 : 0.85);
      }
    }
    hp(a, 500); lp(a, 5000);
    for (let i = 0; i < a.length; i++) a[i] = sat(1.6 * a[i]);
    return out(c, [a]);
  } },
  // three knocks on the steel front door
  knock: { volume: 0.8, render: (c) => {
    begin(335);
    const a = buf(1.5);
    const door: Mode3[] = [[125, 0.08, 0.6], [270, 0.07, 0.5], [455, 0.055, 0.5], [690, 0.045, 0.45], [1050, 0.03, 0.35], [1630, 0.02, 0.25], [2480, 0.012, 0.15]];
    for (const [t0, g] of [[0, 0.9], [0.27, 0.8], [0.56, 1]]) {
      const ex = buf(0.03); burst(ex, 0, 0.0025, 1); lp(ex, 3500); mix(a, pn(ex, 0.9 * g), t0);
      hit(a, t0, g, door.map(([f, tau, x]): Mode3 => [f * uni(0.98, 1.02), tau, x]), 0, 0);
    }
    for (let i = 0; i < a.length; i++) a[i] = sat(2.5 * a[i]);
    return out(c, [mono(verb(a, { t60: 0.7, scale: 0.6, wet: 0.2 }))]);
  } },
  // "pin-pooon": two-tone descending chime through a cheap, slightly broken intercom speaker
  doorbell: { volume: 0.55, render: (c) => {
    begin(336);
    const a = buf(2.6);
    const tone = (t0: number, f: number, tau: number): void => hit(a, t0, 1, [[f, tau, 1], [f * 2, tau * 0.5, 0.12], [f * 3, tau * 0.4, 0.22], [f * 4, tau * 0.25, 0.05]], 0, 0);
    tone(0, 659.3, 0.38);
    tone(0.42, 523.3, 0.85);
    const bz = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { const x = sat(3.2 * a[i]), x2 = x * x; a[i] = x; bz[i] = rnd() * x2 * x2; }
    hp(a, 420); hp(a, 420); lp(a, 3300); pk(a, 1150, 1.5, 5);
    bp(bz, 3200, 1.2); mix(a, bz, 0, 0.12);
    hit(a, 0, 0.08, [[2500, 0.004, 1]], 0.0005, 6000);
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.5, wet: 0.12 }))]);
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Fear
// ═════════════════════════════════════════════════════════════════════════════
/** sine with a per-sample frequency function, accumulated phase (no Math.sin drift issues) */
function chirp(dst: Buf, at: number, dur: number, f: (t: number) => number, env: (t: number) => number, g = 1): void {
  const i0 = Math.round(at * R), m = Math.min(len(dur), dst.length - i0);
  let ph = 0;
  for (let k = 0; k < m; k++) { const t = k / R; ph += f(t) / R; dst[i0 + k] += sn(ph) * env(t) * g; }
}
add({
  // "lub-dub": pitch-dropping thumps, lightly saturated so laptop speakers still carry it
  heartbeat: { volume: 1.0, render: (c) => {
    begin(401);
    const a = buf(0.62);
    const beat = (t0: number, f0: number, f1: number, g: number, d: number): void => {
      chirp(a, t0, 0.5, (t) => f1 + (f0 - f1) * Math.exp(-t / 0.03), (t) => ad(t, 0.006, d), g);
      const th = buf(0.08); burst(th, 0, 0.012, 1); lp(th, 140); lp(th, 200); mix(a, pn(th, 0.35 * g), t0);
    };
    beat(0, 78, 44, 1, 0.06);
    beat(0.2, 92, 52, 0.62, 0.045);
    for (let i = 0; i < a.length; i++) a[i] = sat(1.8 * a[i]);
    return out(c, [a]);
  } },
  // staring: tinnitus with a slow binaural beat + uneasy low drone + breath (4 s loop; engine raises its rate)
  stare: { volume: 0.75, loop: true, render: (c) => {
    begin(402);
    const L = 4, n = len(L);
    const br = white(n); bp(br, 420, 0.7, n); pn(br, 1);
    const br2 = rot(br, n * 0.37);
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / R;
      const drone = sat(1.5 * (0.5 * sn(55 * t) + 0.35 * sn(58.25 * t) + 0.25 * sn(82.5 * t) + 0.12 * sn(110.5 * t))) * (0.75 + 0.25 * sn(0.25 * t));
      const tin = 0.16 * (1 + 0.15 * sn(0.5 * t)), air = 0.12 * (0.6 + 0.4 * sn(0.25 * t + 0.3));
      l[i] = drone * 0.55 + tin * sn(4200 * t) + 0.03 * sn(6300 * t) + air * br[i];
      r[i] = drone * 0.55 + tin * sn(4203 * t) + 0.03 * sn(6301.5 * t) + air * br2[i];
    }
    return out(c, [l, r], { loop: true });
  } },
  // the face rushes in: sub impact, overdriven formant scream, metallic screech (loud, low-passed)
  jumpscare: { volume: 1.0, render: (c) => {
    begin(403);
    const n = len(1.7);
    const chans: Buf[] = [];
    for (let ch = 0; ch < 2; ch++) {
      const a = new Float32Array(n);
      chirp(a, 0, 1.7, (t) => 30 + 28 * Math.exp(-t / 0.08), (t) => ad(t, 0.003, 0.35), 0.9);
      const im = buf(0.4); burst(im, 0, 0.06, 1); lp(im, 1200); mix(a, pn(im, 0.6), 0);
      const v = new Float32Array(n), jit = smooth(n, 30);
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / R, f0 = (520 + 200 * clamp(t / 0.3, 0, 1)) * (1 + 0.03 * sn(7 * t) + 0.02 * jit[i]) * (ch ? 1.006 : 1);
        p1 += f0 / R; p2 += (f0 * 1.414) / R;
        v[i] = (2 * (p1 - Math.floor(p1)) - 1 + 0.6 * (2 * (p2 - Math.floor(p2)) - 1) + 0.5 * rnd()) * gate(t, 0, 0.75, 0.02, 0.8);
      }
      const f1 = v.slice(), f2 = v.slice(), f3 = v.slice();
      bp(f1, 900, 5); bp(f2, 1450, 6); bp(f3, 2800, 7);
      for (let i = 0; i < n; i++) v[i] = sat(3 * (f1[i] + 0.8 * f2[i] + 0.5 * f3[i]) + 0.15 * v[i]);
      mix(a, pn(v, 0.8), 0.01);
      const sc = white(n); bp(sc, 3050, 6);
      for (let i = 0; i < n; i++) { const t = i / R; sc[i] = (sc[i] * 2 + 0.3 * sn(2950 * t) + 0.3 * sn(3120 * t)) * ad(t, 0.01, 0.45); }
      mix(a, pn(sc, 0.35), 0);
      lp(a, 7500);
      chans.push(a);
    }
    return out(c, chans);
  } },
  // short dissonant sting when a face shows up
  face_appear: { volume: 1.0, render: (c) => {
    begin(404);
    const n = len(2.6);
    const st: Stereo = [new Float32Array(n), new Float32Array(n)];
    const sub = new Float32Array(n);
    chirp(sub, 0, 2.6, (t) => 36 + 14 * Math.exp(-t / 0.1), (t) => ad(t, 0.004, 0.4));
    const im = buf(0.3); burst(im, 0, 0.05, 1); lp(im, 1500); mix(sub, pn(im, 0.5), 0);
    pan(st, sub, 0, 0.6, 0);
    [233.08, 246.94, 349.23, 369.99, 493.88].forEach((f, k) => {
      const v = new Float32Array(n);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const t = i / R;
        p += (f * (1 + 0.004 * sn(5.3 * t + k * 0.3))) / R;
        v[i] = (2 * (p - Math.floor(p)) - 1) * ad(t, 0.015, 0.9) * (0.7 + 0.3 * sn(9 * t + k * 0.21));
      }
      svf(v, (t) => 600 + 3400 * Math.exp(-t / 0.4), 1.2, 'lp');
      pan(st, v, 0, 0.42, -0.8 + 0.4 * k);
    });
    const hi = new Float32Array(n);
    chirp(hi, 0, 2.6, (t) => 1975.5 * (1 + 0.004 * Math.sin(TAU * 6 * t)), (t) => ad(t, 0.03, 0.8));
    chirp(hi, 0, 2.6, () => 2093, (t) => ad(t, 0.03, 0.8));
    pan(st, hi, 0, 0.16, 0.3);
    return out(c, sverb(st, { t60: 1.8, wet: 0.35, damp: 0.5 }));
  } },
  // the face is gone: sucked-in swell cut short, falling warble, low "thoom"
  face_vanish: { volume: 0.52, render: (c) => {
    begin(405);
    const a = buf(1.4);
    const sw = white(len(0.4)); hp(sw, 800); svf(sw, (t) => 900 + 5000 * (t / 0.4), 1.2, 'bp');
    shape(sw, (t) => Math.pow(clamp(t / 0.38, 0, 1), 3) * (t < 0.38 ? 1 : Math.max(0, 1 - (t - 0.38) / 0.005)));
    mix(a, pn(sw, 0.7), 0);
    for (const k of [1, 1.013]) chirp(a, 0.3, 1.1, (t) => (180 + 1020 * Math.exp(-t / 0.18)) * k, (t) => ad(t, 0.01, 0.25), 0.2);
    ring(a, 0.38, 70, 0.2, 0.4);
    return out(c, verb(a, { t60: 1.4, wet: 0.35, damp: 0.5 }));
  } },
  // sharp inhale with a tiny voiced squeak and a glottal catch, then a shaky exhale
  gasp: { volume: 0.5, render: (c) => {
    begin(406);
    const a = buf(0.8);
    const src = white(len(0.26));
    const f1 = src.slice(), f2 = src.slice(), f3 = src.slice();
    svf(f1, (t) => 800 - 350 * (t / 0.26), 5, 'bp'); svf(f2, (t) => 1300 + 900 * (t / 0.26), 6, 'bp'); svf(f3, () => 2700, 6, 'bp');
    const hs = src.slice(); hp(hs, 2500); lp(hs, 7000);
    for (let i = 0; i < src.length; i++) src[i] = (f1[i] + 0.8 * f2[i] + 0.5 * f3[i] + 0.035 * hs[i]) * gate(i / R, 0, 0.22, 0.03, 0.012);
    mix(a, pn(src, 0.9), 0);
    const vo = buf(0.1);
    let p = 0;
    for (let i = 0; i < vo.length; i++) { const t = i / R; p += (700 + 120 * t * 10) / R; vo[i] = (2 * (p - Math.floor(p)) - 1) * gate(t, 0, 0.07, 0.02, 0.02); }
    const v1 = vo.slice(); bp(v1, 450, 6); bp(vo, 2300, 7);
    for (let i = 0; i < vo.length; i++) vo[i] += v1[i];
    mix(a, pn(vo, 0.18), 0.14);
    hit(a, 0.235, 0.15, [[1800, 0.003, 1]], 0.0004, 5000);
    const ex = white(len(0.35)); lp(ex, 1400);
    shape(ex, (t) => gate(t, 0, 0.1, 0.05, 0.2) * (0.7 + 0.3 * Math.sin(TAU * 9 * t)));
    mix(a, pn(ex, 0.25), 0.42);
    return out(c, [a]);
  } },
  // game over: a temple bell (beating partial pairs) over a dark drone, long hall
  gameover_drone: { volume: 1.0, render: (c) => {
    begin(407, 32000);
    const n = len(8);
    const a = new Float32Array(n);
    const f0 = 98;
    for (const [r, tau, g] of [[0.5, 5, 0.35], [1, 4, 1], [1.004, 4, 0.6], [2.03, 2.5, 0.5], [2.041, 2.5, 0.3], [2.98, 1.6, 0.35], [4.16, 1, 0.25], [5.43, 0.6, 0.15], [6.79, 0.4, 0.1], [8.2, 0.25, 0.07]]) ring(a, 0.02, f0 * r, tau, g);
    const th = buf(0.15); burst(th, 0, 0.03, 1); lp(th, 400); mix(a, pn(th, 0.5), 0.02);
    const dr = new Float32Array(n);
    let p1 = 0, p2 = 0, p3 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / R;
      p1 += 49 / R; p2 += 51.5 / R; p3 += 73.4 / R;
      dr[i] = ((p1 % 1) + (p2 % 1) + 0.7 * (p3 % 1) - 1.35) * gate(t, 0.3, 5.5, 1.5, 2.4);
    }
    lp(dr, 260); lp(dr, 300);
    mix(a, pn(dr, 0.35), 0);
    return out(c, verb(a, { t60: 3.2, scale: 1.3, wet: 0.4, damp: 0.45 }));
  } },
  // the charm takes the hit: a crack, the little bell rattling out of tune, an airy release
  omamori_break: { volume: 0.55, render: (c) => {
    begin(408);
    const a = buf(2.2);
    hit(a, 0, 1, [[3100, 0.03, 1], [4700, 0.025, 0.8], [6600, 0.02, 0.6], [8900, 0.012, 0.4]], 0.0006, 12000);
    for (let k = 0; k < 7; k++) hit(a, uni(0.005, 0.07), uni(0.2, 0.5), metal(uni(2500, 6000), 0.015, 3), 0.0004, 12000);
    let t = 0.03;
    for (let k = 0; k < 8; k++) {
      const f = 2350 * (1 - (0.03 * k) / 8);
      hit(a, t, 0.7 * Math.pow(0.8, k), [[f, 0.35, 1], [f * 1.006, 0.35, 0.6], [f * 1.53, 0.25, 0.6], [f * 2.4, 0.15, 0.4]], 0.0003, 9000);
      t += uni(0.025, 0.045);
    }
    const air = white(len(1.2)); bp(air, 5200, 1.2); shape(air, (tt) => ad(tt, 0.02, 0.3)); mix(a, pn(air, 0.15), 0.02);
    return out(c, verb(a, { t60: 1.6, wet: 0.35 }));
  } },
  // hard soles along the outdoor corridor, getting closer, stopping at the door
  footsteps_outside: { volume: 0.95, render: (c) => {
    begin(409);
    const a = buf(5.2);
    const times = [0, 0.56, 1.1, 1.67, 2.21, 2.78, 3.33, 3.86, 4.3];
    times.forEach((t0, k) => {
      const g = 0.45 + (0.55 * k) / (times.length - 1), v = uni(0.97, 1.03);
      hit(a, t0, g, [[1800 * v, 0.012, 0.6], [2900 * v, 0.008, 0.4], [950 * v, 0.02, 0.3]], 0.0008, 6000);
      const th = buf(0.06); burst(th, 0, 0.01, 1); lp(th, 400); mix(a, pn(th, g * 0.7), t0 + 0.003);
      const sc = white(len(0.09)); bp(sc, 2600, 0.8); shape(sc, (t) => gate(t, 0, 0.03, 0.01, 0.05)); mix(a, pn(sc, g * 0.15), t0 + 0.05);
    });
    echo(a, 0.034, 0.25, 0.25, 3000);
    lp(a, 5000);
    return out(c, [mono(verb(a, { t60: 0.9, scale: 0.8, wet: 0.25 }))]);
  } },
  // fingernails dragged down the other side of the wall, three strokes
  scratch: { volume: 0.8, render: (c) => {
    begin(410);
    const a = buf(2.3);
    for (const [t0, dur, g] of [[0, 0.55, 1], [0.72, 0.45, 0.8], [1.3, 0.7, 0.95]]) {
      const s = white(len(dur)); bp(s, 2300, 0.9);
      const e = new Float32Array(s.length);
      let t = 0;
      while (t < dur) { const i = Math.round(t * R); if (i < e.length) e[i] = uni(0.5, 1); t += 1 / uni(30, 70); }
      lp1(e, 120); pn(e, 1);
      for (let i = 0; i < s.length; i++) s[i] *= (0.3 + e[i] * 2) * gate(i / R, 0, dur - 0.08, 0.04, 0.08);
      mix(a, pn(s, g * 0.8), t0);
      creak(a, t0, dur, (tt) => 40 + 30 * Math.sin(tt * 9), (tt) => gate(tt, 0, dur - 0.08, 0.04, 0.08), [[380, 0.015, 1], [820, 0.01, 0.6], [1500, 0.006, 0.3]], g * 0.35, 0.3);
    }
    lp(a, 4500);
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.4, wet: 0.15 }))]);
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Voices: whispers, breath, sobbing
// ═════════════════════════════════════════════════════════════════════════════
// Whispered Japanese vowels (F1, F2, F3 in Hz).
const VOW: Record<string, [number, number, number]> = {
  a: [850, 1300, 2600], i: [330, 2250, 3050], u: [380, 1450, 2450], e: [520, 1950, 2650], o: [540, 900, 2550],
};
/**
 * Whisper synthesizer: noise through three moving formants plus fricatives, bursts and
 * nasal murmurs. `seq` is [phoneme, seconds][] with phonemes a i u e o s sh h k t m n r y
 * '.' (closure) '_' (pause). `size` scales formants (smaller speaker = higher). Control
 * tracks run at 1/16 of the audio rate. With `wrap` everything is circular (for loops).
 */
function whisperVoice(seq: [string, number][], n: number, start: number, size: number, wrap = false): Buf {
  // control points: one per 16 samples; when wrapping, exactly nc points span the n samples
  const CR = 16, nc = wrap ? Math.max(2, Math.round(n / CR)) : Math.ceil(n / CR) + 1, q = wrap ? nc / n : 1 / CR, Rc = R * q;
  const T = Array.from({ length: 7 }, () => new Float32Array(nc + 1));
  const [F1, F2, F3, VA, FA, FF, NA] = T;
  const set = new Uint8Array(nc + 1);
  const bursts: [number, number, number][] = [];
  let f: [number, number, number] = VOW.a, ff = 5000, i = Math.round(start * R);
  for (let s = 0; s < seq.length; s++) {
    const [ph, d] = seq[s], m = Math.round(d * R);
    const next = seq.slice(s + 1).find(([p]) => p in VOW);
    if (ph in VOW) f = VOW[ph];
    else if (next && ph !== '_') f = VOW[next[0]];
    if (ph === 's') ff = 6200;
    if (ph === 'sh') ff = 3300;
    if (ph === 'y') f = VOW.i;
    for (let ci = Math.ceil(i * q); ci < (i + m) * q; ci++) {
      const x = (ci / q - i) / m;
      let va = 0, fa = 0, na = 0;
      if (ph in VOW) va = 1;
      else if (ph === 's' || ph === 'sh') { va = 0.05; fa = ph === 's' ? 0.9 : 0.8; }
      else if (ph === 'h') { va = 0.4; fa = 0.05; }
      else if (ph === 'k' || ph === 't') va = x > 0.6 ? 0.45 : 0;
      else if (ph === 'm' || ph === 'n') { va = 0.08; na = 0.45; }
      else if (ph === 'r') va = 0.45;
      else if (ph === 'y') va = 0.6;
      const j = wrap ? ci % nc : ci;
      if (j < 0 || j >= nc) continue;
      F1[j] = f[0] * size; F2[j] = f[1] * size; F3[j] = f[2] * size; VA[j] = va; FA[j] = fa; FF[j] = ff; NA[j] = na; set[j] = 1;
    }
    if (ph === 'k' || ph === 't') bursts.push([i + Math.round(m * 0.6), ph === 'k' ? 2300 : 4600, ph === 'k' ? 0.8 : 0.65]);
    i += m;
  }
  // hold formant targets through unset spans (before the first / after the last phoneme)
  let first = 0;
  while (first < nc - 1 && !set[first]) first++;
  for (const tr of [F1, F2, F3, FF]) {
    for (let k = 0; k < first; k++) tr[k] = tr[first];
    for (let k = first + 1; k < nc; k++) if (!set[k]) tr[k] = tr[k - 1];
  }
  // co-articulation: smooth the control tracks (one-pole at control rate, circular when wrapping)
  const sm = (tr: Buf, hz: number): void => {
    const kk = 1 - Math.exp((-TAU * hz) / Rc);
    let y = tr[wrap ? nc - 1 : 0];
    if (wrap) for (let k = 0; k < nc; k++) y += kk * (tr[k] - y);
    for (let k = 0; k < nc; k++) { y += kk * (tr[k] - y); tr[k] = y; }
  };
  for (const tr of [F1, F2, F3]) sm(tr, 9);
  for (const tr of [VA, FA, NA]) { sm(tr, 28); sm(tr, 40); }
  sm(FF, 20);
  for (const tr of T) tr[nc] = wrap ? tr[0] : tr[nc - 1];
  const w = wrap ? Math.min(n, len(0.4)) : 0;
  const o = new Float32Array(n), src = white(n);
  const at = (tr: Buf) => (t: number): number => { const c = Math.round(t * R * q); return tr[wrap ? c % nc : Math.min(nc, c)]; };
  // per-sample amplitudes (linear interpolation of the control tracks)
  const va = new Float32Array(n), fa = new Float32Array(n), nm = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const x = j * q, c0 = x | 0, c1 = wrap && c0 + 1 >= nc ? 0 : c0 + 1, u = x - c0;
    va[j] = VA[c0] + (VA[c1] - VA[c0]) * u;
    fa[j] = FA[c0] + (FA[c1] - FA[c0]) * u;
    nm[j] = NA[c0] + (NA[c1] - NA[c0]) * u;
  }
  const qs = [4, 8, 10], gs = [1, 0.7, 0.4];
  for (let k = 0; k < 3; k++) {
    const b = src.slice(), gk = gs[k];
    svf(b, at([F1, F2, F3][k]), qs[k], 'bp', w);
    for (let j = 0; j < n; j++) o[j] += b[j] * gk * va[j];
  }
  const fr = src.slice(); svf(fr, at(FF), 1.6, 'bp', w);
  const na = rot(src, n >> 1); lp(na, 480, 0.707, w);
  for (let j = 0; j < n; j++) o[j] += fr[j] * fa[j] * 0.8 + na[j] * nm[j] * 0.5;
  for (const [k, fc, g] of bursts) {
    const b = buf(0.03); burst(b, 0, 0.004, 1); bp(b, fc, 1.5);
    mix(o, b, k / R, g * 2.5, wrap);
  }
  return o;
}
/** voiced segment: jittery sawtooth + breath noise through three formants */
function voice(dst: Buf, at: number, dur: number, f0: (t: number) => number, fm: ((t: number) => number)[], amp: (t: number) => number, breath = 0.3, g = 1, wrap = false): void {
  const n = len(dur), src = new Float32Array(n), jit = smooth(n, 25);
  let p = 0;
  for (let i = 0; i < n; i++) { p += (f0(i / R) * (1 + 0.012 * jit[i])) / R; src[i] = (1 - breath) * (2 * (p - Math.floor(p)) - 1) + breath * rnd() * 1.5; }
  lp1(src, 3500);
  const o = new Float32Array(n);
  fm.forEach((f, k) => {
    const b = src.slice();
    svf(b, f, [5, 9, 11][k] ?? 10, 'bp');
    const gk = [1, 0.6, 0.35][k] ?? 0.3;
    for (let i = 0; i < n; i++) o[i] += b[i] * gk;
  });
  for (let i = 0; i < n; i++) o[i] *= amp(i / R);
  mix(dst, o, at, g, wrap);
}
/** one breath through the vocal tract: inhale (in=true) or exhale */
function breath(dst: Buf, at: number, dur: number, inhale: boolean, g: number, shake = 0.25): void {
  const n = len(dur), a = white(n), b = a.slice(), m = smooth(n, 9);
  if (inhale) { bp(a, 1150, 1.2); bp(b, 2700, 2.2); } else { lp(a, 1500); bp(b, 520, 1); }
  for (let i = 0; i < n; i++) {
    const t = i / R, e = inhale ? gate(t, 0, dur - 0.05, dur * 0.7, 0.05) : gate(t, 0, dur * 0.12, dur * 0.1, dur * 0.85);
    a[i] = (a[i] + 0.7 * b[i]) * e * (1 + shake * m[i]);
  }
  mix(dst, pn(a, g), at);
}
add({
  // close whisper: an intake of breath, then "zutto… miteru" (two voices, slightly apart)
  whisper: { volume: 0.8, render: (c) => {
    begin(501);
    const n = len(2.6);
    const a = new Float32Array(n);
    breath(a, 0, 0.42, true, 0.25, 0.4);
    const seq: [string, number][] = [['s', 0.11], ['u', 0.12], ['.', 0.07], ['t', 0.03], ['o', 0.24], ['_', 0.22], ['m', 0.07], ['i', 0.13], ['.', 0.05], ['t', 0.03], ['e', 0.12], ['r', 0.03], ['u', 0.3], ['_', 0.2]];
    const v1 = whisperVoice(seq, n, 0.48, 1.0), v2 = whisperVoice(seq, n, 0.505, 0.88);
    for (let i = 0; i < n; i++) { const t = i / R; a[i] += (v1[i] + 0.45 * v2[i]) * (1 - 0.35 * clamp((t - 0.5) / 1.8, 0, 1)); }
    hp(a, 150);
    return out(c, [a]);
  } },
  // the words the script subtitles: "……ふたつ" (the faces / the voicemail), "……おやすみ", Nao's "……しずく"
  whisper_futatsu: { volume: 0.85, render: (c) => {
    begin(511);
    const n = len(2.2);
    const a = new Float32Array(n);
    breath(a, 0, 0.36, true, 0.2, 0.35);
    const seq: [string, number][] = [['_', 0.05], ['h', 0.09], ['u', 0.12], ['.', 0.05], ['t', 0.03], ['a', 0.18], ['.', 0.05], ['t', 0.03], ['s', 0.09], ['u', 0.34], ['_', 0.25]];
    const v1 = whisperVoice(seq, n, 0.42, 0.96), v2 = whisperVoice(seq, n, 0.445, 0.84);
    for (let i = 0; i < n; i++) a[i] += v1[i] + 0.4 * v2[i];
    hp(a, 150);
    return out(c, [a]);
  } },
  whisper_oyasumi: { volume: 0.7, render: (c) => {
    begin(512);
    const n = len(2.4);
    const a = new Float32Array(n);
    const seq: [string, number][] = [['_', 0.1], ['o', 0.16], ['y', 0.05], ['a', 0.14], ['s', 0.1], ['u', 0.06], ['m', 0.08], ['i', 0.4], ['_', 0.3]];
    const v1 = whisperVoice(seq, n, 0.2, 1.0), v2 = whisperVoice(seq, n, 0.23, 0.87);
    for (let i = 0; i < n; i++) a[i] += v1[i] + 0.4 * v2[i];
    breath(a, 1.5, 0.6, false, 0.15, 0.2);
    hp(a, 150);
    return out(c, [a]);
  } },
  whisper_shizuku: { volume: 0.8, render: (c) => {
    begin(513);
    const n = len(2.0);
    const a = new Float32Array(n);
    const seq: [string, number][] = [['_', 0.05], ['sh', 0.13], ['i', 0.12], ['s', 0.07], ['u', 0.15], ['.', 0.06], ['k', 0.04], ['u', 0.36], ['_', 0.25]];
    const v = whisperVoice(seq, n, 0.15, 1.12);
    for (let i = 0; i < n; i++) a[i] += v[i];
    breath(a, 1.3, 0.5, false, 0.12, 0.2);
    hp(a, 170);
    return out(c, [a]);
  } },
  // several voices murmuring all around (8 s loop)
  whisper_loop: { volume: 0.62, loop: true, render: (c) => {
    begin(502, 22050);
    const L = 8, n = len(L);
    const st: Stereo = [new Float32Array(n), new Float32Array(n)];
    const cons = ['k', 's', 'sh', 't', 'n', 'm', 'h', 'r', 'y', '', '', ''], vows = ['a', 'i', 'u', 'e', 'o', 'u', 'i'];
    [[-0.65, 1, 1.0], [0.15, 0.8, 0.9], [0.7, 0.75, 1.13]].forEach(([p, g, size], v) => {
      const seq: [string, number][] = [];
      let t = uni(0, 0.8);
      seq.push(['_', t]);
      while (t < L) {
        const syl = Math.round(uni(4, 10));
        for (let k = 0; k < syl && t < L; k++) {
          const cn = pick(cons), vw = pick(vows), d = uni(0.1, 0.19);
          if (cn) { seq.push([cn, cn === 'k' || cn === 't' ? 0.06 : 0.05]); t += 0.055; }
          seq.push([vw, d]); t += d;
        }
        const pause = uni(0.3, 1.0);
        seq.push(['_', pause]); t += pause;
      }
      const o = whisperVoice(seq, n, 0, size, true);
      lp(o, 5200 - v * 900, 0.707, n);
      pan(st, o, 0, g, p, true);
    });
    return out(c, sverb(st, { t60: 0.9, wet: 0.3, loop: true }), { loop: true });
  } },
  // nervous, shaky breathing: in-out twice, ends in silence (loopable)
  breathing: { volume: 0.4, render: (c) => {
    begin(503);
    const a = buf(5.2);
    breath(a, 0.1, 0.85, true, 0.55);
    breath(a, 1.0, 1.1, false, 0.8);
    breath(a, 2.7, 0.8, true, 0.5);
    breath(a, 3.55, 1.05, false, 0.75);
    return out(c, [a]);
  } },
  // muffled sobbing in another room: sniffles, broken whimpers, stuttering inhales
  crying: { volume: 0.4, render: (c) => {
    begin(504);
    const a = buf(5.8);
    const sniff = (t0: number, k: number): void => {
      for (let j = 0; j < k; j++) {
        const s = white(len(0.07)); bp(s, 2300, 1.2);
        shape(s, (t) => gate(t, 0, 0.04, 0.012, 0.025));
        mix(a, pn(s, 0.35), t0 + j * 0.11);
      }
    };
    const U = [() => 400, () => 1100, () => 2500], O: ((t: number) => number)[] = [() => 480, () => 850, () => 2500];
    sniff(0.15, 2);
    voice(a, 0.55, 0.8, (t) => 385 - 90 * t + 18 * Math.sin(TAU * 6 * t), U, (t) => gate(t, 0, 0.18, 0.03, 0.05) + 0.9 * gate(t, 0.25, 0.37, 0.03, 0.05) + 0.8 * gate(t, 0.45, 0.62, 0.03, 0.15), 0.45, 0.6);
    for (let j = 0; j < 3; j++) breath(a, 1.6 + j * 0.13, 0.11, true, 0.25, 0.1);
    voice(a, 2.2, 0.95, (t) => 340 - 80 * t + 14 * Math.sin(TAU * 5.5 * t), O, (t) => gate(t, 0, 0.75, 0.12, 0.2) * (0.75 + 0.25 * Math.sin(TAU * 6 * t)), 0.5, 0.55);
    sniff(3.4, 1);
    voice(a, 3.95, 0.16, (t) => 540 - 200 * t, U, (t) => gate(t, 0, 0.08, 0.01, 0.04), 0.35, 0.5);
    hit(a, 4.1, 0.08, [[1500, 0.003, 1]], 0.0004, 4000);
    breath(a, 4.45, 0.7, false, 0.3, 0.35);
    lp(a, 4000);
    return out(c, [mono(verb(a, { t60: 0.6, scale: 0.5, wet: 0.25 }))]);
  } },
  // ending: slow breathing Dm9 pad, wind, two far-off singing-bowl tones (16 s loop)
  ending_drone: { volume: 0.7, loop: true, bus: 'amb', render: (c) => {
    begin(505, 22050);
    const L = 16, n = len(L);
    const l = new Float32Array(n), r = new Float32Array(n);
    const T1 = wtab([1, 0.3, 0.12]), T2 = wtab([1, 0.3]);
    [73.4375, 110, 174.625, 261.625, 329.625].forEach((f, k) => {
      const sw = (k % 3) + 1, g = k === 0 ? 0.9 : 0.5, f2 = f + 0.0625;
      for (let i = 0; i < n; i++) {
        const t = i / R, e = (0.55 + 0.45 * sn((sw * t) / L + k * 0.17)) * g;
        const v = look(T1, f * t) * e, w = look(T2, f2 * t) * e;
        l[i] += v * 0.6 + w * 0.4;
        r[i] += v * 0.4 + w * 0.6;
      }
    });
    const wind = white(n); lp(wind, 380, 0.707, n);
    const wm = smooth(n, 0.25, n);
    for (let i = 0; i < n; i++) wind[i] *= 0.6 + 0.4 * sat(wm[i]);
    pn(wind, 0.5);
    const wr = rot(wind, n * 0.41);
    for (let i = 0; i < n; i++) { l[i] += wind[i]; r[i] += wr[i]; }
    const bowl = new Float32Array(n);
    for (const t0 of [3, 11]) for (const [p, tau, g] of [[1, 4.5, 1], [1.004, 4.5, 0.5], [2.71, 2, 0.45], [5.15, 0.8, 0.2]]) ring(bowl, t0, 1661 * p * (t0 > 5 ? 0.75 : 1), tau, g, true);
    pan([l, r], bowl, 0, 0.6, 0.2, true);
    return out(c, [l, r], { loop: true });
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Ambience beds (loops on the 'amb' bus). Built circularly → seamless.
// ═════════════════════════════════════════════════════════════════════════════
const st0 = (n: number): Stereo => [new Float32Array(n), new Float32Array(n)];
/** a distant car swelling past (filtered tyre noise), mono, peak g */
function farCar(dur: number, g: number, bright = 500): Buf {
  const o = white(len(dur)), h = dur / 2;
  svf(o, (t) => 240 + bright * Math.exp(-(((t - h) / (dur / 5)) ** 2)), 0.7, 'lp');
  shape(o, (t) => Math.exp(-(((t - h) / (dur / 4.5)) ** 2)));
  return pn(o, g);
}
/** Aburazemi-like sizzle: band noise with fast rectified random AM ("jiri-jiri") and a swell */
function abura(n: number, fc: number, w: number, swell: (t: number) => number): Buf {
  const a = white(n); bp(a, fc, 1.6, w); bp(a, fc * 1.12, 1.6, w);
  const m = smooth(n, 55, w);
  for (let i = 0; i < n; i++) a[i] *= (0.35 + Math.min(2.5, Math.abs(m[i]))) * swell(i / R);
  return pn(a, 1);
}
/** Kumazemi-like "sha-sha-sha" (common in Kansai): bright noise pulsed at `rate` Hz */
function kuma(n: number, rate: number, w: number, swell: (t: number) => number): Buf {
  const a = white(n); bp(a, 5600, 1.8, w); hp(a, 3000, 0.707, w);
  for (let i = 0; i < n; i++) { const s = Math.max(0, sn((rate * i) / R)); a[i] *= (0.15 + 0.85 * s * s) * swell(i / R); }
  return pn(a, 1);
}
/** one Minmin-zemi call: "miiin, min-min-min…, miii" (buzzy tone with a rising-falling pitch per unit) */
function minmin(dst: Stereo, at: number, g: number, p: number, wrap: boolean, units = 6): void {
  const seg: [number, number, number][] = [[0, 0.85, 1]];
  let t = 1.0;
  for (let k = 0; k < units; k++) { seg.push([t, 0.3, 0.95]); t += 0.37; }
  seg.push([t + 0.05, 0.75, 0.8]);
  const o = new Float32Array(len(t + 1));
  for (const [s0, d, gg] of seg) {
    const i0 = Math.round(s0 * R), m = len(d);
    let ph = 0;
    for (let k = 0; k < m; k++) {
      const x = k / m, f = 3500 + 1100 * Math.sin(Math.PI * Math.min(1, x * 1.6)) - 300 * x;
      ph += f / R;
      o[i0 + k] += (sn(ph) + 0.15 * sn(2 * ph)) * (0.55 + 0.45 * sn((118 * k) / R)) * gg * gate(x, 0, 0.82, 0.08, 0.17);
    }
  }
  pan(dst, o, at, g, p, wrap);
}
/** small bird call: an FM sweep from f0 to f1 */
function tweet(dst: Stereo, at: number, f0: number, f1: number, dur: number, g: number, p: number, wrap: boolean): void {
  const m = len(dur), o = new Float32Array(m);
  let ph = 0;
  for (let k = 0; k < m; k++) { const x = k / m; ph += (f0 + (f1 - f0) * Math.pow(x, 0.7) + 120 * Math.sin(TAU * 35 * x * dur)) / R; o[k] = sn(ph) * Math.pow(Math.sin(Math.PI * x), 2); }
  pan(dst, o, at, g, p, wrap);
}
/** insect phrase: tone at f pulsed at `rate` Hz for `dur` seconds */
function insect(dst: Stereo, at: number, f: number, rate: number, dur: number, g: number, p: number, wrap: boolean): void {
  const m = len(dur), o = new Float32Array(m);
  for (let k = 0; k < m; k++) { const t = k / R, s = Math.max(0, sn(rate * t)); o[k] = sn(f * t) * s * s * gate(t, 0, dur - 0.05, 0.04, 0.05); }
  pan(dst, o, at, g, p, wrap);
}
/** decorrelated stereo pair from a mono bed (rotation) */
const spread = (a: Buf, k = 0.43): Stereo => [a, rot(a, a.length * k)];
function addTo(d: Stereo, s: Stereo, g = 1): Stereo {
  for (let i = 0; i < d[0].length; i++) { d[0][i] += s[0][i] * g; d[1][i] += s[1][i] * g; }
  return d;
}
add({
  // the dead quiet of the room at 3 a.m.: low air, faint hiss, a car far outside, the house settling
  room_tone: { volume: 0.2, loop: true, bus: 'amb', render: (c) => {
    begin(601, 22050);
    const L = 20, n = len(L), W = len(1);
    const b = white(n); lp1(b, 150, W); lp1(b, 420, W); pn(b, 1);
    const air = white(n); bp(air, 900, 0.6, W); pn(air, 0.07);
    const hiss = white(n); hp(hiss, 3500, 0.707, W); pn(hiss, 0.015);
    const m = smooth(n, 0.15, n);
    for (let i = 0; i < n; i++) b[i] = (b[i] + air[i]) * (1 + 0.12 * m[i]) + hiss[i];
    const st = spread(b);
    pan(st, farCar(7, 0.5), 6.5, 1, (t) => -0.7 + 0.2 * t, true);
    const tick = buf(0.25); hit(tick, 0, 1, [[2300, 0.01, 1], [3700, 0.006, 0.5], [900, 0.015, 0.4]], 0.0004, 6000);
    pan(st, pn(tick, 0.16), 15.3, 1, 0.55, true);
    pan(st, tick, 4.2, 0.6, -0.6, true);
    return out(c, st, { loop: true });
  } },
  // summer night outside: distant insect chorus, a few close crickets, breeze, one far car
  night_out: { volume: 0.32, loop: true, bus: 'amb', render: (c) => {
    begin(602, 32000);
    const L = 20, n = len(L), W = len(1);
    const wind = white(n); lp1(wind, 230, W); lp1(wind, 500, W);
    const gm = smooth(n, 0.1, n);
    for (let i = 0; i < n; i++) wind[i] *= 0.7 + 0.3 * sat(gm[i]);
    const st = spread(pn(wind, 1));
    const ch = white(n); bp(ch, 4300, 5, W); bp(ch, 4300, 3, W);
    const cm = smooth(n, 30, W);
    for (let i = 0; i < n; i++) ch[i] *= 0.4 + Math.min(2, Math.abs(cm[i]));
    addTo(st, spread(pn(ch, 0.22), 0.31));
    for (let t = 0.3; t < L; t += uni(2.0, 2.6)) insect(st, t, 4100, 48, uni(0.55, 0.8), 0.2, -0.5, true);
    for (let t = 1.1; t < L; t += uni(2.8, 3.4)) {
      for (let k = 0; k < 4; k++) insect(st, t + k * 0.05, 4650, 0, 0.035, 0.16, 0.6, true);
      insect(st, t + 0.22, 4650, 0, 0.28, 0.14, 0.6, true);
    }
    for (let t = 0.7; t < L; t += uni(4.5, 6)) insect(st, t, 3600, 31, uni(1.4, 2.2), 0.08, 0.1, true);
    pan(st, farCar(6.5, 0.45, 700), 11.5, 1, (t) => 0.6 - 0.2 * t, true);
    return out(c, st, { loop: true });
  } },
  // summer midday: Aburazemi sizzle, a Minmin-zemi calling, far traffic, a wind chime, sparrows
  day_out: { volume: 0.35, loop: true, bus: 'amb', render: (c) => {
    begin(603, 32000);
    const L = 16, n = len(L), W = len(1);
    const st = st0(n);
    pan(st, abura(n, 4300, W, (t) => 0.75 + 0.25 * sn(t / L)), 0, 0.9, -0.55, true);
    pan(st, abura(n, 4900, W, (t) => 0.7 + 0.3 * sn((2 * t) / L + 0.3)), 0, 0.7, 0.6, true);
    minmin(st, 3.4, 0.55, 0.35, true);
    minmin(st, 11.2, 0.25, -0.75, true, 4);
    const tr = white(n); lp1(tr, 260, W); lp1(tr, 500, W);
    addTo(st, spread(pn(tr, 0.3)));
    pan(st, farCar(6, 0.3, 600), 1.5, 1, (t) => -0.8 + 0.25 * t, true);
    const fu = buf(2.2);
    for (const t0 of [0, 0.19]) hit(fu, t0, t0 ? 0.5 : 1, [[2650, 0.9, 1], [2650 * 2.32, 0.4, 0.4], [2650 * 4.1, 0.15, 0.2]], 0.0003, 9000);
    pan(st, pn(fu, 0.12), 7.3, 1, 0.25, true);
    pan(st, fu, 13.9, 0.08, 0.25, true);
    for (const [t0, k] of [[5.1, 3], [9.6, 2]]) for (let j = 0; j < k; j++) tweet(st, t0 + j * 0.16, 5200, 3600, 0.07, 0.1, -0.2, true);
    return out(c, st, { loop: true });
  } },
  // pure cicada chorus (Aburazemi, Kumazemi, Minmin) — layer it over other beds
  cicadas: { volume: 0.3, loop: true, bus: 'amb', render: (c) => {
    begin(604, 32000);
    const L = 12, n = len(L), W = len(1);
    const st = st0(n);
    pan(st, abura(n, 4300, W, (t) => 0.75 + 0.25 * sn(t / L)), 0, 0.9, -0.5, true);
    pan(st, abura(n, 4700, W, (t) => 0.7 + 0.3 * sn((2 * t) / L + 0.5)), 0, 0.75, 0.55, true);
    pan(st, kuma(n, 8, W, (t) => 0.5 + 0.5 * Math.max(0, sn(t / L + 0.6))), 0, 0.5, 0.1, true);
    minmin(st, 2.0, 0.5, -0.2, true);
    return out(c, st, { loop: true });
  } },
});

/** release ramp: 1 until `end - r`, then a cosine fade to 0 at `end` */
const rel = (t: number, end: number, r: number): number => (t < end - r ? 1 : t >= end ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - (end - r))) / r));
const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
/** soft FM electric-piano note (recursive envelopes: cheap) */
function epiano(dst: Buf, at: number, f: number, dur: number, g: number, wrap = false): void {
  const m = len(dur), i0 = Math.round(at * R), n = dst.length, dI = Math.exp(-1 / (0.3 * R)), dA = Math.exp(-1 / (1.3 * R)), atk = 0.004 * R;
  let eI = 1.4, eA = g;
  for (let k = 0; k < m; k++) {
    const t = k / R, ph = f * t;
    const v = sn(ph + ((eI + 0.2) * sn(ph)) / TAU) * eA * (k < atk ? k / atk : 1) * rel(t, dur, 0.15);
    eI *= dI; eA *= dA;
    let j = i0 + k;
    if (j >= n) { if (!wrap) break; j -= n; }
    dst[j] += v;
  }
}
add({
  // inside the convenience store: refrigerated cases, and a quiet piped-in I–vi–ii–V loop from a ceiling speaker
  conbini_in: { volume: 0.33, loop: true, bus: 'amb', render: (c) => {
    begin(605, 22050);
    const L = 16, n = len(L), W = len(1);
    const bed = white(n); lp1(bed, 700, W); lp1(bed, 1400, W); pn(bed, 0.5);
    for (let i = 0; i < n; i++) { const t = i / R; bed[i] += 0.28 * sn(120 * t) + 0.1 * sn(240 * t) + 0.16 * sn(58.5 * t) + 0.04 * sat(3 * sn(120 * t + 0.25)); }
    const st = spread(bed);
    const bgm = new Float32Array(n);
    const chords = [[48, 52, 55, 59], [45, 52, 55, 60], [50, 53, 57, 60], [43, 53, 55, 59]], bass = [36, 33, 38, 31], mel = [[76, 74], [72, 71], [69, 72], [71, 74]];
    chords.forEach((ch, k) => {
      const t0 = k * 4;
      ch.forEach((m, j) => { epiano(bgm, t0 + 0.03 * j, mtof(m), 3.85, 0.2); epiano(bgm, t0 + 2 + 0.02 * j, mtof(m), 1.9, 0.08); });
      const fb = mtof(bass[k]);
      for (let i = 0; i < len(3.9); i++) { const t = i / R; bgm[Math.round(t0 * R) + i] += (sn(fb * t) + 0.3 * sn(2 * fb * t)) * ad(t, 0.01, 1.4) * rel(t, 3.9, 0.15) * 0.35; }
      mel[k].forEach((m, j) => epiano(bgm, t0 + j * 2 + 0.5, mtof(m), 1.7, 0.16, true));
    });
    hp(bgm, 240, 0.707, W); lp(bgm, 4200, 0.707, W); pk(bgm, 1500, 1, 3, W);
    echo(bgm, 0.019, 0.3, 0.35, 3000, W);
    pan(st, pn(bgm, 0.32), 0, 1, 0.15, true);
    return out(c, st, { loop: true });
  } },
  // shrine grounds at night: gusts through the trees, leaves, a creaking trunk, a twig, a far owl
  shrine_night: { volume: 0.3, loop: true, bus: 'amb', render: (c) => {
    begin(606, 32000);
    const L = 20, n = len(L), W = len(1);
    const gust = smooth(n, 0.12, n);
    for (let i = 0; i < n; i++) gust[i] = 0.5 + 0.5 * sat(1.4 * gust[i]);
    const wind = white(n); lp1(wind, 260, W); lp1(wind, 520, W);
    const leaves = white(n); bp(leaves, 3200, 0.5, W);
    const fl = smooth(n, 14, W);
    for (let i = 0; i < n; i++) { const g = gust[i]; wind[i] *= 0.45 + 0.55 * g; leaves[i] *= g * Math.sqrt(g) * (0.5 + 0.5 * Math.min(2, Math.abs(fl[i]))); }
    const st = spread(pn(wind, 0.8));
    addTo(st, spread(pn(leaves, 0.6), 0.27));
    const cr = buf(1.6);
    creak(cr, 0, 1.4, (t) => 32 + 18 * Math.sin(t * 2.2), (t) => gate(t, 0, 1.1, 0.4, 0.3), [[380, 0.03, 1], [720, 0.02, 0.6], [1300, 0.012, 0.3]], 1, 0.25);
    pan(st, pn(cr, 0.14), 6.8, 1, 0.6, true);
    const tw = buf(0.5);
    hit(tw, 0, 1, [[1800, 0.012, 1], [2900, 0.008, 0.7], [4300, 0.005, 0.5]], 0.0006, 8000);
    hit(tw, 0.035, 0.5, [[2100, 0.01, 1], [3300, 0.006, 0.5]], 0.0005, 8000);
    echo(tw, 0.06, 0.2, 0.3, 2000);
    pan(st, pn(tw, 0.22), 14.4, 1, -0.55, true);
    const owl = buf(1.4);
    for (const [t0, d, f] of [[0, 0.32, 385], [0.55, 0.55, 365]]) chirp(owl, t0, d, (t) => f * (1 - (0.04 * t) / d), (t) => gate(t, 0, d - 0.12, 0.05, 0.12));
    lp(owl, 900);
    pan(st, pn(owl, 0.1), 10.2, 1, 0.8, true);
    for (let t = 1.5; t < L; t += uni(3.5, 4.5)) insect(st, t, 3900, 36, uni(0.6, 0.9), 0.04, -0.3, true);
    return out(c, st, { loop: true });
  } },
  // shrine grounds by day: cicadas in the trees, leaves, a bulbul and sparrows
  shrine_day: { volume: 0.35, loop: true, bus: 'amb', render: (c) => {
    begin(607, 32000);
    const L = 16, n = len(L), W = len(1);
    const st = st0(n);
    pan(st, abura(n, 4500, W, (t) => 0.7 + 0.3 * sn(t / L + 0.2)), 0, 0.85, 0.5, true);
    pan(st, kuma(n, 7.5, W, (t) => 0.4 + 0.6 * Math.max(0, sn(t / L))), 0, 0.55, -0.45, true);
    minmin(st, 8.3, 0.4, -0.1, true, 5);
    const lv = white(n); bp(lv, 3000, 0.5, W);
    const g = smooth(n, 0.2, n);
    for (let i = 0; i < n; i++) lv[i] *= 0.3 + 0.7 * Math.max(0, sat(g[i]));
    addTo(st, spread(pn(lv, 0.25), 0.33));
    for (const t0 of [2.2, 2.9, 12.4]) { tweet(st, t0, 2600, 3700, 0.3, 0.18, 0.7, true); tweet(st, t0 + 0.32, 3500, 2300, 0.22, 0.15, 0.7, true); }
    for (const [t0, k] of [[5.3, 3], [6.1, 2], [10.2, 4]]) for (let j = 0; j < k; j++) tweet(st, t0 + j * 0.14, 5400, 3800, 0.06, 0.12, -0.6, true);
    return out(c, st, { loop: true });
  } },
  // two jungle crows calling to each other across the town
  crows: { volume: 0.36, loop: true, bus: 'amb', render: (c) => {
    begin(608, 22050);
    const L = 16, n = len(L), W = len(1);
    const st = st0(n);
    const caw = (t0: number, f: number, g: number, p: number): void => {
      const d = 0.34, o = buf(d + 0.05);
      voice(o, 0, d, (t) => f * (1.05 - (0.15 * t) / d) * (1 + 0.04 * Math.sin(TAU * 70 * t)), [(t) => 1250 - (450 * t) / d, (t) => 1700 - (200 * t) / d, () => 2700], (t) => gate(t, 0, d * 0.45, 0.02, d * 0.5) * (0.7 + 0.3 * Math.max(0, Math.sin(TAU * 75 * t))), 0.45);
      pan(st, pn(o, g), t0, 1, p, true);
    };
    for (const [t0, k, f, g, p] of [[1.0, 3, 520, 0.8, -0.4], [5.6, 2, 470, 0.45, 0.7], [9.1, 4, 530, 0.85, -0.35], [13.4, 2, 465, 0.4, 0.75]]) {
      for (let j = 0; j < k; j++) caw(t0 + j * uni(0.42, 0.52), f * uni(0.97, 1.03), g * uni(0.85, 1), p);
    }
    echo(st[0], 0.13, 0.25, 0.25, 2500, W);
    echo(st[1], 0.17, 0.25, 0.25, 2500, W);
    const air = white(n); lp1(air, 300, W);
    addTo(st, spread(pn(air, 0.05)));
    return out(c, st, { loop: true });
  } },
  // gusty wind with a faint howl
  wind: { volume: 0.35, loop: true, bus: 'amb', render: (c) => {
    begin(609, 22050);
    const L = 16, n = len(L), W = len(1);
    const g = smooth(n, 0.15, n);
    for (let i = 0; i < n; i++) g[i] = 0.5 + 0.5 * sat(1.3 * g[i]);
    const b = white(n); lp1(b, 380, W); lp1(b, 900, W);
    for (let i = 0; i < n; i++) b[i] *= 0.3 + 0.7 * g[i];
    const wh = white(n); svf(wh, (t) => 380 + 520 * g[Math.min(n - 1, Math.round(t * R))], 9, 'bp', W);
    for (let i = 0; i < n; i++) wh[i] *= g[i] * g[i];
    const st = spread(pn(b, 1), 0.37);
    addTo(st, spread(pn(wh, 0.35), 0.61));
    return out(c, st, { loop: true });
  } },
  // vending machine: buzzy 60 Hz-grid transformer hum, compressor, fan, PSU whine (6 s loop)
  vending_hum: { volume: 0.21, loop: true, bus: 'amb', render: (c) => {
    begin(610, 22050);
    const L = 6, n = len(L), W = len(0.5);
    const fan = white(n); bp(fan, 320, 0.7, W); lp(fan, 1200, 0.707, W); pn(fan, 0.3);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / R;
      a[i] = 0.4 * sat(2.2 * sn(120 * t)) + 0.18 * sn(240 * t) + 0.1 * sn(360 * t) + 0.05 * sn(480 * t) + 0.12 * sn(58.5 * t) + fan[i] * (0.85 + 0.15 * sn(25 * t)) + 0.015 * sn(1860 * t);
    }
    return out(c, [a], { loop: true });
  } },
  // old fluorescent tube on a magnetic ballast: 120 Hz buzz, arc hiss, two flicker ticks (6 s loop)
  fluorescent_buzz: { volume: 0.17, loop: true, bus: 'amb', render: (c) => {
    begin(611);
    const L = 6, n = len(L), W = len(0.3);
    const arc = white(n); bp(arc, 2400, 0.9, W);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / R, x = sn(60 * t), x2 = x * x, x4 = x2 * x2, x8 = x4 * x4;
      a[i] = 0.35 * sat(4 * sn(120 * t)) + 0.08 * sn(60 * t) + arc[i] * (0.15 + 1.6 * x8 * x4);
    }
    hp(a, 90, 0.707, W);
    for (const t0 of [1.73, 4.46]) { const tk = buf(0.08); hit(tk, 0, 1, [[3200, 0.004, 1], [5200, 0.003, 0.5]], 0.0004, 9000); mix(a, pn(tk, 0.5), t0, 1, true); }
    return out(c, [a], { loop: true });
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Shrine & town
// ═════════════════════════════════════════════════════════════════════════════
add({
  // honsuzu: the big shrine bells rattled by their rope (swings of clanks dying away)
  shrine_bell: { volume: 0.58, render: (c) => {
    begin(701);
    const n = len(3.0), a = new Float32Array(n), clicks = new Float32Array(n);
    const bells = [620, 790, 1040].map((f) => ({ f, e: new Float32Array(n) }));
    let t = 0.02;
    for (let s = 0; s < 7; s++) {
      const sw = Math.pow(0.8, s), k = Math.round(uni(3, 6) * sw + 1);
      for (let j = 0; j < k; j++) {
        const i = Math.round((t + uni(0, 0.06)) * R), g = sw * uni(0.4, 1);
        pick(bells).e[i] += g;
        burst(clicks, i / R, 0.0006, g);
      }
      t += uni(0.16, 0.2);
    }
    for (const b of bells) {
      const d = uni(0.99, 1.01);
      mix(a, ringBank(b.e, [[b.f * d, 0.5, 1], [b.f * 1.62 * d, 0.36, 0.7], [b.f * 2.31 * d, 0.26, 0.55], [b.f * 3.17 * d, 0.16, 0.4], [b.f * 4.45 * d, 0.1, 0.3]]));
    }
    hp(clicks, 2500); mix(a, clicks, 0, 0.5);
    const rb = white(len(1.3)); bp(rb, 2600, 1.5);
    shape(rb, (tt) => ad(tt, 0.02, 0.35) * (0.5 + 0.5 * Math.abs(Math.sin(TAU * 2.8 * tt))));
    mix(a, pn(rb, 0.05), 0.02);
    return out(c, [mono(verb(a, { t60: 1.2, scale: 0.8, wet: 0.2 }))]);
  } },
  // kashiwade: one sharp cupped clap, ringing off the hall and the trees
  clap: { volume: 1.0, render: (c) => {
    begin(702);
    const a = buf(1.4);
    const cl = buf(0.06); burst(cl, 0, 0.006, 1);
    const c2 = cl.slice(); bp(cl, 1100, 1.4); bp(c2, 2300, 1.2);
    for (let i = 0; i < cl.length; i++) cl[i] += 0.6 * c2[i];
    mix(a, pn(cl, 1), 0);
    ring(a, 0, 950, 0.007, 0.35);
    ring(a, 0, 320, 0.01, 0.2);
    const st = verb(a, { t60: 0.9, scale: 1.1, wet: 0.35, damp: 0.4 });
    echo(st[0], 0.11, 0.15, 0.22, 2500);
    echo(st[1], 0.137, 0.15, 0.22, 2500);
    return out(c, st);
  } },
  // offering coin: clinks on the grate, bounces, drops into the wooden box
  coin: { volume: 0.46, render: (c) => {
    begin(703);
    const a = buf(0.9);
    const cm = (f: number, k = 1): Mode3[] => [[f, 0.06 * k, 1], [f * 1.91, 0.04 * k, 0.7], [f * 2.53, 0.03 * k, 0.5], [f * 3.2, 0.02 * k, 0.3]];
    hit(a, 0, 0.9, cm(3600), 0.0005, 9000);
    hit(a, 0, 0.5, [[600, 0.02, 1], [1400, 0.012, 0.5]], 0.001, 3000);
    hit(a, 0.09, 0.45, cm(3580), 0.0004, 9000);
    hit(a, 0.14, 0.3, [[650, 0.015, 1]], 0.001, 3000);
    hit(a, 0.15, 0.25, cm(3620), 0.0004, 9000);
    const th = buf(0.1); burst(th, 0, 0.012, 1); lp(th, 800); mix(a, pn(th, 0.45), 0.32);
    hit(a, 0.32, 0.4, [[280, 0.04, 1], [520, 0.03, 0.6]], 0, 0);
    hit(a, 0.325, 0.2, cm(3500, 0.4), 0, 0);
    return out(c, [mono(verb(a, { t60: 0.4, scale: 0.4, wet: 0.12 }))]);
  } },
  // temizu: scoop with the ladle, pour over the hands onto the stones, last drips, ladle set down
  water_ladle: { volume: 0.4, render: (c) => {
    begin(704);
    const a = buf(2.5);
    const sp = white(len(0.2)); lp(sp, 3000); shape(sp, (t) => ad(t, 0.005, 0.05)); mix(a, pn(sp, 0.35), 0);
    for (let k = 0; k < 8; k++) bubble(a, uni(0, 0.15), uni(400, 1200), uni(0.008, 0.02), uni(0.1, 0.3));
    const sm = white(len(1.3)), s2 = sm.slice(); bp(sm, 1800, 0.7); lp(s2, 4500);
    const m = smooth(sm.length, 18);
    for (let i = 0; i < sm.length; i++) sm[i] = (sm[i] + 0.5 * s2[i]) * (0.6 + 0.4 * Math.min(2, Math.abs(m[i]))) * gate(i / R, 0, 1.05, 0.12, 0.2);
    mix(a, pn(sm, 0.6), 0.35);
    for (let k = 0; k < 30; k++) bubble(a, uni(0.4, 1.55), uni(600, 2200), uni(0.004, 0.012), uni(0.05, 0.2), 3);
    for (const t of [1.75, 1.95, 2.1]) bubble(a, t, uni(900, 1400), 0.015, 0.25);
    hit(a, 2.25, 0.5, [[700, 0.02, 1], [1600, 0.012, 0.5]], 0.001, 3000);
    return out(c, [mono(verb(a, { t60: 0.6, scale: 0.6, wet: 0.15 }))]);
  } },
  // automatic-door entry chime: a generic rising three-note electronic "ding" (no store's real jingle)
  conbini_chime: { volume: 0.33, render: (c) => {
    begin(705);
    const a = buf(1.8);
    for (const [t0, f] of [[0, 880], [0.13, 1108.73], [0.26, 1318.51]]) hit(a, t0, 1, [[f, 0.6, 1], [f * 2, 0.2, 0.18], [f * 3, 0.08, 0.06]], 0, 0);
    hp(a, 350); lp(a, 4500); pk(a, 1200, 1.2, 3);
    return out(c, [mono(verb(a, { t60: 0.6, scale: 0.6, wet: 0.18 }))]);
  } },
  // vending machine: whirr, the can tumbling down the chute, the big "ga-kon", settling
  vending: { volume: 0.95, render: (c) => {
    begin(706);
    const a = buf(1.1);
    for (let i = 0; i < len(0.3); i++) { const t = i / R; a[i] += sat(2 * sn(180 * t)) * gate(t, 0, 0.22, 0.03, 0.06) * 0.15; }
    const ru = white(len(0.3)); bp(ru, 1500, 1.2);
    const m = smooth(ru.length, 40);
    for (let i = 0; i < ru.length; i++) ru[i] *= Math.abs(m[i]) * gate(i / R, 0, 0.22, 0.05, 0.06);
    mix(a, pn(ru, 0.3), 0.05);
    hit(a, 0.12, 0.25, [[1100, 0.04, 1], [2650, 0.03, 0.6]], 0.0005, 6000);
    hit(a, 0.22, 0.3, [[1150, 0.04, 1], [2700, 0.03, 0.6]], 0.0005, 6000);
    const th = buf(0.2); burst(th, 0, 0.04, 1); lp(th, 900); mix(a, pn(th, 1), 0.35);
    hit(a, 0.35, 1, [[110, 0.12, 1], [230, 0.09, 0.7], [520, 0.06, 0.5], [900, 0.05, 0.35], [1700, 0.04, 0.25], [2900, 0.03, 0.15]], 0, 0);
    hit(a, 0.352, 0.4, [[1100, 0.05, 1], [2650, 0.035, 0.6], [4200, 0.02, 0.4]], 0.0005, 7000);
    hit(a, 0.5, 0.25, [[240, 0.04, 1], [1150, 0.03, 0.5]], 0.001, 3000);
    hit(a, 0.58, 0.15, [[250, 0.03, 1], [1200, 0.02, 0.5]], 0.001, 3000);
    return out(c, [mono(verb(a, { t60: 0.35, scale: 0.4, wet: 0.12 }))]);
  } },
  // a cat somewhere down the street: "nya-ooo", then a shorter one
  cat: { volume: 0.3, render: (c) => {
    begin(707);
    const a = buf(2.8);
    const meow = (t0: number, d: number, fA: number, fB: number, g: number): void => voice(a, t0, d,
      (t) => { const x = t / d; return x < 0.3 ? fA + ((fB - fA) * x) / 0.3 : fB - ((fB - fA * 0.85) * (x - 0.3)) / 0.7; },
      [(t) => { const x = t / d; return x < 0.25 ? 450 + (650 * x) / 0.25 : 1100 - (450 * (x - 0.25)) / 0.75; }, (t) => 1700 - (600 * t) / d, () => 3000],
      (t) => gate(t, 0, d * 0.7, 0.06, d * 0.28), 0.3, g);
    meow(0, 0.85, 520, 760, 1);
    meow(1.45, 0.5, 560, 700, 0.6);
    lp(a, 3200);
    return out(c, [mono(verb(a, { t60: 1.2, scale: 1, wet: 0.35 }))]);
  } },
  // a car passing close: tyre roar brightening at the closest point, Doppler-shifted engine, pan L→R
  car_pass: { volume: 0.76, render: (c) => {
    begin(708);
    const D = 6.5, n = len(D), tc = 3.2, dist = 3.5, v = 12, cs = 343;
    const near = (t: number): number => dist / Math.hypot(v * (t - tc), dist);
    const tire = white(n); svf(tire, (t) => 500 + 2600 * Math.pow(near(t), 1.5), 0.6, 'lp');
    const st = st0(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / R, x = v * (t - tc), rr = Math.hypot(x, dist), dop = cs / (cs + (v * x) / rr);
      ph += (36 * dop) / R;
      const eng = sat(1.6 * sn(ph)) + 0.5 * sn(2 * ph + 0.1) + 0.3 * sn(3 * ph);
      const s = (tire[i] * 0.9 + eng * 0.22) * Math.pow(dist / rr, 1.15) * rel(t, D, 0.4) * Math.min(1, t / 0.4);
      const th = ((clamp(x / 14, -1, 1) + 1) * Math.PI) / 4;
      st[0][i] = s * Math.cos(th);
      st[1][i] = s * Math.sin(th);
    }
    const wh = white(len(0.9)); hp(wh, 900); shape(wh, (t) => Math.exp(-(((t - 0.45) / 0.18) ** 2)));
    pan(st, pn(wh, 0.25), tc - 0.45, 1, (t) => -0.4 + 0.9 * t);
    return out(c, st);
  } },
});

// ═════════════════════════════════════════════════════════════════════════════
// Extras for chapter scripts (not required by the engine)
// ═════════════════════════════════════════════════════════════════════════════
/** Higurashi "kana-kana-kana…": a run of quick falling chirps that swells and fades */
function kanakana(dst: Stereo, at: number, f0: number, g: number, p: number, wrap: boolean): void {
  const notes = 26, dur = 3.2, o = new Float32Array(len(dur + 0.3));
  for (let k = 0; k < notes; k++) {
    const x = k / (notes - 1), env = Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.15)), 0.7), f = f0 * (1 - 0.06 * x);
    const m = len(0.075), i0 = Math.round(((k / notes) * dur) * R);
    let ph = 0;
    for (let j = 0; j < m; j++) { const u = j / m; ph += (f * (1.12 - 0.15 * u)) / R; o[i0 + j] += sn(ph) * Math.pow(Math.sin(Math.PI * u), 2) * env * (0.7 + 0.3 * sn((260 * j) / R)); }
  }
  pan(dst, o, at, g, p, wrap);
}
add({
  // someone outside trying the front-door handle: ga-chan… ga-cha-gacha… gacha
  door_knob: { volume: 0.45, render: (c) => {
    begin(801);
    const a = buf(2.4);
    const jiggle = (t0: number, g: number): void => {
      hit(a, t0, g, metal(1350, 0.05, 5), 0.0008, 6000);
      hit(a, t0 + 0.04, g * 0.9, [[1700, 0.04, 1], [2800, 0.03, 0.6], [4100, 0.02, 0.4]], 0.0008, 6000);
      hit(a, t0 + 0.045, g * 0.6, [[110, 0.07, 1], [240, 0.05, 0.6], [470, 0.04, 0.4]], 0.003, 1200);
      hit(a, t0 + 0.12, g * 0.5, [[1550, 0.03, 1], [2600, 0.02, 0.5]], 0.0006, 6000);
    };
    jiggle(0, 0.8); jiggle(0.55, 1); jiggle(0.74, 0.9); jiggle(1.5, 0.7);
    for (let i = 0; i < a.length; i++) a[i] = sat(1.8 * a[i]);
    return out(c, [mono(verb(a, { t60: 0.6, scale: 0.6, wet: 0.18 }))]);
  } },
  // a heavy, dull thump (something falling, a body against the wall / ceiling)
  thud: { volume: 0.9, render: (c) => {
    begin(802);
    const a = buf(1.2);
    chirp(a, 0, 1, (t) => 48 + 30 * Math.exp(-t / 0.05), (t) => ad(t, 0.004, 0.18), 1);
    const th = buf(0.3); burst(th, 0, 0.03, 1); lp(th, 500); mix(a, pn(th, 0.8), 0);
    hit(a, 0, 0.6, [[180, 0.08, 1], [330, 0.06, 0.6], [610, 0.04, 0.35], [1100, 0.02, 0.2]], 0, 0);
    for (let i = 0; i < a.length; i++) a[i] = sat(1.6 * a[i]);
    return out(c, [mono(verb(a, { t60: 0.7, scale: 0.7, wet: 0.2 }))]);
  } },
  // knuckles tapping on the balcony window glass, three times
  window_tap: { volume: 0.6, render: (c) => {
    begin(803);
    const a = buf(1.3);
    for (const [t0, g] of [[0, 0.8], [0.23, 1], [0.5, 0.7]]) {
      hit(a, t0, g, [[1850, 0.025, 1], [3250, 0.018, 0.6], [4900, 0.01, 0.35], [520, 0.03, 0.3]], 0.0007, 7000);
      hit(a, t0 + 0.004, g * 0.2, [[2600, 0.012, 1]], 0, 0);
    }
    return out(c, [mono(verb(a, { t60: 0.5, scale: 0.5, wet: 0.15 }))]);
  } },
  // summer evening: higurashi calling from the woods, echoing (16 s loop)
  higurashi: { volume: 0.4, loop: true, bus: 'amb', render: (c) => {
    begin(804, 32000);
    const L = 16, n = len(L), W = len(1);
    const air = white(n); lp1(air, 300, W); lp1(air, 600, W);
    const st = spread(pn(air, 0.12));
    kanakana(st, 0.5, 4300, 0.6, -0.5, true);
    kanakana(st, 5.2, 4550, 0.4, 0.6, true);
    kanakana(st, 10.4, 4150, 0.5, 0.1, true);
    kanakana(st, 13.5, 4400, 0.25, -0.8, true);
    echo(st[0], 0.23, 0.35, 0.3, 3000, W);
    echo(st[1], 0.29, 0.35, 0.3, 3000, W);
    return out(c, st, { loop: true });
  } },
});
