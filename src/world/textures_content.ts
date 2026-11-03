import type { TexSpec } from './textures';
import { JP_FONT, JP_SERIF, rnd, srand, stains } from './textures';

// Story textures: posters, signs, notes, plates (docs/SCENARIO.md §3 and §7-C).
// Every canvas has the aspect of the surface it is mapped on (noted per entry).
// Priority at the game's 360p: what kind of paper or sign it is and its key
// words (headline, name, date) must read; body text only has to look like rows
// of print or handwriting — the full text is shown by the document UI.

/**
 * Surfaces of the GLB models (tex_* / emit_* materials) carry glTF UVs, whose v
 * runs top → bottom, while TextureLib uploads canvases with three's default
 * flipY = true and World.prepareMaterials does not compensate. A canvas drawn
 * upright therefore shows upside down on a model (verified in game on the
 * calendar). The specs built with onModel() are drawn mirrored vertically to
 * cancel that. Set this to false once the engine uploads model maps with
 * flipY = false (or flips the UVs) — nothing else needs to change here.
 */
export const MODEL_FLIP_Y: boolean = true;

type G = CanvasRenderingContext2D;
type Draw = (g: G, w: number, h: number) => void;
type RGB = readonly [number, number, number];

const TAU = Math.PI * 2;
/** Rounded gothic for handwriting (falls back to the plain gothic). */
const MARU = `"Hiragino Maru Gothic ProN","Hiragino Maru Gothic Pro","Kosugi Maru","M PLUS Rounded 1c","Zen Maru Gothic",${JP_FONT}`;
/** ツキミマート brand colours (original: violet and moon yellow). */
const VIOLET = '#4a2f78';
const MOON = '#f2c84b';
/** Felt of the town bulletin board (bulletin_board.glb, bb_felt). */
const FELT = '#24442f';

// ── spec builders ────────────────────────────────────────────────────────────

/** Texture for a three.js plane (posters, memos): drawn upright. */
function sheet(w: number, h: number, draw: Draw): TexSpec {
  return {
    w, h, clamp: true, nearest: false,
    draw: (g, cw, ch) => {
      g.save();
      draw(g, cw, ch);
      g.restore();
    },
  };
}

/** Texture for a GLB model surface (see MODEL_FLIP_Y). */
function onModel(w: number, h: number, draw: Draw): TexSpec {
  return {
    w, h, clamp: true, nearest: false,
    draw: (g, cw, ch) => {
      if (!MODEL_FLIP_Y) {
        g.save();
        draw(g, cw, ch);
        g.restore();
        return;
      }
      const cv = offscreen(cw, ch);
      draw(cv.getContext('2d')!, cw, ch);
      g.save();
      g.setTransform(1, 0, 0, -1, 0, ch);
      g.drawImage(cv, 0, 0);
      g.restore();
    },
  };
}

function offscreen(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

// ── small utilities ──────────────────────────────────────────────────────────

/** Local deterministic PRNG (mulberry32), independent of the shared rnd(). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function disc(g: G, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, Math.max(0.1, r), 0, TAU);
  g.fill();
}
function oval(g: G, x: number, y: number, rx: number, ry: number, color: string, rot = 0): void {
  g.fillStyle = color;
  g.beginPath();
  g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU);
  g.fill();
}
function poly(g: G, pts: number[], color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fill();
}
function rrect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Per-pixel luminance grain (paper fibre, print noise). */
function grain(g: G, w: number, h: number, amount: number, seed: number): void {
  const R = prng(seed);
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(im, 0, 0);
}

/** Draws into a separate layer, then knocks random holes in its alpha (crayon wax, dry brush, worn ink). */
function speckled(w: number, h: number, seed: number, grit: number, draw: (c: G) => void): HTMLCanvasElement {
  const cv = offscreen(w, h);
  const c = cv.getContext('2d')!;
  draw(c);
  const im = c.getImageData(0, 0, w, h);
  const d = im.data;
  const R = prng(seed);
  for (let i = 3; i < d.length; i += 4) {
    if (!d[i]) continue;
    const r = R();
    if (r < grit * 0.45) d[i] *= 0.12;
    else if (r < grit) d[i] *= 0.6;
  }
  c.putImageData(im, 0, 0);
  return cv;
}

// ── paper and wear ───────────────────────────────────────────────────────────

/** Base sheet: colour, a few broad blotches, darkened/yellowed edges. */
function paper(g: G, w: number, h: number, base: string, seed: number, edge?: RGB, edgeA = 0.2): void {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  srand(seed);
  stains(g, w, h, 3 + Math.round((w * h) / 14000), 'rgba(120,100,60,0.05)', Math.max(w, h) * 0.3);
  if (edge) edgeShade(g, w, h, edge, edgeA, Math.min(w, h) * 0.12);
}

function edgeShade(g: G, w: number, h: number, c: RGB, a: number, d: number): void {
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, d, 0, 0, w, d],
    [0, h, 0, h - d, 0, h - d, w, d],
    [0, 0, d, 0, 0, 0, d, h],
    [w, 0, w - d, 0, w - d, 0, d, h],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, rgba(c, a));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(rx, ry, rw, rh);
  }
}

/** Sun yellowing, strongest at the top of a sheet that hung outdoors. */
function sunFade(g: G, w: number, h: number, a: number): void {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, `rgba(222,196,128,${a})`);
  gr.addColorStop(1, `rgba(222,196,128,${a * 0.2})`);
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

/** Washed-out print: lifts everything toward the paper colour. */
function wash(g: G, w: number, h: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
}

/** Dried rain drop: an irregular tide line with a faint fill. */
function tide(g: G, cx: number, cy: number, r: number, seed: number, a = 0.26): void {
  const R = prng(seed);
  const n = 14;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * TAU;
    const rr = r * (0.72 + R() * 0.42);
    pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.82]);
  }
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n];
    const q = pts[(i + 1) % n];
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    if (i === 0) g.moveTo(mx, my);
    else g.quadraticCurveTo(p[0], p[1], mx, my);
  }
  g.closePath();
  g.fillStyle = `rgba(150,120,64,${a * 0.28})`;
  g.fill();
  g.strokeStyle = `rgba(118,88,40,${a})`;
  g.lineWidth = 1.1;
  g.stroke();
}

/** Rain run-off streaks from the top edge. */
function streaks(g: G, w: number, h: number, n: number, seed: number, a = 0.1): void {
  const R = prng(seed);
  const c: RGB = [122, 98, 52];
  for (let i = 0; i < n; i++) {
    const x = R() * w;
    const y0 = R() * h * 0.25;
    const len = h * (0.2 + R() * 0.55);
    const gr = g.createLinearGradient(0, y0, 0, y0 + len);
    gr.addColorStop(0, rgba(c, 0));
    gr.addColorStop(0.25, rgba(c, a));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(x, y0, 1 + R() * 2.2, len);
  }
}

/** Push pin seen from the front (head with a highlight and a drop shadow). */
function pushpin(g: G, x: number, y: number, r: number, light: string, mid: string, dark: string): void {
  disc(g, x + r * 0.45, y + r * 0.65, r * 1.05, 'rgba(0,0,0,0.32)');
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  gr.addColorStop(0, light);
  gr.addColorStop(0.55, mid);
  gr.addColorStop(1, dark);
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
  disc(g, x - r * 0.35, y - r * 0.38, r * 0.22, 'rgba(255,255,255,0.75)');
}
const redPin = (g: G, x: number, y: number, r = 4.2) => pushpin(g, x, y, r, '#f07a6a', '#c0302a', '#6c1410');
const bluePin = (g: G, x: number, y: number, r = 4.2) => pushpin(g, x, y, r, '#7d9ae6', '#2a52b0', '#142a66');

/** Strip of tape (masking or clear) across a corner. */
function tape(g: G, x: number, y: number, w: number, h: number, ang: number, fill: string, edge: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.fillRect(-w / 2, -h / 2, w, h);
  g.fillStyle = edge;
  g.fillRect(-w / 2, -h / 2, w, 0.8);
  g.fillRect(-w / 2, h / 2 - 0.8, w, 0.8);
  g.restore();
}

/** Dog-eared bottom-right corner: the felt behind shows, the flap folds over the front. */
function dogEar(g: G, w: number, h: number, s: number, back: string): void {
  poly(g, [w, h - s, w, h, w - s, h], FELT);
  const gr = g.createLinearGradient(w - s * 0.5, h - s * 0.5, w - s, h - s);
  gr.addColorStop(0, 'rgba(0,0,0,0.28)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(w, h - s);
  g.lineTo(w - s, h);
  g.lineTo(w - s * 1.25, h - s * 0.2);
  g.lineTo(w - s * 0.2, h - s * 1.25);
  g.closePath();
  g.fill();
  poly(g, [w, h - s, w - s, h, w - s * 0.88, h - s * 0.88], back);
  g.strokeStyle = 'rgba(80,70,50,0.35)';
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(w, h - s);
  g.lineTo(w - s, h);
  g.stroke();
}

// ── wood ─────────────────────────────────────────────────────────────────────

interface WoodOpts { vertical?: boolean; grain?: number; planks?: number }

/** Plank wood with wavy grain, tone bands and optional joints. */
function wood(g: G, x: number, y: number, w: number, h: number, base: RGB, seed: number, o: WoodOpts = {}): void {
  const R = prng(seed);
  const vert = !!o.vertical;
  const along = vert ? h : w;
  const across = vert ? w : h;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = rgba(base, 1);
  g.fillRect(x, y, w, h);
  for (let i = 0; i < across / 9; i++) {
    const p = R() * across;
    const bw = 3 + R() * 16;
    g.fillStyle = R() < 0.5 ? `rgba(255,238,205,${0.04 + R() * 0.07})` : `rgba(64,38,16,${0.04 + R() * 0.07})`;
    if (vert) g.fillRect(x + p, y, bw, h);
    else g.fillRect(x, y + p, w, bw);
  }
  const n = Math.round(across / 2.4);
  for (let i = 0; i < n; i++) {
    const p = R() * across;
    const amp = 0.5 + R() * 2.2;
    const fq = ((1.5 + R() * 4) * TAU) / along;
    const ph = R() * TAU;
    g.strokeStyle = `rgba(72,42,18,${(0.05 + R() * 0.12) * (o.grain ?? 1)})`;
    g.lineWidth = 0.5 + R() * 1.1;
    g.beginPath();
    for (let s = 0; s <= along + 4; s += 4) {
      const d = p + Math.sin(s * fq + ph) * amp + Math.sin(s * fq * 2.7 + ph * 1.3) * amp * 0.35;
      const px = vert ? x + d : x + s;
      const py = vert ? y + s : y + d;
      if (s === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }
  const planks = o.planks ?? 1;
  for (let k = 1; k < planks; k++) {
    const p = (across * k) / planks + (R() - 0.5) * 3;
    g.fillStyle = 'rgba(38,22,10,0.5)';
    if (vert) g.fillRect(x + p - 0.7, y, 1.4, h);
    else g.fillRect(x, y + p - 0.7, w, 1.4);
    g.fillStyle = 'rgba(255,240,210,0.16)';
    if (vert) g.fillRect(x + p + 0.7, y, 1, h);
    else g.fillRect(x, y + p + 0.7, w, 1);
  }
  g.restore();
}

// ── text ─────────────────────────────────────────────────────────────────────

function setFont(g: G, px: number, family: string = JP_FONT, weight = ''): void {
  g.font = `${weight ? weight + ' ' : ''}${Math.round(px * 10) / 10}px ${family}`;
}

/** Sets the largest font size ≤ max at which `text` fits in maxW; returns it. */
function fitFont(g: G, text: string, maxW: number, max: number, family: string = JP_FONT, weight = '', min = 5): number {
  for (let s = max; s > min; s -= 0.5) {
    setFont(g, s, family, weight);
    if (g.measureText(text).width <= maxW) return s;
  }
  setFont(g, min, family, weight);
  return min;
}

/** One centred line, shrunk to fit maxW. */
function center(g: G, text: string, cx: number, y: number, maxW: number, size: number, color: string, family: string = JP_FONT, weight = ''): void {
  fitFont(g, text, maxW, size, family, weight);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(text, cx, y);
}

/** Characters spread evenly from x0 to x1 (headlines, sign lettering); uses the current font. */
function spread(g: G, text: string, x0: number, x1: number, y: number, stroke = false): void {
  const chars = [...text];
  const ws = chars.map((c) => g.measureText(c).width);
  const total = ws.reduce((a, b) => a + b, 0);
  const gap = chars.length > 1 ? (x1 - x0 - total) / (chars.length - 1) : 0;
  let x = chars.length > 1 ? x0 : (x0 + x1 - total) / 2;
  g.textAlign = 'left';
  chars.forEach((c, i) => {
    if (stroke) g.strokeText(c, x, y);
    g.fillText(c, x, y);
    x += ws[i] + gap;
  });
}

const NO_LINE_START = '、。，．）」』！？ー…っゃゅょァィゥェォッャュョ';

/** Wraps per character (closing punctuation hangs instead of starting a line); returns the next baseline. */
function wrap(g: G, text: string, x: number, y: number, maxW: number, lh: number, align: CanvasTextAlign = 'left'): number {
  g.textAlign = align;
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && g.measureText(line + ch).width > maxW && !NO_LINE_START.includes(ch)) {
        g.fillText(line, x, y);
        y += lh;
        line = ch;
      } else line += ch;
    }
    g.fillText(line, x, y);
    y += lh;
  }
  return y;
}

