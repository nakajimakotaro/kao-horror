import * as THREE from 'three';
import type { World } from '../world/World';

export interface InteractDef {
  /** prompt label; return null when there is nothing to do right now */
  label: string | (() => string | null);
  use: () => void | Promise<void>;
  /** usable with closed eyes when it was the last thing aimed at (default false) */
  blind?: boolean;
  /** reach in meters (default 2.0) */
  range?: number;
}

export interface Target {
  id: string;
  label: string;
  def: InteractDef;
  dist: number;
  blind: boolean;
}

/** Ray from the screen center → interaction id → prompt and use. */
export class Interaction {
  /** per-chapter definitions (override defaults) */
  readonly defs = new Map<string, InteractDef>();
  /** world defaults, built lazily with the current chapter context */
  resolveDefault: (id: string) => InteractDef | null = () => null;
  current: Target | null = null;
  busy = false;
  enabled = true;
  private last: { id: string; time: number } | null = null;
  /** set by scripts: the target usable with closed eyes regardless of what was aimed at */
  forcedBlind: string | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly dir = new THREE.Vector3();
  private time = 0;

  constructor(private readonly world: World) {}

  clear(): void {
    this.defs.clear();
    this.current = null;
    this.last = null;
    this.forcedBlind = null;
    this.busy = false;
  }

  resolve(id: string): InteractDef | null {
    return this.defs.get(id) ?? this.resolveDefault(id);
  }

  private labelOf(def: InteractDef): string | null {
    try {
      return typeof def.label === 'function' ? def.label() : def.label;
    } catch (e) {
      console.warn('[interact] label failed', e);
      return null;
    }
  }

  update(dt: number, cam: THREE.PerspectiveCamera, eyesClosed: boolean): void {
    this.time += dt;
    this.current = null;
    if (!this.enabled || this.busy) return;
    if (eyesClosed) {
      if (this.forcedBlind) {
        const def = this.resolve(this.forcedBlind);
        const label = def && def.blind === true ? this.labelOf(def) : null;
        if (def && label) { this.current = { id: this.forcedBlind, label, def, dist: 0, blind: true }; return; }
      }
      if (this.last && this.time - this.last.time < 1.6) {
        const def = this.resolve(this.last.id);
        const label = def && def.blind === true ? this.labelOf(def) : null;
        if (def && label) this.current = { id: this.last.id, label, def, dist: 0, blind: true };
      }
      return;
    }
    cam.getWorldDirection(this.dir);
    this.ray.set(cam.position, this.dir);
    this.ray.near = 0;
    this.ray.far = 3.2;
    const hits = this.ray.intersectObjects(this.world.rayCandidates(cam.position, 3.4), false);
    for (const h of hits) {
      if (!isVisibleDeep(h.object)) continue;
      if ((h.object as THREE.Mesh).material && ((h.object as THREE.Mesh).material as THREE.Material).transparent && !h.object.userData.interactId) continue;
      const id = findInteractId(h.object);
      if (!id) return; // something solid in the way
      const def = this.resolve(id);
      if (!def) return;
      if (h.distance > (def.range ?? (id.startsWith('npc_') ? 2.8 : 2.0))) return;
      const label = this.labelOf(def);
      if (!label) return;
      this.current = { id, label, def, dist: h.distance, blind: false };
      this.last = { id, time: this.time };
      return;
    }
  }

  /** Run the current target's action. Resolves when the action finishes. */
  async trigger(): Promise<boolean> {
    const t = this.current;
    if (!t || this.busy) return false;
    this.busy = true;
    try {
      await t.def.use();
    } finally {
      this.busy = false;
    }
    return true;
  }
}

function findInteractId(o: THREE.Object3D): string | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (p.userData.interactId !== undefined) return p.userData.interactId as string | null;
  }
  return null;
}

function isVisibleDeep(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
