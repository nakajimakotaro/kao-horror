import type { SoundHandle } from '../../audio/AudioEngine';
import type { Npc } from '../../world/World';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';

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
const townObjective = (c: Ctx): string => `外に出て、町を歩く（掲示板・コンビニの店員・神社の宮司　${townCount(c)}/3）`;
/** the towel hung over the mirror in ch1 is still there (until taken off here) */
const towelOn = (c: Ctx): boolean => c.is('gap_mirror') && !c.is('ch2_towel_off');

function currentObjective(c: Ctx): string {
  if (!c.is('read_doc_line_nao')) return 'スマホを見る';
  if (c.is('ch2_dusk')) return '部屋に戻って休む';
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
  await c.mono('……日が傾いてきた。ヒグラシが鳴いてる');
  c.objective('部屋に戻って休む');
}

/**
 * 5-0 rule 3: no dialogue box over closed eyes (the engine would open them for it).
 * For triggers that can fire while the player walks with the eyes shut (zones):
 * keep the eyes shut for the box, then hand them back.
 */
async function monoEyesSafe(c: Ctx, text: string | string[]): Promise<void> {
  if (!c.player.eyesClosed) {
    await c.mono(text);
    return;
  }
  c.eyes(true);
  try {
    await c.mono(text);
  } finally {
    c.releaseEyes();
  }
}

// ── NPC talks ───────────────────────────────────────────────────────────────
const HATSU_Q = ['夜中に、目が覚めるんです', '前に住んでた人って、どんな人でした？', '懐中電灯が、冷蔵庫に入ってたんです'];

// QA19: ハツ and 白瀬 share one local speech (〜けん・〜とる・〜やろ・ほやけど). No Kansai せやけど /
// bare 〜や / 行き・つぶっとき, no Hiroshima ほいじゃけん.
async function hatsuAnswer(c: Ctx, q: number): Promise<void> {
  c.set(`hatsu2_q${q + 1}`);
  if (q === 0) {
    await c.say('ハツ', [
      '三時ごろやろ。年寄りは、みんなそうよ',
      'ほやけど、目はつぶっとかないかんよ。夜中に目ぇ開けとったら、おもてさまと目が合うけん',
    ]);
  } else if (q === 1) {
    await c.say('ハツ', [
      '女の子よ。しずくちゃん。ええ子やった',
      '夜によう歩いとったんよ。裸足で。……去年の夏の終わりに、おらんようになってしもうて',
      '掲示板に、張り紙あるやろ',
    ]);
  } else {
    await c.say('ハツ', 'ああ、電池はな、冷蔵庫に入れとくと長持ちするんよ。あんたが越してきたとき、教えたやろ');
    await c.mono('……そうだっけ');
  }
}

async function talkHatsu(c: Ctx): Promise<void> {
  if (!c.is('talked_hatsu_2')) {
    c.set('talked_hatsu_2');
    await c.say('ハツ', ['あら、103の。暑いねえ。打ち水しよるんよ', 'あんた、顔色わるいよ。ちゃんと寝よるん？']);
    await hatsuAnswer(c, await c.choice(HATSU_Q));
    await c.say('ハツ', [
      'おもてさまの唄、知らん？　このへんの子は、みんな歌うて育ったんよ',
      'ひとつ、ひとりで、めがさめて。ふたつ、ふたつで、めがあう',
      'みっつ、みられりゃ、おもてになる。よっつ、よなかの、すきまから。いつつ、いつでも、のぞいてる',
      '……あら、続き。なんやったかねえ。年とると、すぐ出てこんようになる',
      '夜におもてに出たらいかんよ。おもてさまが見とるけん',
    ]);
    await c.doc('doc_song_half');
    await c.mono('ハツさんの唄を、スマホのメモに打ち込んだ');
    return;
  }
  // 2回目以降: 残りの選択肢と「いえ、なんでも」
  const rest = HATSU_Q.map((text, q) => ({ text, q })).filter((o) => !c.is(`hatsu2_q${o.q + 1}`));
  if (rest.length) {
    const i = await c.choice([...rest.map((o) => o.text), 'いえ、なんでも']);
    if (i < rest.length) await hatsuAnswer(c, rest[i].q);
    else await c.say('ハツ', 'そうかね。……ほんなら'); // QA24: 「いえ、なんでも」にも一言（唄はくり返さない）
  }
  await c.say('ハツ', '蚊取り線香、いる？　夜は蚊が多いけん');
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
  await c.say('さき', '……おにいちゃん、103のひと？');
  await c.say('透', 'そうだけど');
  await c.say('さき', 'よるね、さき、トイレにおきたら、おにいちゃん、あるいてたよ。はだしで');
  await c.say('透', '……え？');
  await c.say('さき', ['おにいちゃんのうしろにね、しろいかお、いたよ', 'ないしょね。ママに、うそつくなっていわれるから']);
}

