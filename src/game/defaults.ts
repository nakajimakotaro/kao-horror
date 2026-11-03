import type { Ctx } from './Ctx';
import type { InteractDef } from './Interaction';
import { DOCS } from './content/docs';
import { SHOPS } from './content/shops';

// World default interactions. Chapters override any of these with c.on(id, …)
// and can still call c.useDefault(id) to reuse the mechanical part (opening
// a door, flipping a switch…).

const look = (c: Ctx, label: string, text: string | string[]): InteractDef => ({ label, use: () => c.mono(text) });

function toggler(c: Ctx, propId: string, part: string | undefined, names: [string, string], sounds: [string, string] = ['door_open', 'door_close'], sec = 0.6): InteractDef {
  return {
    label: () => (c.prop(propId).isOpen(part) ? names[1] : names[0]),
    use: async () => {
      const p = c.prop(propId);
      const opening = !p.isOpen(part);
      c.sfx(opening ? sounds[0] : sounds[1], { at: propId });
      await p.animate(opening ? 1 : 0, part, sec);
    },
  };
}

function lightSwitch(c: Ctx, propId: string, lightId: string): InteractDef {
  return {
    label: '電気のスイッチを押す',
    use: async () => {
      const sw = c.prop(propId);
      c.sfx('switch_click', { at: propId });
      void sw.animate(sw.isOpen() ? 0 : 1, undefined, 0.08);
      if (!c.hasPower) {
        await c.mono('カチッ……。つかない。');
        return;
      }
      const l = c.light(lightId);
      l.setOn(!l.on);
    },
  };
}

