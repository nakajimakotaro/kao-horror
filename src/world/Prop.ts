import * as THREE from 'three';
import type { Collider } from '../core/Collision';
import type { PartSpec } from './Assets';
import type { PropDef, V3 } from './types';

const DEG = Math.PI / 180;

interface PartState {
  node: THREE.Object3D;
  spec: PartSpec;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
  baseScale: THREE.Vector3;
  t: number;
  target: number;
  speed: number;
  waiters: (() => void)[];
  collider?: Collider;
}

interface GlowMat {
  mat: THREE.MeshStandardMaterial;
  color: THREE.Color;
  intensity: number;
}

/** A placed model instance: animated parts (doors, lids), glow materials, colliders. */
export class Prop {
  readonly parts = new Map<string, PartState>();
  readonly colliders: Collider[] = [];
  readonly meshes: THREE.Mesh[] = [];
  readonly glows = new Map<string, GlowMat[]>();
  readonly firstPart: string | null;
  interactId: string | null;
  private _visible = true;

  constructor(readonly def: PropDef, readonly root: THREE.Object3D, parts: Record<string, PartSpec>) {
    this.interactId = def.interact === false ? null : def.interact ?? def.id;
    let first: string | null = null;
    for (const [name, spec] of Object.entries(parts)) {
      const node = root.getObjectByName(name);
      if (!node) continue;
      first ??= name;
      this.parts.set(name, {
        node, spec, basePos: node.position.clone(), baseRot: node.rotation.clone(), baseScale: node.scale.clone(),
        t: 0, target: 0, speed: 1, waiters: [],
      });
    }
    this.firstPart = first;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.meshes.push(m);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (!sm.name?.startsWith('emit_') || !sm.emissive) continue;
        const list = this.glows.get(sm.name) ?? [];
        if (!list.some((g) => g.mat === sm)) {
          const color = sm.emissive.clone();
          if (color.r + color.g + color.b < 0.01) color.set(sm.color ?? 0xffffff);
          list.push({ mat: sm, color, intensity: Math.max(1, sm.emissiveIntensity || 1) });
        }
        this.glows.set(sm.name, list);
      }
    });
  }

  get id(): string {
    return this.def.id;
  }

  get model(): string {
    return this.def.model;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.root.visible = v;
    for (const c of this.colliders) c.enabled = v;
    for (const p of this.parts.values()) if (p.collider) p.collider.enabled = v && p.t < 0.5;
  }

  node(name: string): THREE.Object3D | undefined {
    return this.root.getObjectByName(name);
  }

  showNode(name: string, visible: boolean): void {
    const n = this.node(name);
    if (n) n.visible = visible;
  }

  hasPart(part?: string): boolean {
    return this.parts.has(part ?? this.firstPart ?? '');
  }

  private part(part?: string): PartState | undefined {
    return this.parts.get(part ?? this.firstPart ?? '');
  }

  openAmount(part?: string): number {
    return this.part(part)?.t ?? 0;
  }

  isOpen(part?: string): boolean {
    const p = this.part(part);
    return p ? p.target > 0.5 : false;
  }

  /** Animate a part to an open fraction (0 = closed, 1 = open). */
  animate(target: number, part?: string, sec = 0.6): Promise<void> {
    const p = this.part(part);
    if (!p) return Promise.resolve();
    p.target = Math.max(0, Math.min(1, target));
    p.speed = 1 / Math.max(0.01, sec);
    if (Math.abs(p.t - p.target) < 1e-4) {
      this.apply(p);
      return Promise.resolve();
    }
    return new Promise((resolve) => p.waiters.push(resolve));
  }

  open(part?: string, sec = 0.6): Promise<void> {
    return this.animate(1, part, sec);
  }

  close(part?: string, sec = 0.6): Promise<void> {
    return this.animate(0, part, sec);
  }

  toggle(part?: string, sec = 0.6): Promise<void> {
    return this.isOpen(part) ? this.close(part, sec) : this.open(part, sec);
  }

  /** Jump to an open fraction without animation. */
  setOpen(t: number, part?: string): void {
    const parts = part === '*' ? [...this.parts.values()] : [this.part(part)].filter(Boolean) as PartState[];
    for (const p of parts) {
      p.t = p.target = Math.max(0, Math.min(1, t));
      this.apply(p);
      for (const w of p.waiters.splice(0)) w();
    }
  }

  update(dt: number): void {
    for (const p of this.parts.values()) {
      if (p.t === p.target) continue;
      const step = dt * p.speed;
      p.t = p.t < p.target ? Math.min(p.target, p.t + step) : Math.max(p.target, p.t - step);
      this.apply(p);
      if (p.t === p.target) for (const w of p.waiters.splice(0)) w();
    }
  }

  private apply(p: PartState): void {
    const e = p.t * p.t * (3 - 2 * p.t);
    const v = p.spec.open * e;
    const n = p.node;
    switch (p.spec.anim) {
      case 'rotX': n.rotation.x = p.baseRot.x + v * DEG; break;
      case 'rotY': n.rotation.y = p.baseRot.y + v * DEG; break;
      case 'rotZ': n.rotation.z = p.baseRot.z + v * DEG; break;
      case 'slideX': n.position.x = p.basePos.x + v; break;
      case 'slideY': n.position.y = p.basePos.y + v; break;
      case 'slideZ': n.position.z = p.basePos.z + v; break;
      case 'scaleX': n.scale.x = p.baseScale.x * (1 + (p.spec.open - 1) * e); break;
      case 'scaleZ': n.scale.z = p.baseScale.z * (1 + (p.spec.open - 1) * e); break;
    }
    if (p.collider) p.collider.enabled = this._visible && p.t < 0.5;
  }

  /** Turn emit_* materials on/off. `mat` limits to one material name. */
  setGlow(level: number, mat?: string): void {
    for (const [name, list] of this.glows) {
      if (mat && name !== mat) continue;
      for (const g of list) {
        g.mat.emissive.copy(g.color);
        g.mat.emissiveIntensity = g.intensity * level;
      }
    }
  }

  hasGlow(mat?: string): boolean {
    return mat ? this.glows.has(mat) : this.glows.size > 0;
  }

  materials(name: string): THREE.MeshStandardMaterial[] {
    const out: THREE.MeshStandardMaterial[] = [];
    for (const m of this.meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (mat.name === name && !out.includes(mat as THREE.MeshStandardMaterial)) out.push(mat as THREE.MeshStandardMaterial);
    }
    return out;
  }

  /** Prop-local coordinates → world. */
  toWorld(local: V3 | THREE.Vector3): THREE.Vector3 {
    const v = Array.isArray(local) ? new THREE.Vector3(...local) : local.clone();
    this.root.updateWorldMatrix(true, false);
    return v.applyMatrix4(this.root.matrixWorld);
  }

  get position(): THREE.Vector3 {
    return this.root.getWorldPosition(new THREE.Vector3());
  }

  /** Attach a collider that follows a part's open state (door leaves). */
  bindPartCollider(part: string, c: Collider): void {
    const p = this.parts.get(part);
    if (p) {
      p.collider = c;
      c.enabled = p.t < 0.5;
    }
  }
}
