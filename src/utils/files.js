import { readFile, writeFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function atomicWrite(file, data, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function listPath(root, file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(file).toLowerCase() !== '.lst') {
    throw new AppError('Список должен быть файлом .lst внутри текущего репозитория.', 'FILE');
  }
  try {
    const [resolved, stat, resolvedRoot] = await Promise.all([realpath(absolute), lstat(absolute), realpath(root)]);
    const realRelative = path.relative(resolvedRoot, resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new AppError('Символические ссылки и пути за пределами репозитория запрещены.', 'FILE');
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError(`Файл списка отсутствует: ${relative}`, 'FILE');
    throw error;
  }
  return relative.split(path.sep).join('/');
}
