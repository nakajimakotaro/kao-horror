import './styles.css';
import { Game } from './game/Game';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
  const warn = document.createElement('div');
  warn.style.cssText = 'position:fixed;left:0;right:0;top:0;padding:10px;background:#300;color:#fdd;font:13px sans-serif;text-align:center;z-index:9;pointer-events:none';
  warn.textContent = 'このゲームはパソコン（キーボードとマウス）向けです。';
  document.body.append(warn);
}
const game = new Game(canvas, ui);
// dev: free the WebGL context on hot reload so repeated reloads don't exhaust contexts
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.engine.renderer.dispose();
    game.engine.renderer.forceContextLoss();
  });
}

const debug = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');
if (debug) {
  void import('./game/debug').then((m) => m.installDebug(game));
}

game.boot().catch((e) => {
  console.error(e);
  ui.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e66;font:16px sans-serif;pointer-events:auto">起動に失敗しました: ${String(e)}</div>`;
});
