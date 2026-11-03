import * as THREE from 'three';
import type { TextureLib } from './textures';
import { Prop } from './Prop';
import type { World } from './World';

// Story-specific nodes the Blender models don't carry (docs/SCENARIO.md §7-B).
// They are built here so they can be toggled with prop.showNode(name, bool)
// like any other node. All of them start hidden every chapter.

const std = (color: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });

function attach(prop: Prop, node: THREE.Object3D, local: [number, number, number], parent?: THREE.Object3D): void {
  const host = parent ?? prop.root.children[0] ?? prop.root;
  node.position.set(...local);
  host.add(node);
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false;
    m.receiveShadow = true;
    m.userData.propId = prop.id;
    m.userData.interactId = prop.interactId;
    prop.meshes.push(m);
  });
}

function paper(tex: THREE.Texture, w: number, h: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  return m;
}

/** Irregular puddle alpha texture (procedural). */
function puddleTexture(seed: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 26; i++) {
    const x = 18 + r() * 92, y = 18 + r() * 92, rad = 10 + r() * 26;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export interface NodeDefault {
  prop: string;
  node: string;
  visible: boolean;
}

export function addScenarioExtras(world: World, tex: TextureLib): NodeDefault[] {
  const defaults: NodeDefault[] = [];
  const hide = (prop: string, node: THREE.Object3D) => {
    node.visible = false;
    defaults.push({ prop, node: node.name, visible: false });
  };

  // 分電盤: masking tape over the lighting breaker + the memo under it (D01)
  const breaker = world.props.get('apt_breaker');
  if (breaker) {
    const tape = new THREE.Group();
    tape.name = 'tape';
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.004), std('#d8c27a', { roughness: 0.6 }));
    strip.position.set(0.015, 0.155, 0.03);
    strip.rotation.z = -0.12;
    const memo = paper(tex.get('memo_breaker'), 0.085, 0.06);
    memo.position.set(0.0, -0.045, 0.052);
    memo.rotation.z = 0.05;
    const tape2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.003), std('#d8c27a', { roughness: 0.6 }));
    tape2.position.set(0.0, -0.012, 0.054);
    tape.add(strip, memo, tape2);
    attach(breaker, tape, [0, 0, 0]);
    hide('apt_breaker', tape);
  }

  // 浴槽: water up to the rim (overflowing)
  const tub = world.props.get('apt_bathtub');
  if (tub) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 1.48),
      new THREE.MeshStandardMaterial({ color: '#2e3c44', roughness: 0.04, metalness: 0.25, transparent: true, opacity: 0.86 }),
    );
    water.name = 'water_full';
    water.rotation.x = -Math.PI / 2;
    attach(tub, water, [0, 0.52, 0]);
    hide('apt_bathtub', water);
  }

  // 床の水たまり: from the unit bath door to the washing machine (its own toggleable prop)
  {
    const group = new THREE.Group();
    group.name = 'apt_floor_water';
    const mat = new THREE.MeshStandardMaterial({ color: '#1d2830', roughness: 0.03, metalness: 0.4, transparent: true, opacity: 0.8, alphaMap: puddleTexture(7), depthWrite: false });
    const patch = (x0: number, z0: number, x1: number, z1: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
      m.renderOrder = 1;
      group.add(m);
    };
    patch(-19.68, 7.85, -18.78, 9.58);   // unit bath floor
    patch(-20.55, 8.45, -19.7, 9.95);    // hall in front of the bath door
    patch(-19.68, 9.62, -18.72, 10.38);  // washing machine nook
    world.root.add(group);
    const prop = new Prop({ id: 'apt_floor_water', model: 'proc_floor_water', pos: [0, 0, 0], interact: false, hidden: true }, group, {});
    world.props.set('apt_floor_water', prop);
    prop.visible = false;
  }

  // 洗面台: white towel hung over the mirror / dropped on the floor
  const sink = world.props.get('apt_sink');
  if (sink) {
    const cloth = std('#e8e6df', { roughness: 0.95 });
    const towel = new THREE.Group();
    towel.name = 'towel';
    for (let i = 0; i < 4; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.17, 0.012), cloth);
      panel.position.set(0, 1.74 - i * 0.165, -0.165 + (i % 2) * 0.008);
      panel.rotation.x = (i % 2 ? -1 : 1) * 0.04;
      towel.add(panel);
    }
    attach(sink, towel, [0, 0, 0]);
    hide('apt_sink', towel);
    const floor = new THREE.Group();
    floor.name = 'towel_floor';
    for (let i = 0; i < 3; i++) {
      const lump = new THREE.Mesh(new THREE.BoxGeometry(0.28 - i * 0.05, 0.03, 0.18 - i * 0.03), cloth);
      lump.position.set(0.05 * i - 0.05, 0.015 + i * 0.022, 0.42 + i * 0.02);
      lump.rotation.y = i * 0.7;
      floor.add(lump);
    }
    attach(sink, floor, [0, 0, 0]);
    hide('apt_sink', floor);
  }

  // 冷蔵庫: the memo with a red magnet (D02), on the door so it swings with it
  const fridge = world.props.get('apt_fridge');
  if (fridge) {
    const door = fridge.node('door');
    const memo = new THREE.Group();
    memo.name = 'memo';
    const sheet = paper(tex.get('memo_fridge'), 0.11, 0.14);
    const magnet = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.01, 10), std('#c0141a', { roughness: 0.4 }));
    magnet.rotation.x = Math.PI / 2;
    magnet.position.set(0, 0.06, 0.006);
    memo.add(sheet, magnet);
    if (door) {
      door.updateWorldMatrix(true, false);
      // door-local: the door node sits on the hinge (x=+0.30, z=+0.325) and spans -X
      attach(fridge, memo, [-0.17, 0.28, 0.013], door);
    } else attach(fridge, memo, [0.13, 1.28, 0.338]);
    hide('apt_fridge', memo);
  }

  // クローゼット: the 天袋 board has come off (dark gap at the top, board on the floor)
  const closet = world.props.get('apt_closet');
  if (closet) {
    const g = new THREE.Group();
    g.name = 'tenbukuro_open';
    const hole = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.16, 0.01), new THREE.MeshBasicMaterial({ color: '#030303' }));
    hole.position.set(0.4, 2.12, 0.355);
    // the board fell inside, across the door sill: visible once the right door slides open
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.018, 0.2), std('#e4e0d6'));
    board.position.set(0.42, 0.06, 0.2);
    board.rotation.set(0.12, 0.18, 0);
    g.add(hole, board);
    attach(closet, g, [0, 0, 0]);
    hide('apt_closet', g);
    const diary = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.016, 0.18), std('#b9a7cf'));
    diary.name = 'diary_book';
    diary.rotation.y = -0.3;
    attach(closet, diary, [0.45, 0.085, 0.2]);
    hide('apt_closet', diary);
  }

  // ローテーブル: なおの置き手紙 (D12)
  const table = world.props.get('apt_lowtable');
  if (table) {
    const note = paper(tex.get('memo_nao'), 0.11, 0.14);
    (note.material as THREE.MeshStandardMaterial).color.set('#f1dfb4');
    note.name = 'note';
    note.rotation.x = -Math.PI / 2;
    note.rotation.z = 0.35;
    attach(table, note, [0.08, 0.376, 0.1]);
    hide('apt_lowtable', note);
  }

  // 祠: ashes, incense (with glow and smoke), hairpin, offered diary
  const hokora = world.props.get('shr_hokora');
  if (hokora) {
    hokora.root.updateWorldMatrix(true, true);
    const top = new THREE.Box3().setFromObject(hokora.root);
    const ledgeY = Math.max(0.3, Math.min(0.7, (top.max.y - top.min.y) * 0.33));
    const fz = 0.5;
    const ash = new THREE.Group();
    ash.name = 'ash';
    for (let i = 0; i < 5; i++) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.03 + i * 0.004, 0.006, 0.02), std('#6b6660'));
      a.position.set(-0.08 + i * 0.035, ledgeY + 0.003, fz - 0.05 + (i % 2) * 0.03);
      a.rotation.y = i;
      ash.add(a);
    }
    attach(hokora, ash, [0, 0, 0]);
    hide('shr_hokora', ash);

    const incense = new THREE.Group();
    incense.name = 'incense';
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.05, 10), std('#4a4038'));
    holder.position.set(0, ledgeY + 0.025, fz);
    incense.add(holder);
    const emberMat = new THREE.MeshStandardMaterial({ color: '#331100', emissive: '#ff4a10', emissiveIntensity: 2.2 });
    emberMat.name = 'emit_incense';
    for (let i = 0; i < 3; i++) {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.16, 4), std('#3f5a2c'));
      const x = -0.012 + i * 0.012;
      stick.position.set(x, ledgeY + 0.13, fz);
      stick.rotation.z = (i - 1) * 0.12;
      const ember = new THREE.Mesh(new THREE.SphereGeometry(0.004, 6, 4), emberMat);
      ember.position.set(x - (i - 1) * 0.01, ledgeY + 0.21, fz);
      incense.add(stick, ember);
    }
    const smokeMat = new THREE.MeshBasicMaterial({ color: '#cfcfcf', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const puff = new THREE.Mesh(new THREE.PlaneGeometry(0.05 + i * 0.03, 0.12), smokeMat);
      puff.position.set(Math.sin(i * 1.7) * 0.02, ledgeY + 0.28 + i * 0.1, fz);
      puff.name = `smoke_${i}`;
      incense.add(puff);
    }
    attach(hokora, incense, [0, 0, 0]);
    hide('shr_hokora', incense);

    const pin = new THREE.Group();
    pin.name = 'hairpin';
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.004, 0.008), std('#c8c8c8', { metalness: 0.7, roughness: 0.3 }));
    const flower = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.005, 10), std('#f2b705', { roughness: 0.5 }));
    flower.position.set(0.028, 0.003, 0);
    const center = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 8), std('#5a3412'));
    center.position.set(0.028, 0.006, 0);
    pin.add(bar, flower, center);
    pin.position.set(0.12, ledgeY + 0.004, fz + 0.04);
    attach(hokora, pin, [0.12, ledgeY + 0.004, fz + 0.04]);
    hide('shr_hokora', pin);

    const diary = new THREE.Group();
    diary.name = 'diary_offer';
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.012, 0.15), std('#c9b9d8'));
    book.rotation.y = 0.2;
    diary.add(book);
    attach(hokora, diary, [-0.12, ledgeY + 0.006, fz + 0.02]);
    hide('shr_hokora', diary);
  }
  return defaults;
}
