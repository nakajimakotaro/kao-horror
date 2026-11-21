import * as THREE from 'three';
import type { SoundHandle } from '../../audio/AudioEngine';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';
import { T, TL, lines } from '../../script';

// ─────────────────────────────────────────────────────────────────────────────
//  第4章　ch4_day「二日目　昼」 — docs/SCENARIO.md §5「第4章」
//
//  目標（必須・この順）:
//    なおの置き手紙を読む → クローゼットを調べる（日記 D14）
//    → 郵便受けを見る（D13）→ 町で話を聞く（掲示板・坂口・宮司　n/3、順不同）
//    → （夕方のメッセージ）→ 部屋に戻って休む → ch5_night
//  顔は出ない（ゲームオーバーなし）。チェックポイントは章頭のみ。
//
//  シナリオの章フラグ: trace_tv, town_board_4, talked_saki_4, hatsu_key, hatsu_saw,
//    talked_clerk_4, atm, knows_rite, talked_shrine_4, town_count
//    （所持品 diary / hairpin / number_memo、自動の read_doc_*）
//  実装用フラグ: ch4_town_done（町3/3の演出を済ませた）, ch4_evening（夕方のメッセージを受けた）
//  前章から読むフラグ: slept_ch3（開始地点）, read_calendar, read_doc_notebook,
//    read_doc_song_half（さきが1番から歌うか）
//  ノード: apt_lowtable.note（置き手紙。章のあいだ表示）、apt_closet.tenbukuro_open / diary_book
//    （置き手紙を読んだあとの物音で落ちる。日記は拾ったら消す）、apt_fridge.memo（第1章のメモ）
// ─────────────────────────────────────────────────────────────────────────────

const OBJ = {
  get note() { return T('ch4.obj_note'); },
  get closet() { return T('ch4.obj_closet'); },
  get mailbox() { return T('ch4.obj_mailbox'); },
  // QA3: name what counts (the board / 坂口 / 白瀬), not just the places
  town: (n: number) => T('ch4.obj_town', { n }),
  get rest() { return T('ch4.obj_rest'); },
};

/** 町の三か所（掲示板・坂口・宮司）のうち、済んだ数 */
function townCount(c: Ctx): number {
  return ['town_board_4', 'talked_clerk_4', 'talked_shrine_4'].filter((k) => c.is(k)).length;
}

/** 目標はフラグだけから一意に決まる（常に一つ・常に正しい） */
function currentObjective(c: Ctx): string {
  if (!c.is('read_doc_nao_note')) return OBJ.note;
  if (!c.has('diary')) return OBJ.closet;
  if (!c.is('read_doc_clinic_letter')) return OBJ.mailbox;
  if (!c.is('ch4_town_done')) return OBJ.town(townCount(c));
  return OBJ.rest;
}

/** 町の数を数え直し、手紙を読んだあとなら（n/3）の目標を出す */
function refreshTown(c: Ctx): void {
  const n = townCount(c);
  c.set('town_count', n);
  if (c.is('read_doc_clinic_letter') && !c.is('ch4_town_done')) c.objective(OBJ.town(n));
}

/** 町 3/3 になった瞬間（手紙を読んだあと）。会話が終わってから呼ぶ */
async function maybeTownDone(c: Ctx): Promise<void> {
  if (c.is('ch4_town_done') || !c.is('read_doc_clinic_letter') || townCount(c) < 3) return;
  c.set('ch4_town_done');
  await c.play('ch4.town_done');
  c.objective(OBJ.rest);
}

/**
 * クローゼットの天袋：置き手紙を読んだあとの物音で板（tenbukuro_open）が中に落ち、
 * 日記（diary_book）がその上に載っている。日記は拾ったら消す。フラグと持ち物から一意に決める
 */
function syncTenbukuro(c: Ctx): void {
  const fallen = c.is('read_doc_nao_note') || c.has('diary');
  const closet = c.prop('apt_closet');
  closet.showNode('tenbukuro_open', fallen);
  closet.showNode('diary_book', fallen && !c.has('diary'));
}

/** 夕方の時計（午後5時40分）。長く遊んで時計がそれを過ぎていても、戻しはしない */
function eveningClock(c: Ctx): void {
  const t = Math.max(17 * 60 + 40, c.now.h * 60 + c.now.m);
  c.clock(Math.floor(t / 60) % 24, t % 60, 0.1);
}