/** Left-aligned lines sharing one font size that fits the widest line. */
function block(g: G, lines: string[], x: number, y: number, lh: number, maxW: number, size: number, color: string, family: string = JP_FONT, weight = ''): number {
  let s = size;
  for (const l of lines) {
    s = Math.min(s, fitFont(g, l, maxW, size, family, weight));
  }
  setFont(g, s, family, weight);
  g.fillStyle = color;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  for (const l of lines) {
    g.fillText(l, x, y);
    y += lh;
  }
  return y;
}

interface Hand {
  size: number;
  color: string;
  seed: number;
  font?: string;
  weight?: string;
  /** shear: > 0 leans the letters to the right */
  slant?: number;
  /** baseline jitter, fraction of size */
  wobble?: number;
  /** per-letter rotation range (rad) */
  tilt?: number;
  /** size variation, fraction */
  vary?: number;
  /** advance factor */
  track?: number;
  /** baseline climb per unit of advance (> 0 rises to the right) */
  rise?: number;
  /** random horizontal squash/stretch per letter, fraction */
  squash?: number;
  /** advance of a full-width space, fraction of size */
  space?: number;
  alpha?: number;
  /** the little curl at the end of め (透's handwriting, D01/D02/D06/D14) */
  curlMe?: boolean;
  /** measure only */
  dry?: boolean;
}

/** Handwritten line: letters drawn one by one with jitter. Returns the end x. */
function hand(g: G, text: string, x: number, y: number, o: Hand): number {
  const R = prng(o.seed);
  let cx = x;
  let cy = y;
  for (const ch of text) {
    if (ch === ' ' || ch === '　') {
      cx += o.size * (ch === ' ' ? 0.3 : o.space ?? 0.55);
      continue;
    }
    const s = o.size * (1 + (R() - 0.5) * (o.vary ?? 0.14));
    setFont(g, s, o.font ?? MARU, o.weight ?? '');
    const sx = 1 + (R() - 0.5) * (o.squash ?? 0);
    const adv = g.measureText(ch).width * sx;
    const dy = (R() - 0.5) * (o.wobble ?? 0.1) * o.size;
    const rot = (R() - 0.5) * (o.tilt ?? 0.14);
    if (!o.dry) {
      g.save();
      g.translate(cx + adv / 2, cy + dy);
      g.rotate(rot);
      if (o.slant) g.transform(1, 0, -o.slant, 1, 0, 0);
      if (sx !== 1) g.scale(sx, 1);
      g.globalAlpha = o.alpha ?? 1;
      g.fillStyle = o.color;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.fillText(ch, 0, 0);
      if (o.curlMe && ch === 'め') {
        // the tail of め ends near the bottom centre; it curls into a small loop there
        g.strokeStyle = o.color;
        g.lineWidth = Math.max(0.7, s * 0.07);
        g.beginPath();
        g.arc(-s * 0.01, s * 0.03, s * 0.05, -Math.PI / 2, -Math.PI / 2 - TAU * 0.82, true);
        g.stroke();
      }
      g.restore();
    }
    const step = adv * (o.track ?? 0.96) + (R() - 0.5) * s * 0.06;
    cx += step;
    cy -= (o.rise ?? 0) * step;
  }
  return cx;
}

/** Handwritten line scaled down (never up) so it fits in maxW. */
function handFit(g: G, text: string, x: number, y: number, maxW: number, o: Hand): number {
  const wdt = hand(g, text, 0, 0, { ...o, dry: true });
  const k = wdt > maxW ? maxW / wdt : 1;
  return hand(g, text, x, y, { ...o, size: o.size * k });
}

const V_ROTATE = 'ー〜…「」『』（）―';
const V_SMALL = 'ぁぃぅぇぉっゃゅょァィゥェォッャュョ';

/** One character of vertical text centred on (x, y); needs textAlign center / baseline middle. */
function vchar(g: G, ch: string, x: number, y: number, s: number): void {
  if (ch === '、' || ch === '。') g.fillText(ch, x + s * 0.6, y - s * 0.6);
  else if (V_ROTATE.includes(ch)) {
    g.save();
    g.translate(x, y);
    g.rotate(Math.PI / 2);
    g.fillText(ch, 0, 0);
    g.restore();
  } else if (V_SMALL.includes(ch)) g.fillText(ch, x + s * 0.1, y - s * 0.1);
  else g.fillText(ch, x, y);
}

/**
 * Vertical text (縦書き): paragraphs flow in columns from `right` leftwards,
 * each paragraph starting a new column; closing punctuation may hang below
 * `bottom`. Returns the left edge of the last column. draw=false only measures.
 */
function vflow(g: G, paras: string[], right: number, top: number, bottom: number, s: number, pitch: number, draw = true): number {
  let x = right - pitch / 2;
  if (draw) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }
  for (const p of paras) {
    let y = top + s / 2;
    for (const ch of p) {
      if (y + s / 2 > bottom + 0.01 && !'、。」）'.includes(ch)) {
        x -= pitch;
        y = top + s / 2;
      }
      if (draw) vchar(g, ch, x, y, s);
      y += s;
    }
    x -= pitch;
  }
  return x + pitch / 2;
}

// ── shared pictures ──────────────────────────────────────────────────────────

function sunflower(g: G, x: number, y: number, r: number, R: () => number): void {
  if (r < 2.4) {
    disc(g, x, y, r, '#e8b622');
    disc(g, x, y, r * 0.42, '#5a3712');
    return;
  }
  g.fillStyle = '#efbd22';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + R() * 0.3;
    g.beginPath();
    g.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.42, r * 0.17, a, 0, TAU);
    g.fill();
  }
  disc(g, x, y, r * 0.45, '#5b3813');
  disc(g, x - r * 0.1, y - r * 0.1, r * 0.24, '#7a4c1c');
}

/** しずく in the sunflower field (D07's photo), looking at the camera and smiling. */
function sunflowerPhoto(g: G, x: number, y: number, w: number, h: number, seed: number): void {
  const R = prng(seed);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const sky = g.createLinearGradient(0, y, 0, y + h * 0.5);
  sky.addColorStop(0, '#6ea5d6');
  sky.addColorStop(1, '#d2e7f1');
  g.fillStyle = sky;
  g.fillRect(x, y, w, h);
  for (let i = 0; i < 7; i++) {
    disc(g, x + w * (0.68 + R() * 0.3), y + h * (0.08 + R() * 0.16), h * (0.04 + R() * 0.06), 'rgba(255,255,255,0.85)');
  }
  g.fillStyle = '#3f5f34';
  g.beginPath();
  g.moveTo(x, y + h * 0.5);
  for (let i = 0; i <= 24; i++) g.lineTo(x + (w * i) / 24, y + h * (0.35 + R() * 0.08));
  g.lineTo(x + w, y + h * 0.5);
  g.closePath();
  g.fill();
  const fld = g.createLinearGradient(0, y + h * 0.44, 0, y + h);
  fld.addColorStop(0, '#5f812f');
  fld.addColorStop(1, '#36551f');
  g.fillStyle = fld;
  g.fillRect(x, y + h * 0.44, w, h * 0.56);
  const row = (fy: number, r: number, gap: number) => {
    for (let fx = x - R() * gap; fx < x + w + gap; fx += gap * (0.75 + R() * 0.5)) sunflower(g, fx, fy + (R() - 0.5) * r, r, R);
  };
  row(y + h * 0.47, h * 0.017, h * 0.045);
  row(y + h * 0.52, h * 0.025, h * 0.065);
  row(y + h * 0.59, h * 0.035, h * 0.09);
  girl(g, x + w * 0.5, y + h * 0.36, h * 0.118, y + h);
  // front rows: leaves, then big flowers over her waist
  for (let i = 0; i < 14; i++) {
    oval(g, x + R() * w, y + h * (0.8 + R() * 0.2), h * 0.07, h * 0.03, R() < 0.5 ? '#3f6b28' : '#4f7f2f', R() * 3);
  }
  row(y + h * 0.78, h * 0.06, h * 0.15);
  row(y + h * 0.96, h * 0.085, h * 0.2);
  g.fillStyle = 'rgba(255,236,200,0.10)';
  g.fillRect(x, y, w, h);
  g.restore();
}

