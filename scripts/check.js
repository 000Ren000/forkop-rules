import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/utils/process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(path.join(dir, e.name)) : path.join(dir, e.name)))).flat().filter((p) => p.endsWith('.js'));
}
const paths = (await Promise.all(['src', 'scripts', 'tests'].map(files))).flat();
for (const file of paths) {
  const r = await run(process.execPath, ['--check', file], { cwd: root });
  if (r.code) { console.error(r.stderr); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`Синтаксис проверен: ${paths.length} JS-файлов.`);
