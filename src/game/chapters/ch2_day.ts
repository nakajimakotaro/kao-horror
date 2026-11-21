import type { SoundHandle } from '../../audio/AudioEngine';
import type { Npc } from '../../world/World';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';
import { T, TL } from '../../script';

// ─────────────────────────────────────────────────────────────────────────────
//  第2章　ch2_day「一日目　昼」（docs/SCENARIO.md §5 第2章）
//
//  Daylight. Toru reads Nao's messages, then walks the town: the bulletin board
//  (→ さき), ツキミマート (坂口) and 月見神社 (白瀬). Optional: the room by day
//  (receipt, clinic card, notebook, calendar, the places where faces appeared),
//  ハツ, shopping. No faces in this chapter (no game over). Checkpoint: chapter
//  head only (the engine saves it), so setup only has to rebuild from flags.
//
//  Flags written (scenario): read_calendar, trace_washer, trace_closet,
//    town_board, talked_clerk_2, talked_shrine_2, town_count (0..3) + read_doc_*.
//  Chapter-local helpers: ch2_dusk (町3/3 → 夕方の合図が済んだ), talked_hatsu_2,
//    hatsu2_q1..3 (ハツに聞いた質問), talked_saki_2, ch2_door_checked,
//    ch2_fridge_seen, ch2_towel_off.
//  Flags read: gap_mirror (ch1: 鏡のタオル), visited_conbini_ch1 (坂口の第一声),
//    ch1_chain_at_bed (玄関のチェーンの独白), ch1_phone_charged (開始演出のスマホ).
//
//  Beyond the scenario text (kept small): 町3/3 waits until the phone (D03) is read;
//  at 町3/3 the HUD clock moves on to 17:00 so it agrees with 「日が傾いてきた」;
//  world defaults that open a box are re-registered blind:false (5-0); the store
//  counter talks to 坂口 (its default line says the clerk is away); 白瀬 faces out
//  of the 授与所 window; the zone monologue keeps closed eyes closed (rule 3).
// ─────────────────────────────────────────────────────────────────────────────

const TOWN = ['town_board', 'talked_clerk_2', 'talked_shrine_2'] as const;
type TownFlag = (typeof TOWN)[number];

const townCount = (c: Ctx): number => TOWN.filter((f) => c.is(f)).length;
// QA3: name what actually counts (reading the board / talking to 坂口 / talking to 白瀬), not just the places
const townObjective = (c: Ctx): string => T('ch2.obj_town', { n: townCount(c) });
/** the towel hung over the mirror in ch1 is still there (until taken off here) */
const towelOn = (c: Ctx): boolean => c.is('gap_mirror') && !c.is('ch2_towel_off');

function currentObjective(c: Ctx): string {
  if (!c.is('read_doc_line_nao')) return T('ch2.obj_phone');
  if (c.is('ch2_dusk')) return T('ch2.obj_rest');
  return townObjective(c);
}

// ── ambience ────────────────────────────────────────────────────────────────
// 屋外 day_out ＋ ツクツクボウシ／室内 room_tone ＋遠い蝉. The engine has a single
// ambience bed, so the bed follows the place (room / store / shrine / street) and
// the cicadas are a separate loop whose volume follows the place too.
// At 町3/3 ([AMB:higurashi]) the bed outdoors becomes higurashi itself (the midday
// cicadas of day_out / shrine_day stop) and the layer carries higurashi indoors only.
type Place = 'apt' | 'conbini' | 'shrine' | 'out';
const LAYER_VOL: Record<'day' | 'dusk', Record<Place, number>> = {
  day: { apt: 0.35, conbini: 0.12, shrine: 1, out: 1 },
  dusk: { apt: 0.45, conbini: 0.2, shrine: 0, out: 0 }, // outdoors the bed is the higurashi
};