/** まぶたを from → to へ（0 = 開、1 = 閉） */
async function tweenLid(c: Ctx, from: number, to: number, sec: number): Promise<void> {
  const n = Math.max(1, Math.round(sec * 40));
  for (let i = 1; i <= n; i++) {
    await c.wait(1 / 40);
    const k = i / n;
    c.lid(from + (to - from) * k * k * (3 - 2 * k));
  }
}

// ── NPC会話 ──────────────────────────────────────────────────────────────────

/** さき（張り紙を読んだ直後に自動。以降は話しかけて） */
async function sakiTalk(c: Ctx, auto: boolean): Promise<void> {
  if (c.is('talked_saki_4')) {
    await c.play('ch4.saki_again');
    return;
  }
  if (auto) await c.cutscene(() => c.lookAt(c.anchor('npc_extra_spot').add(new THREE.Vector3(0, 1.0, 0)), 0.7));
  await c.play('ch4.saki_hello');
  // QA19: さき speaks in hiragana（うた・みてる）. QA24: 「ぜんぶ」— from the first verse if he never
  // heard ハツの唄 in ch2 (doc_song_half unread)
  // 唄は1つのウィンドウで続けて出す（話者は台本の saki_song_intro の行から）
  const song = lines('ch4.saki_song_intro');
  if (!c.is('read_doc_song_half')) song.push(...lines('ch4.saki_song_first'));
  song.push(...lines('ch4.saki_song_rest'));
  await c.say(song[0].speaker ?? '', song.map((l) => l.text));
  await c.doc('doc_song_full');
  // QA16: the weak explanation (D15「手に懐中電灯」): his own face, lit from below
  await c.play('ch4.saki_after_song');
  c.set('talked_saki_4');
}

/** ハツ（任意）。2回目は残りの選択肢だけ、尽きたら結びの一言だけ */
async function hatsuTalk(c: Ctx): Promise<void> {
  const first = !c.is('hatsu_key') && !c.is('hatsu_saw');
  const opts: string[] = [];
  const keys: ('key' | 'saw')[] = [];
  if (!c.is('hatsu_key')) { opts.push(T('ch4.choice_hatsu_key')); keys.push('key'); }
  if (!c.is('hatsu_saw')) { opts.push(T('ch4.choice_hatsu_saw')); keys.push('saw'); }
  if (first) await c.play('ch4.hatsu_hello');
  if (keys.length) {
    const k = keys[await c.choice(opts)];
    if (k === 'key') {
      await c.play('ch4.hatsu_key');
      c.set('hatsu_key');
    } else {
      // QA11: what Nao is to him, in his own words
      await c.play('ch4.hatsu_saw');
      c.set('hatsu_saw');
    }
  }
  if (first || !keys.length) await c.play('ch4.hatsu_bye');
}

/** 坂口（町の数 +1）。2回目以降（QA24）：宮司から送りの作法を聞いたあとなら線香の場所、それ以外は夜勤の話 */
async function clerkTalk(c: Ctx): Promise<void> {
  if (c.is('talked_clerk_4')) {
    if (c.is('knows_rite')) await c.play('ch4.clerk_incense');
    else await c.play('ch4.clerk_night');
    return;
  }
  // QA19: no reason to suggest incense before 白瀬 has told him about the rite
  await c.play('ch4.clerk_talk');
  c.set('talked_clerk_4');
  refreshTown(c);
  await maybeTownDone(c);
}

/** 宮司・白瀬（初回は選択肢なしで最後まで必ず聞かせる。町の数 +1。2回目以降は選択肢だけ） */
async function shrineTalk(c: Ctx): Promise<void> {
  if (!c.is('talked_shrine_4')) {
    // QA19: the same local speech as ハツ（〜けん・〜とる・〜やろ・ほやけん）; no bare Kansai 〜や / 覚えとき
    await c.play('ch4.shrine_talk');
    c.set('knows_rite');
    c.set('talked_shrine_4');
    refreshTown(c);
  }
  const opts: string[] = [];
  const keys: ('coffee' | 'omamori' | 'thanks')[] = [];
  if (c.has('coffee')) { opts.push(T('ch4.choice_shrine_coffee')); keys.push('coffee'); }
  opts.push(T('ch4.choice_shrine_omamori')); keys.push('omamori');
  opts.push(T('ch4.choice_shrine_thanks')); keys.push('thanks');
  const k = keys[await c.choice(opts)];
  if (k === 'coffee') {
    c.take('coffee');
    c.toast(T('ch4.toast_coffee')); // [ITEM-:coffee]（第2章と同じ表示）
    await c.play('ch4.shrine_coffee');
  } else if (k === 'omamori') {
    await c.shop('juyosho');
  } else {
    await c.play('ch4.shrine_thanks');
  }
  await maybeTownDone(c);
}

