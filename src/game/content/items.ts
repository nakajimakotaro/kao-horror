import { T } from '../../script';
import type { ItemDef } from './types';

// 名前と説明は台本 script/items.nani（`items.<id>.name` / `items.<id>.desc`）。
// Engine-level ids: flashlight (F key), battery (auto swap), omamori (absorbs one lethal stare).
const item = (id: string, icon: string): ItemDef => ({ id, name: T(`items.${id}.name`), desc: T(`items.${id}.desc`), icon });

export const ITEMS: Record<string, ItemDef> = {
  flashlight: item('flashlight', '◉'),
  battery: item('battery', '▮'),
  omamori: item('omamori', '⛩'),
  incense: item('incense', '｜'),
  coffee: item('coffee', '▯'),
  milktea: item('milktea', '▯'),
  diary: item('diary', '▤'),
  hairpin: item('hairpin', '✿'),
  number_memo: item('number_memo', '✎'),
  coin10: item('coin10', '●'),
};
