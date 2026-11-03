// Artifact 公開用ビルド: dist-artifact/ に出力し、GLB を glTF JSON（.gltf.json）に変換する。
// （claude.ai の Artifact は .glb を配信できないため）
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist-artifact';
execSync(`npx vite build --outDir ${out} --emptyOutDir`, {
  stdio: 'inherit',
  env: { ...process.env, VITE_MODEL_EXT: '.gltf.json' },
});

const dir = join(out, 'models');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
  const buf = readFileSync(join(dir, f));
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${f}: not a GLB`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (bin && json.buffers?.[0]) {
    json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  }
  writeFileSync(join(dir, f.replace(/\.glb$/, '.gltf.json')), JSON.stringify(json));
  unlinkSync(join(dir, f));
}
console.log(`[artifact] ${out}/ ready`);
