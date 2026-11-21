import type { Ctx } from './Ctx';
import type { InteractDef } from './Interaction';
import { DOCS } from './content/docs';
import { SHOPS } from './content/shops';
import { T } from '../script';

// 文言は台本 script/common.nani。
// World default interactions. Chapters override any of these with c.on(id, …)
// and can still call c.useDefault(id) to reuse the mechanical part (opening
// a door, flipping a switch…).

/** 見るだけの物: label = 表示する文字列、key = 調べたときの台本のブロック */
const look = (c: Ctx, label: string, key: string): InteractDef => ({ label, use: () => c.play(key) });

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
    label: T('common.switch.label'),
    use: async () => {
      const sw = c.prop(propId);
      c.sfx('switch_click', { at: propId });
      void sw.animate(sw.isOpen() ? 0 : 1, undefined, 0.08);
      if (!c.hasPower) {
        await c.play('common.switch.no_power');
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
        label: () => (c.prop('apt_fridge').isOpen('door') ? T('common.apt_fridge.label_close') : T('common.apt_fridge.label_open')),
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
      return { label: T('common.apt_microwave.label'), use: () => c.play('common.apt_microwave') };
    case 'apt_kitchen_drawer':
      return toggler(c, 'apt_kitchen_counter', 'drawer', [T('common.apt_kitchen_drawer.label_open'), T('common.apt_kitchen_drawer.label_close')], ['drawer_open', 'drawer_close'], 0.35);
    case 'apt_washer':
      return toggler(c, 'apt_washer', 'lid', [T('common.apt_washer.label_open'), T('common.apt_washer.label_close')], ['lid_open', 'lid_close'], 0.5);
    case 'apt_shoebox':
      return {
        label: () => (c.prop('apt_shoebox').isOpen('door_l') ? T('common.apt_shoebox.label_close') : T('common.apt_shoebox.label_open')),
        use: async () => {
          const p = c.prop('apt_shoebox');
          const o = !p.isOpen('door_l');
          c.sfx(o ? 'cabinet_open' : 'cabinet_close', { at: 'apt_shoebox' });
          await Promise.all([p.animate(o ? 1 : 0, 'door_l', 0.5), p.animate(o ? 1 : 0, 'door_r', 0.5)]);
        },
      };
    case 'apt_breaker':
      return {
        label: () => (c.prop('apt_breaker').isOpen('cover') ? T('common.apt_breaker.label_check') : T('common.apt_breaker.label_open')),
        use: async () => {
          const p = c.prop('apt_breaker');
          if (!p.isOpen('cover')) {
            c.sfx('cabinet_open', { at: 'apt_breaker' });
            await p.open('cover', 0.4);
            return;
          }
          await c.play(c.hasPower ? 'common.apt_breaker.all_up' : 'common.apt_breaker.tripped');
        },
      };
    case 'apt_switch_kitchen':
      return lightSwitch(c, 'apt_switch_kitchen', 'apt_light_kitchen');
    case 'apt_switch_room':
      return lightSwitch(c, 'apt_switch_room', 'apt_light_room');
    case 'apt_door':
      return {
        label: () => (c.prop('apt_door').isOpen() ? T('common.apt_door.label_close') : T('common.apt_door.label')),
        use: async () => {
          const door = c.prop('apt_door');
          if (door.isOpen()) {
            c.sfx('door_close', { at: 'apt_door' });
            await door.close('leaf', 0.7);
            return;
          }
          const locked = c.isLocked('apt_door');
          const chain = c.isLocked('apt_door_chain');
          const opts = [T('common.apt_door.choice_peephole'), locked ? T('common.apt_door.choice_unlock') : T('common.apt_door.choice_lock'), chain ? T('common.apt_door.choice_unchain') : T('common.apt_door.choice_chain'), T('common.apt_door.choice_open'), T('common.apt_door.choice_cancel')];
          const i = await c.choice(opts);
          if (i === 0) await c.peephole();
          else if (i === 1) { c.sfx('door_lock', { at: 'apt_door' }); c.lock('apt_door', !locked); }
          else if (i === 2) {
            c.sfx('chain', { at: 'apt_door' });
            c.lock('apt_door_chain', !chain);
            door.showNode('chain_hooked', !chain);
            door.showNode('chain_hanging', chain);
          } else if (i === 3) {
            if (locked) await c.play('common.apt_door.locked');
            else if (chain) { c.sfx('chain_rattle', { at: 'apt_door' }); await c.play('common.apt_door.chained'); }
            else { c.sfx('door_open', { at: 'apt_door' }); await door.open('leaf', 0.9); }
          }
        },
      };
    case 'apt_bath_door':
      return toggler(c, 'apt_bath_door', 'leaf', [T('common.apt_bath_door.label_open'), T('common.apt_bath_door.label_close')]);
    case 'apt_room_door':
      return toggler(c, 'apt_room_door', 'panel', [T('common.apt_room_door.label_open'), T('common.apt_room_door.label_close')], ['slide_open', 'slide_close'], 0.5);
    case 'apt_window':
      return {
        label: () => (c.prop('apt_window').isOpen('pane_r') ? T('common.apt_window.label_close') : T('common.apt_window.label_open')),
        use: async () => {
          if (!c.prop('apt_curtain').isOpen('curtain_l')) { await c.play('common.apt_window.curtain_closed'); return; }
          const p = c.prop('apt_window');
          const o = !p.isOpen('pane_r');
          c.sfx(o ? 'window_open' : 'window_close', { at: 'apt_window' });
          await p.animate(o ? 1 : 0, 'pane_r', 0.8);
        },
      };
    case 'apt_curtain':
      return {
        label: () => (c.prop('apt_curtain').isOpen('curtain_l') ? T('common.apt_curtain.label_close') : T('common.apt_curtain.label_open')),
        use: async () => {
          const p = c.prop('apt_curtain');
          const o = !p.isOpen('curtain_l');
          c.sfx('curtain', { at: 'apt_curtain' });
          await Promise.all([p.animate(o ? 1 : 0, 'curtain_l', 0.8), p.animate(o ? 1 : 0, 'curtain_r', 0.8)]);
        },
      };
    case 'apt_toilet':
      return toggler(c, 'apt_toilet', 'lid', [T('common.apt_toilet.label_open'), T('common.apt_toilet.label_close')], ['lid_open', 'lid_close'], 0.5);
    case 'apt_bath_mirror':
      return look(c, T('common.apt_bath_mirror.label'), 'common.apt_bath_mirror');
    case 'apt_bathtub':
      return look(c, T('common.apt_bathtub.label'), 'common.apt_bathtub');
    case 'apt_shower_curtain':
      return toggler(c, 'apt_shower_curtain', 'curtain', [T('common.apt_shower_curtain.label_open'), T('common.apt_shower_curtain.label_close')], ['curtain', 'curtain'], 0.6);
    case 'apt_desk':
      return toggler(c, 'apt_desk', 'drawer', [T('common.apt_desk.label_open'), T('common.apt_desk.label_close')], ['drawer_open', 'drawer_close'], 0.35);
    case 'apt_tv':
      return {
        label: T('common.apt_tv.label'),
        use: async () => {
          const on = c.game.world.light('apt_tv_light').on;
          c.sfx('tv_on', { at: 'apt_tv' });
          c.tv(on ? 'off' : 'on');
        },
      };
    case 'apt_lowtable':
      return look(c, T('common.apt_lowtable.label'), 'common.apt_lowtable');
    case 'apt_phone':
      return look(c, T('common.apt_phone.label'), 'common.apt_phone');
    case 'apt_bed':
      return look(c, T('common.apt_bed.label'), 'common.apt_bed');
    case 'apt_closet':
      return toggler(c, 'apt_closet', 'door_r', [T('common.apt_closet.label_open'), T('common.apt_closet.label_close')], ['slide_open', 'slide_close'], 0.6);
    case 'apt_photo':
      return look(c, T('common.apt_photo.label'), 'common.apt_photo');
    case 'apt_trash':
      return look(c, T('common.apt_trash.label'), 'common.apt_trash');
    case 'apt_calendar':
      return look(c, T('common.apt_calendar.label'), 'common.apt_calendar');
    case 'apt_ac':
      return look(c, T('common.apt_ac.label'), 'common.apt_ac');
    case 'apt_medicine':
      return look(c, T('common.apt_medicine.label'), 'common.apt_medicine');
    case 'apt_notebook':
      return look(c, T('common.apt_notebook.label'), 'common.apt_notebook');
    case 'apt_ac_outdoor':
      return look(c, T('common.apt_ac_outdoor.label'), 'common.apt_ac_outdoor');
    // ── outside ──
    case 'ext_mailbox':
      return look(c, T('common.ext_mailbox.label'), 'common.ext_mailbox');
    case 'ext_vending':
      return SHOPS.vending
        ? { label: T('common.ext_vending.label_buy'), use: () => c.shop('vending') }
        : look(c, T('common.ext_vending.label'), 'common.ext_vending');
    case 'ext_board':
      return look(c, T('common.ext_board.label'), 'common.ext_board');
    case 'ext_curve_mirror':
      return look(c, T('common.ext_curve_mirror.label'), 'common.ext_curve_mirror');
    case 'ext_garbage':
      return look(c, T('common.ext_garbage.label'), 'common.ext_garbage');
    case 'ext_phonebooth':
      return look(c, T('common.ext_phonebooth.label'), 'common.ext_phonebooth');
    case 'ext_barrier':
      return look(c, T('common.ext_barrier.label'), 'common.ext_barrier');
    case 'ext_door_101':
    case 'ext_door_102':
    case 'ext_door_104':
      return look(c, T('common.ext_door.label'), 'common.ext_door');
    // ── convenience store ──
    case 'conbini_shelf':
      return SHOPS.conbini ? { label: T('common.conbini_shelf.label'), use: () => c.shop('conbini') } : null;
    case 'conbini_counter': {
      const clerk = c.game.world.npcs.get('npc_clerk');
      const talk = clerk?.visible ? c.game.interaction.defs.get('npc_clerk') : undefined;
      if (talk) return { label: T('common.conbini_counter.label_talk'), use: () => talk.use(), blind: false };
      return look(c, T('common.conbini_counter.label'), 'common.conbini_counter');
    }
    case 'conbini_fridge':
      return look(c, T('common.conbini_fridge.label'), 'common.conbini_fridge');
    case 'conbini_magazine':
      return look(c, T('common.conbini_magazine.label'), 'common.conbini_magazine');
    case 'conbini_atm':
      return look(c, T('common.conbini_atm.label'), 'common.conbini_atm');
    // ── shrine ──
    case 'shr_saisen':
      return {
        label: T('common.shr_saisen.label'),
        use: async () => {
          if (c.money >= 5) { c.addMoney(-5); c.sfx('coin', { at: 'shr_saisen' }); await c.wait(0.5); }
          c.sfx('shrine_bell', { at: 'anc_haiden' });
          await c.wait(1.0);
          c.sfx('clap'); await c.wait(0.45); c.sfx('clap');
          await c.wait(0.8);
          await c.play('common.shr_saisen');
        },
      };
    case 'shr_chozuya':
      return { label: T('common.shr_chozuya.label'), use: async () => { c.sfx('water_ladle', { at: 'shr_chozuya' }); await c.wait(0.8); await c.play('common.shr_chozuya'); } };
    case 'shr_ema':
      return look(c, T('common.shr_ema.label'), 'common.shr_ema');
    case 'shr_yuisho':
      return DOCS.doc_yuisho ? { label: T('common.shr_yuisho.label'), use: () => c.doc('doc_yuisho') } : look(c, T('common.shr_yuisho.label'), 'common.shr_yuisho');
    case 'shr_komainu':
      return look(c, T('common.shr_komainu.label'), 'common.shr_komainu');
    case 'shr_haiden':
      return look(c, T('common.shr_haiden.label'), 'common.shr_haiden');
    case 'shr_shinboku':
      return look(c, T('common.shr_shinboku.label'), 'common.shr_shinboku');
    case 'shr_hokora':
      return look(c, T('common.shr_hokora.label'), 'common.shr_hokora');
    case 'shr_kura':
      return look(c, T('common.shr_kura.label'), 'common.shr_kura');
  }
  return null;
}
