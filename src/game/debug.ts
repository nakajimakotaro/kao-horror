import * as THREE from 'three';
import type { Game } from './Game';
import { CHAPTERS } from './chapters';

/** Developer console helpers: window.__kao (dev server or ?debug). */
export function installDebug(game: Game): void {
  const api = {
    game,
    THREE,
    chapters: () => CHAPTERS.map((c) => c.id),
    /** start a chapter immediately (skips title) */
    async goto(id: string) {
      game.audio.init();
      game.startEmitters();
      game.ui.hideScreen();
      await game.startChapter(id, { fromCheckpoint: false });
    },
    give(item: string, n = 1) {
      game.state.give(item, n);
      if (item === 'flashlight') game.flashlight.owned = true;
    },
    flag(k: string, v: boolean | number | string = true) {
      game.state.flags[k] = v;
    },
    flags: () => ({ ...game.state.flags }),
    inv: () => ({ ...game.state.inv }),
    tp(to: string) {
      game.teleport(to);
    },
    pos: () => {
      const p = game.player.pos;
      return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +((game.player.yaw * 180) / Math.PI).toFixed(1)];
    },
    noclip(v = true) {
      game.player.noclip = v;
    },
    god(v = true) {
      game.faces.god = v;
    },
    time(t: 'night' | 'day' | 'evening' | 'dawn') {
      game.world.setTime(t);
    },
    light(on = true) {
      game.flashlight.owned = true;
      game.flashlight.on = on;
    },
    face(anchor: string) {
      return game.ctx?.face(anchor);
    },
    interactTarget: () => game.interaction.current?.id ?? null,
    zones: () => game.world.zonesAt(game.player.pos),
    look(yawDeg: number, pitchDeg = 0) {
      game.player.yaw = (yawDeg * Math.PI) / 180;
      game.player.pitch = (pitchDeg * Math.PI) / 180;
    },
    /** run one interaction on whatever is under the crosshair (or a given id) */
    async use(id?: string) {
      const def = id ? game.interaction.resolve(id) : game.interaction.current?.def;
      if (def) await def.use();
    },
    /** press confirm on the current dialogue/choice */
    say: () => (game.ui as unknown as { modal: unknown }).modal,
    /** transcript of dialogue/choices/docs while auto mode is on */
    log: [] as string[],
    /** queued answers for upcoming choices (indices); default 0 */
    answers: [] as number[],
    /**
     * Test mode: dialogue resolves instantly (and is logged), choices take
     * the next queued answer, documents close themselves.
     */
    auto(on = true) {
      const ui = game.ui as unknown as Record<string, unknown>;
      const orig = (ui.__orig ??= { say: game.ui.say.bind(game.ui), choose: game.ui.choose.bind(game.ui), showDoc: game.ui.showDoc.bind(game.ui) }) as {
        say: typeof game.ui.say; choose: typeof game.ui.choose; showDoc: typeof game.ui.showDoc;
      };
      if (!on) {
        game.ui.say = orig.say;
        game.ui.choose = orig.choose;
        game.ui.showDoc = orig.showDoc;
        return;
      }
      game.ui.say = (sp, text, style = 'talk') => {
        const lines = Array.isArray(text) ? text : [text];
        for (const l of lines) api.log.push(style === 'mono' ? `（${l}）` : style === 'narr' ? `〈${l}〉` : `${sp ?? ''}「${l}」`);
        return new Promise((r) => setTimeout(r, 15));
      };
      game.ui.choose = (opts, prompt) => {
        const i = Math.min(opts.length - 1, api.answers.length ? api.answers.shift()! : 0);
        api.log.push(`[CHOICE${prompt ? ' ' + prompt : ''}] ${opts.map((o, k) => (k === i ? `▶${o}` : o)).join(' / ')}`);
        return Promise.resolve(i);
      };
      game.ui.showDoc = (d) => {
        api.log.push(`[DOC] ${d.title}`);
        return Promise.resolve();
      };
    },
    /** drain and return the transcript */
    take() {
      const out = api.log.splice(0);
      return out.join('\n');
    },
    objective: () => game.ui.root.querySelector('.objective')?.textContent ?? null,
    /** interactables within r meters whose label is currently non-null */
    near(r = 3) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const m of game.world.rayMeshes) {
        const id = m.userData.interactId as string | null | undefined;
        if (!id || seen.has(id)) continue;
        const p = m.getWorldPosition(new THREE.Vector3());
        if (p.distanceTo(game.player.pos) > r) continue;
        seen.add(id);
        const def = game.interaction.resolve(id);
        const label = def ? (typeof def.label === 'function' ? def.label() : def.label) : null;
        if (label) out.push(`${id}: ${label}`);
      }
      return out;
    },
    label(id: string) {
      const def = game.interaction.resolve(id);
      return def ? (typeof def.label === 'function' ? def.label() : def.label) : null;
    },
    /** wait for game-time seconds (helper for scripted tests) */
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    /**
     * Advance the game by `sec` seconds of simulated time without relying on
     * requestAnimationFrame (throttled when the pane is hidden).
     */
    async drive(sec: number, dt = 1 / 30) {
      const g = game as unknown as { step(dt: number): void; time: number };
      const n = Math.ceil(sec / dt);
      for (let i = 0; i < n; i++) {
        g.time += dt;
        g.step(dt);
        if (i % 4 === 0) game.engine.render(g.time);
        game.input.endFrame();
        if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      game.engine.render(g.time);
    },
    /** run an interaction and keep the game ticking until it finishes (max sec) */
    async act(id: string, sec = 30) {
      const def = game.interaction.resolve(id);
      if (!def) return `no interaction: ${id}`;
      let done = false;
      void Promise.resolve(def.use()).finally(() => (done = true));
      for (let t = 0; t < sec && !done; t += 0.25) await api.drive(0.25);
      return done ? 'ok' : 'still running';
    },
    chapter: () => game.chapter?.id ?? null,
    mode: () => game.mode,
  };
  (window as unknown as { __kao: typeof api }).__kao = api;
  console.info('[debug] window.__kao ready', api.chapters());
}
