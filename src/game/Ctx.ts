import * as THREE from 'three';
import type { SoundHandle } from '../audio/AudioEngine';
import type { Prop } from '../world/Prop';
import type { LightCtl } from '../world/Lights';
import type { Npc } from '../world/World';
import type { TimeOfDay, V3 } from '../world/types';
import type { ChapterDef } from './Chapter';
import type { Face, FaceOptions } from './face/FaceSystem';
import type { Game } from './Game';
import type { InteractDef } from './Interaction';
import type { FlagValue } from './State';
import { DOCS } from './content/docs';
import { ITEMS } from './content/items';

/** Thrown inside scripts of a chapter that has been left/restarted. Swallowed by the runner. */
export class Aborted extends Error {
  constructor() { super('chapter aborted'); }
}

export const NPC_NAMES: Record<string, string> = {
  npc_clerk: '店員', npc_shrine: '宮司', npc_neighbor: 'おばあさん', npc_nao: 'なお', npc_nao_sit: 'なお', npc_extra: '？？？',
};

export interface ZoneHandlers {
  enter?: () => void | Promise<void>;
  exit?: () => void | Promise<void>;
  once?: boolean;
}

/**
 * The scripting API handed to chapters. Every async helper throws Aborted when
 * the chapter is no longer current, so stale scripts stop by themselves.
 */
export class Ctx {
  constructor(readonly game: Game, readonly chapter: ChapterDef, readonly gen: number) {}

  get alive(): boolean {
    return this.game.gen === this.gen;
  }

  private check(): void {
    if (!this.alive) throw new Aborted();
  }

  /** tag passed to checkpoint() when this chapter was resumed from a mid-chapter checkpoint */
  get checkpointTag(): string | null {
    return this.game.state.checkpoint;
  }

