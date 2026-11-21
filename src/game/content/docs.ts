import { T } from '../../script';
import type { DocDef } from './types';

// 文書の題と本文は台本 script/docs.nani（`docs.<id>.title` / `docs.<id>`）。ここは id と見た目の種類だけ。
// kind 'phone' の本文の書式は script/docs.nani の冒頭を参照。
const doc = (id: string, kind: DocDef['kind']): DocDef => ({ id, kind, title: T(`docs.${id}.title`), body: T(`docs.${id}`) });

export const DOCS: Record<string, DocDef> = {
  doc_memo_breaker: doc('doc_memo_breaker', 'note'),
  doc_memo_fridge: doc('doc_memo_fridge', 'note'),
  doc_line_nao: doc('doc_line_nao', 'phone'),
  doc_receipt: doc('doc_receipt', 'receipt'),
  doc_clinic_card: doc('doc_clinic_card', 'card'),
  doc_notebook: doc('doc_notebook', 'note'),
  doc_poster_shizuku: doc('doc_poster_shizuku', 'poster'),
  doc_yuisho: doc('doc_yuisho', 'sign'),
  doc_ema: doc('doc_ema', 'ema'),
  doc_song_half: doc('doc_song_half', 'paper'),
  doc_song_full: doc('doc_song_full', 'paper'),
  doc_call_log: doc('doc_call_log', 'phone'),
  doc_nao_note: doc('doc_nao_note', 'note'),
  doc_clinic_letter: doc('doc_clinic_letter', 'paper'),
  doc_diary: doc('doc_diary', 'diary'),
  doc_notice: doc('doc_notice', 'poster'),
  doc_nao_phone: doc('doc_nao_phone', 'phone'),
};
