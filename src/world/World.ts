import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Collider, CollisionWorld } from '../core/Collision';
import { Assets, MODELS, fallbackModel } from './Assets';
import { LightCtl, LightManager } from './Lights';
import { Prop } from './Prop';
import { Sky } from './Sky';
import { addScenarioExtras, type NodeDefault } from './extras';
import type { TextureLib } from './textures';
import type { BoxDef, Layout, PosterDef, Rect, SpawnDef, Surface, TimeOfDay, V3, WallDef } from './types';

const DEG = Math.PI / 180;

const VC_MATS = new Map<string, THREE.MeshStandardMaterial>();
/** Shared vertex-colored material for a roughness/metalness bucket. */
function vcMaterial(rough: number, metal: number): { key: string; mat: THREE.MeshStandardMaterial } {
  const r = rough < 0.35 ? 0.25 : rough < 0.7 ? 0.55 : 0.88;
  const m = metal > 0.5 ? 0.7 : 0;
  const key = `${r}|${m}`;
  let mat = VC_MATS.get(key);
  if (!mat) VC_MATS.set(key, (mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: r, metalness: m, name: `vc_${key}` })));
  return { key, mat };
}

/** Materials that scripts or the renderer treat specially must keep their own meshes. */
function special(mat: THREE.MeshStandardMaterial): boolean {
  const n = mat.name ?? '';
  return !!(mat.map || mat.transparent || mat.emissiveMap || /^(emit_|tex_|screen_|glass|mirror|water)/.test(n));
}

/** Clone a mesh's geometry into `space`, keep position/normal and bake the material color as vertex color. */
function bakeColored(m: THREE.Mesh, toSpace: THREE.Matrix4): THREE.BufferGeometry {
  const src = m.geometry;
  let g = src.index ? src.toNonIndexed() : src.clone();
  for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(a)) g.deleteAttribute(a);
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  const mat = m.material as THREE.MeshStandardMaterial;
  const col = mat.color ?? new THREE.Color(1, 1, 1);
  const n = g.attributes.position.count;
  const out = new Float32Array(n * 3);
  const prev = g.attributes.color as THREE.BufferAttribute | undefined;
  for (let i = 0; i < n; i++) {
    const pr = prev ? prev.getX(i) : 1, pg = prev ? prev.getY(i) : 1, pb = prev ? prev.getZ(i) : 1;
    out[i * 3] = col.r * pr; out[i * 3 + 1] = col.g * pg; out[i * 3 + 2] = col.b * pb;
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3));
  g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toSpace, m.matrixWorld));
  g = g.index ? g.toNonIndexed() : g;
  return g;
}

/** Buckets meshes by world position so per-frame ray tests only touch nearby ones. */
class MeshGrid {
  private readonly cells = new Map<string, { m: THREE.Mesh; c: THREE.Vector3; r: number }[]>();
  private readonly big: THREE.Mesh[] = [];
  private readonly dynamic: THREE.Mesh[] = [];
  private static readonly S = 4;

  add(m: THREE.Mesh, dynamic = false): void {
    if (dynamic) { this.dynamic.push(m); return; }
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    m.updateWorldMatrix(true, false);
    const c = g.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld);
    const r = g.boundingSphere!.radius * m.matrixWorld.getMaxScaleOnAxis();
    if (r > 6) { this.big.push(m); return; }
    const k = `${Math.floor(c.x / MeshGrid.S)},${Math.floor(c.z / MeshGrid.S)}`;
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push({ m, c, r });
  }

  query(p: THREE.Vector3, r: number): THREE.Mesh[] {
    const out = [...this.big, ...this.dynamic];
    const S = MeshGrid.S, pad = 6;
    const x0 = Math.floor((p.x - r - pad) / S), x1 = Math.floor((p.x + r + pad) / S);
    const z0 = Math.floor((p.z - r - pad) / S), z1 = Math.floor((p.z + r + pad) / S);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const cell = this.cells.get(`${x},${z}`);
      if (!cell) continue;
      for (const e of cell) if (e.c.distanceTo(p) <= r + e.r) out.push(e.m);
    }
    return out;
  }
}

interface Bucket { pos: number[]; nrm: number[]; uv: number[]; idx: number[] }

interface TimePreset {
  fog: string; fogDensity?: number; fogNear?: number; fogFar?: number;
  hemiSky: string; hemiGround: string; hemi: number; hemiIndoor: number;
  sun: number; sunColor: string; sunDir: V3; sunShadow: boolean; exposure: number;
}

