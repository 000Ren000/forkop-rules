import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { parseArgs } from '../src/cli.js';
import { execute } from '../src/commands/index.js';
import { fixture } from './helpers.js';
import { DomainService } from '../src/services/domains.js';

test('конфигурация: окружение > .env > config.json > пример', async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ router: { host: '10.0.0.1' } }));
  await writeFile(path.join(root, '.env'), 'ROUTER_HOST=10.0.0.2\nROUTER_PASSWORD="test # secret"\n');
  const config = await loadConfig(root, { ROUTER_HOST: '10.0.0.3' }); assert.equal(config.router.host, '10.0.0.3'); assert.equal(config.router.password, 'test # secret');
});
test('конфигурация: секрет в JSON и произвольная shell-команда запрещены', async (t) => {
  const { root } = await fixture(t);
  for (const local of [{ router: { password: 'test' } }, { forkop: { updateCommand: 'forkop list_update; reboot' } }, { forkop: { retryCount: 0 } }, { router: { port: 65536 } }]) {
    await writeFile(path.join(root, 'config.json'), JSON.stringify(local)); await assert.rejects(loadConfig(root, {}), { code: 'CONFIG' });
  }
});
test('аргументы: пакет, --file, --no-sync и dry-run', () => {
  assert.deepEqual(parseArgs(['add', 'a.com', 'b.com', '--file', 'custom.lst', '--no-sync']), { command: 'add', values: ['a.com', 'b.com'], options: { file: 'custom.lst', noSync: true } });
  assert.equal(parseArgs(['sync', '--dry-run']).options.dryRun, true); assert.equal(parseArgs([]).command, undefined);
});
for (const args of [['add'], ['remove'], ['list', 'extra'], ['sync', '--no-sync'], ['add', 'x.com', '--dry-run'], ['sync', '--file'], ['search', 'a', 'b'], ['unknown']]) {
  test(`неверные аргументы: ${args.join(' ')}`, () => assert.throws(() => parseArgs(args), { code: 'USAGE' }));
}
test('add: автоматическая sync ровно после изменения, --no-sync не публикует', async (t) => {
  const f = await fixture(t); let count = 0;
  const context = { config: f.config, domains: new DomainService(f.config, f.git), sync: { sync: async () => { count++; } }, log: () => {} };
  await execute('add', ['new.com'], {}, context); assert.equal(count, 1);
  await execute('add', ['new.com'], {}, context); assert.equal(count, 1);
  await execute('add', ['local.com'], { noSync: true }, context); assert.equal(count, 1);
});
test('add: после ошибки sync локальная запись сохраняется', async (t) => {
  const f = await fixture(t), domains = new DomainService(f.config, f.git);
  const context = { config: f.config, domains, sync: { sync: async () => { throw new Error('push failed'); } }, log: () => {} };
  await assert.rejects(execute('add', ['new.com'], {}, context), /Локальные изменения сохранены/);
  assert.equal((await domains.search('new.com')).length, 1);
});
