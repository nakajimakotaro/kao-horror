import * as THREE from 'three';
import type { SoundHandle } from '../../audio/AudioEngine';
import type { V3 } from '../../world/types';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';
import { T, TL } from '../../script';

// ─────────────────────────────────────────────────────────────────────────────
//  第3章　ch3_night「二日目　午前三時」（docs/SCENARIO.md §5 第3章）
//
//  The TV wakes Toru at 3:00. One-way objectives:
//    テレビを消す → 玄関を確かめる → 玄関の鍵とチェーンをかける → 浴室を確かめる
//    （浴室に入ると トイレのふたを閉める）→ スマホを見る（→ピンポン）
//    → 玄関を確かめる（覗き穴）→ なおと話す → ベッドで眠る
//  Each step only opens after the previous one (the TV gates the genkan, locking up gates the
//  toilet lid, the lid gates the phone, the talk gates the bed), so no objective rolls back.
//  …then the fake sleep (寝たふり): Nao advances in stages A–E by the total time the
//  player keeps the eyes closed. Staying awake to E (heard_lock) or falling asleep
//  on the way (8 s closed → slept_ch3) both lead to ch4_day.
//
//  Faces: F3-1 TV (fleeting, flat), F3-2 toilet bowl (static), F3-3 outside the
//  door through the peephole (static, lethal 2.5 — a lesson: it always vanishes before
//  the stare can kill), F3-4 ceiling over the bed (static, 6 s; game over text 「……起きてたんだ。」).
//  Checkpoints: chapter head / ch3_bell (toilet lid closed) / ch3_bed (after the talk).
//
//  QA review fixes applied here (the scenario text is not revised yet):
//   #3  the toilet lid works only after locking up; entering the bath sets 「トイレのふたを閉める」
//   #6  F3-3 can never kill (vanishes at 80 % of the stare, harmless as a net); hint for
//       closing the eyes / leaving inside the door scope
//   #13 Nao changes place only in the dark, unseen, or while the eyes are closed
//   #15 genkan line（サンダルが、濡れてる。……夜露？）→（玄関に、泥の足跡。……裸足の）
//   #25 「ドアを開ける」 before Nao's voice →（……誰だ。先に、覗き穴だ）; heard_whisper with
//       「……しずく」; the bed starts looking toward Nao, low; F3-4 is preceded by
//       （……真上で、何かが息をしている）
//
//  Flags written (scenario): locked_both, toilet_closed, read_doc_call_log (auto),
//    bell_rang, nao_in, nao_trust (+1 開ける / +1 バッグを見ない), saw_key,
//    heard_whisper, heard_lock, slept_ch3.
//  Chapter-local helpers: ch3_tv_off, ch3_genkan (玄関を確かめた), ch3_nao_voice
//    (ノックとなおの声が済んだ), ch3_nao_talked, ch3_towel (タオルをかけ直した).
//  Flags read from earlier chapters: ch2_towel_off (the towel line after the lid) — otherwise the
//  night is rebuilt from scratch.
// ─────────────────────────────────────────────────────────────────────────────

/** Flags this chapter writes; cleared whenever it starts from its head. (nao_trust is cumulative: untouched.) */
const OWN_FLAGS = [
  'locked_both', 'toilet_closed', 'read_doc_call_log', 'bell_rang', 'nao_in', 'saw_key', 'heard_whisper', 'heard_lock', 'slept_ch3',
  'ch3_tv_off', 'ch3_genkan', 'ch3_nao_voice', 'ch3_nao_talked', 'ch3_towel',
];

const DEG = Math.PI / 180;

// positions (the scenario places these by coordinates; no new anchors)
const NAO_FRIDGE: V3 = [-21.0, 0, 10.0];                 // 段C: in front of the fridge, yaw 90
const GENKAN_STAND = { pos: [-21.0, 0, 8.6] as V3, yaw: 0 }; // Toru facing Nao in the genkan
const PHONE_BEDSIDE: V3 = [-19.17, 0.8, 14.4];           // Nao's phone while she sits by the bed
const EAR: V3 = [-18.85, 0.8, 14.5];                     // close to the pillow
const ABOVE_PILLOW: V3 = [-18.8, 1.75, 14.35];           // 段D: the breathing right above the face
const BEDSIDE_HEAD: V3 = [-19.45, 1.5, 14.4];            // Nao standing by the bed (head height)
const BEDSIDE_SIT_HEAD: V3 = [-19.5, 0.65, 14.36];       // Nao sitting by the bed (head height)
/** 段A・B: Nao held this close to the center of view counts as being watched */
const WATCH_DEG = 16;
const STEPS_TO_BED: V3[] = [[-20.75, 0.05, 10.5], [-20.35, 0.05, 11.5], [-19.95, 0.05, 12.5], [-19.6, 0.05, 13.6]];
const STEPS_TO_DOOR: V3[] = [[-19.7, 0.05, 13.5], [-20.1, 0.05, 12.4], [-20.5, 0.05, 11.3], [-20.8, 0.05, 10.3], [-21.0, 0.05, 9.2], [-21.1, 0.05, 8.1]];

