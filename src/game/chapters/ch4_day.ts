import * as THREE from 'three';
import type { SoundHandle } from '../../audio/AudioEngine';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';

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
  note: 'なおの置き手紙を読む',
  closet: 'クローゼットを調べる',
  mailbox: '郵便受けを見る（外廊下の集合ポスト）',
  // QA3: name what counts (the board / 坂口 / 白瀬), not just the places
  town: (n: number) => `町で話を聞く（掲示板・コンビニの店員・神社の宮司　${n}/3）`,
  rest: '部屋に戻って休む',
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
  await c.mono('今夜のために、何か買っておくなら、今のうちだ');
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
    await c.say('さき', 'あした、しゅくだい、ぜんぶやらなきゃ');
    return;
  }
  if (auto) await c.cutscene(() => c.lookAt(c.anchor('npc_extra_spot').add(new THREE.Vector3(0, 1.0, 0)), 0.7));
  await c.say('さき', ['あ、103のおにいちゃん', 'きのうもね、よる、あるいてたよ。はだしで、かいちゅうでんとう、もって']);
  await c.say('透', '……そう');
  // QA19: さき speaks in hiragana（うた・みてる）. QA24: 「ぜんぶ」— from the first verse if he never
  // heard ハツの唄 in ch2 (doc_song_half unread)
  const song = ['かおのうた、ぜんぶうたえるよ。きいて'];
  if (!c.is('read_doc_song_half')) {
    song.push(
      'ひとつ、ひとりで、めがさめて。ふたつ、ふたつで、めがあう',
      'みっつ、みられりゃ、おもてになる。よっつ、よなかの、すきまから。いつつ、いつでも、のぞいてる',
    );
  }
  song.push(
    'むっつ、むかえが、こないよう。ななつ、なんでも、ふたをして',
    'やっつ、やっぱり、あかりはけして。ここのつ、こわけりゃ、てをつなげ',
    'とお、とうとう、さいごに、め',
    '……おしまい。さいごに、めを、つぶるの',
  );
  await c.say('さき', song);
  await c.doc('doc_song_full');
  await c.mono('さいごに、め。……冷蔵庫のメモと、同じだ');
  await c.say('さき', ['あのね。しろいかおはね、おにいちゃんを、みてるんじゃないよ', 'おにいちゃんの、なかを、みてるの']);
  await c.say('透', '……なか？');
  await c.say('さき', ['うん。……それとね、かおのなかに、おにいちゃんのかおも、あったよ', 'ないしょね']);
  // QA16: the weak explanation (D15「手に懐中電灯」): his own face, lit from below
  await c.mono('……懐中電灯で、下から照らした、俺の顔か');
  c.set('talked_saki_4');
}

/** ハツ（任意）。2回目は残りの選択肢だけ、尽きたら結びの一言だけ */
async function hatsuTalk(c: Ctx): Promise<void> {
  const first = !c.is('hatsu_key') && !c.is('hatsu_saw');
  const opts: string[] = [];
  const keys: ('key' | 'saw')[] = [];
  if (!c.is('hatsu_key')) { opts.push('この部屋の鍵って、替えてないんですか'); keys.push('key'); }
  if (!c.is('hatsu_saw')) { opts.push('夜中に、何か見ませんでした？'); keys.push('saw'); }
  if (first) await c.say('ハツ', 'あら。ゆうべは眠れたん？');
  if (keys.length) {
    const k = keys[await c.choice(opts)];
    if (k === 'key') {
      await c.say('ハツ', [
        '鍵？　替えとらんよ、もったいない',
        '前の子の荷物はな、家族の人が片付けに来て……合鍵、全部返してもろたかねえ。どうやったかねえ',
      ]);
      c.set('hatsu_key');
    } else {
      await c.say('ハツ', [
        'おとといの三時前ごろな、また目が覚めて、窓から見とったら……髪の長い子が、あんたの部屋に入っていきよったよ。鍵あけて',
        'あれ、あんたの彼女やろ？　仲がええねえ',
      ]);
      // QA11: what Nao is to him, in his own words
      await c.mono(['……彼女、なのかな。そういう話は、したことがない', '……鍵を、あけて？']);
      c.set('hatsu_saw');
    }
  }
  if (first || !keys.length) await c.say('ハツ', '……あした、ちょうど一年なんよねえ。しずくちゃん');
}

