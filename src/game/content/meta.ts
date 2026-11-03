import type { GameMeta } from './types';

export const META: GameMeta = {
  title: 'ねずのばん',
  titleSub: '午前三時',
  warn: 'この作品には恐怖表現・突然の大きな音・点滅表現が含まれます。ヘッドホン推奨。',
  tips: [
    '「顔」を二秒、見つめてはいけない。ひとつ、ふたつで、目が合う。',
    '[Space] を長押しすると目を閉じる。閉じている間、顔はあなたと目を合わせられない。',
    // only interactions marked blind work with the eyes shut (InteractDef.blind defaults to false)
    '目を閉じたままでも、直前に狙っていた物は [E] で調べられることがある。',
    // QA21: END3 is reached by falling asleep in front of the 祠, so do not tell the player 「ベッドの上だけ」
    '目を閉じ続けると、眠ってしまう。……どこで眠るかは、よく選ぶこと。',
    // QA6: the door scope (第3章・第5章)
    '覗き穴の中でも、[Space] で目を閉じられる。[E] で覗き穴から離れる。',
    '耳鳴りと心音は、近くに「顔」がいるしるし。耳鳴りがしない白い顔は、たぶん人間だ。',
    'お守りは一度だけ、身代わりになって砕ける。祠の前では、効かない。',
    '夜に顔が出た場所は、明るいうちに見ておくといい。',
    '迷ったら、画面の左上を見ること。目標だけは、嘘をつかない。',
    '覗き穴の中でも [Space] で目を閉じられる。[E] で覗き穴から離れる。',
  ],
  credits: ['原案　深夜三時のチャット', 'シナリオ・プログラム・3Dモデル・音　Claude Code', '（three.js / Blender / WebAudio）', 'ありがとうございました'],
  gameOverTitle: '……ふたつ。',
  gameOverHint: '顔を見つめ続けてはいけない。目をそらすか、[Space] で目を閉じること。',
};