const TIME: Record<TimeOfDay, TimePreset> = {
  night: { fog: '#070910', fogDensity: 0.05, hemiSky: '#2a3654', hemiGround: '#0b0b0e', hemi: 0.14, hemiIndoor: 0.035, sun: 0.07, sunColor: '#8ea4d0', sunDir: [-0.5, 0.8, -0.6], sunShadow: false, exposure: 1.0 },
  dawn: { fog: '#5d6270', fogDensity: 0.03, hemiSky: '#8e98b8', hemiGround: '#3a3632', hemi: 0.5, hemiIndoor: 0.22, sun: 0.4, sunColor: '#c8b0b8', sunDir: [0.6, 0.25, -0.3], sunShadow: false, exposure: 1.0 },
  day: { fog: '#cfe0ea', fogNear: 35, fogFar: 170, hemiSky: '#eaf3ff', hemiGround: '#8a8068', hemi: 1.7, hemiIndoor: 0.95, sun: 2.6, sunColor: '#fff0d6', sunDir: [0.45, 1, 0.3], sunShadow: true, exposure: 1.0 },
  evening: { fog: '#c89880', fogNear: 25, fogFar: 140, hemiSky: '#f0b890', hemiGround: '#4c3a30', hemi: 0.75, hemiIndoor: 0.35, sun: 1.6, sunColor: '#ffae6a', sunDir: [0.8, 0.28, 0.2], sunShadow: true, exposure: 1.0 },
};

const ROUGH: Record<string, number> = { conbini_floor: 0.35, floor_wood: 0.55, floor_kitchen: 0.6, floor_bath: 0.5, wall_bath: 0.45, metal_panel: 0.5, roof_metal: 0.6 };

export class Npc {
  visible = false;
  lookAtPlayer = true;
  /** phone screen lights the face from below (scenario A-3) */
  phoneGlow = false;
  yaw = 0;
  talk: (() => Promise<void>) | null = null;
  label: string | null = null;
  readonly head: THREE.Object3D | null;
  readonly meshes: THREE.Mesh[] = [];
  private t = Math.random() * 10;

  constructor(readonly id: string, readonly root: THREE.Group, readonly collider: Collider) {
    this.head = root.getObjectByName('head') ?? null;
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.meshes.push(o as THREE.Mesh); });
    root.visible = false;
    collider.enabled = false;
  }

  update(dt: number, cam: THREE.Vector3): void {
    if (!this.visible) return;
    this.t += dt;
    const body = this.root.children[0];
    if (body) body.scale.y = 1 + Math.sin(this.t * 1.7) * 0.006;
    if (!this.head) return;
    let target = 0;
    if (this.lookAtPlayer) {
      const dx = cam.x - this.root.position.x, dz = cam.z - this.root.position.z;
      if (dx * dx + dz * dz < 25) {
        const want = Math.atan2(dx, dz) - this.root.rotation.y;
        let a = want;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        target = Math.max(-1.0, Math.min(1.0, a));
      }
    }
    this.head.rotation.y += (target - this.head.rotation.y) * Math.min(1, dt * 4);
  }
}

/**
 * Builds the continuous town from LAYOUT and exposes it to scripts:
 * props, lights, anchors, zones, posters, NPCs and the time of day.
 */
