#!/usr/bin/env node
// Builds every Blender model script in tools/blender/models/*.py headlessly and
// writes public/models/manifest.json (the list of GLBs the game may load).
//
//   npm run assets                      # all scripts
//   npm run assets -- interior          # only scripts whose name contains "interior"
//   npm run assets -- --preview         # also render tools/blender/previews/<id>.png
//   BLENDER=/path/to/blender npm run assets
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(root, 'tools', 'blender', 'models');
const out = join(root, 'public', 'models');

function findBlender() {
  const candidates = [
    process.env.BLENDER,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
    '/usr/bin/blender',
    '/snap/bin/blender',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['blender']).toString().split('\n')[0].trim();
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const filter = args.find((a) => !a.startsWith('--'));
const blender = findBlender();

if (blender && existsSync(scripts)) {
  const files = readdirSync(scripts).filter((f) => f.endsWith('.py') && (!filter || f.includes(filter))).sort();
  for (const f of files) {
    console.log(`\n▶ ${f}`);
    execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(scripts, f), '--', ...(preview ? ['--preview'] : [])], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: root,
    })
      .toString()
      .split('\n')
      .filter((l) => l.startsWith('[model]') || l.startsWith('[warn]') || l.includes('Error'))
      .forEach((l) => console.log('  ' + l));
  }
} else {
  console.warn('Blender not found (set BLENDER=...). Only refreshing the manifest.');
}

const models = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, '')).sort() : [];
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ models }, null, 1) + '\n');
console.log(`\nmanifest: ${models.length} models`);
