import * as THREE from 'three';
import { createFaceVisual, type FaceVisual } from './FaceVisual';

export type FaceType = 'static' | 'fleeting' | 'approach' | 'peek';

export interface FaceOptions {
  type?: FaceType;
  /** size multiplier (1 = life size, about 0.3 m tall) */
  scale?: number;
  /** seconds of continuous staring before game over (default 2) */
  lethal?: number;
  /** turn to face the camera (default true) */
  lookAt?: boolean;
  /** fixed facing (deg, camera yaw convention) when lookAt is false */
  yaw?: number;
  /** 'flat' = drawn on a surface (TV, mirror, photo) */
  style?: 'head' | 'flat';
  /** approach speed m/s */
  speed?: number;
  /** approach stops at this distance */
  minDist?: number;
  /** self-illumination 0..1 */
  glow?: number;
  /** visual variant hint for FaceVisual */
  variant?: string;
  /** prop that contains this face (its body does not block line of sight; its doors do) */
  owner?: string | null;
  /** fleeting faces vanish this long after being seen even if still watched */
  vanishAfter?: number;
  /** cannot kill (scripted moments) */
  harmless?: boolean;
  onSeen?: () => void;
  onVanish?: () => void;
}

export class Face {
  readonly id: number;
  readonly pos: THREE.Vector3;
  gaze = 0;
  seen = false;
  seenTime = 0;
  inView = false;
  centered = false;
  alive = true;
  age = 0;
  private outOfView = 0;
  dying = 0;
  readonly visual: FaceVisual;

  constructor(id: number, pos: THREE.Vector3, readonly opts: FaceOptions, readonly anchor: string | null) {
    this.id = id;
    this.pos = pos.clone();
    this.visual = createFaceVisual(opts);
    this.visual.object.position.copy(pos);
  }

  get type(): FaceType {
    return this.opts.type ?? 'static';
  }

  get lethal(): number {
    return this.opts.lethal ?? 2;
  }

  /** returns true when it should vanish */
  tickVisibility(dt: number, visible: boolean): boolean {
    if (visible) {
      this.outOfView = 0;
      if (!this.seen) {
        this.seen = true;
        this.opts.onSeen?.();
      }
      this.seenTime += dt;
    } else if (this.seen) this.outOfView += dt;
    if (this.type === 'fleeting') {
      if (this.seen && this.outOfView > 0.25) return true;
      if (this.opts.vanishAfter && this.seenTime > this.opts.vanishAfter) return true;
    }
    return false;
  }
}

export interface FaceUpdateContext {
  /** gameplay running (no modal UI, not paused) */
  active: boolean;
  eyesClosed: boolean;
  camera: THREE.PerspectiveCamera;
  /** flashlight cone check: returns 0..1 how lit a point is */
  litBy: (p: THREE.Vector3) => number;
}

const CENTER_DEG = 10;

/**
 * Spawns faces and enforces the rule: a face kept near the center of view for
 * `lethal` seconds (default 2) kills. Looking away drains the meter; closed
 * eyes see nothing.
 */
export class FaceSystem {
  readonly faces: Face[] = [];
  readonly group = new THREE.Group();
  enabled = true;
  /** debug: never lethal */
  god = false;
  /** 0..1 strongest normalized gaze this frame */
  maxGaze = 0;
  /** 0..1 how close/visible the nearest face is */
  presence = 0;
  onLethal: ((f: Face) => void) | null = null;
  onSeen: ((f: Face) => void) | null = null;
  private nextId = 1;
  private readonly ray = new THREE.Raycaster();
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private locked: Face | null = null;

  constructor(scene: THREE.Scene, private readonly occluders: (a: THREE.Vector3, b: THREE.Vector3) => THREE.Mesh[]) {
    scene.add(this.group);
  }

  spawn(pos: THREE.Vector3, opts: FaceOptions = {}, anchor: string | null = null): Face {
    if (anchor) this.remove(anchor, false);
    const f = new Face(this.nextId++, pos, opts, anchor);
    this.faces.push(f);
    this.group.add(f.visual.object);
    return f;
  }

  remove(target: Face | string | number, fade = true): void {
    for (const f of [...this.faces]) {
      const hit = typeof target === 'string' ? f.anchor === target : typeof target === 'number' ? f.id === target : f === target;
      if (!hit) continue;
      if (fade) f.dying = Math.max(f.dying, 0.0001);
      else this.kill(f);
    }
  }

  private kill(f: Face): void {
    f.alive = false;
    this.group.remove(f.visual.object);
    f.visual.dispose();
    const i = this.faces.indexOf(f);
    if (i >= 0) this.faces.splice(i, 1);
    f.opts.onVanish?.();
  }

  clear(): void {
    for (const f of [...this.faces]) this.kill(f);
    this.maxGaze = 0;
    this.presence = 0;
    this.locked = null;
  }