export class World {
  readonly root = new THREE.Group();
  readonly props = new Map<string, Prop>();
  readonly anchors = new Map<string, { pos: THREE.Vector3; yaw: number }>();
  readonly zones = new Map<string, { rect: Rect; region?: string }>();
  readonly posters = new Map<string, { mesh: THREE.Mesh; def: PosterDef }>();
  readonly npcs = new Map<string, Npc>();
  readonly lights: LightManager;
  readonly sky = new Sky();
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.1);
  readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  /** meshes that can be hit by the interaction ray (and block it) */
  readonly rayMeshes: THREE.Mesh[] = [];
  /** meshes that block a face's line of sight */
  readonly occluders: THREE.Mesh[] = [];
  readonly locks = new Map<string, boolean>();
  time: TimeOfDay = 'night';
  power = true;
  layout!: Layout;
  private floorRects: { rect: Rect; surface: Surface; layer: number }[] = [];
  private preset = TIME.night;
  private hemiLevel = 0.1;
  private sunTarget = new THREE.Object3D();
  private posterDefaults = new Map<string, { tex: string; visible: boolean }>();
  private blinkT = 0;
  private nodeDefaults: NodeDefault[] = [];
  private readonly levers = new Map<string, number>();
  /** cold light of a phone screen held by an NPC */
  readonly phoneLight = new THREE.PointLight(0xdfe9ff, 0, 1.4, 2);
  private readonly rayGrid = new MeshGrid();
  private readonly occGrid = new MeshGrid();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly col: CollisionWorld,
    private readonly tex: TextureLib,
    private readonly assets: Assets,
  ) {
    this.lights = new LightManager(scene);
    this.lights.portalOpen = (id) => this.props.get(id)?.isOpen() ?? false;
    scene.add(this.root, this.sky.group, this.hemi, this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 120;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
  }

  // ── build ────────────────────────────────────────────────────────────────
  async build(layout: Layout, onProgress?: (k: number) => void): Promise<void> {
    this.layout = layout;
    this.col.walkable = layout.walkable;
    this.buildStatic(layout);
    const total = layout.props.length + 6;
    let done = 0;
    await Promise.all(layout.props.map(async (d) => {
      await this.addProp(d);
      onProgress?.(++done / total);
    }));
    await Promise.all(['npc_clerk', 'npc_shrine', 'npc_neighbor', 'npc_nao', 'npc_nao_sit', 'npc_extra'].map(async (id) => {
      await this.addNpc(id);
      onProgress?.(++done / total);
    }));
    for (const a of layout.anchors) {
      const pos = a.prop ? this.props.get(a.prop)?.toWorld(a.pos) ?? new THREE.Vector3(...a.pos) : new THREE.Vector3(...a.pos);
      const propYaw = a.prop ? (this.props.get(a.prop)?.def.rot ?? 0) : 0;
      this.anchors.set(a.id, { pos, yaw: (a.yaw ?? 0) + (a.prop ? propYaw : 0) });
    }
    for (const z of layout.zones) this.zones.set(z.id, { rect: z.rect, region: z.region });
    for (const p of layout.posters) this.addPoster(p);
    for (const l of layout.lights) {
      const pos = l.prop ? this.props.get(l.prop)?.toWorld(l.pos) ?? new THREE.Vector3(...l.pos) : new THREE.Vector3(...l.pos);
      const glow = (l.emissive ?? []).map((e) => ({ prop: this.props.get(e.prop)!, mat: e.mat })).filter((g) => g.prop);
      this.lights.add(l, pos, glow);
    }
    this.buildWires(layout.wires);
    this.nodeDefaults = addScenarioExtras(this, this.tex);
    this.scene.add(this.phoneLight);
    this.root.updateMatrixWorld(true);
    this.batchScenery();
    for (const m of this.rayMeshes) this.rayGrid.add(m, !!m.userData.npcId);
    for (const m of this.occluders) this.occGrid.add(m);
    this.resetState();
    this.setTime('night');
  }

  private bucket(map: Map<string, Bucket>, key: string): Bucket {
    let b = map.get(key);
    if (!b) map.set(key, (b = { pos: [], nrm: [], uv: [], idx: [] }));
    return b;
  }

  private quad(b: Bucket, p: V3[], n: V3, uv: [number, number][]): void {
    const base = b.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      b.pos.push(...p[i]);
      b.nrm.push(...n);
      b.uv.push(...uv[i]);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Emit faces of an AABB. faces: tex per face key, or null to skip. */
  private boxFaces(map: Map<string, Bucket>, min: V3, max: V3, faces: Partial<Record<'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz', string>>, s: number): void {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const st = s > 0;
    const U = (a: number, lo: number, hi: number) => (st ? a / s : (a - lo) / Math.max(1e-6, hi - lo));
    const V = (a: number, lo: number, hi: number) => (st ? a / s : (a - lo) / Math.max(1e-6, hi - lo));
    if (faces.px) this.quad(this.bucket(map, faces.px), [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0],
      [[U(-z1, -z1, -z0), V(y0, y0, y1)], [U(-z0, -z1, -z0), V(y0, y0, y1)], [U(-z0, -z1, -z0), V(y1, y0, y1)], [U(-z1, -z1, -z0), V(y1, y0, y1)]]);
    if (faces.nx) this.quad(this.bucket(map, faces.nx), [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0],
      [[U(z0, z0, z1), V(y0, y0, y1)], [U(z1, z0, z1), V(y0, y0, y1)], [U(z1, z0, z1), V(y1, y0, y1)], [U(z0, z0, z1), V(y1, y0, y1)]]);
    if (faces.pz) this.quad(this.bucket(map, faces.pz), [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1],
      [[U(x0, x0, x1), V(y0, y0, y1)], [U(x1, x0, x1), V(y0, y0, y1)], [U(x1, x0, x1), V(y1, y0, y1)], [U(x0, x0, x1), V(y1, y0, y1)]]);
    if (faces.nz) this.quad(this.bucket(map, faces.nz), [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1],
      [[U(-x1, -x1, -x0), V(y0, y0, y1)], [U(-x0, -x1, -x0), V(y0, y0, y1)], [U(-x0, -x1, -x0), V(y1, y0, y1)], [U(-x1, -x1, -x0), V(y1, y0, y1)]]);
    if (faces.py) this.quad(this.bucket(map, faces.py), [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0],
      [[U(x0, x0, x1), V(-z1, -z1, -z0)], [U(x1, x0, x1), V(-z1, -z1, -z0)], [U(x1, x0, x1), V(-z0, -z1, -z0)], [U(x0, x0, x1), V(-z0, -z1, -z0)]]);
    if (faces.ny) this.quad(this.bucket(map, faces.ny), [[x1, y0, z1], [x0, y0, z1], [x0, y0, z0], [x1, y0, z0]], [0, -1, 0],
      [[U(-x1, -x1, -x0), V(-z1, -z1, -z0)], [U(-x0, -x1, -x0), V(-z1, -z1, -z0)], [U(-x0, -x1, -x0), V(-z0, -z1, -z0)], [U(-x1, -x1, -x0), V(-z0, -z1, -z0)]]);
  }

  private addCollider(min: V3, max: V3, owner: string): Collider {
    return this.col.add({ minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2], owner });
  }

  private buildStatic(layout: Layout): void {
    const map = new Map<string, Bucket>();
    for (const f of layout.floors) {
      const [x0, z0, x1, z1] = f.rect;
      const y = (f.y ?? 0) + (f.layer ?? 0) * 0.002;
      this.boxFaces(map, [x0, y, z0], [x1, y, z1], { py: f.tex }, f.uv ?? 1);
      if (f.ceiling) this.boxFaces(map, [x0, f.ceiling.y, z0], [x1, f.ceiling.y, z1], { ny: f.ceiling.tex }, f.ceiling.uv ?? 1);
      if (f.surface) this.floorRects.push({ rect: f.rect, surface: f.surface, layer: f.layer ?? 0 });
    }
    this.floorRects.sort((a, b) => b.layer - a.layer);
    for (const w of layout.walls) this.buildWall(map, w);
    for (const b of layout.boxes) this.buildBox(map, b);
    for (const [key, b] of map) {
      if (key === 'none' || !b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({ map: this.tex.get(key), roughness: ROUGH[key] ?? 0.92, metalness: 0 });
      mat.name = `static_${key}`;
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = !['dirt', 'asphalt', 'road_line', 'parking', 'gravel', 'stone_path', 'road_tomare'].includes(key);
      mesh.userData.occOwner = 'static';
      this.root.add(mesh);
      this.rayMeshes.push(mesh);
      if (mesh.castShadow) this.occluders.push(mesh);
    }
  }

  private buildWall(map: Map<string, Bucket>, w: WallDef): void {
    const t = w.t ?? 0.12;
    const y0 = w.y ?? 0;
    const alongX = w.from[1] === w.to[1];
    const a = alongX ? Math.min(w.from[0], w.to[0]) : Math.min(w.from[1], w.to[1]);
    const L = Math.abs(alongX ? w.to[0] - w.from[0] : w.to[1] - w.from[1]);
    const fixed = alongX ? w.from[1] : w.from[0];
    const flip = alongX ? w.to[0] < w.from[0] : w.to[1] < w.from[1];
    const holes = (w.holes ?? []).map((h) => ({ ...h, at: flip ? L - h.at : h.at })).sort((p, q) => p.at - q.at);
    const pieces: [number, number, number, number][] = []; // s0, s1, ya, yb
    let cursor = 0;
    for (const h of holes) {
      const s0 = h.at - h.w / 2, s1 = h.at + h.w / 2;
      if (s0 > cursor) pieces.push([cursor, s0, 0, w.h]);
      if (h.top < w.h) pieces.push([s0, s1, h.top, w.h]);
      if ((h.bottom ?? 0) > 0) pieces.push([s0, s1, 0, h.bottom!]);
      cursor = s1;
    }
    if (cursor < L) pieces.push([cursor, L, 0, w.h]);
    const t1 = w.tex, t2 = w.tex2 ?? w.tex;
    for (const [s0, s1, ya, yb] of pieces) {
      const min: V3 = alongX ? [a + s0, y0 + ya, fixed - t / 2] : [fixed - t / 2, y0 + ya, a + s0];
      const max: V3 = alongX ? [a + s1, y0 + yb, fixed + t / 2] : [fixed + t / 2, y0 + yb, a + s1];
      if (!w.invisible) {
        const faces = alongX
          ? { pz: t1, nz: t2, px: t1, nx: t1, py: t1, ny: ya > 0 ? t1 : undefined }
          : { px: t1, nx: t2, pz: t1, nz: t1, py: t1, ny: ya > 0 ? t1 : undefined };
        this.boxFaces(map, min, max, faces, w.uv ?? 1);
      }
      if (w.collide !== false) this.addCollider(min, max, 'static');
    }
  }

  private buildBox(map: Map<string, Bucket>, b: BoxDef): void {
    if (b.glass) {
      const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), glassMaterial());
      m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      m.renderOrder = 2;
      this.root.add(m);
    } else if (b.emissive) {
      const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial({ color: b.emissive }));
      m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      this.root.add(m);
    } else if (!b.invisible && b.tex) {
      this.boxFaces(map, b.min, b.max, { px: b.tex, nx: b.tex, py: b.tex, ny: b.tex, pz: b.tex, nz: b.tex }, b.uv ?? 1);
    }
    if (b.collide !== false && !b.emissive) this.addCollider(b.min, b.max, 'static');
  }

  /**
   * Collapse a model's static meshes: ordinary materials are baked into vertex
   * colors and merged per roughness/metalness bucket (a handful of draw calls per
   * prop). Animated parts, named nodes and special materials stay untouched.
   */
  private mergeModel(obj: THREE.Object3D, protect: Set<string>): void {
    obj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; shadow: boolean }>();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      for (let p: THREE.Object3D | null = m; p && p !== obj; p = p.parent) if (protect.has(p.name)) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (special(mat) || !mat.isMeshStandardMaterial) return;
      const { key, mat: vc } = vcMaterial(mat.roughness ?? 0.8, mat.metalness ?? 0);
      const gk = `${key}|${m.castShadow}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { mat: vc, geos: [], meshes: [], shadow: m.castShadow }));
      g.geos.push(bakeColored(m, inv));
      g.meshes.push(m);
    });
    for (const g of groups.values()) {
      const merged = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, g.mat);
      mesh.name = `merged_${g.mat.name}`;
      mesh.castShadow = g.shadow;
      obj.add(mesh);
      for (const m of g.meshes) m.parent?.remove(m);
    }
  }

  private async addProp(d: Layout['props'][number]): Promise<void> {
    const spec = MODELS[d.model];
    const loaded = await this.assets.instance(d.model);
    const obj = loaded ?? fallbackModel(d.model);
    const holder = new THREE.Group();
    holder.name = d.id;
    holder.add(obj);
    holder.position.set(...d.pos);
    holder.rotation.y = (d.rot ?? 0) * DEG;
    if (d.scale !== undefined) {
      if (typeof d.scale === 'number') holder.scale.setScalar(d.scale);
      else holder.scale.set(...d.scale);
    }
    this.root.add(holder);
    holder.updateMatrixWorld(true);
    this.prepareMaterials(holder, d);
    const prop = new Prop(d, holder, spec?.parts ?? {});
    this.props.set(d.id, prop);
    // colliders come from the original meshes (per-mesh boxes for trees, poles, torii pillars)…
    this.buildPropColliders(prop, spec?.collider ?? 'auto', spec?.blocks ?? []);
    // …and only then are the static meshes merged to save draw calls
    if (loaded) {
      this.mergeModel(obj, new Set([...Object.keys(spec?.parts ?? {}), ...Object.keys(spec?.nodes ?? {}), 'head']));
      prop.meshes.length = 0;
      holder.traverse((o) => { if ((o as THREE.Mesh).isMesh) prop.meshes.push(o as THREE.Mesh); });
    }
    const small = spec ? Math.max(...spec.size) < 0.35 : false;
    for (const m of prop.meshes) {
      m.castShadow = !small;
      m.receiveShadow = true;
      m.userData.propId = d.id;
      m.userData.interactId = prop.interactId;
      this.rayMeshes.push(m);
      if (d.occluder !== false && !small && spec?.group !== 'character') {
        m.userData.occOwner = d.id;
        this.occluders.push(m);
      }
    }
    // mark which part each mesh belongs to (face LOS keeps doors/lids of the owner)
    for (const [name] of prop.parts) {
      prop.node(name)?.traverse((o) => { o.userData.occPart = name; });
    }
    if (d.hidden) prop.visible = false;
  }

  private prepareMaterials(root: THREE.Object3D, d: Layout['props'][number]): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) {
        const n = mat.name ?? '';
        const override = d.tex?.[n];
        if (n.startsWith('tex_')) {
          const id = override ?? n.slice(4);
          mat.map = this.tex.get(id);
          mat.color?.set(0xffffff);
          mat.needsUpdate = true;
        } else if (n.startsWith('emit_')) {
          const id = override ?? n.slice(5);
          if (this.tex.has(id)) {
            mat.map = this.tex.get(id);
            mat.emissiveMap = mat.map;
            mat.color?.set(0xffffff);
            if (mat.emissive && mat.emissive.r + mat.emissive.g + mat.emissive.b < 0.01) mat.emissive.set(0xffffff);
            mat.needsUpdate = true;
          }
        } else if (n.startsWith('glass')) {
          mat.transparent = true;
          mat.opacity = n === 'glass_frosted' ? 0.7 : 0.22;
          mat.depthWrite = false;
          mat.roughness = n === 'glass_frosted' ? 0.85 : 0.05;
          mat.metalness = 0;
          m.renderOrder = 2;
        } else if (n === 'mirror') {
          mat.color?.set('#8f969c');
          mat.metalness = 0.95;
          mat.roughness = 0.12;
        } else if (n === 'water') {
          mat.color?.set('#2a3438');
          mat.roughness = 0.08;
        } else if (n.startsWith('screen_')) {
          mat.color?.set('#050607');
          mat.roughness = 0.25;
        }
      }
    });
  }

  private buildPropColliders(prop: Prop, mode: 'auto' | 'meshes' | 'none', blocks: string[]): void {
    if (prop.def.collider === 'none' || mode === 'none') return;
    const kind = prop.def.collider ?? mode;
    const blockNodes = blocks.map((b) => prop.node(b)).filter(Boolean) as THREE.Object3D[];
    const inBlock = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (blockNodes.includes(p)) return true;
      return false;
    };
    const tmp = new THREE.Box3();
    if (kind === 'meshes') {
      for (const m of prop.meshes) {
        tmp.setFromObject(m);
        const sx = tmp.max.x - tmp.min.x, sz = tmp.max.z - tmp.min.z;
        if (tmp.min.y > 2.0 || tmp.max.y < 0.15 || (sx < 0.05 && sz < 0.05)) continue;
        prop.colliders.push(this.addCollider(tmp.min.toArray() as V3, tmp.max.toArray() as V3, prop.id));
      }
    } else {
      const body = new THREE.Box3();
      for (const m of prop.meshes) if (!inBlock(m)) body.union(tmp.setFromObject(m));
      // Doors and windows sit in wall holes: the frame must not block its own
      // opening, so only the moving leaves/panes collide.
      if (!body.isEmpty() && body.max.y > 0.12 && !blockNodes.length) {
        prop.colliders.push(this.addCollider(body.min.toArray() as V3, body.max.toArray() as V3, prop.id));
      }
      for (const n of blockNodes) {
        const b = new THREE.Box3().setFromObject(n);
        if (b.isEmpty()) continue;
        const c = this.addCollider(b.min.toArray() as V3, b.max.toArray() as V3, prop.id);
        const partName = [...prop.parts.keys()].find((k) => prop.node(k) === n);
        if (partName) prop.bindPartCollider(partName, c);
        else prop.colliders.push(c);
      }
    }
  }

  /**
   * Merge the meshes of static, non-interactive scenery props (houses, trees,
   * poles…) per material to cut draw calls. Glowing and per-instance textured
   * materials stay separate so they can still be switched per prop.
   */
  private batchScenery(): void {
    const BATCH = /^(house_|cedar_tree|utility_pole|balcony_rail|window_ext|traffic_cone|road_barrier|stone_lantern|ext_stairs|bicycle|potted_plants|fluorescent_light|torii|komainu|shinboku|kura|bench|garbage_station|car_stop|trash_bins|conbini_back_shelf|copy_machine|chair|cushion|laundry_pole|shoes)/;
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const removed = new Set<THREE.Mesh>();
    for (const prop of this.props.values()) {
      if (prop.interactId !== null || prop.parts.size || prop.def.hidden || !BATCH.test(prop.model)) continue;
      prop.root.updateMatrixWorld(true);
      for (const m of [...prop.meshes]) {
        if (Array.isArray(m.material)) continue;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (special(mat) || !mat.isMeshStandardMaterial) continue;
        // already-merged vertex-colored meshes reuse their shared material; others get baked now
        const vc = mat.vertexColors && mat.name.startsWith('vc_') ? { mat, key: mat.name } : vcMaterial(mat.roughness ?? 0.8, mat.metalness ?? 0);
        const g = mat.vertexColors && mat.name.startsWith('vc_') ? (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld) : bakeColored(m, new THREE.Matrix4());
        for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(a)) g.deleteAttribute(a);
        g.computeBoundingSphere();
        const c = g.boundingSphere!.center;
        const cell = `${Math.floor(c.x / 40)},${Math.floor(c.z / 40)}`;
        const key = `${cell}|${vc.key}|${m.castShadow}`;
        let grp = groups.get(key);
        if (!grp) groups.set(key, (grp = { mat: vc.mat, geos: [] }));
        grp.geos.push(g);
        m.parent?.remove(m);
        removed.add(m);
        prop.meshes.splice(prop.meshes.indexOf(m), 1);
      }
    }
    if (!removed.size) return;
    const keep = (list: THREE.Mesh[]) => list.filter((m) => !removed.has(m));
    this.rayMeshes.splice(0, this.rayMeshes.length, ...keep(this.rayMeshes));
    this.occluders.splice(0, this.occluders.length, ...keep(this.occluders));
    for (const [key, grp] of groups) {
      const merged = grp.geos.length === 1 ? grp.geos[0] : mergeGeometries(grp.geos, false);
      if (!merged) { console.warn('[world] batch merge failed', key); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, grp.mat);
      mesh.castShadow = key.endsWith('|true');
      mesh.receiveShadow = true;
      mesh.userData.occOwner = 'static';
      mesh.userData.interactId = null;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.rayMeshes.push(mesh);
      this.occluders.push(mesh);
    }
  }

  private async addNpc(id: string): Promise<void> {
    const obj = (await this.assets.instance(id)) ?? fallbackModel(id);
    const root = new THREE.Group();
    root.name = id;
    root.add(obj);
    this.root.add(root);
    const spec = MODELS[id];
    const c = this.col.add({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: spec?.size[1] ?? 1.7, owner: id, enabled: false });
    const npc = new Npc(id, root, c);
    for (const m of npc.meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.interactId = id;
      m.userData.npcId = id;
      this.rayMeshes.push(m);
    }
    this.npcs.set(id, npc);
  }

  private addPoster(p: PosterDef): void {
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.get(p.tex), roughness: 0.9, transparent: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.size[0], p.size[1]), mat);
    mesh.position.set(...p.pos);
    mesh.rotation.y = p.rot * DEG;
    mesh.receiveShadow = true;
    if (p.interact) {
      mesh.userData.interactId = p.interact;
      mesh.userData.posterId = p.id;
      this.rayMeshes.push(mesh);
    }
    mesh.visible = !p.hidden;
    this.root.add(mesh);
    this.posters.set(p.id, { mesh, def: p });
    this.posterDefaults.set(p.id, { tex: p.tex, visible: !p.hidden });
  }

  private buildWires(wires: [V3, V3][]): void {
    const pts: number[] = [];
    for (const [a, b] of wires) {
      const n = 10;
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const sag = Math.min(0.8, len * 0.025);
      for (let i = 0; i < n; i++) {
        for (const k of [i / n, (i + 1) / n]) {
          pts.push(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k - Math.sin(Math.PI * k) * sag, a[2] + (b[2] - a[2]) * k);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.root.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0c0c0e })));
  }

  // ── state ────────────────────────────────────────────────────────────────
  /** Back to the neutral state every chapter starts from. */
  resetState(): void {
    for (const p of this.props.values()) {
      p.setOpen(0, '*');
      p.visible = !p.def.hidden;
    }
    for (const [id, d] of this.posterDefaults) this.setPoster(id, { tex: d.tex, visible: d.visible });
    for (const n of this.npcs.values()) this.hideNpc(n.id);
    this.locks.clear();
    for (const id of ['ext_door_101', 'ext_door_102', 'ext_door_104', 'shr_kura']) this.locks.set(id, true);
    this.locks.set('apt_door', true);
    this.locks.set('apt_door_chain', true);
    this.power = true;
    const fridge = this.props.get('apt_fridge');
    fridge?.showNode('flashlight_in_fridge', false);
    const door = this.props.get('apt_door');
    door?.showNode('chain_hooked', true);
    door?.showNode('chain_hanging', false);
    for (const d of this.nodeDefaults) this.props.get(d.prop)?.showNode(d.node, d.visible);
    for (const sw of ['sw_main', 'sw_1', 'sw_2', 'sw_3', 'sw_4']) this.setLever(sw, true);
    for (const n of this.npcs.values()) n.phoneGlow = false;
  }

  /** Breaker levers are modelled ON (up); OFF rotates them down by 60°. */
  setLever(name: string, on: boolean): void {
    const node = this.props.get('apt_breaker')?.node(name);
    if (!node) return;
    if (!this.levers.has(name)) this.levers.set(name, node.rotation.x);
    node.rotation.x = this.levers.get(name)! + (on ? 0 : 60 * DEG);
  }

  leverOn(name: string): boolean {
    const node = this.props.get('apt_breaker')?.node(name);
    if (!node || !this.levers.has(name)) return true;
    return Math.abs(node.rotation.x - this.levers.get(name)!) < 0.1;
  }

  /** `all` = chapter start (reset every light); mid-chapter changes keep script-controlled lights. */
  setTime(t: TimeOfDay, all = true): void {
    this.time = t;
    const p = (this.preset = TIME[t]);
    if (p.fogDensity) this.scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);
    else this.scene.fog = new THREE.Fog(p.fog, p.fogNear ?? 30, p.fogFar ?? 150);
    this.scene.background = new THREE.Color(p.fog);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sun;
    this.sun.castShadow = p.sunShadow;
    this.sky.setTime(t);
    this.lights.applyTime(t, all);
    const night = t !== 'day';
    let i = 0;
    for (const prop of this.props.values()) {
      if (prop.hasGlow('emit_window')) {
        const tags = prop.def.tags ?? [];
        const lit = tags.includes('lit') || (!tags.includes('dark') && (i++ * 7) % 3 === 0);
        prop.setGlow(night && lit ? 1 : 0, 'emit_window');
      }
      for (const m of ['emit_led', 'emit_mw_display', 'emit_screen', 'emit_case']) if (prop.hasGlow(m)) prop.setGlow(1, m);
      if (prop.hasGlow('emit_blink')) prop.setGlow(0, 'emit_blink');
      if (prop.hasGlow('emit_lens')) prop.setGlow(0, 'emit_lens');
    }
  }

  get timePreset(): TimePreset {
    return this.preset;
  }

  // ── queries ──────────────────────────────────────────────────────────────
  prop(id: string): Prop {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown prop: ${id}`);
    return p;
  }

  light(id: string): LightCtl {
    const l = this.lights.ctls.get(id);
    if (!l) throw new Error(`unknown light: ${id}`);
    return l;
  }

  anchor(id: string): THREE.Vector3 {
    const a = this.anchors.get(id);
    if (!a) throw new Error(`unknown anchor: ${id}`);
    return a.pos.clone();
  }

  anchorYaw(id: string): number {
    return this.anchors.get(id)?.yaw ?? 0;
  }

  spawn(id: string): SpawnDef {
    const s = this.layout.spawns[id];
    if (!s) throw new Error(`unknown spawn: ${id}`);
    return s;
  }

  inZone(id: string, p: THREE.Vector3): boolean {
    const z = this.zones.get(id);
    if (!z) return false;
    const [x0, z0, x1, z1] = z.rect;
    return p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1;
  }

  zonesAt(p: THREE.Vector3): string[] {
    const out: string[] = [];
    for (const [id] of this.zones) if (this.inZone(id, p)) out.push(id);
    return out;
  }

  regionAt(p: THREE.Vector3): 'apt' | 'out' | 'conbini' {
    for (const z of this.zones.values()) {
      if (!z.region) continue;
      const [x0, z0, x1, z1] = z.rect;
      if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1) return z.region as 'apt' | 'conbini';
    }
    return 'out';
  }

  surfaceAt(x: number, z: number): Surface {
    for (const f of this.floorRects) {
      const [x0, z0, x1, z1] = f.rect;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return f.surface;
    }
    return 'dirt';
  }

  setPoster(id: string, o: { tex?: string; visible?: boolean }): void {
    const p = this.posters.get(id);
    if (!p) throw new Error(`unknown poster: ${id}`);
    if (o.tex) (p.mesh.material as THREE.MeshStandardMaterial).map = this.tex.get(o.tex);
    if (o.visible !== undefined) p.mesh.visible = o.visible;
    (p.mesh.material as THREE.MeshStandardMaterial).needsUpdate = true;
  }

  showNpc(id: string, pos: THREE.Vector3, yawDeg: number): Npc {
    const n = this.npcs.get(id);
    if (!n) throw new Error(`unknown npc: ${id}`);
    n.visible = true;
    n.root.visible = true;
    n.root.position.copy(pos);
    n.yaw = yawDeg;
    n.root.rotation.y = (yawDeg + 180) * DEG;
    const r = 0.25;
    Object.assign(n.collider, { minX: pos.x - r, maxX: pos.x + r, minZ: pos.z - r, maxZ: pos.z + r, minY: pos.y, enabled: true });
    return n;
  }

  hideNpc(id: string): void {
    const n = this.npcs.get(id);
    if (!n) return;
    n.visible = false;
    n.root.visible = false;
    n.collider.enabled = false;
    n.talk = null;
    n.label = null;
  }

  rayCandidates(p: THREE.Vector3, r: number): THREE.Mesh[] {
    return this.rayGrid.query(p, r);
  }

  occluderCandidates(a: THREE.Vector3, b: THREE.Vector3): THREE.Mesh[] {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    return this.occGrid.query(mid, a.distanceTo(b) / 2 + 0.5);
  }

  isLocked(id: string): boolean {
    return this.locks.get(id) ?? false;
  }

  // ── per frame ────────────────────────────────────────────────────────────
  update(dt: number, cam: THREE.Vector3, playerPos: THREE.Vector3): void {
    for (const p of this.props.values()) p.update(dt);
    let glow: Npc | null = null;
    for (const n of this.npcs.values()) {
      n.update(dt, cam);
      if (n.visible && n.phoneGlow) glow = n;
    }
    if (glow) {
      const head = glow.head ?? glow.root;
      const hp = head.getWorldPosition(new THREE.Vector3());
      const yaw = glow.root.rotation.y;
      // in front of the chest, below the chin: the phone's screen light
      this.phoneLight.position.set(hp.x + Math.sin(yaw) * 0.28, hp.y - 0.05, hp.z + Math.cos(yaw) * 0.28);
      this.phoneLight.intensity = 0.6 * (0.92 + Math.random() * 0.08);
    } else this.phoneLight.intensity = 0;
    for (const n of this.npcs.values()) {
      for (const m of n.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.name?.startsWith('emit_phone')) mat.emissiveIntensity = n.phoneGlow ? 1.4 : 0;
      }
    }
    // automatic doors
    for (const p of this.props.values()) {
      if (!p.def.tags?.includes('autodoor') || this.isLocked(p.id)) continue;
      const near = p.position.distanceTo(playerPos) < 2.3;
      if (near && !p.isOpen('pane_l')) { void p.open('pane_l', 0.5); void p.open('pane_r', 0.5); this.onAutoDoor?.(p.id, true); }
      if (!near && p.isOpen('pane_l')) { void p.close('pane_l', 0.7); void p.close('pane_r', 0.7); this.onAutoDoor?.(p.id, false); }
    }
    this.lights.cameraRegion = this.regionAt(cam);
    this.lights.update(dt, cam);
    const indoor = this.lights.cameraRegion !== 'out';
    const target = indoor ? this.preset.hemiIndoor : this.preset.hemi;
    this.hemiLevel += (target - this.hemiLevel) * Math.min(1, dt * 3);
    this.hemi.intensity = this.hemiLevel;
    this.sun.intensity = this.preset.sun * (indoor ? 0.15 : 1);
    const d = this.preset.sunDir;
    this.sunTarget.position.set(cam.x, 0, cam.z);
    this.sun.position.set(cam.x + d[0] * 40, d[1] * 40, cam.z + d[2] * 40);
    this.sky.update(cam);
    this.blinkT += dt;
    const blink = this.time !== 'day' && Math.sin(this.blinkT * 4) > 0 ? 1 : 0;
    for (const p of this.props.values()) if (p.hasGlow('emit_blink')) p.setGlow(blink, 'emit_blink');
  }

  onAutoDoor: ((id: string, open: boolean) => void) | null = null;
}

export function glassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xa8c4cc, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, depthWrite: false });
}
