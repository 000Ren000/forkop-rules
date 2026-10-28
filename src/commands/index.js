import { withLock } from '../utils/lock.js';
import { AppError } from '../utils/errors.js';

export async function execute(command, values, options, context) {
  const { config, domains, git, forkop, sync, log } = context;
  if (command === 'add' || command === 'remove') {
    return withLock(config.root, async () => {
      const result = await domains[command](values, options.file);
      if (command === 'add') {
        if (result.added.length) log(`Добавлено в ${result.file}: ${result.added.join(', ')}.`);
        if (result.duplicates.length) log(`Уже есть в списках: ${result.duplicates.join(', ')}.`);
      } else {
        for (const row of result.removed) log(`Удалён ${row.value} из ${row.file}.`);
        if (result.missing.length) log(`Домены не найдены: ${result.missing.join(', ')}.`);
      }
      if (result.changed && config.domains.autoSync && !options.noSync) {
        try { await sync.sync({ file: options.file, locked: true }); }
        catch (error) { throw new AppError(`Локальные изменения сохранены. Синхронизация не завершена: ${error.message} После устранения причины выполните domains sync.`, error.code); }
      } else if (result.changed) log('Синхронизация отключена. Для публикации выполните domains sync.');
      return result;
    });
  }
  if (command === 'list' || command === 'search') {
    const rows = command === 'list' ? await domains.entries(options.file) : await domains.search(values[0], options.file);
    for (const row of rows) log(`${row.value}  (${row.file}:${row.line})`);
    log(`Всего доменов: ${rows.length}.`);
    return rows;
  }
  if (command === 'check') {
    const result = await domains.check(options.file);
    for (const row of result.issues) log(`${row.file}:${row.line} [${row.level}] ${row.message}`);
    log(`Проверено файлов: ${result.documents.length}; доменов: ${result.documents.flatMap((d) => d.lines).filter((r) => r.type === 'domain').length}; ошибок: ${result.issues.filter((r) => r.level === 'error').length}.`);
    if (!result.valid) throw new AppError('Проверка списков завершилась с ошибками.', 'CHECK');
    return result;
  }
  if (command === 'sync') return sync.sync({ dryRun: options.dryRun, file: options.file });
  if (command === 'ssh-check') {
    const status = await forkop.status();
    log(`SSH: подключение и host key проверены. Forkop ${status.version}; команда: ${status.command}.`);
    return status;
  }
  if (command === 'status') {
    const state = await git.status();
    log(`Ветка: ${state.branch || 'detached HEAD'}\nRemote ${state.remote}: ${state.url}\nЛокальные изменения: ${state.dirty ? 'есть' : 'нет'}`);
    log(`Доменов: ${(await domains.entries(options.file)).length}.`);
    const last = await sync.state();
    log(`Последняя синхронизация: ${last ? `${last.at || ''} — ${last.success ? 'успешно' : 'ошибка'}; ${last.message}` : 'нет данных'}`);
    if (options.offline) { log('Роутер, SSH и команда обновления: не проверялись (--offline).'); return state; }
    try {
      const status = await forkop.status();
      log(`Роутер: доступен. SSH: подключение и host key проверены. Forkop: ${status.version}. Команда: ${status.command}.`);
      return { ...state, router: status };
    } catch (error) {
      log(`${error.sshConnected ? 'Роутер: доступен. SSH: подключение проверено. Forkop' : 'Роутер/SSH/команда обновления'}: ${error.message}`);
      throw error;
    }
  }
  throw new AppError('Неизвестная команда. Выполните domains help.', 'USAGE');
}
