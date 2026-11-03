import type { Rect } from '../world/types';

export interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
  enabled: boolean;
  owner?: string;
}

/**
 * 2.5D collision: the player is a vertical capsule approximated by a circle on
 * the XZ plane; obstacles are axis aligned boxes that overlap the body height.
 */
export class CollisionWorld {
  readonly colliders: Collider[] = [];
  walkable: Rect[] = [];

  add(c: Omit<Collider, 'enabled'> & { enabled?: boolean }): Collider {
    const col: Collider = { enabled: true, ...c };
    this.colliders.push(col);
    return col;
  }

  remove(c: Collider): void {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  insideWalkable(x: number, z: number): boolean {
    if (!this.walkable.length) return true;
    for (const r of this.walkable) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return true;
    return false;
  }

  /** Push a circle out of all blocking boxes. Mutates and returns pos. */
  resolve(pos: { x: number; z: number }, radius: number, yMin = 0.25, yMax = 1.7): { x: number; z: number } {
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (!c.enabled || c.maxY < yMin || c.minY > yMax) continue;
        if (pos.x < c.minX - radius || pos.x > c.maxX + radius || pos.z < c.minZ - radius || pos.z > c.maxZ + radius) continue;
        const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
        const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
        let dx = pos.x - cx;
        let dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // center is inside the box: leave through the nearest face
          const left = pos.x - c.minX, right = c.maxX - pos.x, back = pos.z - c.minZ, front = c.maxZ - pos.z;
          const m = Math.min(left, right, back, front);
          if (m === left) pos.x = c.minX - radius;
          else if (m === right) pos.x = c.maxX + radius;
          else if (m === back) pos.z = c.minZ - radius;
          else pos.z = c.maxZ + radius;
          dx = dz = 0;
        }
        moved = true;
      }
      if (!moved) break;
    }
    return pos;
  }

  /** True if the segment (x0,z0)→(x1,z1) at height y crosses an enabled collider. */
  segmentBlocked(x0: number, z0: number, x1: number, z1: number, y: number): boolean {
    for (const c of this.colliders) {
      if (!c.enabled || y < c.minY || y > c.maxY) continue;
      if (segAabb(x0, z0, x1, z1, c)) return true;
    }
    return false;
  }
}

function segAabb(x0: number, z0: number, x1: number, z1: number, c: Collider): boolean {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dz = z1 - z0;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - c.minX) && clip(dx, c.maxX - x0) && clip(-dz, z0 - c.minZ) && clip(dz, c.maxZ - z0) && t0 <= t1;
}
