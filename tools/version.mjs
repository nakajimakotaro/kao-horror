// ゲームの版名: package.json の version + Git のコミット（未コミットの変更があれば -dirty）。
// vite.config.ts（画面に出す版）と tools/upload-itch.mjs（itch.io の userversion）が同じものを使う。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function appVersion() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return `${version}+${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '-dirty' : ''}`;
  } catch {
    return version;
  }
}
