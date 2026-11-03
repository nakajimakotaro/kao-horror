import * as THREE from 'three';
import type { LightDef, TimeOfDay } from './types';
import type { Prop } from './Prop';

const POOL_SIZE = 6;

/** Script-facing handle for one light (real or pooled). */
export class LightCtl {
  on = false;
  flicker = false;
  /** multiplier set by scripts (dimming), 1 = normal */
  level = 1;
  /** current animated output 0..1 (after flicker) */
  out = 0;
  pos = new THREE.Vector3();
  real: THREE.PointLight | null = null;
  private flickerTimer = 0;
  private flickerState = 1;
  glowProps: { prop: Prop; mat?: string }[] = [];

  constructor(readonly def: LightDef) {
    this.flicker = !!def.flicker;
  }

  get id(): string {
    return this.def.id;
  }

  setOn(v: boolean): this {
    this.on = v;
    return this;
  }

  setFlicker(v: boolean): this {
    this.flicker = v;
    return this;
  }

  tick(dt: number): void {
    let target = this.on ? this.level : 0;
    if (this.on && this.flicker) {
      this.flickerTimer -= dt;
      if (this.flickerTimer <= 0) {
        if (this.flickerState > 0.5) {
          this.flickerState = Math.random() < 0.15 ? 0.15 : 0;
          this.flickerTimer = Math.random() < 0.12 ? 0.4 + Math.random() * 0.8 : 0.03 + Math.random() * 0.12;
        } else {
          this.flickerState = 1;
          this.flickerTimer = Math.random() < 0.3 ? 0.05 + Math.random() * 0.2 : 0.6 + Math.random() * 3.5;
        }
      }
      target *= this.flickerState;
    }
    this.out = target;
    for (const g of this.glowProps) g.prop.setGlow(target > 0.05 ? Math.max(0.25, target) : 0, g.mat);
  }
}

/**
 * Keeps the number of THREE lights constant (no shader recompiles):
 * dedicated lights for the apartment, and a small pool that follows the
 * nearest outdoor lamps.
 */
export class LightManager {
  readonly ctls = new Map<string, LightCtl>();
  private readonly pool: THREE.PointLight[] = [];
  private readonly pooled: LightCtl[] = [];
  cameraRegion: 'apt' | 'out' | 'conbini' = 'out';
  portalOpen: (propId: string) => boolean = () => false;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.pool.push(l);
      scene.add(l);
    }
  }

  add(def: LightDef, pos: THREE.Vector3, glow: { prop: Prop; mat?: string }[]): LightCtl {
    const ctl = new LightCtl(def);
    ctl.pos.copy(pos);
    ctl.glowProps = glow;
    if (def.kind === 'pooled') {
      this.pooled.push(ctl);
    } else {
      const l = new THREE.PointLight(new THREE.Color(def.color), 0, def.distance ?? 8, 2);
      l.position.copy(pos);
      l.castShadow = false;
      this.scene.add(l);
      ctl.real = l;
    }
    this.ctls.set(def.id, ctl);
    return ctl;
  }

  /** Apply time-of-day defaults. `all` (chapter start) also switches off lights without a time default. */
  applyTime(t: TimeOfDay, all = true): void {
    for (const c of this.ctls.values()) {
      const d = c.def.on;
      if (!d) {
        if (all) { c.on = false; c.level = 1; c.flicker = !!c.def.flicker; }
        continue;
      }
      const on = t === 'day' ? d.day : t === 'evening' ? (d.evening ?? d.night) : t === 'dawn' ? (d.dawn ?? d.night) : d.night;
      c.on = !!on;
      c.level = 1;
      c.flicker = !!c.def.flicker;
    }
  }

  private damp(c: LightCtl): number {
    const r = c.def.region ?? 'out';
    if (r === this.cameraRegion) return 1;
    if (c.def.portal && this.portalOpen(c.def.portal)) return 1;
    if (r === 'out' && this.cameraRegion === 'apt') return 0.06;
    if (r === 'apt' && this.cameraRegion !== 'apt') return 0.35;
    return 1;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    for (const c of this.ctls.values()) c.tick(dt);
    for (const c of this.ctls.values()) {
      if (!c.real) continue;
      c.real.intensity = c.def.intensity * c.out * this.damp(c);
    }
    // nearest active pooled lights
    const active = this.pooled
      .filter((c) => c.out > 0.01)
      .map((c) => ({ c, d: c.pos.distanceToSquared(camPos) - (c.def.distance ?? 10) ** 2 * 0.25 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.pool.length);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const a = active[i];
      if (!a) { l.intensity = 0; continue; }
      l.position.copy(a.c.pos);
      l.color.set(a.c.def.color);
      l.distance = a.c.def.distance ?? 10;
      l.intensity = a.c.def.intensity * a.c.out * this.damp(a.c);
    }
  }
}
