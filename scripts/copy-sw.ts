// Dopo `tsc`: copia js/sw.js alla radice del sito come sw.js, con BUILD_ID unico per build
// e lista SHELL generata da js/**/*.js, data/*.json, index.html, css, manifest e icone.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(`${dir}/${d.name}`, ext) : d.name.endsWith(ext) ? [`${dir}/${d.name}`] : []);
}
const list = (dir: string, ext: string): string[] => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

const id = Date.now().toString(36);
const src = readFileSync('js/sw.js', 'utf8');
if (!src.includes('__BUILD_ID__')) throw new Error('js/sw.js: segnaposto __BUILD_ID__ non trovato');
if (!src.includes('__SHELL__')) throw new Error('js/sw.js: segnaposto __SHELL__ non trovato');
const shell = [
  './', 'index.html', 'manifest.webmanifest',
  ...list('css', '.css'), ...list('icons', '.svg'), ...list('icons', '.png'),
  ...walk('js', '.js').filter((f) => f !== 'js/sw.js'),
  ...list('data', '.json'),
];
writeFileSync('sw.js', src.replace('__BUILD_ID__', id).replace('__SHELL__', JSON.stringify(shell)));
console.log(`sw.js scritto (cache openprintcalc-${id}, ${shell.length} file)`);
