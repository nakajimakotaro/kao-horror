import { T, TL } from '../../script';
import type { GameMeta } from './types';

// 文言は台本 script/system.nani。
export const META: GameMeta = {
  title: T('system.title'),
  titleSub: T('system.title_sub'),
  warn: T('system.warn'),
  tips: TL('system.tips'),
  credits: TL('system.credits'),
  gameOverTitle: T('system.gameover_title'),
  gameOverHint: T('system.gameover_hint'),
};
