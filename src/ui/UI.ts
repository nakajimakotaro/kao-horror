import type { Input } from '../core/Input';
import type { Settings } from '../game/Settings';

export type DocKind = 'paper' | 'note' | 'poster' | 'phone' | 'receipt' | 'diary' | 'card' | 'ema' | 'sign' | 'photo' | 'tv';

export interface DocView {
  title: string;
  body: string;
  kind?: DocKind;
}

export interface ListEntry {
  id: string;
  name: string;
  desc: string;
  count?: number;
  price?: number;
  icon?: string;
}

type Modal =
  | { kind: 'say'; lines: string[]; idx: number; shown: number; full: boolean; resolve: () => void; speed: number }
  | { kind: 'choice'; n: number; sel: number; resolve: (i: number) => void }
  | { kind: 'doc'; resolve: () => void; opened: number }
  | { kind: 'list'; entries: ListEntry[]; sel: number; resolve: () => void; mode: 'inventory' | 'shop'; buy?: (id: string) => string | null; money?: () => number }
  | { kind: 'menu'; items: { label: string; act: () => void; disabled?: boolean }[]; sel: number; root: HTMLElement; back?: () => void; opened: number }
  | { kind: 'wait' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** DOM overlay. Modal parts read keyboard input through update(); clicks work when the pointer is free. */
export class UI {
  readonly root: HTMLElement;
  private modal: Modal | null = null;
  private readonly box = el('div', 'dlg hidden');
  private readonly boxName = el('div', 'dlg-name');
  private readonly boxText = el('div', 'dlg-text');
  private readonly boxNext = el('div', 'dlg-next', '▼');
  private readonly choiceEl = el('div', 'choices hidden');
  private readonly promptEl = el('div', 'prompt hidden');
  private readonly crossEl = el('div', 'cross');
  private readonly objEl = el('div', 'objective hidden');
  private readonly clockEl = el('div', 'clock hidden');
  private readonly moneyEl = el('div', 'money hidden');
  private readonly batteryEl = el('div', 'battery hidden');
  private readonly eyesEl = el('div', 'eyes-ind hidden', '目を閉じている');
  private readonly toastEl = el('div', 'toasts');
  private readonly docEl = el('div', 'doc hidden');
  private readonly listEl = el('div', 'listpanel hidden');
  private readonly cardEl = el('div', 'card hidden');
  private readonly screenEl = el('div', 'screen hidden');
  private readonly hintEl = el('div', 'resume-hint hidden', 'クリックで再開');
  private readonly tutEl = el('div', 'tutorial hidden');
  private readonly subEl = el('div', 'subtitle hidden');
  private subTimer = 0;
  private tutTimer = 0;
  private hideBoxTimer = 0;
  textSpeed = 1;
  onConfirmSound: (() => void) | null = null;
  onTick: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = parent;
    this.box.append(this.boxName, this.boxText, this.boxNext);
    const hud = el('div', 'hud');
    hud.append(this.objEl, this.clockEl, this.moneyEl, this.batteryEl, this.eyesEl);
    parent.append(hud, this.crossEl, this.promptEl, this.tutEl, this.subEl, this.box, this.choiceEl, this.toastEl, this.docEl, this.listEl, this.cardEl, this.screenEl, this.hintEl);
    this.box.addEventListener('click', () => this.advance());
    this.docEl.addEventListener('click', () => this.closeDoc());
  }

  /** True while a modal UI owns the input (gameplay pauses). */
  get blocking(): boolean {
    return !!this.modal && this.modal.kind !== 'wait';
  }

  get busyDialogue(): boolean {
    return this.modal?.kind === 'say' || this.modal?.kind === 'choice';
  }

  // ── dialogue ────────────────────────────────────────────────────────────
  say(speaker: string | null, text: string | string[], style: 'talk' | 'mono' | 'narr' = 'talk'): Promise<void> {
    const lines = (Array.isArray(text) ? text : [text]).flatMap((t) => t.split('\f'));
    clearTimeout(this.hideBoxTimer);
    this.box.classList.remove('hidden', 'mono', 'narr', 'talk');
    this.box.classList.add(style);
    this.boxName.textContent = speaker ?? '';
    this.boxName.classList.toggle('hidden', !speaker || style !== 'talk');
    return new Promise((resolve) => {
      this.modal = { kind: 'say', lines, idx: 0, shown: 0, full: false, resolve, speed: 34 * this.textSpeed };
      this.renderLine();
    });
  }

  private renderLine(): void {
    const m = this.modal;
    if (m?.kind !== 'say') return;
    const line = m.lines[m.idx] ?? '';
    const n = m.full ? line.length : Math.floor(m.shown);
    this.boxText.textContent = line.slice(0, n);
    this.boxNext.classList.toggle('hidden', !m.full);
  }

  private advance(): void {
    const m = this.modal;
    if (m?.kind !== 'say') return;
    if (!m.full) {
      m.full = true;
      this.renderLine();
      return;
    }
    this.onConfirmSound?.();
    m.idx++;
    if (m.idx >= m.lines.length) {
      this.modal = null;
      this.hideBoxTimer = window.setTimeout(() => this.box.classList.add('hidden'), 90);
      m.resolve();
      return;
    }
    m.shown = 0;
    m.full = false;
    this.renderLine();
  }

  choose(options: string[], prompt?: string): Promise<number> {
    this.choiceEl.innerHTML = '';
    if (prompt) this.choiceEl.append(el('div', 'choice-prompt', esc(prompt)));
    options.forEach((o, i) => {
      const b = el('div', 'choice', `<span class="num">${i + 1}</span>${esc(o)}`);
      b.addEventListener('click', () => this.pickChoice(i));
      b.addEventListener('mouseenter', () => this.selChoice(i));
      this.choiceEl.append(b);
    });
    this.choiceEl.classList.remove('hidden');
    return new Promise((resolve) => {
      this.modal = { kind: 'choice', n: options.length, sel: 0, resolve };
      this.selChoice(0);
    });
  }

  private selChoice(i: number): void {
    const m = this.modal;
    if (m?.kind !== 'choice') return;
    m.sel = (i + m.n) % m.n;
    this.choiceEl.querySelectorAll('.choice').forEach((c, k) => c.classList.toggle('sel', k === m.sel));
  }

  private pickChoice(i: number): void {
    const m = this.modal;
    if (m?.kind !== 'choice') return;
    this.onConfirmSound?.();
    this.modal = null;
    this.choiceEl.classList.add('hidden');
    m.resolve(i);
  }

  // ── documents ───────────────────────────────────────────────────────────
  showDoc(d: DocView): Promise<void> {
    this.docEl.className = `doc doc-${d.kind ?? 'paper'}`;
    const first = d.body.split('\n')[0].replace(/^-+\s*/, '').trim();
    const showTitle = first !== d.title.trim();
    const body = d.kind === 'phone' ? phoneHtml(d.body) : `<div class="doc-body">${esc(d.body).replace(/\n/g, '<br>')}</div>`;
    this.docEl.innerHTML = `<div class="doc-sheet">${showTitle ? `<div class="doc-title">${esc(d.title)}</div>` : ''}${body}</div><div class="doc-close">[E] 閉じる</div>`;
    return new Promise((resolve) => {
      this.modal = { kind: 'doc', resolve, opened: performance.now() };
    });
  }

  private closeDoc(): void {
    const m = this.modal;
    if (m?.kind !== 'doc' || performance.now() - m.opened < 250) return;
    this.onConfirmSound?.();
    this.modal = null;
    this.docEl.className = 'doc hidden';
    m.resolve();
  }

  // ── inventory / shop ────────────────────────────────────────────────────
  openList(mode: 'inventory' | 'shop', title: string, entries: ListEntry[], extra?: { buy?: (id: string) => string | null; money?: () => number }): Promise<void> {
    return new Promise((resolve) => {
      this.modal = { kind: 'list', entries, sel: 0, resolve, mode, buy: extra?.buy, money: extra?.money };
      this.renderList(title);
      this.listEl.classList.remove('hidden');
    });
  }

  private listTitle = '';
  private renderList(title?: string): void {
    const m = this.modal;
    if (m?.kind !== 'list') return;
    if (title !== undefined) this.listTitle = title;
    const money = m.money ? `<div class="list-money">所持金 ¥${m.money().toLocaleString()}</div>` : '';
    const rows = m.entries.length
      ? m.entries.map((e, i) => `<div class="row${i === m.sel ? ' sel' : ''}" data-i="${i}"><span class="ico">${e.icon ?? '◆'}</span><span class="nm">${esc(e.name)}</span>${e.count && e.count > 1 ? `<span class="ct">×${e.count}</span>` : ''}${e.price !== undefined ? `<span class="pr">¥${e.price}</span>` : ''}</div>`).join('')
      : '<div class="row empty">（なにもない）</div>';
    const cur = m.entries[m.sel];
    const help = m.mode === 'shop' ? '[E] 買う　[Q/Esc] やめる' : '[Tab/Esc] 閉じる';
    this.listEl.innerHTML = `<div class="list-sheet"><div class="list-head"><span>${esc(this.listTitle)}</span>${money}</div><div class="list-rows">${rows}</div><div class="list-desc">${cur ? esc(cur.desc).replace(/\n/g, '<br>') : ''}</div><div class="list-help">${help}</div></div>`;
    this.listEl.querySelectorAll<HTMLElement>('.row[data-i]').forEach((r) => {
      r.addEventListener('mouseenter', () => { m.sel = Number(r.dataset.i); this.renderList(); });
      r.addEventListener('click', () => { m.sel = Number(r.dataset.i); if (m.mode === 'shop') this.buySelected(); });
    });
  }

  private buySelected(): void {
    const m = this.modal;
    if (m?.kind !== 'list' || !m.buy) return;
    const e = m.entries[m.sel];
    if (!e) return;
    const msg = m.buy(e.id);
    if (msg) this.toast(msg);
    this.renderList();
  }

  private closeList(): void {
    const m = this.modal;
    if (m?.kind !== 'list') return;
    this.modal = null;
    this.listEl.classList.add('hidden');
    m.resolve();
  }

  // ── menus (title / pause / settings / game over) ────────────────────────
  private menu(root: HTMLElement, items: { label: string; act: () => void; disabled?: boolean }[], back?: () => void): void {
    let wrap = root.querySelector('.menu');
    if (!wrap) {
      wrap = el('div', 'menu');
      root.append(wrap);
    }
    wrap.innerHTML = '';
    items.forEach((it, i) => {
      const b = el('div', `mi${it.disabled ? ' dis' : ''}`, esc(it.label));
      b.addEventListener('click', () => { if (!it.disabled) { this.onConfirmSound?.(); it.act(); } });
      b.addEventListener('mouseenter', () => this.menuSel(i));
      wrap.append(b);
    });
    this.modal = { kind: 'menu', items, sel: items.findIndex((x) => !x.disabled), root, back, opened: performance.now() };
    this.menuSel(this.modal.sel);
  }

  private menuSel(i: number): void {
    const m = this.modal;
    if (m?.kind !== 'menu') return;
    m.sel = i;
    m.root.querySelectorAll('.mi').forEach((e, k) => e.classList.toggle('sel', k === i));
  }

  /** small version line in the corner of the title / pause screens */
  private static readonly VERSION = `v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`;

  showScreen(html: string, cls: string): HTMLElement {
    this.screenEl.className = `screen ${cls}`;
    this.screenEl.innerHTML = html;
    return this.screenEl;
  }

  hideScreen(): void {
    this.screenEl.className = 'screen hidden';
    this.screenEl.innerHTML = '';
    if (this.modal?.kind === 'menu') this.modal = null;
  }

  showTitle(o: { title: string; sub: string; warn: string; hasSave: boolean; endings: string[]; onStart: () => void; onContinue: () => void; onSettings: () => void; onControls: () => void }): void {
    const s = this.showScreen(`<div class="title-wrap"><div class="title-main">${esc(o.title)}</div><div class="title-sub">${esc(o.sub)}</div><div class="menu"></div><div class="title-endings">${o.endings.map(esc).join('　')}</div><div class="title-warn">${esc(o.warn)}</div></div><div class="ver">${esc(UI.VERSION)}</div>`, 'title');
    this.menu(s, [
      { label: 'はじめから', act: o.onStart },
      { label: 'つづきから', act: o.onContinue, disabled: !o.hasSave },
      { label: '操作方法', act: o.onControls },
      { label: '設定', act: o.onSettings },
    ]);
  }

  showControls(onBack: () => void): void {
    const rows = [
      ['W A S D / 矢印', '移動'], ['マウス', '見回す'], ['Shift', '走る（足音が大きくなる）'], ['E / 左クリック', '調べる・会話を進める'],
      ['F', '懐中電灯 ON/OFF'], ['Space 長押し', '目を閉じる'], ['Tab / I', '持ち物'], ['Esc', 'ポーズ'],
    ];
    const s = this.showScreen(`<div class="panel"><div class="panel-title">操作方法</div><table class="keys">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table><div class="panel-note">「顔」を見つめ続けてはいけない。視線をそらすか、目を閉じること。</div><div class="menu"></div></div>`, 'dim');
    this.menu(s, [{ label: 'もどる', act: onBack }], onBack);
  }

  showSettings(st: Settings, onChange: (s: Settings) => void, onBack: () => void): void {
    const s = this.showScreen(`<div class="panel"><div class="panel-title">設定</div><div class="settings"></div><div class="menu"></div></div>`, 'dim');
    const box = s.querySelector('.settings')!;
    const slider = (label: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string) => {
      const row = el('label', 'set-row');
      const v = st[key] as number;
      row.innerHTML = `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}"><b>${fmt(v)}</b>`;
      const inp = row.querySelector('input')!, out = row.querySelector('b')!;
      inp.addEventListener('input', () => { (st[key] as number) = Number(inp.value); out.textContent = fmt(Number(inp.value)); onChange(st); });
      box.append(row);
    };
    slider('マウス感度', 'sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2));
    slider('音量', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    slider('明るさ', 'brightness', 0.7, 2, 0.05, (v) => v.toFixed(2));
    slider('視野角', 'fov', 55, 95, 1, (v) => `${v}°`);
    slider('文字の速さ', 'textSpeed', 0.4, 3, 0.1, (v) => `×${v.toFixed(1)}`);
    const res = el('label', 'set-row');
    res.innerHTML = `<span>解像度</span><select>${[[240, '240p（ざらざら）'], [360, '360p（標準）'], [480, '480p'], [720, '720p'], [4000, 'ネイティブ']].map(([v, n]) => `<option value="${v}" ${st.pixelHeight === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    res.querySelector('select')!.addEventListener('change', (e) => { st.pixelHeight = Number((e.target as HTMLSelectElement).value); onChange(st); });
    const inv = el('label', 'set-row');
    inv.innerHTML = `<span>上下反転</span><input type="checkbox" ${st.invertY ? 'checked' : ''}>`;
    inv.querySelector('input')!.addEventListener('change', (e) => { st.invertY = (e.target as HTMLInputElement).checked; onChange(st); });
    box.append(res, inv);
    this.menu(s, [{ label: 'もどる', act: onBack }], onBack);
  }

  showPause(o: { onResume: () => void; onSettings: () => void; onControls: () => void; onTitle: () => void; objective: string | null }): void {
    const s = this.showScreen(`<div class="panel"><div class="panel-title">一時停止</div>${o.objective ? `<div class="panel-note">目標：${esc(o.objective)}</div>` : ''}<div class="menu"></div></div><div class="ver">${esc(UI.VERSION)}</div>`, 'dim');
    this.menu(s, [
      { label: 'つづける', act: o.onResume },
      { label: '操作方法', act: o.onControls },
      { label: '設定', act: o.onSettings },
      { label: 'タイトルへ戻る', act: o.onTitle },
    ], o.onResume);
  }

  showGameOver(o: { title: string; reason: string; hint: string; onRetry: () => void; onTitle: () => void }): void {
    const s = this.showScreen(`<div class="go-wrap"><div class="go-title">${esc(o.title)}</div><div class="go-reason">${esc(o.reason).replace(/\n/g, '<br>')}</div><div class="go-hint">${esc(o.hint)}</div><div class="menu"></div></div>`, 'gameover');
    this.menu(s, [
      { label: 'やりなおす', act: o.onRetry },
      { label: 'タイトルへ', act: o.onTitle },
    ]);
  }

  /** Ending roll: shows lines one by one, then the ending name. */
  showEnding(o: { name: string; label: string; lines: string[]; credits: string[]; onDone: () => void }): void {
    const s = this.showScreen(`<div class="end-wrap"><div class="end-lines"></div></div>`, 'ending');
    const linesEl = s.querySelector('.end-lines')!;
    const all = [...o.lines.map((l) => ({ l, c: 'el' })), { l: o.label, c: 'el-label' }, { l: o.name, c: 'el-name' }, ...o.credits.map((l) => ({ l, c: 'el-credit' }))];
    let i = 0;
    const next = () => {
      if (i >= all.length) {
        const m = el('div', 'menu');
        linesEl.append(m);
        this.menu(s, [{ label: 'タイトルへ', act: o.onDone }]);
        return;
      }
      const { l, c } = all[i++];
      const d = el('div', c, esc(l) || '&nbsp;');
      linesEl.append(d);
      requestAnimationFrame(() => d.classList.add('in'));
      linesEl.scrollTop = linesEl.scrollHeight;
      window.setTimeout(next, c === 'el' ? 1700 + l.length * 45 : 1400);
    };
    next();
  }

  showLoading(k: number, tip: string): void {
    this.showScreen(`<div class="load-wrap"><div class="load-bar"><i style="width:${Math.round(k * 100)}%"></i></div><div class="load-tip">${esc(tip)}</div></div>`, 'loading');
    this.modal = { kind: 'wait' };
  }

  // ── chapter card & HUD ──────────────────────────────────────────────────
  card(title: string, sub = '', sec = 3.2): Promise<void> {
    this.cardEl.innerHTML = `<div class="card-title">${esc(title)}</div><div class="card-sub">${esc(sub)}</div>`;
    this.cardEl.className = 'card';
    return new Promise((resolve) => {
      window.setTimeout(() => {
        this.cardEl.classList.add('out');
        window.setTimeout(() => { this.cardEl.className = 'card hidden'; resolve(); }, 900);
      }, sec * 1000);
    });
  }

  setPrompt(text: string | null, blind = false): void {
    if (!text) { this.promptEl.classList.add('hidden'); this.crossEl.classList.remove('on'); return; }
    this.promptEl.innerHTML = `<span class="key">E</span>${esc(text)}${blind ? '<span class="blind">（目を閉じたまま）</span>' : ''}`;
    this.promptEl.classList.remove('hidden');
    this.crossEl.classList.add('on');
  }

  setCrossVisible(v: boolean): void {
    this.crossEl.classList.toggle('hidden', !v);
  }

  setObjective(text: string | null): void {
    if (!text) { this.objEl.classList.add('hidden'); this.objEl.textContent = ''; this.objEl.dataset.t = ''; return; }
    const changed = this.objEl.dataset.t !== text;
    this.objEl.dataset.t = text;
    this.objEl.innerHTML = `<span class="obj-mark">◆</span>${esc(text)}`;
    this.objEl.classList.remove('hidden');
    if (changed) { this.objEl.classList.remove('flash'); void this.objEl.offsetWidth; this.objEl.classList.add('flash'); }
  }

  setClock(text: string | null): void {
    this.clockEl.classList.toggle('hidden', !text);
    if (text) this.clockEl.textContent = text;
  }

  setMoney(n: number | null): void {
    this.moneyEl.classList.toggle('hidden', n === null);
    if (n !== null) this.moneyEl.textContent = `¥${n.toLocaleString()}`;
  }

  setBattery(v: number | null, on = false): void {
    this.batteryEl.classList.toggle('hidden', v === null);
    if (v === null) return;
    const bars = Math.ceil(v * 5);
    this.batteryEl.innerHTML = `<span class="bt-ico${on ? ' on' : ''}">◉</span>${'▮'.repeat(bars)}<span class="bt-empty">${'▯'.repeat(5 - bars)}</span>`;
    this.batteryEl.classList.toggle('low', v < 0.2);
  }

  setEyes(closed: boolean): void {
    this.eyesEl.classList.toggle('hidden', !closed);
  }

  setResumeHint(v: boolean): void {
    this.hintEl.classList.toggle('hidden', !v);
  }

  setHudVisible(v: boolean): void {
    this.root.classList.toggle('nohud', !v);
  }

  /** Bottom-left control hint (tutorials). Lines separated by \n; [Key] is styled. */
  hint(text: string | null, sec = 7): void {
    clearTimeout(this.tutTimer);
    if (!text) { this.tutEl.classList.add('hidden'); return; }
    this.tutEl.innerHTML = esc(text).replace(/\[([^\]]+)\]/g, '<span class="key">$1</span>').replace(/\n/g, '<br>');
    this.tutEl.classList.remove('hidden', 'out');
    this.tutTimer = window.setTimeout(() => {
      this.tutEl.classList.add('out');
      this.tutTimer = window.setTimeout(() => this.tutEl.classList.add('hidden'), 900);
    }, sec * 1000);
  }

  /** Non-modal subtitle (voices heard while the eyes are closed, etc.). */
  sub(speaker: string | null, text: string, sec = 3): void {
    clearTimeout(this.subTimer);
    this.subEl.innerHTML = `${speaker ? `<span class="sub-name">${esc(speaker)}</span>` : ''}<span class="sub-text">${esc(text)}</span>`;
    this.subEl.classList.remove('hidden', 'out');
    this.subTimer = window.setTimeout(() => {
      this.subEl.classList.add('out');
      this.subTimer = window.setTimeout(() => this.subEl.classList.add('hidden'), 600);
    }, sec * 1000);
  }

  toast(text: string): void {
    const t = el('div', 'toast', esc(text));
    this.toastEl.append(t);
    window.setTimeout(() => t.classList.add('out'), 2600);
    window.setTimeout(() => t.remove(), 3400);
  }

  // ── per-frame keyboard handling for modals ──────────────────────────────
  update(dt: number, input: Input): void {
    const m = this.modal;
    if (!m) return;
    switch (m.kind) {
      case 'say': {
        if (!m.full) {
          const line = m.lines[m.idx] ?? '';
          const before = Math.floor(m.shown);
          m.shown += dt * m.speed;
          if (Math.floor(m.shown) !== before && line[before] && !'　 、。…'.includes(line[before])) this.onTick?.();
          if (m.shown >= line.length) m.full = true;
          this.renderLine();
        }
        if (input.pressed('confirm')) { input.consume('confirm'); this.advance(); }
        break;
      }
      case 'choice': {
        if (input.pressed('up') || input.wheel < 0) this.selChoice(m.sel - 1);
        if (input.pressed('down') || input.wheel > 0) this.selChoice(m.sel + 1);
        for (let i = 0; i < m.n; i++) if (input.keyPressed(`Digit${i + 1}`)) { this.pickChoice(i); return; }
        if (input.pressed('confirm')) { input.consume('confirm'); this.pickChoice(m.sel); }
        break;
      }
      case 'doc':
        if (input.pressed('confirm') || input.pressed('cancel')) { input.consume('confirm'); this.closeDoc(); }
        break;
      case 'list': {
        const n = Math.max(1, m.entries.length);
        if (input.pressed('up') || input.wheel < 0) { m.sel = (m.sel - 1 + n) % n; this.renderList(); }
        if (input.pressed('down') || input.wheel > 0) { m.sel = (m.sel + 1) % n; this.renderList(); }
        if (m.mode === 'shop' && input.pressed('interact')) { input.consume('interact'); this.buySelected(); }
        else if (input.pressed('cancel') || input.pressed('inventory') || (m.mode === 'inventory' && input.pressed('interact'))) { input.consume('cancel'); this.closeList(); }
        break;
      }
      case 'menu': {
        // ignore keys right after a menu appears (e.g. Space still held to keep the eyes shut)
        if (performance.now() - m.opened < 700) break;
        const enabled = m.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
        const pos = enabled.indexOf(m.sel);
        if (input.pressed('up')) this.menuSel(enabled[(pos - 1 + enabled.length) % enabled.length]);
        if (input.pressed('down')) this.menuSel(enabled[(pos + 1) % enabled.length]);
        if (input.pressed('confirm')) { input.consume('confirm'); const it = m.items[m.sel]; if (it && !it.disabled) { this.onConfirmSound?.(); it.act(); } }
        else if (m.back && input.keyPressed('Escape')) { input.consume('cancel'); m.back(); }
        break;
      }
    }
  }

  /** Drop any modal (used when a chapter restarts). Pending promises resolve so awaiting scripts can abort. */
  reset(): void {
    const m = this.modal;
    this.modal = null;
    if (m?.kind === 'say' || m?.kind === 'doc' || m?.kind === 'list') m.resolve();
    else if (m?.kind === 'choice') m.resolve(0);
    this.box.classList.add('hidden');
    this.choiceEl.classList.add('hidden');
    this.docEl.className = 'doc hidden';
    this.listEl.classList.add('hidden');
    this.cardEl.className = 'card hidden';
    this.subEl.classList.add('hidden');
    this.setPrompt(null);
  }
}

function phoneHtml(body: string): string {
  // "なお: 本文" / "自分: 本文" / "--- 日付" lines become chat bubbles
  const rows = body.split('\n').map((line) => {
    if (line.startsWith('---')) return `<div class="ph-date">${esc(line.replace(/^-+\s*/, ''))}</div>`;
    const m = line.match(/^([^:：]{1,8})[:：]\s*(.*)$/);
    if (!m) return `<div class="ph-sys">${esc(line)}</div>`;
    const me = ['自分', '俺', '僕', '私', '透', '瀬尾'].includes(m[1]);
    return `<div class="ph-row ${me ? 'me' : 'them'}">${me ? '' : `<span class="ph-who">${esc(m[1])}</span>`}<span class="ph-bub">${esc(m[2])}</span></div>`;
  });
  return `<div class="doc-body phone">${rows.join('')}</div>`;
}
