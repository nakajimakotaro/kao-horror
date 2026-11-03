import { bandpass, env, highpass, lowpass, makeLoop, rand, render, seed, sine } from './synth';

export interface SoundDef {
  render: (ctx: BaseAudioContext) => AudioBuffer;
  loop?: boolean;
  /** default gain 0..1 */
  volume?: number;
  bus?: 'sfx' | 'amb' | 'ui';
}

// Core set. The full library (SOUND_LIBRARY in sounds_lib.ts) extends/overrides these.
export const CORE_SOUNDS: Record<string, SoundDef> = {
  step_wood: { volume: 0.35, render: (c) => { seed(1); const lp = lowpass(900); return render(c, 0.16, (t) => lp(rand()) * env(t, 0.004, 0.035) + sine(90, t) * env(t, 0.002, 0.03) * 0.6); } },
  step_tile: { volume: 0.3, render: (c) => { seed(2); const bp = bandpass(2200, 1.2); return render(c, 0.12, (t) => bp(rand()) * env(t, 0.002, 0.02)); } },
  step_concrete: { volume: 0.35, render: (c) => { seed(3); const bp = bandpass(1200, 0.8); return render(c, 0.15, (t) => bp(rand()) * env(t, 0.003, 0.03)); } },
  step_gravel: { volume: 0.4, render: (c) => { seed(4); const hp = highpass(1500); return render(c, 0.25, (t) => hp(rand()) * env(t, 0.01, 0.06) * (0.6 + 0.4 * Math.abs(rand()))); } },
  switch_click: { volume: 0.5, bus: 'sfx', render: (c) => { seed(5); const hp = highpass(2000); return render(c, 0.08, (t) => hp(rand()) * env(t, 0.0005, 0.006) + sine(1800, t) * env(t, 0.0005, 0.01) * 0.4); } },
  doorbell: { volume: 0.7, render: (c) => render(c, 2.4, (t) => {
    const a = t < 1.1 ? (sine(659.3, t) + 0.3 * sine(1318.5, t)) * env(t, 0.005, 0.7) : 0;
    const b = t >= 0.55 ? (sine(523.3, t - 0.55) + 0.3 * sine(1046.5, t - 0.55)) * env(t - 0.55, 0.005, 0.9) : 0;
    return a * (t < 0.6 ? 1 : 0.4) + b;
  }) },
  heartbeat: { volume: 0.8, render: (c) => render(c, 0.9, (t) => {
    const beat = (t0: number) => (t >= t0 ? sine(48, t - t0) * env(t - t0, 0.008, 0.07) + sine(70, t - t0) * env(t - t0, 0.004, 0.04) * 0.5 : 0);
    return beat(0) + beat(0.24) * 0.7;
  }) },
  stare: { volume: 0.5, loop: true, render: (c) => { seed(6); const bp = bandpass(3100, 8); return makeLoop(render(c, 4.5, (t) => sine(3150, t) * 0.3 + sine(3163, t) * 0.3 + bp(rand()) * 0.5 + sine(55, t) * 0.4 * (0.6 + 0.4 * sine(0.5, t)))); } },
  jumpscare: { volume: 1.0, render: (c) => { seed(7); const hp = highpass(300); return render(c, 1.6, (t) => {
    const e = env(t, 0.01, 0.5);
    let v = hp(rand()) * 0.8;
    for (const f of [311, 466, 587, 740]) v += Math.sign(sine(f * (1 - t * 0.15), t)) * 0.18;
    return v * e;
  }); } },
  door_open: { volume: 0.5, render: (c) => { seed(8); const bp = bandpass(700, 6); return render(c, 0.9, (t) => bp(rand()) * env(t, 0.05, 0.25) * (1 + 0.5 * sine(9, t)) + sine(120, t) * env(t, 0.001, 0.05) * 0.4); } },
  door_close: { volume: 0.6, render: (c) => { seed(9); const lp = lowpass(500); return render(c, 0.6, (t) => lp(rand()) * env(t, 0.002, 0.08) + sine(70, t) * env(t, 0.001, 0.12) * 0.8); } },
  room_tone: { volume: 0.25, loop: true, bus: 'amb', render: (c) => { seed(10); const lp = lowpass(180); return makeLoop(render(c, 8, (t) => lp(rand()) * 2.0 + sine(50, t) * 0.02 + sine(100, t) * 0.012)); } },
  fridge_hum: { volume: 0.18, loop: true, render: (c) => { seed(11); const lp = lowpass(400); return makeLoop(render(c, 6, (t) => sine(100, t) * 0.4 + sine(150, t) * 0.12 + lp(rand()) * 0.5)); } },
  night_out: { volume: 0.3, loop: true, bus: 'amb', render: (c) => { seed(12); const lp = lowpass(300); const bp = bandpass(4200, 12);
    return makeLoop(render(c, 10, (t) => lp(rand()) * 1.5 + bp(rand()) * 0.4 * (0.5 + 0.5 * sine(0.2, t)) * (sine(28, t) > 0.2 ? 1 : 0.2))); } },
  day_out: { volume: 0.35, loop: true, bus: 'amb', render: (c) => { seed(13); const bp = bandpass(5200, 3); const lp = lowpass(200);
    return makeLoop(render(c, 10, (t) => bp(rand()) * (0.6 + 0.4 * sine(0.13, t)) * (0.7 + 0.3 * Math.sign(sine(16, t))) + lp(rand()) * 0.8)); } },
};