/** 坂口（町の数 +1）。2回目以降（QA24）：宮司から送りの作法を聞いたあとなら線香の場所、それ以外は夜勤の話 */
async function clerkTalk(c: Ctx): Promise<void> {
  if (c.is('talked_clerk_4')) {
    if (c.is('knows_rite')) await c.say('坂口', '線香っすか？　仏壇用のなら、そこの棚にありますよ。マッチつきの');
    else await c.say('坂口', '今夜も深夜、俺っす。……人いないんで');
    return;
  }
  await c.say('坂口', 'あ、どうも。……ゆうべは来なかったっすね');
  await c.say('透', '……あの張り紙の子、知ってる？');
  await c.say('坂口', [
    '宮内さん？　知ってますよ。去年、よく夜中に来てたんで',
    'ドリンクの冷蔵庫の前で、ずーっと立ってて。で、ミルクティー一本。『お姉ちゃんが好きなの』って',
    '……あれ。お客さんと、同じだ',
  ]);
  await c.mono('……同じ');
  // QA19: no reason to suggest incense before 白瀬 has told him about the rite
  await c.say('坂口', '電池とか、今夜いるなら今のうちっすよ。夜中は品出しで、レジ遅いんで');
  c.set('talked_clerk_4');
  refreshTown(c);
  await maybeTownDone(c);
}

/** 宮司・白瀬（初回は選択肢なしで最後まで必ず聞かせる。町の数 +1。2回目以降は選択肢だけ） */
async function shrineTalk(c: Ctx): Promise<void> {
  if (!c.is('talked_shrine_4')) {
    await c.say('白瀬', 'また来たね。……顔色が、ようないな');
    await c.say('透', '……去年いなくなった子の日記を、見つけたんです。俺の部屋で');
    await c.say('白瀬', ['……宮内さんとこの、娘さんか', 'その子を、送ってやりたいんかね']);
    await c.say('透', '……送る？');
    // QA19: the same local speech as ハツ（〜けん・〜とる・〜やろ・ほやけん）; no bare Kansai 〜や / 覚えとき
    await c.say('白瀬', [
      '由緒書きにあるとおりよ。その子のもんと線香を祠に供えて、身内がひと晩、寝ずの番をする',
      '番をする者は目ぇ開けて、線香を絶やさん。送られる者は、目ぇ閉じて眠る。昔の通夜と同じよ',
      '夜の境内に入ったら、祠に着くまで目ぇ開けたらいかん。おもてさまの通り道やけん',
      '祠の前じゃ、お守りは効かん。あそこは、向こうとこっちの境目やけんな',
      '……それと、これだけは覚えとかないかんよ。連れていかれたもんは、帰ってこん。顔が、ひとつ増えるだけよ',
    ]);
    c.set('knows_rite');
    c.set('talked_shrine_4');
    refreshTown(c);
  }
  const opts: string[] = [];
  const keys: ('coffee' | 'omamori' | 'thanks')[] = [];
  if (c.has('coffee')) { opts.push('缶コーヒー、どうぞ'); keys.push('coffee'); }
  opts.push('お守りを、ください'); keys.push('omamori');
  opts.push('……ありがとうございました'); keys.push('thanks');
  const k = keys[await c.choice(opts)];
  if (k === 'coffee') {
    c.take('coffee');
    c.toast('缶コーヒー（微糖） を渡した'); // [ITEM-:coffee]（第2章と同じ表示）
    await c.say('白瀬', ['すまんね', '……去年の娘さんな。あの子は、誰かのからだを借りてでも、帰りたがっとるように見えた']);
  } else if (k === 'omamori') {
    await c.shop('juyosho');
  } else {
    await c.say('白瀬', '祠に行くんなら、拝殿の裏の林の奥よ。……昼のうちにな');
  }
  await maybeTownDone(c);
}

// ── 章 ───────────────────────────────────────────────────────────────────────

