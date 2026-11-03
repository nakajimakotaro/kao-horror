import type { ChapterDef } from '../Chapter';
import { ch1_night } from './ch1_night';
import { ch2_day } from './ch2_day';
import { ch3_night } from './ch3_night';
import { ch4_day } from './ch4_day';
import { ch5_night } from './ch5_night';

/** Story order. The first entry is where a new game starts. */
export const CHAPTERS: ChapterDef[] = [ch1_night, ch2_day, ch3_night, ch4_day, ch5_night];
