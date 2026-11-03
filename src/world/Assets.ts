import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import CATALOG from './catalog.json';

export interface PartSpec {
  anim: 'rotX' | 'rotY' | 'rotZ' | 'slideX' | 'slideY' | 'slideZ' | 'scaleX' | 'scaleZ';
  open: number;
  pivot?: string;
}
export interface ModelSpec {
  size: [number, number, number];
  desc: string;
  group?: string;
  parts?: Record<string, PartSpec>;
  nodes?: Record<string, string>;
  materials?: string[];
  collider?: 'auto' | 'meshes' | 'none';
  blocks?: string[];
  color?: string;
}

export const MODELS = (CATALOG as unknown as { models: Record<string, ModelSpec> }).models;

const BASE = import.meta.env.BASE_URL;

/**
 * Loads Blender-exported GLB models (public/models/<id>.glb). Missing models
 * resolve to null so the world can substitute a box of the catalog size.
 */
export class Assets {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<THREE.Object3D | null>>();
  private available: Set<string> | null = null;
  private manifestPromise: Promise<void> | null = null;

  private loadManifest(): Promise<void> {
    if (!this.manifestPromise) {
      this.manifestPromise = fetch(`${BASE}models/manifest.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : { models: [] }))
        .then((j: { models?: string[] }) => { this.available = new Set(j.models ?? []); })
        .catch(() => { this.available = new Set(); });
    }
    return this.manifestPromise;
  }

  /** Returns a fresh clone of the model scene (materials cloned too), or null. */
  async instance(id: string): Promise<THREE.Object3D | null> {
    const src = await this.source(id);
    if (!src) return null;
    const obj = src.clone(true);
    // clone materials per instance, but keep sharing inside the instance
    const clones = new Map<THREE.Material, THREE.Material>();
    const cl = (x: THREE.Material) => {
      let c = clones.get(x);
      if (!c) clones.set(x, (c = x.clone()));
      return c;
    };
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map(cl) : cl(m.material);
    });
    return obj;
  }

  source(id: string): Promise<THREE.Object3D | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.loadManifest().then(() => {
        if (!this.available?.has(id)) return null;
        return new Promise<THREE.Object3D | null>((resolve) => {
          this.loader.load(
            `${BASE}models/${id}.glb`,
            (gltf) => resolve(gltf.scene),
            undefined,
            (err) => { console.warn(`[assets] failed to load ${id}`, err); resolve(null); },
          );
        });
      });
      this.cache.set(id, p);
    }
    return p;
  }
}

/** A stand-in for missing models: a box (or capsule for characters) of the catalog size. */
export function fallbackModel(id: string): THREE.Object3D {
  const spec = MODELS[id];
  const [w, h, d] = spec?.size ?? [0.5, 0.5, 0.5];
  const group = new THREE.Group();
  const color = new THREE.Color(spec?.color ?? colorFor(id));
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  if (spec?.group === 'character') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.4, w * 0.45, h * 0.82, 10), mat);
    body.position.y = h * 0.41;
    const head = new THREE.Group();
    head.name = 'head';
    head.position.y = h * 0.84;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshStandardMaterial({ color: '#c9a88c', roughness: 0.8 }));
    skull.position.y = 0.08;
    head.add(skull);
    group.add(body, head);
    return group;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.y = h / 2;
  group.add(mesh);
  // keep part names so animations do not crash
  for (const name of Object.keys(spec?.parts ?? {})) {
    const part = new THREE.Group();
    part.name = name;
    group.add(part);
  }
  return group;
}

function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 12%, ${45 + (h % 20)}%)`;
}