// ── 章 ───────────────────────────────────────────────────────────────────────

export const ch4_day: ChapterDef = {
  id: 'ch4_day',
  title: T('ch4.title'),
  subtitle: T('ch4.subtitle'),
  time: 'day',
  // 寝たふりの途中で眠った（slept_ch3）なら、冷蔵庫の前に立った状態から（wakeUp なし）
  spawn: (c) => (c.is('slept_ch3') ? 'spawn_kitchen' : 'spawn_bed'),
  wakeUp: (c) => !c.is('slept_ch3'),
  clock: { h: 13, m: 10, rate: 0.1 },
  ambience: 'day_out',
  gameOverReason: T('ch4.gameover'),

  setup(c) {
    // ── 初期状態：部屋 ──
    c.power(true);
    c.lock('apt_door', true);
    c.lock('apt_door_chain', false);
    c.prop('apt_door').showNode('chain_hooked', false);
    c.prop('apt_door').showNode('chain_hanging', true);
    c.prop('apt_room_door').setOpen(1, 'panel'); // 第3章の夜から開いたまま
    if (c.is('slept_ch3') && !c.checkpointTag) {
      c.prop('apt_fridge').setOpen(1, 'door');
      c.light('apt_fridge_light').setOn(true);
      c.lid(1); // 冷蔵庫の前で、まぶたを開けるところから（intro）
    }
    c.prop('apt_fridge').showNode('memo', true); // 第1章の冷蔵庫のメモ（D02）は貼られたまま（QA17）
    c.prop('apt_lowtable').showNode('note', true); // なおの置き手紙（D12）。読んでも、テーブルに置いたまま
    syncTenbukuro(c);

    // ── 初期状態：町 ──
    c.poster('poster_3', { tex: 'poster_missing_3', visible: true }); // 町内会のお知らせ（D15）
    c.prop('shr_hokora').showNode('ash', true);
    c.prop('shr_hokora').showNode('hairpin', !c.has('hairpin'));
    c.npc('npc_neighbor', { at: 'npc_neighbor_spot', label: T('ch4.label_hatsu'), talk: () => hatsuTalk(c) });
    c.npc('npc_extra', { at: 'npc_extra_spot', label: T('ch4.label_saki'), talk: () => sakiTalk(c, false) });
    c.npc('npc_clerk', { at: 'npc_clerk_spot', talk: () => clerkTalk(c) });
    c.npc('npc_shrine', { at: 'npc_shrine_spot', talk: () => shrineTalk(c) });
    c.set('town_count', townCount(c));
    if (c.is('ch4_evening')) {
      c.time('evening');
      c.light('apt_moon').setOn(false);
      eveningClock(c);
    }

    // ── 環境音：day_out ＋ ツクツクボウシ（室内＝部屋とコンビニの中では少し遠く）／夕方は higurashi ──
    let tsuku: SoundHandle | null = c.is('ch4_evening') ? null : c.loop('tsukutsuku', { volume: 0.9 });
    let indoor: boolean | null = null;
    const isIndoor = (): boolean => c.inZone('zone_apt') || c.inZone('zone_conbini_in');
    const applyAmbience = (force = false): void => {
      const inside = isIndoor();
      if (!force && inside === indoor) return;
      indoor = inside;
      if (c.is('ch4_evening')) c.ambience('higurashi', inside ? 0.55 : 1);
      else c.ambience('day_out', inside ? 0.5 : 1);
      tsuku?.setVolume(inside ? 0.4 : 0.9, 1.5);
    };
    // 章頭のフェードインが終わってから（途中で音量を変えると上書きされるため）
    c.after(2, () => {
      applyAmbience(true);
      c.every(0.5, () => applyAmbience());
    });

    // ── インタラクト：部屋 ──
    c.on('apt_lowtable', {
      label: T('ch4.label_note'),
      use: async () => {
        const first = !c.is('read_doc_nao_note');
        await c.doc('doc_nao_note');
        if (!first) return;
        if (c.is('read_calendar')) await c.play('ch4.note_calendar_hand');
        await c.wait(1.2);
        c.sfx('thud', { at: 'apt_closet' });
        syncTenbukuro(c); // 天袋の板が、日記を載せたまま中に落ちた（戸を開けてあれば、そのまま見える）
        await c.cutscene(() => c.lookAt('apt_closet', 0.7));
        await c.play('ch4.note_closet_thud');
        c.objective(OBJ.closet);
      },
      blind: false,
    });

    c.on('apt_closet', {
      label: () => {
        if (c.is('read_doc_nao_note') && !c.has('diary')) return c.prop('apt_closet').isOpen('door_r') ? T('ch4.label_closet_check') : T('ch4.label_closet_open');
        return c.defaultLabel('apt_closet');
      },
      use: async () => {
        if (!c.is('read_doc_nao_note') || c.has('diary')) {
          await c.useDefault('apt_closet');
          return;
        }
        const closet = c.prop('apt_closet');
        syncTenbukuro(c);
        if (!closet.isOpen('door_r')) {
          c.sfx('slide_open', { at: 'apt_closet' });
          await closet.animate(1, 'door_r', 0.6);
        }
        await c.play('ch4.closet_found');
        c.give('diary');
        syncTenbukuro(c); // 拾った日記は、板の上から消す
        await c.doc('doc_diary');
        await c.play('ch4.diary_after');
        if (c.is('read_doc_notebook')) await c.play('ch4.diary_hand_known');
        else await c.play('ch4.diary_hand_unknown');
        c.objective(OBJ.mailbox);
      },
      blind: false,
    });

    c.on('apt_door', {
      label: () => (c.has('diary') ? c.defaultLabel('apt_door') : T('ch4.label_door')),
      use: async () => {
        if (!c.has('diary')) {
          await c.play('ch4.door_not_yet');
          return;
        }
        await c.useDefault('apt_door');
      },
      blind: false,
    });

    c.on('apt_tv', {
      label: T('ch4.label_tv'),
      use: async () => {
        await c.play('ch4.tv_charger');
        c.set('trace_tv');
      },
      blind: false,
    });

    c.on('apt_toilet', {
      label: T('ch4.label_toilet'),
      use: () => c.play('ch4.toilet_hair'),
      blind: false,
    });

    c.on('apt_calendar', {
      label: T('ch4.label_calendar'),
      use: async () => {
        await c.play('ch4.calendar_tomorrow');
        if (c.has('diary')) await c.play('ch4.calendar_year');
        c.set('read_calendar'); // 「1ねん」の字を見た（置き手紙の字と見比べられる）
      },
      blind: false,
    });

    // 仕事のノート（D06）。日記の最後の字と見比べられる（第2章で読んでいなくても、ここで気づける）
    c.on('apt_notebook', {
      label: T('ch4.label_notebook'),
      use: async () => {
        await c.doc('doc_notebook');
        if (c.has('diary')) await c.play('ch4.notebook_hand');
        else await c.play('ch4.notebook_due');
      },
      blind: false,
    });

    c.on('apt_phone', {
      label: T('ch4.label_phone'),
      use: () => (c.is('ch4_evening') ? c.play('ch4.phone_evening') : c.play('ch4.phone_day')),
      blind: false,
    });

    c.on('apt_bed', {
      label: () => (c.is('ch4_evening') ? T('ch4.label_bed_lie') : T('ch4.label_bed')),
      use: async () => {
        if (!c.is('ch4_evening')) {
          await c.play('ch4.bed_day');
          return;
        }
        await c.lieDown();
        await c.play('ch4.bed_sleep');
        await c.goto('ch5_night');
      },
      blind: false,
    });

    // ── インタラクト：町 ──
    c.on('ext_mailbox', {
      label: () => (c.has('diary') && !c.is('read_doc_clinic_letter') ? T('ch4.label_mailbox') : c.defaultLabel('ext_mailbox')),
      use: async () => {
        if (!c.has('diary') || c.is('read_doc_clinic_letter')) {
          await c.useDefault('ext_mailbox');
          return;
        }
        await c.doc('doc_clinic_letter');
        await c.play('ch4.clinic_letter_after');
        refreshTown(c);
        await maybeTownDone(c);
      },
      blind: false,
    });

    c.on('ext_board', {
      label: T('ch4.label_board'),
      use: async () => {
        if (c.is('town_board_4')) {
          await c.doc('doc_notice');
          await c.doc('doc_poster_shizuku');
          return;
        }
        await c.doc('doc_notice');
        await c.play('ch4.board_notice');
        await c.doc('doc_poster_shizuku');
        // QA15: why he does not call right away with his own phone
        await c.play('ch4.board_poster');
        c.give('number_memo');
        c.set('town_board_4');
        refreshTown(c);
        if (!c.is('talked_saki_4')) await sakiTalk(c, true); // 続けて、さきの会話が自動で始まる
        await maybeTownDone(c);
      },
      blind: false,
    });

    c.on('conbini_atm', {
      label: () => (c.is('atm') ? c.defaultLabel('conbini_atm') : T('ch4.label_atm')),
      use: async () => {
        if (c.is('atm')) {
          await c.useDefault('conbini_atm');
          return;
        }
        c.addMoney(1000);
        c.set('atm');
        await c.play('ch4.atm_paid');
      },
      blind: false,
    });

    c.on('shr_hokora', {
      label: () => (c.has('hairpin') ? c.defaultLabel('shr_hokora') : T('ch4.label_hokora')),
      use: async () => {
        if (c.has('hairpin')) {
          await c.useDefault('shr_hokora');
          return;
        }
        await c.play('ch4.hokora_look');
        const i = await c.choice(TL('ch4.choice_hairpin'));
        if (i === 0) {
          c.give('hairpin');
          c.prop('shr_hokora').showNode('hairpin', false);
          await c.play('ch4.hairpin_take');
        } else {
          await c.play('ch4.hairpin_leave'); // 何度でも選び直せる
        }
      },
      blind: false,
    });

    c.on('shr_ema', { label: T('ch4.label_ema'), use: () => c.doc('doc_ema'), blind: false });
    // shr_yuisho（D08）・conbini_shelf（店）・ext_vending（自販機）は既定のまま

    // ── 町 3/3 のあと、部屋に入ったら夕方（zone_apt enter 初回） ──
    const toEvening = (): void => {
      const keep = {
        kitchen: c.light('apt_light_kitchen').on,
        room: c.light('apt_light_room').on,
        bath: c.light('apt_light_bath').on,
        fridge: c.light('apt_fridge_light').on,
      };
      c.time('evening');
      // 時間帯の切り替えで部屋の照明が既定に戻らないように（夕方に月明かりは要らない）
      c.light('apt_light_kitchen').setOn(keep.kitchen);
      c.light('apt_light_room').setOn(keep.room);
      c.light('apt_light_bath').setOn(keep.bath);
      c.light('apt_fridge_light').setOn(keep.fridge);
      c.light('apt_moon').setOn(false);
      eveningClock(c);
      tsuku?.stop(3);
      tsuku = null;
      indoor = isIndoor();
      c.ambience('higurashi', indoor ? 0.55 : 1);
      const crows = c.loop('crows', { volume: 0.75 });
      c.after(14, () => crows.stop(3));
    };
    c.when(() => c.is('ch4_town_done') && !c.is('ch4_evening') && c.inZone('zone_apt'), async () => {
      c.set('ch4_evening');
      toEvening();
      c.sfx('phone_vibrate');
      await c.wait(1.2);
      // 5-0 ルール3: 目を閉じたまま入ってきたなら、開けるまで会話ウィンドウは出さない
      while (c.player.eyesClosed) await c.wait(0.1);
      await c.play('ch4.evening_message');
    });

    // 章内チェックポイントは無いが、再開時も目標はフラグから正しく出す
    if (c.checkpointTag) c.objective(currentObjective(c));
  },

  async intro(c) {
    if (c.is('slept_ch3')) {
      // 冷蔵庫の前で、はっと気がつく（開いた冷蔵庫の中をのぞきこんだ姿勢から）
      await c.cutscene(async () => {
        await c.lookAt(c.anchor('anc_fridge_inside'), 0.05);
        await c.wait(0.4);
        await tweenLid(c, 1, 0.35, 0.8);
        await tweenLid(c, 0.35, 0.7, 0.25);
        await tweenLid(c, 0.7, 0, 0.9);
      });
      c.lid(null);
      await c.play('ch4.wake_fridge');
      await c.cutscene(() => c.lookAt('apt_door', 0.9));
      await c.play('ch4.wake_fridge_door');
    } else {
      await c.play('ch4.wake_bed');
    }
    await c.cutscene(() => c.lookAt(c.prop('apt_lowtable').position.add(new THREE.Vector3(0, 0.38, 0)), 0.9));
    await c.play('ch4.wake_table');
    c.objective(currentObjective(c));
  },
};