/** Black short bob, grey hoodie, sunflower hair pin on her left (viewer's right) fringe. */
function girl(g: G, cx: number, cy: number, hr: number, bottom: number): void {
  // hood behind the neck and the hoodie body
  oval(g, cx, cy + hr * 1.45, hr * 1.25, hr * 0.6, '#6c6f74');
  g.fillStyle = '#878a90';
  g.beginPath();
  g.moveTo(cx - hr * 0.5, cy + hr * 1.2);
  g.quadraticCurveTo(cx - hr * 1.9, cy + hr * 1.35, cx - hr * 2.1, cy + hr * 2.4);
  g.lineTo(cx - hr * 2.3, bottom);
  g.lineTo(cx + hr * 2.3, bottom);
  g.lineTo(cx + hr * 2.1, cy + hr * 2.4);
  g.quadraticCurveTo(cx + hr * 1.9, cy + hr * 1.35, cx + hr * 0.5, cy + hr * 1.2);
  g.closePath();
  g.fill();
  g.fillStyle = '#e9c3a6';
  g.fillRect(cx - hr * 0.28, cy + hr * 0.7, hr * 0.56, hr * 0.62);
  g.strokeStyle = '#5b5e63';
  g.lineWidth = Math.max(1, hr * 0.13);
  g.beginPath();
  g.moveTo(cx - hr * 0.72, cy + hr * 1.15);
  g.quadraticCurveTo(cx, cy + hr * 1.95, cx + hr * 0.72, cy + hr * 1.15);
  g.stroke();
  g.strokeStyle = '#ecebe6';
  g.lineWidth = Math.max(0.8, hr * 0.08);
  g.beginPath();
  g.moveTo(cx - hr * 0.26, cy + hr * 1.58);
  g.lineTo(cx - hr * 0.32, cy + hr * 2.4);
  g.moveTo(cx + hr * 0.26, cy + hr * 1.58);
  g.lineTo(cx + hr * 0.32, cy + hr * 2.4);
  g.stroke();
  // bob: dome and straight sides down to the jaw
  g.fillStyle = '#17130f';
  g.beginPath();
  g.ellipse(cx, cy - hr * 0.05, hr * 1.12, hr * 1.08, 0, Math.PI, 0);
  g.lineTo(cx + hr * 1.14, cy + hr * 0.62);
  g.quadraticCurveTo(cx + hr * 0.95, cy + hr * 0.8, cx + hr * 0.6, cy + hr * 0.72);
  g.lineTo(cx - hr * 0.6, cy + hr * 0.72);
  g.quadraticCurveTo(cx - hr * 0.95, cy + hr * 0.8, cx - hr * 1.14, cy + hr * 0.62);
  g.closePath();
  g.fill();
  oval(g, cx, cy + hr * 0.1, hr * 0.78, hr * 0.9, '#f0cdb2');
  // fringe
  g.fillStyle = '#17130f';
  g.beginPath();
  g.ellipse(cx, cy - hr * 0.05, hr * 0.98, hr * 0.98, 0, Math.PI, 0);
  g.lineTo(cx + hr * 0.86, cy - hr * 0.05);
  g.quadraticCurveTo(cx, cy - hr * 0.36, cx - hr * 0.86, cy - hr * 0.05);
  g.closePath();
  g.fill();
  // face
  oval(g, cx - hr * 0.32, cy + hr * 0.16, hr * 0.1, hr * 0.13, '#231a14');
  oval(g, cx + hr * 0.32, cy + hr * 0.16, hr * 0.1, hr * 0.13, '#231a14');
  disc(g, cx - hr * 0.5, cy + hr * 0.4, hr * 0.16, 'rgba(230,120,110,0.28)');
  disc(g, cx + hr * 0.5, cy + hr * 0.4, hr * 0.16, 'rgba(230,120,110,0.28)');
  g.fillStyle = '#a5463e';
  g.beginPath();
  g.ellipse(cx, cy + hr * 0.5, hr * 0.25, hr * 0.15, 0, 0, Math.PI);
  g.fill();
  // hair pin
  const pr = Math.max(1.6, hr * 0.22);
  disc(g, cx + hr * 0.6, cy - hr * 0.22, pr, '#f4c21c');
  disc(g, cx + hr * 0.6, cy - hr * 0.22, pr * 0.45, '#6a4314');
}

// ── posters on the town board (three.js planes) ──────────────────────────────

/** poster_missing_1 — D07 しずくの張り紙. 0.30 × 0.42 m, up for a year: sun and rain. */
function drawShizukuPoster(g: G, w: number, h: number): void {
  paper(g, w, h, '#f2eee2', 7101, [176, 146, 80], 0.22);
  const M = 12;
  const cx = w / 2;
  const iw = w - M * 2;
  // headline (red ink that ran a little in the rain)
  setFont(g, 28, JP_FONT, 'bold');
  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(192,50,42,0.22)';
  spread(g, 'さがしています', M + 3, w - M - 3, 44);
  g.fillStyle = '#c0322a';
  spread(g, 'さがしています', M + 3, w - M - 3, 42);
  g.fillRect(M, 49, iw, 1.6);
  // photo, printed with a thin white border
  const px = 28;
  const py = 56;
  const pw = w - 56;
  const ph = 102;
  g.fillStyle = '#fbfaf4';
  g.fillRect(px - 3, py - 3, pw + 6, ph + 6);
  sunflowerPhoto(g, px, py, pw, ph, 7102);
  g.strokeStyle = 'rgba(70,60,50,0.45)';
  g.lineWidth = 1;
  g.strokeRect(px - 3.5, py - 3.5, pw + 7, ph + 7);
  // name, then when and where
  center(g, '宮内　しずく　さん', cx, 186, iw, 22, '#1e1b18', JP_FONT, 'bold');
  center(g, '（19歳・当時）', cx, 200, iw, 11, '#2a2622');
  center(g, '昨年8月31日の午前3時ごろ、', cx, 218, iw, 12.5, '#b3271f', JP_FONT, 'bold');
  setFont(g, 10, JP_FONT);
  g.fillStyle = '#24211d';
  wrap(g, '月見町二丁目付近で見かけられたのを最後に、行方が分かっていません。', cx, 231, iw - 6, 12.5, 'center');
  block(g, ['・身長155cm　やせ型　黒髪のショートボブ', '・灰色のパーカー　裸足', '・左の前髪に、ひまわりのヘアピン'], M + 10, 260, 12.5, iw - 16, 10, '#24211d');
  center(g, 'どんな小さなことでも、ご連絡ください。', cx, 300, iw, 10, '#24211d');
  g.strokeStyle = '#3a3530';
  g.lineWidth = 1;
  g.strokeRect(M + 4, 307, iw - 8, 20);
  // the number stays masked (no real number is ever drawn)
  center(g, '連絡先　宮内（家族）　090-××××-××××', cx, 321.5, iw - 16, 11, '#1e1b18', JP_FONT, 'bold');
  // a year outdoors
  wash(g, w, h, 'rgba(246,240,224,0.16)');
  sunFade(g, w, h, 0.16);
  streaks(g, w, h, 8, 7103, 0.11);
  tide(g, 34, 292, 30, 7104, 0.24);
  tide(g, w - 34, 74, 15, 7105, 0.2);
  tide(g, w - 58, 238, 11, 7106, 0.18);
  grain(g, w, h, 12, 7107);
  dogEar(g, w, h, 17, '#ddd5c0');
  redPin(g, 15, 11);
  bluePin(g, w - 15, 11);
}

/** Crayon calico cat, as a seven-year-old would draw it. */
function kidCat(c: G, cx: number, cy: number, s: number, R: () => number): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const ink = '#2b2523';
  const orange = '#e58a2b';
  // tail
  c.strokeStyle = orange;
  c.lineWidth = 8 * s;
  c.beginPath();
  c.moveTo(cx + 26 * s, cy + 36 * s);
  c.bezierCurveTo(cx + 64 * s, cy + 38 * s, cx + 62 * s, cy + 2 * s, cx + 46 * s, cy - 6 * s);
  c.stroke();
  // body with patches
  const body = () => {
    c.beginPath();
    c.ellipse(cx, cy + 26 * s, 34 * s, 30 * s, 0, 0, TAU);
  };
  c.fillStyle = '#fffdf4';
  body();
  c.fill();
  c.save();
  body();
  c.clip();
  oval(c, cx - 22 * s, cy + 16 * s, 16 * s, 13 * s, orange);
  oval(c, cx + 21 * s, cy + 38 * s, 15 * s, 12 * s, ink);
  c.restore();
  // ears (one orange, one black)
  poly(c, [cx - 27 * s, cy - 30 * s, cx - 22 * s, cy - 60 * s, cx - 5 * s, cy - 44 * s], orange);
  poly(c, [cx + 27 * s, cy - 30 * s, cx + 22 * s, cy - 60 * s, cx + 5 * s, cy - 44 * s], ink);
  const head = () => {
    c.beginPath();
    c.ellipse(cx, cy - 26 * s, 30 * s, 25 * s, 0, 0, TAU);
  };
  c.fillStyle = '#fffdf4';
  head();
  c.fill();
  c.save();
  head();
  c.clip();
  oval(c, cx - 21 * s, cy - 41 * s, 17 * s, 13 * s, orange);
  oval(c, cx + 22 * s, cy - 40 * s, 15 * s, 12 * s, ink);
  c.restore();
  // wobbly outlines, gone over twice
  c.strokeStyle = ink;
  c.lineWidth = 2.4 * s;
  for (let k = 0; k < 2; k++) {
    wobbly(c, cx, cy + 26 * s, 34 * s, 30 * s, R, 1.6 * s);
    c.stroke();
    wobbly(c, cx, cy - 26 * s, 30 * s, 25 * s, R, 1.6 * s);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(cx - 27 * s, cy - 32 * s);
  c.lineTo(cx - 22 * s, cy - 60 * s);
  c.lineTo(cx - 6 * s, cy - 46 * s);
  c.moveTo(cx + 27 * s, cy - 32 * s);
  c.lineTo(cx + 22 * s, cy - 60 * s);
  c.lineTo(cx + 6 * s, cy - 46 * s);
  c.stroke();
  // face
  disc(c, cx - 11 * s, cy - 29 * s, 3.8 * s, ink);
  disc(c, cx + 11 * s, cy - 29 * s, 3.8 * s, ink);
  poly(c, [cx - 3.5 * s, cy - 21 * s, cx + 3.5 * s, cy - 21 * s, cx, cy - 16.5 * s], '#e8778e');
  c.lineWidth = 1.8 * s;
  c.beginPath();
  c.arc(cx - 3 * s, cy - 15 * s, 3 * s, Math.PI, 0, true);
  c.arc(cx + 3 * s, cy - 15 * s, 3 * s, Math.PI, 0, true);
  c.stroke();
  for (const side of [-1, 1]) {
    for (let k = -1; k <= 1; k++) {
      c.beginPath();
      c.moveTo(cx + side * 14 * s, cy - 19 * s + k * 3 * s);
      c.lineTo(cx + side * 37 * s, cy - 21 * s + k * 7 * s);
      c.stroke();
    }
  }
  // red collar and a bell
  c.strokeStyle = '#d6262b';
  c.lineWidth = 5 * s;
  c.beginPath();
  c.moveTo(cx - 22 * s, cy - 5 * s);
  c.quadraticCurveTo(cx, cy + 6 * s, cx + 22 * s, cy - 5 * s);
  c.stroke();
  disc(c, cx, cy + 6 * s, 5 * s, '#f2c21b');
  c.strokeStyle = '#8a6a10';
  c.lineWidth = 1.3 * s;
  c.beginPath();
  c.moveTo(cx - 3 * s, cy + 7 * s);
  c.lineTo(cx + 3 * s, cy + 7 * s);
  c.stroke();
  // feet
  for (const fx of [-14, 14]) {
    c.strokeStyle = ink;
    c.lineWidth = 2.2 * s;
    c.beginPath();
    c.ellipse(cx + fx * s, cy + 54 * s, 8 * s, 5 * s, 0, Math.PI, 0);
    c.stroke();
  }
}

