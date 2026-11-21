// 台本（script/*.nani）をゲームから引く入口。
//   T('ch1.objective_light')            … ブロック全体を1つの文字列で（行は改行でつなぐ）
//   TL('system.tips')                   … ブロックを行の配列で（空行は除く）
//   lines('ch1.washer_face')            … 台詞として読む（話者・モノローグ・ナレ）→ Ctx.play() が使う
// 見つからないキーは【キー】を返して警告する（ゲームは止めない）。
import { type Block, type Line, fill, parseLine, parseScript, parseSpeakers, unescape } from './parse';

const FILES = import.meta.glob('/script/*.nani', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const BLOCKS = new Map<string, Block>();
const DUPES: string[] = [];
for (const [path, src] of Object.entries(FILES)) {
  const file = path.replace(/^.*\//, '').replace(/\.nani$/, '');
  for (const b of parseScript(file, src)) {
    if (BLOCKS.has(b.key)) {
      DUPES.push(`${file}.nani:${b.line}  ブロック ${b.key} が二重に定義されている`);
      console.warn(`[script] ${DUPES[DUPES.length - 1]}`);
    }
    BLOCKS.set(b.key, b);
  }
}

/** 話者 ID → 表示名（system.nani の speakers） */
const SPEAKERS = parseSpeakers(BLOCKS.get('system.speakers')?.lines ?? []);

type Vars = Record<string, string | number>;

function get(key: string): Block | null {
  const b = BLOCKS.get(key);
  if (!b) console.warn(`[script] 台本にないキー: ${key}`);
  return b ?? null;
}

/** ブロック全体を1つの文字列で（途中の空行も残す）。文書の本文・目標・ラベルなど */
export function T(key: string, vars?: Vars): string {
  const b = get(key);
  if (!b) return `【${key}】`;
  return fill(b.lines.map(unescape).join('\n'), vars);
}

/** ブロックを行の配列で。`keepBlank` なら空行も '' として残す（エンディングロールなど） */
export function TL(key: string, vars?: Vars, keepBlank = false): string[] {
  const b = get(key);
  if (!b) return [`【${key}】`];
  return b.lines.filter((l) => keepBlank || l !== '').map((l) => fill(unescape(l), vars));
}

/** 台詞として読む。空行は読み飛ばす */
export function lines(key: string, vars?: Vars): Line[] {
  const b = get(key);
  if (!b) return [{ kind: 'mono', speaker: null, text: `【${key}】` }];
  return b.lines.filter((l) => l !== '').map((l) => {
    const p = parseLine(l, SPEAKERS);
    return { ...p, text: fill(p.text, vars) };
  });
}

/** すべてのブロック（tools/validate.mjs 用） */
export function allBlocks(): Block[] {
  return [...BLOCKS.values()];
}
export function speakers(): ReadonlyMap<string, string> {
  return SPEAKERS;
}
export function duplicateKeys(): string[] {
  return DUPES;
}