export const ch4_day: ChapterDef = {
  id: 'ch4_day',
  title: '二日目',
  subtitle: '八月三十日　午後一時十分',
  time: 'day',
  // 寝たふりの途中で眠った（slept_ch3）なら、冷蔵庫の前に立った状態から（wakeUp なし）
  spawn: (c) => (c.is('slept_ch3') ? 'spawn_kitchen' : 'spawn_bed'),
  wakeUp: (c) => !c.is('slept_ch3'),
  clock: { h: 13, m: 10, rate: 0.1 },
  ambience: 'day_out',
  gameOverReason: '白い顔と、ふたつ数えるあいだ目が合ってしまった。',

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
    c.npc('npc_neighbor', { at: 'npc_neighbor_spot', label: 'ハツさんに話しかける', talk: () => hatsuTalk(c) });
    c.npc('npc_extra', { at: 'npc_extra_spot', label: 'さきに話しかける', talk: () => sakiTalk(c, false) });
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
      label: '置き手紙を読む',
      use: async () => {
        const first = !c.is('read_doc_nao_note');
        await c.doc('doc_nao_note');
        if (!first) return;
        if (c.is('read_calendar')) await c.mono('……この字。カレンダーの「1ねん」と、同じだ');
        await c.wait(1.2);
        c.sfx('thud', { at: 'apt_closet' });
        syncTenbukuro(c); // 天袋の板が、日記を載せたまま中に落ちた（戸を開けてあれば、そのまま見える）
        await c.cutscene(() => c.lookAt('apt_closet', 0.7));
        await c.mono('……クローゼット？');
        c.objective(OBJ.closet);
      },
      blind: false,
    });

    c.on('apt_closet', {
      label: () => {
        if (c.is('read_doc_nao_note') && !c.has('diary')) return c.prop('apt_closet').isOpen('door_r') ? 'クローゼットを調べる' : 'クローゼットを開ける';
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
        await c.mono(['天袋の板が外れて、落ちてる', 'その上に、ノートが一冊']);
        c.give('diary');
        syncTenbukuro(c); // 拾った日記は、板の上から消す
        await c.doc('doc_diary');
        await c.mono([
          '去年の七月から、八月三十日まで。……しずく。張り紙の子だ',
          'それから白紙が続いて――字が、変わる',
          '八月三十日。……ゆうべだ',
        ]);
        if (c.is('read_doc_notebook')) await c.mono('「め」の終わりが、丸まってる。……俺の、字だ');
        else await c.mono('「め」の終わりが、くるっと丸まってる。……どこかで見た字だ');
        c.objective(OBJ.mailbox);
      },
      blind: false,
    });

    c.on('apt_door', {
      label: () => (c.has('diary') ? c.defaultLabel('apt_door') : '玄関のドア'),
      use: async () => {
        if (!c.has('diary')) {
          await c.mono('先に、部屋の中を確かめよう');
          return;
        }
        await c.useDefault('apt_door');
      },
      blind: false,
    });

    c.on('apt_tv', {
      label: 'テレビ台の裏を見る',
      use: async () => {
        await c.mono(['見覚えのない白い充電器が、ささってる', '……なおの？']);
        c.set('trace_tv');
      },
      blind: false,
    });

    c.on('apt_toilet', {
      label: 'トイレを見る',
      use: () => c.mono('タンクのふたの上に、長い髪の毛が一本'),
      blind: false,
    });

    c.on('apt_calendar', {
      label: 'カレンダーを見る',
      use: async () => {
        await c.mono('31日。……明日だ。「1ねん」');
        if (c.has('diary')) await c.mono('しずくがいなくなって、ちょうど一年');
        c.set('read_calendar'); // 「1ねん」の字を見た（置き手紙の字と見比べられる）
      },
      blind: false,
    });

    // 仕事のノート（D06）。日記の最後の字と見比べられる（第2章で読んでいなくても、ここで気づける）
    c.on('apt_notebook', {
      label: 'ノートを見る',
      use: async () => {
        await c.doc('doc_notebook');
        if (c.has('diary')) await c.mono(['納品は、あした', '「め」の終わりを、くるりと丸める癖。……日記の最後のほうと、同じ字だ']);
        else await c.mono('納品は31日。……あしただ');
      },
      blind: false,
    });

    c.on('apt_phone', {
      label: 'スマホを見る',
      use: () =>
        c.mono(c.is('ch4_evening')
          ? 'なおから。『今夜は行けない。ごめん。ちゃんと寝てね』'
          : 'なおから。『ちゃんと眠れた？』……返す言葉が、見つからない'),
      blind: false,
    });

    c.on('apt_bed', {
      label: () => (c.is('ch4_evening') ? '横になる' : 'ベッド'),
      use: async () => {
        if (!c.is('ch4_evening')) {
          await c.mono('まだ昼だ');
          return;
        }
        await c.lieDown();
        await c.narrate('あしたで、ちょうど一年。');
        await c.goto('ch5_night');
      },
      blind: false,
    });

    // ── インタラクト：町 ──
    c.on('ext_mailbox', {
      label: () => (c.has('diary') && !c.is('read_doc_clinic_letter') ? '郵便受けを見る' : c.defaultLabel('ext_mailbox')),
      use: async () => {
        if (!c.has('diary') || c.is('read_doc_clinic_letter')) {
          await c.useDefault('ext_mailbox');
          return;
        }
        await c.doc('doc_clinic_letter');
        await c.say('透', [
          '睡眠時遊行症。……夢遊病',
          '短い文字を書く。電話をかける',
          '病気。……そうか、病気なんだ',
          'じゃあ、顔も',
        ]);
        await c.mono('安堵とも、諦めともつかない声が出た');
        refreshTown(c);
        await maybeTownDone(c);
      },
      blind: false,
    });

    c.on('ext_board', {
      label: '張り紙を読む',
      use: async () => {
        if (c.is('town_board_4')) {
          await c.doc('doc_notice');
          await c.doc('doc_poster_shizuku');
          return;
        }
        await c.doc('doc_notice');
        await c.mono(['灰色のTシャツに、紺のハーフパンツ。……今、俺が着てる服だ', '夜回りは、今年はやってない？']);
        await c.doc('doc_poster_shizuku');
        await c.mono([
          '宮内しずく。家族、宮内……',
          '……そういえば俺、なおの名字を知らない',
          '日記を、家族に返さなきゃ。番号を控えておこう',
          // QA15: why he does not call right away with his own phone
          '……電話は、夜、落ち着いてからにしよう',
        ]);
        c.give('number_memo');
        c.set('town_board_4');
        refreshTown(c);
        if (!c.is('talked_saki_4')) await sakiTalk(c, true); // 続けて、さきの会話が自動で始まる
        await maybeTownDone(c);
      },
      blind: false,
    });

    c.on('conbini_atm', {
      label: () => (c.is('atm') ? c.defaultLabel('conbini_atm') : 'お金をおろす'),
      use: async () => {
        if (c.is('atm')) {
          await c.useDefault('conbini_atm');
          return;
        }
        c.addMoney(1000);
        c.set('atm');
        await c.mono('文字起こしの報酬が、入ってた');
      },
      blind: false,
    });

    c.on('shr_hokora', {
      label: () => (c.has('hairpin') ? c.defaultLabel('shr_hokora') : '祠を見る'),
      use: async () => {
        if (c.has('hairpin')) {
          await c.useDefault('shr_hokora');
          return;
        }
        await c.mono(['線香の燃えかす。……それと', 'ひまわりのヘアピン。……新しい', '一年前のものにしては、新しすぎる']);
        const i = await c.choice(['持っていく', 'そのままにしておく']);
        if (i === 0) {
          c.give('hairpin');
          c.prop('shr_hokora').showNode('hairpin', false);
          await c.mono('……あの子の家族に、返そう。日記と一緒に');
        } else {
          await c.mono('……'); // 何度でも選び直せる
        }
      },
      blind: false,
    });

    c.on('shr_ema', { label: '絵馬を見る', use: () => c.doc('doc_ema'), blind: false });
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
      await c.mono('なおから。『今夜は行けない。ごめん。ちゃんと寝てね』');
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
      await c.mono(['……冷蔵庫の前に、立ってた', '扉が開けっぱなしだ。手に、麦茶のボトル', 'なおは？　……いない']);
      await c.cutscene(() => c.lookAt('apt_door', 0.9));
      await c.mono(['玄関の鍵は、かかってる。チェーンは外れてる', 'なおが出ていったのに、鍵が、かかってる？']);
    } else {
      await c.mono(['……少しは、眠れたのか', '外から鍵のかかる音が、まだ耳に残ってる']);
    }
    await c.cutscene(() => c.lookAt(c.prop('apt_lowtable').position.add(new THREE.Vector3(0, 0.38, 0)), 0.9));
    await c.mono('テーブルに、紙が置いてある');
    c.objective(currentObjective(c));
  },
};