function wobbly(c: G, cx: number, cy: number, rx: number, ry: number, R: () => number, amp: number): void {
  const n = 28;
  c.beginPath();
  for (let i = 0; i <= n + 2; i++) {
    const a = (i / n) * TAU + 0.2;
    const j = (R() - 0.5) * amp * 2;
    const px = cx + Math.cos(a) * (rx + j);
    const py = cy + Math.sin(a) * (ry + j);
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
}

/** poster_missing_2 — 迷い猫「三毛のミケ」, crayon on drawing paper, taped up by a child. */
function drawCatPoster(g: G, w: number, h: number): void {
  paper(g, w, h, '#f5edd8', 7201, [170, 140, 80], 0.16);
  grain(g, w, h, 14, 7202);
  const R = prng(7203);
  const layer = speckled(w, h, 7204, 0.42, (c) => {
    const big: Partial<Hand> = { weight: 'bold', vary: 0.22, wobble: 0.18, tilt: 0.3 };
    handFit(c, 'まいごの　ねこ', 22, 40, w - 40, { ...big, size: 24, color: '#d2332b', seed: 1 } as Hand);
    handFit(c, 'さがしています', 18, 72, w - 30, { ...big, size: 27, color: '#d2332b', seed: 2 } as Hand);
    kidCat(c, w * 0.47, 146, 0.95, R);
    let x = handFit(c, 'なまえ', 26, 230, 90, { ...big, size: 21, color: '#2a4fa8', seed: 3 } as Hand);
    handFit(c, 'ミケ', x + 10, 233, 90, { ...big, size: 31, color: '#d9701c', seed: 4 } as Hand);
    const small: Partial<Hand> = { vary: 0.18, wobble: 0.16, tilt: 0.22, weight: 'bold' };
    handFit(c, 'しろと　ちゃいろと　くろの　ねこ', 20, 258, w - 34, { ...small, size: 14, color: '#3a3330', seed: 5 } as Hand);
    handFit(c, 'あかい　くびわに　すず', 20, 280, w - 34, { ...small, size: 14, color: '#3a3330', seed: 6 } as Hand);
    x = handFit(c, 'みつけたら　おしえてね', 20, 312, w - 50, { ...big, size: 19, color: '#2f8a3a', seed: 7 } as Hand);
    // a little heart at the end
    c.fillStyle = '#e0457a';
    c.beginPath();
    const hx = Math.min(x + 12, w - 16);
    const hy = 304;
    c.moveTo(hx, hy + 5);
    c.bezierCurveTo(hx - 9, hy - 2, hx - 4, hy - 9, hx, hy - 3);
    c.bezierCurveTo(hx + 4, hy - 9, hx + 9, hy - 2, hx, hy + 5);
    c.fill();
    // stars in the corners
    for (const [sx, sy, col] of [[w - 28, 104, '#f0b81a'], [26, 112, '#f0b81a'], [w - 34, 196, '#5aa0e0']] as [number, number, string][]) {
      c.strokeStyle = col;
      c.lineWidth = 2.4;
      c.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
        const px = sx + Math.cos(a) * 9;
        const py = sy + Math.sin(a) * 9;
        if (k === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.stroke();
    }
  });
  g.drawImage(layer, 0, 0);
  sunFade(g, w, h, 0.1);
  streaks(g, w, h, 5, 7205, 0.08);
  tide(g, w - 40, 300, 20, 7206, 0.2);
  // clear tape at the two top corners
  tape(g, 18, 12, 38, 12, -0.62, 'rgba(250,250,238,0.42)', 'rgba(170,170,150,0.35)');
  tape(g, w - 18, 12, 38, 12, 0.62, 'rgba(250,250,238,0.42)', 'rgba(170,170,150,0.35)');
}

/** poster_missing_3 — D15 町内会のお知らせ (posted on 8/30: crisp, pinned at four corners). */
function drawNotice(g: G, w: number, h: number): void {
  paper(g, w, h, '#f7f6f1', 7301, [150, 140, 110], 0.08);
  const M = 16;
  const cx = w / 2;
  const iw = w - M * 2;
  const navy = '#1f2a44';
  const ink = '#232220';
  setFont(g, 11, JP_FONT);
  g.fillStyle = '#3a3a3a';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText('月見町内会より', M + 2, 32);
  g.strokeStyle = navy;
  g.lineWidth = 2;
  g.strokeRect(M, 41, iw, 40);
  g.lineWidth = 0.8;
  g.strokeRect(M + 3, 44, iw - 6, 34);
  center(g, '夜間の見守りのお願い', cx, 68, iw - 14, 21, navy, JP_FONT, 'bold');
  const bw = iw - 6;
  let y = 108;
  center(g, '最近、深夜3時ごろ、二丁目付近を', cx, y, bw, 11.5, ink, JP_SERIF);
  y += 19;
  center(g, '裸足で歩く若い男性の姿が', cx, y, bw, 14, '#111', JP_FONT, 'bold');
  const ul = Math.min(bw, g.measureText('裸足で歩く若い男性の姿が').width);
  g.fillStyle = '#b02a22';
  g.fillRect(cx - ul / 2, y + 3, ul, 1.3);
  y += 19;
  center(g, 'たびたび見かけられています。', cx, y, bw, 11.5, ink, JP_SERIF);
  // description box
  g.strokeStyle = '#6a6862';
  g.lineWidth = 1;
  g.strokeRect(M + 10, y + 9, iw - 20, 38);
  center(g, '灰色のTシャツに紺のハーフパンツ、', cx, y + 25, iw - 30, 10.5, ink, JP_SERIF);
  center(g, '手に懐中電灯', cx, y + 40, iw - 30, 10.5, ink, JP_SERIF);
  y += 72;
  center(g, 'お心当たりのある方、ご家族の方は、', cx, y, bw, 11.5, ink, JP_SERIF);
  y += 17;
  center(g, '町内会長までご相談ください。', cx, y, bw, 11.5, ink, JP_SERIF);
  y += 27;
  center(g, 'なお、夏の夜回り（拍子木）は、', cx, y, bw, 10.5, '#3a3936', JP_SERIF);
  y += 16;
  center(g, '今年は行っておりません。', cx, y, bw, 10.5, '#3a3936', JP_SERIF);
  // signature and a red seal
  setFont(g, 12, JP_SERIF, 'bold');
  g.fillStyle = ink;
  g.textAlign = 'right';
  g.fillText('月見町内会', w - M - 26, 306);
  g.strokeStyle = 'rgba(196,40,36,0.85)';
  g.lineWidth = 1.4;
  g.strokeRect(w - M - 21, 290, 20, 20);
  // seal text in columns, right column first: 町内 | 会印
  g.fillStyle = 'rgba(196,40,36,0.85)';
  setFont(g, 8, JP_SERIF, 'bold');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('町', w - M - 6.5, 296);
  g.fillText('内', w - M - 6.5, 305);
  g.fillText('会', w - M - 15.5, 296);
  g.fillText('印', w - M - 15.5, 305);
  g.textBaseline = 'alphabetic';
  grain(g, w, h, 8, 7302);
  for (const [px, py, red] of [[13, 11, true], [w - 13, 11, false], [13, h - 11, false], [w - 13, h - 11, true]] as [number, number, boolean][]) {
    if (red) redPin(g, px, py, 3.8);
    else bluePin(g, px, py, 3.8);
  }
}

/** poster_notice_1 — 「ラジオ体操は8月31日まで」 (children's association, faded by the summer sun). */
function drawRadioTaiso(g: G, w: number, h: number): void {
  paper(g, w, h, '#f8f5ea', 7401, [170, 140, 70], 0.16);
  const cx = w / 2;
  g.fillStyle = '#2f86c9';
  g.fillRect(0, 12, w, 46);
  center(g, 'なつやすみ', cx - 12, 30, 150, 14, '#ffffff', MARU, 'bold');
  center(g, 'ラジオたいそう', cx - 12, 52, 160, 23, '#ffffff', MARU, 'bold');
  // sun
  const sx = w - 30;
  const sy = 35;
  g.strokeStyle = '#f39a1e';
  g.lineWidth = 2.5;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    g.beginPath();
    g.moveTo(sx + Math.cos(a) * 14, sy + Math.sin(a) * 14);
    g.lineTo(sx + Math.cos(a) * 20, sy + Math.sin(a) * 20);
    g.stroke();
  }
  disc(g, sx, sy, 11.5, '#f7b733');
  // two children stretching
  for (const [fx, sc] of [[38, 1], [76, 0.82]] as [number, number][]) {
    const top = 72 + (1 - sc) * 30;
    g.strokeStyle = '#26508a';
    g.lineWidth = 3 * sc;
    g.lineCap = 'round';
    disc(g, fx, top + 8 * sc, 7 * sc, '#26508a');
    g.beginPath();
    g.moveTo(fx, top + 15 * sc);
    g.lineTo(fx, top + 40 * sc);
    g.moveTo(fx - 16 * sc, top - 2 * sc);
    g.lineTo(fx, top + 20 * sc);
    g.lineTo(fx + 16 * sc, top - 2 * sc);
    g.moveTo(fx - 11 * sc, top + 60 * sc);
    g.lineTo(fx, top + 40 * sc);
    g.lineTo(fx + 11 * sc, top + 60 * sc);
    g.stroke();
  }
  center(g, 'まいあさ', 168, 88, 110, 14, '#26508a', MARU, 'bold');
  center(g, '6:30〜', 168, 120, 120, 30, '#26508a', JP_FONT, 'bold');
  // the key line
  center(g, '8月31日まで', cx, 172, w - 24, 34, '#d22a22', JP_FONT, 'bold');
  center(g, 'ばしょ：月見神社　けいだい', cx, 196, w - 30, 12.5, '#333', MARU, 'bold');
  center(g, 'カードを　わすれずに！', cx, 214, w - 30, 12.5, '#333', MARU, 'bold');
  setFont(g, 9.5, JP_FONT);
  g.fillStyle = '#555';
  g.textAlign = 'right';
  g.fillText('月見町　子ども会', w - 12, 232);
  wash(g, w, h, 'rgba(250,246,234,0.2)');
  sunFade(g, w, h, 0.12);
  streaks(g, w, h, 4, 7402, 0.07);
  grain(g, w, h, 10, 7403);
  redPin(g, 12, 7, 3.8);
  redPin(g, w - 12, 7, 3.8);
}

/** poster_notice_2 — 夜間の外出注意 (yellow crime-prevention notice, old and faded). */
function drawNightCaution(g: G, w: number, h: number): void {
  paper(g, w, h, '#efdf8a', 7501, [150, 118, 40], 0.24);
  const cx = w / 2;
  disc(g, 38, 42, 22, '#c8302a');
  setFont(g, 15, JP_FONT, 'bold');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('防犯', 38, 43);
  g.textBaseline = 'alphabetic';
  // crescent moon over a roof line
  disc(g, w - 44, 40, 15, '#2b2a26');
  disc(g, w - 37, 35, 13, '#efdf8a');
  center(g, '夜間の外出に', cx, 110, w - 28, 28, '#1b1b1b', JP_FONT, 'bold');
  center(g, 'ご注意ください', cx, 146, w - 28, 28, '#1b1b1b', JP_FONT, 'bold');
  g.fillStyle = '#c8302a';
  g.fillRect(24, 156, w - 48, 3);
  center(g, '深夜のひとり歩きは　さけましょう', cx, 182, w - 30, 12.5, '#262420');
  center(g, 'あやしい人を見かけたら　すぐに110番', cx, 202, w - 30, 12.5, '#262420');
  setFont(g, 10, JP_FONT);
  g.fillStyle = '#3a372f';
  g.textAlign = 'right';
  g.fillText('月見町内会　防犯部', w - 14, 228);
  wash(g, w, h, 'rgba(248,240,200,0.18)');
  sunFade(g, w, h, 0.12);
  streaks(g, w, h, 6, 7502, 0.1);
  tide(g, 46, 190, 22, 7503, 0.22);
  // a crease across the sheet
  g.strokeStyle = 'rgba(120,100,40,0.25)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, h * 0.62);
  g.lineTo(w, h * 0.58);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,230,0.35)';
  g.beginPath();
  g.moveTo(0, h * 0.62 + 1.2);
  g.lineTo(w, h * 0.58 + 1.2);
  g.stroke();
  grain(g, w, h, 12, 7504);
  bluePin(g, 12, 8, 3.8);
  redPin(g, w - 12, 8, 3.8);
}

