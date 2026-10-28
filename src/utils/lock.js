import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

// Один замок охватывает изменение списка, commit, push и применение на роутере.
// После аварийного завершения замок удаляется только вручную: PID может быть переиспользован.
export async function withLock(root, action) {
  const dir = path.join(root, '.domains');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'sync.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new AppError('Другая операция domains уже выполняется. После аварии проверьте процессы и удалите .domains/sync.lock вручную.', 'LOCKED');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally { await handle.close(); await unlink(file); }
}
