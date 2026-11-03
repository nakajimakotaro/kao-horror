import type { DocKind } from '../../ui/UI';

export interface ItemDef {
  id: string;
  name: string;
  desc: string;
  /** one glyph shown in the inventory list */
  icon?: string;
}

export interface DocDef {
  id: string;
  title: string;
  body: string;
  kind?: DocKind;
}

export interface ShopItem {
  item: string;
  price: number;
  /** name/description shown in this shop (defaults to ITEMS) */
  name?: string;
  desc?: string;
  /** max purchasable per chapter (default unlimited) */
  limit?: number;
}

export interface ShopDef {
  id: string;
  title: string;
  items: ShopItem[];
}

export interface EndingDef {
  id: string;
  /** e.g. 「目覚め」 */
  name: string;
  /** e.g. "END 1" */
  label: string;
  /** epilogue lines shown on the ending roll */
  lines: string[];
}

export interface GameMeta {
  title: string;
  titleSub: string;
  warn: string;
  tips: string[];
  credits: string[];
  /** game over screen texts */
  gameOverTitle: string;
  gameOverHint: string;
}
