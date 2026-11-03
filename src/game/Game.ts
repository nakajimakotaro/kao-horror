import * as THREE from 'three';
import { AudioEngine, type SoundHandle } from '../audio/AudioEngine';
import { CollisionWorld } from '../core/Collision';
import { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import { Player } from '../core/Player';
import { UI, type ListEntry } from '../ui/UI';
import { Assets } from '../world/Assets';
import { LAYOUT } from '../world/layout';
import { BASE_TEXTURES, TextureLib } from '../world/textures';
import { CONTENT_TEXTURES } from '../world/textures_content';
import type { V3 } from '../world/types';
import { World } from '../world/World';
import type { ChapterDef } from './Chapter';
import { CHAPTERS } from './chapters';
import { ENDINGS } from './content/endings';
import { ITEMS } from './content/items';
import { META } from './content/meta';
import { SHOPS } from './content/shops';
import { Aborted, Ctx, type ZoneHandlers } from './Ctx';
import { buildDefaults } from './defaults';
import { Face, FaceSystem } from './face/FaceSystem';
import { Flashlight } from './Flashlight';
import { Interaction } from './Interaction';
import { loadSettings, saveSettings, type Settings } from './Settings';
import { GameState, type Snapshot } from './State';

const DEG = Math.PI / 180;

type Mode = 'boot' | 'title' | 'play' | 'paused' | 'gameover' | 'ending' | 'transition';

interface Runtime {
  zones: Map<string, ZoneHandlers & { inside: boolean }>;
  timers: { t: number; fn: () => void | Promise<void>; every: number }[];
  watchers: { cond: () => boolean; fn: () => void | Promise<void> }[];
  loops: SoundHandle[];
  blackout: (() => boolean | void | Promise<boolean | void>) | null;
  shopBought: Record<string, number>;
  gameOverReason: string | null;
  autoDoorChime: boolean;
}

const STEP_SOUND: Record<string, string> = {
  wood: 'step_wood', tile: 'step_tile', concrete: 'step_concrete', asphalt: 'step_concrete', stone: 'step_concrete',
  metal: 'step_concrete', gravel: 'step_gravel', dirt: 'step_gravel', grass: 'step_gravel',
};

/** Orchestrates engine, world, player, faces, UI, audio and the chapter scripts. */
export class Game {
  readonly engine: Engine;
  readonly input: Input;
  readonly collision = new CollisionWorld();
  readonly textures = new TextureLib(BASE_TEXTURES, CONTENT_TEXTURES);
  readonly assets = new Assets();
  readonly world: World;
  readonly player = new Player();
  readonly interaction: Interaction;
  readonly faces: FaceSystem;
  readonly flashlight: Flashlight;
  readonly audio = new AudioEngine();
  readonly ui: UI;
  readonly state = new GameState();
  settings: Settings = loadSettings();
  mode: Mode = 'boot';
  gen = 0;
  lockCount = 0;
  chapter: ChapterDef | null = null;
  ctx: Ctx | null = null;
  runtime: Runtime = Game.freshRuntime();
  readonly eyes = { amount: 0, closed: false, closedTime: 0, force: null as boolean | null, lid: -1 };
  scriptFear = { level: 0, t: 0 };
  private cp: Snapshot | null = null;
  private objective: string | null = null;
  private waits: { t: number; resolve: () => void }[] = [];
  private fade = { v: 1, from: 1, to: 1, t: 0, dur: 0, resolve: null as null | (() => void) };
  private flashState = { color: new THREE.Color(), t: 0, dur: 0 };
  private clockState = { h: 3, m: 0, acc: 0, rate: 0, shown: '' };
  private fear = 0;
  private heartT = 0;
  private stareLoop: SoundHandle | null = null;
  private emitters: SoundHandle[] = [];
  readonly emitterMap = new Map<string, SoundHandle>();
  private tvMode: 'off' | 'static' | 'on' = 'off';
  private tvTex: THREE.CanvasTexture | null = null;
  private inPeephole = false;
  /** lying in bed awake (c.lieAwake): look limits around the lying pose */
  lying: { o: { pos: THREE.Vector3; yaw: number; pitch: number; roll: number }; cy: number; range: number; pitchMin: number } | null = null;
  private last = performance.now();
  private time = 0;
  private dialogueDepth = 0;

  static freshRuntime(): Runtime {
    return { zones: new Map(), timers: [], watchers: [], loops: [], blackout: null, shopBought: {}, gameOverReason: null, autoDoorChime: true };
  }

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);
    this.ui = new UI(uiRoot);
    this.textures.maxAnisotropy = this.engine.renderer.capabilities.getMaxAnisotropy();
    this.textures.register('mw_display', { w: 64, h: 24, clamp: true, draw: (g, w, h) => {
      g.fillStyle = '#020604'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#5dff9a'; g.font = 'bold 18px "DotGothic16", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`${this.clockState.h % 24}:${String(this.clockState.m).padStart(2, '0')}`, w / 2, h / 2 + 1);
    } });
    this.world = new World(this.engine.scene, this.collision, this.textures, this.assets);
    this.interaction = new Interaction(this.world);
    this.faces = new FaceSystem(this.engine.scene, (a, b) => this.world.occluderCandidates(a, b));
    this.flashlight = new Flashlight(this.engine);
    this.faces.onLethal = (f) => void this.onLethal(f);
    this.player.onStep = (run) => {
      const s = this.world.surfaceAt(this.player.pos.x, this.player.pos.z);
      this.audio.play(STEP_SOUND[s] ?? 'step_concrete', { volume: run ? 1 : 0.55, rate: 0.9 + Math.random() * 0.2 });
    };
    this.input.onLockChange = (locked) => {
      if (!locked && this.mode === 'play') this.pause();
      this.ui.setResumeHint(!locked && this.mode === 'play');
    };
    canvas.addEventListener('click', () => {
      if (this.mode === 'play') this.input.requestLock();
    });
    this.ui.onConfirmSound = () => this.audio.play('ui_confirm', { volume: 0.5 });
    this.ui.onTick = () => this.audio.play('text_tick', { volume: 0.25, rate: 0.95 + Math.random() * 0.1 });
    this.world.onAutoDoor = (_id, open) => { if (open && this.runtime.autoDoorChime) this.audio.play('conbini_chime', { at: this.world.anchor('anc_conbini_window') }); };
    this.applySettings();
    this.interaction.resolveDefault = (id) => (this.ctx ? buildDefaults(this.ctx, id) : null);
    requestAnimationFrame((t) => this.frame(t));
  }

  // ── boot / title ─────────────────────────────────────────────────────────
  async boot(): Promise<void> {
    const tip = META.tips[Math.floor(Math.random() * META.tips.length)] ?? '';
    this.ui.showLoading(0, tip);
    await this.world.build(LAYOUT, (k) => this.ui.showLoading(k * 0.95, tip));
    const fl = await this.assets.instance('flashlight');
    if (fl) this.flashlight.setModel(fl);
    this.showTitle();
  }

  showTitle(): void {
    this.gen++;
    this.mode = 'title';
    this.ctx = null;
    this.chapter = null;
    this.ui.reset();
    this.faces.clear();
    this.interaction.clear();
    this.stopRuntime();
    this.world.resetState();
    this.world.setTime('night');
    this.flashlight.on = false;
    this.flashlight.owned = false;
    this.lockCount = 0;
    this.player.override = null;
    this.player.lookLimit = null;
    this.lying = null;
    this.eyes.lid = -1;
    this.eyes.force = null;
    this.engine.post.u.uFisheye.value = 0;
    this.player.teleport(-22.6, 0, 3.2, -132, 4);
    this.ui.setHudVisible(false);
    this.ui.setObjective(null);
    this.ui.setClock(null);
    this.ui.setMoney(null);
    this.ui.setBattery(null);
    this.input.releaseLock();
    this.fadeTo(0, 2);
    const endings = GameState.endings().map((id) => ENDINGS[id]?.label ?? id);
    this.ui.showTitle({
      title: META.title, sub: META.titleSub, warn: META.warn, hasSave: !!GameState.load(), endings,
      onStart: () => void this.newGame(),
      onContinue: () => void this.continueGame(),
      onSettings: () => this.ui.showSettings(this.settings, (s) => this.onSettings(s), () => this.showTitle()),
      onControls: () => this.ui.showControls(() => this.showTitle()),
    });
  }

  private async newGame(): Promise<void> {
    this.audio.init();
    this.ui.hideScreen();
    this.state.reset();
    this.mode = 'transition';
    await this.fadeTo(1, 0.8);
    await this.audio.warmup();
    this.startEmitters();
    this.input.requestLock();
    await this.startChapter(CHAPTERS[0].id, { fromCheckpoint: false });
  }

  private async continueGame(): Promise<void> {
    const s = GameState.load();
    if (!s) return;
    this.audio.init();
    this.ui.hideScreen();
    this.state.restore(s);
    this.mode = 'transition';
    await this.fadeTo(1, 0.8);
    await this.audio.warmup();
    this.startEmitters();
    this.input.requestLock();
    await this.startChapter(s.chapter, { fromCheckpoint: true });
  }

  startEmitters(): void {
    if (this.emitters.length) return;
    const at = (id: string, dy = 1) => this.world.prop(id).position.add(new THREE.Vector3(0, dy, 0));
    const add = (id: string, h: SoundHandle) => { this.emitters.push(h); this.emitterMap.set(id, h); };
    add('fridge_hum', this.audio.loop('fridge_hum', { at: at('apt_fridge'), volume: 0.8 }));
    add('vending_hum', this.audio.loop('vending_hum', { at: at('ext_vending'), volume: 0.7 }));
    add('fluorescent_buzz', this.audio.loop('fluorescent_buzz', { at: at('ext_fl_103', -0.1), volume: 0.6 }));
  }

  // ── chapters ─────────────────────────────────────────────────────────────
  findChapter(id: string): ChapterDef {
    const c = CHAPTERS.find((x) => x.id === id);
    if (!c) throw new Error(`unknown chapter ${id}`);
    return c;
  }

  async startChapter(id: string, o: { fromCheckpoint: boolean }): Promise<void> {
    const def = this.findChapter(id);
    this.gen++;
    const gen = this.gen;
    this.mode = 'transition';
    this.lockCount = 0;
    if (this.fade.v < 1) await this.fadeTo(1, 0.7);
    if (gen !== this.gen) return;
    this.abortPeephole();
    this.ui.reset();
    this.ui.hideScreen();
    this.dialogueChain = Promise.resolve();
    this.dialogueDepth = 0;
    this.faces.clear();
    this.faces.releaseLock();
    this.interaction.clear();
    this.stopRuntime();
    this.world.resetState();
    this.world.setTime(def.time);
    this.engine.post.u.uFisheye.value = 0;
    this.engine.post.u.uRed.value = 0;
    this.player.override = null;
    this.player.lookLimit = null;
    this.inPeephole = false;
    this.eyes.force = null;
    this.eyes.lid = -1;
    this.scriptFear = { level: 0, t: 0 };
    this.setTv('off');
    if (!o.fromCheckpoint) {
      this.state.chapter = id;
      this.state.checkpoint = null;
      this.state.pos = undefined;
      if (def.money !== undefined) this.state.money = def.money;
    }
    this.cp = this.state.snapshot();
    this.state.save(this.cp);
    this.chapter = def;
    for (const [id, h] of this.emitterMap) h.setVolume(id === 'fridge_hum' ? 0.8 : id === 'vending_hum' ? 0.7 : 0.6, 0.5);
    const ctx = (this.ctx = new Ctx(this, def, gen));
    this.flashlight.owned = this.state.has('flashlight');
    this.flashlight.enabled = true;
    this.flashlight.on = !!def.flashlightOn && this.flashlight.owned && this.state.battery > 0;
    const resumed = !!(o.fromCheckpoint && this.state.checkpoint && this.state.pos);
    this.lying = null;
    if (resumed) {
      const p = this.state.pos!;
      this.player.teleport(p[0], p[1], p[2], p[3]);
    } else this.teleport(typeof def.spawn === 'function' ? def.spawn(ctx) : def.spawn);
    const wake = typeof def.wakeUp === 'function' ? def.wakeUp(ctx) : !!def.wakeUp;
    const ck = def.clock ?? { h: def.time === 'day' ? 12 : 3, m: 0 };
    const saved = resumed && typeof this.state.flags._clock === 'string' ? this.state.flags._clock.split(':').map(Number) : null;
    if (saved && saved.length === 3 && saved.every((n) => Number.isFinite(n))) this.setClock(saved[0], saved[1], saved[2]);
    else this.setClock(ck.h, ck.m, ck.rate ?? 0);
    this.setObjective(null);
    this.ui.setHudVisible(true);
    if (def.ambience !== undefined) this.audio.ambience(def.ambience, 1, 1.5);
    try {
      def.setup(ctx);
    } catch (e) {
      if (!(e instanceof Aborted)) console.error(`[chapter ${id}] setup failed`, e);
    }
    this.mode = 'play';
    this.lockCount++;
    if (def.title && !resumed) await this.ui.card(def.title, def.subtitle ?? '', 3.2);
    if (gen !== this.gen) return;
    if (wake && !resumed) {
      this.eyes.lid = 1;
      void this.fadeTo(0, 1.2);
      this.lockCount = Math.max(0, this.lockCount - 1);
      await this.wakeUpAnimation(false);
    } else {
      await this.fadeTo(0, 1.0);
      this.lockCount = Math.max(0, this.lockCount - 1);
    }
    if (gen !== this.gen) return;
    if (def.intro && !resumed) this.spawnScript(() => def.intro!(ctx));
  }

  private stopRuntime(): void {
    for (const h of this.runtime.loops) h.stop(0.4);
    this.runtime = Game.freshRuntime();
    this.waits = [];
  }

  checkpoint(tag: string | null): void {
    this.state.checkpoint = tag;
    const p = this.player.pos;
    this.state.pos = [p.x, p.y, p.z, this.player.yaw / DEG];
    this.state.flags._clock = `${this.clockState.h}:${this.clockState.m}:${this.clockState.rate}`;
    this.cp = this.state.snapshot();
    this.state.save(this.cp);
    this.ui.toast('（チェックポイント）');
  }

  /** Run an async script; Aborted errors are expected when chapters change. */
  spawnScript(fn: () => void | Promise<void>): void {
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        if (!(e instanceof Aborted)) console.error('[script]', e);
      });
  }

  /** Modal UI calls are serialized so two scripts never fight over the dialogue box. */
  dialogue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const gen = this.gen;
      this.dialogueDepth++;
      try {
        return await fn();
      } finally {
        if (gen === this.gen) this.dialogueDepth = Math.max(0, this.dialogueDepth - 1);
      }
    };
    const p = this.dialogueChain.then(run, run);
    this.dialogueChain = p.then(() => undefined, () => undefined);
    return p;
  }
  private dialogueChain: Promise<void> = Promise.resolve();

  setObjective(text: string | null): void {
    this.objective = text;
    this.ui.setObjective(text);
    if (text) this.audio.play('objective', { volume: 0.4 });
  }

  // ── time helpers ─────────────────────────────────────────────────────────
  wait(sec: number): Promise<void> {
    return new Promise((resolve) => this.waits.push({ t: sec, resolve }));
  }

  fadeTo(v: number, sec: number): Promise<void> {
    this.fade.resolve?.();
    return new Promise((resolve) => {
      Object.assign(this.fade, { from: this.fade.v, to: v, t: 0, dur: Math.max(0.001, sec), resolve });
    });
  }

  flash(color: string, sec: number): void {
    this.flashState.color.set(color);
    this.flashState.t = sec;
    this.flashState.dur = sec;
  }

  clockNow(): { h: number; m: number; rate: number } {
    return { h: this.clockState.h, m: this.clockState.m, rate: this.clockState.rate };
  }

  setClock(h: number, m: number, rate = 0): void {
    Object.assign(this.clockState, { h, m, acc: 0, rate });
    this.refreshClock();
  }

  private refreshClock(): void {
    const { h, m } = this.clockState;
    const hh = ((h % 24) + 24) % 24;
    const text = `${hh < 12 ? 'AM' : 'PM'} ${hh % 12 === 0 && hh >= 12 ? 12 : hh % 12}:${String(m).padStart(2, '0')}`;
    if (text !== this.clockState.shown) {
      this.clockState.shown = text;
      this.ui.setClock(text);
      this.textures.redraw('mw_display');
    }
  }

  teleport(to: string | { pos: V3; yaw?: number }): void {
    if (typeof to === 'string') {
      if (this.world.layout.spawns[to]) {
        const s = this.world.spawn(to);
        this.player.teleport(s.pos[0], s.pos[1], s.pos[2], s.yaw);
      } else {
        const p = this.world.anchor(to);
        this.player.teleport(p.x, 0, p.z, this.world.anchorYaw(to));
      }
    } else this.player.teleport(to.pos[0], to.pos[1], to.pos[2], to.yaw);
  }

  // ── tv ───────────────────────────────────────────────────────────────────
  setTv(mode: 'off' | 'static' | 'on'): void {
    this.tvMode = mode;
    const tv = this.world.props.get('apt_tv');
    if (!tv) return;
    if (!this.tvTex) {
      const cv = document.createElement('canvas');
      cv.width = 96; cv.height = 64;
      this.tvTex = new THREE.CanvasTexture(cv);
      this.tvTex.colorSpace = THREE.SRGBColorSpace;
      this.tvTex.magFilter = THREE.NearestFilter;
    }
    for (const m of tv.materials('screen_tv')) {
      m.map = mode === 'static' ? this.tvTex : null;
      m.emissiveMap = mode === 'static' ? this.tvTex : null;
      m.emissive.set(mode === 'off' ? 0x000000 : mode === 'static' ? 0xffffff : 0x1a2a55);
      m.emissiveIntensity = mode === 'static' ? 1.3 : 1;
      m.color.set(mode === 'static' ? 0xffffff : 0x050607);
      m.needsUpdate = true;
    }
    const l = this.world.light('apt_tv_light');
    l.setOn(mode !== 'off').setFlicker(mode === 'static');
    l.level = mode === 'on' ? 0.5 : 1;
  }

  private drawTv(): void {
    if (this.tvMode !== 'static' || !this.tvTex) return;
    const cv = this.tvTex.image as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(cv.width, cv.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.tvTex.needsUpdate = true;
  }

  // ── shop / inventory ─────────────────────────────────────────────────────
  async openShop(id: string): Promise<void> {
    const shop = SHOPS[id];
    if (!shop) return;
    const entries: ListEntry[] = shop.items.map((s) => ({ id: s.item, name: s.name ?? ITEMS[s.item]?.name ?? s.item, desc: s.desc ?? ITEMS[s.item]?.desc ?? '', price: s.price, icon: ITEMS[s.item]?.icon }));
    this.ui.setMoney(this.state.money);
    await this.dialogue(() => this.ui.openList('shop', shop.title, entries, {
      money: () => this.state.money,
      buy: (itemId) => {
        const s = shop.items.find((x) => x.item === itemId)!;
        const key = `${id}:${itemId}`;
        const bought = this.runtime.shopBought[key] ?? 0;
        if (s.limit !== undefined && bought >= s.limit) return 'もう買えない。';
        if (this.state.money < s.price) { this.audio.play('ui_deny'); return 'お金が足りない。'; }
        this.state.money -= s.price;
        this.state.give(itemId);
        if (itemId === 'flashlight') this.flashlight.owned = true;
        this.runtime.shopBought[key] = bought + 1;
        this.state.flags[`bought_${itemId}`] = (Number(this.state.flags[`bought_${itemId}`]) || 0) + 1;
        this.audio.play('register');
        this.ui.setMoney(this.state.money);
        return `${ITEMS[itemId]?.name ?? itemId} を買った。`;
      },
    }));
  }

  private openInventory(): void {
    const entries: ListEntry[] = Object.entries(this.state.inv)
      .filter(([id, n]) => n > 0 && ITEMS[id])
      .map(([id, n]) => ({ id, name: ITEMS[id].name, desc: ITEMS[id].desc + (id === 'flashlight' ? `\n電池残量：${Math.round(this.state.battery * 100)}%` : ''), count: n, icon: ITEMS[id].icon }));
    this.audio.play('ui_open', { volume: 0.5 });
    void this.dialogue(() => this.ui.openList('inventory', `持ち物　　所持金 ¥${this.state.money.toLocaleString()}`, entries));
  }

  // ── peephole / bed animations ────────────────────────────────────────────
  async peephole(o: { minSec?: number; onEnter?: () => void }): Promise<void> {
    const door = this.world.prop('apt_door');
    const saved = { pos: this.player.pos.clone(), yaw: this.player.yaw, pitch: this.player.pitch, eye: this.player.eyeHeight, fl: this.flashlight.on };
    const outside = door.toWorld([0, 0, 0.09]);
    const yaw = (door.def.rot ?? 0) * DEG + Math.PI; // door front (+Z) faces the corridor
    this.inPeephole = true;
    this.flashlight.on = false;
    this.audio.play('peephole', { volume: 0.6 });
    await this.fadeTo(0.9, 0.25);
    this.player.pos.set(outside.x, 0, outside.z);
    this.player.eyeHeight = 1.45;
    this.player.yaw = yaw;
    this.player.pitch = 0;
    this.player.lookLimit = { yaw: 38, pitch: 26, cy: yaw, cp: 0 };
    this.player.canMove = false;
    this.lockCount++;
    this.engine.post.u.uFisheye.value = 1;
    o.onEnter?.();
    await this.fadeTo(0, 0.25);
    const t0 = this.time;
    let aborted = false;
    await new Promise<void>((resolve) => {
      this.peepAbort = () => { aborted = true; resolve(); };
      const check = () => {
        if (this.mode !== 'play' && this.mode !== 'paused') { resolve(); return; }
        const ok = this.time - t0 > (o.minSec ?? 0.6);
        if (ok && !this.ui.blocking && (this.input.pressed('back') || this.input.pressed('interact') || this.input.pressed('cancel'))) {
          this.input.consume('interact');
          resolve();
          return;
        }
        this.peepCheck = check;
      };
      this.peepCheck = check;
    });
    this.peepCheck = null;
    this.peepAbort = null;
    if (aborted) return;
    await this.fadeTo(0.9, 0.2);
    this.engine.post.u.uFisheye.value = 0;
    this.player.lookLimit = null;
    this.player.pos.copy(saved.pos);
    this.player.yaw = saved.yaw;
    this.player.pitch = saved.pitch;
    this.player.eyeHeight = saved.eye;
    this.flashlight.on = saved.fl && this.flashlight.owned;
    this.inPeephole = false;
    this.lockCount = Math.max(0, this.lockCount - 1);
    await this.fadeTo(0, 0.25);
  }
  private peepCheck: (() => void) | null = null;
  private peepAbort: (() => void) | null = null;

  /** Leave the door scope immediately (chapter restart / death). */
  private abortPeephole(): void {
    if (!this.inPeephole && !this.peepAbort) return;
    this.peepAbort?.();
    this.peepAbort = null;
    this.peepCheck = null;
    this.inPeephole = false;
    this.engine.post.u.uFisheye.value = 0;
    this.player.lookLimit = null;
    this.player.eyeHeight = 1.55;
  }

  private bedPose(): { lie: THREE.Vector3; sit: THREE.Vector3; yaw: number } {
    const bed = this.world.prop('apt_bed');
    const yaw = (bed.def.rot ?? 0) * DEG + Math.PI; // facing the foot end
    return { lie: bed.toWorld([0, 0.66, -0.62]), sit: bed.toWorld([0.05, 1.12, -0.2]), yaw };
  }

  async wakeUpAnimation(fast: boolean): Promise<void> {
    this.lockCount++;
    const { lie, sit, yaw } = this.bedPose();
    const spawn = this.player.pos.clone();
    const spawnYaw = this.player.yaw;
    const o = { pos: lie.clone(), yaw, pitch: 82 * DEG, roll: 0.25 };
    this.player.override = o;
    const tween = async (sec: number, f: (k: number) => void) => {
      let t = 0;
      while (t < sec) {
        await this.wait(1 / 60);
        t += 1 / 60;
        const k = Math.min(1, t / sec);
        f(k * k * (3 - 2 * k));
      }
    };
    const s = fast ? 0.4 : 1;
    this.eyes.lid = 1;
    await this.wait(0.8 * s);
    await tween(0.9 * s, (k) => (this.eyes.lid = 1 - k * 0.6));
    await tween(0.35 * s, (k) => (this.eyes.lid = 0.4 + k * 0.6));
    await tween(1.1 * s, (k) => (this.eyes.lid = 1 - k));
    this.eyes.lid = -1;
    await this.wait(0.6 * s);
    const p0 = lie.clone();
    await tween(1.4 * s, (k) => {
      o.pos.lerpVectors(p0, sit, k);
      o.pitch = (82 - 86 * k) * DEG;
      o.roll = 0.25 * (1 - k);
    });
    const p1 = sit.clone();
    const target = new THREE.Vector3(spawn.x, this.player.eyeHeight, spawn.z);
    let dy = spawnYaw - yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    await tween(1.3 * s, (k) => {
      o.pos.lerpVectors(p1, target, k);
      o.yaw = yaw + dy * k;
      o.pitch = -4 * DEG * (1 - k);
    });
    this.player.override = null;
    this.player.teleport(spawn.x, 0, spawn.z, spawnYaw / DEG);
    this.lockCount = Math.max(0, this.lockCount - 1);
  }

  /** Lie down and stay awake: eyes and head move, the body does not (scenario A-1). */
  async lieAwake(range = 70, look?: { yaw: number; pitch: number }, pitchMin = 10): Promise<void> {
    this.lockCount++;
    const { lie, sit, yaw } = this.bedPose();
    const o = { pos: new THREE.Vector3(this.player.pos.x, this.player.eyeHeight, this.player.pos.z), yaw: this.player.yaw, pitch: this.player.pitch, roll: 0 };
    this.player.override = o;
    this.flashlight.on = false;
    const p0 = o.pos.clone(), y0 = o.yaw, pt0 = o.pitch;
    let dy = yaw - y0;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    await this.tweenT(1.0, (k) => { o.pos.lerpVectors(p0, sit, k); o.yaw = y0 + dy * k; o.pitch = pt0 * (1 - k); });
    const endYaw = look ? yaw + look.yaw * DEG : yaw;
    const endPitch = (look ? look.pitch : 70) * DEG;
    const y1 = o.yaw;
    await this.tweenT(1.2, (k) => { o.pos.lerpVectors(sit, lie, k); o.yaw = y1 + (endYaw - y1) * k; o.pitch = endPitch * k; o.roll = 0.2 * k; });
    // keep o.yaw in the same winding as the clamp center so the first free frame cannot jump
    let w = o.yaw - yaw;
    while (w > Math.PI) w -= Math.PI * 2;
    while (w < -Math.PI) w += Math.PI * 2;
    o.yaw = yaw + w;
    this.lying = { o, cy: yaw, range, pitchMin: pitchMin * DEG };
    this.lockCount = Math.max(0, this.lockCount - 1);
  }

  /** From lieAwake back to standing beside the bed. */
  async getUp(): Promise<void> {
    if (!this.lying) return;
    this.lockCount++;
    const { sit } = this.bedPose();
    const o = this.lying.o;
    this.lying = null;
    const spawn = this.world.spawn('spawn_bed');
    const p0 = o.pos.clone(), pt0 = o.pitch, r0 = o.roll, y0 = o.yaw;
    await this.tweenT(1.0, (k) => { o.pos.lerpVectors(p0, sit, k); o.pitch = pt0 * (1 - k); o.roll = r0 * (1 - k); });
    const stand = new THREE.Vector3(spawn.pos[0], this.player.eyeHeight, spawn.pos[2]);
    let dy = spawn.yaw * DEG - y0;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    await this.tweenT(1.0, (k) => { o.pos.lerpVectors(sit, stand, k); o.yaw = y0 + dy * k; });
    this.player.override = null;
    this.player.teleport(spawn.pos[0], 0, spawn.pos[2], spawn.yaw);
    this.lockCount = Math.max(0, this.lockCount - 1);
  }

  private async tweenT(sec: number, f: (k: number) => void): Promise<void> {
    let t = 0;
    while (t < sec) {
      await this.wait(1 / 60);
      t += 1 / 60;
      const k = Math.min(1, t / sec);
      f(k * k * (3 - 2 * k));
    }
  }

  async lieDownAnimation(): Promise<void> {
    this.lockCount++;
    if (this.lying) {
      // already in bed: just close the eyes and fade
      this.lying = null;
      const from = Math.max(this.eyes.amount, this.eyes.lid > 0 ? this.eyes.lid : 0);
      await this.tweenT(1.4 * (1 - from) + 0.05, (k) => (this.eyes.lid = from + (1 - from) * k));
      await this.fadeTo(1, 1.2);
      this.lockCount = Math.max(0, this.lockCount - 1);
      return;
    }
    const { lie, sit, yaw } = this.bedPose();
    const o = { pos: new THREE.Vector3(this.player.pos.x, this.player.eyeHeight, this.player.pos.z), yaw: this.player.yaw, pitch: this.player.pitch, roll: 0 };
    this.player.override = o;
    this.flashlight.on = false;
    const tween = async (sec: number, f: (k: number) => void) => {
      let t = 0;
      while (t < sec) {
        await this.wait(1 / 60);
        t += 1 / 60;
        const k = Math.min(1, t / sec);
        f(k * k * (3 - 2 * k));
      }
    };
    const p0 = o.pos.clone(), y0 = o.yaw, pt0 = o.pitch;
    let dy = yaw - y0;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    await tween(1.1, (k) => { o.pos.lerpVectors(p0, sit, k); o.yaw = y0 + dy * k; o.pitch = pt0 * (1 - k); });
    await tween(1.3, (k) => { o.pos.lerpVectors(sit, lie, k); o.pitch = 82 * DEG * k; o.roll = 0.25 * k; });
    await tween(1.6, (k) => (this.eyes.lid = k));
    await this.fadeTo(1, 1.2);
    this.lockCount = Math.max(0, this.lockCount - 1);
  }

  // ── death / endings ──────────────────────────────────────────────────────
  private async onLethal(f: Face): Promise<void> {
    if (this.mode !== 'play') { this.faces.releaseLock(); return; }
    if (this.state.has('omamori')) {
      this.state.take('omamori');
      this.audio.play('omamori_break');
      this.flash('#ffffff', 0.7);
      this.player.shake = 1;
      this.faces.remove(f);
      this.ui.toast('お守りが砕けた。');
      this.faces.releaseLock();
      f.gaze = 0;
      return;
    }
    this.mode = 'transition';
    this.gen++;
    this.lockCount++;
    this.peepCheck = null;
    this.stareLoop?.stop(0.05);
    this.stareLoop = null;
    this.audio.play('jumpscare');
    this.player.shake = 1.4;
    const gen = this.gen;
    await this.faces.jumpscare(f, this.engine.camera);
    if (gen !== this.gen) return;
    this.flash('#600000', 0.6);
    this.engine.post.u.uRed.value = 0.6;
    await new Promise((r) => setTimeout(r, 450));
    if (gen !== this.gen) return;
    this.gameOver(this.runtime.gameOverReason ?? this.chapter?.gameOverReason);
  }

  gameOver(reason?: string): void {
    this.gen++;
    this.mode = 'gameover';
    this.ui.reset();
    this.faces.clear();
    this.input.releaseLock();
    this.stopRuntime();
    this.audio.play('gameover_drone');
    this.audio.play('whisper_futatsu', { volume: 0.9, delay: 0.6 });
    this.fade.v = 0.75;
    this.ui.showGameOver({
      title: META.gameOverTitle,
      reason: reason ?? 'あなたは、それと目を合わせてしまった。',
      hint: META.gameOverHint,
      onRetry: () => void this.retry(),
      onTitle: () => this.showTitle(),
    });
  }

  private async retry(): Promise<void> {
    if (!this.cp) return this.showTitle();
    this.ui.hideScreen();
    this.engine.post.u.uRed.value = 0;
    this.state.restore(this.cp);
    this.input.requestLock();
    this.fade.v = 1;
    await this.startChapter(this.cp.chapter, { fromCheckpoint: true });
  }

  async playEnding(id: string): Promise<void> {
    const e = ENDINGS[id];
    this.gen++;
    this.mode = 'ending';
    this.faces.clear();
    this.stopRuntime();
    this.ui.reset();
    this.input.releaseLock();
    GameState.addEnding(id);
    GameState.clearSave();
    await this.fadeTo(1, 2);
    this.audio.ambience('ending_drone', 0.7, 3);
    this.ui.setHudVisible(false);
    await new Promise<void>((resolve) => this.ui.showEnding({
      name: e?.name ?? id, label: e?.label ?? 'END', lines: e?.lines ?? [], credits: META.credits,
      onDone: () => resolve(),
    }));
    this.audio.ambience(null);
    this.showTitle();
  }

  // ── pause & settings ─────────────────────────────────────────────────────
  private pause(): void {
    if (this.mode !== 'play') return;
    this.mode = 'paused';
    this.audio.ctx?.suspend().catch(() => undefined);
    const resume = () => {
      this.ui.hideScreen();
      this.mode = 'play';
      void this.audio.ctx?.resume();
      this.input.requestLock();
    };
    const show = () => this.ui.showPause({
      objective: this.objective,
      onResume: resume,
      onSettings: () => this.ui.showSettings(this.settings, (s) => this.onSettings(s), show),
      onControls: () => this.ui.showControls(show),
      onTitle: () => { void this.audio.ctx?.resume(); this.showTitle(); },
    });
    show();
  }

  private onSettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    this.applySettings();
  }

  private applySettings(): void {
    const s = this.settings;
    this.player.sensitivity = s.sensitivity;
    this.player.invertY = s.invertY;
    this.audio.setVolume(s.volume);
    this.engine.post.u.uGamma.value = s.brightness;
    this.engine.baseFov = s.fov;
    this.ui.textSpeed = s.textSpeed;
    if (this.engine.pixelHeight !== s.pixelHeight) this.engine.setPixelHeight(s.pixelHeight);
  }

  // ── main loop ────────────────────────────────────────────────────────────
  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    try {
      this.step(dt);
    } catch (e) {
      console.error('[frame]', e);
    }
    this.engine.render(this.time);
    this.input.endFrame();
    requestAnimationFrame((t) => this.frame(t));
  }

  private step(dt: number): void {
    const playing = this.mode === 'play';
    const u = this.engine.post.u;
    // fade & flash
    if (this.fade.dur > 0) {
      this.fade.t += dt;
      const k = Math.min(1, this.fade.t / this.fade.dur);
      this.fade.v = this.fade.from + (this.fade.to - this.fade.from) * k;
      if (k >= 1) {
        this.fade.dur = 0;
        const r = this.fade.resolve;
        this.fade.resolve = null;
        r?.();
      }
    }
    u.uFade.value = this.fade.v;
    if (this.flashState.t > 0) {
      this.flashState.t -= dt;
      u.uFlash.value = Math.max(0, this.flashState.t / this.flashState.dur) * 0.85;
      u.uFlashColor.value.copy(this.flashState.color);
    } else u.uFlash.value = 0;

    if (this.mode === 'title') {
      this.player.yaw = (-132 + Math.sin(this.time * 0.07) * 6) * DEG;
      this.player.applyCamera(this.engine.camera, this.time);
      this.ui.update(dt, this.input);
      this.world.update(dt, this.engine.camera.position, this.player.pos);
      return;
    }
    if (this.mode === 'paused' || this.mode === 'gameover' || this.mode === 'boot') {
      this.ui.update(dt, this.input);
      return;
    }

    this.ui.update(dt, this.input);
    const modal = this.ui.blocking || this.dialogueDepth > 0;
    const controls = playing && !modal && this.lockCount === 0;

    // game-time waits
    if (playing) {
      for (const w of [...this.waits]) {
        w.t -= dt;
        if (w.t <= 0) {
          this.waits.splice(this.waits.indexOf(w), 1);
          w.resolve();
        }
      }
    }

    // eyes
    // the eyes can also be closed while looking through the door scope
    const wantClosed = this.eyes.force ?? ((controls || (playing && !modal && this.inPeephole)) && this.input.isDown('eyes'));
    this.eyes.amount += ((wantClosed ? 1 : 0) - this.eyes.amount) * Math.min(1, dt * (wantClosed ? 14 : 9));
    this.eyes.closed = this.eyes.amount > 0.7;
    if (this.eyes.closed && controls) {
      this.eyes.closedTime += dt;
      if (this.eyes.closedTime > 8) {
        this.eyes.closedTime = -2;
        void this.onBlackout();
      }
    } else if (!this.eyes.closed) this.eyes.closedTime = 0;
    u.uEyes.value = this.eyes.lid >= 0 ? this.eyes.lid : this.eyes.amount;
    u.uDream.value = Math.max(0, this.eyes.closedTime - 4) / 4;
    this.ui.setEyes(this.eyes.closed && this.eyes.lid < 0);

    // player
    if (this.lying && controls && this.input.locked) {
      const L = this.lying, sens = 0.0022 * this.settings.sensitivity;
      L.o.yaw = Math.max(L.cy - L.range * DEG, Math.min(L.cy + L.range * DEG, L.o.yaw - this.input.mouseDX * sens));
      L.o.pitch = Math.max(L.pitchMin, Math.min(85 * DEG, L.o.pitch - this.input.mouseDY * sens * (this.settings.invertY ? -1 : 1)));
    }
    this.player.canMove = controls && !this.inPeephole && !this.lying;
    this.player.canLook = playing && !modal && !this.lying && (this.lockCount === 0 || this.inPeephole);
    this.player.update(dt, this.input, this.collision);
    this.player.applyCamera(this.engine.camera, this.time);
    this.engine.camera.updateMatrixWorld();

    // interaction
    if (controls && !this.inPeephole && !this.lying) {
      this.interaction.update(dt, this.engine.camera, this.eyes.closed);
      const cur = this.interaction.current;
      this.ui.setPrompt(cur ? cur.label : null, cur?.blind);
      if (cur && this.input.pressed('interact')) {
        this.input.consume('interact');
        this.spawnScript(() => this.interaction.trigger().then(() => undefined));
      }
      if (this.input.pressed('flashlight')) {
        const msg = this.flashlight.toggle(this.state.battery);
        if (msg === '電池が切れている。' && this.state.has('battery')) {
          this.state.take('battery');
          this.state.battery = 1;
          this.audio.play('battery_swap');
          this.ui.toast('電池を交換した。');
          this.flashlight.on = true;
        } else if (msg) this.ui.toast(msg);
        if (this.flashlight.owned) this.audio.play('flashlight_click', { volume: 0.6 });
      }
      if (this.input.pressed('inventory')) {
        this.input.consume('inventory');
        this.openInventory();
      }
    } else {
      this.ui.setPrompt(null);
    }
    this.ui.setCrossVisible(controls && !this.inPeephole && !this.lying);
    this.peepCheck?.();

    // triggers
    if (playing && !modal) this.tickTriggers(dt);

    // faces
    this.faces.update(dt, {
      active: playing && !modal,
      eyesClosed: this.eyes.closed || this.eyes.lid > 0.5,
      camera: this.engine.camera,
      litBy: (p) => this.flashlight.litAmount(p),
    });

    // flashlight & battery
    const before = this.state.battery;
    this.state.battery = this.flashlight.update(dt, this.state.battery, this.faces.presence, this.engine.camera, !this.inPeephole && this.player.override === null);
    if (before > 0 && this.state.battery <= 0 && this.state.has('battery')) {
      this.state.take('battery');
      this.state.battery = 1;
      this.flashlight.on = true;
      this.audio.play('battery_swap');
      this.ui.toast('電池を交換した。');
    }
    this.ui.setBattery(this.flashlight.owned ? this.state.battery : null, this.flashlight.on);
    this.ui.setMoney(this.chapter?.time === 'day' || this.world.inZone('zone_conbini_in', this.player.pos) ? this.state.money : null);

    // clock
    if (playing && this.clockState.rate > 0) {
      this.clockState.acc += dt * this.clockState.rate;
      while (this.clockState.acc >= 1) {
        this.clockState.acc -= 1;
        this.clockState.m++;
        if (this.clockState.m >= 60) { this.clockState.m = 0; this.clockState.h = (this.clockState.h + 1) % 24; }
      }
      this.refreshClock();
    }

    this.world.update(dt, this.engine.camera.position, this.player.pos);
    this.drawTv();
    this.updateFear(dt);
    this.audio.updateListener(this.engine.camera);
    if (playing && this.chapter?.update && this.ctx) {
      try { this.chapter.update(this.ctx, dt); } catch (e) { if (!(e instanceof Aborted)) console.error(e); }
    }
  }

  private tickTriggers(dt: number): void {
    const rt = this.runtime;
    if (!this.inPeephole) {
      for (const [id, z] of rt.zones) {
        const inside = this.world.inZone(id, this.player.pos);
        if (inside !== z.inside) {
          z.inside = inside;
          const fn = inside ? z.enter : z.exit;
          if (fn) {
            if (z.once) rt.zones.delete(id);
            this.spawnScript(fn);
          }
        }
      }
    }
    for (const t of [...rt.timers]) {
      t.t -= dt;
      if (t.t > 0) continue;
      if (t.every > 0) t.t += t.every;
      else rt.timers.splice(rt.timers.indexOf(t), 1);
      this.spawnScript(t.fn);
    }
    for (const w of [...rt.watchers]) {
      let ok = false;
      try { ok = w.cond(); } catch { ok = false; }
      if (!ok) continue;
      rt.watchers.splice(rt.watchers.indexOf(w), 1);
      this.spawnScript(w.fn);
    }
  }

  private async onBlackout(): Promise<void> {
    const h = this.runtime.blackout;
    if (h) {
      let handled: boolean | void = false;
      try {
        handled = await h();
      } catch (e) {
        if (!(e instanceof Aborted)) console.error('[blackout]', e);
        return;
      }
      if (handled) return;
    }
    this.eyes.force = false;
    this.audio.play('gasp');
    this.player.shake = 0.6;
    await this.wait(0.4);
    this.eyes.force = null;
    this.ui.toast('……眠りかけていた。');
  }

  /** Drop all fear feedback at once (heartbeat, ringing, distortion). */
  calm(): void {
    this.fear = 0;
    this.heartT = 3;
    this.scriptFear = { level: 0, t: 0 };
    this.stareLoop?.stop(0.2);
    this.stareLoop = null;
    this.engine.post.u.uFear.value = 0;
    this.engine.fovOffset = 0;
    this.player.shake = 0;
  }

  private updateFear(dt: number): void {
    if (this.scriptFear.t > 0) this.scriptFear.t -= dt;
    const scripted = this.scriptFear.t > 0 ? this.scriptFear.level : 0;
    const gaze = this.faces.maxGaze;
    const target = Math.min(1, Math.max(gaze, this.faces.presence * 0.35, scripted));
    this.fear += (target - this.fear) * Math.min(1, dt * (target > this.fear ? 6 : 1.5));
    const u = this.engine.post.u;
    u.uFear.value = this.fear;
    u.uStatic.value = this.tvMode === 'static' && this.world.inZone('zone_apt_room', this.player.pos) ? 0.03 : 0;
    this.engine.fovOffset += (-gaze * 14 - this.engine.fovOffset) * Math.min(1, dt * 5);
    this.player.shake = Math.max(this.player.shake, gaze * gaze * 0.8);
    // heartbeat
    if (this.fear > 0.12 && this.mode === 'play') {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 1.15 - this.fear * 0.75;
        this.audio.play('heartbeat', { volume: Math.min(1, this.fear * 1.2) });
      }
    }
    if (gaze > 0.02 && this.mode === 'play') {
      this.stareLoop ??= this.audio.loop('stare', { volume: 0, fadeIn: 0.1 });
      this.stareLoop.setVolume(gaze, 0.1);
      this.stareLoop.setRate(1 + gaze * 0.25);
    } else if (this.stareLoop) {
      this.stareLoop.stop(0.4);
      this.stareLoop = null;
    }
  }
}
