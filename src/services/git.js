import { run } from '../utils/process.js';
import { AppError } from '../utils/errors.js';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

export async function findRoot(cwd, runner = run) {
  const r = await runner('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (r.code) throw new AppError('Запустите domains внутри существующего Git-репозитория.', 'GIT');
  return r.stdout.trim();
}

export class GitService {
  constructor(config, runner = run) { this.config = config; this.runner = runner; }
  async exec(args, allowFailure = false) {
    const r = await this.runner('git', ['--literal-pathspecs', ...args], {
      cwd: this.config.root, timeoutMs: this.config.github.timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    });
    if (r.code && !allowFailure) {
      const output = `${r.stderr}\n${r.stdout}`;
      if (/non-fast-forward|rejected|fetch first|CONFLICT|diverged/i.test(output)) throw new AppError('Конфликт локальной и удалённой веток. Разрешите его вручную; push и обновление роутера остановлены.', 'GIT_CONFLICT');
      if (/permission denied|authentication|could not read Username|publickey/i.test(output)) throw new AppError('Ошибка авторизации GitHub. Проверьте SSH-ключ/агент или Git credential helper.', 'GIT_AUTH');
      throw new AppError(`Ошибка Git (${args[0]}): ${output.trim().slice(0, 2000) || `код ${r.code}`}`, 'GIT');
    }
    return r;
  }
  async listFiles() {
    const r = await this.exec(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return [...new Set(r.stdout.split('\0').filter((p) => p.toLowerCase().endsWith('.lst')))];
  }
  async status() {
    const branch = (await this.exec(['branch', '--show-current'])).stdout.trim();
    const remote = this.config.github.remote;
    const url = (await this.exec(['remote', 'get-url', remote])).stdout.trim();
    const status = (await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
    return { branch, remote, url, dirty: !!status, status };
  }
  async changed(files) {
    const result = [];
    for (const file of files) {
      const r = await this.exec(['status', '--porcelain=v1', '-z', '--', file]);
      if (r.stdout) result.push(file);
    }
    return result;
  }
  async inspect(files) {
    const status = await this.status();
    if (!status.branch) throw new AppError('Detached HEAD: переключитесь на ветку.', 'GIT');
    const branch = this.config.github.branch === 'auto' ? status.branch : this.config.github.branch;
    if (branch !== status.branch) throw new AppError('github.branch должен совпадать с текущей веткой.', 'GIT');
    await this.exec(['check-ref-format', '--branch', branch]);
    const unresolved = await this.exec(['diff', '--name-only', '--diff-filter=U']);
    if (unresolved.stdout.trim()) throw new AppError('В репозитории есть неразрешённые конфликты.', 'GIT_CONFLICT');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      if (!(await this.exec(['rev-parse', '-q', '--verify', name], true)).code) throw new AppError('Завершите текущую операцию Git перед sync.', 'GIT');
    }
    for (const name of ['rebase-merge', 'rebase-apply', 'sequencer']) {
      const location = (await this.exec(['rev-parse', '--git-path', name])).stdout.trim();
      if (location) {
        const exists = await access(path.resolve(this.config.root, location)).then(() => true, () => false);
        if (exists) throw new AppError('Завершите текущий rebase/cherry-pick перед sync.', 'GIT');
      }
    }
    const changed = await this.changed(files);
    for (const file of changed) {
      const staged = await this.exec(['diff', '--cached', '--name-only', '--', file]);
      const unstaged = await this.exec(['diff', '--name-only', '--', file]);
      if (staged.stdout && unstaged.stdout) throw new AppError(`В ${file} есть частично staged изменения. Сначала согласуйте индекс и рабочий файл.`, 'GIT_INDEX');
    }
    const pushUrls = (await this.exec(['remote', 'get-url', '--push', '--all', status.remote])).stdout.trim().split('\n');
    if (pushUrls.length !== 1 || pushUrls[0] !== status.url) throw new AppError('Для безопасной проверки требуется один одинаковый fetch/push URL remote.', 'GIT_REMOTE');
    return { ...status, branch, changed };
  }
  async remoteHead(plan) {
    const r = await this.exec(['ls-remote', '--exit-code', '--heads', plan.remote, `refs/heads/${plan.branch}`]);
    const oid = r.stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new AppError('GitHub не вернул HEAD целевой ветки.', 'GIT_REMOTE');
    return oid;
  }
  async publish(plan) {
    const remoteHead = await this.remoteHead(plan);
    await this.exec(['fetch', '--no-tags', '--', plan.remote, `refs/heads/${plan.branch}`]);
    if ((await this.exec(['merge-base', '--is-ancestor', remoteHead, 'HEAD'], true)).code) {
      throw new AppError('Удалённая ветка содержит новые коммиты. Сначала согласуйте ветки вручную.', 'GIT_CONFLICT');
    }
    const expectedBlobs = {};
    for (const file of plan.files) {
      if (await readFile(path.join(this.config.root, file), 'utf8') !== plan.snapshots[file]) throw new AppError(`Список ${file} изменён после проверки. Повторите sync.`, 'CONCURRENT');
      expectedBlobs[file] = (await this.exec(['hash-object', `--path=${file}`, '--', file])).stdout.trim();
    }
    if (plan.changed.length) {
      await this.exec(['diff', '--check', '--', ...plan.changed]);
      await this.exec(['add', '--', ...plan.changed]);
      await this.exec(['diff', '--cached', '--check', '--', ...plan.changed]);
      await this.exec(['commit', '--only', '-m', 'Update Forkop domain lists', '--', ...plan.changed]);
    }
    const oid = (await this.exec(['rev-parse', 'HEAD'])).stdout.trim();
    const contents = {};
    for (const file of plan.files) {
      const blob = (await this.exec(['rev-parse', `${oid}:${file}`])).stdout.trim();
      if (blob !== expectedBlobs[file]) throw new AppError(`Содержимое ${file} изменилось после проверки. Push остановлен; проверьте локальный коммит и повторите sync.`, 'CONCURRENT');
      contents[file] = (await this.exec(['show', `${oid}:${file}`])).stdout;
    }
    await this.exec(['push', '--', plan.remote, `HEAD:refs/heads/${plan.branch}`]);
    if ((await this.remoteHead(plan)) !== oid) throw new AppError('Не удалось подтвердить опубликованный HEAD. Роутер не обновлялся.', 'GIT_VERIFY');
    const modifiedFiles = (await this.exec(['diff', '--name-only', '-z', remoteHead, oid, '--', ...plan.files])).stdout.split('\0').filter(Boolean);
    return { oid, modifiedFiles, contents };
  }
}
