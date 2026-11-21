// Bundled by tools/validate.mjs and executed in node: dumps every id the game knows.
import CATALOG from '../src/world/catalog.json';
import { LAYOUT } from '../src/world/layout';
import { BASE_TEXTURES } from '../src/world/textures';
import { CONTENT_TEXTURES } from '../src/world/textures_content';
import { CORE_SOUNDS } from '../src/audio/sounds';
import { SOUND_LIBRARY } from '../src/audio/sounds_lib';
import { EXTRA_SOUNDS } from '../src/audio/sounds_extra';
import { DOCS } from '../src/game/content/docs';
import { ITEMS } from '../src/game/content/items';
import { SHOPS } from '../src/game/content/shops';
import { ENDINGS } from '../src/game/content/endings';
import { CHAPTERS } from '../src/game/chapters';
import { allBlocks, duplicateKeys, speakers } from '../src/script';
import { unknownSpeaker } from '../src/script/parse';
import { META } from '../src/game/content/meta';

const props = LAYOUT.props.map((p) => p.id);
const interact = new Set<string>();
for (const p of LAYOUT.props) if (p.interact !== false) interact.add(p.interact ?? p.id);
for (const p of LAYOUT.posters) if (p.interact) interact.add(p.interact);

export const IDS = {
  models: Object.keys((CATALOG as { models: Record<string, unknown> }).models),
  props,
  propModels: Object.fromEntries(LAYOUT.props.map((p) => [p.id, p.model])),
  interact: [...interact],
  anchors: LAYOUT.anchors.map((a) => a.id),
  zones: LAYOUT.zones.map((z) => z.id),
  lights: LAYOUT.lights.map((l) => l.id),
  posters: LAYOUT.posters.map((p) => p.id),
  spawns: Object.keys(LAYOUT.spawns),
  npcs: ['npc_clerk', 'npc_shrine', 'npc_neighbor', 'npc_nao', 'npc_nao_sit', 'npc_extra'],
  textures: [...Object.keys(BASE_TEXTURES), ...Object.keys(CONTENT_TEXTURES), 'mw_display'],
  sounds: [...Object.keys(CORE_SOUNDS), ...Object.keys(SOUND_LIBRARY), ...Object.keys(EXTRA_SOUNDS)],
  docs: Object.keys(DOCS),
  items: Object.keys(ITEMS),
  shops: Object.keys(SHOPS),
  shopItems: Object.values(SHOPS).flatMap((s) => s.items.map((i) => i.item)),
  endings: Object.keys(ENDINGS),
  scriptKeys: allBlocks().map((b) => b.key),
  scriptDupes: duplicateKeys(),
  scriptMissing: missingInContent(),
  contentKeys: contentKeys(),
  scriptSpeakerLike: speakerLike(),
  chapters: CHAPTERS.map((c) => ({ id: c.id, spawn: typeof c.spawn === 'string' ? c.spawn : null })),
};

/** `id: …` の形なのに話者表に ID がない行（モノローグとして表示されてしまう）。意図したモノローグなら行頭に \\ */
function speakerLike(): string[] {
  const sp = speakers();
  const out: string[] = [];
  for (const b of allBlocks()) {
    if (!/^ch\d|^common$/.test(b.file)) continue;
    b.lines.forEach((l, i) => {
      const name = unknownSpeaker(l, sp);
      if (name) out.push(`${b.file}.nani ${b.key}（${b.line + i + 1}行目あたり）: 話者 ID「${name}」が system.nani の speakers にない（モノローグなら行頭に \\）`);
    });
  }
  return out;
}

/** content/*.ts の文字列で台本が見つからなかったもの（T() は【キー】を返す） */
function missingInContent(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { const m = /^【(.+)】$/.exec(v); if (m) out.push(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([DOCS, ITEMS, SHOPS, ENDINGS, META]);
  return out;
}

/** content/*.ts が id から組み立てて使っている台本のキー */
function contentKeys(): string[] {
  const k: string[] = [];
  for (const id of Object.keys(DOCS)) k.push(`docs.${id}.title`, `docs.${id}`);
  for (const id of Object.keys(ENDINGS)) k.push(`endings.${id}.name`, `endings.${id}.label`, `endings.${id}`);
  for (const id of Object.keys(ITEMS)) k.push(`items.${id}.name`, `items.${id}.desc`);
  for (const [sid, s] of Object.entries(SHOPS)) {
    k.push(`items.shop_${sid}.title`);
    for (const it of s.items) k.push(`items.shop_${sid}.${it.item}.name`, `items.shop_${sid}.${it.item}.desc`);
  }
  return k;
}
