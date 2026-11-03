import type { TimeOfDay } from '../world/types';
import type { Ctx } from './Ctx';

export type SpawnSpec = string | { pos: [number, number, number]; yaw: number };

/**
 * One checkpointed segment of the story. Chapters are plain objects registered
 * in chapters/index.ts. `setup` wires interactions/zones/NPCs/faces for the
 * chapter (synchronously); `intro` is the opening cutscene.
 */
export interface ChapterDef {
  id: string;
  /** chapter card title, e.g. 「一日目」 (omit for no card) */
  title?: string;
  /** chapter card subtitle, e.g. 「午前三時」 */
  subtitle?: string;
  time: TimeOfDay;
  /** spawn id from layout.spawns, or an explicit position + yaw; may be a function of the chapter state */
  spawn: SpawnSpec | ((c: Ctx) => SpawnSpec);
  /** initial clock (h, m); `rate` = game minutes per real second (0 = frozen) */
  clock?: { h: number; m: number; rate?: number };
  ambience?: string | null;
  /** set money at chapter start */
  money?: number;
  /** flashlight starts on if owned */
  flashlightOn?: boolean;
  /** start the chapter lying in bed with the wake-up animation (may depend on flags) */
  wakeUp?: boolean | ((c: Ctx) => boolean);
  setup(c: Ctx): void;
  intro?(c: Ctx): Promise<void>;
  update?(c: Ctx, dt: number): void;
  /** text for the game over screen when a face kills in this chapter */
  gameOverReason?: string;
}
