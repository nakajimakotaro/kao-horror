import * as THREE from 'three';
import type { Engine } from '../core/Engine';

/** Hand-held flashlight: lagging spot light with shadows, battery and a view model. */
export class Flashlight {
  readonly spot: THREE.SpotLight;
  private readonly aim = new THREE.Object3D();
  private readonly dir = new THREE.Vector3(0, 0, -1);
  private readonly viewGroup = new THREE.Group();
  private readonly holder = new THREE.Group();
  private lens: THREE.MeshStandardMaterial | null = null;
  owned = false;
  on = false;
  /** scripts can forbid using it */
  enabled = true;
  /** battery seconds for a full charge */
  capacity = 420;
  intensity = 26;
  private flick = 1;
  private flickT = 0;
  private sway = 0;

  constructor(private readonly engine: Engine) {
    this.spot = new THREE.SpotLight(0xfff1d8, 0, 24, 0.46, 0.62, 2);
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.camera.near = 0.1;
    this.spot.shadow.camera.far = 24;
    this.spot.shadow.bias = -0.0004;
    this.spot.shadow.normalBias = 0.025;
    this.spot.target = this.aim;
    engine.scene.add(this.spot, this.aim);
    // view model: a simple handle until the Blender model is attached
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.17, 10), new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.6 }));
    body.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.019, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0x9a9a9e, roughness: 0.35, metalness: 0.7 }));
    head.rotation.x = Math.PI / 2;
    head.position.z = -0.1;
    const lens = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xfff3d0, emissiveIntensity: 0 });
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.023, 12), lens);
    glass.position.z = -0.126;
    glass.rotation.y = Math.PI;
    this.lens = lens;
    this.holder.add(body, head, glass);
    this.holder.position.set(0.2, -0.205, -0.38);
    this.holder.rotation.set(0.06, 0.08, 0);
    this.viewGroup.add(this.holder);
    const fill = new THREE.HemisphereLight(0x9aa0b0, 0x111111, 0.6);
    this.viewGroup.add(fill);
    engine.viewScene.add(this.viewGroup);
    this.viewGroup.visible = false;
  }

  /** Replace the procedural view model with the Blender one. */
  setModel(obj: THREE.Object3D): void {
    this.holder.clear();
    obj.scale.setScalar(0.72);
    obj.rotation.set(0, 0, 0);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === 'emit_lens') this.lens = mat;
    });
    this.holder.add(obj);
  }

  /** Returns a message if the action failed. */
  toggle(battery: number): string | null {
    if (!this.owned) return null;
    if (!this.enabled) return '今は使えない。';
    if (!this.on && battery <= 0) return '電池が切れている。';
    this.on = !this.on;
    return null;
  }

  /** 0..1 how strongly a world point is lit by the beam. */
  litAmount(p: THREE.Vector3): number {
    if (!this.on || this.spot.intensity <= 0.01) return 0;
    const to = p.clone().sub(this.spot.position);
    const d = to.length();
    if (d > this.spot.distance) return 0;
    const cos = to.normalize().dot(this.dir);
    const edge = Math.cos(this.spot.angle);
    if (cos < edge) return 0;
    return Math.min(1, ((cos - edge) / (1 - edge)) * 3) * Math.max(0, 1 - d / this.spot.distance) * this.flick;
  }

  /** Returns battery after drain. */
  update(dt: number, battery: number, fear: number, cam: THREE.PerspectiveCamera, visibleView: boolean): number {
    if (this.on) battery = Math.max(0, battery - dt / this.capacity);
    if (battery <= 0) this.on = false;
    // flicker when low or when something is near
    this.flickT -= dt;
    const unstable = (battery < 0.18 ? (0.18 - battery) * 4 : 0) + fear * 0.5;
    if (this.flickT <= 0) {
      this.flick = Math.random() < unstable * 0.5 ? 0.05 + Math.random() * 0.3 : 1;
      this.flickT = this.flick < 1 ? 0.04 + Math.random() * 0.12 : 0.1 + Math.random() * 0.6;
    }
    const target = this.on ? this.intensity * this.flick * (battery < 0.1 ? 0.45 + battery * 5.5 : 1) : 0;
    this.spot.intensity = target;
    // lagging aim
    const want = new THREE.Vector3();
    cam.getWorldDirection(want);
    this.dir.lerp(want, 1 - Math.exp(-dt * 14)).normalize();
    const right = new THREE.Vector3().crossVectors(want, cam.up).normalize();
    this.spot.position.copy(cam.position).addScaledVector(right, 0.14).add(new THREE.Vector3(0, -0.16, 0));
    this.aim.position.copy(this.spot.position).add(this.dir);
    this.viewGroup.visible = this.owned && visibleView;
    this.viewGroup.position.copy(cam.position);
    this.viewGroup.quaternion.copy(cam.quaternion);
    this.sway += dt;
    this.holder.position.y = -0.205 + Math.sin(this.sway * 1.6) * 0.003;
    if (this.lens) this.lens.emissiveIntensity = this.on ? 1.5 * this.flick : 0;
    return battery;
  }
}