function placeOf(c: Ctx): Place {
  if (c.inZone('zone_apt')) return 'apt';
  if (c.inZone('zone_conbini_in')) return 'conbini';
  if (c.inZone('zone_shrine')) return 'shrine';
  return 'out';
}

interface Ambience {
  tick(): void;
  dusk(): void;
}

function startAmbience(c: Ctx): Ambience {
  let place = placeOf(c);
  let evening = c.is('ch2_dusk');
  const vol = (): number => LAYER_VOL[evening ? 'dusk' : 'day'][place];
  const layer = (): SoundHandle => c.loop(evening ? 'higurashi' : 'tsukutsuku', { volume: vol() });
  const bed = (): void => {
    if (place === 'apt') c.ambience('room_tone');
    else if (place === 'conbini') c.ambience('conbini_in');
    else if (evening) c.ambience('higurashi');
    else if (place === 'shrine') c.ambience('shrine_day');
    else c.ambience('day_out');
  };
  let insects = layer();
  if (place !== 'apt') bed(); // the chapter's own ambience (room_tone) already covers the room
  return {
    tick() {
      const p = placeOf(c);
      if (p === place) return;
      place = p;
      bed();
      insects.setVolume(vol(), 1.5);
    },
    dusk() {
      if (evening) return;
      evening = true;
      insects.stop(3);
      insects = layer();
      bed();
    },
  };
}

// ── town progress ───────────────────────────────────────────────────────────
interface Env {
  c: Ctx;
  amb: Ambience;
}

/** Set one of the three town flags and keep town_count / the objective in step. */
function markTown(c: Ctx, flag: TownFlag): void {
  if (c.is(flag)) return;
  c.set(flag);
  c.set('town_count', townCount(c));
  if (c.is('read_doc_line_nao') && !c.is('ch2_dusk')) c.objective(townObjective(c));
}

/** the HUD clock at 町3/3 (12:40 at rate 0.1 is only ~13:30 by then; the line says the sun is going down) */
const DUSK_CLOCK = { h: 17, m: 0 };

/** 町 3/3 になった瞬間（スマホを読んだあと）: crows, higurashi, back home. */
async function checkDusk(e: Env): Promise<void> {
  const { c } = e;
  if (!c.is('read_doc_line_nao') || c.is('ch2_dusk') || townCount(c) < 3) return;
  c.set('ch2_dusk');
  // [SE:crows]: crows is a looping bed in the library, so it is a loop stopped after a while
  const crows = c.loop('crows', { volume: 0.9 });
  c.after(15, () => crows.stop(2.5));
  e.amb.dusk(); // [AMB:higurashi]
  const now = c.now;
  if (now.h * 60 + now.m < DUSK_CLOCK.h * 60 + DUSK_CLOCK.m) c.clock(DUSK_CLOCK.h, DUSK_CLOCK.m, 0.1);
  await c.play('ch2.dusk');
  c.objective(T('ch2.obj_rest'));
}

/**
 * 5-0 rule 3: no dialogue box over closed eyes (the engine would open them for it).
 * For triggers that can fire while the player walks with the eyes shut (zones):
 * keep the eyes shut for the box, then hand them back.
 */
async function monoEyesSafe(c: Ctx, show: () => Promise<void>): Promise<void> {
  if (!c.player.eyesClosed) {
    await show();
    return;
  }
  c.eyes(true);
  try {
    await show();
  } finally {
    c.releaseEyes();
  }
}

// ── NPC talks ───────────────────────────────────────────────────────────────
const hatsuQ = (): string[] => TL('ch2.choice_hatsu');

// QA19: ハツ and 白瀬 share one local speech (〜けん・〜とる・〜やろ・ほやけど). No Kansai せやけど /
// bare 〜や / 行き・つぶっとき, no Hiroshima ほいじゃけん.
async function hatsuAnswer(c: Ctx, q: number): Promise<void> {
  c.set(`hatsu2_q${q + 1}`);
  if (q === 0) {
    await c.play('ch2.hatsu_ans_night');
  } else if (q === 1) {
    await c.play('ch2.hatsu_ans_prev');
  } else {
    await c.play('ch2.hatsu_ans_fridge');
  }
}

