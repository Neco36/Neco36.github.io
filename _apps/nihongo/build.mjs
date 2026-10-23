// claude.ai Artifact 用に 1 ページへまとめる。
// 出力: dist/nihongo.html（CSS と JS を埋め込んだページ）と dist/dict/（ふりがな辞書）
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => path.join(here, 'src', p);
const dist = path.join(here, 'dist');

const js = await build({
  entryPoints: [src('app.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const code = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(src('app.css'), 'utf8');
const page = fs.readFileSync(src('page.html'), 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => code);

fs.mkdirSync(path.join(dist, 'dict'), { recursive: true });
fs.writeFileSync(path.join(dist, 'nihongo.html'), page);
const dictSrc = path.join(here, 'node_modules', 'kuromoji', 'dict');
for (const f of fs.readdirSync(dictSrc)) fs.copyFileSync(path.join(dictSrc, f), path.join(dist, 'dict', f));
console.log(`dist/nihongo.html ${(page.length / 1024).toFixed(0)} KB`);
