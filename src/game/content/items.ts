import type { ItemDef } from './types';

// Engine-level ids: flashlight (F key), battery (auto swap), omamori (absorbs one lethal stare).
export const ITEMS: Record<string, ItemDef> = {
  flashlight: { id: 'flashlight', name: '懐中電灯', desc: 'いつもの黒い懐中電灯。冷蔵庫に入っていたのに、持ち手だけがぬるかった。\n[F] で点灯・消灯。', icon: '◉' },
  battery: { id: 'battery', name: '単三電池', desc: '懐中電灯の予備の電池。切れたら自動で入れ替える。', icon: '▮' },
  // QA15: no 「……祠の前では効かない、と宮司は言った」 — it can be bought in ch2, before 白瀬 says so (ch4)
  omamori: { id: 'omamori', name: '面守り（おもてまもり）', desc: '月見神社のお守り。白い面の刺繍がある。一度だけ身代わりになって砕けるという。', icon: '⛩' },
  incense: { id: 'incense', name: '線香「月光」', desc: '小箱の線香とマッチ。聞いたことのない銘柄だ。', icon: '｜' },
  coffee: { id: 'coffee', name: '缶コーヒー（微糖）', desc: 'アパート前の自販機の缶コーヒー。', icon: '▯' },
  milktea: { id: 'milktea', name: 'ロイヤルミルクティー', desc: '甘いミルクティー。……なぜか、手が伸びた。', icon: '▯' },
  diary: { id: 'diary', name: 'しずくの日記', desc: '天袋から落ちてきた小さなノート。表紙に「しずく」。', icon: '▤' },
  hairpin: { id: 'hairpin', name: 'ひまわりのヘアピン', desc: '祠に供えてあった。一年前のものにしては、新しすぎる。', icon: '✿' },
  number_memo: { id: 'number_memo', name: '張り紙の番号のメモ', desc: '張り紙の「家族」の電話番号を書き写した。日記を返すつもりだった。', icon: '✎' },
  coin10: { id: 'coin10', name: '十円玉', desc: '自販機の釣り銭口に残っていた十円玉。', icon: '●' },
};
