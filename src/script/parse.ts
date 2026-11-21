// script/*.nani（シナリオライター用の台本ファイル。Naninovel の書き方に寄せている）の読み取り。書式は script/README.md。
// DOM にも Vite にも依存しない（tools/validate.mjs も使う）。

/** 台本の1ブロック = `# 名前` から次の `#` まで */
export interface Block {
  /** 「ファイル名.ブロック名」 例: ch1.washer_face */
  key: string;
  /** 本文の行（前後の空行は除く。途中の空行は '' として残す） */
  lines: string[];
  file: string;
  /** `#` のある行番号（1始まり） */
  line: number;
}

/**
 * 台本ファイル1つを読む。
 * - `# 名前` … ブロックの始まり（Naninovel のラベル）。最初の空白までが名前
 * - `; 〜` … コメント（読み飛ばす）
 * - 行頭の `\` … 次の1文字を特別扱いしない（`\#` `\;` `\nao: …` など）。`\` 自体は消える
 * - 最初の `#` より前の行は読み飛ばす
 */
export function parseScript(file: string, src: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/[ \t]+$/, '');
    if (raw.startsWith('#')) {
      const name = raw.slice(1).trim().split(/\s/)[0];
      cur = { key: `${file}.${name}`, lines: [], file, line: i + 1 };
      blocks.push(cur);
      continue;
    }
    if (raw.startsWith(';')) continue;
    if (!cur) continue;
    cur.lines.push(raw);
  }
  for (const b of blocks) {
    while (b.lines.length && b.lines[0] === '') b.lines.shift();
    while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
  }
  return blocks;
}

/** 行頭の `\` を外す（エスケープ）。台詞の話者判定より後に呼ぶ */
export function unescape(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line;
}

export type LineKind = 'talk' | 'mono' | 'narr';
export interface Line {
  kind: LineKind;
  speaker: string | null;
  text: string;
}

/** `nao: 台詞` の形。話者はアルファベットの ID。コロンは半角・全角どちらでも、後ろの空白はあってもなくてもよい */
const SPEAKER_LINE = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*[:：][ 　]?([\s\S]*)$/;

/** 話者 ID → 画面に出す名前（system.nani の speakers） */
export type SpeakerTable = ReadonlyMap<string, string>;

/** system.nani の speakers ブロック（`nao: なお` の行）を読む */
export function parseSpeakers(lines: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines) {
    const r = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*[:：][ 　]?(.+)$/.exec(l.trim());
    if (r) m.set(r[1], r[2].trim());
  }
  return m;
}

/**
 * 台詞1行を読む。
 * - `nao: 起きてる？` … 話者つきの台詞（話者 ID は system.nani の speakers に載っているものだけ）
 * - `narr: ……` … ナレーション（中央表示）
 * - それ以外 … 主人公（透）のモノローグ
 */
export function parseLine(raw: string, speakers: SpeakerTable): Line {
  if (!raw.startsWith('\\')) {
    const m = SPEAKER_LINE.exec(raw);
    if (m) {
      if (m[1] === 'narr') return { kind: 'narr', speaker: null, text: m[2] };
      const name = speakers.get(m[1]);
      if (name !== undefined) return { kind: 'talk', speaker: name, text: m[2] };
    }
  }
  return { kind: 'mono', speaker: null, text: unescape(raw) };
}

/** 話者 ID らしいのに話者表にない（打ち間違いかもしれない）行の ID。モノローグでよければ行頭に \\ */
export function unknownSpeaker(raw: string, speakers: SpeakerTable): string | null {
  if (raw.startsWith('\\')) return null;
  const m = SPEAKER_LINE.exec(raw);
  if (!m || m[1] === 'narr' || speakers.has(m[1])) return null;
  return m[1];
}

/** `{name}` を差し込む */
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