// ── convenience store ────────────────────────────────────────────────────────

/** ツキミマート mark: violet badge with a moon-yellow crescent. */
function moonMark(g: G, x: number, y: number, r: number, ring = false): void {
  if (ring) disc(g, x, y, r + 1.6, MOON);
  disc(g, x, y, r, VIOLET);
  disc(g, x - r * 0.1, y + r * 0.03, r * 0.6, MOON);
  disc(g, x + r * 0.2, y - r * 0.14, r * 0.5, VIOLET);
  disc(g, x + r * 0.44, y + r * 0.42, r * 0.09, MOON);
}

/** conbini_sign — emit_conbini_sign face, 5.6 × 0.86 m (backlit at night). */
function drawConbiniSign(g: G, w: number, h: number): void {
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#efebe2');
  bg.addColorStop(0.5, '#fbfaf5');
  bg.addColorStop(1, '#e9e5da');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = VIOLET;
  g.fillRect(0, 4, w, 2.5);
  g.fillRect(0, h - 6.5, w, 2.5);
  const my = h / 2;
  moonMark(g, 36, my, 19);
  setFont(g, 33, JP_FONT, 'bold');
  g.fillStyle = VIOLET;
  g.textBaseline = 'middle';
  spread(g, 'ツキミマート', 70, 298, my + 1);
  rrect(g, 314, my - 12, 56, 24, 12);
  g.fillStyle = MOON;
  g.fill();
  setFont(g, 15, JP_FONT, 'bold');
  g.fillStyle = VIOLET;
  g.textAlign = 'center';
  g.fillText('24H', 342, my + 1);
  g.textBaseline = 'alphabetic';
  grain(g, w, h, 5, 7601);
}

/** conbini_poster — staff wanted, on the shop front. 0.5 × 0.7 m. */
function drawConbiniPoster(g: G, w: number, h: number): void {
  paper(g, w, h, '#fbfaf6', 7701, [150, 140, 120], 0.06);
  const cx = w / 2;
  g.fillStyle = VIOLET;
  g.fillRect(0, 0, w, 44);
  moonMark(g, 28, 22, 13, true);
  setFont(g, 18, JP_FONT, 'bold');
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText('ツキミマート', 50, 23);
  g.textBaseline = 'alphabetic';
  center(g, 'スタッフ', cx, 92, w - 30, 40, VIOLET, JP_FONT, 'bold');
  g.fillStyle = MOON;
  g.fillRect(14, 102, w - 28, 46);
  center(g, '募集中！', cx, 139, w - 40, 38, '#c62a24', JP_FONT, 'bold');
  center(g, '深夜（22時〜翌9時）', cx, 176, w - 30, 15, '#222', JP_FONT, 'bold');
  // 時給 + amount on one line
  setFont(g, 16, JP_FONT, 'bold');
  const a = g.measureText('時給').width;
  setFont(g, 36, JP_FONT, 'bold');
  const b = g.measureText('1,300円').width;
  const x0 = cx - (a + b + 6) / 2;
  setFont(g, 16, JP_FONT, 'bold');
  g.fillStyle = '#222';
  g.textAlign = 'left';
  g.fillText('時給', x0, 216);
  setFont(g, 36, JP_FONT, 'bold');
  g.fillStyle = '#c62a24';
  g.fillText('1,300円', x0 + a + 6, 218);
  block(g, ['・週2日、1日4時間からOK', '・学生さん、未経験の方も歓迎', '・日中のシフトもあります'], 30, 248, 17, w - 50, 12.5, '#2a2a2a', JP_FONT, 'bold');
  g.fillStyle = VIOLET;
  g.fillRect(14, 298, w - 28, 1.5);
  center(g, 'くわしくは店長・スタッフまで', cx, 316, w - 30, 11.5, '#333');
  center(g, 'ツキミマート　月見町店', cx, 331, w - 30, 10, VIOLET, JP_FONT, 'bold');
  grain(g, w, h, 6, 7702);
}

// ── shrine ───────────────────────────────────────────────────────────────────

const YUISHO_TITLE = '月見神社　由緒';
const YUISHO_BODY = [
  '当社は旧面見村の産土神を祀る。',
  '古くより夜半に姿を消したる者は面になると言い伝え、拝殿裏の祠にその霊を祀る。',
  '面となりし者は目を閉ずること能わず、夜半に目覚めたる者を閉ざされぬ隙間より窺う。目を合わすべからず。ふたつ数うる間に、隙間より入らるべし。',
  '寝ぬる前には、鏡に布、厠に蓋、戸は閉ざすべし。',
  '帰らざる者を送らんとする時は、その者の品と香を祠に供え、身内の者ひと夜、寝ずの番をなすべし。番する者は目を開けて香を絶やさず、送らるる者は目を閉じて眠る。',
  '昭和三十二年、村名を面見より月見に改む。',
];

/** shrine_yuisho — D08 (abridged), sumi on a weathered board in a dark frame. 1.2 × 0.85 m plane. */
function drawYuisho(g: G, w: number, h: number): void {
  const F = 11;
  g.fillStyle = '#3a291b';
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,230,190,0.12)';
  g.fillRect(0, 0, w, 3);
  g.fillRect(0, 0, 3, h);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(0, h - 3, w, 3);
  g.fillRect(w - 3, 0, 3, h);
  wood(g, F, F, w - F * 2, h - F * 2, [204, 186, 150], 7801, { vertical: true, planks: 4, grain: 0.8 });
  // weathering: greyer toward the bottom, frame shadow
  const wx = g.createLinearGradient(0, F, 0, h - F);
  wx.addColorStop(0, 'rgba(120,110,100,0)');
  wx.addColorStop(1, 'rgba(110,104,96,0.22)');
  g.fillStyle = wx;
  g.fillRect(F, F, w - F * 2, h - F * 2);
  edgeShade(g, w, h, [40, 26, 14], 0.35, F + 8);
  const top = F + 13;
  const bottom = h - F - 13;
  const right = w - F - 12;
  const left = F + 12;
  const titleS = 21;
  const titlePitch = 32;
  // body: largest size whose columns fit between the title and the left edge,
  // leaving one narrower column for the signature
  let s = 15;
  for (; s > 8; s -= 0.5) {
    if (vflow(g, YUISHO_BODY, right - titlePitch - 6, top, bottom, s, s * 1.32, false) - s * 1.32 * 0.9 >= left - 2) break;
  }
  const pitch = s * 1.32;
  const rows = Math.floor((bottom - top) / s);
  const sign = '　'.repeat(Math.max(0, rows - 7)) + '月見神社社務所';
  const lastLeft = vflow(g, YUISHO_BODY, right - titlePitch - 6, top, bottom, s, pitch, false);
  const ink = speckled(w, h, 7802, 0.2, (c) => {
    c.fillStyle = '#1c140e';
    setFont(c, titleS, JP_SERIF, 'bold');
    vflow(c, [YUISHO_TITLE], right, top, bottom, titleS, titlePitch);
    setFont(c, s, JP_SERIF, 'bold');
    vflow(c, YUISHO_BODY, right - titlePitch - 6, top, bottom, s, pitch);
    if (lastLeft - pitch * 0.9 >= left - 2) {
      setFont(c, s * 0.85, JP_SERIF, 'bold');
      vflow(c, [sign], lastLeft - 2, top, bottom, s, pitch * 0.9);
    }
  });
  g.drawImage(ink, 0, 0);
  grain(g, w, h, 10, 7803);
}

/**
 * shrine_plaque — 扁額「月見神社」 on the torii (0.4 × 0.6 m, 3.6 m up and in
 * the shade of the beams): big, bright gold letters on a dark board.
 */
function drawPlaque(g: G, w: number, h: number): void {
  g.fillStyle = '#17120e';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#c29a3e';
  g.lineWidth = 3;
  g.strokeRect(4, 4, w - 8, h - 8);
  const F = 11;
  const field = g.createLinearGradient(0, F, 0, h - F);
  field.addColorStop(0, '#20252c');
  field.addColorStop(1, '#13161b');
  g.fillStyle = field;
  g.fillRect(F, F, w - F * 2, h - F * 2);
  g.strokeStyle = '#c9a443';
  g.lineWidth = 1.5;
  g.strokeRect(F + 3, F + 3, w - F * 2 - 6, h - F * 2 - 6);
  for (const [x, y] of [[F, F], [w - F, F], [F, h - F], [w - F, h - F]]) {
    g.fillStyle = '#b8913a';
    g.fillRect(x - 6, y - 6, 12, 12);
    disc(g, x, y, 2, '#6b5420');
  }
  // seen from the approach, the top of the plaque hides behind the 島木 beam:
  // the letters sit in the lower part of the field
  const chars = ['月', '見', '神', '社'];
  const top = Math.round(h * 0.14);
  const step = (h - F - 6 - top) / 4;
  setFont(g, Math.min(step - 1, 52), JP_SERIF, 'bold');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  chars.forEach((ch, i) => {
    const y = top + step * (i + 0.5);
    g.fillStyle = 'rgba(0,0,0,0.8)';
    g.fillText(ch, w / 2 + 1.5, y + 2);
    // a stroke in the same gold thickens the thin Mincho strokes for distance
    g.strokeStyle = '#e0bb55';
    g.lineWidth = 2.2;
    g.strokeText(ch, w / 2, y);
    g.fillStyle = '#e8c35e';
    g.fillText(ch, w / 2, y);
    g.fillStyle = 'rgba(255,244,205,0.35)';
    g.fillText(ch, w / 2 - 0.8, y - 0.9);
  });
  srand(7901);
  stains(g, w, h, 6, 'rgba(10,8,6,0.25)', 40);
  grain(g, w, h, 12, 7902);
}

/** juyosho — 授与所 board over the office window (1.0 × 0.3 m). */
function drawJuyosho(g: G, w: number, h: number): void {
  wood(g, 0, 0, w, h, [200, 168, 116], 8001, { grain: 1 });
  edgeShade(g, w, h, [50, 30, 12], 0.4, 10);
  const ink = speckled(w, h, 8002, 0.08, (c) => {
    setFont(c, 60, JP_SERIF, 'bold');
    c.fillStyle = '#1b130c';
    c.strokeStyle = '#1b130c';
    c.lineWidth = 2.4;
    c.lineJoin = 'round';
    c.textBaseline = 'middle';
    // stroked as well as filled: thicker brush lines that survive the distance
    spread(c, '授与所', 56, w - 56, h / 2 + 3, true);
  });
  g.drawImage(ink, 0, 0);
  grain(g, w, h, 10, 8003);
}

/**
 * Ema face (0.16 × 0.12 m plane on the rectangular body under the pointed top;
 * the rest of the board is the flat ema_wood colour, so the edges fade into it).
 */