  // ── state ────────────────────────────────────────────────────────────────
  get(name: string): FlagValue | undefined {
    return this.game.state.flags[name];
  }
  is(name: string): boolean {
    return !!this.game.state.flags[name];
  }
  set(name: string, value: FlagValue = true): void {
    this.game.state.flags[name] = value;
  }
  inc(name: string, by = 1): number {
    const v = (Number(this.game.state.flags[name]) || 0) + by;
    this.game.state.flags[name] = v;
    return v;
  }
  has(item: string): boolean {
    return this.game.state.has(item);
  }
  count(item: string): number {
    return this.game.state.inv[item] ?? 0;
  }
  give(item: string, n = 1, silent = false): void {
    this.game.state.give(item, n);
    if (item === 'flashlight') this.game.flashlight.owned = true;
    if (!silent) {
      this.game.ui.toast(`${ITEMS[item]?.name ?? item} を手に入れた`);
      this.game.audio.play('item_get');
    }
  }
  take(item: string, n = 1): boolean {
    const ok = this.game.state.take(item, n);
    if (item === 'flashlight' && !this.game.state.has('flashlight')) {
      this.game.flashlight.owned = false;
      this.game.flashlight.on = false;
    }
    return ok;
  }
  get money(): number {
    return this.game.state.money;
  }
  addMoney(n: number): void {
    this.game.state.money = Math.max(0, this.game.state.money + n);
  }
  get battery(): number {
    return this.game.state.battery;
  }
  set battery(v: number) {
    this.game.state.battery = Math.max(0, Math.min(1, v));
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  async say(speaker: string, text: string | string[]): Promise<void> {
    this.check();
    await this.game.dialogue(() => { this.check(); return this.game.ui.say(speaker, text, 'talk'); });
    this.check();
  }
  /** Protagonist's inner voice. */
  async mono(text: string | string[]): Promise<void> {
    this.check();
    await this.game.dialogue(() => { this.check(); return this.game.ui.say(null, text, 'mono'); });
    this.check();
  }
  /** Centered narration (no speaker). */
  async narrate(text: string | string[]): Promise<void> {
    this.check();
    await this.game.dialogue(() => { this.check(); return this.game.ui.say(null, text, 'narr'); });
    this.check();
  }
  async choice(options: string[], prompt?: string): Promise<number> {
    this.check();
    const i = await this.game.dialogue(() => { this.check(); return this.game.ui.choose(options, prompt); });
    this.check();
    return i;
  }
  async doc(id: string): Promise<void> {
    this.check();
    const d = DOCS[id];
    if (!d) { console.warn(`[ctx] unknown doc ${id}`); return; }
    this.game.audio.play('paper');
    this.set(`read_${id}`);
    await this.game.dialogue(() => { this.check(); return this.game.ui.showDoc(d); });
    this.check();
  }
  objective(text: string | null): void {
    this.game.setObjective(text);
  }
  toast(text: string): void {
    this.game.ui.toast(text);
  }
  /** Non-modal subtitle (does not stop movement or force the eyes open). Use while the eyes are closed. */
  sub(speaker: string | null, text: string, sec = 3): void {
    this.game.ui.sub(speaker, text, sec);
  }
  /** Control hint at the bottom-left, e.g. c.hint('[Space] 長押しで目を閉じる'). */
  hint(text: string | null, sec = 7): void {
    this.game.ui.hint(text, sec);
  }
  async card(title: string, subtitle = '', sec = 3): Promise<void> {
    this.check();
    await this.game.ui.card(title, subtitle, sec);
    this.check();
  }
  async fadeOut(sec = 1): Promise<void> {
    this.check();
    await this.game.fadeTo(1, sec);
    this.check();
  }
  async fadeIn(sec = 1): Promise<void> {
    this.check();
    await this.game.fadeTo(0, sec);
    this.check();
  }
  async wait(sec: number): Promise<void> {
    this.check();
    await this.game.wait(sec);
    this.check();
  }
  async shop(id: string): Promise<void> {
    this.check();
    await this.game.openShop(id);
    this.check();
  }

  // ── world ────────────────────────────────────────────────────────────────
  prop(id: string): Prop {
    return this.game.world.prop(id);
  }
  light(id: string): LightCtl {
    return this.game.world.light(id);
  }
  anchor(id: string): THREE.Vector3 {
    return this.game.world.anchor(id);
  }
  poster(id: string, o: { tex?: string; visible?: boolean }): void {
    this.game.world.setPoster(id, o);
  }
  lock(id: string, locked = true): void {
    this.game.world.locks.set(id, locked);
  }
  isLocked(id: string): boolean {
    return this.game.world.isLocked(id);
  }
  /** Apartment breaker: room lights only work when power is on. */
  power(on: boolean): void {
    this.game.world.power = on;
    if (!on) for (const id of ['apt_light_kitchen', 'apt_light_room', 'apt_light_bath']) this.game.world.light(id).setOn(false);
  }
  get hasPower(): boolean {
    return this.game.world.power;
  }
  time(t: TimeOfDay): void {
    this.game.world.setTime(t, false);
  }
  clock(h: number, m: number, rate = 0): void {
    this.game.setClock(h, m, rate);
  }
  /** current in-game clock */
  get now(): { h: number; m: number } {
    const c = this.game.clockNow();
    return { h: c.h, m: c.m };
  }
  /** TV screen: 'off' | 'static' | 'on' (dim blue) */
  tv(mode: 'off' | 'static' | 'on'): void {
    this.game.setTv(mode);
  }

  // ── interactions & triggers ──────────────────────────────────────────────
  /** Register (or override) the interaction for a prop / NPC / poster id in this chapter. */
  on(id: string, def: InteractDef): void {
    this.game.interaction.defs.set(id, def);
  }
  /**
   * While the eyes are closed, offer this interaction (if its def has blind:true)
   * even though the player never aimed at it — e.g. waking up eyes-closed in front
   * of the fridge. null to clear.
   */
  blindTarget(id: string | null): void {
    this.game.interaction.forcedBlind = id;
  }
  /** Make an id non-interactable in this chapter. */
  off(id: string): void {
    this.game.interaction.defs.set(id, { label: () => null, use: () => {} });
  }
  /** Fall back to the world's default behavior again. */
  reset(id: string): void {
    this.game.interaction.defs.delete(id);
  }
  /** Run the default interaction of an id (e.g. open the fridge), even if overridden. */
  async useDefault(id: string): Promise<void> {
    const d = this.game.interaction.resolveDefault(id);
    if (d) await d.use();
    this.check();
  }
  defaultLabel(id: string): string | null {
    const d = this.game.interaction.resolveDefault(id);
    if (!d) return null;
    return typeof d.label === 'function' ? d.label() : d.label;
  }
  zone(id: string, h: ZoneHandlers): void {
    this.game.runtime.zones.set(id, { ...h, inside: this.game.world.inZone(id, this.game.player.pos) });
  }
  after(sec: number, fn: () => void | Promise<void>): void {
    this.game.runtime.timers.push({ t: sec, fn, every: 0 });
  }
  every(sec: number, fn: () => void | Promise<void>): void {
    this.game.runtime.timers.push({ t: sec, fn, every: sec });
  }
  /** Fire once when the condition becomes true (checked every frame during play). */
  when(cond: () => boolean, fn: () => void | Promise<void>): void {
    this.game.runtime.watchers.push({ cond, fn });
  }
  /** Eyes kept closed for ~8 s. Return true to suppress the default (wake with a gasp). */
  onBlackout(fn: () => boolean | void | Promise<boolean | void>): void {
    this.game.runtime.blackout = fn;
  }
  /** Fire-and-forget script with abort handling. */
  run(fn: () => Promise<void>): void {
    this.game.spawnScript(fn);
  }
  /** Lock player movement/look for the duration of fn. */
  async cutscene<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    this.game.lockCount++;
    try {
      return await fn();
    } finally {
      this.game.lockCount = Math.max(0, this.game.lockCount - 1);
    }
  }