const v = (p: V3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);

/** game clock in minutes after midnight */
const minutesNow = (c: Ctx): number => c.now.h * 60 + c.now.m;

/** Set the clock, but never backwards (the HUD clock must stay believable). */
function clockAtLeast(c: Ctx, h: number, m: number, rate: number): void {
  const t = Math.max(h * 60 + m, minutesNow(c));
  c.clock(Math.floor(t / 60) % 24, t % 60, rate);
}

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
/** Is the world point within `deg` degrees of the center of view? */
function lookingAt(c: Ctx, p: THREE.Vector3, deg: number): boolean {
  const cam = c.game.engine.camera;
  cam.getWorldDirection(_fwd);
  _to.copy(p).sub(cam.position);
  const d = _to.length();
  if (d < 1e-3) return true;
  return _fwd.dot(_to) / d > Math.cos(deg * DEG);
}

/** Head position of a visible NPC (fallback: root + height). */
function npcHead(c: Ctx, id: string, fallbackY: number): THREE.Vector3 | null {
  const n = c.game.world.npcs.get(id);
  if (!n || !n.visible) return null;
  if (n.head) return n.head.getWorldPosition(new THREE.Vector3());
  return n.root.position.clone().add(new THREE.Vector3(0, fallbackY, 0));
}

/**
 * 5-0 rule 3: a dialogue box over closed eyes keeps them closed (the engine would open them
 * for the box). For thoughts, voices and choices that may come while the eyes are shut.
 */
async function keepShut<T>(c: Ctx, show: () => Promise<T>): Promise<T> {
  const g = c.game;
  const shut = g.eyes.closed && g.eyes.force === null;
  if (shut) c.eyes(true);
  const r = await show(); // Aborted (chapter over): leave the next chapter's eyes alone
  if (shut && g.eyes.force === true) c.releaseEyes();
  return r;
}

/** Lines about what Toru sees wait until the eyes are open (bounded by the 8 s rule outside the scope). */
async function eyesOpen(c: Ctx): Promise<void> {
  while (c.player.eyesClosed) await c.wait(0.1);
}

/** Wait (game time, at most `maxSec`) until p is out of the center of view or the eyes are closed. */
async function unseen(c: Ctx, p: THREE.Vector3, deg: number, maxSec: number): Promise<void> {
  for (let t = 0; t < maxSec && !c.player.eyesClosed && lookingAt(c, p, deg); t += 0.1) await c.wait(0.1);
}

/** Camera yaw/pitch (degrees, camera convention: 0 = north, 90 = west) from one point toward another. */
function aimFrom(from: THREE.Vector3, to: THREE.Vector3): { yaw: number; pitch: number } {
  const d = to.clone().sub(from);
  return { yaw: Math.atan2(-d.x, -d.z) / DEG, pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG };
}

const wrapPi = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * Turn the head of the player lying awake (c.lieAwake) toward a camera yaw/pitch (degrees),
 * kept inside the lying look limits. It first brings the yaw to the winding the engine
 * clamps against: Game.lieAwake leaves it at the player's old winding, and the per-frame
 * clamp would otherwise snap the view to the edge of the range.
 */
async function turnInBed(c: Ctx, yawDeg: number, pitchDeg: number, sec: number): Promise<void> {
  const L = c.game.lying;
  if (!L) return;
  const o = L.o;
  const r = L.range * DEG;
  o.yaw = L.cy + Math.max(-r, Math.min(r, wrapPi(o.yaw - L.cy)));
  const y0 = o.yaw, p0 = o.pitch;
  const y1 = L.cy + Math.max(-r, Math.min(r, wrapPi(yawDeg * DEG - L.cy)));
  const p1 = Math.max(10 * DEG, Math.min(85 * DEG, pitchDeg * DEG));
  await c.cutscene(async () => {
    for (let t = 0; t < sec; ) {
      await c.wait(1 / 60);
      t += 1 / 60;
      const k = Math.min(1, t / sec);
      const e = k * k * (3 - 2 * k);
      o.yaw = y0 + (y1 - y0) * e;
      o.pitch = p0 + (p1 - p0) * e;
    }
  });
}

// ── the fake sleep (寝たふり) ───────────────────────────────────────────────
interface SleepState {
  /** running (after the opening monologue in bed) */
  on: boolean;
  /** stages done: 0 none, 1 A, 2 B, 3 C, 4 D running (ceiling face), 5 face gone, 6 E */
  stage: number;
  /** closed-eye seconds counted toward the next stage */
  acc: number;
  /** seconds Nao has been held in the center of view during A/B */
  watch: number;
  /** 段C 「……いないね」 already shown */
  sawFridge: boolean;
  /** how the night ended */
  result: null | 'slept' | 'awake';
}

interface Run {
  ctx: Ctx;
  tick(dt: number): void;
  intro(): Promise<void>;
}

