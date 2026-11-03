export type FlagValue = boolean | number | string;

export interface Snapshot {
  version: 1;
  chapter: string;
  checkpoint: string | null;
  flags: Record<string, FlagValue>;
  inv: Record<string, number>;
  money: number;
  battery: number;
  /** player position for mid-chapter checkpoints */
  pos?: [number, number, number, number];
  savedAt: number;
}

const SAVE_KEY = 'kao.save.v1';
const ENDINGS_KEY = 'kao.endings.v1';

/** Everything that persists between checkpoints. */
export class GameState {
  chapter = '';
  checkpoint: string | null = null;
  flags: Record<string, FlagValue> = {};
  inv: Record<string, number> = {};
  money = 0;
  battery = 1;
  pos: Snapshot['pos'];

  reset(): void {
    this.chapter = '';
    this.checkpoint = null;
    this.flags = {};
    this.inv = {};
    this.money = 0;
    this.battery = 1;
    this.pos = undefined;
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      chapter: this.chapter,
      checkpoint: this.checkpoint,
      flags: structuredClone(this.flags),
      inv: { ...this.inv },
      money: this.money,
      battery: this.battery,
      pos: this.pos,
      savedAt: Date.now(),
    };
  }

  restore(s: Snapshot): void {
    this.chapter = s.chapter;
    this.checkpoint = s.checkpoint;
    this.flags = structuredClone(s.flags);
    this.inv = { ...s.inv };
    this.money = s.money;
    this.battery = s.battery;
    this.pos = s.pos;
  }

  save(s: Snapshot = this.snapshot()): void {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  static load(): Snapshot | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Snapshot;
      return s.version === 1 && s.chapter ? s : null;
    } catch {
      return null;
    }
  }

  static clearSave(): void {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  }

  static endings(): string[] {
    try { return JSON.parse(localStorage.getItem(ENDINGS_KEY) ?? '[]') as string[]; } catch { return []; }
  }

  static addEnding(id: string): void {
    const all = new Set(GameState.endings());
    all.add(id);
    try { localStorage.setItem(ENDINGS_KEY, JSON.stringify([...all])); } catch { /* ignore */ }
  }

  has(item: string): boolean {
    return (this.inv[item] ?? 0) > 0;
  }

  give(item: string, n = 1): void {
    this.inv[item] = (this.inv[item] ?? 0) + n;
  }

  take(item: string, n = 1): boolean {
    const c = this.inv[item] ?? 0;
    if (c < n) return false;
    if (c - n <= 0) delete this.inv[item];
    else this.inv[item] = c - n;
    return true;
  }
}