  // ── faces ────────────────────────────────────────────────────────────────
  /** Spawn a face at an anchor id (or position). Anchors owned by a prop let its doors hide the face. */
  face(at: string | THREE.Vector3, opts: FaceOptions = {}): Face {
    const anchorId = typeof at === 'string' ? at : null;
    const pos = typeof at === 'string' ? this.anchor(at) : at;
    const owner = opts.owner !== undefined ? opts.owner : anchorId ? this.game.world.layout.anchors.find((a) => a.id === anchorId)?.prop ?? null : null;
    return this.game.faces.spawn(pos, { ...opts, owner }, anchorId);
  }
  clearFace(f: Face | string, fade = true): void {
    this.game.faces.remove(f, fade);
  }
  clearFaces(): void {
    this.game.faces.clear();
  }
  get gaze(): number {
    return this.game.faces.maxGaze;
  }
  facesEnabled(v: boolean): void {
    this.game.faces.enabled = v;
  }

  // ── NPCs ─────────────────────────────────────────────────────────────────
  npc(id: string, o: { at: string | V3; yaw?: number; label?: string; talk?: () => Promise<void>; lookAtPlayer?: boolean; phoneGlow?: boolean }): Npc {
    let pos: THREE.Vector3;
    let yaw = o.yaw ?? 0;
    if (typeof o.at === 'string') {
      pos = this.anchor(o.at);
      if (o.yaw === undefined) yaw = this.game.world.anchorYaw(o.at);
    } else pos = new THREE.Vector3(...o.at);
    const n = this.game.world.showNpc(id, pos, yaw);
    n.lookAtPlayer = o.lookAtPlayer ?? true;
    n.phoneGlow = !!o.phoneGlow;
    if (o.talk) {
      const talk = o.talk;
      this.on(id, { label: o.label ?? `${NPC_NAMES[id] ?? id}に話しかける`, use: () => talk(), range: 2.8, blind: false });
    } else {
      this.off(id);
    }
    return n;
  }
  hideNpc(id: string): void {
    this.game.world.hideNpc(id);
    this.game.interaction.defs.delete(id);
  }

