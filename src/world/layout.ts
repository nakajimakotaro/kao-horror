import type {
  AnchorDef, BoxDef, FloorDef, Layout, LightDef, PosterDef, PropDef, Rect, SpawnDef, V3, WallDef, ZoneDef,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
//  月見町（つきみちょう）— the whole playable world in one continuous map.
//
//   north (-Z)
//     shrine (-56..-26)   houses   board(-10)   houses | side street (17..22) | conbini (24..38)
//   ════════════════════════ main street  z ∈ [-3, 3] ════════════════════════
//     houses  booth  コーポ月見 (-32..-12)  neighbor(-9..0)  houses ...
//   south (+Z)
//
//  Unit 103 occupies x ∈ [-22, -18], z ∈ [7, 15]; its door faces the outdoor
//  corridor (north) and its balcony window faces south.
// ─────────────────────────────────────────────────────────────────────────────

const floors: FloorDef[] = [];
const walls: WallDef[] = [];
const boxes: BoxDef[] = [];
const props: PropDef[] = [];
const anchors: AnchorDef[] = [];
const zones: ZoneDef[] = [];
const lights: LightDef[] = [];
const posters: PosterDef[] = [];
const wires: [V3, V3][] = [];

const floor = (rect: Rect, tex: string, o: Partial<FloorDef> = {}) => floors.push({ rect, tex, ...o });
const wall = (from: [number, number], to: [number, number], h: number, tex: string, o: Partial<WallDef> = {}) =>
  walls.push({ from, to, h, tex, ...o });
const box = (min: V3, max: V3, tex: string, o: Partial<BoxDef> = {}) => boxes.push({ min, max, tex, ...o });
const prop = (id: string, model: string, pos: V3, rot = 0, o: Partial<PropDef> = {}) =>
  props.push({ id, model, pos, rot, ...o });
const anchor = (id: string, pos: V3, o: Partial<AnchorDef> = {}) => anchors.push({ id, pos, ...o });
const zone = (id: string, rect: Rect, o: Partial<ZoneDef> = {}) => zones.push({ id, rect, ...o });
const light = (d: LightDef) => lights.push(d);
const block = (from: [number, number], to: [number, number], o: Partial<WallDef> = {}) =>
  wall(from, to, 1.2, 'block_wall', { t: 0.12, uv: 0.8, ...o });
const fence = (from: [number, number], to: [number, number]) => wall(from, to, 0.9, 'stone_fence', { t: 0.25, uv: 1 });
const invisible = (from: [number, number], to: [number, number]) =>
  wall(from, to, 3, 'none', { invisible: true, t: 0.2 });

// ── Ground and roads ────────────────────────────────────────────────────────
floor([-90, -90, 90, 45], 'dirt', { y: -0.02, surface: 'dirt', uv: 3 });
floor([-90, -3, 90, 3], 'asphalt', { surface: 'asphalt', uv: 4, layer: 1 });
floor([17, -70, 22, -3], 'asphalt', { surface: 'asphalt', uv: 4, layer: 1 });
floor([-90, 2.6, 90, 2.72], 'road_line', { layer: 2 });
floor([-90, -2.72, 17, -2.6], 'road_line', { layer: 2 });
floor([22, -2.72, 90, -2.6], 'road_line', { layer: 2 });
floor([17.28, -70, 17.4, -3.6], 'road_line', { layer: 2 });
floor([21.6, -70, 21.72, -3.6], 'road_line', { layer: 2 });
floor([17.4, -3.75, 21.6, -3.6], 'road_line', { layer: 2 });
floor([17.8, -6.4, 21.2, -4.1], 'road_tomare', { layer: 2, uv: 0 });

// ── コーポ月見 (apartment building) ─────────────────────────────────────────
// lot
floor([-32, 3.5, -12, 5.6], 'concrete', { surface: 'concrete', uv: 2, layer: 1 });
floor([-32, 5.6, -30, 18], 'gravel', { surface: 'gravel', uv: 2, layer: 1 });
floor([-14, 7, -12, 18], 'gravel', { surface: 'gravel', uv: 2, layer: 1 });
floor([-30, 16.2, -14, 18], 'gravel', { surface: 'gravel', uv: 2, layer: 1 });
floor([-30, 15, -22, 16.2], 'concrete', { uv: 2, layer: 1 });
floor([-18, 15, -14, 16.2], 'concrete', { uv: 2, layer: 1 });
// outdoor corridor (外廊下)
floor([-31.5, 5.6, -14, 7], 'concrete', { surface: 'concrete', uv: 2, layer: 1 });
block([-32, 3.5], [-17.5, 3.5]);
block([-32, 3.5], [-32, 18]);
block([-32, 18], [-12, 18]);
block([-12, 3.5], [-12, 18]);

// building shell (two storeys, only unit 103 is hollow)
wall([-30, 7], [-14, 7], 5.6, 'wallpaper', { tex2: 'siding', t: 0.15, holes: [{ at: 8.8, w: 0.9, top: 2.08 }] });
wall([-30, 15], [-14, 15], 5.6, 'siding', { tex2: 'wallpaper', t: 0.15, holes: [{ at: 9.6, w: 2.2, bottom: 0.03, top: 2.0 }] });
wall([-30, 7], [-30, 15], 5.6, 'siding', { t: 0.15 });
wall([-14, 7], [-14, 15], 5.6, 'siding', { t: 0.15 });
box([-31.5, 2.6, 5.6], [-14, 2.8, 7], 'concrete', { uv: 2 });            // 2F corridor slab
box([-31.5, 2.8, 5.6], [-14, 3.85, 5.68], 'metal_panel', { uv: 1 });      // 2F corridor railing
box([-30.0, 0, 5.6], [-29.85, 2.6, 5.75], 'metal_dark');
box([-22.075, 0, 5.6], [-21.925, 2.6, 5.75], 'metal_dark');
box([-14.15, 0, 5.6], [-14.0, 2.6, 5.75], 'metal_dark');
box([-31.6, 5.6, 5.3], [-13.7, 5.85, 16.5], 'roof_metal', { uv: 2 });
box([-30, 2.6, 15], [-14, 2.8, 16.2], 'concrete', { uv: 2 });             // 2F balcony slab
box([-22.05, 0, 15], [-21.97, 1.8, 16.2], 'partition', { uv: 0 });        // 隔て板
box([-18.03, 0, 15], [-17.95, 1.8, 16.2], 'partition', { uv: 0 });
// gutters
box([-30.15, 0, 15.1], [-30.05, 5.6, 15.2], 'metal_dark');
box([-14.05, 0, 15.1], [-13.95, 5.6, 15.2], 'metal_dark');

// Unit 103 interior ─────────────────────────────────────────────────────────
floor([-22, 7, -20.7, 8], 'floor_tile_genkan', { surface: 'tile', uv: 0.6, layer: 3, ceiling: { y: 2.4, tex: 'ceiling' } });
floor([-20.7, 7, -19.7, 8], 'floor_kitchen', { surface: 'wood', layer: 3, ceiling: { y: 2.4, tex: 'ceiling' } });
floor([-22, 8, -19.7, 10.4], 'floor_kitchen', { surface: 'wood', layer: 3, ceiling: { y: 2.4, tex: 'ceiling' } });
floor([-19.7, 9.6, -18, 10.4], 'floor_kitchen', { surface: 'wood', layer: 3, ceiling: { y: 2.4, tex: 'ceiling' } });
floor([-19.7, 7, -18, 9.6], 'floor_bath', { surface: 'tile', uv: 0.5, layer: 3, ceiling: { y: 2.2, tex: 'ceiling_bath' } });
floor([-22, 10.4, -18, 15], 'floor_wood', { surface: 'wood', layer: 3, ceiling: { y: 2.4, tex: 'ceiling' } });
floor([-22, 15, -18, 16.2], 'concrete', { surface: 'concrete', uv: 2, layer: 3 });
wall([-22, 7], [-22, 15], 2.4, 'wallpaper', { t: 0.1 });
wall([-18, 7], [-18, 15], 2.4, 'wallpaper', { t: 0.1 });
// unit bath
wall([-19.7, 7], [-19.7, 9.6], 2.4, 'wall_bath', { tex2: 'wallpaper', t: 0.1, holes: [{ at: 1.95, w: 0.78, top: 2.02 }] });
wall([-19.7, 9.6], [-18, 9.6], 2.4, 'wallpaper', { tex2: 'wall_bath', t: 0.1 });
box([-19.65, 0, 7.075], [-18.05, 2.2, 7.085], 'wall_bath', { collide: false });
box([-18.06, 0, 7.075], [-18.05, 2.2, 9.55], 'wall_bath', { collide: false });
// kitchen | room partition with the sliding glass door
wall([-22, 10.4], [-18, 10.4], 2.4, 'wallpaper', { t: 0.1, holes: [{ at: 1.2, w: 0.88, top: 2.02 }] });
// door/window props
prop('apt_door', 'door_entrance', [-21.2, 0, 7], 180, { tex: { tex_plate: 'plate_103' }, tags: ['door'], occluder: true });
prop('apt_bath_door', 'door_bath', [-19.7, 0, 8.95], -90, { tags: ['door'], occluder: true });
prop('apt_room_door', 'door_sliding_glass', [-20.8, 0, 10.4], 0, { tags: ['door'], occluder: true });
prop('apt_window', 'window_sliding', [-20.4, 0, 15], 0, { tags: ['door'] });
box([-21.5, 0, 14.94], [-20.4, 2.0, 15.06], 'none', { invisible: true });   // fixed left pane
prop('apt_curtain', 'curtains', [-20.4, 0, 14.86], 180, { occluder: true });
// genkan & kitchen
prop('apt_shoebox', 'shoebox', [-21.8, 0, 7.52], 90);
prop('apt_shoes', 'shoes', [-21.05, 0, 7.6], 90, { interact: false });
prop('apt_breaker', 'breaker_panel', [-20.35, 1.82, 7.09], 0);
prop('apt_switch_kitchen', 'light_switch', [-19.76, 1.12, 7.7], -90);
prop('apt_ceil_kitchen', 'ceiling_light_small', [-20.9, 2.4, 9.0], 0, { interact: false });
prop('apt_kitchen_counter', 'kitchen_counter', [-21.69, 0, 8.85], 90, { interact: 'apt_kitchen_drawer' });
prop('apt_fridge', 'fridge', [-21.66, 0, 10.0], 90);
prop('apt_microwave', 'microwave', [-21.68, 1.5, 10.0], 90);
prop('apt_washer', 'washer', [-18.4, 0, 10.0], -90);
// unit bath
prop('apt_toilet', 'toilet', [-19.25, 0, 7.44], 0);
prop('apt_sink', 'bath_sink', [-18.45, 0, 7.29], 0, { interact: 'apt_bath_mirror' });
prop('apt_bathtub', 'bathtub', [-18.36, 0, 8.75], 0);
prop('apt_shower_curtain', 'shower_curtain', [-18.75, 0, 8.75], 0, { occluder: true });
prop('apt_ceil_bath', 'ceiling_light_small', [-18.85, 2.2, 8.3], 0, { interact: false });
// room
prop('apt_switch_room', 'light_switch', [-20.15, 1.12, 10.46], 0);
prop('apt_ceil_room', 'ceiling_light', [-20.0, 2.4, 12.7], 0, { interact: false });
prop('apt_desk', 'desk', [-21.65, 0, 11.3], 90);
prop('apt_chair', 'chair', [-21.0, 0, 11.35], -90, { interact: false });
prop('apt_tv', 'tv_set', [-21.78, 0, 13.2], 90);
prop('apt_lowtable', 'low_table', [-20.3, 0, 13.0], 0);
prop('apt_cushion', 'cushion', [-19.65, 0, 13.0], 0, { interact: false });
prop('apt_phone', 'smartphone', [-20.12, 0.36, 12.92], 20);
prop('apt_bed', 'bed', [-18.55, 0, 13.925], 180);
prop('apt_closet', 'closet', [-18.35, 0, 11.4], -90, { occluder: true });
prop('apt_bookshelf', 'color_box', [-19.2, 0, 10.62], 0, { interact: 'apt_photo' });
prop('apt_trash', 'trash_can', [-21.0, 0, 10.75], 0);
prop('apt_calendar', 'calendar', [-21.55, 1.3, 10.46], 0);
prop('apt_ac', 'aircon', [-21.86, 2.02, 12.1], 90);
prop('apt_medicine', 'medicine_bag', [-21.75, 0.72, 10.95], 100);
prop('apt_notebook', 'notebook', [-21.55, 0.72, 11.75], 80);
// balcony
prop('apt_balcony_rail', 'balcony_rail', [-20, 0, 16.2], 0, { interact: false });
prop('apt_ac_outdoor', 'ac_outdoor', [-18.6, 0, 15.85], 0);
prop('apt_laundry', 'laundry_pole', [-20.8, 0, 15.95], 0, { interact: false });
for (const x of [-28, -24, -16]) prop(`ext_rail_1f_${x}`, 'balcony_rail', [x, 0, 16.2], 0, { interact: false });
for (const x of [-28, -24, -20, -16]) prop(`ext_rail_2f_${x}`, 'balcony_rail', [x, 2.8, 16.2], 0, { interact: false });

// building exterior details
prop('ext_door_101', 'door_entrance', [-29.2, 0, 6.92], 180, { tex: { tex_plate: 'plate_101' }, tags: ['door'] });
prop('ext_door_102', 'door_entrance', [-25.2, 0, 6.92], 180, { tex: { tex_plate: 'plate_102' }, tags: ['door'] });
prop('ext_door_104', 'door_entrance', [-17.2, 0, 6.92], 180, { tex: { tex_plate: 'plate_104' }, tags: ['door'] });
for (const [i, x] of [-29.2, -25.2, -21.2, -17.2].entries()) {
  prop(`ext_door_20${i + 1}`, 'door_entrance', [x, 2.8, 6.92], 180, { interact: false, tex: { tex_plate: `plate_20${i + 1}` } });
  prop(`ext_win_n2f_${i}`, 'window_ext', [x + 1.9, 3.9, 6.92], 180, { interact: false, tags: [i % 2 ? 'lit' : 'dark'] });
  prop(`ext_win_s1f_${i}`, 'window_ext', [x + 0.8, 0.7, 15.08], 0, { interact: false, hidden: x === -21.2, tags: [i === 0 ? 'lit' : 'dark'] });
  prop(`ext_win_s2f_${i}`, 'window_ext', [x + 0.8, 3.5, 15.08], 0, { interact: false, tags: [i === 2 ? 'lit' : 'dark'] });
}
for (const [i, x] of [-28.3, -24.3, -16.3].entries()) prop(`ext_win_n1f_${i}`, 'window_ext', [x, 0.9, 6.92], 180, { interact: false, scale: [0.5, 0.6, 1], tags: [i === 2 ? 'dark' : 'lit'] });
prop('ext_fl_101', 'fluorescent_light', [-28.6, 2.6, 6.3], 0, { interact: false });
prop('ext_fl_102', 'fluorescent_light', [-24.6, 2.6, 6.3], 0, { interact: false });
prop('ext_fl_103', 'fluorescent_light', [-20.6, 2.6, 6.3], 0, { interact: false });
prop('ext_fl_104', 'fluorescent_light', [-16.6, 2.6, 6.3], 0, { interact: false });
prop('ext_mailbox', 'mailbox_set', [-13.4, 0, 6.5], 180);
prop('ext_stairs', 'ext_stairs', [-30.85, 0, 8.7], 0, { interact: false });
prop('ext_vending', 'vending_machine', [-12.85, 0, 3.95], 180);
prop('ext_bike_1', 'bicycle', [-27.2, 0, 4.6], 90, { interact: false });
prop('ext_bike_2', 'bicycle', [-26.4, 0, 4.7], 95, { interact: false });

// ── Neighbor (おばあさんの家) and houses ─────────────────────────────────────
block([-12, 3.5], [2.5, 3.5]);
block([2.5, 3.5], [2.5, 18]);
prop('ext_house_neighbor', 'house_old', [-4.5, 0, 11.5], 180, { interact: false });
prop('ext_neighbor_plants', 'potted_plants', [-7.2, 0, 4.3], 180, { interact: false });

const houseS: [string, number][] = [['house_b', -52], ['house_a', -41], ['house_a', 8], ['house_c', 19.5], ['house_b', 31], ['house_a', 43], ['house_c', 53], ['house_b', -66], ['house_a', 66]];
houseS.forEach(([m, x], i) => prop(`ext_house_s${i}`, m, [x, 0, 11.5], 180, { interact: false }));
const houseN: [string, number][] = [['house_c', -20], ['house_a', -2], ['house_b', 8.5], ['house_a', 44], ['house_c', 53.5], ['house_a', -66], ['house_c', 66]];
houseN.forEach(([m, x], i) => prop(`ext_house_n${i}`, m, [x, 0, -11.5], 0, { interact: false }));
const houseW: [string, number][] = [['house_b', -24], ['house_a', -36], ['house_c', -48]];
houseW.forEach(([m, z], i) => prop(`ext_house_w${i}`, m, [11.5, 0, z], 90, { interact: false }));
const houseE: [string, number][] = [['house_c', -26], ['house_a', -38], ['house_b', -50]];
houseE.forEach(([m, z], i) => prop(`ext_house_e${i}`, m, [27.8, 0, z], -90, { interact: false }));
prop('ext_house_end', 'house_a', [19.5, 0, -64], 0, { interact: false });

// south block walls (gaps for the phone booth and the garbage station)
block([-60, 3.5], [-47, 3.5]);
block([-45, 3.5], [-34.8, 3.5]);
block([-33.6, 3.5], [-32, 3.5]);
block([2.5, 3.5], [60, 3.5]);
// north side
block([-60, -3.5], [-56, -3.5]);
block([-26, -4], [16.5, -4]);
block([16.5, -4], [16.5, -58]);
block([22.5, -7.2], [22.5, -58]);
block([22.5, -7.2], [24, -7.2]);
block([38.1, -3.5], [38.1, -17.2]);
block([38.1, -3.5], [60, -3.5]);
// ends of the town
invisible([-58, -3.6], [-58, 3.6]);
invisible([58, -3.6], [58, 3.6]);
invisible([16.5, -56], [22.5, -56]);
prop('ext_barrier_w1', 'road_barrier', [-57.5, 0, -1.4], 90, { interact: 'ext_barrier' });
prop('ext_barrier_w2', 'road_barrier', [-57.5, 0, 1.4], 90, { interact: 'ext_barrier' });
prop('ext_barrier_e1', 'road_barrier', [57.5, 0, -1.4], -90, { interact: 'ext_barrier' });
prop('ext_barrier_e2', 'road_barrier', [57.5, 0, 1.4], -90, { interact: 'ext_barrier' });
prop('ext_barrier_n1', 'road_barrier', [18.6, 0, -55.6], 0, { interact: 'ext_barrier' });
prop('ext_barrier_n2', 'road_barrier', [20.9, 0, -55.6], 0, { interact: 'ext_barrier' });
for (const [i, p] of ([[-57.2, -2.6], [-57.0, 2.5], [57.1, 0.1], [19.7, -55.2]] as [number, number][]).entries())
  prop(`ext_cone_${i}`, 'traffic_cone', [p[0], 0, p[1]], i * 37, { interact: false });

// street furniture
prop('ext_board', 'bulletin_board', [-10, 0, -3.66], 0);
prop('ext_curve_mirror', 'curve_mirror', [19.5, 0, 3.75], 180);
prop('ext_garbage', 'garbage_station', [-46, 0, 4.3], 180);
prop('ext_phonebooth', 'phone_booth', [-34.2, 0, 4.06], 180);

// utility poles + street lamps (pooled lights) + wires
const poles: { id: string; x: number; z: number; rot: number }[] = [];
const north = [-50, -24, 2, 28, 46];
const south = [-36, -9, 14, 38, 54];
const side = [-14, -30, -46];
north.forEach((x, i) => poles.push({ id: `pole_n${i}`, x, z: -3.25, rot: 0 }));
south.forEach((x, i) => poles.push({ id: `pole_s${i}`, x, z: 3.25, rot: 180 }));
side.forEach((z, i) => poles.push({ id: `pole_e${i}`, x: 22.75, z, rot: -90 }));
const flickering = new Set(['pole_s1', 'pole_e2']);
for (const p of poles) {
  prop(p.id, 'utility_pole', [p.x, 0, p.z], p.rot, { interact: false, tags: ['pole'] });
  const r = (p.rot * Math.PI) / 180;
  const lx = p.x + Math.sin(r) * 1.15;
  const lz = p.z + Math.cos(r) * 1.15;
  light({
    id: `lamp_${p.id}`, pos: [lx, 5.0, lz], color: '#dfe8ff', intensity: 17, distance: 14, kind: 'pooled', region: 'out',
    on: { night: true, day: false }, flicker: flickering.has(p.id), emissive: [{ prop: p.id, mat: 'emit_lamp' }],
  });
}
const wireRow = (xs: number[], z: number) => {
  for (let i = 0; i < xs.length - 1; i++) {
    for (const dz of [-0.45, 0.45]) wires.push([[xs[i], 8.45, z + dz], [xs[i + 1], 8.45, z + dz]]);
    wires.push([[xs[i], 7.6, z], [xs[i + 1], 7.6, z]]);
  }
};
wireRow([-62, ...north, 62], -3.25);
wireRow([-62, ...south, 62], 3.25);
for (let i = 0; i < side.length - 1; i++) wires.push([[22.75, 8.45, side[i]], [22.75, 8.45, side[i + 1]]]);

// ── Convenience store (24h) ─────────────────────────────────────────────────
floor([22, -7.2, 38.1, -3], 'parking', { surface: 'asphalt', uv: 0, layer: 2 });
floor([24, -17, 38, -7], 'conbini_floor', { surface: 'tile', uv: 0.6, layer: 3, ceiling: { y: 3.0, tex: 'conbini_ceiling', uv: 0.6 } });
wall([24, -7], [38, -7], 3.8, 'siding_white', { tex2: 'conbini_wall', t: 0.15, holes: [
  { at: 2.0, w: 3.2, bottom: 0.5, top: 2.7 },
  { at: 5.0, w: 2.0, top: 2.4 },
  { at: 10.0, w: 7.2, bottom: 0.5, top: 2.7 },
] });
wall([24, -17], [38, -17], 3.4, 'conbini_wall', { tex2: 'siding_white', t: 0.15 });
wall([24, -17], [24, -7], 3.4, 'conbini_wall', { tex2: 'siding_white', t: 0.15 });
wall([38, -17], [38, -7], 3.4, 'siding_white', { tex2: 'conbini_wall', t: 0.15 });
box([23.9, 3.0, -17.1], [38.1, 3.4, -6.9], 'roof_metal', { uv: 2 });
box([24.4, 0.5, -7.02], [27.6, 2.7, -6.98], 'none', { glass: true });
box([30.4, 0.5, -7.02], [37.6, 2.7, -6.98], 'none', { glass: true });
for (const z of [-15, -12, -9]) box([25.5, 2.96, z - 0.3], [36.5, 2.99, z + 0.3], 'none', { emissive: '#f4f8ff', collide: false });
prop('conbini_sign', 'conbini_sign', [31, 2.85, -6.8], 0, { interact: false });
prop('conbini_door', 'auto_door', [29, 0, -7], 0, { tags: ['autodoor'] });
prop('conbini_counter', 'conbini_counter', [35.2, 0, -11], -90);
prop('conbini_back_shelf', 'conbini_back_shelf', [37.75, 0, -11], -90, { interact: false });
for (const [i, x] of [26, 29, 32].entries()) prop(`conbini_fridge_${i + 1}`, 'conbini_drink_fridge', [x, 0, -16.55], 0, { interact: 'conbini_fridge' });
for (const [i, x] of [26.5, 29.0, 31.5].entries()) prop(`conbini_shelf_${i + 1}`, 'conbini_shelf', [x, 0, -12], 90, { interact: 'conbini_shelf' });
prop('conbini_magazine', 'conbini_magazine', [26, 0, -7.45], 180);
prop('conbini_atm', 'atm', [24.45, 0, -9.0], 90);
prop('conbini_copy', 'copy_machine', [24.5, 0, -10.3], 90, { interact: false });
prop('conbini_trash', 'trash_bins', [26.4, 0, -6.45], 0, { interact: false });
for (const x of [31.6, 34.0, 36.4]) prop(`conbini_carstop_${x}`, 'car_stop', [x, 0, -6.55], 0, { interact: false });
floor([30.75, -7.0, 30.85, -3.6], 'road_line', { layer: 3 });
floor([33.15, -7.0, 33.25, -3.6], 'road_line', { layer: 3 });
floor([35.55, -7.0, 35.65, -3.6], 'road_line', { layer: 3 });
posters.push({ id: 'conbini_poster', tex: 'conbini_poster', pos: [36.5, 1.7, -6.95], rot: 0, size: [0.5, 0.7] });

// ── Shrine (神社) ───────────────────────────────────────────────────────────
floor([-56, -52, -26, -4], 'gravel', { surface: 'gravel', uv: 1.5, layer: 1 });
floor([-41.5, -32.5, -38.5, -3], 'stone_path', { surface: 'stone', uv: 1, layer: 2 });
fence([-56, -4], [-41.6, -4]);
fence([-38.4, -4], [-26, -4]);
fence([-56, -4], [-56, -52]);
fence([-26, -4], [-26, -52]);
fence([-56, -52], [-26, -52]);
prop('shr_torii', 'torii', [-40, 0, -6], 0, { interact: false });
for (const z of [-12, -20]) {
  prop(`shr_lantern_w${z}`, 'stone_lantern', [-42.4, 0, z], 0, { interact: false });
  prop(`shr_lantern_e${z}`, 'stone_lantern', [-37.6, 0, z], 0, { interact: false });
}
prop('shr_chozuya', 'chozuya', [-45, 0, -16], 90);
prop('shr_komainu_w', 'komainu', [-42.7, 0, -26], 0, { interact: 'shr_komainu' });
prop('shr_komainu_e', 'komainu', [-37.3, 0, -26], 0, { interact: 'shr_komainu', scale: [-1, 1, 1] });
prop('shr_haiden', 'haiden', [-40, 0, -36], 0, { occluder: true });
prop('shr_saisen', 'saisen_box', [-40, 0, -31.6], 0);
prop('shr_office', 'shrine_office', [-31, 0, -24], -90, { interact: false, occluder: true });
prop('shr_ema', 'ema_rack', [-35.6, 0, -29.2], -90);
prop('shr_shinboku', 'shinboku', [-48.5, 0, -25.5], 0);
prop('shr_hokora', 'hokora', [-40, 0, -47.2], 0);
prop('shr_kura', 'kura', [-51.2, 0, -42], 90);
prop('shr_bench', 'bench', [-34.2, 0, -13.5], -90, { interact: false });
box([-37.0, 0, -9.3], [-36.9, 1.0, -9.25], 'wood_dark');                   // 由緒書き posts
box([-37.0, 0, -8.15], [-36.9, 1.0, -8.1], 'wood_dark');
box([-37.0, 0.95, -9.35], [-36.92, 1.85, -8.05], 'wood_dark');
posters.push({ id: 'shr_yuisho', tex: 'shrine_yuisho', pos: [-36.91, 1.4, -8.7], rot: -90, size: [1.2, 0.85], interact: 'shr_yuisho' });
const cedars: [number, number][] = [
  [-54, -8], [-54.2, -14], [-53.8, -20], [-54, -27], [-54.3, -33], [-54, -39], [-53.6, -46], [-52, -50.2],
  [-28, -10], [-28.2, -16], [-28, -21], [-28.4, -30], [-28, -36], [-28.3, -43], [-28, -49.5],
  [-47, -50], [-43.5, -50.3], [-36.5, -50.2], [-33, -49.6], [-30.5, -47],
  [-35.8, -43.6], [-33.6, -39.8], [-46.8, -45.6], [-44.6, -42.4], [-49.6, -36.6], [-46.2, -10.4], [-33.2, -18.6],
];
cedars.forEach(([x, z], i) => prop(`shr_cedar_${i}`, 'cedar_tree', [x, 0, z], (i * 47) % 360, { interact: false, scale: 0.85 + ((i * 7) % 5) * 0.08 }));

// ── Anchors (face spawn points and other markers) ───────────────────────────
anchor('anc_fridge_inside', [0, 1.26, 0.02], { prop: 'apt_fridge' });
anchor('anc_washer_inside', [0, 0.72, 0.0], { prop: 'apt_washer' });
anchor('anc_toilet_bowl', [0, 0.36, 0.1], { prop: 'apt_toilet' });
anchor('anc_mirror', [0, 1.45, -0.165], { prop: 'apt_sink' });
anchor('anc_bathtub', [0, 0.32, 0.25], { prop: 'apt_bathtub' });
anchor('anc_under_bed', [0.45, 0.1, -0.28], { prop: 'apt_bed' });
anchor('anc_ceiling_bed', [-18.55, 2.28, 14.1]);
anchor('anc_tv_screen', [0, 0.72, 0.07], { prop: 'apt_tv' });
anchor('anc_closet_gap', [0.42, 1.55, 0.12], { prop: 'apt_closet' });
anchor('anc_window_outside', [-20.4, 1.55, 15.75]);
anchor('anc_room_corner', [-21.75, 2.0, 14.75]);
anchor('anc_door_outside', [-21.2, 1.48, 6.25]);
anchor('anc_kitchen_end', [-21.6, 1.7, 8.2]);
anchor('anc_curve_mirror', [0, 2.6, 0.1], { prop: 'ext_curve_mirror' });
anchor('anc_street_far', [19.5, 1.6, -50]);
anchor('anc_board_behind', [-11.02, 1.45, -3.86]);
anchor('anc_phonebooth', [0, 1.55, 0], { prop: 'ext_phonebooth' });
anchor('anc_torii', [-40, 1.75, -6.6]);
anchor('anc_haiden', [-40, 2.05, -32.4]);
anchor('anc_shinboku', [-47.3, 1.8, -24.9]);
anchor('anc_hokora', [0, 1.05, 0.5], { prop: 'shr_hokora' });
anchor('anc_conbini_window', [26.0, 1.6, -6.72]);
anchor('anc_conbini_fridge', [0, 1.3, -0.12], { prop: 'conbini_fridge_2' });
anchor('anc_stairs', [-30.85, 3.25, 6.55]);
// NPC standing spots
anchor('npc_clerk_spot', [36.3, 0, -11], { yaw: 90 });
anchor('npc_shrine_spot', [0, 0, 1.0], { prop: 'shr_office', yaw: 180 });
anchor('npc_neighbor_spot', [-4.2, 0, 2.95], { yaw: 0 });
anchor('npc_nao_door', [-21.2, 0, 5.95], { yaw: 180 });
anchor('npc_nao_genkan', [-21.05, 0, 7.6], { yaw: 180 });
anchor('npc_nao_room', [-19.62, 0, 13.0], { yaw: 90 });
anchor('npc_nao_bedside', [-19.45, 0, 14.4], { yaw: 90 });
anchor('npc_extra_spot', [-11.4, 0, -2.6], { yaw: 0 });

// ── Zones ───────────────────────────────────────────────────────────────────
zone('zone_apt', [-22, 7, -18, 15], { region: 'apt' });
zone('zone_apt_genkan', [-22, 7, -20.7, 8], { region: 'apt' });
zone('zone_apt_kitchen', [-22, 8, -19.7, 10.4], { region: 'apt' });
zone('zone_apt_bath', [-19.7, 7, -18, 9.6], { region: 'apt' });
zone('zone_apt_room', [-22, 10.4, -18, 15], { region: 'apt' });
zone('zone_apt_balcony', [-22, 15, -18, 16.2]);
zone('zone_corridor', [-31.5, 5.6, -14, 7]);
zone('zone_apt_lot', [-32, 3.5, -12, 18]);
zone('zone_street', [-60, -3.5, 60, 3.5]);
zone('zone_side_street', [16.5, -58, 22.5, -3.5]);
zone('zone_board', [-12, -3.5, -8, 0]);
zone('zone_vending', [-14.2, 1.4, -11.5, 3.5]);
zone('zone_neighbor', [-7, 0.5, -1.5, 3.5]);
zone('zone_phonebooth', [-35.6, 1.8, -32.8, 3.5]);
zone('zone_conbini_lot', [22, -7.2, 38.1, -3]);
zone('zone_conbini_in', [24, -17, 38, -7], { region: 'conbini' });
zone('zone_shrine', [-56, -52, -26, -4]);
zone('zone_shrine_gate', [-42.5, -9, -37.5, -3]);
zone('zone_haiden', [-44, -32.6, -36, -28.5]);
zone('zone_shrine_office', [-34.6, -27, -32.9, -21]);
zone('zone_shrine_back', [-48, -52, -32, -39.6]);

// ── Lights ──────────────────────────────────────────────────────────────────
light({ id: 'apt_light_kitchen', pos: [-20.9, 2.22, 9.0], color: '#fff1dc', intensity: 5, distance: 6, region: 'apt', emissive: [{ prop: 'apt_ceil_kitchen' }] });
light({ id: 'apt_light_room', pos: [-20.0, 2.18, 12.7], color: '#fff4e2', intensity: 10, distance: 9, region: 'apt', emissive: [{ prop: 'apt_ceil_room' }] });
light({ id: 'apt_light_bath', pos: [-18.85, 2.0, 8.3], color: '#fff0d8', intensity: 3.5, distance: 4, region: 'apt', emissive: [{ prop: 'apt_ceil_bath' }] });
light({ id: 'apt_fridge_light', pos: [0, 1.3, 0.3], prop: 'apt_fridge', color: '#eef6ff', intensity: 1.6, distance: 3.5, region: 'apt', emissive: [{ prop: 'apt_fridge', mat: 'emit_fridge' }] });
light({ id: 'apt_moon', pos: [-20.4, 1.7, 14.4], color: '#7f93c4', intensity: 0.45, distance: 6.5, region: 'apt', on: { night: true, day: false, evening: false } });
light({ id: 'apt_tv_light', pos: [0, 0.75, 0.75], prop: 'apt_tv', color: '#a8b8ff', intensity: 1.6, distance: 4.5, region: 'apt' });
light({ id: 'ext_corridor_light', pos: [-20.6, 2.42, 6.3], color: '#e6fff0', intensity: 4, distance: 7, kind: 'pooled', region: 'out', portal: 'apt_door', on: { night: true, day: false }, flicker: true, emissive: [{ prop: 'ext_fl_103' }] });
light({ id: 'ext_corridor_light_101', pos: [-28.6, 2.42, 6.3], color: '#e6fff0', intensity: 3, distance: 6, kind: 'pooled', region: 'out', on: { night: true, day: false }, emissive: [{ prop: 'ext_fl_101' }] });
light({ id: 'ext_corridor_light_104', pos: [-16.6, 2.42, 6.3], color: '#e6fff0', intensity: 3, distance: 6, kind: 'pooled', region: 'out', on: { night: true, day: false }, emissive: [{ prop: 'ext_fl_104' }] });
light({ id: 'ext_vending_light', pos: [-12.85, 1.4, 3.05], color: '#dcefff', intensity: 2.5, distance: 5, kind: 'pooled', region: 'out', on: { night: true, day: true }, emissive: [{ prop: 'ext_vending', mat: 'emit_vending' }] });
light({ id: 'conbini_in_1', pos: [28, 2.85, -12], color: '#f5fbff', intensity: 14, distance: 13, kind: 'pooled', region: 'conbini', on: { night: true, day: true }, emissive: [{ prop: 'conbini_fridge_1' }, { prop: 'conbini_fridge_2' }, { prop: 'conbini_fridge_3' }, { prop: 'conbini_counter' }, { prop: 'conbini_atm' }] });
light({ id: 'conbini_in_2', pos: [34, 2.85, -12], color: '#f5fbff', intensity: 14, distance: 13, kind: 'pooled', region: 'conbini', on: { night: true, day: true } });
light({ id: 'conbini_out', pos: [31, 2.5, -5.2], color: '#f5fbff', intensity: 5, distance: 9, kind: 'pooled', region: 'out', on: { night: true, day: false }, emissive: [{ prop: 'conbini_sign' }] });
light({ id: 'shrine_office_light', pos: [-32.4, 2.3, -24], color: '#ffd8a0', intensity: 2, distance: 6, kind: 'pooled', region: 'out', on: { night: true, day: false } });
light({ id: 'phonebooth_light', pos: [-34.2, 2.1, 4.06], color: '#e8ffe8', intensity: 1.5, distance: 4, kind: 'pooled', region: 'out', on: { night: true, day: false }, flicker: true, emissive: [{ prop: 'ext_phonebooth', mat: 'emit_booth' }] });

// ── Posters on the bulletin board (textures/visibility are set per chapter) ──
const BOARD_Z = -3.495;
posters.push({ id: 'poster_1', tex: 'poster_missing_1', pos: [-10.62, 1.5, BOARD_Z], rot: 0, size: [0.3, 0.42], interact: 'ext_board' });
posters.push({ id: 'poster_2', tex: 'poster_missing_2', pos: [-10.2, 1.5, BOARD_Z], rot: 0, size: [0.3, 0.42], interact: 'ext_board' });
posters.push({ id: 'poster_3', tex: 'poster_missing_3', pos: [-9.78, 1.5, BOARD_Z], rot: 0, size: [0.3, 0.42], interact: 'ext_board', hidden: true });
posters.push({ id: 'poster_4', tex: 'poster_notice_1', pos: [-9.36, 1.66, BOARD_Z], rot: 0, size: [0.3, 0.3], interact: 'ext_board' });
posters.push({ id: 'poster_5', tex: 'poster_notice_2', pos: [-9.36, 1.24, BOARD_Z], rot: 0, size: [0.3, 0.3], interact: 'ext_board' });

// ── Spawn points ────────────────────────────────────────────────────────────
const spawns: Record<string, SpawnDef> = {
  spawn_bed: { pos: [-19.4, 0, 13.7], yaw: 90 },
  spawn_genkan: { pos: [-21.0, 0, 8.35], yaw: 180 },
  spawn_kitchen: { pos: [-20.85, 0, 10.05], yaw: 90 },
  spawn_room: { pos: [-20.4, 0, 11.6], yaw: 180 },
  spawn_corridor: { pos: [-21.2, 0, 6.2], yaw: 0 },
  spawn_street: { pos: [-15.5, 0, 1.6], yaw: 90 },
  spawn_conbini: { pos: [29, 0, -4.4], yaw: 0 },
  spawn_shrine: { pos: [-40, 0, -4.6], yaw: 0 },
  spawn_hokora: { pos: [-40, 0, -44.6], yaw: 0 },
};

// Areas the player may stand in (a safety net on top of the walls).
const walkable: Rect[] = [
  [-58, -3.3, 58, 3.3],          // main street
  [16.9, -56, 22.1, -3],         // side street
  [-31.8, 3.4, -12.2, 17.8],     // apartment lot, corridor, unit 103 (walls do the rest)
  [-17.6, 3.0, -13.4, 3.6],      // lot entrance
  [22.0, -17, 38.0, -3],         // convenience store and parking
  [-55.8, -51.8, -26.2, -3.2],   // shrine grounds
  [-41.6, -4.2, -38.4, -3],      // shrine gate
];

export const LAYOUT: Layout = { floors, walls, boxes, props, anchors, zones, lights, posters, spawns, walkable, wires };
