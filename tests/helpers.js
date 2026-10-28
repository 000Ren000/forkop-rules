import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';

export async function fixture(t, files = { 'domains.lst': 'example.com\n' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forkop-domains-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  const config = await loadConfig(root, {});
  return { root, config, git: { listFiles: async () => Object.keys(files).filter((f) => f.endsWith('.lst')) } };
}
export const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