  // ── audio ────────────────────────────────────────────────────────────────
  /** One-shot sound. `loop:false` plays a loop-defined sound once; `ref`/`rolloff` tune positional falloff. */
  sfx(id: string, o: { at?: string | THREE.Vector3; volume?: number; rate?: number; delay?: number; loop?: boolean; ref?: number; rolloff?: number } = {}): SoundHandle {
    const at = typeof o.at === 'string' ? this.anchorOrProp(o.at) : o.at;
    return this.game.audio.play(id, { at, volume: o.volume, rate: o.rate, delay: o.delay, loop: o.loop ?? false, ref: o.ref, rolloff: o.rolloff });
  }
  loop(id: string, o: { at?: string | THREE.Vector3; volume?: number } = {}): SoundHandle {
    const at = typeof o.at === 'string' ? this.anchorOrProp(o.at) : o.at;
    const h = this.game.audio.loop(id, { at, volume: o.volume, fadeIn: 0.5 });
    this.game.runtime.loops.push(h);
    return h;
  }
  ambience(id: string | null, volume = 1): void {
    this.game.audio.ambience(id, volume);
  }
  /** World point for an anchor, a prop (center of its bounds) or an NPC (its head). */
  anchorOrProp(id: string): THREE.Vector3 {
    const w = this.game.world;
    if (w.anchors.has(id)) return this.anchor(id);
    const npc = w.npcs.get(id);
    if (npc?.visible) return (npc.head ?? npc.root).getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, npc.head ? 0.1 : 1.4, 0));
    if (w.props.has(id)) {
      const box = new THREE.Box3().setFromObject(this.prop(id).root);
      return box.isEmpty() ? this.prop(id).position : box.getCenter(new THREE.Vector3());
    }
    return this.game.engine.camera.position.clone();
  }
  /** Always-on positional hums started by the engine: 'fridge_hum' | 'vending_hum' | 'fluorescent_buzz'. */
  emitter(id: string): SoundHandle | null {
    return this.game.emitterMap.get(id) ?? null;
  }
  /** Turn the automatic-door chime of the convenience store on/off for this chapter. */
  autoDoorChime(on: boolean): void {
    this.game.runtime.autoDoorChime = on;
  }

  // ── player & camera ──────────────────────────────────────────────────────
  get player() {
    const g = this.game;
    return {
      pos: g.player.pos.clone(),
      yaw: (g.player.yaw * 180) / Math.PI,
      eyesClosed: g.eyes.closed,
      flashlightOn: g.flashlight.on,
    };
  }
  inZone(id: string): boolean {
    return this.game.world.inZone(id, this.game.player.pos);
  }
  /** Move the player to a spawn id or anchor id (or position) */
  teleport(to: string | { pos: V3; yaw?: number }): void {
    this.game.teleport(to);
  }
  async lookAt(target: string | THREE.Vector3, sec = 0.8): Promise<void> {
    this.check();
    const p = typeof target === 'string' ? this.anchorOrProp(target) : target;
    await this.game.player.lookAt(p, sec);
    this.check();
  }
  /** Lying in bed → sit up → stand (cutscene). */
  async wakeUp(fast = false): Promise<void> {
    this.check();
    await this.game.wakeUpAnimation(fast);
    this.check();
  }
  /** Lie down in bed and fade out (does not change chapter). */
  async lieDown(): Promise<void> {
    this.check();
    await this.game.lieDownAnimation();
    this.check();
  }
  lockControls(lock: boolean): void {
    this.game.lockCount = lock ? this.game.lockCount + 1 : Math.max(0, this.game.lockCount - 1);
  }
  flashlight(o: { owned?: boolean; on?: boolean; enabled?: boolean }): void {
    const f = this.game.flashlight;
    if (o.owned !== undefined) f.owned = o.owned;
    if (o.enabled !== undefined) f.enabled = o.enabled;
    if (o.on !== undefined) f.on = o.on && f.owned && this.game.state.battery > 0;
  }
  shake(amount = 1, sec = 0.6): void {
    this.game.player.shake = Math.max(this.game.player.shake, amount);
    void sec;
  }
  flash(color = '#ffffff', sec = 0.5): void {
    this.game.flash(color, sec);
  }
  /** Scripted fear pulse 0..1 for `sec` seconds (heartbeat, distortion). */
  fear(level: number, sec = 2): void {
    this.game.scriptFear = { level, t: sec };
  }
  /** Look through the door scope of apt_door (fisheye). Resolves when the player steps back. */
  async peephole(o: { minSec?: number; onEnter?: () => void } = {}): Promise<void> {
    this.check();
    await this.game.peephole(o);
    this.check();
  }
  /**
   * Lose consciousness and come to somewhere else (sleepwalking): eyes close,
   * black out, the clock jumps `minutes`, the player wakes at `to` (spawn/anchor/pos).
   */
  async blackoutTo(to: string | { pos: V3; yaw?: number }, o: { minutes?: number; hold?: number } = {}): Promise<void> {
    this.check();
    await this.cutscene(async () => {
      this.game.eyes.force = true;
      this.game.audio.play('gasp', { volume: 0.5 });
      await this.game.fadeTo(1, 1.2);
      this.check();
      this.game.teleport(to);
      if (o.minutes) {
        const cs = this.game.clockNow();
        const total = cs.h * 60 + cs.m + o.minutes;
        this.game.setClock(Math.floor(total / 60) % 24, total % 60, cs.rate);
      }
      await this.game.wait(o.hold ?? 1.5);
      this.check();
      this.game.eyes.force = null;
      this.game.eyes.lid = 1;
      void this.game.fadeTo(0, 1.5);
      for (let t = 0; t < 1; t += 1 / 45) {
        await this.game.wait(1 / 60);
        this.game.eyes.lid = 1 - t;
      }
      this.game.eyes.lid = -1;
    });
    this.check();
  }
  /**
   * Eyelid opening for cutscenes: 0 = open … 1 = shut. While above 0.5 faces are not "seen".
   * null hands control back to the player.
   */
  lid(v: number | null): void {
    this.game.eyes.lid = v === null ? -1 : Math.max(0, Math.min(1, v));
  }
  /** Replace the game-over text for the rest of this run of the chapter. */
  set gameOverReason(text: string | null) {
    this.game.runtime.gameOverReason = text;
  }
  /** Lie down in bed and stay awake: head and eyes move (Space works, 8 s rule counts), body does not. */
  async lieAwake(o: { yaw?: number; look?: { yaw: number; pitch: number }; pitchMin?: number } = {}): Promise<void> {
    this.check();
    await this.game.lieAwake(o.yaw ?? 70, o.look, o.pitchMin ?? 10);
    this.check();
  }
  /** Stop the heartbeat / ringing / distortion immediately (e.g. a sudden silence). */
  calm(): void {
    this.game.calm();
  }
  /** Get up from lieAwake and stand beside the bed. */
  async getUp(): Promise<void> {
    this.check();
    await this.game.getUp();
    this.check();
  }
  get lying(): boolean {
    return !!this.game.lying;
  }
  /** Breaker levers on apt_breaker: 'sw_main' | 'sw_1'..'sw_4'. */
  breaker(lever: string, on: boolean): void {
    this.game.world.setLever(lever, on);
  }
  breakerOn(lever: string): boolean {
    return this.game.world.leverOn(lever);
  }
  /** Force the player's eyes open/closed state (cutscenes). */
  eyes(closed: boolean): void {
    this.game.eyes.force = closed;
  }
  releaseEyes(): void {
    this.game.eyes.force = null;
  }

  // ── flow ─────────────────────────────────────────────────────────────────
  /** Save a mid-chapter checkpoint; on retry, setup() sees c.checkpointTag === tag. */
  checkpoint(tag: string | null = null): void {
    this.game.checkpoint(tag);
  }
  async goto(chapterId: string): Promise<void> {
    this.check();
    await this.game.startChapter(chapterId, { fromCheckpoint: false });
    throw new Aborted();
  }
  async ending(id: string): Promise<void> {
    this.check();
    await this.game.playEnding(id);
    throw new Aborted();
  }
  gameOver(reason?: string): void {
    this.check();
    this.game.gameOver(reason);
  }
}