async function talkHatsu(c: Ctx): Promise<void> {
  if (!c.is('talked_hatsu_2')) {
    c.set('talked_hatsu_2');
    await c.play('ch2.hatsu_greet');
    await hatsuAnswer(c, await c.choice(hatsuQ()));
    await c.play('ch2.hatsu_song');
    await c.doc('doc_song_half');
    await c.play('ch2.hatsu_song_memo');
    return;
  }
  // 2回目以降: 残りの選択肢と「いえ、なんでも」
  const rest = hatsuQ().map((text, q) => ({ text, q })).filter((o) => !c.is(`hatsu2_q${o.q + 1}`));
  if (rest.length) {
    const i = await c.choice([...rest.map((o) => o.text), T('ch2.choice_hatsu_none')]);
    if (i < rest.length) await hatsuAnswer(c, rest[i].q);
    else await c.play('ch2.hatsu_none'); // QA24: 「いえ、なんでも」にも一言（唄はくり返さない）
  }
  await c.play('ch2.hatsu_katori');
}

/** さき's first talk: right after the board (turn toward her) or when spoken to first. */
async function sakiFirst(c: Ctx, turnTo: Npc | null): Promise<void> {
  c.set('talked_saki_2');
  if (turnTo) {
    const head = c.anchor('npc_extra_spot');
    if (turnTo.head) turnTo.head.getWorldPosition(head).y += 0.08;
    else head.y = 0.95;
    await c.cutscene(() => c.lookAt(head, 0.7)); // she speaks up: turn toward her (no walking off mid-turn)
  }
  await c.play('ch2.saki_first');
}

async function talkSaki(c: Ctx): Promise<void> {
  if (!c.is('talked_saki_2')) {
    await sakiFirst(c, null);
    return;
  }
  await c.play('ch2.saki_again');
}

async function talkClerk(e: Env): Promise<void> {
  const { c } = e;
  if (c.is('talked_clerk_2')) {
    // (he served Toru at three this morning if Toru went in during ch1 — then 「深夜もいる」 is no news)
    if (c.is('visited_conbini_ch1')) await c.play('ch2.clerk_again_ch1');
    else await c.play('ch2.clerk_again');
    return;
  }
  if (c.is('visited_conbini_ch1')) {
    // QA24: Toru did come in at three this morning (ch1) — 坂口 knows, and asks about the night before
    await c.play('ch2.clerk_first_ch1');
  } else {
    await c.play('ch2.clerk_first');
  }
  // QA18: said aloud — 坂口 answers it (透「……覚えてない」 in ch2.clerk_milktea)
  await c.play('ch2.clerk_milktea');
  markTown(c, 'talked_clerk_2');
  await checkDusk(e);
}

async function talkShrine(e: Env): Promise<void> {
  const { c } = e;
  // first visit opens with the greeting; later visits go straight to the same choices
  if (!c.is('talked_shrine_2')) await c.play('ch2.shrine_greet');
  const i = await c.choice(TL('ch2.choice_shrine'));
  if (i === 0) {
    await c.play('ch2.shrine_omote');
    if (c.has('coffee')) {
      const j = await c.choice(TL('ch2.choice_coffee'));
      if (j === 0) {
        c.take('coffee');
        c.toast(T('ch2.toast_coffee'));
        await c.play('ch2.shrine_coffee');
      } else {
        await c.play('ch2.shrine_coffee_no'); // QA24: 「……いえ」にも反応
      }
    }
  } else if (i === 1) {
    await c.play('ch2.shrine_omamori');
    await c.shop('juyosho');
  } else {
    await c.play('ch2.shrine_nothing');
  }
  markTown(c, 'talked_shrine_2');
  await checkDusk(e);
}