  /** Line of sight from the camera to a point, ignoring the owner prop's body. */
  visibleFrom(cam: THREE.Vector3, p: THREE.Vector3, owner?: string | null): boolean {
    const dir = this.tmpDir.copy(p).sub(cam);
    const dist = dir.length();
    if (dist < 0.05) return true;
    dir.divideScalar(dist);
    this.ray.set(cam, dir);
    this.ray.near = 0.02;
    this.ray.far = dist - 0.06;
    for (const m of this.occluders(cam, p)) {
      if (!m.visible || !isVisibleDeep(m)) continue;
      if (owner && m.userData.occOwner === owner && !m.userData.occPart) continue;
      const bs = m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere!);
      // cheap reject: distance from sphere center to the ray segment
      const c = this.tmp2.copy(bs.center).applyMatrix4(m.matrixWorld);
      const r = bs.radius * m.matrixWorld.getMaxScaleOnAxis();
      const t = Math.max(0, Math.min(dist, c.clone().sub(cam).dot(dir)));
      if (c.distanceToSquared(cam.clone().addScaledVector(dir, t)) > r * r) continue;
      if (this.ray.intersectObject(m, false).length) return false;
    }
    return true;
  }
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();

  update(dt: number, ctx: FaceUpdateContext): void {
    const cam = ctx.camera.position;
    ctx.camera.getWorldDirection(this.fwd);
    const halfFov = (ctx.camera.fov * ctx.camera.aspect * 0.5 * Math.PI) / 180;
    const viewLimit = Math.min(1.25, halfFov * 0.62 + 0.25);
    let maxG = 0;
    let presence = 0;
    for (const f of [...this.faces]) {
      f.age += dt;
      if (f.dying > 0) {
        f.dying += dt;
        f.visual.setFade(Math.max(0, 1 - f.dying / 0.35));
        if (f.dying > 0.35) this.kill(f);
        continue;
      }
      // approach movement happens only while unseen
      const to = this.tmp.copy(f.pos).sub(cam);
      const dist = to.length();
      const angle = dist > 1e-4 ? Math.acos(Math.max(-1, Math.min(1, to.dot(this.fwd) / dist))) : 0;
      const sizeSlack = Math.atan2(0.15 * (f.opts.scale ?? 1), Math.max(0.2, dist));
      const los = dist < 40 && this.visibleFrom(cam, f.pos, f.opts.owner);
      const eyesOpen = !ctx.eyesClosed;
      f.inView = eyesOpen && los && angle < viewLimit;
      f.centered = eyesOpen && los && angle < (CENTER_DEG * Math.PI) / 180 + sizeSlack && dist < 22;
      if (ctx.active && this.enabled) {
        if (f.type === 'approach' && !f.inView) {
          const minD = f.opts.minDist ?? 0.75;
          if (dist > minD) {
            const step = Math.min(dist - minD, (f.opts.speed ?? 0.55) * dt);
            const dir = to.clone().multiplyScalar(-1 / dist);
            f.pos.x += dir.x * step;
            f.pos.z += dir.z * step;
            f.pos.y += (cam.y - 0.05 - f.pos.y) * Math.min(1, dt * 0.8);
          }
        }
        const wasSeen = f.seen;
        if (f.tickVisibility(dt, f.inView)) { f.dying = 0.0001; continue; }
        if (!wasSeen && f.seen) this.onSeen?.(f);
        const grace = f.age < 0.35;
        if (f.centered && !grace) f.gaze += dt;
        else f.gaze = Math.max(0, f.gaze - dt * 1.25);
        if (f.gaze >= f.lethal && !f.opts.harmless && !this.god && !this.locked) {
          this.locked = f;
          this.onLethal?.(f);
        }
      }
      const g = Math.min(1, f.gaze / f.lethal);
      maxG = Math.max(maxG, g);
      if (f.inView) presence = Math.max(presence, Math.max(0, 1 - dist / 8));
      // visuals
      const obj = f.visual.object;
      obj.position.copy(f.pos);
      if (f.opts.lookAt !== false) {
        obj.lookAt(cam);
      } else {
        obj.rotation.set(0, ((f.opts.yaw ?? 0) + 180) * (Math.PI / 180), 0);
      }
      f.visual.update(dt, { gaze: g, lit: ctx.litBy(f.pos), dist, time: f.age });
    }
    this.maxGaze = maxG;
    this.presence = presence;
  }

  /** The face rushes into the camera (game over). */
  async jumpscare(f: Face, camera: THREE.PerspectiveCamera): Promise<void> {
    const obj = f.visual.object;
    const start = obj.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const end = camera.position.clone().addScaledVector(dir, 0.32);
    f.visual.setScream(true);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 260);
        obj.position.lerpVectors(start, end, k * k);
        obj.lookAt(camera.position);
        obj.scale.setScalar(1 + k * 0.6);
        if (k < 1) requestAnimationFrame(step); else resolve();
      };
      step();
    });
  }

  releaseLock(): void {
    this.locked = null;
  }
}

function isVisibleDeep(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
