import test from 'node:test';
import assert from 'node:assert/strict';
import { GitService } from '../src/services/git.js';
import { fixture, ok } from './helpers.js';

function mockGit(config, { changed = true, conflict = false, failPush = false, corrupt = false, stagedOther = true } = {}) {
  const calls = [], remote = 'a'.repeat(40), local = 'b'.repeat(40);
  let pushed = false;
  const runner = async (file, args, options) => {
    assert.equal(file, 'git'); assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(args.shift(), '--literal-pathspecs'); calls.push([...args]);
    if (args[0] === 'branch') return ok('main\n');
    if (args[0] === 'remote') return ok('git@github.com:owner/repo.git\n');
    if (args[0] === 'status') return ok(args.includes('--') ? changed ? ' M domains.lst\0' : '' : stagedOther ? 'M  unrelated.txt\0' : '');
    if (args[0] === 'rev-parse') {
      if (args.includes('-q')) return { ...ok(), code: 1 };
      if (args.includes('--git-path')) return ok();
      if (args[1]?.includes(':')) return ok((corrupt ? 'd' : 'c').repeat(40) + '\n');
      return ok(local + '\n');
    }
    if (args[0] === 'hash-object') return ok('c'.repeat(40) + '\n');
    if (args[0] === 'diff') return ok(args.includes(remote) ? 'domains.lst\0' : '');
    if (args[0] === 'ls-remote') return ok(`${pushed ? local : remote}\trefs/heads/main\n`);
    if (args[0] === 'merge-base') return { ...ok(), code: conflict ? 1 : 0 };
    if (args[0] === 'show') return ok(corrupt ? 'changed.com\n' : 'example.com\n');
    if (args[0] === 'push') { if (failPush) return { ...ok(), code: 1, stderr: 'Permission denied (publickey)' }; pushed = true; }
    return ok();
  };
  return { git: new GitService(config, runner), calls };
}
test('Git: commit ограничен списками, staged посторонний файл сохраняется', async (t) => {
  const f = await fixture(t), { git, calls } = mockGit(f.config);
  const plan = { ...await git.inspect(['domains.lst']), files: ['domains.lst'], snapshots: { 'domains.lst': 'example.com\n' } };
  const r = await git.publish(plan);
  assert.equal(r.oid, 'b'.repeat(40));
  assert.deepEqual(calls.find((a) => a[0] === 'add'), ['add', '--', 'domains.lst']);
  assert.deepEqual(calls.find((a) => a[0] === 'commit'), ['commit', '--only', '-m', 'Update Forkop domain lists', '--', 'domains.lst']);
  assert.deepEqual(calls.find((a) => a[0] === 'push'), ['push', '--', 'origin', 'HEAD:refs/heads/main']);
  assert.ok(!calls.flat().includes('unrelated.txt')); assert.ok(!calls.flat().includes('--force'));
});
test('Git: без изменений не создаёт коммит, публикацию проверяет', async (t) => {
  const f = await fixture(t), { git, calls } = mockGit(f.config, { changed: false });
  const plan = { ...await git.inspect(['domains.lst']), files: ['domains.lst'], snapshots: { 'domains.lst': 'example.com\n' } };
  await git.publish(plan); assert.ok(!calls.some((c) => c[0] === 'commit')); assert.equal(calls.filter((c) => c[0] === 'ls-remote').length, 2);
});
test('Git: удалённые новые коммиты останавливают commit/push', async (t) => {
  const f = await fixture(t), { git, calls } = mockGit(f.config, { conflict: true });
  const plan = { ...await git.inspect(['domains.lst']), files: ['domains.lst'] };
  await assert.rejects(git.publish(plan), { code: 'GIT_CONFLICT' });
  assert.ok(!calls.some((c) => ['commit', 'push'].includes(c[0])));
});
test('Git: ошибка авторизации push', async (t) => {
  const f = await fixture(t), { git } = mockGit(f.config, { failPush: true });
  const plan = { ...await git.inspect(['domains.lst']), files: ['domains.lst'], snapshots: { 'domains.lst': 'example.com\n' } };
  await assert.rejects(git.publish(plan), { code: 'GIT_AUTH' });
});
test('Git: изменение проверенного содержимого блокирует push', async (t) => {
  const f = await fixture(t), { git, calls } = mockGit(f.config, { corrupt: true });
  const plan = { ...await git.inspect(['domains.lst']), files: ['domains.lst'], snapshots: { 'domains.lst': 'example.com\n' } };
  await assert.rejects(git.publish(plan), { code: 'CONCURRENT' }); assert.ok(!calls.some((c) => c[0] === 'push'));
});
test('Git: частично staged список блокируется без изменения индекса', async (t) => {
  const f = await fixture(t), { git } = mockGit(f.config);
  const original = git.exec.bind(git);
  git.exec = async (args, allow) => args[0] === 'diff' && args.includes('--name-only') && args.includes('domains.lst') ? ok('domains.lst\n') : original(args, allow);
  await assert.rejects(git.inspect(['domains.lst']), { code: 'GIT_INDEX' });
});