// ── chapter ─────────────────────────────────────────────────────────────────
export const ch2_day: ChapterDef = {
  id: 'ch2_day',
  title: T('ch2.title'),
  subtitle: T('ch2.subtitle'),
  time: 'day',
  spawn: 'spawn_bed',
  wakeUp: true,
  clock: { h: 12, m: 40, rate: 0.1 },
  ambience: 'room_tone',
  // money: carried over from ch1 (1,500 minus whatever was bought)
  gameOverReason: T('ch2.gameover'),

  setup(c) {
    // ── world (初期状態) ──
    c.power(true); // room lights stay off in daylight; the switches work
    c.lock('apt_door', true);
    c.lock('apt_door_chain', false);
    const door = c.prop('apt_door');
    door.showNode('chain_hooked', false);
    door.showNode('chain_hanging', true);
    c.prop('apt_sink').showNode('towel', towelOn(c));
    c.prop('apt_fridge').showNode('memo', true); // D02 stays on the fridge door (QA17)
    c.poster('poster_1', { tex: 'poster_missing_1', visible: true });
    c.poster('poster_2', { tex: 'poster_missing_2', visible: true });
    c.poster('poster_3', { visible: false });
    c.poster('poster_4', { tex: 'poster_notice_1', visible: true });
    c.poster('poster_5', { tex: 'poster_notice_2', visible: true });
    c.prop('shr_hokora').showNode('ash', true);

    const e: Env = { c, amb: startAmbience(c) };
    c.every(0.25, () => e.amb.tick());

    // ── NPCs ──
    c.npc('npc_neighbor', { at: 'npc_neighbor_spot', label: T('ch2.label_hatsu'), talk: () => talkHatsu(c) });
    const saki = c.npc('npc_extra', { at: 'npc_extra_spot', label: T('ch2.label_saki'), talk: () => talkSaki(c) });
    c.npc('npc_clerk', { at: 'npc_clerk_spot', talk: () => talkClerk(e) });
    // 白瀬 is 「授与所の窓口にいる」: face out of the office window (the model's +Z, turned by
    // the office's rot). The anchor's own yaw (90 on an office turned 90) leaves him side-on.
    c.npc('npc_shrine', { at: 'npc_shrine_spot', yaw: (c.prop('shr_office').def.rot ?? 0) + 180, talk: () => talkShrine(e) });

    // ── room ──
    c.on('apt_phone', {
      label: T('ch2.label_phone'),
      blind: false,
      use: async () => {
        if (c.is('read_doc_line_nao')) {
          await c.play('ch2.phone_no_news');
          return;
        }
        await c.doc('doc_line_nao');
        // QA11: say once, in the game, what Nao is to him
        await c.play('ch2.phone_line_nao');
        if (townCount(c) < 3) c.objective(townObjective(c));
        await checkDusk(e); // the town may already be done if the player went out first
      },
    });
    c.on('apt_trash', {
      label: T('ch2.label_trash'),
      blind: false,
      use: async () => {
        await c.doc('doc_receipt');
        await c.play('ch2.trash_receipt');
      },
    });
    c.on('apt_desk', {
      label: () => (c.prop('apt_desk').isOpen('drawer') ? T('ch2.label_desk_close') : T('ch2.label_desk_open')),
      blind: false,
      use: async () => {
        const desk = c.prop('apt_desk');
        if (desk.isOpen('drawer')) {
          await c.useDefault('apt_desk');
          return;
        }
        c.sfx('drawer_open', { at: 'apt_desk' });
        await desk.animate(1, 'drawer', 0.35);
        await c.doc('doc_clinic_card');
        await c.play('ch2.desk_clinic_card');
      },
    });
    c.on('apt_medicine', { label: T('ch2.label_medicine'), blind: false, use: () => c.play('ch2.medicine') });
    c.on('apt_notebook', {
      label: T('ch2.label_notebook'),
      blind: false,
      use: async () => {
        await c.doc('doc_notebook');
        await c.play('ch2.notebook');
      },
    });
    c.on('apt_calendar', {
      label: T('ch2.label_calendar'),
      blind: false,
      use: async () => {
        await c.play('ch2.calendar');
        c.set('read_calendar');
      },
    });
    c.on('apt_photo', { label: T('ch2.label_photo'), blind: false, use: () => c.play('ch2.photo') });
    c.on('apt_breaker', { label: T('ch2.label_breaker'), blind: false, use: () => c.play('ch2.breaker') });
    c.on('apt_fridge', {
      label: () => c.defaultLabel('apt_fridge'),
      blind: false,
      use: async () => {
        const opening = !c.prop('apt_fridge').isOpen('door');
        await c.useDefault('apt_fridge');
        if (opening && !c.is('ch2_fridge_seen')) {
          c.set('ch2_fridge_seen');
          await c.play('ch2.fridge_first');
        }
      },
    });
    c.on('apt_washer', {
      label: () => (c.is('trace_washer') ? c.defaultLabel('apt_washer') : T('ch2.label_washer')),
      blind: false,
      use: async () => {
        if (c.is('trace_washer')) {
          await c.useDefault('apt_washer');
          return;
        }
        const washer = c.prop('apt_washer');
        if (!washer.isOpen('lid')) {
          c.sfx('lid_open', { at: 'apt_washer' });
          await washer.animate(1, 'lid', 0.5);
        }
        await c.play('ch2.washer_net');
        c.set('trace_washer');
      },
    });
    c.on('apt_closet', {
      label: () => c.defaultLabel('apt_closet'),
      blind: false,
      use: async () => {
        const opening = !c.prop('apt_closet').isOpen('door_r');
        await c.useDefault('apt_closet');
        if (opening && !c.is('trace_closet')) {
          await c.play('ch2.closet_hair');
          c.set('trace_closet');
        }
      },
    });
    c.on('apt_bath_mirror', {
      label: () => (towelOn(c) ? T('ch2.label_towel') : c.defaultLabel('apt_bath_mirror')),
      blind: false,
      use: async () => {
        if (!towelOn(c)) {
          await c.useDefault('apt_bath_mirror');
          return;
        }
        c.sfx('curtain', { at: 'apt_sink', volume: 0.6 });
        c.prop('apt_sink').showNode('towel', false);
        c.set('ch2_towel_off');
        await c.play('ch2.mirror_towel_off');
      },
    });
    c.on('apt_bathtub', { label: T('ch2.label_bathtub'), blind: false, use: () => c.play('ch2.bathtub') });
    c.on('apt_door', {
      label: () => c.defaultLabel('apt_door'),
      blind: false,
      use: async () => {
        if (!c.is('ch2_door_checked') && !c.prop('apt_door').isOpen()) {
          c.set('ch2_door_checked');
          // QA24: if he unhooked it himself in ch1 (to go out) and went to bed so, nothing is strange
          if (c.get('ch1_chain_at_bed') === false) await c.play('ch2.door_chain_self');
          else await c.play('ch2.door_chain_strange');
        }
        await c.useDefault('apt_door');
      },
    });
    let ending = false;
    c.on('apt_bed', {
      label: () => (c.is('ch2_dusk') ? T('ch2.label_bed_dusk') : T('ch2.label_bed')),
      blind: false,
      use: async () => {
        if (!c.is('ch2_dusk')) {
          await c.play('ch2.bed_still_noon');
          return;
        }
        if (ending) return;
        ending = true;
        c.run(async () => {
          await c.lieDown();
          await c.play('ch2.bed_sleep');
          await c.goto('ch3_night'); // town_count stays 3 (ch4 recounts its own from its setup)
        });
      },
    });

    // ── town ──
    c.on('ext_board', {
      label: T('ch2.label_board'),
      blind: false,
      use: async () => {
        await c.doc('doc_poster_shizuku');
        if (c.is('town_board')) {
          await c.play('ch2.board_again');
          return;
        }
        await c.play('ch2.board_first');
        markTown(c, 'town_board');
        if (!c.is('talked_saki_2')) await sakiFirst(c, saki); // さきの会話が自動で始まる
        await checkDusk(e);
      },
    });
    c.on('ext_mailbox', { label: T('ch2.label_mailbox'), blind: false, use: () => c.play('ch2.mailbox') });
    c.on('conbini_fridge', { label: T('ch2.label_conbini_fridge'), blind: false, use: () => c.play('ch2.conbini_fridge') });
    c.on('shr_yuisho', { label: T('ch2.label_yuisho'), blind: false, use: () => c.doc('doc_yuisho') });
    c.on('shr_ema', {
      label: T('ch2.label_ema'),
      blind: false,
      use: async () => {
        await c.doc('doc_ema');
        if (c.is('read_doc_poster_shizuku')) await c.play('ch2.ema_shizuku');
      },
    });
    c.on('shr_hokora', {
      label: T('ch2.label_hokora'),
      blind: false,
      use: () => c.play('ch2.hokora'),
    });
    c.on('shr_shinboku', { label: T('ch2.label_shinboku'), blind: false, use: () => c.play('ch2.shinboku') });
    // 坂口 stands right behind the register: the counter's default line (店員の姿が見えない) would
    // contradict him, so aiming at the counter talks to him too.
    c.on('conbini_counter', { label: T('ch2.label_clerk'), range: 2.8, blind: false, use: () => talkClerk(e) });
    // World defaults that open a box (looks / shops). defaults.ts leaves them usable with closed
    // eyes; here they are sighted-only like every interaction of this chapter (5-0: blind:false,
    // rule 3). ext_vending (vending) / conbini_shelf (conbini) / conbini_atm / shr_saisen /
    // shr_chozuya / shr_komainu / shr_kura / shr_haiden are the scenario's 「既定」.
    for (const id of [
      'ext_vending', 'conbini_shelf', 'conbini_atm', 'conbini_magazine',
      'shr_saisen', 'shr_chozuya', 'shr_komainu', 'shr_kura', 'shr_haiden',
      'ext_curve_mirror', 'ext_garbage', 'ext_phonebooth', 'ext_barrier', 'ext_door_101', 'ext_door_102', 'ext_door_104',
      'apt_microwave', 'apt_lowtable', 'apt_ac', 'apt_ac_outdoor', 'apt_window',
    ]) {
      c.on(id, { label: () => c.defaultLabel(id), blind: false, use: () => c.useDefault(id) });
    }

    // ── place triggers ──
    c.zone('zone_neighbor', {
      once: true,
      enter: async () => {
        c.sfx('water_ladle', { at: 'npc_neighbor_spot' });
        await monoEyesSafe(c, () => c.play('ch2.zone_neighbor'));
      },
    });
    // ハツ keeps sprinkling water while the player is around
    c.every(6, () => {
      if (Math.random() < 0.5) return;
      if (c.anchor('npc_neighbor_spot').distanceTo(c.player.pos) > 16) return;
      c.sfx('water_ladle', { at: 'npc_neighbor_spot', volume: 0.6 });
    });
    // zone_conbini_in: the automatic door already plays conbini_chime (World.onAutoDoor).

    if (c.checkpointTag) c.objective(currentObjective(c)); // (no mid-chapter checkpoints; intro sets it)
  },

  async intro(c) {
    const lines = TL('ch2.intro_noon');
    if (towelOn(c)) lines.push(T('ch2.intro_towel'));
    // QA15: charging the phone in ch1 is optional — if he didn't, someone plugged it in for him
    lines.push(c.is('ch1_phone_charged') ? T('ch2.intro_phone_charged') : T('ch2.intro_phone_plugged'));
    await c.mono(lines);
    c.objective(currentObjective(c));
  },
};