export function buildDefaults(c: Ctx, id: string): InteractDef | null {
  switch (id) {
    // ── apartment ──
    case 'apt_fridge':
      return {
        label: () => (c.prop('apt_fridge').isOpen('door') ? '冷蔵庫を閉める' : '冷蔵庫を開ける'),
        use: async () => {
          const p = c.prop('apt_fridge');
          const opening = !p.isOpen('door');
          c.sfx(opening ? 'fridge_open' : 'fridge_close', { at: 'apt_fridge' });
          if (opening) c.light('apt_fridge_light').setOn(true);
          await p.animate(opening ? 1 : 0, 'door', 0.55);
          if (!opening) c.light('apt_fridge_light').setOn(false);
        },
      };
    case 'apt_microwave':
      return { label: '電子レンジを見る', use: () => c.mono('電子レンジの時計が光っている。……こんな時間か。') };
    case 'apt_kitchen_drawer':
      return toggler(c, 'apt_kitchen_counter', 'drawer', ['引き出しを開ける', '引き出しを閉める'], ['drawer_open', 'drawer_close'], 0.35);
    case 'apt_washer':
      return toggler(c, 'apt_washer', 'lid', ['洗濯機のふたを開ける', 'ふたを閉める'], ['lid_open', 'lid_close'], 0.5);
    case 'apt_shoebox':
      return {
        label: () => (c.prop('apt_shoebox').isOpen('door_l') ? '靴箱を閉める' : '靴箱を開ける'),
        use: async () => {
          const p = c.prop('apt_shoebox');
          const o = !p.isOpen('door_l');
          c.sfx(o ? 'cabinet_open' : 'cabinet_close', { at: 'apt_shoebox' });
          await Promise.all([p.animate(o ? 1 : 0, 'door_l', 0.5), p.animate(o ? 1 : 0, 'door_r', 0.5)]);
        },
      };
    case 'apt_breaker':
      return {
        label: () => (c.prop('apt_breaker').isOpen('cover') ? 'ブレーカーを調べる' : '分電盤のフタを開ける'),
        use: async () => {
          const p = c.prop('apt_breaker');
          if (!p.isOpen('cover')) {
            c.sfx('cabinet_open', { at: 'apt_breaker' });
            await p.open('cover', 0.4);
            return;
          }
          await c.mono(c.hasPower ? 'ブレーカーは全部上がっている。' : 'ブレーカーが落ちている……？');
        },
      };
    case 'apt_switch_kitchen':
      return lightSwitch(c, 'apt_switch_kitchen', 'apt_light_kitchen');
    case 'apt_switch_room':
      return lightSwitch(c, 'apt_switch_room', 'apt_light_room');
    case 'apt_door':
      return {
        label: () => (c.prop('apt_door').isOpen() ? 'ドアを閉める' : '玄関のドア'),
        use: async () => {
          const door = c.prop('apt_door');
          if (door.isOpen()) {
            c.sfx('door_close', { at: 'apt_door' });
            await door.close('leaf', 0.7);
            return;
          }
          const locked = c.isLocked('apt_door');
          const chain = c.isLocked('apt_door_chain');
          const opts = ['覗き穴を見る', locked ? '鍵を開ける' : '鍵をかける', chain ? 'チェーンを外す' : 'チェーンをかける', 'ドアを開ける', 'やめる'];
          const i = await c.choice(opts);
          if (i === 0) await c.peephole();
          else if (i === 1) { c.sfx('door_lock', { at: 'apt_door' }); c.lock('apt_door', !locked); }
          else if (i === 2) {
            c.sfx('chain', { at: 'apt_door' });
            c.lock('apt_door_chain', !chain);
            door.showNode('chain_hooked', !chain);
            door.showNode('chain_hanging', chain);
          } else if (i === 3) {
            if (locked) await c.mono('鍵がかかっている。');
            else if (chain) { c.sfx('chain_rattle', { at: 'apt_door' }); await c.mono('チェーンがかかっていて開かない。'); }
            else { c.sfx('door_open', { at: 'apt_door' }); await door.open('leaf', 0.9); }
          }
        },
      };
    case 'apt_bath_door':
      return toggler(c, 'apt_bath_door', 'leaf', ['ユニットバスの扉を開ける', '扉を閉める']);
    case 'apt_room_door':
      return toggler(c, 'apt_room_door', 'panel', ['引き戸を開ける', '引き戸を閉める'], ['slide_open', 'slide_close'], 0.5);
    case 'apt_window':
      return {
        label: () => (c.prop('apt_window').isOpen('pane_r') ? '窓を閉める' : '窓を開ける'),
        use: async () => {
          if (!c.prop('apt_curtain').isOpen('curtain_l')) { await c.mono('カーテンが閉まっている。'); return; }
          const p = c.prop('apt_window');
          const o = !p.isOpen('pane_r');
          c.sfx(o ? 'window_open' : 'window_close', { at: 'apt_window' });
          await p.animate(o ? 1 : 0, 'pane_r', 0.8);
        },
      };
    case 'apt_curtain':
      return {
        label: () => (c.prop('apt_curtain').isOpen('curtain_l') ? 'カーテンを閉める' : 'カーテンを開ける'),
        use: async () => {
          const p = c.prop('apt_curtain');
          const o = !p.isOpen('curtain_l');
          c.sfx('curtain', { at: 'apt_curtain' });
          await Promise.all([p.animate(o ? 1 : 0, 'curtain_l', 0.8), p.animate(o ? 1 : 0, 'curtain_r', 0.8)]);
        },
      };
    case 'apt_toilet':
      return toggler(c, 'apt_toilet', 'lid', ['トイレのふたを開ける', 'ふたを閉める'], ['lid_open', 'lid_close'], 0.5);
    case 'apt_bath_mirror':
      return look(c, '鏡を見る', '鏡に映った自分の顔。……ひどい顔だ。');
    case 'apt_bathtub':
      return look(c, '浴槽を見る', '空っぽの浴槽。乾いている。');
    case 'apt_shower_curtain':
      return toggler(c, 'apt_shower_curtain', 'curtain', ['シャワーカーテンを開ける', 'シャワーカーテンを閉める'], ['curtain', 'curtain'], 0.6);
    case 'apt_desk':
      return toggler(c, 'apt_desk', 'drawer', ['机の引き出しを開ける', '引き出しを閉める'], ['drawer_open', 'drawer_close'], 0.35);
    case 'apt_tv':
      return {
        label: 'テレビをつける／消す',
        use: async () => {
          const on = c.game.world.light('apt_tv_light').on;
          c.sfx('tv_on', { at: 'apt_tv' });
          c.tv(on ? 'off' : 'on');
        },
      };
    case 'apt_lowtable':
      return look(c, 'テーブルを見る', '飲みかけの缶チューハイと、リモコン。');
    case 'apt_phone':
      return look(c, 'スマホを見る', 'スマホ。……画面がつかない。充電が切れている。');
    case 'apt_bed':
      return look(c, 'ベッド', '今は、眠れない。');
    case 'apt_closet':
      return toggler(c, 'apt_closet', 'door_r', ['クローゼットを開ける', 'クローゼットを閉める'], ['slide_open', 'slide_close'], 0.6);
    case 'apt_photo':
      return look(c, '写真立てを見る', '写真立て。');
    case 'apt_trash':
      return look(c, 'ゴミ箱を見る', '丸めたレシートやティッシュが入っている。');
    case 'apt_calendar':
      return look(c, 'カレンダーを見る', '八月のカレンダー。');
    case 'apt_ac':
      return look(c, 'エアコンを見る', 'エアコン。……止まっている。');
    case 'apt_medicine':
      return look(c, '薬の袋を見る', '薬の袋だ。');
    case 'apt_notebook':
      return look(c, 'ノートを見る', 'ノートだ。');
    case 'apt_ac_outdoor':
      return look(c, '室外機を見る', 'エアコンの室外機。');
    // ── outside ──
    case 'ext_mailbox':
      return look(c, '集合ポストを見る', '集合ポスト。103のポストはチラシでいっぱいだ。');
    case 'ext_vending':
      return SHOPS.vending
        ? { label: '自販機で飲み物を買う', use: () => c.shop('vending') }
        : look(c, '自販機を見る', '自販機が白く光っている。');
    case 'ext_board':
      return look(c, '掲示板を見る', '町内会の掲示板だ。');
    case 'ext_curve_mirror':
      return look(c, 'カーブミラーを見る', 'カーブミラーに、ゆがんだ通りが映っている。');
    case 'ext_garbage':
      return look(c, 'ゴミ捨て場を見る', 'ゴミ捨て場。カラスよけのネットがかかっている。');
    case 'ext_phonebooth':
      return look(c, '公衆電話を見る', '公衆電話。まだあったのか。');
    case 'ext_barrier':
      return look(c, 'バリケードを見る', '工事中で通行止めだ。この先には行けない。');
    case 'ext_door_101':
    case 'ext_door_102':
    case 'ext_door_104':
      return look(c, 'ドアを見る', '他の部屋のドアだ。');
    // ── convenience store ──
    case 'conbini_shelf':
      return SHOPS.conbini ? { label: '商品を見る', use: () => c.shop('conbini') } : null;
    case 'conbini_counter': {
      const clerk = c.game.world.npcs.get('npc_clerk');
      const talk = clerk?.visible ? c.game.interaction.defs.get('npc_clerk') : undefined;
      if (talk) return { label: '店員に話しかける', use: () => talk.use(), blind: false };
      return look(c, 'レジ', '店員の姿が見えない。');
    }
    case 'conbini_fridge':
      return look(c, '冷蔵ケースを見る', 'ドリンクがずらりと並んでいる。');
    case 'conbini_magazine':
      return look(c, '雑誌棚を見る', '週刊誌の表紙に「真夏の怪奇特集」の文字。');
    case 'conbini_atm':
      return look(c, 'ATMを見る', 'ATM。残高は、見ないことにした。');
    // ── shrine ──
    case 'shr_saisen':
      return {
        label: 'お参りする',
        use: async () => {
          if (c.money >= 5) { c.addMoney(-5); c.sfx('coin', { at: 'shr_saisen' }); await c.wait(0.5); }
          c.sfx('shrine_bell', { at: 'anc_haiden' });
          await c.wait(1.0);
          c.sfx('clap'); await c.wait(0.45); c.sfx('clap');
          await c.wait(0.8);
          await c.mono('……手を合わせた。');
        },
      };
    case 'shr_chozuya':
      return { label: '手を清める', use: async () => { c.sfx('water_ladle', { at: 'shr_chozuya' }); await c.wait(0.8); await c.mono('冷たい水で手を清めた。'); } };
    case 'shr_ema':
      return look(c, '絵馬を見る', 'たくさんの絵馬が掛かっている。');
    case 'shr_yuisho':
      return DOCS.doc_yuisho ? { label: '由緒書きを読む', use: () => c.doc('doc_yuisho') } : look(c, '由緒書きを読む', '神社の由緒が書かれている。');
    case 'shr_komainu':
      return look(c, '狛犬を見る', '狛犬が、こちらをにらんでいる。');
    case 'shr_haiden':
      return look(c, '拝殿を見る', '古い拝殿。格子戸は閉まっている。');
    case 'shr_shinboku':
      return look(c, '御神木を見る', '大きな御神木。しめ縄が巻かれている。');
    case 'shr_hokora':
      return look(c, '祠を見る', '林の奥の、小さな祠。');
    case 'shr_kura':
      return look(c, '蔵を見る', '古い蔵。重い錠前がかかっている。');
  }
  return null;
}
