// tools/validate.mjs が validate-entry.ts を node 向けに束ねる設定。
// Vite の import.meta.glob（src/script/index.ts）は rolldown が知らないので、script/*.nani を読み込んだ値に置き換える。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptGlob = {
  name: 'script-glob',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('src/script/index.ts')) return null;
    const dir = join(root, 'script');
    const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.nani')).map((f) => [`/script/${f}`, readFileSync(join(dir, f), 'utf8')]));
    const out = code.replace(/import\.meta\.glob\([^)]*\)/, JSON.stringify(files));
    if (out === code) throw new Error('script-glob: import.meta.glob が見つからない');
    return { code: out };
  },
};

export default {
  input: process.env.VALIDATE_IN ?? join(root, 'tools', 'validate-entry.ts'),
  platform: 'node',
  plugins: [scriptGlob],
  output: { format: 'esm', file: process.env.VALIDATE_OUT },
};