function emaWood(g: G, w: number, h: number, seed: number, faded: boolean): void {
  wood(g, 0, 0, w, h, faded ? [214, 196, 162] : [217, 183, 124], seed, { grain: faded ? 0.4 : 0.55 });
  if (faded) {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, 'rgba(235,228,214,0.35)');
    gr.addColorStop(1, 'rgba(160,150,135,0.18)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  }
  edgeShade(g, w, h, [217, 183, 124], faded ? 0.95 : 0.7, faded ? 22 : 10);
}

/** Small red shrine stamp. */
function emaStamp(g: G, x: number, y: number, a: number): void {
  g.strokeStyle = `rgba(190,36,34,${a})`;
  g.lineWidth = 1.4;
  g.strokeRect(x, y, 18, 24);
  g.fillStyle = `rgba(190,36,34,${a})`;
  setFont(g, 9, JP_SERIF, 'bold');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('月', x + 9, y + 7);
  g.fillText('見', x + 9, y + 17.5);
  g.textBaseline = 'alphabetic';
}

/** ema_1 — 「ぐっすり眠れますように　月見町　T・K」 (an adult's marker). */
function drawEma1(g: G, w: number, h: number): void {
  emaWood(g, w, h, 8101, false);
  emaStamp(g, 10, h - 34, 0.75);
  const o = { color: '#1a1714', font: JP_FONT, weight: 'bold', vary: 0.08, wobble: 0.08, tilt: 0.1, track: 0.95 };
  handFit(g, 'ぐっすり', 18, 48, w - 32, { ...o, size: 34, seed: 11 });
  handFit(g, '眠れますように', 12, 90, w - 22, { ...o, size: 26, seed: 12 });
  handFit(g, '月見町　T・K', 74, 126, w - 84, { ...o, size: 15, seed: 13, weight: '' });
}

/** ema_2 — さき (7): 「二がっきも　ともだちと　なかよく　できますように」 */
function drawEma2(g: G, w: number, h: number): void {
  emaWood(g, w, h, 8201, false);
  emaStamp(g, 10, h - 34, 0.75);
  const o = { color: '#c2307a', font: MARU, weight: 'bold', vary: 0.24, wobble: 0.2, tilt: 0.32, track: 0.98 };
  handFit(g, '二がっきも', 16, 32, w - 30, { ...o, size: 21, seed: 21 });
  handFit(g, 'ともだちと', 22, 57, w - 34, { ...o, size: 21, seed: 22 });
  handFit(g, 'なかよく', 16, 82, w - 30, { ...o, size: 21, seed: 23 });
  handFit(g, 'できますように', 14, 107, w - 22, { ...o, size: 21, seed: 24 });
  const x = handFit(g, 'さき', 112, 134, 60, { ...o, size: 20, seed: 25, color: '#2c63b8' });
  // a flower doodle after the name
  const fx = Math.min(x + 12, w - 12);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    disc(g, fx + Math.cos(a) * 4.5, 126 + Math.sin(a) * 4.5, 3.2, '#f08aa8');
  }
  disc(g, fx, 126, 2.6, '#f4c21c');
}

/** ema_3 — しずく, last year: 「おもてさま　おねえちゃんを　みないでください」, sun-bleached. */
function drawEma3(g: G, w: number, h: number): void {
  emaWood(g, w, h, 8301, true);
  emaStamp(g, 10, h - 34, 0.3);
  const layer = speckled(w, h, 8302, 0.3, (c) => {
    const o = { color: '#4f4038', font: MARU, vary: 0.08, wobble: 0.06, tilt: 0.08, track: 0.94, alpha: 0.62 };
    handFit(c, 'おもてさま', 18, 36, w - 36, { ...o, size: 21, seed: 31 });
    handFit(c, 'おねえちゃんを', 18, 64, w - 30, { ...o, size: 21, seed: 32 });
    handFit(c, 'みないでください', 16, 92, w - 26, { ...o, size: 21, seed: 33 });
    handFit(c, 'しずく', 110, 126, 72, { ...o, size: 20, seed: 34 });
    handFit(c, '8月17日', 38, 126, 64, { ...o, size: 12, seed: 35, alpha: 0.5 });
  });
  g.drawImage(layer, 0, 0);
  grain(g, w, h, 8, 8303);
}

// ── apartment ────────────────────────────────────────────────────────────────

/** Door / mailbox number plate (door 0.12 × 0.06 m, mailbox 0.06 × 0.03 m). */
function plate(n: string): TexSpec {
  const seed = 9000 + Number(n);
  return onModel(128, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#f2eee2');
    gr.addColorStop(1, '#d9d3c1');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(70,64,52,0.55)';
    g.lineWidth = 2;
    rrect(g, 5, 5, w - 10, h - 10, 6);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,250,0.6)';
    g.lineWidth = 1;
    rrect(g, 7, 7, w - 14, h - 14, 5);
    g.stroke();
    // digits as big as the plate allows: the mailbox copy is only 6 × 3 cm
    fitFont(g, n, w - 40, 44, JP_FONT, 'bold');
    g.fillStyle = '#2b2824';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(n, w / 2, h / 2 + 2);
    for (const sx of [12, w - 12]) {
      disc(g, sx, h / 2, 3, '#a9a69c');
      g.strokeStyle = '#6e6b62';
      g.lineWidth = 0.9;
      g.beginPath();
      g.moveTo(sx - 2, h / 2);
      g.lineTo(sx + 2, h / 2);
      g.stroke();
    }
    srand(seed);
    stains(g, w, h, 6, 'rgba(90,80,60,0.10)', 20);
    const dirt = g.createLinearGradient(0, h * 0.6, 0, h);
    dirt.addColorStop(0, 'rgba(80,70,50,0)');
    dirt.addColorStop(1, 'rgba(80,70,50,0.18)');
    g.fillStyle = dirt;
    g.fillRect(0, 0, w, h);
    grain(g, w, h, 8, seed);
  });
}

/** Lined memo-pad sheet (うちのメモ帳: D01, D02 and なおの置き手紙 share it). */
function memoPad(g: G, w: number, h: number, seed: number, lineTop: number, pitch: number): void {
  paper(g, w, h, '#f7f4ea', seed, [150, 140, 110], 0.1);
  g.fillStyle = 'rgba(96,140,200,0.28)';
  for (let y = lineTop; y < h - 4; y += pitch) g.fillRect(6, y, w - 12, 0.9);
  g.fillStyle = 'rgba(214,96,96,0.35)';
  g.fillRect(14, 0, 0.9, h);
  grain(g, w, h, 8, seed + 1);
}

/** The sleepwalker's hand (透 asleep): round, sloppy, lopsided hiragana with the curled め. */
const SLEEP_HAND = { color: '#24305e', font: MARU, vary: 0.3, wobble: 0.3, tilt: 0.44, squash: 0.3, track: 0.9, space: 0.4, curlMe: true };
/** なお's hand: round letters that lean a little to the right (D12; the calendar's 「1ねん」). */
const NAO_HAND = { font: MARU, slant: 0.22, vary: 0.12, wobble: 0.1, tilt: 0.09, squash: 0.08, track: 0.98 };

/** memo_breaker — D01 under the masking tape (0.085 × 0.06 m; the tape covers the top edge). */
function drawMemoBreaker(g: G, w: number, h: number): void {
  memoPad(g, w, h, 8401, 30, 26);
  handFit(g, 'あかり　つけたら　だめ', 12, 56, w - 18, { ...SLEEP_HAND, size: 21, seed: 41, rise: -0.035 });
  handFit(g, 'みえちゃうから', 20, 98, w - 30, { ...SLEEP_HAND, size: 22, seed: 42, rise: -0.05 });
}

/** memo_fridge — D02 on the fridge door (0.11 × 0.14 m; the red magnet covers the top centre). */
function drawMemoFridge(g: G, w: number, h: number): void {
  memoPad(g, w, h, 8501, 34, 19);
  const L = 22;
  const W = w - L - 10;
  const o = { ...SLEEP_HAND, size: 15 };
  handFit(g, 'ねるまえに', L, 50, W, { ...o, seed: 51 });
  handFit(g, 'あいてるところを', L, 69, W, { ...o, seed: 52 });
  handFit(g, 'ぜんぶ　しめる', L + 6, 88, W, { ...o, seed: 53 });
  // (カーテン keeps its ン upright: tilted, it reads as ソ)
  ['・トイレの　ふた', '・かがみ', '・クローゼット', '・カーテン', '・れいぞうこ'].forEach((t, i) => {
    handFit(g, t, L, 109 + i * 18, W, { ...o, size: 14, tilt: i === 3 ? 0.1 : 0.3, seed: 54 + i });
  });
  handFit(g, 'さいごに　め', L + 4, 210, W, { ...o, size: 18, seed: 60 });
}

/** memo_nao (added) — D12 なおの置き手紙 on the low table, same pad (0.11 × 0.14 m). */
function drawMemoNao(g: G, w: number, h: number): void {
  memoPad(g, w, h, 8601, 30, 20);
  const L = 20;
  const W = w - L - 12;
  const o = { ...NAO_HAND, color: '#2b2b33', size: 13 };
  const lines = ['仕事いくね。', 'よく寝てたから、', '起こさなかった。', '冷蔵庫に、麦茶', 'つくっておいたよ。', '病院は、無理しなくて', 'いいからね。'];
  lines.forEach((t, i) => handFit(g, t, L, 46 + i * 20, W, { ...o, seed: 61 + i }));
  handFit(g, 'なお', w - 58, 200, 40, { ...o, size: 15, seed: 69 });
}

/** calendar — August, Sunday-first. 0.32 × 0.46 m sheet. */
// The year is never printed. Aug 1 = Tuesday, so 29日 = Tue (clinic 15:00),
// 30日 = Wed, 31日 = Thu, 9/1 = Fri (school starts); 11日 (山の日) = Fri.
const CAL_AUG1 = 2;
function drawCalendar(g: G, w: number, h: number): void {
  g.fillStyle = '#f8f7f2';
  g.fillRect(0, 0, w, h);
  summerScene(g, 6, 6, w - 12, 90, 8701);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  g.strokeRect(6.5, 6.5, w - 13, 90);
  const ink = '#26324a';
  const red = '#c8262a';
  const blue = '#2b5aa8';
  setFont(g, 34, JP_FONT, 'bold');
  g.fillStyle = ink;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText('8', 10, 128);
  setFont(g, 10, JP_FONT, 'bold');
  g.fillText('AUGUST', 36, 114);
  setFont(g, 9, JP_SERIF);
  g.fillText('葉月', 36, 126);
  miniMonth(g, 98, 104, '7', 6, 31);
  miniMonth(g, 146, 104, '9', 5, 30);
  const gx = 6;
  const gw = (w - 12) / 7;
  const gy = 134;
  const rowH = 22;
  ['日', '月', '火', '水', '木', '金', '土'].forEach((d, i) => {
    setFont(g, 9, JP_FONT, 'bold');
    g.fillStyle = i === 0 ? red : i === 6 ? blue : '#555';
    g.textAlign = 'center';
    g.fillText(d, gx + gw * (i + 0.5), gy + 9);
  });
  g.strokeStyle = '#d4d1c8';
  g.lineWidth = 0.8;
  for (let r = 0; r <= 5; r++) {
    g.beginPath();
    g.moveTo(gx, gy + 12 + r * rowH);
    g.lineTo(w - 6, gy + 12 + r * rowH);
    g.stroke();
  }
  for (let c = 1; c < 7; c++) {
    g.beginPath();
    g.moveTo(gx + c * gw, gy + 12);
    g.lineTo(gx + c * gw, gy + 12 + 5 * rowH);
    g.stroke();
  }
  const cell = (d: number) => {
    const idx = CAL_AUG1 + d - 1;
    return { x: gx + (idx % 7) * gw, y: gy + 12 + Math.floor(idx / 7) * rowH, col: idx % 7 };
  };
  for (let d = 1; d <= 31; d++) {
    const c = cell(d);
    setFont(g, 11, JP_FONT, 'bold');
    g.fillStyle = c.col === 0 || d === 11 ? red : c.col === 6 ? blue : '#2a2a2a';
    g.textAlign = 'left';
    g.fillText(String(d), c.x + 2.5, c.y + 11);
  }
  const c11 = cell(11);
  setFont(g, 6, JP_FONT);
  g.fillStyle = red;
  g.fillText('山の日', c11.x + 2.5, c11.y + 19);
  // 透's own note on the 29th (pencil)
  const c29 = cell(29);
  hand(g, '病院', c29.x + 3, c29.y + 19.5, { size: 8, color: 'rgba(70,70,74,0.85)', seed: 71, font: JP_FONT, vary: 0.1, wobble: 0.1, tilt: 0.1 });
  // red marker: circle round 31 and 「1ねん」 in なお's round, right-leaning hand
  const c31 = cell(31);
  penCircle(g, c31.x + 9.5, c31.y + 7, 11, 9, red, 1.8, 72);
  hand(g, '1ねん', c31.x + 21, c31.y + 17, { ...NAO_HAND, size: 14, color: red, seed: 73, weight: 'bold' });
  setFont(g, 7, JP_FONT);
  g.fillStyle = '#777';
  g.textAlign = 'center';
  g.fillText('月見町商店会', w / 2, 268);
  grain(g, w, h, 6, 8702);
}