async function talkSaki(c: Ctx): Promise<void> {
  if (!c.is('talked_saki_2')) {
    await sakiFirst(c, null);
    return;
  }
  await c.say('さき', 'なつやすみ、あとみっかで、おわっちゃう');
}

async function talkClerk(e: Env): Promise<void> {
  const { c } = e;
  if (c.is('talked_clerk_2')) {
    // (he served Toru at three this morning if Toru went in during ch1 — then 「深夜もいる」 is no news)
    if (c.is('visited_conbini_ch1')) await c.say('坂口', '今朝の三時も、俺だったでしょ。人いないんで。……夜中に線香買ってく人、たまにいるんすよね');
    else await c.say('坂口', '深夜もいるんすよ、俺。人いないんで。……夜中に線香買ってく人、たまにいるんすよね');
    return;
  }
  if (c.is('visited_conbini_ch1')) {
    // QA24: Toru did come in at three this morning (ch1) — 坂口 knows, and asks about the night before
    await c.say('坂口', ['いらっしゃいませー。……あ', 'お客さん、今朝の三時ごろも来てましたけど……おとといも、来てましたよね']);
    await c.say('透', '……おととい？　来てないけど');
  } else {
    await c.say('坂口', ['いらっしゃいませー。……あ', 'お客さん、おとといも三時ごろ来てましたよね']);
    await c.say('透', '……来てないけど');
  }
  await c.say('坂口', [
    'え、来てたっすよ。ドリンクの冷蔵庫の前で、ずーっと立ってて。で、ミルクティー一本',
    'なんか小声でしゃべってたんで、電話かと思ったんすけど',
    '『お姉ちゃんの好きなやつ』って。……女の子みたいな声で',
  ]);
  await c.say('透', '……覚えてない'); // QA18: said aloud — 坂口 answers it
  await c.say('坂口', ['……え、寝てたんすか？　歩きながら？　こわ', '電池なら、そこの棚っす']);
  markTown(c, 'talked_clerk_2');
  await checkDusk(e);
}

async function talkShrine(e: Env): Promise<void> {
  const { c } = e;
  // first visit opens with the greeting; later visits go straight to the same choices
  if (!c.is('talked_shrine_2')) await c.say('白瀬', '……お参りかね。暑いのに、ご苦労さん');
  const i = await c.choice(['おもてさまって、何ですか', 'お守りを、ください', 'いえ。……なんでも']);
  if (i === 0) {
    await c.say('白瀬', [
      'この辺は昔、面見（おもてみ）いうてな。夜中に神隠しにおうた者は、体をなくして、白い面だけになる、言うんよ',
      '面は目を閉じられんけん、眠れん。夜中に目ぇ覚ました者を、すきまから覗きに来る',
      'ふたつ数えるあいだ目が合うたら、入られる。……ほやけん、夜中に目が覚めたら、朝まで目ぇつぶっとけ。昔はみんな、そうしよった',
      '……ま、年寄りの話よ。眠れんのやったら、病院へ行かないかんよ',
    ]);
    if (c.has('coffee')) {
      const j = await c.choice(['缶コーヒー、どうぞ', '……いえ']);
      if (j === 0) {
        c.take('coffee');
        c.toast('缶コーヒー（微糖） を渡した');
        await c.say('白瀬', [
          'おお、すまんね',
          '……去年の夏な、裸足の娘さんが、毎晩、祠の前で目ぇつぶって座っとった',
          '声かけたら『見ちゃだめ。目が合ったら、入られる』言うてな',
        ]);
      } else {
        await c.say('白瀬', '……そうかね'); // QA24: 「……いえ」にも反応
      }
    }
  } else if (i === 1) {
    await c.say('白瀬', '面守りよ。一度だけ、身代わりになってくれる');
    await c.shop('juyosho');
  } else {
    await c.say('白瀬', 'そうかね。……お守りだけでも、受けていったらええ。気ぃつけて帰りなさいよ');
  }
  markTown(c, 'talked_shrine_2');
  await checkDusk(e);
}

