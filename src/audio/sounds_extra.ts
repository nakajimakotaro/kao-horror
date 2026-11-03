import type { SoundDef } from './sounds';
import { bandpass, env, highpass, lowpass, makeLoop, rand, render, seed, sine } from './synth';

// Sounds added for the final scenario (docs/SCENARIO.md §7-D).
export const EXTRA_SOUNDS: Record<string, SoundDef> = {
  /** tap left running into a tub: steady splash + bubbling */
  water_run: { volume: 0.45, loop: true, render: (c) => {
    seed(201);
    const bp1 = bandpass(1400, 0.8), bp2 = bandpass(3600, 1.5), lp = lowpass(500);
    return makeLoop(render(c, 6, (t) => {
      const bubble = Math.max(0, Math.sin(t * 37 + Math.sin(t * 5) * 3)) ** 8;
      return bp1(rand()) * 0.9 + bp2(rand()) * 0.35 * (0.6 + 0.4 * Math.sin(t * 13)) + lp(rand()) * 0.8 + sine(380 + 120 * Math.sin(t * 9), t) * bubble * 0.15;
    }), 0.6);
  } },
  /** masking tape peeled off a plastic surface */
  tape_peel: { volume: 0.5, render: (c) => {
    seed(202);
    const hp = highpass(1800);
    return render(c, 0.7, (t) => {
      const crackle = rand() > 0.7 ? 1 : 0.25;
      return hp(rand()) * crackle * env(t, 0.02, 0.35) * (0.6 + 0.4 * Math.sin(t * 90));
    });
  } },
  /** small brass bell on a keychain */
  suzu: { volume: 0.45, render: (c) => render(c, 1.2, (t) => {
    let v = 0;
    for (const [t0, a] of [[0, 1], [0.09, 0.6], [0.2, 0.35]] as const) {
      if (t < t0) continue;
      const u = t - t0;
      v += a * (sine(3520, u) * 0.6 + sine(4890, u) * 0.3 + sine(7120, u) * 0.15) * env(u, 0.001, 0.18);
    }
    return v;
  }) },
  /** far-off wooden clappers of the night watch: カン、カン */
  hyoshigi: { volume: 0.4, render: (c) => {
    seed(203);
    const bp = bandpass(1900, 6), lp = lowpass(3000);
    return render(c, 2.6, (t) => {
      let v = 0;
      for (const t0 of [0, 0.42]) {
        if (t < t0) continue;
        const u = t - t0;
        v += (bp(rand()) * 2 + sine(1850, u) * 0.6 + sine(2730, u) * 0.3) * env(u, 0.001, 0.05);
      }
      // distance: soft echo
      const echo = t > 0.9 ? Math.exp(-(t - 0.9) * 3) * 0.08 * sine(1850, t) : 0;
      return lp(v * 0.5) + echo;
    });
  } },
  /** tiny electronic "recording started" beep */
  rec_beep: { volume: 0.35, bus: 'ui', render: (c) => render(c, 0.32, (t) => (t < 0.08 ? sine(2400, t) : t > 0.14 && t < 0.22 ? sine(2400, t - 0.14) : 0) * 0.8) },
  /** answering machine beep (start / end of a voicemail) */
  voicemail_beep: { volume: 0.5, render: (c) => render(c, 0.7, (t) => (t < 0.55 ? sine(1000, t) * Math.min(1, t / 0.005) * Math.min(1, (0.55 - t) / 0.01) : 0) * 0.7) },
  /** refrigerator "door open" alarm: pi-pi-pi */
  fridge_alarm: { volume: 0.4, render: (c) => render(c, 1.6, (t) => {
    const k = t % 0.5;
    return k < 0.16 ? sine(2050, k) * (Math.floor(k * 40) % 2 ? 0.2 : 1) * 0.7 : 0;
  }) },
  /** tsukutsuku-boshi: the late-summer cicada (ツクツクボウシ) call, looping with pauses */
  tsukutsuku: { volume: 0.32, loop: true, bus: 'amb', render: (c) => {
    seed(204);
    const bp = bandpass(4600, 4), bp2 = bandpass(6200, 6), lp = lowpass(250);
    return makeLoop(render(c, 12, (t) => {
      // phrase: rising buzz then repeated "tsuku-tsuku-boshi" pulses for ~5 s, then rest
      const ph = t % 12;
      let amp = 0;
      if (ph > 1 && ph < 6.5) {
        const p = ph - 1;
        const pulse = p < 1 ? p : Math.max(0, Math.sin(p * Math.PI * 4.2)) ** 2;
        amp = pulse * (p > 5 ? (5.5 - p) * 2 : 1);
      }
      const far = bp2(rand()) * 0.2 * (0.5 + 0.5 * Math.sin(t * 0.7));
      return bp(rand()) * amp * 1.2 + far + lp(rand()) * 0.5;
    }), 0.8);
  } },
};