/** Tiny reference month (previous / next) in the calendar header. */
function miniMonth(g: G, x: number, y: number, label: string, firstDow: number, days: number): void {
  setFont(g, 7, JP_FONT, 'bold');
  g.fillStyle = '#555';
  g.textAlign = 'left';
  g.fillText(label, x, y + 6);
  setFont(g, 4.2, JP_FONT);
  g.textAlign = 'center';
  for (let d = 1; d <= days; d++) {
    const idx = firstDow + d - 1;
    const col = idx % 7;
    g.fillStyle = col === 0 ? '#c8262a' : col === 6 ? '#2b5aa8' : '#666';
    g.fillText(String(d), x + 9 + col * 5.6, y + 6 + Math.floor(idx / 7) * 4.6);
  }
}

/** Hand-drawn marker ring that overshoots where it closes. */
function penCircle(g: G, cx: number, cy: number, rx: number, ry: number, color: string, lw: number, seed: number): void {
  const R = prng(seed);
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.beginPath();
  const start = -2.3 + R() * 0.3;
  let i = 0;
  for (let a = start; a <= start + TAU + 0.55; a += 0.16, i++) {
    const k = 1 + (R() - 0.5) * 0.06 + (a - start) * 0.014;
    const px = cx + Math.cos(a) * rx * k;
    const py = cy + Math.sin(a) * ry * k;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
}

/** Calendar photo: 入道雲 over green rice fields. */
function summerScene(g: G, x: number, y: number, w: number, h: number, seed: number): void {
  const R = prng(seed);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const sky = g.createLinearGradient(0, y, 0, y + h * 0.65);
  sky.addColorStop(0, '#3f86d2');
  sky.addColorStop(1, '#bfe0f2');
  g.fillStyle = sky;
  g.fillRect(x, y, w, h);
  // cumulonimbus
  for (let i = 0; i < 26; i++) {
    const t = R();
    const cx = x + w * (0.48 + R() * 0.4);
    const cy = y + h * (0.55 - t * 0.45);
    const r = h * (0.07 + (1 - t) * 0.12) * (0.7 + R() * 0.5);
    disc(g, cx, cy + r * 0.25, r, 'rgba(170,190,215,0.9)');
    disc(g, cx, cy, r, '#fbfcfd');
  }
  poly(g, [x, y + h * 0.62, x + w * 0.2, y + h * 0.5, x + w * 0.42, y + h * 0.58, x + w * 0.7, y + h * 0.49, x + w, y + h * 0.6, x + w, y + h * 0.7, x, y + h * 0.7], '#7d98b2');
  poly(g, [x, y + h * 0.68, x + w * 0.3, y + h * 0.6, x + w * 0.55, y + h * 0.66, x + w, y + h * 0.63, x + w, y + h * 0.72, x, y + h * 0.72], '#4d7a52');
  g.fillStyle = '#76ad4a';
  g.fillRect(x, y + h * 0.71, w, h * 0.29);
  g.strokeStyle = 'rgba(40,90,30,0.45)';
  g.lineWidth = 1;
  const vx = x + w * 0.45;
  const vy = y + h * 0.66;
  for (let i = -10; i <= 14; i++) {
    g.beginPath();
    g.moveTo(vx + i * 3, y + h * 0.71);
    g.lineTo(vx + i * 22, y + h);
    g.stroke();
  }
  // a pole and its wires on the left
  g.fillStyle = '#4a4a46';
  g.fillRect(x + w * 0.12, y + h * 0.22, 2, h * 0.6);
  g.fillRect(x + w * 0.12 - 5, y + h * 0.26, 12, 1.5);
  g.strokeStyle = 'rgba(40,40,40,0.6)';
  g.lineWidth = 0.6;
  g.beginPath();
  g.moveTo(x, y + h * 0.3);
  g.quadraticCurveTo(x + w * 0.06, y + h * 0.33, x + w * 0.12, y + h * 0.27);
  g.quadraticCurveTo(x + w * 0.6, y + h * 0.42, x + w, y + h * 0.3);
  g.stroke();
  g.restore();
}

/** photo — 実家の柴犬 in the frame on the colour box (0.12 × 0.16 m print). */
function drawShibaPhoto(g: G, w: number, h: number): void {
  const k = w / 144;
  const R = prng(8801);
  g.save();
  g.scale(k, h / 192);
  // garden hedge and a strip of house wall
  g.fillStyle = '#4b7a3b';
  g.fillRect(0, 0, 144, 118);
  for (let i = 0; i < 170; i++) {
    disc(g, R() * 144, R() * 112, 2.5 + R() * 4.5, ['#5f8f4a', '#3c6830', '#6f9d55', '#456f36'][Math.floor(R() * 4)]);
  }
  g.fillStyle = '#d9cdb4';
  g.fillRect(0, 0, 22, 112);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(20, 0, 3, 112);
  // gravel yard
  g.fillStyle = '#b8ac97';
  g.fillRect(0, 112, 144, 80);
  for (let i = 0; i < 260; i++) disc(g, R() * 144, 112 + R() * 80, 0.6 + R() * 1.2, R() < 0.5 ? '#9c907b' : '#cfc4b0');
  oval(g, 72, 183, 44, 7, 'rgba(40,30,20,0.3)');
  const tan = '#c8783a';
  const cream = '#f3eadc';
  // curled tail
  g.strokeStyle = tan;
  g.lineWidth = 9;
  g.beginPath();
  g.arc(104, 122, 11, 0, TAU);
  g.stroke();
  g.strokeStyle = cream;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(104, 122, 8, 2.2, 4.4);
  g.stroke();
  // body, chest, legs
  oval(g, 72, 146, 33, 38, tan);
  oval(g, 46, 171, 13, 10, tan);
  oval(g, 98, 171, 13, 10, tan);
  oval(g, 72, 137, 19, 28, cream);
  g.fillStyle = cream;
  g.fillRect(57, 148, 10, 32);
  g.fillRect(77, 148, 10, 32);
  g.fillStyle = 'rgba(160,90,40,0.6)';
  g.fillRect(57, 148, 2, 26);
  g.fillRect(85, 148, 2, 26);
  oval(g, 62, 180, 7, 4, cream);
  oval(g, 82, 180, 7, 4, cream);
  // collar
  g.strokeStyle = '#b62a2a';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(50, 110);
  g.quadraticCurveTo(72, 121, 94, 110);
  g.stroke();
  disc(g, 72, 119, 3, '#d9b44a');
  // head
  poly(g, [46, 78, 50, 47, 67, 63], tan);
  poly(g, [98, 78, 94, 47, 77, 63], tan);
  poly(g, [51, 71, 53, 56, 62, 65], '#e7c39a');
  poly(g, [93, 71, 91, 56, 82, 65], '#e7c39a');
  oval(g, 72, 87, 30, 26, tan);
  oval(g, 58, 97, 14, 10, cream);
  oval(g, 86, 97, 14, 10, cream);
  oval(g, 72, 99, 12, 10, cream);
  oval(g, 61, 78, 3.4, 2.4, '#f4e6d2');
  oval(g, 83, 78, 3.4, 2.4, '#f4e6d2');
  oval(g, 62, 86, 3.6, 3, '#24160e');
  oval(g, 82, 86, 3.6, 3, '#24160e');
  disc(g, 61, 85, 1, '#ffffff');
  disc(g, 81, 85, 1, '#ffffff');
  poly(g, [66.5, 93, 77.5, 93, 72, 98.5], '#1b1410');
  g.strokeStyle = '#3a2a20';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(72, 98.5);
  g.lineTo(72, 101.5);
  g.moveTo(66.5, 103.5);
  g.quadraticCurveTo(72, 106, 77.5, 103.5);
  g.stroke();
  oval(g, 72, 106, 3.5, 2.6, '#d9727a');
  g.restore();
  // print look: warm cast, vignette, grain
  g.fillStyle = 'rgba(255,214,150,0.12)';
  g.fillRect(0, 0, w, h);
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.72);
  vg.addColorStop(0, 'rgba(30,20,10,0)');
  vg.addColorStop(1, 'rgba(30,20,10,0.38)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 16, 8802);
}

/** medicine_bag — 月見台クリニックの薬袋, 瀬尾 透 様 (0.14 × 0.195 m front). */
function drawMedicineBag(g: G, w: number, h: number): void {
  paper(g, w, h, '#f8f8f5', 8901, [140, 140, 130], 0.08);
  const blue = '#2a5aa8';
  rrect(g, 14, 18, w - 28, 36, 5);
  g.fillStyle = blue;
  g.fill();
  setFont(g, 23, JP_FONT, 'bold');
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  spread(g, '内服薬', 30, w - 30, 37);
  g.textBaseline = 'alphabetic';
  center(g, '瀬尾　透　様', w / 2, 78, w - 24, 15, '#1d1d1d', JP_FONT, 'bold');
  g.fillStyle = '#555';
  g.fillRect(14, 83, w - 28, 0.9);
  center(g, '1日1回　寝る前', w / 2, 102, w - 24, 13, '#1d1d1d', JP_FONT, 'bold');
  const items = ['朝', '昼', '夕', '寝る前'];
  let x = 16;
  setFont(g, 9, JP_FONT);
  g.textAlign = 'left';
  items.forEach((t, i) => {
    g.strokeStyle = '#333';
    g.lineWidth = 0.9;
    g.strokeRect(x, 110, 7, 7);
    if (i === 3) {
      g.fillStyle = blue;
      g.fillRect(x + 1.5, 111.5, 4, 4);
    }
    g.fillStyle = '#333';
    g.fillText(t, x + 9, 117);
    x += 9 + g.measureText(t).width + 8;
  });
  center(g, '1回1錠　14日分', w / 2, 136, w - 24, 11, '#1d1d1d');
  setFont(g, 6.5, JP_FONT);
  g.fillStyle = '#6a6a6a';
  wrap(g, '※お薬は子どもの手の届かない所に保管してください。', 14, 152, w - 28, 8.5);
  g.fillStyle = blue;
  g.fillRect(14, 168, w - 28, 1.2);
  center(g, '月見台クリニック', w / 2, 186, w - 24, 13, blue, JP_FONT, 'bold');
  center(g, 'TEL ××-××××-××××', w / 2, 196, w - 24, 7, '#555');
  grain(g, w, h, 6, 8902);
}

/** notebook — 仕事のノート cover (D06): 「文字起こし」 in 透's hurried, rising hand. 0.148 × 0.22 m. */
function drawNotebook(g: G, w: number, h: number): void {
  g.fillStyle = '#2e4a6b';
  g.fillRect(0, 0, w, h);
  srand(9101);
  stains(g, w, h, 6, 'rgba(255,255,255,0.04)', 40);
  grain(g, w, h, 10, 9102);
  rrect(g, 14, 36, w - 28, 66, 3);
  g.fillStyle = '#f1efe6';
  g.fill();
  setFont(g, 7, JP_FONT);
  g.fillStyle = '#8a8a8a';
  g.textAlign = 'left';
  g.fillText('No.', 19, 47);
  g.fillStyle = '#b9b9b2';
  g.fillRect(32, 48, 30, 0.8);
  g.fillRect(19, 94, w - 38, 0.8);
  handFit(g, '文字起こし', 20, 80, w - 40, { size: 19, color: '#16161a', seed: 91, font: JP_FONT, weight: 'bold', rise: 0.09, vary: 0.1, wobble: 0.1, tilt: 0.12, slant: 0.1 });
  hand(g, '8月〜', 66, 92, { size: 10, color: '#16161a', seed: 92, font: JP_FONT, rise: 0.06 });
  setFont(g, 8, JP_FONT, 'bold');
  g.fillStyle = 'rgba(235,235,230,0.8)';
  g.textBaseline = 'alphabetic';
  spread(g, 'NOTEBOOK', 30, w - 30, 168);
  setFont(g, 6, JP_FONT);
  g.textAlign = 'center';
  g.fillText('A5 ・ 7mm × 30 lines ・ 30 sheets', w / 2, 179);
  // a coffee ring and worn corners
  g.strokeStyle = 'rgba(46,28,12,0.4)';
  g.lineWidth = 2.2;
  g.beginPath();
  g.arc(88, 136, 17, 0.3, TAU - 0.6);
  g.stroke();
  g.strokeStyle = 'rgba(46,28,12,0.15)';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(88, 136, 15, 0.9, 2.6);
  g.stroke();
  for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 14);
    gr.addColorStop(0, 'rgba(200,210,220,0.35)');
    gr.addColorStop(1, 'rgba(200,210,220,0)');
    g.fillStyle = gr;
    g.fillRect(cx - 14, cy - 14, 28, 28);
  }
}

