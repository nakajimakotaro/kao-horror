#!/usr/bin/env node
// itch.io へアップロード: 本番ビルド (dist/) を butler で nakajimakotaro/nezunoban の html5 チャンネルに push する。
//
//   npm run upload            # ビルドして push
//   npm run upload -- --dry   # ビルドして、push せずに何を上げるかだけ表示
//
// butler は PATH、BUTLER=...、~/.local/butler/butler の順に探す。初回だけ `butler login` が要る
// （CI などでは環境変数 BUTLER_API_KEY でもよい）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersion } from './version.mjs';

const TARGET = 'nakajimakotaro/nezunoban:html5';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');

function findButler() {
  const candidates = [process.env.BUTLER, join(homedir(), '.local', 'butler', 'butler')].filter(Boolean);
  try {
    candidates.unshift(execFileSync('which', ['butler']).toString().trim());
  } catch { /* not on PATH */ }
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

const butler = findButler();
if (!butler) {
  console.error('butler が見つかりません。https://itch.io/docs/butler/ から入れて ~/.local/butler/butler に置くか、BUTLER=... で場所を指定してください。');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run('npm', ['run', 'build']);

const userVersion = appVersion();

console.log(`\n▶ ${TARGET}  (${userVersion})`);
if (dry) {
  console.log('--dry: push しませんでした');
  process.exit(0);
}
run(butler, ['push', join(root, 'dist'), TARGET, '--userversion', userVersion]);
// itch.io 側の処理には少しかかる（直後の butler status ではまだ出ないことがある）
console.log(`\n✓ push しました。数十秒で https://nakajimakotaro.itch.io/nezunoban に反映されます（確認: ${butler} status ${TARGET}）`);
