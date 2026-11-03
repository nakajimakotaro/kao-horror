import * as THREE from 'three';
import type { TimeOfDay } from './types';

interface SkyPreset { top: string; horizon: string; bottom: string; stars: number; moon: boolean; sun: boolean }

const PRESETS: Record<TimeOfDay, SkyPreset> = {
  night: { top: '#03040a', horizon: '#141a28', bottom: '#05060a', stars: 0.9, moon: true, sun: false },
  dawn: { top: '#1c2840', horizon: '#9a8a90', bottom: '#2a2a30', stars: 0.2, moon: true, sun: false },
  day: { top: '#5e9bd6', horizon: '#cfe0ea', bottom: '#b8c4c8', stars: 0, moon: false, sun: true },
  evening: { top: '#3b4f7c', horizon: '#f0a070', bottom: '#5a4a48', stars: 0, moon: false, sun: true },
};

/** Gradient dome, stars and moon that follow the camera. */
export class Sky {
  readonly group = new THREE.Group();
  private readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly moon: THREE.Mesh;

  constructor() {
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(190, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() } },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom; varying vec3 vP;
          void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h,0.0,1.0), 0.55)) : mix(uHorizon, uBottom, clamp(-h*4.0,0.0,1.0));
          gl_FragColor = vec4(c, 1.0); }`,
      }),
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    const pts: number[] = [];
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 700; i++) {
      const th = r() * Math.PI * 2, y = 0.08 + r() * 0.92, rad = Math.sqrt(1 - y * y);
      pts.push(Math.cos(th) * rad * 180, y * 180, Math.sin(th) * rad * 180);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.8, fog: false, depthWrite: false }));
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(5.5, 20), new THREE.MeshBasicMaterial({ color: 0xf2ead0, fog: false }));
    this.moon.position.set(-80, 70, -120);
    this.moon.lookAt(0, 0, 0);
    this.moon.renderOrder = -8;
    this.group.add(this.dome, this.stars, this.moon);
  }

  setTime(t: TimeOfDay): void {
    const p = PRESETS[t];
    const u = this.dome.material.uniforms;
    u.uTop.value.set(p.top);
    u.uHorizon.value.set(p.horizon);
    u.uBottom.value.set(p.bottom);
    this.stars.visible = p.stars > 0;
    this.stars.material.opacity = p.stars;
    this.moon.visible = p.moon;
  }

  horizon(t: TimeOfDay): THREE.Color {
    return new THREE.Color(PRESETS[t].horizon);
  }

  update(camPos: THREE.Vector3): void {
    this.group.position.copy(camPos);
  }
}
