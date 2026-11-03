// Shared data types for the world layout. Coordinates are meters, Y up,
// X = east, Z = south (north is -Z). Yaw follows the camera convention:
// yaw 0 looks north (-Z), yaw 90 looks west (-X), yaw -90 looks east (+X).

export type V3 = [number, number, number];
/** x0, z0, x1, z1 */
export type Rect = [number, number, number, number];

export type Surface = 'wood' | 'tile' | 'concrete' | 'asphalt' | 'gravel' | 'stone' | 'dirt' | 'grass' | 'metal';

export interface FloorDef {
  rect: Rect;
  y?: number;
  tex: string;
  surface?: Surface;
  /** meters per texture repeat (default 1) */
  uv?: number;
  /** stacking order for co-planar floors (each layer lifts 2 mm) */
  layer?: number;
  ceiling?: { y: number; tex: string; uv?: number };
}

export interface Hole {
  /** center distance from `from`, along the wall */
  at: number;
  w: number;
  top: number;
  bottom?: number;
}

/** Axis aligned wall segment. `tex` is the +normal side (+Z for X-walls, +X for Z-walls); `tex2` the other side. */
export interface WallDef {
  from: [number, number];
  to: [number, number];
  h: number;
  y?: number;
  t?: number;
  tex: string;
  tex2?: string;
  holes?: Hole[];
  collide?: boolean;
  uv?: number;
  invisible?: boolean;
}

export interface BoxDef {
  min: V3;
  max: V3;
  tex?: string;
  collide?: boolean;
  uv?: number;
  glass?: boolean;
  /** self-lit color (light panels) */
  emissive?: string;
  invisible?: boolean;
}

export interface PropDef {
  id: string;
  model: string;
  pos: V3;
  /** rotation about Y in degrees, applied to the model (model front is +Z) */
  rot?: number;
  scale?: number | V3;
  /** interaction id (defaults to the prop id); false = never interactable */
  interact?: string | false;
  collider?: 'auto' | 'meshes' | 'none';
  /** blocks face line-of-sight */
  occluder?: boolean;
  hidden?: boolean;
  /** material name → texture id overrides for tex_* / emit_* materials */
  tex?: Record<string, string>;
  tags?: string[];
}

export interface AnchorDef {
  id: string;
  pos: V3;
  /** when set, pos is in the prop's local space */
  prop?: string;
  yaw?: number;
}

export interface ZoneDef {
  id: string;
  rect: Rect;
  /** lighting region used to stop outdoor lights from leaking indoors */
  region?: 'apt' | 'out' | 'conbini';
  ymax?: number;
}

export interface LightDef {
  id: string;
  pos: V3;
  prop?: string;
  color: string;
  intensity: number;
  distance?: number;
  /** real = dedicated THREE light; pooled = shares one of the nearest-N pool lights */
  kind?: 'real' | 'pooled';
  region?: 'apt' | 'out' | 'conbini';
  /** prop id: when that prop is open the light is not damped across regions */
  portal?: string;
  /** default on/off per time of day (evening/dawn fall back to night) */
  on?: { night?: boolean; day?: boolean; evening?: boolean; dawn?: boolean };
  flicker?: boolean;
  /** emissive materials that glow together with this light */
  emissive?: { prop: string; mat?: string }[];
}

export interface PosterDef {
  id: string;
  tex: string;
  pos: V3;
  /** yaw of the poster normal in degrees (0 = faces +Z) */
  rot: number;
  size: [number, number];
  hidden?: boolean;
  interact?: string;
}

export interface SpawnDef {
  pos: V3;
  yaw: number;
}

export interface Layout {
  floors: FloorDef[];
  walls: WallDef[];
  boxes: BoxDef[];
  props: PropDef[];
  anchors: AnchorDef[];
  zones: ZoneDef[];
  lights: LightDef[];
  posters: PosterDef[];
  spawns: Record<string, SpawnDef>;
  walkable: Rect[];
  wires: [V3, V3][];
}

export type TimeOfDay = 'night' | 'day' | 'evening' | 'dawn';
