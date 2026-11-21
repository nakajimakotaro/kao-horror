import * as THREE from 'three';
import type { SoundHandle } from '../../audio/AudioEngine';
import type { ChapterDef } from '../Chapter';
import { T } from '../../script';
import type { Ctx } from '../Ctx';

// ─────────────────────────────────────────────────────────────────────────────
//  第1章　ch1_night「一日目　午前三時」（docs/SCENARIO.md §5 第1章）
//
//  章内の状態はすべてフラグで持ち、setup がフラグから世界を組み直す
//  （章頭 / ch1_flashlight / ch1_power のどこから再開しても同じ見た目になる）。
//  目標表示は objectiveText() がフラグから毎回求める（順番を飛ばしても巻き戻らない）。
//
//  シナリオのフラグ: tried_switch, drawer_checked, got_flashlight, saw_breaker, tape_peeled,
//  power_tripped, water_found, faucet_off, plug_out, power_on, gap_phase, gap_toilet,
//  gap_mirror, gap_closet, gap_curtain, gap_fridge, fridge_reopened（+ read_doc_memo_*）
//  章内の補助フラグ（ch1_ 接頭辞）: ch1_fridge_opened, ch1_f11_spawned, ch1_f11_gone,
//  ch1_washer_lid_closed, ch1_f14_spawned, ch1_f15_spawned, ch1_f16_seen, ch1_face_seen,
//  ch1_corridor_done, ch1_street_done, ch1_phone_charged, ch1_clerk_met, ch1_blackout_hint
//  後の章に渡すフラグ（QA#24 用。第2章が読んで台詞を分岐する）: went_out_ch1, visited_conbini_ch1,
//  ch1_chain_at_bed（寝たときチェーンがかかっていたか）, ch1_phone_charged（第2章冒頭のスマホ）
//
//  QAレビュー（critique.json）への対応:
//   #1  蛇口は漏電の前でも閉められる（water_found も立つ。目標は進めない）。洗濯機のプラグは
//       漏電のあと〔water_found または faucet_off〕で抜ける。先に閉めていた場合は漏電後の独白を差し替える
//   #2  分電盤は懐中電灯を取るまで（暗くて、よく見えない）。目標はフラグから計算するので巻き戻らない
//   #4  冷蔵庫の再開封は「gap_phase 中に冷蔵庫以外が3つ以上」になった時点で（メモ直後も含めて）一度だけ
//   #5  どの顔でも「最初に見た顔」なら［顔から目をそらす］を出す。外階段の顔はやめた（#20）
//   #20 F1-1/4/5 は予兆（音・明滅）を挟んでから出す。F1-6 はカーブミラーの fleeting（外廊下は足音だけ）
//   #21 致死の顔は lethal 2。F1-2 だけ初見救済で 3.5（反射閉眼つき）。F1-1/F1-6 は構造上死なない
//   #22 シャワーカーテン越しでも「蛇口を閉める」。洗濯機・浴槽の顔は縁より上に出し、冷蔵庫・クローゼットの
//       顔は owner:null（側面ごしに見えない顔の凝視が進まない）。レンジの表示は消灯/点滅
//  ほか: 懐中電灯を取る練習中はキッチンなら c.blindTarget で閉眼中に必ず取れる。共通ルール3は keepEyes()
// ─────────────────────────────────────────────────────────────────────────────

/** extras.ts が作る小道具（layout.ts には無いので validate の対象外。実行時には存在する） */
const FLOOR_WATER = 'apt_floor_water';

/** クローゼット右戸の「少し開けた」開度。0.15 だと実寸5cmで顔が見えないので、半分のぞく幅にする */
const CLOSET_GAP = 0.3;
/** シャワーカーテンの「3割開き」（scaleZ のイージング込みで実寸およそ3割。南端 z≈9.07〜9.55 が隙間） */
const SHOWER_GAP = 0.4;

// ── 電子レンジの時計（漏電で消える → 復旧後は「0:00」が点滅）。update() で毎フレーム上書きする ──
let mwMode: 'clock' | 'off' | 'blink' = 'clock';
let mwKey = '';
let mwT = 0;

