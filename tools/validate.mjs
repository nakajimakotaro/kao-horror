#!/usr/bin/env node
// Static cross-check of story scripts against the world data:
// every prop/anchor/zone/light/doc/item/sound/chapter id used in src/game/chapters/*.ts must exist.
//   npm run validate
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'kao-validate-'));
const out = join(tmp, 'ids.mjs');
try {
  execFileSync(join(root, 'node_modules', '.bin', 'rolldown'), ['-c', join(root, 'tools', 'rolldown.validate.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VALIDATE_OUT: out } });
} catch (e) {
  console.error('bundle failed:\n' + (e.stderr?.toString() ?? e));
  process.exit(2);
}
const { IDS } = await import(pathToFileURL(out).href);
rmSync(tmp, { recursive: true, force: true });

const defaultsSrc = readFileSync(join(root, 'src/game/defaults.ts'), 'utf8');
const defaultIds = [...defaultsSrc.matchAll(/case '([^']+)'/g)].map((m) => m[1]);
const set = (a) => new Set(a);
const S = {
  prop: set(IDS.props), interact: set([...IDS.interact, ...IDS.npcs, ...defaultIds]), anchor: set(IDS.anchors), zone: set(IDS.zones),
  light: set(IDS.lights), poster: set(IDS.posters), spawn: set(IDS.spawns), npc: set(IDS.npcs), tex: set(IDS.textures),
  sound: set(IDS.sounds), doc: set(IDS.docs), item: set(IDS.items), shop: set(IDS.shops), ending: set(IDS.endings), chapter: set(IDS.chapters.map((c) => c.id)),
};
const place = (id) => S.anchor.has(id) || S.prop.has(id) || S.spawn.has(id);

const rules = [
  [/\bc\.(?:on|off|reset|useDefault|defaultLabel)\(\s*'([^']+)'/g, (id) => S.interact.has(id), 'interact id'],
  [/\bc\.prop\(\s*'([^']+)'/g, (id) => S.prop.has(id), 'prop'],
  [/\bc\.light\(\s*'([^']+)'/g, (id) => S.light.has(id), 'light'],
  [/\bc\.(?:face|anchor|clearFace)\(\s*'([^']+)'/g, (id) => S.anchor.has(id), 'anchor'],
  [/\bc\.lookAt\(\s*'([^']+)'/g, (id) => place(id) || S.npc.has(id), 'anchor/prop/npc'],
  [/\bat:\s*'([^']+)'/g, place, 'anchor/prop (at:)'],
  [/\bc\.(?:zone|inZone)\(\s*'([^']+)'/g, (id) => S.zone.has(id), 'zone'],
  [/\bc\.doc\(\s*'([^']+)'/g, (id) => S.doc.has(id), 'doc'],
  [/\bc\.(?:give|take|has|count)\(\s*'([^']+)'/g, (id) => S.item.has(id), 'item'],
  [/\bc\.shop\(\s*'([^']+)'/g, (id) => S.shop.has(id), 'shop'],
  [/\bc\.(?:sfx|loop|ambience)\(\s*'([^']+)'/g, (id) => S.sound.has(id), 'sound'],
  [/\bc\.(?:npc|hideNpc)\(\s*'([^']+)'/g, (id) => S.npc.has(id), 'npc'],
  [/\bc\.goto\(\s*'([^']+)'/g, (id) => S.chapter.has(id), 'chapter'],
  [/\bc\.ending\(\s*'([^']+)'/g, (id) => S.ending.has(id), 'ending'],
  [/\bc\.poster\(\s*'([^']+)'/g, (id) => S.poster.has(id), 'poster'],
  [/\btex:\s*'([^']+)'/g, (id) => S.tex.has(id), 'texture'],
  [/\bc\.teleport\(\s*'([^']+)'/g, (id) => S.spawn.has(id) || S.anchor.has(id), 'spawn/anchor'],
];

const problems = [];
const dir = join(root, 'src/game/chapters');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(dir, f), 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const [re, ok, kind] of rules) {
    for (const m of src.matchAll(re)) {
      if (!ok(m[1])) problems.push(`${relative(root, join(dir, f))}:${lineOf(m.index)}  unknown ${kind}: '${m[1]}'`);
    }
  }
}
// ── 台本（script/*.nani）: コードが使うキーが台本にあるか／台本に使われていないブロックがないか ──
const blockKeys = new Set(IDS.scriptKeys);
const usedKeys = new Set();
// 台本のキーらしい文字列リテラルはすべて検査する（look(c, …, 'common.x') のように関数に渡すものも）
const scriptRe = /'((?:ch\d|common|system|docs|items|endings)\.[A-Za-z0-9_.]+)'/g;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
for (const f of walk(join(root, 'src'))) {
  if (f.includes(join('src', 'script'))) continue;
  // content/ は id から `docs.${id}` のようにキーを組み立てる（下の scriptMissing で検査する）
  const isContent = f.includes(join('src', 'game', 'content'));
  const src = readFileSync(f, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(scriptRe)) {
    usedKeys.add(m[1]);
    if (!blockKeys.has(m[1])) problems.push(`${relative(root, f)}:${lineOf(m.index)}  台本にないキー: '${m[1]}'`);
  }
  // キーは文字列リテラルで書く（`ch1.${x}` だと検査できない）
  if (!isContent) for (const m of src.matchAll(/\b(?:T|TL|lines|c\.play|c\.subLine)\(\s*`/g)) problems.push(`${relative(root, f)}:${lineOf(m.index)}  台本のキーはテンプレート文字列にしない`);
}
for (const d of IDS.scriptDupes) problems.push(`script/${d}`);
for (const k of IDS.scriptMissing) problems.push(`src/game/content: 台本にないキー: '${k}'`);
const contentFile = /^(docs|items|endings)\./;
const unused = IDS.scriptKeys.filter((k) => !usedKeys.has(k) && k !== 'system.speakers' && !(contentFile.test(k) && !IDS.scriptMissing.length && IDS.contentKeys.includes(k)));
for (const k of unused) console.log(`（注意）台本のブロック '${k}' はコードから使われていない`);
for (const b of IDS.scriptSpeakerLike) problems.push(`script/${b}`);

for (const c of IDS.chapters) if (c.spawn && !S.spawn.has(c.spawn)) problems.push(`chapter ${c.id}: unknown spawn '${c.spawn}'`);
for (const it of IDS.shopItems) if (!S.item.has(it)) problems.push(`shops.ts: unknown item '${it}'`);
const missingModels = [...new Set(Object.values(IDS.propModels))].filter((m) => !IDS.models.includes(m));
for (const m of missingModels) problems.push(`layout.ts: model '${m}' not in catalog.json`);

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n✗ ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`✓ chapters reference only known ids (${blockKeys.size} script blocks, ${IDS.chapters.length} chapters, ${IDS.docs.length} docs, ${IDS.items.length} items, ${IDS.sounds.length} sounds)`);
