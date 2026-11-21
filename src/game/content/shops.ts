import { T } from '../../script';
import type { ShopDef, ShopItem } from './types';

// docs/SCENARIO.md §4。店の名前・品物の表示名と説明は台本 script/items.nani（`items.shop_<店>.title` / `items.shop_<店>.<item>.name|desc`）。
const shop = (id: string, items: ShopItem[]): ShopDef => ({
  id,
  title: T(`items.shop_${id}.title`),
  items: items.map((it) => ({ ...it, name: T(`items.shop_${id}.${it.item}.name`), desc: T(`items.shop_${id}.${it.item}.desc`) })),
});

export const SHOPS: Record<string, ShopDef> = {
  conbini: shop('conbini', [{ item: 'battery', price: 330 }, { item: 'incense', price: 280 }, { item: 'milktea', price: 150 }]),
  vending: shop('vending', [{ item: 'coffee', price: 130 }, { item: 'milktea', price: 130 }]),
  juyosho: shop('juyosho', [{ item: 'omamori', price: 500, limit: 1 }]),
};
