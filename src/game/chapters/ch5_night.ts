import * as THREE from 'three';
import type { SoundHandle } from '../../audio/AudioEngine';
import type { V3 } from '../../world/types';
import type { Npc } from '../../world/World';
import type { ChapterDef } from '../Chapter';
import type { Ctx } from '../Ctx';
import type { InteractDef } from '../Interaction';
import type { Face } from '../face/FaceSystem';

// ─────────────────────────────────────────────────────────────────────────────
//  第5章 ch5_night「三日目　午前三時」 — docs/SCENARIO.md §5 第5章、§6 エンディングのゲーム内場面
//
//  流れ: 冷蔵庫の前で目覚める → うしろの白い顔（なお）→ ピンポン・偽のなお → なおが出ていく
//        → 公衆電話 → 鳥居の前の告白 → 顔たちが来る → ルートA（部屋で朝まで）/ ルートC（祠へ）
//  チェックポイント: 章頭 / ch5_out / ch5_choice / ch5_home（ルートA）/ ch5_sando（ルートC）
//
//  この章のフラグ: closed_fridge5, fake_done, nao_left, called, nao_trust, route('A'|'C'),
//  stage_a, offered（シナリオ記載）＋ 章内の補助フラグ ch5_*（再開時の組み直し用。ch5_sent_away＝
//  最後の返事が「来ないでくれ」）
//  前の章から読むもの: nao_trust（第3章）, saw_key / heard_lock / heard_whisper / slept_ch3（第3章）,
//  hatsu_key / hatsu_saw / knows_rite / trace_tv / read_doc_nao_note（第4章）, trace_washer /
//  trace_closet（第2章）, read_doc_notice / read_doc_notebook, 持ち物 diary / hairpin / milktea / incense
// ─────────────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
type XZ = [number, number];

const FRIDGE: XZ = [-21.66, 10.0];
const BEDSIDE: XZ = [-19.45, 14.4];
const DOOR: XZ = [-21.2, 7.0];
const HOKORA: XZ = [-40, -47.2];
/** 公衆電話ボックス（ext_phonebooth） */
const BOOTH: XZ = [-34.2, 4.06];
/** なお（立ち姿）：鳥居の下。目隠しの参道の W0 */
const TORII_NAO: V3 = [-40, 0, -7.6];
const RING_AT = new THREE.Vector3(-40, 1.2, -7.6);
const LOOK_TORII = new THREE.Vector3(-40, 1.4, -7.6);
/** 祠の前で番をするなお（座り姿） */
const HOKORA_SEAT: V3 = [-38.9, 0, -45.4];
/** 偽の鈴：拝殿の東側 */
const FAKE_BELL = new THREE.Vector3(-34.6, 1.0, -36.5);
/**
 * 目隠しの参道（鳥居→狛犬→拝殿の西脇→祠）。シナリオの W0〜W4＋祠の前に、実際の当たり判定で
 * 通れるよう中継点を足した（実機で歩いて確認）:
 *  - 鳥居の当たり判定は幅いっぱい（x∈[-42.3,-37.7]）で中央を抜けられないので、西の柱の外を回る
 *  - 拝殿（x∈[-44.1,-35.9], z∈[-39.6,-32.5]）の西の前角・後ろ角を回る
 *  - 拝殿の裏の杉（shr_cedar_23: x∈[-45.8,-43.4], z∈[-43.6,-41.2]）の東を抜ける
 */
const SANDO: XZ[] = [
  [-40, -7.6], // W0 鳥居の下
  [-43.1, -7.2], // 鳥居の西の柱の外
  [-40.3, -9.8], // 鳥居の奥
  [-40, -18], // W1
  [-40, -28.3], // W2 狛犬のあいだ
  [-45.4, -31.0], // 拝殿の西の前角
  [-45.6, -36], // W3 拝殿の西脇
  [-45.0, -40.35], // 拝殿の西の後ろ角
  [-42.6, -40.4], // 拝殿の裏、杉の東
  [-41.2, -44.2], // W4
  [-40, -45.2], // 祠の前
];
/** なおがこの番号の地点へ移った＝プレイヤーが W2→W3 を歩いている（偽の鈴の区間） */
const FAKE_LEG = 5;
/** なおが次へ移る距離（1.8m）。W0 だけは鳥居の手前（当たり判定の前）から届くよう広げる */
const reachOf = (i: number): number => (i === 0 ? 2.6 : 1.8);

type Phase =
  | 'fridge' // 目を閉じたまま、冷蔵庫を閉める
  | 'behind' // うしろを確かめる
  | 'talk1' // なおと話す（ベッドの脇）
  | 'fake' // 玄関を確かめる（偽のなお）
  | 'talk2' // なおと話す（偽のなおのあと）
  | 'town' // 公衆電話から、張り紙の番号にかける
  | 'torii' // なおと話す（鳥居の前）
  | 'confess' // 告白の最中
  | 'faces' // 目を閉じる
  | 'choosing' // 最後の選択
  | 'homeA' // ルートA：ベッドへ
  | 'lyingA' // ルートA：朝まで
  | 'incense' // ルートC：コンビニで線香を買う／鳥居の前に戻る
  | 'sando' // ルートC：目を閉じたまま、鈴の音についていく
  | 'hokora' // ルートC：祠に供える
  | 'watch' // ルートC：目を閉じて、眠る（なおが番をする）
  | 'ending';

interface Run {
  c: Ctx;
  intro: () => Promise<void>;
  tick: (dt: number) => void;
}

/** the live run of this chapter (rebuilt by every setup, also on retry) */
let run: Run | null = null;

export const ch5_night: ChapterDef = {
  id: 'ch5_night',
  title: '三日目',
  subtitle: '八月三十一日　午前三時',
  time: 'night',
  // 冷蔵庫の正面（spawn_kitchen より半歩、冷蔵庫に寄せた位置。庫内の顔まで約0.6m）
  spawn: { pos: [-21.08, 0, 10.0], yaw: 90 },
  wakeUp: false,
  clock: { h: 3, m: 0, rate: 0.05 },
  ambience: 'room_tone',
  gameOverReason: '白い顔と、ふたつ数えるあいだ目が合ってしまった。',
  setup(c) {
    run = build(c);
  },
  async intro(c) {
    if (run && run.c === c) await run.intro();
  },
  update(c, dt) {
    if (run && run.c === c) run.tick(dt);
  },
};

