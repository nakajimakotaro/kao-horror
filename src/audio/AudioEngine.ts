import * as THREE from 'three';
import { CORE_SOUNDS, type SoundDef } from './sounds';
import { EXTRA_SOUNDS } from './sounds_extra';
import { SOUND_LIBRARY } from './sounds_lib';

export interface PlayOptions {
  at?: THREE.Vector3;
  volume?: number;
  rate?: number;
  /** seconds to wait before starting */
  delay?: number;
  /** positional attenuation: full volume within `ref` meters (default 1.6) */
  ref?: number;
  /** how fast it fades beyond ref (default 1.0; 0 = no falloff) */
  rolloff?: number;
  loop?: boolean;
  fadeIn?: number;
}

export interface SoundHandle {
  setVolume(v: number, fade?: number): void;
  setRate(r: number): void;
  setPosition(p: THREE.Vector3): void;
  stop(fade?: number): void;
  readonly playing: boolean;
}

const NOOP: SoundHandle = { setVolume() {}, setRate() {}, setPosition() {}, stop() {}, playing: false };

/** WebAudio mixer with positional (HRTF) one-shots, loops and an ambience bed. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffleFilter!: BiquadFilterNode;
  private buses: Record<'sfx' | 'amb' | 'ui', GainNode> = {} as never;
  private buffers = new Map<string, AudioBuffer>();
  private defs: Record<string, SoundDef> = { ...CORE_SOUNDS, ...SOUND_LIBRARY, ...EXTRA_SOUNDS };
  private amb: { id: string; h: SoundHandle } | null = null;
  private warned = new Set<string>();
  volume = 0.8;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.muffleFilter = ctx.createBiquadFilter();
    this.muffleFilter.type = 'lowpass';
    this.muffleFilter.frequency.value = 20000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    this.master.connect(this.muffleFilter).connect(comp).connect(ctx.destination);
    for (const b of ['sfx', 'amb', 'ui'] as const) {
      const g = ctx.createGain();
      g.connect(this.master);
      this.buses[b] = g;
    }
    const l = ctx.listener;
    if (l.forwardX) {
      l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** 0 = clear, 1 = heavily muffled (eyes closed, underwater...). */
  muffle(k: number): void {
    if (!this.ctx) return;
    const f = 20000 * Math.pow(0.03, Math.max(0, Math.min(1, k)));
    this.muffleFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08);
  }

  has(id: string): boolean {
    return id in this.defs;
  }

  private buffer(id: string): AudioBuffer | null {
    if (!this.ctx) return null;
    let b = this.buffers.get(id);
    if (b) return b;
    const def = this.defs[id];
    if (!def) {
      if (!this.warned.has(id)) { console.warn(`[audio] unknown sound: ${id}`); this.warned.add(id); }
      return null;
    }
    try {
      b = def.render(this.ctx);
    } catch (e) {
      console.warn(`[audio] render failed: ${id}`, e);
      return null;
    }
    this.buffers.set(id, b);
    return b;
  }

  /** Render every sound up front (avoids hitches the first time a sound plays). */
  async warmup(onProgress?: (k: number) => void): Promise<void> {
    const ids = Object.keys(this.defs);
    for (let i = 0; i < ids.length; i++) {
      this.buffer(ids[i]);
      onProgress?.((i + 1) / ids.length);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
  }

  play(id: string, o: PlayOptions = {}): SoundHandle {
    const ctx = this.ctx;
    const buf = this.buffer(id);
    if (!ctx || !buf) return NOOP;
    const def = this.defs[id];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = o.loop ?? !!def.loop;
    src.playbackRate.value = o.rate ?? 1;
    const gain = ctx.createGain();
    const vol = (def.volume ?? 1) * (o.volume ?? 1);
    const t0 = ctx.currentTime + (o.delay ?? 0);
    if (o.fadeIn) {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + o.fadeIn);
    } else gain.gain.value = vol;
    let panner: PannerNode | null = null;
    src.connect(gain);
    if (o.at) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 1.6;
      panner.rolloffFactor = o.rolloff ?? 1.0;
      panner.maxDistance = 60;
      panner.positionX.value = o.at.x;
      panner.positionY.value = o.at.y;
      panner.positionZ.value = o.at.z;
      gain.connect(panner).connect(this.buses[def.bus ?? 'sfx']);
    } else gain.connect(this.buses[def.bus ?? 'sfx']);
    src.start(t0);
    let playing = true;
    src.onended = () => { playing = false; try { gain.disconnect(); panner?.disconnect(); } catch { /* already gone */ } };
    return {
      setVolume: (v, fade = 0.1) => {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.setTargetAtTime((def.volume ?? 1) * v, t, Math.max(0.005, fade / 3));
      },
      setRate: (r) => src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.05),
      setPosition: (p) => {
        if (!panner) return;
        panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z;
      },
      stop: (fade = 0.05) => {
        if (!playing) return;
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
        try { src.stop(t + Math.max(0.01, fade) + 0.02); } catch { /* not started */ }
        playing = false;
      },
      get playing() { return playing; },
    };
  }

  loop(id: string, o: PlayOptions = {}): SoundHandle {
    return this.play(id, { ...o, loop: true });
  }

  /** Crossfade the background bed. */
  ambience(id: string | null, volume = 1, fade = 2): void {
    if (this.amb?.id === id) {
      this.amb.h.setVolume(volume, fade);
      return;
    }
    this.amb?.h.stop(fade);
    this.amb = null;
    if (!id) return;
    this.amb = { id, h: this.play(id, { loop: true, volume, fadeIn: fade }) };
  }

  stopAll(): void {
    this.ambience(null, 0, 0.2);
  }

  updateListener(cam: THREE.Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const p = cam.getWorldPosition(new THREE.Vector3());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(p.x, t, 0.02); l.positionY.setTargetAtTime(p.y, t, 0.02); l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02); l.forwardY.setTargetAtTime(f.y, t, 0.02); l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02); l.upY.setTargetAtTime(u.y, t, 0.02); l.upZ.setTargetAtTime(u.z, t, 0.02);
    }
  }
}