/** The current run of this chapter (rebuilt by every setup, incl. retries). */
let current: Run | null = null;

function wire(c: Ctx): Run {
  const tag = c.checkpointTag;
  if (tag === null) for (const f of OWN_FLAGS) c.set(f, false);

  const st = {
    tvLoop: null as SoundHandle | null,
    /** the player is looking through the door scope right now */
    peeping: false,
    /** entered the door scope after the doorbell (cancels the 10 s fallback) */
    peepEntered: false,
    peepFaceShown: false,
    /** the 「[E] で覗き穴から離れる」 hint was shown */
    peepHinted: false,
    /** entered the bath after locking up (objective: トイレのふたを閉める) */
    bathEntered: false,
    voiceStarted: false,
    opening: false,
    sleepStarting: false,
    sleep: { on: false, stage: 0, acc: 0, watch: 0, sawFridge: false, result: null } as SleepState,
  };
  const ended = (): boolean => st.sleep.result !== null;
  const until = async (cond: () => boolean): Promise<void> => {
    while (!cond()) await c.wait(0.1);
  };

  const door = c.prop('apt_door');
  const sink = c.prop('apt_sink');
  const setChain = (hooked: boolean): void => {
    c.lock('apt_door_chain', hooked);
    door.showNode('chain_hooked', hooked);
    door.showNode('chain_hanging', !hooked);
  };

  // ── Nao ───────────────────────────────────────────────────────────────────
  /** Nao sitting by the low table in the room (talkable until the talk is done). */
  const showNaoRoom = (talk: boolean): void => {
    if (talk) c.npc('npc_nao_sit', { at: 'npc_nao_room', talk: () => naoTalk() });
    else c.npc('npc_nao_sit', { at: 'npc_nao_room' });
  };
  /** Nao sitting by the bed, phone raised toward the pillow. */
  const naoBedsideSit = (): void => {
    c.npc('npc_nao_sit', { at: 'npc_nao_bedside', yaw: -90, phoneGlow: true });
  };

  // ── テレビ ────────────────────────────────────────────────────────────────
  const intro = async (): Promise<void> => {
    await c.play('ch3.wake_tv');
    await c.wait(0.5);
    if (c.is('ch3_tv_off')) return;
    // F3-1: in the static, right in front of the bed
    c.face('anc_tv_screen', {
      type: 'fleeting', style: 'flat', lethal: 3, vanishAfter: 1.8,
      onSeen: () => c.run(() => c.play('ch3.tv_face')),
    });
    c.objective(T('ch3.obj_tv_off'));
  };

  c.on('apt_tv', {
    label: () => (c.is('ch3_tv_off') ? c.defaultLabel('apt_tv') : T('ch3.label_tv_off')),
    blind: false,
    use: async () => {
      if (c.is('ch3_tv_off')) {
        await c.useDefault('apt_tv');
        return;
      }
      c.set('ch3_tv_off');
      c.sfx('tv_on', { at: 'apt_tv' });
      c.tv('off');
      st.tvLoop?.stop(0.15);
      st.tvLoop = null;
      c.clearFace('anc_tv_screen');
      await c.play('ch3.tv_off_soil');
      // the genkan event waits for the TV, so this can never roll the objective back
      if (!c.is('ch3_genkan')) c.objective(T('ch3.obj_genkan'));
    },
  });

  // ── 玄関 ─────────────────────────────────────────────────────────────────
  /** zone_apt_genkan（初回）. Only after the TV, so the objectives stay in order. */
  const genkan = async (): Promise<void> => {
    if (!c.is('ch3_tv_off') || c.is('ch3_genkan')) return;
    c.set('ch3_genkan');
    await eyesOpen(c); // what he sees (the zone also fires while walking with the eyes shut)
    // QA #15: he went out barefoot (soil on his soles) — the sandals were never his clue
    await c.play('ch3.genkan_open');
    c.sfx('hyoshigi', { volume: 0.9 });
    await c.wait(1.4);
    await keepShut(c, () => c.play('ch3.genkan_hyoshigi'));
    if (!c.is('locked_both')) c.objective(T('ch3.obj_lock'));
  };
  c.zone('zone_apt_genkan', { enter: () => genkan() });

  /** both the lock and the chain are on */
  const lockedBoth = async (): Promise<void> => {
    await c.play('ch3.locked_both');
    c.set('locked_both');
    await c.wait(0.8);
    c.sfx('water_drip', { at: 'anc_toilet_bowl', volume: 2 });
    await keepShut(c, () => c.play('ch3.bath_water'));
    if (!c.is('toilet_closed')) c.objective(st.bathEntered ? T('ch3.obj_toilet_lid') : T('ch3.obj_bath'));
  };

  // ── ピンポン：覗き穴・ノック・なおの声・ドアを開ける ─────────────────────────
  /** Knock → 「……透くん？　……私。なお」 → Nao appears outside the door. Runs once. */
  const naoVoice = async (): Promise<void> => {
    if (st.voiceStarted) return;
    st.voiceStarted = true;
    c.sfx('knock', { at: 'apt_door', volume: 1.4, rolloff: 0.6 }); // the knock sample is three knocks
    await c.wait(1.3);
    await keepShut(c, () => c.play('ch3.nao_voice'));
    // Nao steps into the door scope's view while the corridor light blinks off (共通ルール5)
    const lamp = c.light('ext_corridor_light');
    const hide = st.peeping;
    if (hide) {
      lamp.setOn(false);
      await c.wait(0.3);
    }
    c.npc('npc_nao', { at: 'npc_nao_door', phoneGlow: true });
    if (hide) {
      await c.wait(0.25);
      lamp.setOn(true);
    }
    if (st.peeping) await eyesOpen(c); // she is seen, not heard: only once the eyes open
    if (st.peeping) {
      if (st.peepFaceShown) await c.play('ch3.nao_seen_after_face');
      else await c.play('ch3.nao_seen');
    } else {
      await keepShut(c, () => c.play('ch3.nao_heard'));
    }
    c.set('ch3_nao_voice');
  };

  /** F3-3: the face outside the door scope (first look after the bell). */
  const peepFace = (): void => {
    st.peepFaceShown = true;
    // QA #6: it teaches that the stare counts through the scope too, and must never kill:
    // it vanishes at 80 % of the stare at the latest (harmless only as a safety net)
    const f = c.face('anc_door_outside', { type: 'static', lethal: 2.5, harmless: true });
    c.run(async () => {
      await c.play('ch3.peep_face');
      c.hint(T('ch3.hint_peep_face'), 7);
      // gone after looking away for 1 s, or 3 s after the monologue (the stare only counts once
      // the box is closed), or before the stare reaches 2 of its 2.5 s
      let last = f.age;
      let t = 0;
      let away = 0;
      while (f.alive && f.dying === 0 && away < 1 && t < 3 && f.gaze < f.lethal * 0.8) {
        await c.wait(0.05);
        const d = f.age - last;
        last = f.age;
        t += d;
        away = f.centered ? 0 : away + d;
      }
      c.clearFace(f);
      await naoVoice();
    });
  };

  const peep = async (): Promise<void> => {
    const bell = c.is('bell_rang') && !c.is('nao_in');
    if (bell) st.peepEntered = true;
    st.peeping = true;
    try {
      await c.peephole({
        onEnter: () => {
          if (bell && !st.voiceStarted && !st.peepFaceShown) peepFace(); // its own hint, after the monologue
          else if (!st.peepHinted) c.hint(T('ch3.hint_peep_leave'), 5);
          st.peepHinted = true;
        },
      });
    } finally {
      st.peeping = false;
    }
    // 声のあと、覗き穴を出た時点で選択
    if (bell && c.is('ch3_nao_voice')) await openDoor();
  };

  /** 「開ける」／「……開けない」 → Nao comes in, locks the door and sits in the room. */
  const openDoor = async (): Promise<void> => {
    if (st.opening || c.is('nao_in')) return;
    st.opening = true;
    const i = await keepShut(c, () => c.choice(TL('ch3.choice_open_door')));
    if (i === 0) {
      c.inc('nao_trust');
    } else {
      await keepShut(c, () => c.play('ch3.nao_please'));
      c.sfx('ringtone', { at: 'apt_phone', volume: 3, rolloff: 0.5 });
      await c.wait(2.0);
      await keepShut(c, () => c.play('ch3.phone_rings_nao'));
      await keepShut(c, () => c.choice(TL('ch3.choice_open_door_again')));
    }
    await c.cutscene(async () => {
      c.lock('apt_door', false);
      setChain(false);
      c.sfx('chain', { at: 'apt_door' });
      await c.wait(0.6);
      c.sfx('door_open', { at: 'apt_door' });
      await door.animate(1, 'leaf', 0.9);
      await c.wait(0.5);
      // she steps into the genkan (moved during a short blackout; NPCs never walk)
      await c.fadeOut(0.35);
      c.hideNpc('npc_nao');
      c.npc('npc_nao', { at: 'npc_nao_genkan' });
      c.teleport(GENKAN_STAND);
      await c.fadeIn(0.35);
      await c.play('ch3.nao_enters');
      c.sfx('door_close', { at: 'apt_door' });
      await door.animate(0, 'leaf', 0.7);
      c.sfx('door_lock', { at: 'apt_door' });
      c.lock('apt_door', true);
      await c.play('ch3.nao_locks');
      await c.fadeOut(0.5);
      c.hideNpc('npc_nao');
      showNaoRoom(true);
      c.light('apt_light_room').setOn(true); // she switches the room light on (switched off again at bedtime)
      c.set('nao_in');
      await c.fadeIn(0.5);
    });
    c.objective(T('ch3.obj_talk_nao'));
  };

  c.on('apt_door', {
    label: () => (c.is('nao_in') ? T('ch3.label_genkan') : c.defaultLabel('apt_door')),
    blind: false,
    use: async () => {
      if (c.is('nao_in')) {
        await c.play('ch3.door_cant_leave');
        return;
      }
      if (door.isOpen()) return;
      // 声のあと：玄関のメニューを開いた時点で選択
      if (c.is('ch3_nao_voice')) {
        await openDoor();
        return;
      }
      if (c.is('bell_rang')) {
        const i = await c.choice(TL('ch3.choice_door_bell'));
        if (i === 0) {
          await peep();
        } else if (i === 1) {
          if (!st.voiceStarted) {
            // QA #25: not past the face and 「顔かと思ったら、なお」 — the scope first.
            // (Nobody looking still gets the knock and the voice, 10 s after the bell.)
            await c.play('ch3.door_peep_first');
          } else {
            // the knock has started: the voice runs on by itself, then the choice
            await until(() => c.is('ch3_nao_voice'));
            await openDoor();
          }
        }
        return;
      }
      // before the doorbell: lock it, but do not go out
      await genkan();
      const canLock = c.is('ch3_genkan') && !c.is('locked_both');
      const opts: [id: string, text: string][] = [['peep', T('ch3.choice_door_peep')]];
      if (canLock && !c.isLocked('apt_door')) opts.push(['lock', T('ch3.choice_door_lock')]);
      if (canLock && !c.isLocked('apt_door_chain')) opts.push(['chain', T('ch3.choice_door_chain')]);
      opts.push(['open', T('ch3.choice_door_open')], ['cancel', T('ch3.choice_door_cancel')]);
      const pick = opts[await c.choice(opts.map((o) => o[1]))][0];
      if (pick === 'peep') await peep();
      else if (pick === 'lock') {
        c.sfx('door_lock', { at: 'apt_door' });
        c.lock('apt_door', true);
      } else if (pick === 'chain') {
        c.sfx('chain', { at: 'apt_door' });
        setChain(true);
      } else if (pick === 'open') {
        await c.play('ch3.door_no_go_out');
      }
      if (canLock && c.isLocked('apt_door') && c.isLocked('apt_door_chain')) await lockedBoth();
    },
  });

  // ── 浴室 ─────────────────────────────────────────────────────────────────
  // F3-2: entering the bath after locking up, while the lid is still open (it can't be closed earlier)
  c.when(() => c.is('locked_both') && !c.is('toilet_closed') && c.inZone('zone_apt_bath'), () => {
    if (c.is('toilet_closed')) return;
    st.bathEntered = true;
    c.objective(T('ch3.obj_toilet_lid')); // QA #3: the objective says what checking the bath means
    c.face('anc_toilet_bowl', {
      type: 'static',
      onSeen: () => c.run(() => c.play('ch3.toilet_face')),
    });
  });

  c.on('apt_toilet', {
    label: () => {
      if (!c.is('locked_both')) return null; // QA #3: the lid waits until the door is locked
      if (!c.is('toilet_closed') && c.prop('apt_toilet').isOpen('lid')) return T('ch3.label_toilet_lid');
      return c.player.eyesClosed ? null : c.defaultLabel('apt_toilet'); // only the closing is 〔閉眼可〕
    },
    blind: true,
    use: async () => {
      const toilet = c.prop('apt_toilet');
      if (c.is('toilet_closed') || !toilet.isOpen('lid')) {
        await c.useDefault('apt_toilet');
        return;
      }
      c.set('toilet_closed');
      c.sfx('lid_close', { at: 'apt_toilet' });
      void toilet.animate(0, 'lid', 0.5);
      c.clearFace('anc_toilet_bowl');
      await c.wait(0.5);
      await eyesOpen(c); // closed blind: the towel is noticed once the eyes open (at most the 8 s rule)
      // 第2章で自分でタオルを外していた（ch2_towel_off）なら、床にあるのは不思議ではない
      if (c.is('ch2_towel_off')) await c.play('ch3.towel_floor_own');
      else await c.play('ch3.towel_floor');
      c.checkpoint('ch3_bell');
      c.run(async () => {
        await c.wait(1.0);
        c.sfx('phone_vibrate', { at: 'apt_phone', volume: 2, rolloff: 0.5 });
        c.objective(T('ch3.obj_phone'));
      });
    },
  });

  c.on('apt_bath_mirror', {
    label: () => {
      if (c.is('ch3_towel')) return null;
      if (c.is('toilet_closed')) return T('ch3.label_towel');
      return c.defaultLabel('apt_bath_mirror');
    },
    blind: false,
    use: async () => {
      if (c.is('ch3_towel')) return;
      if (!c.is('toilet_closed')) {
        await c.useDefault('apt_bath_mirror');
        return;
      }
      c.set('ch3_towel');
      c.sfx('curtain', { at: 'apt_sink', volume: 0.6 });
      sink.showNode('towel_floor', false);
      sink.showNode('towel', true);
      await c.play('ch3.towel_back');
    },
  });

  // ── スマホ（→ピンポン） ──────────────────────────────────────────────────
  c.on('apt_phone', {
    label: () => (c.is('toilet_closed') ? T('ch3.label_phone') : null),
    blind: false,
    use: async () => {
      if (c.is('read_doc_call_log')) {
        await c.doc('doc_call_log');
        return;
      }
      await c.doc('doc_call_log');
      await c.play('ch3.call_log');
      await c.wait(1.5);
      clockAtLeast(c, 3, 3, 0.05);
      c.sfx('doorbell');
      c.set('bell_rang');
      await keepShut(c, () => c.play('ch3.bell'));
      await c.wait(2.0);
      c.sfx('doorbell');
      c.objective(T('ch3.obj_peephole'));
      // nobody looks through the scope for 10 s → the knock and the voice come anyway
      c.after(10, () => {
        if (!st.peepEntered && !st.voiceStarted) c.run(naoVoice);
      });
    },
  });

  // ── その他（既定＋一言） ───────────────────────────────────────────────────
  c.on('apt_fridge', {
    label: () => c.defaultLabel('apt_fridge'),
    blind: false,
    use: async () => {
      const opening = !c.prop('apt_fridge').isOpen('door');
      await c.useDefault('apt_fridge');
      if (opening) await c.play('ch3.fridge_nothing');
    },
  });

  // ── なお（洋室） ─────────────────────────────────────────────────────────
  const naoTalk = async (): Promise<void> => {
    if (c.is('ch3_nao_talked')) return;
    await c.cutscene(async () => {
      await c.play('ch3.talk_face');
      const i = await c.choice(TL('ch3.choice_talk_face'));
      if (i === 0) await c.play('ch3.talk_face_told');
      else await c.play('ch3.talk_face_hid');
      await c.play('ch3.talk_pale');
      // she goes into the unit bath (moved during a short blackout)
      await c.fadeOut(0.4);
      c.hideNpc('npc_nao_sit');
      c.prop('apt_bath_door').setOpen(0, 'leaf');
      c.sfx('door_close', { at: 'apt_bath_door' });
      await c.fadeIn(0.4);
      await c.wait(0.6);
      await c.play('ch3.bag');
      const b = await c.choice(TL('ch3.choice_bag'));
      if (b === 0) {
        await c.play('ch3.bag_key');
        c.sfx('suzu', { at: 'npc_nao_room' });
        await c.wait(0.7);
        await c.play('ch3.bag_key_doubt');
        c.set('saw_key');
      } else {
        await c.play('ch3.bag_no');
        c.inc('nao_trust');
      }
      await c.wait(1.0);
      c.sfx('toilet_flush', { at: 'apt_toilet' });
      await c.wait(1.6);
      c.sfx('door_open', { at: 'apt_bath_door' });
      void c.prop('apt_bath_door').animate(1, 'leaf', 0.6);
      await c.wait(0.8);
      await c.fadeOut(0.4);
      showNaoRoom(false);
      clockAtLeast(c, 3, 30, 0.05); // 「三時半だよ」
      await c.fadeIn(0.4);
      await c.play('ch3.talk_sleep');
      c.set('ch3_nao_talked');
      c.checkpoint('ch3_bed');
    });
    c.objective(T('ch3.obj_bed'));
  };

  // ── 寝たふり ─────────────────────────────────────────────────────────────
  const lieDownAwake = async (): Promise<void> => {
    if (st.sleepStarting) return;
    st.sleepStarting = true;
    c.objective(null); // 「横になる」で達成。寝たふりの間は目標を出さない
    await c.lieAwake({ yaw: 75 });
    c.gameOverReason = T('ch3.gameover_fake_sleep');
    c.sfx('switch_click', { at: 'apt_switch_room' });
    const sw = c.prop('apt_switch_room');
    void sw.animate(sw.isOpen() ? 0 : 1, undefined, 0.08);
    // the whole flat goes dark: the face over the bed sits in the dark (共通ルール4) and the fridge
    // light is all that shows her back in 段C
    for (const id of ['apt_light_room', 'apt_light_kitchen', 'apt_light_bath']) c.light(id).setOn(false);
    c.tv('off');
    // she gets up in the dark while his eyes are on the ceiling (共通ルール5)
    c.hideNpc('npc_nao_sit');
    await c.play('ch3.lights_off');
    naoBedsideSit();
    // QA #25: the lying view starts on Nao's side and low — she is in view a little off the center,
    // the ceiling (段D) is not
    const L = c.game.lying;
    if (L) {
      const head = npcHead(c, 'npc_nao_sit', 0.65) ?? v(BEDSIDE_SIT_HEAD);
      const a = aimFrom(L.o.pos, head);
      await turnInBed(c, a.yaw - 24, a.pitch + 2, 1.6); // she stays outside the WATCH_DEG cone
    }
    await c.play('ch3.fake_sleep');
    c.hint(T('ch3.hint_fake_sleep'), 10);
    st.sleep.on = true;
  };

  c.on('apt_bed', {
    label: () => {
      if (!c.is('ch3_nao_talked')) return c.defaultLabel('apt_bed');
      return st.sleepStarting ? null : T('ch3.label_lie_down');
    },
    blind: false,
    use: async () => {
      if (!c.is('ch3_nao_talked')) {
        await c.useDefault('apt_bed');
        return;
      }
      await lieDownAwake();
    },
  });

  /** 段A: the recording starts. */
  const stageA = (): void => {
    st.sleep.stage = 1;
    naoBedsideSit(); // (eyes closed) back on her spot, phone raised
    c.sfx('rec_beep', { at: v(PHONE_BEDSIDE) });
    c.subLine('ch3.sub_rec_beep', 3);
  };
  /** 段B: the whisper. */
  const stageB = (): void => {
    st.sleep.stage = 2;
    c.sfx('whisper_shizuku', { at: v(EAR), volume: 0.8 });
    c.subLine('ch3.sub_whisper', 2.2);
    c.set('heard_whisper'); // QA #25: with the first line — falling asleep right after still heard it
    c.run(async () => {
      await c.wait(2);
      if (ended() || st.sleep.stage !== 2) return;
      c.subLine('ch3.sub_himawari', 3.5);
    });
  };
  /** 段C: Nao at the open fridge, past the sliding door. */
  const stageC = (): void => {
    st.sleep.stage = 3;
    st.sleep.sawFridge = false;
    c.hideNpc('npc_nao_sit');
    c.npc('npc_nao', { at: NAO_FRIDGE, yaw: 90, lookAtPlayer: false });
    const room = c.prop('apt_room_door');
    if (!room.isOpen('panel')) room.setOpen(1, 'panel');
    c.light('apt_fridge_light').setOn(true);
    c.sfx('fridge_open', { at: 'apt_fridge', rolloff: 0.5 });
    void c.prop('apt_fridge').animate(1, 'door', 0.55);
    c.subLine('ch3.sub_fridge_open', 3);
  };
  /** 段D: back to the bed — and the face right above the pillow (F3-4, 6 s). */
  const stageD = (): void => {
    st.sleep.stage = 4;
    c.run(async () => {
      c.sfx('fridge_close', { at: 'apt_fridge', rolloff: 0.5 });
      void c.prop('apt_fridge').animate(0, 'door', 0.55).then(() => {
        if (c.alive) c.light('apt_fridge_light').setOn(false);
      });
      c.hideNpc('npc_nao');
      for (const p of STEPS_TO_BED) {
        c.sfx('step_wood', { at: v(p), volume: 1.8, rolloff: 0.6 });
        await c.wait(0.5);
        if (ended()) return;
      }
      // she appears by the bed only while that spot is not watched (or the eyes are closed)
      await unseen(c, v(BEDSIDE_HEAD), 45, 8);
      if (ended()) return;
      c.npc('npc_nao', { at: 'npc_nao_bedside', yaw: -90 });
      // 予兆（QA #25）: breathing right above. Turned to the side, the face stays at the edge of view
      c.sfx('breathing', { at: v(ABOVE_PILLOW) });
      c.subLine('ch3.sub_breathing', 3);
      c.fear(0.3, 2);
      await c.wait(1.6);
      if (ended()) return;
      // it comes while not looked at (or with the eyes closed); a stare at the ceiling waits ≤ 3 s
      await unseen(c, c.anchor('anc_ceiling_bed'), 30, 3);
      if (ended()) return;
      const f = c.face('anc_ceiling_bed', { type: 'static' });
      c.subLine('ch3.sub_neta', 3);
      c.fear(0.5, 6);
      await c.wait(6);
      if (ended()) return;
      c.clearFace(f);
      st.sleep.acc = 0;
      st.sleep.stage = 5;
    });
  };
  /** 段E: she leaves — and locks the door from outside. */
  const stageE = (): void => {
    st.sleep.stage = 6;
    c.run(async () => {
      c.hideNpc('npc_nao');
      for (const p of STEPS_TO_DOOR) {
        c.sfx('step_wood', { at: v(p), volume: 1.8, rolloff: 0.6 });
        await c.wait(0.5);
        if (ended()) return;
      }
      // the door is 7 m from the pillow: these must carry through the flat
      c.sfx('door_open', { at: 'apt_door', rolloff: 0.3 });
      await c.wait(1.0);
      if (ended()) return;
      c.sfx('door_close', { at: 'apt_door', rolloff: 0.3 });
      await c.wait(1.5);
      if (ended()) return;
      c.sfx('door_lock', { at: 'apt_door', volume: 1.6, rolloff: 0.3 });
      st.sleep.result = 'awake';
      c.set('heard_lock');
      c.gameOverReason = null;
      await c.wait(0.9);
      c.eyes(false); // 目は自動で開く
      await c.play('ch3.heard_lock');
      await c.fadeOut(1.5);
      await c.play('ch3.dawn');
      await c.goto('ch4_day');
    });
  };

  const tick = (dt: number): void => {
    const sl = st.sleep;
    if (!sl.on || sl.result !== null || !c.alive || c.game.ui.blocking) return;
    const closed = c.player.eyesClosed;
    // stages advance by the total time the eyes are kept closed
    if (closed && (sl.stage <= 3 || sl.stage === 5)) {
      sl.acc += dt;
      if (sl.acc >= 3) {
        sl.acc = 0;
        if (sl.stage === 0) stageA();
        else if (sl.stage === 1) stageB();
        else if (sl.stage === 2) stageC();
        else if (sl.stage === 3) stageD();
        else stageE();
      }
    }
    // 段A・Bの間：目を開けてなおを1.5秒見つめると「……起きてる？」→ 段Aからやり直し
    // (16°: her head sits at pillow height, and the lying view can't come closer than ~12.5° to it)
    const head = !closed && (sl.stage === 1 || sl.stage === 2) ? npcHead(c, 'npc_nao_sit', 0.65) : null;
    if (head && lookingAt(c, head, WATCH_DEG)) {
      sl.watch += dt;
      if (sl.watch >= 1.5) {
        sl.watch = 0;
        sl.stage = 0;
        sl.acc = 0;
        c.subLine('ch3.sub_okiteru', 3);
      }
    } else {
      sl.watch = 0;
    }
    // 段C：見えたら「……いないね」
    if (sl.stage === 3 && !sl.sawFridge && !closed) {
      const h = npcHead(c, 'npc_nao', 1.45);
      if (h && lookingAt(c, h, 28)) {
        sl.sawFridge = true;
        c.subLine('ch3.sub_inaine', 3);
      }
    }
  };

  // 8秒ルール：寝たふりの間は本当に眠ってしまう（→ slept_ch3）。それ以外は既定。
  c.onBlackout(() => {
    const sl = st.sleep;
    if (!sl.on) return false;
    if (sl.result !== null) return true;
    sl.result = 'slept';
    c.run(async () => {
      c.eyes(true);
      c.clearFaces();
      c.subLine('ch3.sub_fading', 4);
      await c.fadeOut(2.2);
      c.set('slept_ch3');
      c.gameOverReason = null;
      await c.goto('ch4_day');
    });
    return true;
  });

  // ── 世界の組み立て（章頭 / ch3_bell / ch3_bed） ─────────────────────────────
  c.prop('apt_bath_door').setOpen(1, 'leaf');
  c.prop('apt_room_door').setOpen(1, 'panel');
  c.prop('apt_fridge').showNode('memo', true); // 第1章の冷蔵庫のメモ（D02）は貼られたまま（QA17）
  sink.showNode('towel', c.is('ch3_towel'));
  sink.showNode('towel_floor', !c.is('ch3_towel'));
  if (tag === 'ch3_bed') {
    c.lock('apt_door', true);
    setChain(false);
    c.prop('apt_toilet').setOpen(0, 'lid');
    c.light('apt_light_room').setOn(true);
    showNaoRoom(false);
    clockAtLeast(c, 3, 30, 0.05); // the checkpoint keeps the clock; never before 「三時半だよ」
    c.objective(T('ch3.obj_bed'));
  } else if (tag === 'ch3_bell') {
    // TV off (world reset), locked up, lid closed; the clock comes back from the checkpoint
    c.lock('apt_door', true);
    setChain(true);
    c.prop('apt_toilet').setOpen(0, 'lid');
    c.objective(T('ch3.obj_phone'));
    c.after(1.0, () => {
      c.sfx('phone_vibrate', { at: 'apt_phone', volume: 2, rolloff: 0.5 });
    });
  } else {
    // 章頭：鍵なし・チェーン垂れ、トイレのふた開、テレビは砂嵐
    c.lock('apt_door', false);
    setChain(false);
    c.prop('apt_toilet').setOpen(1, 'lid');
    c.tv('static');
    st.tvLoop = c.loop('tv_static', { at: 'apt_tv', volume: 2.5 });
  }
  // the doorbell rings at 3:03 — hold the clock at 3:02 until then so it never runs backwards
  if (!c.is('bell_rang')) {
    c.when(() => c.is('bell_rang') || minutesNow(c) >= 3 * 60 + 2, () => {
      if (!c.is('bell_rang')) c.clock(c.now.h, c.now.m, 0);
    });
  }

  return { ctx: c, tick, intro };
}

export const ch3_night: ChapterDef = {
  id: 'ch3_night',
  title: T('ch3.title'),
  subtitle: T('ch3.subtitle'),
  time: 'night',
  spawn: 'spawn_bed',
  wakeUp: true,
  clock: { h: 3, m: 0, rate: 0.05 },
  ambience: 'room_tone',
  gameOverReason: T('ch3.gameover'),
  setup(c) {
    current = wire(c);
  },
  async intro(c) {
    if (current?.ctx === c) await current.intro();
  },
  update(c, dt) {
    if (current?.ctx === c) current.tick(dt);
  },
};
