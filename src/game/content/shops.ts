import type { ShopDef } from './types';

// docs/SCENARIO.md §4
export const SHOPS: Record<string, ShopDef> = {
  conbini: { id: 'conbini', title: 'ツキミマート', items: [
    { item: 'battery', price: 330, name: '単三電池（2本）', desc: 'いつもの電池。' },
    { item: 'incense', price: 280, name: '線香「月光」', desc: '仏壇用の小箱。マッチつき。' },
    { item: 'milktea', price: 150, name: 'ロイヤルミルクティー', desc: '冷蔵ケースの甘いミルクティー。' },
  ] },
  vending: { id: 'vending', title: 'アパート前の自販機', items: [
    { item: 'coffee', price: 130, name: '缶コーヒー（微糖）', desc: '自販機の缶コーヒー。' },
    { item: 'milktea', price: 130, name: 'ロイヤルミルクティー（缶）', desc: '甘いミルクティーの缶。コンビニより少し安い。' },
  ] },
  juyosho: { id: 'juyosho', title: '月見神社　授与所', items: [
    { item: 'omamori', price: 500, limit: 1, name: '面守り', desc: '白い面の刺繍のお守り。一度だけ、身代わりになって砕けるという。（各章1つまで）' },
  ] },
};