// ── town ─────────────────────────────────────────────────────────────────────

/** road_closed — board on the barricades (0.8 × 0.4 m). */
function drawRoadClosed(g: G, w: number, h: number): void {
  g.fillStyle = '#f3f3ef';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#c4161c';
  g.lineWidth = 8;
  g.strokeRect(8, 8, w - 16, h - 16);
  center(g, 'この先', w / 2, 35, 120, 18, '#1d1d1d', JP_FONT, 'bold');
  center(g, '通行止め', w / 2, 84, w - 40, 46, '#c4161c', JP_FONT, 'bold');
  center(g, '工事中　ご迷惑をおかけします', w / 2, 108, w - 44, 11, '#1d1d1d');
  // road dirt splashed on the lower half, scuffs
  const R = prng(9201);
  for (let i = 0; i < 70; i++) {
    const y = h * (0.55 + R() * 0.45);
    disc(g, R() * w, y, 0.5 + R() * 1.8, `rgba(90,75,55,${0.08 + R() * 0.2})`);
  }
  const dirt = g.createLinearGradient(0, h * 0.5, 0, h);
  dirt.addColorStop(0, 'rgba(110,95,70,0)');
  dirt.addColorStop(1, 'rgba(110,95,70,0.22)');
  g.fillStyle = dirt;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 8, 9202);
}

/** pole_sign — address plate wrapped round the utility pole (0.25 × 0.5 m). */
function drawPoleSign(g: G, w: number, h: number): void {
  const B = 128;
  g.fillStyle = '#1d4e98';
  g.fillRect(0, 0, w, B);
  setFont(g, 30, JP_FONT, 'bold');
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const y0 = (B - 3 * 36) / 2 + 18;
  ['月', '見', '町'].forEach((c, i) => g.fillText(c, w * 0.69, y0 + i * 36));
  ['二', '丁', '目'].forEach((c, i) => g.fillText(c, w * 0.31, y0 + i * 36));
  g.fillStyle = '#ecece6';
  g.fillRect(0, B, w, h - B);
  g.fillStyle = '#1d4e98';
  g.fillRect(0, B, w, 2);
  g.textBaseline = 'alphabetic';
  center(g, '月見台', w / 2, B + 20, w - 16, 15, '#2e7d4f', JP_FONT, 'bold');
  center(g, 'クリニック', w / 2, B + 38, w - 16, 15, '#2e7d4f', JP_FONT, 'bold');
  center(g, '内科・睡眠外来', w / 2, B + 51, w - 20, 8.5, '#333');
  center(g, '→ 200m', w / 2, B + 60, w - 20, 7.5, '#333');
  // rust run-off from the steel bands and road grime
  const R = prng(9301);
  for (let i = 0; i < 7; i++) {
    const x = R() * w;
    const gr = g.createLinearGradient(0, 0, 0, h * 0.7);
    gr.addColorStop(0, 'rgba(120,70,30,0.25)');
    gr.addColorStop(1, 'rgba(120,70,30,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, 1 + R() * 2, h * (0.3 + R() * 0.4));
  }
  const dirt = g.createLinearGradient(0, h * 0.6, 0, h);
  dirt.addColorStop(0, 'rgba(80,70,55,0)');
  dirt.addColorStop(1, 'rgba(80,70,55,0.25)');
  g.fillStyle = dirt;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 10, 9302);
}

// ── story objects not yet placed in the world (added) ────────────────────────

/** diary_cover (added) — D14 しずくの日記: lavender cover, 「しずく」 on the label (0.11 × 0.15 m). */
function drawDiaryCover(g: G, w: number, h: number): void {
  g.fillStyle = '#c9b9d8';
  g.fillRect(0, 0, w, h);
  srand(9401);
  stains(g, w, h, 5, 'rgba(255,255,255,0.06)', 40);
  grain(g, w, h, 8, 9402);
  setFont(g, 10, JP_SERIF, 'bold');
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.textBaseline = 'alphabetic';
  spread(g, 'DIARY', 38, w - 38, 30);
  rrect(g, 22, 70, w - 44, 40, 4);
  g.fillStyle = '#fbf9f2';
  g.fill();
  g.strokeStyle = '#a99abb';
  g.lineWidth = 1;
  g.stroke();
  handFit(g, 'しずく', 36, 98, w - 72, { size: 20, color: '#2a2630', seed: 94, font: MARU, vary: 0.06, wobble: 0.05, tilt: 0.06 });
  // a sunflower sticker
  const R = prng(9403);
  sunflower(g, w - 24, h - 26, 10, R);
  edgeShade(g, w, h, [80, 60, 100], 0.25, 10);
}

/** envelope_clinic (added) — D13 クリニックからの手紙 in the mailbox (洋形 0.235 × 0.12 m). */
function drawClinicEnvelope(g: G, w: number, h: number): void {
  paper(g, w, h, '#f6f3ea', 9501, [150, 140, 110], 0.08);
  setFont(g, 8, JP_FONT);
  g.fillStyle = '#333';
  g.textAlign = 'left';
  g.fillText('月見町二丁目　コーポ月見 103', 16, 22);
  center(g, '瀬尾　透　様', w / 2 + 6, 54, w - 60, 17, '#1b1b1b', JP_SERIF, 'bold');
  g.strokeStyle = '#555';
  g.lineWidth = 0.8;
  g.strokeRect(w - 44, 8, 34, 26);
  setFont(g, 6, JP_FONT);
  g.fillStyle = '#555';
  g.textAlign = 'center';
  g.fillText('料金後納', w - 27, 19);
  g.fillText('郵便', w - 27, 28);
  disc(g, 22, h - 18, 6, '#2e7d4f');
  disc(g, 22, h - 18, 2.5, '#f6f3ea');
  setFont(g, 10, JP_FONT, 'bold');
  g.fillStyle = '#2e7d4f';
  g.textAlign = 'left';
  g.fillText('月見台クリニック', 33, h - 14);
  setFont(g, 7, JP_FONT);
  g.fillText('睡眠外来', 33, h - 5);
  g.strokeStyle = 'rgba(196,40,36,0.8)';
  g.lineWidth = 1.2;
  g.strokeRect(w - 40, h - 30, 24, 14);
  setFont(g, 9, JP_SERIF, 'bold');
  g.fillStyle = 'rgba(196,40,36,0.8)';
  g.textAlign = 'center';
  g.fillText('親展', w - 28, h - 19.5);
  grain(g, w, h, 6, 9502);
}

// ── registry ─────────────────────────────────────────────────────────────────

export const CONTENT_TEXTURES: Record<string, TexSpec> = {
  // memos (three.js planes, extras.ts)
  memo_breaker: sheet(170, 120, drawMemoBreaker), //     0.085 × 0.06
  memo_fridge: sheet(176, 224, drawMemoFridge), //       0.11 × 0.14
  memo_nao: sheet(176, 224, drawMemoNao), //             added: D12 (0.11 × 0.14)
  // room plates: door (0.12 × 0.06) and mailbox (0.06 × 0.03)
  plate_101: plate('101'), plate_102: plate('102'), plate_103: plate('103'), plate_104: plate('104'),
  plate_201: plate('201'), plate_202: plate('202'), plate_203: plate('203'), plate_204: plate('204'),
  // town board posters (three.js planes)
  poster_missing_1: sheet(240, 336, drawShizukuPoster), // 0.30 × 0.42
  poster_missing_2: sheet(240, 336, drawCatPoster),
  poster_missing_3: sheet(240, 336, drawNotice),
  poster_notice_1: sheet(240, 240, drawRadioTaiso), //    0.30 × 0.30
  poster_notice_2: sheet(240, 240, drawNightCaution),
  // convenience store
  conbini_sign: onModel(384, 59, drawConbiniSign), //     5.6 × 0.86 (emit_)
  conbini_poster: sheet(240, 336, drawConbiniPoster), //  0.5 × 0.7
  // shrine
  shrine_yuisho: sheet(384, 272, drawYuisho), //          1.2 × 0.85
  shrine_plaque: onModel(160, 240, drawPlaque), //        0.4 × 0.6
  juyosho: onModel(320, 96, drawJuyosho), //              1.0 × 0.3
  ema_1: onModel(192, 144, drawEma1), //                  0.16 × 0.12
  ema_2: onModel(192, 144, drawEma2),
  ema_3: onModel(192, 144, drawEma3),
  // room 103 props
  photo: onModel(144, 192, drawShibaPhoto), //            0.12 × 0.16
  calendar: onModel(192, 276, drawCalendar), //           0.32 × 0.46
  medicine_bag: onModel(144, 200, drawMedicineBag), //    0.14 × 0.195
  notebook: onModel(128, 190, drawNotebook), //           0.148 × 0.22 (cover, lying flat)
  // street
  road_closed: onModel(256, 128, drawRoadClosed), //      0.8 × 0.4
  pole_sign: onModel(96, 192, drawPoleSign), //           0.25 × 0.5 (curved)
  // added, not yet placed: give them a three.js plane of the noted size
  diary_cover: sheet(132, 180, drawDiaryCover), //        D14 (0.11 × 0.15)
  envelope_clinic: sheet(192, 98, drawClinicEnvelope), // D13 (0.235 × 0.12)
};

/** Draw a quick deterministic "handwriting" scribble line (used by notes/ema). */
export function scribble(g: CanvasRenderingContext2D, x: number, y: number, len: number): void {
  g.beginPath(); g.moveTo(x, y);
  for (let i = 0; i < len; i += 3) g.lineTo(x + i, y + (rnd() - 0.5) * 3);
  g.stroke();
}
