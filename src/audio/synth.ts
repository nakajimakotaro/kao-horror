// Tiny offline synthesis toolkit: every sound in the game is generated from
// math into an AudioBuffer once, then cached. Deterministic (seeded noise).

export const SR = 44100;

let s = 1234567;
export function seed(v: number): void { s = v >>> 0 || 1; }
export function rand(): number {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return ((s >>> 0) / 4294967296) * 2 - 1;
}

export type Gen = (t: number, i: number) => number;

/** Render a mono (or stereo with `gen2`) buffer from sample generators. */
export function render(ctx: BaseAudioContext, sec: number, gen: Gen, gen2?: Gen): AudioBuffer {
  const n = Math.max(1, Math.floor(sec * SR));
  const b = ctx.createBuffer(gen2 ? 2 : 1, n, SR);
  const l = b.getChannelData(0);
  for (let i = 0; i < n; i++) l[i] = gen(i / SR, i);
  if (gen2) {
    const r = b.getChannelData(1);
    for (let i = 0; i < n; i++) r[i] = gen2(i / SR, i);
  }
  normalize(b, 0.95);
  return b;
}

export function normalize(b: AudioBuffer, peak: number): void {
  let m = 0;
  for (let c = 0; c < b.numberOfChannels; c++) for (const v of b.getChannelData(c)) m = Math.max(m, Math.abs(v));
  if (m < 1e-6) return;
  const k = peak / m;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

/** Crossfade the tail into the head so the buffer loops seamlessly. */
export function makeLoop(b: AudioBuffer, fadeSec = 0.5): AudioBuffer {
  const f = Math.floor(fadeSec * SR);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    const n = d.length;
    for (let i = 0; i < f; i++) {
      const k = i / f;
      d[i] = d[i] * k + d[n - f + i] * (1 - k);
    }
  }
  const out = new AudioBuffer({ length: b.length - f, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
  for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c).subarray(0, b.length - f), c);
  return out;
}

export const env = (t: number, a: number, d: number): number => (t < a ? t / a : Math.exp(-(t - a) / d));
export const sine = (f: number, t: number): number => Math.sin(2 * Math.PI * f * t);

/** One-pole low-pass state holder. */
export function lowpass(cut: number): (x: number) => number {
  const a = Math.exp((-2 * Math.PI * cut) / SR);
  let y = 0;
  return (x) => (y = (1 - a) * x + a * y);
}
export function highpass(cut: number): (x: number) => number {
  const lp = lowpass(cut);
  return (x) => x - lp(x);
}

/** RBJ biquad band-pass (constant peak). */
export function bandpass(freq: number, q: number): (x: number) => number {
  const w = (2 * Math.PI * freq) / SR, al = Math.sin(w) / (2 * q), cw = Math.cos(w);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}