function build(c: Ctx): Run {
  const g = c.game;
  const tag = c.checkpointTag;

  // ── run state ────────────────────────────────────────────────────────────
  let phase: Phase = 'fridge';
  let introDone = tag !== null;
  let closing = false;
  let busy = false;
  let alarm: SoundHandle | null = null;
  let stare: SoundHandle | null = null;
  let crows: SoundHandle | null = null;
  let peeping = false;
  let windOn = false;
  let naoSit: Npc | null = null;
  let naoStand: Npc | null = null;
  let behindT = 0;
  let shrineGateSaid = false;
  // route A
  let cornerFace: Face | null = null;
  let fearT = 0;
  let prevClosed = false;
  let lastOpenSub = -99;
  // route C: 参道
  let wi = 0;
  let prevWp: XZ = SANDO[0];
  let sandoGen = 0;
  let sandoFaces: Face[] = [];
  let facesSpawned = false;
  let openInShrine = false;
  let warnCount = 0;
  let offT = 0;
  let corrCool = 0;
  /** 偽の鈴でまぶたをこじ開けられている最中 */
  let prying = false;
  let fake: 'idle' | 'armed' | 'rang' | 'event' | 'done' = 'idle';
  let fakeT = 0;
  // 冒頭：閉眼中の心音
  let fridgeFearT = 0;
  // route C: 番
  let hokoraFace: Face | null = null;
  let closedStreak = 0;
  let lure = 0;
  let staring = false;
  let calmCool = 0;
  let T = 0;

  // ── helpers ──────────────────────────────────────────────────────────────
  const num = (k: string): number => Number(c.get(k) ?? 0) || 0;
  const trust = (): number => num('nao_trust');
  const free = (): boolean => !g.ui.blocking && g.lockCount === 0;
  const dist = (p: XZ): number => Math.hypot(g.player.pos.x - p[0], g.player.pos.z - p[1]);
  /** angle (deg) between where the player faces and the direction to p */
  const angleTo = (p: XZ): number => {
    const dx = p[0] - g.player.pos.x;
    const dz = p[1] - g.player.pos.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3) return 0;
    const y = g.player.yaw;
    const dot = (-Math.sin(y) * dx - Math.cos(y) * dz) / L;
    return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
  };
  /** camera-convention yaw (deg) looking from a to b */
  const yawToward = (a: XZ, b: XZ): number => Math.atan2(-(b[0] - a[0]), -(b[1] - a[1])) / DEG;
  const segDist = (p: XZ, a: XZ, b: XZ): number => {
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const L2 = vx * vx + vz * vz;
    const t = L2 > 1e-6 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / L2)) : 0;
    return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vz * t));
  };
  const playerXZ = (): XZ => [g.player.pos.x, g.player.pos.z];
  const v3 = (p: XZ, y: number): THREE.Vector3 => new THREE.Vector3(p[0], y, p[1]);
  /** checkpoint (the engine saves the in-game clock with it) */
  const cp = (t: string): void => c.checkpoint(t);
  /**
   * 5-0 ルール3：目を閉じている間に会話ウィンドウを出すときは、先に強制的に閉じる
   * （エンジンはモーダル表示中に目を開けてしまう）。場所トリガーなど、いつ出るか分からない台詞に使う
   */
  const keepShut = async (show: () => Promise<void>): Promise<void> => {
    const shut = g.eyes.closed && g.eyes.force === null;
    if (shut) c.eyes(true);
    await show(); // Aborted（章の終了）なら、新しい章の目の状態には触れない
    if (shut && g.eyes.force === true) c.releaseEyes();
  };
  const monoEyes = (t: string | string[]): Promise<void> => keepShut(() => c.mono(t));
  const sayEyes = (who: string, t: string | string[]): Promise<void> => keepShut(() => c.say(who, t));
  const startCrows = (): void => {
    if (!crows || !crows.playing) crows = c.loop('crows', { volume: 0.9 });
  };
  /** ルートAの目標（QA3：横になる操作が要ることも目標に書く） */
  const objA = (n: number): void => c.objective(`ベッドで横になり、朝まで目を閉じて眠る（${n}/3）`);
  const hideSmoke = (): void => {
    const h = c.prop('shr_hokora');
    for (let i = 0; i < 4; i++) h.showNode(`smoke_${i}`, false);
  };
  /** この章で消した灯り。c.time() で時刻の既定に戻されたあとも、これで消し直す */
  const applyNightLights = (): void => {
    c.light('shrine_office_light').setOn(false); // 鳥居の奥は、真っ暗
    if (c.is('ch5_lamp_s1')) c.light('lamp_pole_s1').setOn(false);
    if (c.is('ch5_lamp_n2')) c.light('lamp_pole_n2').setOn(false);
    if (c.is('ch5_lamp_n1')) c.light('lamp_pole_n1').setOn(false);
    if (windOn) {
      // 顔たちが来たあと：電話ボックスと、その上の街灯は消えたまま
      c.light('phonebooth_light').setOn(false);
      c.light('lamp_pole_s0').setOn(false);
    }
  };
  /** [TIME:dawn]（街灯などは時刻の既定に戻るので、消した灯りを消し直す） */
  const dawn = (): void => {
    c.time('dawn');
    applyNightLights();
  };

  // ── NPC: なお（立ち姿と座り姿は同時に出さない）────────────────────────
  const naoSitDef: InteractDef = {
    label: () => (phase === 'talk1' || phase === 'talk2' ? 'なおに話しかける' : null),
    range: 2.8,
    blind: false,
    use: async () => {
      if (phase === 'talk1') await talk1();
      else if (phase === 'talk2') await talk2();
    },
  };
  const naoStandDef: InteractDef = {
    label: () => (phase === 'torii' || phase === 'incense' ? 'なおに話しかける' : null),
    range: 2.8,
    blind: false,
    use: async () => {
      if (phase === 'torii') await confession();
      else if (phase === 'incense') {
        if (c.has('incense')) await sandoIntro();
        else await c.say('なお', 'コンビニ、開いてるよ。……ここで、待ってる');
      }
    },
  };
  const showNaoSit = (at: string | V3, yaw: number, glow: boolean): void => {
    if (naoStand) {
      c.hideNpc('npc_nao');
      naoStand = null;
    }
    naoSit = c.npc('npc_nao_sit', { at, yaw, phoneGlow: glow });
    c.on('npc_nao_sit', naoSitDef);
  };
  const showNaoStand = (at: V3, yaw: number, o: { glow?: boolean; look?: boolean } = {}): void => {
    if (naoSit) {
      c.hideNpc('npc_nao_sit');
      naoSit = null;
    }
    naoStand = c.npc('npc_nao', { at, yaw, phoneGlow: !!o.glow, lookAtPlayer: o.look ?? true });
    c.on('npc_nao', naoStandDef);
  };
  /** なおの頭のほうを向く（見えているほうの姿） */
  const lookAtNao = (sec = 0.8): Promise<void> => c.lookAt(naoSit ? 'npc_nao_sit' : 'npc_nao', sec);

  // ══ 0. 冷蔵庫の前で ═══════════════════════════════════════════════════════
  async function intro(): Promise<void> {
    await c.cutscene(async () => {
      c.eyes(true);
      await c.wait(0.6);
      await c.mono(['……寒い', '冷気が、顔に当たってる。何かが、ピー、ピーって鳴ってる', '……冷蔵庫の、警告音？', '俺、冷蔵庫の前に、立ってる']);
      c.fear(0.6, 5);
      await c.mono('目を開けるな。――なぜか、そう思った');
      // 視線は冷蔵庫の中段（開ければ顔が目の前。正面のままだと上の電子レンジを狙ってしまう）
      await c.lookAt(c.anchor('anc_fridge_inside'), 0.01);
    });
    c.hint('[Space] を押している間は目を閉じたまま。閉じたまま [E] で冷蔵庫を閉められる', 10);
    c.objective('目を閉じたまま、冷蔵庫を閉める');
    // 閉じたまま [E] で閉められることを保証する：狙っていなくても、閉眼中は冷蔵庫が調べる対象になる
    c.blindTarget('apt_fridge');
    // F5-1: 閉眼のうちに出し（心音は閉眼中も tick が鳴らす）、そのまま目を解放する。開けていれば目の前
    c.face('anc_fridge_inside', { type: 'static', lethal: 4 });
    fridgeFearT = 0;
    c.releaseEyes();
    introDone = true;
  }

  async function closeFridge5(): Promise<void> {
    if (c.is('closed_fridge5') || closing) return;
    closing = true;
    c.blindTarget(null);
    const p = c.prop('apt_fridge');
    c.sfx('fridge_close', { at: 'apt_fridge' });
    void p.animate(0, 'door', 0.55);
    c.light('apt_fridge_light').setOn(false);
    alarm?.stop(0.15);
    alarm = null;
    c.clearFace('anc_fridge_inside');
    c.set('closed_fridge5');
    await c.wait(0.6);
    await monoEyes('……閉めた');
    phase = 'behind';
    behindT = 0;
    c.objective('うしろを確かめる');
  }

  // ══ 1. うしろの白い顔 ═════════════════════════════════════════════════════
  async function behindScene(): Promise<void> {
    // 振り向いて見るところまでは短いカットシーン（その間に目を閉じて、見えないはずの物を「見る」ことがないように）
    await c.cutscene(async () => {
      if (angleTo(BEDSIDE) > 50) await lookAtNao(1.0);
      await c.mono(['ベッドのほうに、白い顔が浮いてる', '……でも、耳鳴りがしない']);
    });
    await c.wait(1.5);
    c.sub('なお', '……起きた？');
    c.set('ch5_saw_nao');
    phase = 'talk1';
    busy = false;
    c.objective('なおと話す');
  }

  // ══ 2. なおと話す → ピンポン ═════════════════════════════════════════════
  async function talk1(): Promise<void> {
    if (phase !== 'talk1' || busy) return;
    busy = true;
    await c.say('透', '……なお？　いつから、いたの');
    await c.say('なお', ['……ちょっと前', '今日は来ないって言ったのに。……ごめん']);
    // QA19: the red REC dot is on her side of the phone — from the lens side only the lens shows
    await c.mono('スマホのレンズが、こっちを向いてる');
    await c.say('透', '……撮ってるの？');
    await c.say('なお', '…………');
    if (naoSit) naoSit.phoneGlow = false;
    await c.mono('なおは、スマホを膝に伏せた');
    await c.wait(1.0);
    c.clock(3, 2, 0.05);
    c.sfx('doorbell', { at: 'apt_door' });
    await c.wait(1.2);
    // 待ちの間は操作できるので、目を閉じていたら閉じたまま出す（ルール3）
    await monoEyes('……ピンポン');
    // knock の音そのものが三回叩く
    c.sfx('knock', { at: 'apt_door' });
    await c.wait(1.3);
    c.sub('？？？', '透くん？　……私。なお。開けて', 4);
    await c.lookAt('apt_door', 0.9);
    await monoEyes('なおの声。……なおは、ここにいるのに');
    c.sub('なお', '……透くん？　どうしたの、玄関なんか見て', 4);
    c.set('ch5_talk1');
    phase = 'fake';
    stare = c.loop('stare', { at: 'apt_door', volume: 0.15 });
    c.objective('玄関を確かめる');
    busy = false;
    c.run(fakeNao);
  }
  /** 共通ルール5：立ち姿・座り姿の切り替えや退出は、暗転の間に済ませる */
  const inDark = async (fn: () => void | Promise<void>, out = 0.45, back = 0.45): Promise<void> => {
    await c.fadeOut(out);
    await fn();
    await c.fadeIn(back);
  };

  // ══ 3. 偽のなお（玄関）════════════════════════════════════════════════════
  async function fakeNao(): Promise<void> {
    const lines = ['……透くん？　開けて', 'ねえ。私だよ。開けて', '……しずくは、あけてくれたよ'];
    let t = 0;
    let mode: 'wait' | 'near' | 'far' = 'wait';
    let next = 0;
    let idx = 0;
    while (idx < lines.length) {
      await c.wait(0.1);
      t += 0.1;
      if (mode === 'wait') {
        if (peeping || c.inZone('zone_apt_genkan')) {
          mode = 'near';
          next = t;
        } else if (t >= 15) {
          // 玄関に来ないまま15秒：同じ字幕を遠くから流して終える
          mode = 'far';
          next = t;
        }
      }
      if (mode !== 'wait' && t >= next) {
        c.sub('？？？', lines[idx], 3.6);
        if (idx === lines.length - 1) {
          // 強く一度（knock は三連打の音なので、重い一打で代える）
          c.sfx('thud', { at: 'apt_door', volume: mode === 'far' ? 0.9 : 1.4 });
          c.sfx('chain_rattle', { at: 'apt_door', volume: mode === 'far' ? 0.4 : 0.7 });
          c.shake(0.4);
        }
        idx++;
        next = t + 4;
      }
    }
    await c.wait(1.6);
    stare?.stop(0.4);
    stare = null;
    c.clearFace('anc_door_outside');
    await monoEyes('……止んだ');
    c.set('fake_done');
    phase = 'talk2';
    c.objective('なおと話す');
  }

  async function peep(): Promise<void> {
    await c.peephole({
      onEnter: () => {
        peeping = true;
        if (phase === 'fake') {
          // F5-2: 偽のなおの最中だけ
          c.face('anc_door_outside', { type: 'static', lethal: 2.5 });
          c.run(async () => {
            await c.mono('レンズいっぱいの白い顔。……口が、なおの声で動いてる');
            // 覗き穴の中でも目を閉じられる。離れ方もここで示す（初見の即死を避ける）
            if (peeping) c.hint('[Space] で目を閉じる　[E] で覗き穴から離れる', 6);
          });
        }
      },
    });
    peeping = false;
    c.clearFace('anc_door_outside');
  }

  // ══ 4. なおと話す（偽のなおのあと）→ なおが出ていく ═════════════════════
  async function talk2(): Promise<void> {
    if (phase !== 'talk2' || busy) return;
    busy = true;
    await c.say('なお', '……誰と、話してたの');
    await c.say('透', '……玄関に、なおが');
    await c.say('なお', ['……私は、ここにいるよ', '透くん。……また夢見てるんだよ。病気なんだから', 'ほら、ベッド戻ろ。目、つぶって。……大丈夫だから']);
    await c.mono(['病気。――そうかもしれない', 'でも、なおは。どうして毎晩、ここにいるんだ']);
    const opts: { text: string; run: () => Promise<void> }[] = [
      { text: 'なおの名字、なんていうの', run: () => c.say('なお', ['……え？', '……どうして、今そんなこと']) },
    ];
    if (['saw_key', 'heard_lock', 'hatsu_saw', 'slept_ch3'].some((k) => c.is(k))) {
      opts.push({ text: '……鍵、持ってるよな', run: () => c.say('なお', '…………') });
    }
    if (c.is('heard_whisper')) opts.push({ text: 'しずくって、誰', run: () => c.say('なお', '……っ') });
    const i = await c.choice(opts.map((o) => o.text));
    await opts[i].run();
    await c.say('なお', '……ごめん。ちょっと、外の空気吸ってくる');
    // NPC は暗転中にだけ消す（共通ルール5）。チェーンと扉の音も暗いうちに聞かせる
    await c.cutscene(() =>
      inDark(async () => {
        c.hideNpc('npc_nao_sit');
        naoSit = null;
        await c.wait(0.5);
        c.sfx('chain', { at: 'apt_door' });
        c.lock('apt_door_chain', false);
        c.prop('apt_door').showNode('chain_hooked', false);
        c.prop('apt_door').showNode('chain_hanging', true);
        await c.wait(0.7);
        c.sfx('door_open', { at: 'apt_door' });
        c.lock('apt_door', false);
        await c.wait(1.2);
        c.sfx('door_close', { at: 'apt_door' });
        await c.wait(0.5);
      }, 0.5, 0.6),
    );
    await c.wait(0.4);
    await monoEyes(['……行っちゃった', '張り紙の番号。……しずくの、家族の番号', 'スマホは、電池が切れてる。公衆電話が、通りの先にある']);
    c.set('nao_left');
    phase = 'town';
    busy = false;
    cp('ch5_out');
    c.objective('公衆電話から、張り紙の番号にかける');
  }

  // ══ 5. 夜の町 → 公衆電話 ══════════════════════════════════════════════════
  async function callNumber(): Promise<void> {
    if (c.money < 10 && !c.has('coin10')) {
      await c.mono('……十円玉が、ない');
      c.set('ch5_need_coin');
      c.objective('十円玉を探す（アパート前の自販機）');
      return;
    }
    await c.cutscene(async () => {
      // なおは、受話器に向かっている今のうち（背後で見えていない間）に鳥居の下へ置く（共通ルール5）。
      // 鳴っているスマホを見ている顔が、振り向いた透から見えるよう、体は電話ボックスのほうへ向ける
      // （シナリオの yaw=0 は北＝境内向きで、背中しか見えないため）
      showNaoStand(TORII_NAO, yawToward([TORII_NAO[0], TORII_NAO[2]], BOOTH), { glow: true, look: false });
      c.sfx('coin', { at: 'ext_phonebooth' });
      await c.mono('受話器を取って、メモの番号を押す');
      await c.wait(1.0);
      c.sfx('ringtone', { volume: 0.35 });
      await c.mono('受話器の奥で、呼び出し音');
      await c.wait(2.0);
      // 13メートルうしろの鳥居から届くよう、距離減衰をゆるめる
      c.sfx('ringtone', { at: RING_AT.clone(), volume: 4, rolloff: 0.5 });
      await c.mono('……うしろで、鳴ってる');
      await c.lookAt(LOOK_TORII.clone(), 1.0);
      await c.mono(['鳥居の下に、白い顔。……スマホの光だ', '呼び出し音が、止まった']);
      await c.say('なお', '……しずく？');
      await c.mono('受話器と、背中の向こうから、同時に');
      await c.say('透', '……なお');
      c.sfx('thud', { at: RING_AT.clone(), volume: 3, rolloff: 0.5 });
      if (naoStand) naoStand.phoneGlow = false;
      await c.mono('なおの手から、スマホが落ちた');
    });
    if (c.money >= 10) c.addMoney(-10);
    else c.take('coin10');
    c.set('called');
    phase = 'torii';
    c.objective('なおと話す（鳥居の前）');
  }

  // ══ 6. 鳥居の前・告白 ═════════════════════════════════════════════════════
  async function confession(): Promise<void> {
    if (phase !== 'torii') return;
    phase = 'confess';
    // 話しかけた時点で lookAtPlayer を戻す。体の向きは一瞬の暗転で直す（共通ルール5）
    await c.fadeOut(0.25);
    showNaoStand(TORII_NAO, yawToward([TORII_NAO[0], TORII_NAO[2]], playerXZ()), { look: true });
    await c.fadeIn(0.3);
    await c.say('なお', ['……公衆電話からかかってくると、絶対出ちゃうの', 'あの夜から。知らない番号には、全部出るって決めた', '……宮内なお。張り紙の、宮内', 'しずくは、妹']);
    await c.mono('……やっぱり');
    // QA16: 第2章の洗濯ネット（trace_washer）は、ここで一言だけ回収する
    if (c.is('trace_washer')) {
      await c.say('透', '洗濯機に、『みやうち』って書いた洗濯ネットが挟まってた');
      await c.say('なお', '……しずくの洗濯ネット。……まだ、あったんだ');
    }

    // 証拠の突きつけ：持っている証拠だけ、各1回まで。f か、出せる証拠が尽きたら抜ける
    const used = new Set<string>();
    for (;;) {
      const ev = evidence().filter((e) => !used.has(e.id));
      if (!ev.length) break;
      const i = await c.choice([...ev.map((e) => e.text), '……もういい。全部、話してくれ']);
      if (i >= ev.length) break;
      used.add(ev[i].id);
      await ev[i].run();
    }

    // 告白の核
    await c.say('なお', [
      '……最初はね。空っぽのこの部屋に、夜だけ入ってた。合鍵で',
      '真っ暗な部屋で、しずくに話しかけてた。返事なんか、ないのに',
      '春に透くんが越してきて、入れなくなった。……鍵で入ったら、泥棒でしょ。入れてほしかったの。だから、コンビニで声をかけた',
      // QA9/QA10: the first night (D03 5/13 → D16 5/14 03:02). She had told him about her sister that
      // evening, so what he said in his sleep was her own story coming back — not a second hard mystery
      // (the voicemail stays the only one)
      '五月に、傘を返しに来た夜。遅くまで話して……はじめて、妹の話をしたの。名前は言わないで',
      'ひまわり畑のこと。『お姉ちゃん』って、どこにでもついてきたこと',
      '三時に、寝てた透くんが起き上がって、私を『お姉ちゃん』って呼んだ',
      'さっき話したばかりのことを、返してきたの。……あの子の話し方に、聞こえた。それから、やめられなくなった',
      '透くんが寝たあと、鍵で入って、枕元に座って。撮って、録って、あの子の話をして。手を握って、返事を待った',
      '病院、行かなくていいって言ったのは……治ったら、もうあの子の声が聞けなくなると思ったから',
      '一日目の夜も、いたよ。透くんが急に起きたから、クローゼットに隠れて、目をつぶってた',
      // QA14: クローゼットの中で目をつぶっていたなおには、透の目の開閉は分からない
      '透くん、戸を閉めてくれたよね。……閉まる音で、見つかったと思った',
    ]);
    await c.mono('……あのとき。中で、何か落ちた音');
    await c.say('なお', '……見てたのは、ずっと私だよ。五月から、毎晩'); // QA9（D16・D03 と同じ）
    if (naoStand) naoStand.phoneGlow = true;
    await c.mono('なおが、拾ったスマホをこちらに向けた');
    await c.doc('doc_nao_phone');
    await c.mono(['五月の半ばから、ほとんど毎晩の動画。いちばん新しいのは、今夜の二時五十八分', 'それから、留守番電話。……「未再生」']);
    await c.say('なお', [
      '一年前の今日、三時二分。しずくから電話があった',
      '……出なかった。眠かったから。それだけの理由で',
      '次の朝には、もういなかった',
      '留守電、一回も聞けてない。聞いたら、あの子がほんとに終わっちゃう気がして',
    ]);
    await c.say('透', '……なおは、俺を見てたんじゃないんだな');
    await c.say('なお', ['…………', '……透くんを見てたんじゃない。しずくを、探してた']);
    await c.mono(['顔も。なおも', '俺を見ていたんじゃなかった', '見ていたのは、ずっと――俺の中の、しずくだ']);
    const k = await c.choice(['……話してくれて、ありがとう', '…………', '……もう、俺の前に来ないでくれ']);
    if (k === 0) {
      c.inc('nao_trust', 2);
      await c.say('なお', '……っ');
      await c.mono('なおは、声を殺して泣いた');
    } else if (k === 1) {
      c.inc('nao_trust', 1);
      await c.say('なお', '……うん');
    } else {
      c.inc('nao_trust', -2);
      c.set('ch5_sent_away'); // QA24: ルートAのなおの台詞を「朝までだけ」にする
      await c.say('なお', '……うん。……そうだよね');
    }
    c.set('ch5_confessed');
    cp('ch5_choice');
    c.run(facesCome);
  }

  function evidence(): { id: string; text: string; run: () => Promise<void> }[] {
    const list: { id: string; text: string; run: () => Promise<void> }[] = [];
    if (['saw_key', 'heard_lock', 'hatsu_key', 'hatsu_saw', 'slept_ch3'].some((k) => c.is(k))) {
      list.push({ id: 'a', text: '合鍵、持ってるよな', run: () => c.say('なお', ['……うん。あの子の荷物を片付けたとき、一本だけ返さなかった', '……毎晩、使ってた']) });
    }
    if (c.is('heard_whisper')) {
      list.push({
        id: 'b',
        text: '寝てる俺に、しずくの話をしてただろ',
        run: () => c.say('なお', ['……聞こえてたんだ', 'ひまわり畑のこと。夜中のミルクティーのこと。あの子が、マステでブレーカー留めてたこと', '眠ってる透くんの耳もとで、毎晩']),
      });
    }
    if (c.has('diary')) {
      list.push({
        id: 'c',
        text: 'しずくの日記だ。……最後のほうを、見てくれ',
        run: () => c.say('なお', ['……これ、しずくの字じゃない。最後のほう、透くんの字だよ。『め』が、くるってなってる', 'でも……『め　つぶってたら　だいじょうぶ』って', 'それ、私が小さいころ、あの子に言った言葉']),
      });
    }
    if (c.has('hairpin')) {
      // QA15: she has been gone one year — 「毎年」 is the birthday present, not the offering (birthday = 8/30)
      list.push({ id: 'd', text: '祠のヘアピン', run: () => c.say('なお', ['……私が置いたの。あの子の誕生日には、毎年ヘアピンをあげてたから', '……今年も。一年前のなんかじゃないよ。ただの、新品']) });
    }
    // QA16: 第2章・第4章で見つけた、なおの物（trace_closet / trace_tv）
    if (c.is('trace_closet')) {
      list.push({ id: 'g', text: 'クローゼットのヘアゴム', run: () => c.say('なお', ['……それ、私の', 'クローゼットの中で、落としたんだと思う']) });
    }
    if (c.is('trace_tv')) {
      list.push({ id: 'h', text: 'テレビの裏の充電器', run: () => c.say('なお', ['……毎晩、あそこで充電してた', '透くんが、寝てるあいだ']) });
    }
    if (c.has('milktea')) {
      list.push({
        id: 'e',
        text: '……これ',
        run: async () => {
          c.take('milktea');
          c.inc('nao_trust', 1);
          await c.say('なお', ['……ミルクティー', 'しずく、夜中にコンビニ行くたび、これ買ってきてくれたの。……私の、好きなやつ']);
        },
      });
    }
    return list;
  }

  // ══ 7. 顔たちが来る → 最後の選択 ══════════════════════════════════════════
  async function facesCome(): Promise<void> {
    phase = 'faces';
    c.light('phonebooth_light').setOn(false);
    c.light('lamp_pole_s0').setOn(false);
    c.sfx('face_appear', { at: 'anc_phonebooth' });
    // F5-3: さっきまで透がいた電話ボックスの中（透の背後）
    c.face('anc_phonebooth', { type: 'static' });
    windOn = true;
    c.ambience('wind');
    c.sub('なお', '……透くん、うしろ。……目、つぶって！', 4);
    c.objective('目を閉じる');
    c.when(() => g.eyes.closed, () => finalChoice());
  }

  async function finalChoice(): Promise<void> {
    if (phase !== 'faces') return;
    phase = 'choosing';
    c.eyes(true);
    await c.mono('冷たい手が、俺の手をつかんだ');
    await c.say('なお', '……手、にぎってて');
    const i = await c.choice(['……帰ろう。今夜は、ちゃんと眠る', 'しずくを、送りに行こう']);
    if (i === 0) await routeA();
    else await routeC();
  }

  // ══ 8A. ルートA（部屋で、朝まで眠る）══════════════════════════════════════
  async function routeA(): Promise<void> {
    c.set('route', 'A');
    c.clearFace('anc_phonebooth');
    await c.fadeOut(1.2);
    await c.narrate('目をつぶったまま、なおに手を引かれて、部屋まで帰った。');
    c.teleport('spawn_bed');
    setupHome();
    windOn = false;
    c.ambience('room_tone');
    await c.wait(0.4);
    await c.fadeIn(1.2);
    c.releaseEyes();
    await c.mono('机の上の薬を、なおが水と一緒に渡してくれた。……飲んだ');
    if (c.is('ch5_sent_away')) {
      // QA24: 「もう、俺の前に来ないでくれ」と言われたあと
      await c.say('なお', ['……朝までだけ。そしたら、帰るから', '手は、にぎらない。……ここに、座ってるだけ']);
    } else {
      await c.say('なお', ['……ここにいるから。朝まで', 'こわかったら、手、にぎってて。……ここのつ、こわけりゃ、てをつなげ、でしょ']);
    }
    cp('ch5_home');
    objA(0);
  }

  /** 部屋（ルートA）：なおはベッドの脇、電気は消え、玄関はなおが閉めた */
  function setupHome(): void {
    phase = 'homeA';
    showNaoSit('npc_nao_bedside', -90, false);
    c.power(false);
    c.breaker('sw_2', false);
    const door = c.prop('apt_door');
    door.setOpen(0, 'leaf');
    c.lock('apt_door', true);
    c.lock('apt_door_chain', true);
    door.showNode('chain_hooked', true);
    door.showNode('chain_hanging', false);
    c.prop('apt_fridge').setOpen(0, 'door');
    c.light('apt_fridge_light').setOn(false);
  }

  async function lieDownA(): Promise<void> {
    if (phase !== 'homeA') return;
    phase = 'lyingA';
    await c.lieAwake();
    // F5-4A: 目を閉じている間だけ近づく
    cornerFace = c.face('anc_room_corner', { type: 'approach', speed: 0.15, minDist: 1.0 });
    prevClosed = g.eyes.closed;
    c.hint('[Space] で目を閉じる。……今夜は、閉じたままでいい', 9);
  }

  /** 8秒閉じ続けるたびに一段階（ゲーム内の眠り）。三段階で朝 */
  function stageA(): boolean {
    const s = c.inc('stage_a');
    if (s === 1) {
      c.clock(3, 40, 0.05);
      c.sfx('breathing', { at: cornerFace?.alive ? cornerFace.pos.clone() : c.anchor('anc_room_corner') });
      objA(1);
      c.run(async () => {
        c.sub(null, '（部屋の隅から、近い）', 2.6);
        await c.wait(2.8);
        c.sub('なお', '……三時四十分。まだ暗いね', 3.2);
      });
    } else if (s === 2) {
      c.clock(4, 30, 0.05);
      // F5-5A: 真上
      c.face('anc_ceiling_bed', { type: 'static' });
      c.fear(0.5, 6);
      c.sub('なお', '大丈夫。……見てるから', 3.2);
      objA(2);
    } else {
      c.clock(5, 20, 0.05);
      startCrows();
      c.sub('なお', '……明るくなってきた', 3.2);
      c.clearFaces();
      cornerFace = null;
      phase = 'ending';
      c.run(end1Home);
    }
    return true;
  }

  // ══ 8C. ルートC（祠へ、しずくを送りに）════════════════════════════════════
  async function routeC(): Promise<void> {
    c.set('route', 'C');
    c.clearFace('anc_phonebooth');
    c.releaseEyes();
    if (c.is('knows_rite')) await c.say('透', '宮司さんが言ってた。あの子のものと線香を祠に供えて、身内がひと晩、寝ずの番をするんだって');
    else await c.say('透', '……あの子のものと線香を祠に供えて、身内が、寝ずの番をするんだって。由緒書きに、書いてあった');
    await c.say('なお', '……私が、番を？');
    if (trust() >= 2) await c.say('なお', '……うん。やる。今度は、ちゃんと起きてる');
    else await c.say('なお', '……できるかな。私、見たら、またあの子を探しちゃう');
    if (!c.has('incense')) {
      await c.mono('線香……持ってない');
      await c.say('なお', 'コンビニ、開いてるよ。……ここで、待ってる');
      c.set('ch5_incense_wait');
      phase = 'incense';
      c.objective('コンビニで線香を買う');
      c.when(() => c.has('incense'), () => {
        if (phase === 'incense') c.objective('鳥居の前に戻る');
      });
      return;
    }
    await sandoIntro();
  }

  async function sandoIntro(): Promise<void> {
    if (phase !== 'choosing' && phase !== 'incense') return;
    phase = 'confess'; // 会話中はなおに話しかけられない
    await c.say('なお', ['境内に入ったら、祠に着くまで目を開けちゃだめ。……しずくが、そう言ってた', '鈴、鳴らすから。……ついてきて']);
    c.sfx('suzu', { at: v3(SANDO[0], 1.0), volume: 1.6 });
    cp('ch5_sando');
    startSando();
  }

  // ── 目隠しの参道 ──
  function startSando(): void {
    phase = 'sando';
    wi = 0;
    prevWp = SANDO[0];
    facesSpawned = false;
    sandoFaces = [];
    openInShrine = false;
    warnCount = 0;
    offT = 0;
    corrCool = 1.5;
    fake = 'idle';
    prying = false;
    // なおはもう W0（鳥居の下）に立っている：目の前で置き直さない（共通ルール5）。再開時だけ置く
    const at = naoStand?.visible ? naoStand.root.position : null;
    if (naoStand && at && Math.hypot(at.x - SANDO[0][0], at.z - SANDO[0][1]) < 0.05) {
      naoStand.lookAtPlayer = false;
      naoStand.phoneGlow = false;
    } else placeNao(0);
    c.objective('目を閉じたまま、鈴の音についていく');
    c.hint('[Space] を押したまま歩ける。鈴の鳴るほうへ', 9);
    const gen = ++sandoGen;
    c.run(async () => {
      // なおは3秒ごとに、自分の位置で鈴を3回（チリン、チリン、チリン）
      while (phase === 'sando' && gen === sandoGen) {
        for (let k = 0; k < 3; k++) {
          ring(SANDO[wi]);
          await c.wait(0.42);
        }
        await c.wait(2.2);
      }
    });
  }

  function placeNao(i: number): void {
    const [x, z] = SANDO[i];
    showNaoStand([x, 0, z], yawToward(SANDO[i], playerXZ()), { look: false });
  }

  function ring(p: XZ, volume = 1.6): void {
    c.sfx('suzu', { at: v3(p, 1.0), volume, rate: 0.97 + Math.random() * 0.06 });
  }

  function spawnSandoFaces(): void {
    facesSpawned = true;
    // F5-4C / F5-5C: 見ていない間だけ近づき、minDist で止まる
    sandoFaces = [
      c.face('anc_shinboku', { type: 'approach', speed: 0.35, minDist: 1.2 }),
      c.face('anc_haiden', { type: 'approach', speed: 0.35, minDist: 1.2 }),
    ];
  }

  async function ringFake(): Promise<void> {
    for (let k = 0; k < 2; k++) {
      c.sfx('suzu', { at: FAKE_BELL.clone(), volume: 1.7, rate: 0.93 });
      await c.wait(0.42);
    }
    c.sub('？？？', 'お姉ちゃん、こっち', 3);
  }

  /**
   * 偽の鈴に4m以内まで寄ったとき。即死はさせない（QA26）：
   * まぶたは c.lid で細く開けるだけで、強制的に目を開けることはしない（lid>0.5 の間は顔を見たことにならない）。
   * 向き直らなければ、まぶたをもう少しこじ開けられる → いったん閉じきって1秒 → 手放してなおのほうを向く。
   */
  async function fakeEvent(): Promise<void> {
    prying = true;
    c.fear(0.8, 3);
    c.sub(null, '（まぶたに、冷たい指が――）', 3);
    c.lid(0.6); // まぶたが細く開く
    let t = 0;
    let turned = false;
    while (t < 3) {
      await c.wait(0.1);
      t += 0.1;
      if (phase !== 'sando') break;
      if (angleTo(SANDO[wi]) < 50) {
        turned = true;
        break;
      }
    }
    if (!turned && phase === 'sando') {
      // 隙間から、境内が少しだけ見える（それでも顔とは目が合わない）
      c.fear(1, 1.6);
      c.shake(0.5);
      c.lid(0.53);
      await c.wait(1.2);
      // 閉じきってから手放す。付きまとう顔の凝視の残りも消しておく
      c.eyes(true);
      c.lid(null);
      for (const f of sandoFaces) f.gaze = 0;
      await c.wait(1.0);
      for (const f of sandoFaces) f.gaze = 0;
      c.releaseEyes();
      prying = false;
      await c.lookAt(v3(SANDO[wi], 1.4), 0.6);
    } else c.lid(null);
    prying = false;
    fake = 'done';
  }

  function arrive(): void {
    phase = 'hokora';
    c.sub('なお', '……着いた。目、開けていいよ。祠だけ見て', 4);
    c.clearFace('anc_shinboku');
    c.clearFace('anc_haiden');
    sandoFaces = [];
    showNaoSit(HOKORA_SEAT, 90, true);
    c.set('ch5_arrived');
    c.objective('祠に、しずくのものと線香を供える');
  }

  async function offer(): Promise<void> {
    if (phase !== 'hokora' || c.is('offered')) return;
    const h = c.prop('shr_hokora');
    c.take('incense');
    h.showNode('incense', true);
    await c.mono('マッチを擦った。線香の煙が、まっすぐ上っていく');
    if (c.take('diary')) {
      h.showNode('diary_offer', true);
      await c.mono('しずくの日記を、祠の前に置いた');
    }
    if (c.has('hairpin')) {
      c.take('hairpin');
      h.showNode('hairpin', true);
      await c.mono('ひまわりのヘアピンを、返した');
    }
    c.set('offered');
    await c.say('なお', ['……透くんは、目をつぶって。眠って', '私が、番してる。線香、絶やさないから']);
    if (trust() >= 2) await c.say('なお', '今夜は、透くんだけ見てる');
    else await c.say('なお', '……ちゃんと、見てられるかな');
    phase = 'watch';
    closedStreak = 0;
    lure = 0;
    c.objective('目を閉じて、眠る（なおが番をする）');
    c.hint('[Space] 長押しで目を閉じる', 8);
  }

  // ══ エンディングのゲーム内場面 ═══════════════════════════════════════════
  /** END1（ルートA）：朝まで目を閉じ続けた */
  async function end1Home(): Promise<void> {
    c.objective(null);
    await c.wait(2.6);
    await c.cutscene(async () => {
      await c.fadeOut(1.6);
      c.clearFaces();
      await c.getUp();
      dawn();
      c.ambience('tsukutsuku');
      await lookAtNao(0.01);
      await c.wait(0.5);
      await c.fadeIn(1.6);
      startCrows();
      await c.mono(['……朝だ', '夢を、見なかった']);
      await c.say('なお', '……おはよう');
      await c.say('透', '……おはよう');
      await c.say('なお', ['何も、言わなかったよ。透くん、朝まで、ただ寝てた', '……よかった']);
      c.sfx('suzu', { at: 'apt_lowtable' });
      await c.mono('なおが、鈴のついた鍵をテーブルに置いた');
      await c.say('なお', ['これ、返す', 'ちゃんと治して。……もう、来ないから']);
      // 共通ルール5：見ている前で消さない。退出は暗転の間に、扉の音も暗いうちに
      await inDark(async () => {
        c.hideNpc('npc_nao_sit');
        naoSit = null;
        await c.wait(0.6);
        c.sfx('door_close', { at: 'apt_door' });
        await c.wait(1.1);
      }, 0.6, 0.9);
      await c.mono('「103」の札が、朝の光の中で白かった');
    });
    await c.ending('end1_ohayou');
  }

  /** END1（ルートC・祠）：nao_trust が2未満のまま眠った */
  async function end1Shrine(): Promise<void> {
    c.objective(null);
    await c.cutscene(async () => {
      c.eyes(true);
      await c.fadeOut(1.6);
      c.clearFaces();
      hokoraFace = null;
      hideSmoke(); // 線香は、途中で消えていた
      dawn();
      c.clock(5, 20, 0.05);
      c.ambience('tsukutsuku', 0.6);
      if (naoSit) naoSit.phoneGlow = false;
      await lookAtNao(0.01);
      await c.wait(1.0);
      c.releaseEyes();
      await c.fadeIn(1.6);
      startCrows();
      await c.mono(['……朝だ', '祠の前の石段で、眠っていた', '線香は、途中で消えていた']);
      await c.say('なお', ['……何も、言ってくれなかった', 'あの子、出てこなかった。……私が、ちゃんと見てなかったからかな', '帰ろう。透くんは、病院に行って']);
      c.sfx('suzu', { at: v3([HOKORA_SEAT[0], HOKORA_SEAT[2]], 0.8) });
      await c.mono('なおが、鈴のついた鍵を俺の手に握らせた');
      await c.say('なお', 'これ、返す。……もう、来ないから');
    });
    await c.ending('end1_ohayou');
  }

  /** END2：祠の顔と、ふたつ数えるあいだ目が合った */
  async function end2(): Promise<void> {
    c.objective(null);
    // ループ音をすべて止める（心音が止まる）
    stare?.stop(0.05);
    crows?.stop(0.05);
    c.ambience(null);
    await c.cutscene(async () => {
      c.flash('#ffffff', 1.0);
      c.clearFaces(); // 凝視が抜けて心音と耳鳴りが止む
      hokoraFace = null;
      await c.wait(0.9);
      await c.narrate(['ひとつ。', 'ふたつ。']);
      await c.mono(['目が合った顔は――', '俺の、顔だった']);
      c.sub('なお', '……透くん？', 3);
      await c.wait(1.6);
      await c.fadeOut(2.2);
    });
    await c.ending('end2_omote');
  }

  /** END3：祠に線香と日記を供え、nao_trust≥2 で眠った */
  async function end3(): Promise<void> {
    c.objective(null);
    const naoAt = v3([HOKORA_SEAT[0], HOKORA_SEAT[2]], 0.8);
    await c.cutscene(async () => {
      // 画面は暗いまま。目を強制的に閉じてから会話ウィンドウで出す
      c.eyes(true);
      c.ambience('wind', 0.35);
      c.sfx('suzu', { at: naoAt });
      await c.wait(1.4);
      await c.narrate('眠りに落ちる直前、自分の口が動くのが分かった。');
      // QA16: the call was made to ask her to come（日記「来てって言う」）— and the sleep talk is word for word the same
      await c.say('透（？）', [
        '……お姉ちゃん？　ごめんね、こんな時間に',
        '……来てほしいって、言おうと思ったんだけど',
        '顔がね、ずっと見てるの。冷蔵庫と、トイレと、鏡のとこ',
        'でもね、大丈夫。目、つぶってたら大丈夫って、お姉ちゃん、ちっちゃいとき言ってくれたでしょ',
        'だから、お姉ちゃんも、こわいときは目、つぶってね',
        '……おやすみ',
      ]);
      await c.say('なお', '……しずく');
      c.sfx('voicemail_beep', { at: naoAt, volume: 0.7 });
      await c.wait(0.9);
      // QA19: played out loud on the speaker — that is how Toru hears every word
      await c.narrate('一年間、一度も再生されなかった留守番電話を、なおが再生した。小さなスピーカーから、声がした。');
      await c.say('留守電（しずく）', [
        '……お姉ちゃん？　ごめんね、こんな時間に',
        '……来てほしいって、言おうと思ったんだけど',
        '顔がね、ずっと見てるの。冷蔵庫と、トイレと、鏡のとこ',
        'でもね、大丈夫。目、つぶってたら大丈夫って、お姉ちゃん、ちっちゃいとき言ってくれたでしょ',
        'だから、お姉ちゃんも、こわいときは目、つぶってね',
        '……おやすみ',
      ]);
      await c.narrate('一字一句、同じだった。');
      await c.say('留守電（しずく）', ['……あ。ピンポン、鳴った', 'お姉ちゃんの声がする。『あけて』って', '来てくれたんだ。……ちょっと、待っててね']);
      // 遠く、録音の中の音として
      c.sfx('door_open', { at: naoAt, volume: 0.25, rate: 0.92 });
      await c.wait(1.4);
      await c.say('留守電（しずく）', ['……ひとつ', '……ふたつ']);
      c.sfx('voicemail_beep', { at: naoAt, volume: 0.7 });
      await c.wait(0.8);
      await c.narrate('録音は、そこで終わっていた。');
      await c.say('なお', ['……ちがうよ', 'それ、私じゃないよ。……私、寝てたんだよ', '…………来たよ、しずく。遅くなって、ごめんね', '今度は、ちゃんと起きてる。朝まで、ここにいる']);
      c.sfx('suzu', { at: naoAt });
      await c.wait(1.0);
      await c.narrate('その夜、なおは見ていた。祠のまわりの白い顔が、ひとつずつ、目を閉じていくのを。');
      await c.fadeOut(2.0);
      c.clearFaces();
      hokoraFace = null;
      c.prop('shr_hokora').showNode('incense', false); // 最後の一本まで燃えつきた（灰だけ）
      dawn();
      c.clock(5, 20, 0.05);
      // 朝：なおは透のすぐ横で、手を握ったまま祠のほうを向いて座っている（目は開いている）。暗いうちに置き直す
      {
        const p = playerXZ();
        const dx = HOKORA[0] - p[0];
        const dz = HOKORA[1] - p[1];
        const L = Math.hypot(dx, dz) || 1;
        const seat: XZ = [p[0] + (dz / L) * 0.6, p[1] - (dx / L) * 0.6];
        showNaoSit([seat[0], 0, seat[1]], yawToward(seat, HOKORA), false);
        if (naoSit) naoSit.lookAtPlayer = false;
      }
      await lookAtNao(0.01);
      await c.wait(1.0);
      c.releaseEyes();
      await c.fadeIn(2.0);
      startCrows();
      c.ambience('tsukutsuku', 0.6);
      // QA27・方針(8)：体への接触は手を握ることだけ。番をしていたなおは、朝も目を開けている
      await c.mono([
        '……朝だ',
        'なおは、俺の手を握ったまま、祠のほうを見ていた。目は、開いていた',
        '線香は、最後の一本まで燃えつきていた',
        '一晩中、目を開けて番をしていたのは、なおのほうだった',
      ]);
    });
    await c.ending('end3_nezunoban');
  }

  // ══ 世界の組み直し（setup は同期）════════════════════════════════════════
  // 町：ハツ・さき・宮司は非表示。坂口は夜勤
  c.npc('npc_clerk', { at: 'npc_clerk_spot', talk: () => clerkTalk() });
  c.poster('poster_3', { visible: true }); // 町内会のお知らせ（第4章から）
  {
    const h = c.prop('shr_hokora');
    h.showNode('ash', true);
    h.showNode('hairpin', !c.has('hairpin'));
    // 煙の板は前の周回のエンディングで隠したままのことがあるので戻す（線香ノード自体は章頭で非表示）
    for (let i = 0; i < 4; i++) h.showNode(`smoke_${i}`, true);
  }
  // 第4章で外れた天袋の板（日記は透が持っている。diary_book は出さない）
  if (c.has('diary')) c.prop('apt_closet').showNode('tenbukuro_open', true);
  // 前の章から残っている紙：冷蔵庫のメモ（D02・第1章。QA17）と、なおの置き手紙（D12・第4章）
  c.prop('apt_fridge').showNode('memo', true);
  c.prop('apt_lowtable').showNode('note', c.is('read_doc_nao_note'));
  applyNightLights();
  c.prop('apt_room_door').setOpen(1, 'panel'); // 洋室の引き戸は開
  // 再開時の時計はエンジンがチェックポイントから戻す

  if (tag === null) {
    // 章頭：また照明のブレーカーが下がってテープ。冷蔵庫は全開で警告音。なおはベッドの脇から撮っている
    c.power(false);
    c.breaker('sw_2', false);
    c.prop('apt_breaker').showNode('tape', true);
    c.prop('apt_fridge').setOpen(1, 'door');
    c.light('apt_fridge_light').setOn(true);
    alarm = c.loop('fridge_alarm', { at: 'apt_fridge', volume: 0.9 });
    showNaoSit('npc_nao_bedside', 0, true);
    c.eyes(true); // 冒頭は目を閉じたまま（フェードインで顔を見せない）
    phase = 'fridge';
  } else {
    // ch5_out 以降：なおは出ていったあと（玄関は開いている）
    const powered = c.is('ch5_power_on');
    c.power(powered);
    c.breaker('sw_2', powered);
    c.prop('apt_breaker').showNode('tape', !powered);
    if (powered) c.light('apt_light_kitchen').setOn(true);
    c.lock('apt_door', false);
    c.lock('apt_door_chain', false);
    c.prop('apt_door').showNode('chain_hooked', false);
    c.prop('apt_door').showNode('chain_hanging', true);
    if (tag === 'ch5_out') {
      phase = 'town';
      c.objective('公衆電話から、張り紙の番号にかける');
    } else if (tag === 'ch5_choice') {
      showNaoStand(TORII_NAO, yawToward([TORII_NAO[0], TORII_NAO[2]], playerXZ()), { glow: true, look: true });
      c.ambience('night_out');
      phase = 'confess'; // 告白は済んでいる（話しかけられない）。facesCome() が 'faces' にする
      c.after(1.0, () => facesCome());
    } else if (tag === 'ch5_home') {
      setupHome();
      objA(0);
    } else if (tag === 'ch5_sando') {
      windOn = true;
      applyNightLights();
      c.ambience('wind');
      startSando();
    }
  }

  // ── インタラクト（部屋）──────────────────────────────────────────────────
  c.on('apt_fridge', {
    label: () => {
      if (!c.is('closed_fridge5')) {
        if (!introDone || closing || !c.prop('apt_fridge').isOpen('door')) return null;
        // 閉眼中は c.blindTarget で狙わなくても出るので、冷蔵庫の前にいるときだけにする
        if (g.eyes.closed && dist(FRIDGE) > 2.0) return null;
        return '冷蔵庫を閉める';
      }
      return c.defaultLabel('apt_fridge');
    },
    // 〔閉眼可〕は冒頭の「冷蔵庫を閉める」だけ。閉めたあとの開け閉めは既定（目を開けて）
    get blind() {
      return !c.is('closed_fridge5');
    },
    use: async () => {
      if (!c.is('closed_fridge5')) await closeFridge5();
      else await c.useDefault('apt_fridge');
    },
  });

  // 分電盤：第1章と同じ（テープを剥がして上げると照明が戻る。落ちない）
  c.on('apt_breaker', {
    label: () => {
      if (phase === 'homeA' || phase === 'lyingA' || phase === 'ending') return null; // ルートA：なおが消した
      if (!c.prop('apt_breaker').isOpen('cover')) return '分電盤のフタを開ける';
      if (c.is('ch5_power_on')) return '分電盤を見る';
      if (!c.is('ch5_saw_breaker')) return 'ブレーカーを調べる';
      return 'テープを剥がして、ブレーカーを上げる';
    },
    blind: false,
    use: async () => {
      if (!c.prop('apt_breaker').isOpen('cover')) {
        await c.useDefault('apt_breaker');
        return;
      }
      if (c.is('ch5_power_on')) {
        await c.mono('全部、上がってる');
        return;
      }
      if (!c.is('ch5_saw_breaker')) {
        // QA15: 第4章の日記のあとなので「俺の字じゃない」とは言わない
        await c.mono(['「照明」のブレーカーだけ、下がってる', '……また、このテープ']);
        await c.doc('doc_memo_breaker');
        await c.mono(c.is('read_doc_notebook') ? '「め」の終わりが、丸まってる。……俺の、字だ' : '……日記の最後のほうと、同じ字だ');
        c.set('ch5_saw_breaker');
        return;
      }
      c.sfx('tape_peel', { at: 'apt_breaker' });
      c.prop('apt_breaker').showNode('tape', false);
      await c.wait(0.5);
      c.sfx('breaker', { at: 'apt_breaker' });
      c.breaker('sw_2', true);
      c.power(true);
      c.light('apt_light_kitchen').setOn(true);
      c.set('ch5_power_on');
      await c.say('透', '……ついた');
    },
  });

  c.on('apt_door', {
    label: () => (c.is('nao_left') && phase !== 'homeA' ? c.defaultLabel('apt_door') : '玄関のドア'),
    blind: false,
    use: async () => {
      if (c.is('nao_left') && phase !== 'homeA') {
        await c.useDefault('apt_door'); // 外へ出られる
        return;
      }
      if (phase === 'homeA') {
        await c.mono('なおを置いて、出るわけにはいかない');
        return;
      }
      // 鍵とチェーンはなおが内側からかけたもの。偽のなおの最中は触れても開かない。
      // なおが出ていくまでは外へ出られない（QA8：会話や偽のなおを飛ばして公衆電話へ行かせない）
      const i = await c.choice(['覗き穴を見る', 'ドアを開ける', 'やめる']);
      if (i === 0) await peep();
      else if (i === 1) {
        if (phase === 'fake') await c.mono('……開けたら、だめだ。なおは、うしろにいる');
        else if (c.is('ch5_saw_nao')) await c.mono('……なおが、そこにいる。置いて出られない');
        else await c.mono('……外に出る気には、なれない');
      }
    },
  });

  // 冷蔵庫の上の電子レンジ：冷蔵庫を閉めるまでは狙えない（閉眼の [E] が電子レンジに取られないように）
  c.on('apt_microwave', {
    label: () => (phase === 'fridge' ? null : c.defaultLabel('apt_microwave')),
    blind: false,
    use: () => c.useDefault('apt_microwave'),
  });
  // QA15: 落ちていたのは照明の子ブレーカーだけ（コンセントは生きている）なので、停電のせいにはしない
  c.on('apt_phone', { label: 'スマホを見る', blind: false, use: () => c.mono('電池が切れてる。……充電ケーブルが、抜けてた') });
  // 第4章のなおの置き手紙（D12）は、テーブルの上に置いたまま
  c.on('apt_lowtable', {
    label: () => (c.is('read_doc_nao_note') ? '置き手紙を見る' : c.defaultLabel('apt_lowtable')),
    blind: false,
    use: async () => {
      if (c.is('read_doc_nao_note')) await c.doc('doc_nao_note');
      else await c.useDefault('apt_lowtable');
    },
  });
  c.on('apt_calendar', { label: 'カレンダーを見る', blind: false, use: () => c.mono('31日。……今日だ。「1ねん」') });
  c.on('apt_bed', {
    label: () => (phase === 'homeA' ? '横になる' : c.defaultLabel('apt_bed')),
    blind: false,
    use: async () => {
      if (phase === 'homeA') await lieDownA();
      else await c.mono('今は、眠れない');
    },
  });

  // ── インタラクト（町）────────────────────────────────────────────────────
  c.on('ext_phonebooth', {
    label: () => (c.is('nao_left') && !c.is('called') ? '張り紙の番号にかける' : c.defaultLabel('ext_phonebooth')),
    blind: false,
    use: async () => {
      if (!c.is('nao_left')) await c.mono('……今は、いい'); // QA8：なおが出ていく前はかけられない
      else if (!c.is('called')) await callNumber();
      else await c.useDefault('ext_phonebooth');
    },
  });
  const needCoin = (): boolean => c.is('nao_left') && !c.is('called') && c.money < 10 && !c.has('coin10');
  c.on('ext_vending', {
    label: () => (needCoin() ? '釣り銭口を見る' : c.defaultLabel('ext_vending')),
    blind: false,
    use: async () => {
      if (!needCoin()) {
        await c.useDefault('ext_vending');
        return;
      }
      c.give('coin10');
      await c.mono('十円玉が一枚。……誰かの忘れ物だ');
      c.objective('公衆電話から、張り紙の番号にかける');
    },
  });

  const wantsIncense = (): boolean => phase === 'incense' && !c.has('incense');
  /** 夜のコンビニの坂口（線香を買いに来たとき）。お金が足りなければ、箱のつぶれたのをくれる */
  async function incenseAtCounter(): Promise<void> {
    await c.say('坂口', '……こんな時間に、線香っすか');
    if (c.money < 280) {
      await c.say('坂口', '……足りない？　いいっすよ、それ。箱がつぶれてるやつなんで');
      c.give('incense');
    } else {
      await c.shop('conbini');
    }
  }
  async function clerkTalk(): Promise<void> {
    if (wantsIncense()) await incenseAtCounter();
    else await c.shop('conbini');
  }
  c.on('conbini_shelf', {
    label: () => c.defaultLabel('conbini_shelf'),
    blind: false,
    use: async () => {
      if (wantsIncense()) await incenseAtCounter();
      else await c.useDefault('conbini_shelf');
    },
  });
  c.on('conbini_fridge', { label: '冷蔵ケースを見る', blind: false, use: () => c.mono('ドリンクの冷蔵ケース。……ミルクティーが、並んでる') });

  // ── 夜の町・神社の反応（QA24）────────────────────────────────────────────
  c.on('ext_board', {
    label: '張り紙を見る',
    blind: false,
    use: async () => {
      if (!c.player.flashlightOn) {
        await c.mono('暗くて、張り紙の字が読めない');
        return;
      }
      await c.doc('doc_poster_shizuku');
      await c.mono('……今日で、ちょうど一年');
    },
  });
  /** 目隠しの参道と祠の前では、祠のほかの物は調べさせない（目を閉じて歩く場面） */
  const shrineQuiet = (): boolean => phase === 'sando' || phase === 'hokora' || phase === 'watch' || phase === 'ending';
  const nightShrine = (id: string, label: string, use: () => Promise<void>): void => {
    c.on(id, { label: () => (shrineQuiet() ? null : label), blind: false, use: async () => { if (!shrineQuiet()) await use(); } });
  };
  // 夜中の三時に本坪鈴は鳴らさない（既定のお参りは鈴と柏手を鳴らし、賽銭も引く）
  nightShrine('shr_saisen', 'お参りする', () => c.mono(['……鈴は、鳴らさなかった', '手だけ、合わせた']));
  nightShrine('shr_chozuya', '手を清める', async () => {
    c.sfx('water_ladle', { at: 'shr_chozuya' });
    await c.wait(0.8);
    await c.mono('夜の水は、刺すように冷たい');
  });
  nightShrine('shr_ema', '絵馬を見る', async () => {
    await c.doc('doc_ema');
    await c.mono(c.is('called') ? 'おねえちゃんを、みないでください。……なおのことだ' : '……しずく。今夜で、ちょうど一年');
  });
  nightShrine('shr_yuisho', '由緒書きを読む', () => c.doc('doc_yuisho'));
  nightShrine('shr_komainu', '狛犬を見る', () => c.mono('暗がりの狛犬が、こっちを向いてる'));
  nightShrine('shr_haiden', '拝殿を見る', () => c.mono('格子戸の奥は、真っ暗だ'));
  nightShrine('shr_shinboku', '御神木を見る', () => c.mono('夜の楠は、黒い壁みたいだ。……しめ縄だけが、白い'));
  nightShrine('shr_kura', '蔵を見る', () => c.mono('古い蔵。重い錠前がかかっている'));

  c.on('shr_hokora', {
    label: () => {
      if (phase === 'hokora') return 'しずくのものと線香を供える';
      if (phase === 'watch' || phase === 'ending') return null;
      return c.defaultLabel('shr_hokora');
    },
    blind: false,
    use: async () => {
      if (phase === 'hokora') await offer();
      else if (phase !== 'watch' && phase !== 'ending') await c.useDefault('shr_hokora');
    },
  });

  // ── 場所トリガー ──────────────────────────────────────────────────────────
  c.zone('zone_apt', {
    enter: () => {
      if (c.is('nao_left')) c.ambience('room_tone');
    },
    exit: () => {
      if (c.is('nao_left')) c.ambience(windOn ? 'wind' : 'night_out');
    },
  });
  c.zone('zone_corridor', {
    enter: async () => {
      if (!c.is('nao_left') || c.is('ch5_corridor') || windOn) return;
      c.set('ch5_corridor');
      c.ambience('night_out');
      await monoEyes('外廊下の蛍光灯が、ジジッと鳴ってる');
      c.sfx('hyoshigi', { volume: 0.9 });
      await c.wait(1.6);
      if (c.is('read_doc_notice')) await monoEyes('……拍子木。今年は、夜回りはやってないはずだ');
      else await monoEyes('……拍子木。こんな時間に');
    },
  });
  c.zone('zone_shrine_gate', {
    enter: async () => {
      if (c.is('called') || shrineGateSaid) return;
      shrineGateSaid = true;
      await monoEyes('鳥居の奥は、真っ暗だ。……今は、入りたくない');
    },
  });
  c.zone('zone_conbini_in', {
    // 入店のチャイムは自動ドアが鳴らす
    enter: async () => {
      if (c.is('ch5_conbini_greet')) return;
      c.set('ch5_conbini_greet');
      await sayEyes('坂口', 'いらっしゃいませー。……こんな時間に、どうしたんすか');
    },
  });

  // ── 8秒ルール（5-0 の表）───────────────────────────────────────────────
  c.onBlackout(() => {
    switch (phase) {
      case 'ending':
      case 'choosing':
        return true;
      case 'fridge':
        // 既定は「はっと目覚める」で一瞬目を開けるが、ここでは20センチ先に顔がいる（QA7）。
        // 目覚めの合図だけ出して、目は閉じたままにする
        if (!c.prop('apt_fridge').isOpen('door')) return false;
        c.sfx('gasp');
        c.shake(0.6);
        c.toast('……眠りかけていた。');
        return true;
      case 'lyingA':
        return stageA();
      case 'sando':
        c.sub('なお', '……透くん、起きてる？', 3);
        return true;
      case 'watch':
        if (dist(HOKORA) < 6) {
          phase = 'ending';
          c.run(trust() >= 2 ? end3 : end1Shrine);
          return true;
        }
        return false;
      default:
        return false; // 部屋と町：既定（はっと目覚める）
    }
  });

  // ══ 毎フレーム ═══════════════════════════════════════════════════════════
  function tick(dt: number): void {
    T += dt;
    const ok = free();

    switch (phase) {
      case 'fridge': {
        // 閉眼中の [E] は c.blindTarget('apt_fridge') が受け持つ。ここでは、目を閉じている間も
        // 目の前の顔の気配（心音）を鳴らす（エンジンの心音は顔が見えているときしか鳴らない）
        if (introDone && ok && !closing && g.eyes.closed && c.prop('apt_fridge').isOpen('door')) {
          fridgeFearT -= dt;
          if (fridgeFearT <= 0) {
            fridgeFearT = 0.5;
            c.fear(0.45, 0.7);
          }
        }
        break;
      }
      case 'behind': {
        if (!ok || busy) break;
        behindT += dt;
        if (!g.eyes.closed && (angleTo(BEDSIDE) < 50 || behindT >= 6)) {
          busy = true;
          c.run(behindScene);
        }
        break;
      }
      case 'talk1': {
        // 近づいたら自動で話す。ただし目を閉じている間は会話ウィンドウを出さない（ルール3）
        if (ok && !busy && !g.interaction.busy && !g.eyes.closed && dist(BEDSIDE) < 2.8) c.run(talk1);
        break;
      }
      case 'fake': {
        if (stare) {
          const d = peeping ? 0 : dist(DOOR);
          const k = Math.max(0, Math.min(1, (7 - d) / 6));
          stare.setVolume(0.15 + 0.55 * k, 0.25);
          if (ok || peeping) c.fear(0.2 + 0.4 * k, 0.35);
        }
        break;
      }
      case 'lyingA':
        tickLying(dt, ok);
        break;
      case 'sando':
        if (ok) tickSando(dt);
        break;
      case 'watch':
        tickWatch(dt, ok);
        break;
      default:
        break;
    }

    // 通りを西へ進むたび、背後（東側）の街灯を一本ずつ消す
    if (c.is('nao_left') && phase !== 'ending' && c.inZone('zone_street')) {
      const x = g.player.pos.x;
      if (x < -16 && !c.is('ch5_lamp_s1')) {
        c.set('ch5_lamp_s1');
        c.light('lamp_pole_s1').setOn(false);
        c.run(() => monoEyes('……うしろの街灯が、消えた'));
      }
      if (x < -24 && !c.is('ch5_lamp_n2')) {
        c.set('ch5_lamp_n2');
        c.light('lamp_pole_n2').setOn(false);
      }
      if (x < -28 && !c.is('ch5_lamp_n1')) {
        c.set('ch5_lamp_n1');
        c.light('lamp_pole_n1').setOn(false);
      }
    }
  }

  /** ルートA：閉眼中の気配と「目、つぶってて」 */
  function tickLying(dt: number, ok: boolean): void {
    if (!ok) return;
    const shut = g.eyes.closed;
    if (shut) {
      fearT -= dt;
      if (fearT <= 0) {
        fearT = 1;
        c.fear(0.25 + 0.15 * num('stage_a'), 1);
      }
    } else if (prevClosed && T - lastOpenSub >= 10) {
      lastOpenSub = T;
      c.sub('なお', '目、つぶってて', 2.5);
    }
    prevClosed = shut;
  }

  /** ルートC：目隠しの参道 */
  function tickSando(dt: number): void {
    const shut = g.eyes.closed;
    const here = playerXZ();
    // 境内＝鳥居をくぐった先（鳥居の前で話している位置も zone_shrine に入っているので、鳥居まわりは除く）
    const inShrine = (c.inZone('zone_shrine') && !c.inZone('zone_shrine_gate')) || wi >= 1;
    // 顔：境内に入った時点で（同時に2体まで）
    if (!facesSpawned && inShrine) spawnSandoFaces();
    // なおを動かすのは、プレイヤーが目を閉じている間だけ
    if (shut && dist(SANDO[wi]) < reachOf(wi) && fake !== 'event') {
      if (wi === SANDO.length - 1) {
        arrive();
        return;
      }
      prevWp = SANDO[wi];
      wi++;
      placeNao(wi);
      c.sub('なお', 'こっち', 2);
      ring(SANDO[wi]);
      if (wi === FAKE_LEG && fake === 'idle') {
        fake = 'armed';
        fakeT = 0;
      }
    }
    // 境内で目を開けると（2回まで）
    const openNow = !shut && inShrine && facesSpawned && !prying;
    if (openNow && !openInShrine && warnCount < 2) {
      warnCount++;
      c.sub('なお', '目、開けちゃだめ！', 2.5);
    }
    openInShrine = openNow;
    // 閉眼中は、いちばん近い顔までの距離で心音（3mで0.3、1.5mで0.7）
    if (shut && facesSpawned) {
      fearT -= dt;
      if (fearT <= 0) {
        fearT = 0.25;
        const cam = g.engine.camera.position;
        let dmin = Infinity;
        for (const f of sandoFaces) if (f.alive) dmin = Math.min(dmin, f.pos.distanceTo(cam));
        if (dmin < Infinity) {
          const lv = dmin <= 1.5 ? 0.7 : dmin >= 3 ? Math.max(0, 0.3 - (dmin - 3) * 0.06) : 0.7 - ((dmin - 1.5) / 1.5) * 0.4;
          if (lv > 0.02) c.fear(lv, 0.4);
        }
      }
    }
    // 道を外れた（なおの方向から60度以上ずれて2秒、または経路から3m以上）
    corrCool -= dt;
    if (shut && fake !== 'event' && corrCool <= 0) {
      offT = angleTo(SANDO[wi]) > 60 ? offT + dt : 0;
      const off = wi > 0 && segDist(here, prevWp, SANDO[wi]) > 3;
      if (offT > 2 || off) {
        offT = 0;
        corrCool = 4;
        c.run(() => c.lookAt(v3(SANDO[wi], 1.4), 0.6));
        c.sub('なお', 'そっちじゃない。……こっち', 2.5);
      }
    } else if (!shut) offT = 0;
    // 偽の鈴（1回だけ）：W2→W3 の途中、拝殿の東側から2回
    if (fake === 'armed') {
      fakeT += dt;
      if (fakeT > 1.4) {
        fake = 'rang';
        c.run(ringFake);
      }
    } else if (fake === 'rang' && Math.hypot(here[0] - FAKE_BELL.x, here[1] - FAKE_BELL.z) < 4) {
      fake = 'event';
      c.run(fakeEvent);
    }
  }

  /** ルートC：寝ずの番 */
  function tickWatch(dt: number, ok: boolean): void {
    if (!ok) return;
    const shut = g.eyes.closed;
    const near = dist(HOKORA) < 6;
    // 初めて目を閉じたとき、祠の前に顔（凝視判定は台本側：2秒で END2）
    if (!hokoraFace && shut && near) {
      hokoraFace = c.face('anc_hokora', { type: 'static', harmless: true });
      closedStreak = 0;
      lure = 0;
    }
    if (!hokoraFace) return;
    if (shut) {
      closedStreak += dt;
      if (near && lure === 0 && closedStreak >= 4) {
        lure = 1;
        c.sub('？？？', '……目、開けて', 2);
      } else if (near && lure === 1 && closedStreak >= 5.5) {
        lure = 2;
        c.sub('？？？', '顔、見せて', 2.4);
      }
    } else {
      closedStreak = 0;
      lure = 0;
    }
    calmCool -= dt;
    if (hokoraFace.gaze >= 2) {
      phase = 'ending';
      c.run(end2);
      return;
    }
    if (hokoraFace.centered) staring = true;
    else if (staring) {
      staring = false;
      if (hokoraFace.gaze > 0.1 && calmCool <= 0) {
        calmCool = 6;
        c.sub('なお', '目、つぶってて。……大丈夫だから', 3);
      }
    }
  }

  return { c, intro, tick };
}
