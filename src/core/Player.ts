import * as THREE from 'three';
import type { Input } from './Input';
import type { CollisionWorld } from './Collision';

const DEG = Math.PI / 180;

export interface CameraOverride {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll?: number;
}

/** First-person walker: yaw/pitch look, smoothed movement, head bob, footsteps. */
export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector2();
  yaw = 0;
  pitch = 0;
  radius = 0.22;
  eyeHeight = 1.55;
  walkSpeed = 1.45;
  runSpeed = 2.75;
  sensitivity = 1;
  invertY = false;
  canMove = true;
  canLook = true;
  noclip = false;
  running = false;
  /** limits look (peephole) — degrees around a center yaw/pitch */
  lookLimit: { yaw: number; pitch: number; cy: number; cp: number } | null = null;
  override: CameraOverride | null = null;
  shake = 0;
  roll = 0;
  onStep: ((run: boolean) => void) | null = null;
  private bobPhase = 0;
  private bobAmount = 0;
  private stepAccum = 0;
  private tween: {
    y0: number; y1: number; p0: number; p1: number; t: number; dur: number; resolve: () => void;
  } | null = null;
  private readonly tmp = new THREE.Vector3();

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  get speed(): number {
    return this.vel.length();
  }

  teleport(x: number, y: number, z: number, yawDeg?: number, pitchDeg = 0): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0);
    if (yawDeg !== undefined) this.yaw = yawDeg * DEG;
    this.pitch = pitchDeg * DEG;
  }

  /** Smoothly turn the head toward a world point. */
  lookAt(target: THREE.Vector3, dur = 0.8): Promise<void> {
    const eye = this.tmp.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    const d = target.clone().sub(eye);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    let dy = yaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.tween?.resolve();
    return new Promise((resolve) => {
      this.tween = { y0: this.yaw, y1: this.yaw + dy, p0: this.pitch, p1: pitch, t: 0, dur: Math.max(0.01, dur), resolve };
    });
  }

  update(dt: number, input: Input, col: CollisionWorld): void {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.dur, tw.t + dt);
      const k = tw.t / tw.dur;
      const e = k * k * (3 - 2 * k);
      this.yaw = tw.y0 + (tw.y1 - tw.y0) * e;
      this.pitch = tw.p0 + (tw.p1 - tw.p0) * e;
      if (tw.t >= tw.dur) {
        this.tween = null;
        tw.resolve();
      }
    } else if (this.canLook && input.locked) {
      const s = 0.0022 * this.sensitivity;
      this.yaw -= input.mouseDX * s;
      this.pitch -= input.mouseDY * s * (this.invertY ? -1 : 1);
      this.pitch = Math.max(-85 * DEG, Math.min(85 * DEG, this.pitch));
      if (this.lookLimit) {
        const L = this.lookLimit;
        this.yaw = Math.max(L.cy - L.yaw * DEG, Math.min(L.cy + L.yaw * DEG, this.yaw));
        this.pitch = Math.max(L.cp - L.pitch * DEG, Math.min(L.cp + L.pitch * DEG, this.pitch));
      }
    }

    let ix = 0, iz = 0;
    if (this.canMove) {
      if (input.isDown('forward')) iz -= 1;
      if (input.isDown('back')) iz += 1;
      if (input.isDown('left')) ix -= 1;
      if (input.isDown('right')) ix += 1;
    }
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }
    this.running = this.canMove && len > 0 && input.isDown('run');
    const speed = this.running ? this.runSpeed : this.walkSpeed;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // local (ix right, iz back) → world
    const wx = ix * cos + iz * sin;
    const wz = -ix * sin + iz * cos;
    const k = 1 - Math.exp(-dt * (len > 0 ? 9 : 12));
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.y += (wz * speed - this.vel.y) * k;
    if (!this.canMove && this.vel.lengthSq() < 1e-4) this.vel.set(0, 0);

    const dist = this.vel.length() * dt;
    if (dist > 1e-5) {
      const steps = Math.max(1, Math.ceil(dist / 0.07));
      const sx = (this.vel.x * dt) / steps, sz = (this.vel.y * dt) / steps;
      for (let i = 0; i < steps; i++) {
        const px = this.pos.x, pz = this.pos.z;
        const p = { x: px + sx, z: pz + sz };
        if (!this.noclip) {
          col.resolve(p, this.radius);
          if (!col.insideWalkable(p.x, p.z)) {
            if (col.insideWalkable(p.x, pz)) p.z = pz;
            else if (col.insideWalkable(px, p.z)) p.x = px;
            else { p.x = px; p.z = pz; }
          }
        }
        this.pos.x = p.x;
        this.pos.z = p.z;
      }
      const moved = Math.min(dist, this.vel.length() * dt);
      this.bobPhase += (moved * Math.PI) / (this.running ? 0.85 : 0.68);
      this.stepAccum += (moved * Math.PI) / (this.running ? 0.85 : 0.68);
      if (this.stepAccum >= Math.PI) {
        this.stepAccum -= Math.PI;
        this.onStep?.(this.running);
      }
    }
    const target = Math.min(1, this.vel.length() / this.walkSpeed);
    this.bobAmount += (target - this.bobAmount) * Math.min(1, dt * 6);
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }

  applyCamera(cam: THREE.PerspectiveCamera, time: number): void {
    if (this.override) {
      const o = this.override;
      cam.position.copy(o.pos);
      cam.rotation.set(o.pitch, o.yaw, o.roll ?? 0, 'YXZ');
      return;
    }
    const b = this.bobAmount * (this.running ? 1.5 : 1);
    const bobY = Math.sin(this.bobPhase * 2) * 0.022 * b;
    const bobX = Math.cos(this.bobPhase) * 0.014 * b;
    const s = this.shake * this.shake;
    const jx = (Math.sin(time * 61.3) + Math.sin(time * 37.1)) * 0.012 * s;
    const jy = (Math.sin(time * 53.7) + Math.cos(time * 29.3)) * 0.012 * s;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    cam.position.set(this.pos.x + bobX * cos, this.pos.y + this.eyeHeight + bobY + jy, this.pos.z - bobX * sin);
    cam.rotation.set(this.pitch + jy * 0.5, this.yaw + jx, this.roll + Math.sin(this.bobPhase) * 0.004 * b, 'YXZ');
  }
}
