#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { findRoot, GitService } from './services/git.js';
import { DomainService } from './services/domains.js';
import { SSHService } from './services/ssh.js';
import { ForkopService } from './services/forkop.js';
import { SyncService } from './services/sync.js';
import { loadConfig } from './config/loader.js';
import { execute } from './commands/index.js';
import { logger } from './utils/logger.js';
import { question } from './utils/prompt.js';
import { AppError } from './utils/errors.js';

const help = `domains — менеджер списков Forkop

  domains add example.com [ещё-домены] [--file custom.lst] [--no-sync]
  domains remove example.com [ещё-домены] [--file custom.lst] [--no-sync]
  domains list [--file custom.lst]
  domains search google [--file custom.lst]
  domains check [--file custom.lst]
  domains sync [--file custom.lst] [--dry-run]
  domains status [--offline]
  domains ssh-check
  domains help

Без аргументов — интерактивное меню. add/remove по умолчанию выполняют commit,
push и обновление списков на роутере. --no-sync сохраняет только локальный список.
--dry-run не меняет файлы и не обращается к GitHub или роутеру.`;

export function parseArgs(args) {
  let command;
  const values = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--help' || value === '-h') return { command: 'help', values: [], options: {} };
    if (value === '--file') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new AppError('После --file укажите путь.', 'USAGE');
      options.file = args[++i];
    } else if (value === '--no-sync') options.noSync = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--offline') options.offline = true;
    else if (value.startsWith('-')) throw new AppError(`Неизвестный флаг: ${value}`, 'USAGE');
    else if (!command) command = value;
    else values.push(value);
  }
  if (command && !['add', 'remove', 'list', 'search', 'check', 'sync', 'status', 'ssh-check', 'help'].includes(command)) throw new AppError('Неизвестная команда. Выполните domains help.', 'USAGE');
  if (['add', 'remove', 'search'].includes(command) ? !values.length : values.length) throw new AppError('Неверное количество аргументов. Выполните domains help.', 'USAGE');
  if (command === 'search' && values.length !== 1) throw new AppError('Для search передайте одну строку поиска в кавычках.', 'USAGE');
  if (options.dryRun && command !== 'sync' || options.noSync && !['add', 'remove'].includes(command) || options.offline && command !== 'status' || options.file && !['add', 'remove', 'list', 'search', 'check', 'sync'].includes(command)) throw new AppError('Флаг не поддерживается этой командой.', 'USAGE');
  return { command, values, options };
}

async function menu(context) {
  if (!process.stdin.isTTY) throw new AppError('Интерактивное меню требует терминал. Выполните domains help.', 'USAGE');
  const mapping = { 1: 'add', 2: 'remove', 3: 'list', 4: 'search', 5: 'sync', 6: 'status', 7: 'ssh-check' };
  while (true) {
    logger.info('\n1. Добавить домен\n2. Удалить домен\n3. Просмотреть список доменов\n4. Найти домен\n5. Синхронизировать с GitHub и роутером\n6. Проверить состояние\n7. Проверить SSH-подключение\n8. Выход');
    const choice = await question('Выберите пункт: ');
    if (choice === '8') return;
    const command = mapping[choice];
    if (!command) { logger.warn('Введите число от 1 до 8.'); continue; }
    try {
      const values = command === 'search' ? [await question('Строка поиска: ')] : ['add', 'remove'].includes(command) ? (await question('Домены через пробел: ')).split(/\s+/).filter(Boolean) : [];
      if (['add', 'remove', 'search'].includes(command) && !values[0]) continue;
      await execute(command, values, {}, context);
    } catch (error) { logger.error(error.message); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') { logger.info(help); return; }
  const root = await findRoot(process.cwd());
  const config = await loadConfig(root);
  const git = new GitService(config), domains = new DomainService(config, git), ssh = new SSHService(config);
  const forkop = new ForkopService(config, ssh, { log: logger.info });
  const sync = new SyncService(config, { git, domains, forkop, log: logger.info });
  const context = { config, git, domains, forkop, sync, log: logger.info };
  if (!parsed.command) return menu(context);
  return execute(parsed.command, parsed.values, parsed.options, context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { logger.error(error.message); process.exitCode = 1; });
}
