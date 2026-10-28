import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncService } from '../src/services/sync.js';
import { DomainService } from '../src/services/domains.js';
import { withLock } from '../src/utils/lock.js';
import { fixture } from './helpers.js';

async function setup(t, { failGit, failRouter, changed = true, valid = true } = {}) {
  const f = await fixture(t, { 'domains.lst': valid ? 'example.com\n' : 'bad value\n' });
  const calls = [];
  const git = { ...f.git,
    inspect: async () => { calls.push('inspect'); return { branch: 'main', remote: 'origin', url: 'git@github.com:owner/repo.git', changed: changed ? ['domains.lst'] : [] }; },
    publish: async () => { calls.push('publish'); if (failGit) throw new Error('GitHub недоступен'); return { oid: 'a'.repeat(40), modifiedFiles: changed ? ['domains.lst'] : [] }; } };
  const forkop = { update: async (sources, verification) => { calls.push('router'); if (failRouter) { await verification.checkpoint({ tag: { revision: 1 } }); throw new Error('Роутер недоступен'); } return { verified: true }; } };
  const domains = new DomainService(f.config, git), log = [];
  const sync = new SyncService(f.config, { git, domains, forkop, log: (s) => log.push(s) });
  return { ...f, sync, calls, log, forkop };
}
test('sync: порядок публикация → роутер → успешное состояние', async (t) => {
  const { sync, calls } = await setup(t); await sync.sync();
  assert.deepEqual(calls, ['inspect', 'publish', 'router']); assert.equal((await sync.state()).success, true);
});
test('sync: ошибка GitHub исключает SSH и сообщение об успехе', async (t) => {
  const { sync, calls, log } = await setup(t, { failGit: true });
  await assert.rejects(sync.sync(), /GitHub недоступен/); assert.ok(!calls.includes('router')); assert.equal((await sync.state()).success, false);
  assert.ok(!log.some((s) => s.includes('Синхронизация завершена')));
});
test('sync: ошибка роутера сохраняет pending и baseline для повтора', async (t) => {
  const { sync } = await setup(t, { failRouter: true }); await assert.rejects(sync.sync(), /Роутер недоступен/);
  const state = await sync.state(); assert.equal(state.success, false); assert.deepEqual(state.pending, ['domains.lst']); assert.equal(state.verificationBaseline.tag.revision, 1);
});
test('sync: некорректный список останавливает Git и SSH', async (t) => {
  const { sync, calls } = await setup(t, { valid: false }); await assert.rejects(sync.sync(), { code: 'CHECK' }); assert.deepEqual(calls, []);
});
test('sync: dry-run не меняет файлов, не вызывает сеть и не создаёт lock/state', async (t) => {
  const { root, sync, calls } = await setup(t); const before = await readdir(root);
  await sync.sync({ dryRun: true }); assert.deepEqual(calls, ['inspect']); assert.deepEqual(await readdir(root), before);
});
test('sync: ручная синхронизация без изменений всё равно обновляет роутер', async (t) => {
  const { sync, calls } = await setup(t, { changed: false }); await sync.sync(); assert.ok(calls.includes('router'));
});
test('sync: неподтверждённое применение не считается успехом', async (t) => {
  const { sync, forkop } = await setup(t); forkop.update = async () => ({ verified: false });
  await assert.rejects(sync.sync(), { code: 'VERIFY' }); assert.equal((await sync.state()).success, false);
});
test('lock: параллельная операция отклоняется, замок освобождается после ошибки', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(withLock(root, async () => {
    await assert.rejects(withLock(root, async () => {}), { code: 'LOCKED' }); throw new Error('failure');
  }), /failure/);
  await withLock(root, async () => {});
});
