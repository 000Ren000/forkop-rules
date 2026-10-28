import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { optionalRead } from '../utils/files.js';
import { registerSecret } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export const expandHome = (file) => file.startsWith('~/') || file.startsWith('~\\') ? path.join(os.homedir(), file.slice(2)) : path.resolve(file);

export async function loadConfig(root, environment = process.env) {
  const defaults = JSON.parse(await readFile(new URL('../../config.example.json', import.meta.url), 'utf8'));
  let local;
  try { local = JSON.parse(await optionalRead(path.join(root, 'config.json')) || '{}'); }
  catch { throw new AppError('config.json содержит неверный JSON.', 'CONFIG'); }
  const dotenv = parseEnv(await optionalRead(path.join(root, '.env')) || '');
  const env = { ...dotenv, ...environment };
  registerSecret(env.ROUTER_PASSWORD);
  registerSecret(env.ROUTER_KEY_PASSPHRASE);
  const cfg = { root };
  for (const group of ['router', 'github', 'domains', 'forkop']) {
    if (local[group] !== undefined && (!local[group] || typeof local[group] !== 'object' || Array.isArray(local[group]))) {
      throw new AppError(`Неверная секция config.json: ${group}.`, 'CONFIG');
    }
    cfg[group] = { ...defaults[group], ...local[group] };
  }
  if ('password' in cfg.router || 'passphrase' in cfg.router) throw new AppError('Секреты задаются только через .env или окружение.', 'CONFIG');
  const overrides = { ROUTER_HOST: ['router', 'host'], ROUTER_PORT: ['router', 'port'], ROUTER_USER: ['router', 'username'],
    ROUTER_AUTH: ['router', 'auth'], ROUTER_SSH_KEY: ['router', 'sshKey'], ROUTER_KNOWN_HOSTS: ['router', 'knownHosts'],
    GITHUB_REMOTE: ['github', 'remote'], GITHUB_BRANCH: ['github', 'branch'] };
  for (const [key, [group, field]] of Object.entries(overrides)) if (env[key]) cfg[group][field] = key === 'ROUTER_PORT' ? Number(env[key]) : env[key];
  cfg.router.password = env.ROUTER_PASSWORD || '';
  cfg.router.passphrase = env.ROUTER_KEY_PASSPHRASE || '';
  for (const [obj, field, min, max] of [[cfg.router, 'port', 1, 65535], [cfg.router, 'connectTimeoutMs', 100, 60000],
    [cfg.github, 'timeoutMs', 100, 300000], [cfg.forkop, 'retryCount', 1, 10], [cfg.forkop, 'retryDelayMs', 0, 60000],
    [cfg.forkop, 'timeoutMs', 100, 600000], [cfg.forkop, 'rawTimeoutMs', 100, 60000], [cfg.forkop, 'verifyTimeoutMs', 100, 120000]]) {
    if (!Number.isInteger(obj[field]) || obj[field] < min || obj[field] > max) throw new AppError(`Неверная настройка ${field}.`, 'CONFIG');
  }
  for (const field of ['host', 'username', 'sshKey', 'knownHosts']) {
    if (typeof cfg.router[field] !== 'string' || !cfg.router[field] || /[\r\n\x00]/.test(cfg.router[field])) throw new AppError(`Неверная настройка router.${field}.`, 'CONFIG');
  }
  if (!['password', 'key', 'agent'].includes(cfg.router.auth)) throw new AppError('router.auth: password, key или agent.', 'CONFIG');
  for (const field of ['remote', 'branch']) if (typeof cfg.github[field] !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(cfg.github[field])) throw new AppError(`Неверная настройка github.${field}.`, 'CONFIG');
  if (typeof cfg.domains.file !== 'string' || ['autoSync', 'sort'].some((key) => typeof cfg.domains[key] !== 'boolean')) throw new AppError('Неверные настройки domains.', 'CONFIG');
  if (cfg.domains.files && (!Array.isArray(cfg.domains.files) || cfg.domains.files.some((f) => typeof f !== 'string'))) throw new AppError('domains.files должен быть массивом путей.', 'CONFIG');
  if (!['auto', 'forkop list_update', 'forkop clash_api PUT /providers/rules'].includes(cfg.forkop.updateCommand)) {
    throw new AppError('Разрешены только штатные команды обновления списков Forkop или auto.', 'CONFIG');
  }
  cfg.router.sshKey = expandHome(cfg.router.sshKey);
  cfg.router.knownHosts = expandHome(cfg.router.knownHosts);
  return cfg;
}
