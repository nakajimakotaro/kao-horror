import { T, TL } from '../../script';
import type { EndingDef } from './types';

// エンディングの名前とロールは台本 script/endings.nani。エンディング直前の場面は script/ch5.nani。
const ending = (id: string): EndingDef => ({ id, name: T(`endings.${id}.name`), label: T(`endings.${id}.label`), lines: TL(`endings.${id}`, undefined, true) });

export const ENDINGS: Record<string, EndingDef> = {
  end1_ohayou: ending('end1_ohayou'),
  end2_omote: ending('end2_omote'),
  end3_nezunoban: ending('end3_nezunoban'),
};
