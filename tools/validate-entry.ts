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
  chapters: CHAPTERS.map((c) => ({ id: c.id, spawn: typeof c.spawn === 'string' ? c.spawn : null })),
};