// ── chapter ─────────────────────────────────────────────────────────────────
export const ch2_day: ChapterDef = {
  id: 'ch2_day',
  title: '一日目',
  subtitle: '八月二十九日　午後零時四十分',
  time: 'day',
  spawn: 'spawn_bed',
  wakeUp: true,
  clock: { h: 12, m: 40, rate: 0.1 },
  ambience: 'room_tone',
  // money: carried over from ch1 (1,500 minus whatever was bought)
  gameOverReason: '白い顔と、ふたつ数えるあいだ目が合ってしまった。',

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
    c.npc('npc_neighbor', { at: 'npc_neighbor_spot', label: 'ハツさんに話しかける', talk: () => talkHatsu(c) });
    const saki = c.npc('npc_extra', { at: 'npc_extra_spot', label: '女の子に話しかける', talk: () => talkSaki(c) });
    c.npc('npc_clerk', { at: 'npc_clerk_spot', talk: () => talkClerk(e) });
    // 白瀬 is 「授与所の窓口にいる」: face out of the office window (the model's +Z, turned by
    // the office's rot). The anchor's own yaw (90 on an office turned 90) leaves him side-on.
    c.npc('npc_shrine', { at: 'npc_shrine_spot', yaw: (c.prop('shr_office').def.rot ?? 0) + 180, talk: () => talkShrine(e) });

    // ── room ──
    c.on('apt_phone', {
      label: 'スマホを見る',
      blind: false,
      use: async () => {
        if (c.is('read_doc_line_nao')) {
          await c.mono('なおからの新しい連絡は、ない');
          return;
        }
        await c.doc('doc_line_nao');
        await c.say('透', '……『みてる』？');
        await c.mono([
          '俺が送ったのか。二時四十七分に',
          '……覚えてない',
          // QA11: say once, in the game, what Nao is to him
          'なお。四月にコンビニで知り合って、夜にふらっと来て、話して、帰る',
          '……付き合ってるのかって聞かれたら、たぶん二人とも答えられない',
          '明るいうちに、ゆうべ顔が出たところも見ておこう',
        ]);
        if (townCount(c) < 3) c.objective(townObjective(c));
        await checkDusk(e); // the town may already be done if the player went out first
      },
    });
    c.on('apt_trash', {
      label: 'ゴミ箱を見る',
      blind: false,
      use: async () => {
        await c.doc('doc_receipt');
        await c.mono(['おとといの夜中の、三時六分？', 'ミルクティーなんて、買った覚えはない', '……行ってない。行ってない、はずだ']);
      },
    });
    c.on('apt_desk', {
      label: () => (c.prop('apt_desk').isOpen('drawer') ? '引き出しを閉める' : '机の引き出しを開ける'),
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
        await c.mono(['今日の三時か。……検査の結果', 'ただの不眠だ。……今日は、いいや']);
      },
    });
    c.on('apt_medicine', { label: '薬の袋を見る', blind: false, use: () => c.mono('睡眠導入剤。……ほとんど減ってない') });
    c.on('apt_notebook', {
      label: 'ノートを見る',
      blind: false,
      use: async () => {
        await c.doc('doc_notebook');
        await c.mono('納品は31日。あと三日');
      },
    });
    c.on('apt_calendar', {
      label: 'カレンダーを見る',
      blind: false,
      use: async () => {
        await c.mono([
          '八月。31日に、赤い丸',
          '……「1ねん」？',
          '俺の字じゃない。丸くて、少し右に傾いた字',
          '何の日だっけ。……なおと会ったのは四月だし',
        ]);
        c.set('read_calendar');
      },
    });
    c.on('apt_photo', { label: '写真立てを見る', blind: false, use: () => c.mono('実家の柴犬。……元気かな') });
    c.on('apt_breaker', { label: '分電盤を見る', blind: false, use: () => c.mono('剥がしたテープ。……俺の机の、マスキングテープだ') });
    c.on('apt_fridge', {
      label: () => c.defaultLabel('apt_fridge'),
      blind: false,
      use: async () => {
        const opening = !c.prop('apt_fridge').isOpen('door');
        await c.useDefault('apt_fridge');
        if (opening && !c.is('ch2_fridge_seen')) {
          c.set('ch2_fridge_seen');
          await c.mono(['麦茶、卵、缶ビール。……顔なんて、いない', '扉のパッキンが、ゆるんでる。だから勝手に開くのか']);
        }
      },
    });
    c.on('apt_washer', {
      label: () => (c.is('trace_washer') ? c.defaultLabel('apt_washer') : '洗濯機をのぞく'),
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
        await c.mono([
          '糸くずフィルターに、何か挟まってる',
          '洗濯ネット。マジックで「みやうち」',
          '前に住んでた人のか。……この洗濯機、備え付けだもんな',
        ]);
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
          await c.mono([
            '床に、長い髪の毛と……紺のヘアゴム',
            'なおのか？　この前来たとき――',
            'いや。なおが、クローゼットなんか開けるか？',
          ]);
          c.set('trace_closet');
        }
      },
    });
    c.on('apt_bath_mirror', {
      label: () => (towelOn(c) ? 'タオルを外す' : c.defaultLabel('apt_bath_mirror')),
      blind: false,
      use: async () => {
        if (!towelOn(c)) {
          await c.useDefault('apt_bath_mirror');
          return;
        }
        c.sfx('curtain', { at: 'apt_sink', volume: 0.6 });
        c.prop('apt_sink').showNode('towel', false);
        c.set('ch2_towel_off');
        await c.mono('……ただの鏡だ。ひどい顔の、俺');
      },
    });
    c.on('apt_bathtub', { label: '浴槽を見る', blind: false, use: () => c.mono('床は、もう乾いてる。……ゆうべは、あんなにあふれてたのに') });
    c.on('apt_door', {
      label: () => c.defaultLabel('apt_door'),
      blind: false,
      use: async () => {
        if (!c.is('ch2_door_checked') && !c.prop('apt_door').isOpen()) {
          c.set('ch2_door_checked');
          // QA24: if he unhooked it himself in ch1 (to go out) and went to bed so, nothing is strange
          if (c.get('ch1_chain_at_bed') === false) await c.mono(['チェーン、外れてる', '……ゆうべ、外したまま寝たんだ']);
          else await c.mono(['チェーン、外れてる。……ゆうべ、かかってたはずだ', '寝ぼけて外したのか']);
        }
        await c.useDefault('apt_door');
      },
    });
    let ending = false;
    c.on('apt_bed', {
      label: () => (c.is('ch2_dusk') ? '少しだけ、横になる' : 'ベッド'),
      blind: false,
      use: async () => {
        if (!c.is('ch2_dusk')) {
          await c.mono('まだ昼だ');
          return;
        }
        if (ending) return;
        ending = true;
        c.run(async () => {
          await c.lieDown();
          await c.narrate('少しだけ、のつもりだった。');
          await c.goto('ch3_night'); // town_count stays 3 (ch4 recounts its own from its setup)
        });
      },
    });

    // ── town ──
    c.on('ext_board', {
      label: '張り紙を読む',
      blind: false,
      use: async () => {
        await c.doc('doc_poster_shizuku');
        if (c.is('town_board')) {
          await c.mono('迷い猫のミケ。……ラジオ体操は、31日まで');
          return;
        }
        await c.say('透', '二丁目。……ここじゃん');
        await c.mono(['去年の、八月三十一日。午前三時', '……あと二日で、一年か']);
        markTown(c, 'town_board');
        if (!c.is('talked_saki_2')) await sakiFirst(c, saki); // さきの会話が自動で始まる
        await checkDusk(e);
      },
    });
    c.on('ext_mailbox', { label: '集合ポストを見る', blind: false, use: () => c.mono('チラシばかりだ') });
    c.on('conbini_fridge', { label: '冷蔵ケースを見る', blind: false, use: () => c.mono('ドリンクの冷蔵ケース。……ミルクティーが、並んでる') });
    c.on('shr_yuisho', { label: '由緒書きを読む', blind: false, use: () => c.doc('doc_yuisho') });
    c.on('shr_ema', {
      label: '絵馬を見る',
      blind: false,
      use: async () => {
        await c.doc('doc_ema');
        if (c.is('read_doc_poster_shizuku')) await c.mono(['……しずく。張り紙の子だ', 'おねえちゃんが、いたのか']);
      },
    });
    c.on('shr_hokora', {
      label: '祠を見る',
      blind: false,
      use: () => c.mono(['林の奥の、小さな祠', '線香の燃えかすが、たくさん。……誰かが、何度もあげてる']),
    });
    c.on('shr_shinboku', { label: '御神木を見る', blind: false, use: () => c.mono('大きな楠。しめ縄。……蝉の抜け殻が、いくつも') });
    // 坂口 stands right behind the register: the counter's default line (店員の姿が見えない) would
    // contradict him, so aiming at the counter talks to him too.
    c.on('conbini_counter', { label: '店員に話しかける', range: 2.8, blind: false, use: () => talkClerk(e) });
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
        await monoEyesSafe(c, '打ち水の音');
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
    const lines = ['……昼だ', 'ゆうべのことは、夢だったのかもしれない'];
    if (towelOn(c)) lines.push('……鏡のタオルは、かかったままだけど');
    // QA15: charging the phone in ch1 is optional — if he didn't, someone plugged it in for him
    lines.push(c.is('ch1_phone_charged') ? 'スマホ、充電できてる' : 'スマホが、充電ケーブルにささってる。……さした覚えは、ない');
    await c.mono(lines);
    c.objective(currentObjective(c));
  },
};
