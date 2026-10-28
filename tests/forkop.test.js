import test from 'node:test';
import assert from 'node:assert/strict';
import { ForkopService, githubRawUrl } from '../src/services/forkop.js';
import { fixture, ok } from './helpers.js';

const source = { file: 'domains.lst', url: 'https://raw.githubusercontent.com/owner/repo/main/domains.lst', text: 'example.com\n', values: ['example.com'], removed: [], requireRevision: true };
async function setup(t, { http = 204, revision = 2, configured = true, help = '  clash_api <method> <path>\n', timestamp = '2026-10-28T01:00:00Z' } = {}) {
  const f = await fixture(t), calls = [];
  f.config.forkop.retryDelayMs = 0;
  let queried = 0;
  const session = {
    exec: async (command) => {
      calls.push(command);
      if (command === 'command -v forkop') return ok('/usr/bin/forkop\n');
      if (command === 'forkop help') return { ...ok(help), code: 1 };
      if (command === 'forkop show_version') return ok('2.0.0\n');
      if (command.startsWith('p=')) return ok(JSON.stringify({ experimental: { clash_api: { external_controller: '0.0.0.0:9090', secret: 'test-only-api-secret' } }, route: { rule_set: configured ? [{ type: 'remote', tag: 'custom', url: source.url, format: 'auto' }] : [] } }));
      return ok(JSON.stringify({ status: http, body: http === 204 ? '' : 'download failed' }));
    },
    request: async (api, route) => {
      calls.push(route); assert.equal(api.port, 9090);
      const current = queried++ > 0;
      return { code: 200, body: JSON.stringify({ providers: { custom: { revision: current ? revision : 1, updatedAt: current ? timestamp : '2026-10-28T00:00:00Z' } } }) };
    },
    close: () => calls.push('close')
  };
  const ssh = { connect: async () => { calls.push('connect'); return session; } };
  const fetcher = async () => { calls.push('raw'); return new Response(source.text); };
  const service = new ForkopService(f.config, ssh, { fetcher, sleep: async () => {} });
  return { ...f, calls, session, service };
}
test('Raw URL из SSH/HTTPS remote и кодирование пути', () => {
  assert.equal(githubRawUrl('git@github.com:owner/repo.git', 'main', 'my list.lst'), 'https://raw.githubusercontent.com/owner/repo/main/my%20list.lst');
  assert.equal(githubRawUrl('https://github.com/owner/repo.git', 'feature/a', 'a.lst'), 'https://raw.githubusercontent.com/owner/repo/feature%2Fa/a.lst');
  assert.throws(() => githubRawUrl('https://token@github.com/a/b.git', 'main', 'a.lst'), { code: 'RAW_URL' });
});
test('Forkop 2: сначала Raw, затем capability probe, штатное обновление и revision', async (t) => {
  const { service, calls } = await setup(t); const r = await service.update([source]);
  assert.equal(r.verified, true); assert.equal(r.mode, 'v2'); assert.ok(calls.indexOf('raw') < calls.indexOf('connect'));
  assert.ok(calls.includes('forkop clash_api PUT /providers/rules')); assert.equal(calls.at(-1), 'close');
  assert.ok(!calls.some((c) => /restart|opkg|apk|install/.test(c)));
});
test('Forkop: старый Raw ограниченно повторяется и не открывает SSH', async (t) => {
  const { service, calls } = await setup(t);
  let count = 0; service.fetcher = async () => { count++; return new Response('stale.com\n'); };
  await assert.rejects(service.update([source]), { code: 'RAW_STALE' }); assert.equal(count, 3); assert.ok(!calls.includes('connect'));
});
test('Forkop: Raw становится актуальным на второй попытке', async (t) => {
  const { service } = await setup(t); let count = 0;
  service.fetcher = async () => new Response(++count === 1 ? 'stale.com\n' : source.text);
  await service.rawReady([source]); assert.equal(count, 2);
});
test('Forkop: недоступный HTTP не считается актуальным Raw', async (t) => {
  const { service } = await setup(t); service.fetcher = async () => new Response('not found', { status: 404 });
  await assert.rejects(service.rawReady([source]), { code: 'RAW_STALE' });
});
test('Forkop: list_update не запускается без проверки поддержки', async (t) => {
  const { service, calls } = await setup(t, { help: '  get_status\n' });
  await assert.rejects(service.update([source]), { code: 'FORKOP_COMMAND' });
  assert.ok(!calls.includes('forkop list_update')); assert.equal(calls.at(-1), 'close');
});
test('Forkop: неподключённый URL останавливает обновление', async (t) => {
  const { service, calls } = await setup(t, { configured: false }); await assert.rejects(service.update([source]), { code: 'NOT_CONFIGURED' });
  assert.ok(!calls.includes('forkop clash_api PUT /providers/rules'));
});
test('Forkop: HTTP 503 не считается успехом даже при SSH exit=0', async (t) => {
  const { service, calls } = await setup(t, { http: 503 }); await assert.rejects(service.update([source]), { code: 'FORKOP_UPDATE' });
  assert.equal(calls.filter((c) => c === 'forkop clash_api PUT /providers/rules').length, 3);
});
test('Forkop: неизменившаяся revision не подтверждает новое содержимое', async (t) => {
  const { service } = await setup(t, { revision: 1 }); await assert.rejects(service.update([source]), { code: 'VERIFY' });
});
test('Forkop: ручной повтор без изменений допускает HTTP 304 по updatedAt', async (t) => {
  const { service } = await setup(t, { revision: 1 }); assert.equal((await service.update([{ ...source, requireRevision: false }])).verified, true);
});
test('Forkop: после прерывания используется сохранённая baseline', async (t) => {
  const { service } = await setup(t, { revision: 1 });
  const r = await service.update([source], { baseline: { custom: { revision: 0, updatedAt: '2026-10-27T00:00:00Z' } } });
  assert.equal(r.verified, true);
});
test('Forkop: занятое обновление не повторяется бесконечно', async (t) => {
  const { service, session, calls } = await setup(t); const exec = session.exec;
  session.exec = async (command) => command === 'forkop clash_api PUT /providers/rules' ? ok('already updating in progress') : exec(command);
  await assert.rejects(service.update([source]), { code: 'FORKOP_BUSY' }); assert.equal(calls.at(-1), 'close');
});
test('Forkop 1: версия определяется по help', async (t) => {
  const { service, session } = await setup(t, { help: '    list_update             Update remote lists\n    clash_api               Manage proxies\n' });
  assert.equal((await service.probe(session)).command, 'forkop list_update');
});