function drawMicrowave(c: Ctx, text: string | null): void {
  const lib = c.game.textures;
  const cv = lib.canvas('mw_display');
  const g = cv?.getContext('2d');
  if (!cv || !g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#020604';
  g.fillRect(0, 0, cv.width, cv.height);
  if (text) {
    g.fillStyle = '#5dff9a';
    g.font = 'bold 18px "DotGothic16", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cv.width / 2, cv.height / 2 + 1);
  }
  lib.get('mw_display').needsUpdate = true;
}

function setMicrowave(c: Ctx, mode: 'clock' | 'off' | 'blink'): void {
  mwMode = mode;
  mwKey = '';
  c.prop('apt_microwave').setGlow(mode === 'off' ? 0 : 1, 'emit_mw_display');
  if (mode === 'clock') c.game.textures.redraw('mw_display');
}

/** 冷蔵庫の唸り（エンジンの常時エミッタ）。漏電の間だけ止める */
function fridgeHum(c: Ctx, on: boolean): void {
  c.emitter('fridge_hum')?.setVolume(on ? 0.8 : 0, on ? 1.2 : 0.12);
}

/** ローテーブルのスマホの画面を光らせる（なおからの『起きてる？』） */
function phoneScreen(c: Ctx, on: boolean): void {
  for (const m of c.prop('apt_phone').materials('screen_phone')) {
    m.emissive?.set(on ? 0xcfdcff : 0x000000);
    m.emissiveIntensity = on ? 1.6 : 1;
  }
}

export const ch1_night: ChapterDef = {
  id: 'ch1_night',
  title: T('ch1.title'),
  subtitle: T('ch1.subtitle'),
  time: 'night',
  spawn: 'spawn_bed',
  wakeUp: true,
  clock: { h: 3, m: 3, rate: 0.05 },
  ambience: 'room_tone',
  money: 1500,
  // チェックポイントから再開したとき（懐中電灯を持っている）は点けた状態で始める
  flashlightOn: true,
  gameOverReason: T('ch1.gameover'),

  setup(c) {
    mwMode = 'clock';
    mwKey = '';
    mwT = 0;
    let lastObjective: string | null = null;
    let water: SoundHandle | null = null;
    let sleeping = false;
    let fallingAsleep = false;
    /** 漏電の一連の演出（「――水の音？」まで）が終わったか */
    let tripSequenceDone = c.is('power_tripped');

    // ── 目標 ─────────────────────────────────────────────────────────────
    const nonFridgeGaps = () => ['gap_toilet', 'gap_mirror', 'gap_closet', 'gap_curtain'].filter((k) => c.is(k)).length;
    const gapCount = () => nonFridgeGaps() + (c.is('gap_fridge') ? 1 : 0);
    const objectiveText = (): string => {
      if (!c.is('got_flashlight')) {
        if (c.is('ch1_fridge_opened')) return T('ch1.obj_take_blind');
        if (c.is('drawer_checked')) return T('ch1.obj_check_fridge');
        if (c.is('tried_switch')) return T('ch1.obj_find_flashlight');
        return T('ch1.obj_light');
      }
      if (!c.is('tape_peeled')) return T('ch1.obj_breaker');
      if (!c.is('power_on')) {
        if (!c.is('water_found')) return T('ch1.obj_water');
        if (c.is('faucet_off') && c.is('plug_out')) return T('ch1.obj_raise_breaker');
        if (c.is('faucet_off')) return T('ch1.obj_washer');
        return T('ch1.obj_faucet');
      }
      if (!c.is('gap_phase')) return T('ch1.obj_read_memo');
      const n = gapCount();
      return n < 5 ? T('ch1.obj_gaps', { n }) : T('ch1.obj_sleep');
    };
    const refresh = () => {
      const t = objectiveText();
      if (t === lastObjective) return;
      lastObjective = t;
      c.objective(t);
    };

    /**
     * 共通ルール3: 目を閉じている最中に会話ウィンドウを出すときは、強制的に閉じたまま出す
     * （エンジンはモーダル表示中に目を開けてしまう）。章が変わったら（Aborted）解除しない。
     */
    const keepEyes = async (fn: () => Promise<void>): Promise<void> => {
      // 別の演出がすでに目を強制しているときは触らない（その演出の解除を先取りしない）
      const mine = c.game.eyes.force === null && c.player.eyesClosed;
      if (mine) c.eyes(true);
      await fn();
      if (mine) c.releaseEyes();
    };
    const monoEyes = (key: string) => keepEyes(() => c.play(key));

    // ── 顔 ───────────────────────────────────────────────────────────────
    /** この章で最初に見た顔か（QA#5: どの顔であれ最初の一体で［顔から目をそらす］を教える） */
    const firstFace = (): boolean => {
      if (c.is('ch1_face_seen')) return false;
      c.set('ch1_face_seen');
      return true;
    };

    /** F1-1 洗濯機の中。fleeting{lethal=3.5, vanishAfter=1.6}（構造上死なない）。槽のふちから半分のぞく */
    const spawnWasherFace = () => {
      c.set('ch1_f11_spawned');
      const f = c.face('anc_washer_inside', {
        type: 'fleeting',
        lethal: 3.5,
        vanishAfter: 1.6,
        onSeen: () => {
          firstFace();
          c.sfx('face_appear', { at: 'anc_washer_inside' });
          // ヒントが先: 独白は目をそらすまで出ない
          c.hint(T('ch1.hint_look_away'));
          c.run(() => monoEyes('ch1.washer_face'));
        },
        onVanish: () => {
          if (c.alive) c.set('ch1_f11_gone');
        },
      });
      // アンカー（y=0.72）は槽の底で、縁に隠れて見えないまま凝視だけ進み得る（QA#22）→ 縁の高さへ
      f.pos.copy(c.prop('apt_washer').toWorld([0, 0.97, 0.02]));
    };
    /** キッチンに初めて入ったとき: 洗濯機のほうで水が垂れる（予兆）→ 0.8秒後に F1-1 */
    const washerFaceAfterOmen = async () => {
      c.set('ch1_f11_spawned');
      c.sfx('water_drip', { at: 'anc_washer_inside', volume: 0.5 });
      await c.wait(0.8);
      if (!c.is('power_on')) spawnWasherFace();
    };

    /**
     * F1-2 冷蔵庫の奥。static{lethal=3.5}。3.5 は初見救済（ルール②を教える顔。反射閉眼つき）。
     * owner:null = 冷蔵庫の側面も視線を遮る（既定の owner では、横から「側面を狙って目を閉じる」
     * つもりで見ていても、見えない顔の凝視が進んでしまう。QA#22）
     */
    const spawnFridgeFace = () => {
      c.face('anc_fridge_inside', {
        type: 'static',
        lethal: 3.5,
        owner: null,
        onSeen: () => void firstFace(),
      });
    };

    /** F1-3 浴槽。peek（lethal 2）。カーテンの隙間の側へ寄せ、水面から上半分だけ出す */
    const spawnTubFace = () => {
      const tub = c.prop('apt_bathtub');
      const f = c.face('anc_bathtub', {
        type: 'peek',
        onSeen: () => {
          if (firstFace()) c.hint(T('ch1.hint_look_away'));
        },
      });
      const surface = tub.node('water_full')?.getWorldPosition(new THREE.Vector3()).y ?? 0.52;
      // アンカー（z=+0.25）はカーテンの端の真裏で、浴室の入口からは隠れる。隙間側（z=+0.38）へ
      const p = tub.toWorld([0, 0, 0.38]);
      f.pos.set(p.x, surface + 0.01, p.z);
    };

    /** F1-4 洗面台の鏡。static{style=flat}（lethal 2）。鏡面に貼りついた「映り込み」として正面（南）を向ける */
    const spawnMirrorFace = () => {
      c.set('ch1_f14_spawned');
      c.face('anc_mirror', {
        type: 'static',
        style: 'flat',
        lookAt: false,
        yaw: 180,
        onSeen: () => {
          if (firstFace()) c.hint(T('ch1.hint_look_away'));
          c.run(() => monoEyes('ch1.mirror_face'));
        },
      });
    };
    /** すきまの段階で浴室に入ったとき: 蛇口の滴と、浴室灯がふっと落ちる（予兆）→ F1-4 */
    const mirrorFaceAfterOmen = async () => {
      c.set('ch1_f14_spawned');
      const bath = c.light('apt_light_bath');
      c.sfx('water_drip', { at: 'anc_mirror', volume: 0.6 });
      bath.level = 0;
      await c.wait(0.5);
      bath.level = 1;
      await c.wait(0.3);
      if (!c.is('gap_mirror')) spawnMirrorFace();
    };

    /**
     * F1-5 クローゼットの隙間。peek（lethal 2）。戸の隙間に半分だけ見える位置へ寄せる。
     * owner:null = クローゼットの側板も視線を遮る（既定の owner では、ベッド側から側板ごしに
     * 見えない顔の凝視が進み、理不尽に死ぬ。QA#22）。見える＝凝視できるのは隙間ごしだけ
     */
    const spawnClosetFace = () => {
      c.set('ch1_f15_spawned');
      const f = c.face('anc_closet_gap', {
        type: 'peek',
        owner: null,
        onSeen: () => {
          if (firstFace()) c.hint(T('ch1.hint_look_away'));
          c.run(() => monoEyes('ch1.closet_face'));
        },
      });
      // 右戸（CLOSET_GAP）が開けた隙間 x∈[0.72,0.85] の中央、戸のすぐ裏。正面から左右およそ25°以内で見える
      f.pos.copy(c.prop('apt_closet').toWorld([0.78, 1.52, 0.2]));
    };
    /** すきまの段階で洋室に入ったとき: クローゼットの中で息の音（予兆）→ F1-5 */
    const closetFaceAfterOmen = async () => {
      c.set('ch1_f15_spawned');
      c.sfx('breathing', { at: 'anc_closet_gap', volume: 0.5 });
      await c.wait(0.9);
      if (!c.is('gap_closet')) spawnClosetFace();
    };

    /**
     * F1-6（任意）夜道のカーブミラー。fleeting{lethal=3.5, vanishAfter=1.6}（構造上死なない）。
     * シナリオの外階段の peek（lethal 2・ヒントなし）は、冷蔵庫より先に外へ出ると最初の顔になり
     * ルールを教わる前に死ぬ（QA#5）ので、QA#20 の案どおりカーブミラーへ移した（外廊下は足音だけ）。
     * 予兆はそばの街灯の明滅。近づいてミラーのほうを向いたときに一度だけ（見ずに離れたら仕切り直す）。
     */
    const mirrorAt = c.anchor('anc_curve_mirror');
    const mirrorDist = () => {
      const p = c.player.pos;
      return Math.hypot(p.x - mirrorAt.x, p.z - mirrorAt.z);
    };
    const facingMirror = () => {
      const p = c.player.pos;
      let d = (Math.atan2(-(mirrorAt.x - p.x), -(mirrorAt.z - p.z)) * 180) / Math.PI - c.player.yaw;
      d = ((((d + 180) % 360) + 360) % 360) - 180;
      return Math.abs(d) < 55;
    };
    const armCurveMirror = () => {
      c.when(
        () => !c.is('ch1_f16_seen') && mirrorDist() < 14 && facingMirror(),
        async () => {
          const lamp = c.light('lamp_pole_s2');
          lamp.setFlicker(true);
          await c.wait(0.9);
          const f = c.face('anc_curve_mirror', {
            type: 'fleeting',
            lethal: 3.5,
            vanishAfter: 1.6,
            style: 'flat',
            scale: 1.5,
            onSeen: () => {
              c.set('ch1_f16_seen');
              c.sfx('face_appear', { at: 'anc_curve_mirror' });
              if (firstFace()) c.hint(T('ch1.hint_look_away'));
              c.run(() => monoEyes('ch1.curve_mirror_face'));
            },
          });
          while (f.alive) {
            await c.wait(0.25);
            if (!f.seen && f.dying === 0 && mirrorDist() > 24) c.clearFace(f);
          }
          lamp.setFlicker(false);
          if (!c.is('ch1_f16_seen')) armCurveMirror();
        },
      );
    };

    // ── 世界の組み直し（フラグ → 見た目） ─────────────────────────────────
    const powerOn = c.is('power_on');
    const tripped = c.is('power_tripped') && !powerOn;

    // 分電盤: 照明の子ブレーカー sw_2 をテープで留めて下げてある → 剥がして上げると漏電でメインが落ちる
    c.power(powerOn);
    c.breaker('sw_2', c.is('tape_peeled'));
    c.breaker('sw_main', !tripped);
    const breakerBox = c.prop('apt_breaker');
    breakerBox.showNode('tape', !c.is('tape_peeled'));
    if (c.is('saw_breaker')) breakerBox.setOpen(1, 'cover');
    if (powerOn) {
      c.light('apt_light_kitchen').setOn(true);
      c.light('apt_light_bath').setOn(true).setFlicker(true);
    }
    fridgeHum(c, !tripped);
    setMicrowave(c, powerOn ? 'blink' : tripped ? 'off' : 'clock');
    phoneScreen(c, false);

    // 冷蔵庫: 扉が少し開いて光が漏れている。中段に懐中電灯。扉にはメモ（暗くて気づかない）
    const fridgeProp = c.prop('apt_fridge');
    fridgeProp.showNode('memo', true);
    fridgeProp.showNode('flashlight_in_fridge', !c.is('got_flashlight'));
    if (!c.is('got_flashlight')) {
      fridgeProp.setOpen(c.is('ch1_fridge_opened') ? 1 : 0.12, 'door');
      c.light('apt_fridge_light').setOn(true);
      if (c.is('ch1_fridge_opened')) spawnFridgeFace();
    } else if (c.is('fridge_reopened') && !c.is('gap_fridge')) {
      fridgeProp.setOpen(0.12, 'door');
      c.light('apt_fridge_light').setOn(true);
    }

    // 洗濯機: ふたが開いている（F1-1 が出る場所）
    if (!c.is('ch1_washer_lid_closed')) c.prop('apt_washer').setOpen(1, 'lid');
    if (c.is('ch1_f11_spawned') && !c.is('ch1_f11_gone') && !powerOn) spawnWasherFace();

    // 浴室: 扉は半開き、シャワーカーテン3割、トイレのふた開、浴槽はあふれて床まで水
    c.prop('apt_bath_door').setOpen(0.6, 'leaf');
    c.prop('apt_shower_curtain').setOpen(SHOWER_GAP, 'curtain');
    if (!c.is('gap_toilet')) c.prop('apt_toilet').setOpen(1, 'lid');
    c.prop('apt_sink').showNode('towel', c.is('gap_mirror'));
    const flooded = !powerOn; // 再開時 power_on → 水と漏電なし
    c.prop('apt_bathtub').showNode('water_full', flooded);
    c.prop(FLOOR_WATER).visible = flooded;
    if (!c.is('faucet_off')) water = c.loop('water_run', { at: 'anc_bathtub', volume: tripped ? 0.6 : 0.15 });
    if (c.is('water_found') && !c.is('faucet_off')) spawnTubFace();

    // 洋室: クローゼットの右戸を少し、カーテンを少し開けてある
    if (!c.is('gap_closet')) c.prop('apt_closet').setOpen(CLOSET_GAP, 'door_r');
    if (!c.is('gap_curtain')) c.prop('apt_curtain').setOpen(0.15, 'curtain_l');
    if (c.is('gap_phase')) {
      if (c.is('ch1_f14_spawned') && !c.is('gap_mirror')) spawnMirrorFace();
      if (c.is('ch1_f15_spawned') && !c.is('gap_closet')) spawnClosetFace();
    }
    // 玄関: 施錠＋チェーン（既定のまま。なおが内側からかけたもの）

    // ── インタラクト ───────────────────────────────────────────────────────

    // 照明スイッチ
    const pressSwitch = async (id: string) => {
      if (c.is('power_on')) {
        await c.useDefault(id);
        return;
      }
      const sw = c.prop(id);
      c.sfx('switch_click', { at: id });
      void sw.animate(sw.isOpen() ? 0 : 1, undefined, 0.08);
      await c.play('ch1.switch_dead');
      if (!c.is('tried_switch')) {
        // 漏電のあと（冷蔵庫も時計も止まっている）に初めて押したときは、最初の気づきは言わない（QA#2）
        if (!c.is('power_tripped')) await c.play('ch1.switch_first');
        c.set('tried_switch');
        refresh();
      }
    };
    c.on('apt_switch_room', { label: T('ch1.label_switch'), use: () => pressSwitch('apt_switch_room'), blind: false });
    c.on('apt_switch_kitchen', { label: T('ch1.label_switch'), use: () => pressSwitch('apt_switch_kitchen'), blind: false });

    // 電子レンジ
    c.on('apt_microwave', {
      label: T('ch1.label_microwave'),
      blind: false,
      use: async () => {
        if (c.is('power_on')) await c.play('ch1.microwave_blink');
        else if (c.is('power_tripped')) await c.play('ch1.microwave_off');
        else await c.play('ch1.microwave_clock', { h: c.now.h });
      },
    });

    // キッチンの引き出し
    c.on('apt_kitchen_drawer', {
      label: () => (c.is('drawer_checked') ? c.defaultLabel('apt_kitchen_drawer') : T('ch1.label_drawer')),
      blind: false,
      use: async () => {
        if (c.is('drawer_checked')) {
          await c.useDefault('apt_kitchen_drawer');
          return;
        }
        c.sfx('drawer_open', { at: 'apt_kitchen_counter' });
        await c.prop('apt_kitchen_counter').animate(1, 'drawer', 0.35);
        await c.play('ch1.drawer_empty');
        c.give('battery');
        c.set('drawer_checked');
        // 冷蔵庫をまだ開けていなければ、漏れている光に気づく（取ったあとなら言わない。QA#2）
        if (!c.is('ch1_fridge_opened') && !c.is('got_flashlight')) await c.play('ch1.drawer_fridge_light');
        refresh();
      },
    });

    // 冷蔵庫
    const fridgePowered = () => !c.is('power_tripped') || c.is('power_on');

    const openFridgeFirst = async () => {
      c.set('ch1_fridge_opened');
      await c.cutscene(async () => {
        const p = c.prop('apt_fridge');
        c.sfx('fridge_open', { at: 'apt_fridge' });
        c.light('apt_fridge_light').setOn(true);
        await p.animate(1, 'door', 0.55);
        await c.lookAt(p.toWorld([0.12, 0.87, 0.05]), 0.6);
        await c.play('ch1.fridge_flashlight');
        await c.wait(0.6);
        spawnFridgeFace();
        c.sfx('face_appear', { at: 'anc_fridge_inside' });
        await c.wait(0.8); // 反射閉眼まで0.8秒
        c.eyes(true); // 反射的に目をつぶる。次の2行のあいだ閉じたまま
        await c.wait(0.4);
        await c.play('ch1.fridge_face');
      });
      c.releaseEyes();
      c.hint(T('ch1.hint_blind_take'));
      refresh();
    };

    const takeFlashlight = async () => {
      c.give('flashlight');
      c.prop('apt_fridge').showNode('flashlight_in_fridge', false);
      c.set('got_flashlight');
      // 耳もとの息に身がすくむ。扉が閉まって顔が消えるまで目は閉じたまま（共通ルール3）
      c.eyes(true);
      c.sfx('breathing', { volume: 0.9 });
      await c.play('ch1.take_breath');
      c.sfx('fridge_close', { at: 'apt_fridge' });
      const closing = c.prop('apt_fridge').animate(0, 'door', 0.55);
      c.clearFace('anc_fridge_inside');
      await closing;
      c.light('apt_fridge_light').setOn(false);
      c.releaseEyes();
      await c.wait(1.0);
      // Space を押したままなら、閉じたまま独白を出す
      await monoEyes('ch1.take_warm');
      await keepEyes(() => c.play('ch1.take_who'));
      c.checkpoint('ch1_flashlight');
      c.hint(T('ch1.hint_flashlight'));
      refresh();
    };

    /** 懐中電灯を取ったあと〜電気が戻るまで: 既定の開閉（漏電中は庫内灯もつかない） */
    const toggleFridgeInDark = async () => {
      const p = c.prop('apt_fridge');
      const opening = !p.isOpen('door');
      c.sfx(opening ? 'fridge_open' : 'fridge_close', { at: 'apt_fridge' });
      if (opening && fridgePowered()) c.light('apt_fridge_light').setOn(true);
      await p.animate(opening ? 1 : 0, 'door', 0.55);
      if (!opening) c.light('apt_fridge_light').setOn(false);
      if (opening) await c.play('ch1.fridge_empty');
    };

    const readFridgeMemo = async () => {
      const p = c.prop('apt_fridge');
      if (p.isOpen('door')) {
        // メモは扉に貼ってある。開けっぱなしなら閉めてから読む
        c.sfx('fridge_close', { at: 'apt_fridge' });
        await p.animate(0, 'door', 0.55);
        c.light('apt_fridge_light').setOn(false);
      }
      await c.doc('doc_memo_fridge');
      await c.play('ch1.memo_after');
      c.set('gap_phase'); // すでに閉じている箇所は gapCount() がそのまま数える
      refresh();
    };

    const closeFridgeGap = async () => {
      c.sfx('fridge_close', { at: 'apt_fridge' });
      await c.prop('apt_fridge').animate(0, 'door', 0.55);
      c.light('apt_fridge_light').setOn(false);
      await c.wait(0.8);
      c.sfx('knock', { at: 'apt_fridge' });
      await c.wait(0.4);
      c.sfx('knock', { at: 'apt_fridge' });
      await monoEyes('ch1.fridge_knock');
      c.set('gap_fridge');
      refresh();
    };

    // ルール②の練習（目を閉じたまま、懐中電灯を取る）: キッチンにいる間は、直前に冷蔵庫を
    // 狙っていなくても、目を閉じれば「懐中電灯を取る」が出る（顔から目をそらしてから閉じても取れる）
    c.every(0.25, () => {
      const practice = c.is('ch1_fridge_opened') && !c.is('got_flashlight') && c.inZone('zone_apt_kitchen');
      c.blindTarget(practice ? 'apt_fridge' : null);
    });

    c.on('apt_fridge', {
      label: () => {
        const open = c.prop('apt_fridge').isOpen('door');
        if (!c.is('got_flashlight')) return open ? T('ch1.label_take_flashlight') : T('ch1.label_open_fridge');
        if (!c.is('power_on')) return open ? T('ch1.label_close_fridge') : T('ch1.label_open_fridge');
        if (!c.is('gap_phase')) return T('ch1.label_read_memo');
        if (c.is('fridge_reopened') && !c.is('gap_fridge')) return T('ch1.label_close_fridge');
        return T('ch1.label_open_fridge');
      },
      // 目を閉じたまま使えるのは「懐中電灯を取る」と、すきまの「冷蔵庫を閉める」だけ
      get blind() {
        const open = c.prop('apt_fridge').isOpen('door');
        return (!c.is('got_flashlight') && open) || (c.is('gap_phase') && c.is('fridge_reopened') && !c.is('gap_fridge'));
      },
      use: async () => {
        const open = c.prop('apt_fridge').isOpen('door');
        if (!c.is('got_flashlight')) {
          if (open) await takeFlashlight();
          else await openFridgeFirst();
          return;
        }
        if (!c.is('power_on')) {
          await toggleFridgeInDark();
          return;
        }
        if (!c.is('gap_phase')) {
          await readFridgeMemo();
          return;
        }
        if (c.is('fridge_reopened') && !c.is('gap_fridge')) {
          await closeFridgeGap();
          return;
        }
        await c.play('ch1.fridge_not_now');
      },
    });

    // 分電盤（玄関の上）
    const peelTape = async () => {
      c.sfx('tape_peel', { at: 'apt_breaker' });
      await c.wait(0.6);
      c.prop('apt_breaker').showNode('tape', false);
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_2', true);
      c.power(true);
      c.light('apt_light_kitchen').setOn(true);
      await keepEyes(() => c.play('ch1.peel_on'));
      await c.wait(2.5);
      // 浴槽からあふれた水が洗濯機の延長コードに届いていて、漏電でメインごと落ちる
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_main', false);
      c.power(false);
      c.light('apt_fridge_light').setOn(false);
      fridgeHum(c, false);
      setMicrowave(c, 'off');
      c.set('tape_peeled');
      c.set('power_tripped');
      await c.wait(1.0);
      await monoEyes('ch1.trip_all');
      if (c.is('faucet_off')) {
        // 漏電の前に蛇口を閉めていた（QA#1）: もう水音はしない。床の水 → 洗濯機のまわりへ
        await monoEyes('ch1.trip_after_faucet');
      } else {
        water?.setVolume(0.6, 1.5);
        await c.wait(1.4);
        await monoEyes('ch1.trip_water');
      }
      tripSequenceDone = true;
      refresh();
    };

    const breakerTripsAgain = async () => {
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_main', true);
      await c.wait(0.3);
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_main', false);
      await monoEyes('ch1.trip_again');
    };

    const restorePower = async () => {
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_main', true);
      c.power(true);
      c.light('apt_light_kitchen').setOn(true);
      fridgeHum(c, true);
      c.light('apt_light_bath').setOn(true).setFlicker(true);
      if (c.prop('apt_fridge').isOpen('door')) c.light('apt_fridge_light').setOn(true);
      setMicrowave(c, 'blink');
      // 顔F1-1 がまだ残っていれば、ここで消す
      c.clearFace('anc_washer_inside');
      c.set('ch1_f11_gone');
      await monoEyes('ch1.restore_on');
      c.set('power_on');
      c.checkpoint('ch1_power');
      await monoEyes('ch1.restore_memo');
      refresh();
    };

    c.on('apt_breaker', {
      label: () => {
        // ふたが閉じている間は既定（「分電盤のフタを開ける」）
        if (!c.prop('apt_breaker').isOpen('cover')) return c.defaultLabel('apt_breaker');
        if (!c.is('got_flashlight') || !c.is('saw_breaker')) return T('ch1.label_breaker_check');
        if (!c.is('tape_peeled')) return T('ch1.label_breaker_peel');
        if (!c.is('power_on')) return T('ch1.label_breaker_raise');
        return T('ch1.label_breaker_look');
      },
      blind: false,
      use: async () => {
        if (!c.prop('apt_breaker').isOpen('cover')) {
          await c.useDefault('apt_breaker');
          return;
        }
        // 懐中電灯より先に全停電を起こさせない（QA#2）
        if (!c.is('got_flashlight')) {
          await c.play('ch1.breaker_dark');
          return;
        }
        if (!c.is('saw_breaker')) {
          await c.play('ch1.breaker_taped');
          await c.doc('doc_memo_breaker');
          await c.play('ch1.breaker_not_mine');
          c.set('saw_breaker');
          return;
        }
        if (!c.is('tape_peeled')) {
          await peelTape();
          return;
        }
        if (!c.is('power_on')) {
          if (c.is('faucet_off') && c.is('plug_out')) await restorePower();
          else await breakerTripsAgain();
          return;
        }
        await c.play('ch1.breaker_all_up');
      },
    });

    // 浴槽の蛇口（シャワーカーテンの隙間から狙う）。
    // QA#1: 漏電の前でも閉められる（water_found も立てる。目標は進めない）。
    // QA#22: 照準はラベルのないカーテンで止まるので、カーテン越しでも同じく「蛇口を閉める」
    const closeFaucet = async () => {
      water?.stop(0.4);
      water = null;
      c.sfx('water_drip', { at: 'anc_bathtub' });
      c.clearFace('anc_bathtub');
      c.set('faucet_off');
      c.set('water_found');
      if (c.is('power_tripped')) await monoEyes('ch1.faucet_tripped');
      else await monoEyes('ch1.faucet_before');
      refresh();
    };
    c.on('apt_bathtub', {
      label: () => (c.is('faucet_off') ? T('ch1.label_look_tub') : T('ch1.label_close_faucet')),
      get blind() {
        return !c.is('faucet_off');
      },
      use: async () => {
        if (!c.is('faucet_off')) {
          await closeFaucet();
          return;
        }
        await c.play('ch1.tub_draining');
      },
    });

    // シャワーカーテン（顔がいる間＝蛇口を閉めるまでは開け閉めさせない）
    c.on('apt_shower_curtain', {
      label: () => (c.is('faucet_off') ? c.defaultLabel('apt_shower_curtain') : T('ch1.label_close_faucet')),
      get blind() {
        return !c.is('faucet_off');
      },
      use: async () => {
        if (!c.is('faucet_off')) {
          await closeFaucet();
          return;
        }
        await c.useDefault('apt_shower_curtain');
      },
    });

    // 洗濯機（プラグは漏電のあと、水に気づいてから。QA#1: 先に蛇口を閉めていてもよい）
    const plugReady = () => c.is('power_tripped') && !c.is('plug_out') && (c.is('water_found') || c.is('faucet_off'));
    c.on('apt_washer', {
      label: () => {
        if (plugReady()) return T('ch1.label_pull_plug');
        if (c.prop('apt_washer').isOpen('lid') && c.is('ch1_f11_gone')) return T('ch1.label_close_washer_lid');
        return T('ch1.label_look_washer');
      },
      blind: false,
      use: async () => {
        if (plugReady()) {
          c.sfx('thud', { at: 'apt_washer' });
          await c.play('ch1.plug_found');
          c.set('plug_out');
          refresh();
          return;
        }
        if (c.prop('apt_washer').isOpen('lid') && c.is('ch1_f11_gone')) {
          await c.useDefault('apt_washer');
          c.set('ch1_washer_lid_closed');
          return;
        }
        await c.play('ch1.washer_old');
      },
    });

    // トイレ（ふたは開けてもよいが、開けたら gap_toilet を戻す）
    c.on('apt_toilet', {
      label: () => (c.prop('apt_toilet').isOpen('lid') ? T('ch1.label_close_toilet') : c.defaultLabel('apt_toilet')),
      get blind() {
        return c.prop('apt_toilet').isOpen('lid');
      },
      use: async () => {
        const p = c.prop('apt_toilet');
        if (!p.isOpen('lid')) {
          await c.useDefault('apt_toilet');
          c.set('gap_toilet', false);
          refresh();
          return;
        }
        c.sfx('lid_close', { at: 'apt_toilet' });
        const closing = p.animate(0, 'lid', 0.5);
        await c.wait(0.6);
        await closing;
        c.sfx('water_drip', { at: 'apt_toilet' });
        await monoEyes('ch1.toilet_closed');
        c.set('gap_toilet');
        refresh();
      },
    });

    // 洗面台の鏡（タオルをかけたあとは、もう覗けない）
    c.on('apt_bath_mirror', {
      label: () => {
        if (c.is('gap_mirror')) return null;
        if (c.is('gap_phase')) return T('ch1.label_towel_mirror');
        return c.defaultLabel('apt_bath_mirror');
      },
      get blind() {
        return c.is('gap_phase') && !c.is('gap_mirror');
      },
      use: async () => {
        if (c.is('gap_mirror')) return;
        if (!c.is('gap_phase')) {
          await c.useDefault('apt_bath_mirror');
          return;
        }
        c.prop('apt_sink').showNode('towel', true);
        c.clearFace('anc_mirror');
        await c.wait(0.8);
        c.sfx('whisper_futatsu', { at: 'anc_mirror' });
        c.subLine('ch1.sub_futatsu', 2.2);
        await c.wait(2.4);
        await monoEyes('ch1.mirror_said');
        c.set('gap_mirror');
        refresh();
      },
    });

    // クローゼット（この章では開けさせない。中になおがいる）
    c.on('apt_closet', {
      label: () => (c.is('gap_closet') ? T('ch1.label_closet') : T('ch1.label_close_closet')),
      get blind() {
        return !c.is('gap_closet');
      },
      use: async () => {
        if (c.is('gap_closet')) {
          await c.play('ch1.closet_not_open');
          return;
        }
        c.sfx('slide_close', { at: 'apt_closet' });
        const closing = c.prop('apt_closet').animate(0, 'door_r', 0.5);
        c.clearFace('anc_closet_gap');
        await closing;
        await c.wait(0.7);
        c.sfx('thud', { at: 'apt_closet' });
        await monoEyes('ch1.closet_closed');
        c.set('gap_closet');
        refresh();
      },
    });

    // カーテン（窓はこの章ではラベルなし）
    c.on('apt_curtain', {
      label: () => (c.is('gap_curtain') ? T('ch1.label_curtain') : T('ch1.label_close_curtain')),
      blind: false,
      use: async () => {
        if (c.is('gap_curtain')) {
          await c.play('ch1.curtain_not_open');
          return;
        }
        c.sfx('curtain', { at: 'apt_curtain' });
        void c.prop('apt_curtain').animate(0, 'curtain_l', 0.5);
        await c.wait(0.5);
        c.sfx('window_tap', { at: 'anc_window_outside' });
        await c.wait(0.3);
        c.sfx('window_tap', { at: 'anc_window_outside' });
        await monoEyes('ch1.curtain_closed');
        c.set('gap_curtain');
        refresh();
      },
    });
    c.off('apt_window');

    // ベッド
    c.on('apt_bed', {
      label: () => (c.is('gap_phase') && gapCount() >= 5 ? T('ch1.label_lie_down') : T('ch1.label_bed')),
      blind: false,
      use: async () => {
        if (!c.is('gap_phase')) {
          await c.play('ch1.bed_not_now');
          return;
        }
        if (gapCount() < 5) {
          await c.play('ch1.bed_not_done');
          return;
        }
        // 第2章の玄関の独白用（QA24）: 自分でチェーンを外したまま寝たなら、朝に外れていても不思議はない
        c.set('ch1_chain_at_bed', c.isLocked('apt_door_chain'));
        await c.lieAwake({ yaw: 70 });
        sleeping = true;
        await c.play('ch1.bed_sleep');
        c.hint(T('ch1.hint_sleep'));
        // 目を8秒閉じ続けたら onBlackout で次の章へ
      },
    });

    // スマホ
    c.on('apt_phone', {
      label: () => (c.is('power_on') && !c.is('ch1_phone_charged') ? T('ch1.label_charge_phone') : c.defaultLabel('apt_phone')),
      blind: false,
      use: async () => {
        if (!c.is('power_on')) {
          await c.play('ch1.phone_no_battery');
          return;
        }
        if (!c.is('ch1_phone_charged')) {
          c.set('ch1_phone_charged');
          await c.play('ch1.phone_charge');
          return;
        }
        await c.play('ch1.phone_not_yet');
      },
    });

    // その他（この章で意味のあるもの）
    c.on('apt_tv', { label: () => c.defaultLabel('apt_tv'), blind: false, use: () => c.play('ch1.tv_not_now') });
    const notNow = () => c.play('ch1.not_now');
    c.on('apt_calendar', { label: () => c.defaultLabel('apt_calendar'), blind: false, use: notNow });
    c.on('apt_desk', { label: () => c.defaultLabel('apt_desk'), blind: false, use: notNow });
    c.on('apt_notebook', { label: () => c.defaultLabel('apt_notebook'), blind: false, use: notNow });
    c.on('apt_medicine', { label: () => c.defaultLabel('apt_medicine'), blind: false, use: notNow });
    c.on('apt_photo', { label: () => c.defaultLabel('apt_photo'), blind: false, use: notNow });
    c.on('apt_trash', { label: () => c.defaultLabel('apt_trash'), blind: false, use: notNow });
    c.on('apt_shoebox', {
      label: () => c.defaultLabel('apt_shoebox'),
      blind: false,
      use: async () => {
        const opening = !c.prop('apt_shoebox').isOpen('door_l');
        await c.useDefault('apt_shoebox');
        if (opening) await c.play('ch1.shoebox');
      },
    });
    // apt_door は既定（覗き穴・鍵・チェーン・開ける）。外へ出るのは任意
    c.on('ext_board', { label: () => c.defaultLabel('ext_board'), blind: false, use: () => c.play('ch1.board_dark') });
    c.on('ext_mailbox', { label: () => c.defaultLabel('ext_mailbox'), blind: false, use: () => c.play('ch1.mailbox') });
    // ext_vending は既定（自販機の店）

    // 夜のコンビニ（任意）: 入ると坂口があいさつ。以降、話しかけると店
    const greetClerk = async () => {
      if (c.is('ch1_clerk_met')) return;
      c.set('ch1_clerk_met');
      await keepEyes(() => c.play('ch1.clerk_greet'));
    };
    const talkClerk = async () => {
      if (!c.is('ch1_clerk_met')) {
        await greetClerk();
        return;
      }
      await c.shop('conbini');
    };
    c.npc('npc_clerk', { at: 'npc_clerk_spot', talk: talkClerk });
    c.on('conbini_counter', { label: T('ch1.label_clerk'), blind: false, use: talkClerk });

    // ── 場所トリガー ───────────────────────────────────────────────────────
    c.zone('zone_apt', {
      enter: () => c.ambience('room_tone'),
      exit: () => c.ambience('night_out'),
    });
    c.zone('zone_conbini_in', {
      // 入店のチャイムは自動ドアが鳴らす
      enter: async () => {
        c.set('visited_conbini_ch1'); // 第2章の坂口の台詞の分岐用（QA#24）
        c.ambience('conbini_in');
        await greetClerk();
      },
      exit: () => c.ambience('night_out'),
    });
    c.zone('zone_apt_kitchen', {
      enter: async () => {
        if (!c.is('ch1_f11_spawned') && !c.is('power_on')) await washerFaceAfterOmen();
      },
    });
    c.zone('zone_apt_bath', {
      enter: async () => {
        if (c.is('gap_phase') && !c.is('gap_mirror') && !c.is('ch1_f14_spawned')) await mirrorFaceAfterOmen();
      },
    });
    c.zone('zone_apt_room', {
      enter: async () => {
        if (c.is('gap_phase') && !c.is('gap_closet') && !c.is('ch1_f15_spawned')) await closetFaceAfterOmen();
      },
    });
    // 外廊下は足音だけ（QA#20。外階段の顔はカーブミラーへ移した）
    c.zone('zone_corridor', {
      enter: async () => {
        if (c.is('ch1_corridor_done')) return;
        c.set('ch1_corridor_done');
        c.set('went_out_ch1'); // 自分でチェーンを外して外へ出た（第2章の玄関の台詞の分岐用。QA#24）
        c.ambience('night_out');
        // 電気が戻ったあとに初めて出たときは「うちだけ停電」の気づきは言わない
        if (!c.is('power_on')) await monoEyes('ch1.corridor_lit');
        c.sfx('footsteps_outside', { at: 'anc_stairs' });
        await c.wait(0.6);
        await monoEyes('ch1.corridor_steps');
      },
    });
    c.zone('zone_street', {
      enter: async () => {
        if (c.is('got_flashlight') || c.is('ch1_street_done')) return;
        c.set('ch1_street_done');
        await monoEyes('ch1.street_back');
      },
    });
    armCurveMirror();

    // 漏電のあと浴室に入る → 水と F1-3（条件が成り立ったときにだけ一度。先に蛇口を閉めていれば起きない）
    c.when(
      () => tripSequenceDone && c.is('power_tripped') && !c.is('water_found') && !c.is('faucet_off') && c.inZone('zone_apt_bath'),
      async () => {
        c.sfx('water_drip', { at: 'anc_bathtub' });
        await monoEyes('ch1.tub_found');
        spawnTubFace();
        await monoEyes('ch1.tub_face');
        c.set('water_found');
        refresh();
      },
    );

    // すきま: gap_phase 中に冷蔵庫以外が3つ以上済んだら（メモを読む前に閉めた分も数える。QA#4）、
    // 一度だけ冷蔵庫がまた開く。部屋の中で、キッチンにいない時に
    c.when(
      () => c.is('gap_phase') && !c.is('fridge_reopened') && nonFridgeGaps() >= 3 && c.inZone('zone_apt') && !c.inZone('zone_apt_kitchen'),
      async () => {
        await c.wait(1.5);
        if (c.is('fridge_reopened')) return;
        c.sfx('fridge_open', { at: 'apt_fridge', volume: 0.45 });
        void c.prop('apt_fridge').animate(0.12, 'door', 0.5);
        c.light('apt_fridge_light').setOn(true);
        c.set('fridge_reopened');
        await monoEyes('ch1.fridge_reopened');
        refresh();
      },
    );

    // ── 8秒ルール ─────────────────────────────────────────────────────────
    c.onBlackout(() => {
      if (sleeping && c.lying) {
        if (!fallingAsleep) {
          fallingAsleep = true;
          c.run(async () => {
            c.eyes(true);
            c.sfx('whisper_oyasumi', { volume: 0.55 });
            c.subLine('ch1.sub_oyasumi', 2.6);
            await c.wait(2.8);
            await c.fadeOut(1.8);
            await c.goto('ch2_day');
          });
        }
        return true;
      }
      // ベッド以外は既定（はっと目覚める）。この章で初めてのときだけヒント
      if (!c.is('ch1_blackout_hint')) {
        c.set('ch1_blackout_hint');
        c.hint(T('ch1.hint_blackout'));
      }
      return false;
    });

    // ── 開始演出（章頭からのときだけ。起き上がる演出の途中から） ──────────────
    if (c.checkpointTag) {
      refresh();
      return;
    }
    c.run(async () => {
      const g = c.game;
      // まぶたが開いた（まだ寝姿勢の）ところから
      for (let i = 0; i < 400 && !(g.eyes.lid < 0 && g.player.override); i++) await c.wait(0.05);
      await c.play('ch1.wake');
      for (let i = 0; i < 400 && g.player.override; i++) await c.wait(0.05);
      await c.cutscene(async () => {
        c.sfx('phone_vibrate', { at: 'apt_phone' });
        phoneScreen(c, true);
        await c.lookAt(c.prop('apt_phone').position, 0.9);
        await c.play('ch1.phone_lit');
        phoneScreen(c, false);
        await c.wait(0.4);
        await c.play('ch1.phone_dead');
      });
      refresh();
      c.hint(T('ch1.hint_move'));
    });
  },

  update(c, dt) {
    if (mwMode === 'clock') return;
    mwT += dt;
    const lit = mwMode === 'blink' && Math.floor(mwT * 2) % 2 === 0;
    // 時計のテクスチャは分が変わるたびにエンジンが描き直すので、そのフレームで上書きし直す
    const key = `${lit ? 1 : 0}:${c.now.h}:${c.now.m}`;
    if (key === mwKey) return;
    mwKey = key;
    drawMicrowave(c, lit ? '0:00' : null);
  },
};
