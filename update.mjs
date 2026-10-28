#!/usr/bin/env node
// Запуск: node update.mjs. Без изменений и подключений: node update.mjs --dry-run.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, open, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const directory = fileURLToPath(new URL('.', import.meta.url));
const remote = process.env.GITHUB_REMOTE || 'origin';
const host = process.env.ROUTER_HOST || '192.168.0.1';
const port = process.env.ROUTER_PORT || '22';
const user = process.env.ROUTER_USER || 'root';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);

async function git(args) {
  try {
    return (await execute('git', ['--literal-pathspecs', ...args], {
      cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })).stdout;
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 600);
    throw new Error(`Git ${args[0]}: ${detail}`);
  }
}

// Пароль без отображения символов запрашивает сам OpenSSH.
export const routerCommand = `
command -v forkop >/dev/null || { echo 'Forkop не установлен' >&2; exit 1; }
help=$(forkop help 2>&1)
if printf '%s\\n' "$help" | grep -q '^[[:space:]]*list_update[[:space:]]'; then
  forkop list_update
  exit $?
fi
printf '%s\\n' "$help" | grep -q '^[[:space:]]*clash_api[[:space:]]' || {
  echo 'Команда обновления списков Forkop недоступна' >&2; exit 1;
}
command -v jsonfilter >/dev/null || { echo 'Нужен штатный jsonfilter OpenWrt для проверки ответа' >&2; exit 1; }
result=$(forkop clash_api PUT /providers/rules)
code=$?
status=$(jsonfilter -s "$result" -e '@.status' 2>/dev/null)
if [ "$code" -eq 0 ]; then
  case "$status" in 2[0-9][0-9]) echo 'Forkop подтвердил обновление списков'; exit 0;; esac
fi
[ -n "$status" ] || status='нет ответа'
echo "Forkop не подтвердил обновление (код: $code, HTTP: $status)" >&2
exit 1
`;

async function ssh() {
  if (!/^[\w.:[\]-]+$/.test(host) || !/^[\w-]+$/.test(user) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Неверные параметры роутера.');
  const args = ['-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-p', port];
  if (process.env.ROUTER_SSH_KEY) args.push('-i', process.env.ROUTER_SSH_KEY);
  args.push(`${user}@${host}`, routerCommand);
  await new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: 'inherit', shell: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить OpenSSH. Проверьте ssh в PATH.')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? 'Таймаут SSH. Команда на роутере могла продолжить работу; проверьте её перед повтором.' : 'Ошибка SSH или обновления Forkop. Диагностика приведена выше.'));
    });
  });
}

export async function main(args = process.argv.slice(2), adapters = {}) {
  const runGit = adapters.git || git, runSSH = adapters.ssh || ssh;
  const fetchRaw = adapters.fetch || fetch, sleep = adapters.wait || wait;
  if (args.includes('--help')) { console.log('node update.mjs [--dry-run]\nПубликует изменённые .lst в GitHub и обновляет списки Forkop по SSH.'); return; }
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('Использование: node update.mjs [--dry-run]');
  const root = (await runGit(['rev-parse', '--show-toplevel'])).trim();
  const branch = (await runGit(['branch', '--show-current'])).trim();
  if (!branch) throw new Error('Сначала переключитесь на ветку Git.');
  if ((await runGit(['diff', '--name-only', '--diff-filter=U'])).trim()) throw new Error('Сначала разрешите конфликты Git.');
  const url = (await runGit(['remote', 'get-url', remote])).trim();
  const pushURL = (await runGit(['remote', 'get-url', '--push', '--all', remote])).trim();
  const repo = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  if (!repo || url !== pushURL) throw new Error('Нужен один одинаковый fetch/push URL репозитория github.com.');
  const files = [...new Set((await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter((file) => file.endsWith('.lst')))];
  if (!files.length) throw new Error('Списки .lst не найдены.');
  const changed = [], snapshots = {};
  for (const file of files) {
    const absolute = await realpath(path.join(root, file));
    const relative = path.relative(await realpath(root), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Список за пределами репозитория: ${file}`);
    snapshots[file] = await readFile(absolute, 'utf8');
    if ((await runGit(['status', '--porcelain=v1', '-z', '--', file])).length) changed.push(file);
    if ((await runGit(['diff', '--cached', '--name-only', '--', file])).trim() &&
        (await runGit(['diff', '--name-only', '--', file])).trim()) throw new Error(`В ${file} частично staged изменения. Сначала согласуйте индекс и файл.`);
  }
  console.log(`Списки: ${files.join(', ')}. Ветка: ${branch}. Роутер: ${user}@${host}:${port}.`);
  if (args.includes('--dry-run')) {
    console.log(`План: ${changed.length ? `коммит только ${changed.join(', ')}; ` : ''}push в ${remote}/${branch}; ожидание GitHub Raw; обновление списков Forkop через SSH.\nИзменения, push и SSH не выполнялись.`);
    return;
  }
  const lockPath = path.join(tmpdir(), `forkop-${hash(root).slice(0, 20)}.lock`);
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error(`Обновление уже выполняется. После аварии проверьте процессы и удалите ${lockPath}.`); });
  try {
    await lock.writeFile(String(process.pid));
    const ref = `refs/heads/${branch}`;
    const remoteHead = (await runGit(['ls-remote', '--exit-code', '--heads', remote, ref])).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(remoteHead)) throw new Error('Не удалось определить удалённый HEAD.');
    await runGit(['fetch', '--no-tags', '--', remote, ref]);
    await runGit(['merge-base', '--is-ancestor', remoteHead, 'HEAD']);
    const blobs = {};
    for (const file of files) {
      if (await readFile(path.join(root, file), 'utf8') !== snapshots[file]) throw new Error(`Файл ${file} изменился во время проверки. Повторите запуск.`);
      blobs[file] = (await runGit(['hash-object', `--path=${file}`, '--', file])).trim();
    }
    if (changed.length) {
      await runGit(['diff', '--check', '--', ...changed]);
      await runGit(['add', '--', ...changed]);
      await runGit(['commit', '--only', '-m', 'Update Forkop domain lists', '--', ...changed]);
    }
    const head = (await runGit(['rev-parse', 'HEAD'])).trim();
    for (const file of files) if ((await runGit(['rev-parse', `${head}:${file}`])).trim() !== blobs[file]) throw new Error(`В коммите другая версия ${file}. Push остановлен.`);
    await runGit(['push', '--', remote, `HEAD:${ref}`]);
    if ((await runGit(['ls-remote', '--exit-code', '--heads', remote, ref])).trim().split(/\s+/)[0] !== head) throw new Error('Не удалось подтвердить push. Обновление роутера остановлено.');
    for (const file of files) {
      const expected = hash(await runGit(['show', `${head}:${file}`]));
      const raw = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${encodeURIComponent(branch)}/${file.split('/').map(encodeURIComponent).join('/')}`;
      let ready = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchRaw(raw, { signal: AbortSignal.timeout(15000), redirect: 'error' });
          ready = response.ok && hash(Buffer.from(await response.arrayBuffer())) === expected;
        } catch { ready = false; }
        if (ready) break;
        if (attempt < 2) await sleep(2000);
      }
      if (!ready) throw new Error(`GitHub Raw недоступен или ещё отдаёт старый ${file}. Повторите запуск позже; SSH не выполнялся.`);
    }
    console.log('Списки опубликованы. Подключаюсь к роутеру; при необходимости SSH запросит пароль.');
    await runSSH();
    console.log('Готово: GitHub обновлён, Forkop подтвердил обновление списков.');
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
}
