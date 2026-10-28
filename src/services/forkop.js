import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { registerSecret } from '../utils/logger.js';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const digest = (text) => createHash('sha256').update(text).digest('hex');

export function githubRawUrl(remote, branch, file) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new AppError('Автоматическая проверка Raw поддерживает remote на github.com без секретов в URL.', 'RAW_URL');
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${encodeURIComponent(branch)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export class ForkopService {
  constructor(config, ssh, { fetcher = fetch, sleep = delay, log = () => {} } = {}) {
    this.config = config; this.ssh = ssh; this.fetcher = fetcher; this.sleep = sleep; this.log = log;
  }
  async probe(session) {
    const installed = await session.exec('command -v forkop');
    if (installed.code || !installed.stdout.trim()) throw new AppError('Forkop не установлен: command -v forkop не нашёл команду.', 'FORKOP');
    const help = await session.exec('forkop help');
    const version = await session.exec('forkop show_version');
    const helpText = `${help.stdout}\n${help.stderr}`;
    const hasV2 = /^\s*clash_api\s/m.test(helpText);
    const hasV1 = /^\s*list_update\s/m.test(helpText);
    const configured = this.config.forkop.updateCommand;
    // В 1.x тоже есть clash_api, но обновление rule providers появилось в 2.x.
    const command = configured === 'auto' ? (hasV1 ? 'forkop list_update' : 'forkop clash_api PUT /providers/rules') : configured;
    if (command.includes('clash_api') ? !hasV2 : !hasV1) throw new AppError('Штатная команда обновления списков отсутствует в установленной версии Forkop. Проверьте forkop help и forkop.updateCommand.', 'FORKOP_COMMAND');
    return { version: version.code ? 'не определена' : version.stdout.trim(), command, mode: command.includes('clash_api') ? 'v2' : 'v1' };
  }
  async rawReady(sources) {
    const cfg = this.config.forkop;
    for (let attempt = 1; attempt <= cfg.retryCount; attempt++) {
      let ready = true;
      for (const source of sources) {
        try {
          // Проверяется точный URL, который скачивает ядро, без cache-buster.
          const response = await this.fetcher(source.url, { signal: AbortSignal.timeout(cfg.rawTimeoutMs), headers: { 'Cache-Control': 'no-cache' }, redirect: 'error' });
          if (!response.ok) { await response.body?.cancel(); ready = false; continue; }
          let size = 0; const chunks = [];
          if (response.body) {
            for await (const chunk of response.body) {
              size += chunk.length;
              if (size > 8 * 1024 * 1024) throw new AppError('Raw-файл превышает 8 МБ.', 'RAW');
              chunks.push(Buffer.from(chunk));
            }
          }
          if (digest(Buffer.concat(chunks)) !== digest(source.text)) ready = false;
        } catch { ready = false; }
      }
      if (ready) return;
      if (attempt < cfg.retryCount) { this.log(`GitHub Raw ещё не отдаёт опубликованные файлы: попытка ${attempt}/${cfg.retryCount}.`); await this.sleep(cfg.retryDelayMs); }
    }
    throw new AppError('GitHub Raw недоступен или возвращает старую версию списка. Обновление роутера остановлено; повторите domains sync позднее.', 'RAW_STALE');
  }
  async runtime(session) {
    const r = await session.exec('p=$(uci -q get forkop.settings.config_path); [ -n "$p" ] && [ -r "$p" ] && cat "$p"');
    let config;
    try { if (r.code) throw new Error(); config = JSON.parse(r.stdout); }
    catch { throw new AppError('Не удалось прочитать рабочую конфигурацию по forkop.settings.config_path. Примените настройки Forkop в LuCI.', 'RUNTIME'); }
    const controller = config.experimental?.clash_api;
    if (controller?.secret) registerSecret(controller.secret);
    const match = /:(\d+)$/.exec(controller?.external_controller || '');
    const port = Number(match?.[1]);
    if (!port || port > 65535) throw new AppError('Clash API ядра не настроен. Включите штатный контроллер Forkop на роутере.', 'API');
    return { config, api: { port, secret: controller.secret || '' } };
  }
  async providers(session, api) {
    const r = await session.request(api, '/providers/rules', this.config.forkop.verifyTimeoutMs);
    try {
      if (r.code !== 200) throw new Error();
      const value = JSON.parse(r.body);
      if (!value.providers || typeof value.providers !== 'object') throw new Error();
      return value.providers;
    } catch { throw new AppError('Не удалось получить активные rule providers ядра. Применение списков не подтверждено.', 'VERIFY'); }
  }
  async updateV2(session, probe, sources, { baseline, checkpoint } = {}) {
    const { config, api } = await this.runtime(session);
    const ruleSets = config.route?.rule_set || [];
    const targets = sources.map((source) => {
      const sets = ruleSets.filter((r) => r.type === 'remote' && r.url === source.url);
      if (!sets.length) throw new AppError(`Список ${source.file} не подключён к рабочей конфигурации Forkop 2. Добавьте Raw URL в наборы правил нужной секции LuCI и примените настройки.`, 'NOT_CONFIGURED');
      return sets.map((r) => ({ tag: r.tag, requireRevision: source.requireRevision }));
    }).flat();
    const current = await this.providers(session, api);
    if (targets.some(({ tag }) => !current[tag])) throw new AppError('В рабочем ядре отсутствует подключённый список. Примените конфигурацию в LuCI.', 'VERIFY');
    const before = Object.fromEntries(targets.map(({ tag }) => [tag, baseline?.[tag] || { revision: current[tag].revision, updatedAt: current[tag].updatedAt }]));
    await checkpoint?.(before);
    let lastCode = 'VERIFY', diagnostic = '';
    for (let attempt = 1; attempt <= this.config.forkop.retryCount; attempt++) {
      this.log(`Forkop ${probe.version}: обновление наборов правил, попытка ${attempt}/${this.config.forkop.retryCount}.`);
      const result = await session.exec(probe.command, this.config.forkop.timeoutMs);
      let response;
      try { response = JSON.parse(result.stdout); } catch { /* ниже выдаётся безопасная диагностика */ }
      if (/already.*(running|updat)|in progress|busy/i.test(`${result.stdout}\n${result.stderr}`)) throw new AppError('Обновление списков на роутере уже выполняется.', 'FORKOP_BUSY');
      if (result.code === 0 && response?.status >= 200 && response.status < 300) {
        const after = await this.providers(session, api);
        // Revision меняется после загрузки и установки правил в работающем ядре.
        // updatedAt отдельно подтверждает HTTP 304 при ручном повторе без изменений.
        const applied = targets.every(({ tag, requireRevision }) => Number(after[tag]?.revision) > Number(before[tag]?.revision) ||
          (!requireRevision && Date.parse(after[tag]?.updatedAt) > Date.parse(before[tag]?.updatedAt)));
        if (applied) {
          await this.rawReady(sources);
          return { mode: 'v2', version: probe.version, verified: true, providers: targets.map(({ tag }) => ({ tag, revision: after[tag].revision })) };
        }
        lastCode = 'VERIFY';
      } else {
        lastCode = 'FORKOP_UPDATE';
        diagnostic = ` Код SSH: ${result.code}; HTTP: ${response?.status ?? 'нет ответа'}. ${String(response?.body || result.stderr).slice(0, 1500)}`;
      }
      if (attempt < this.config.forkop.retryCount) await this.sleep(this.config.forkop.retryDelayMs);
    }
    throw new AppError(lastCode === 'VERIFY' ? 'Списки скачаны, но обновление активных rule providers не подтверждено (revision/updatedAt). Повторите sync и проверьте журнал Forkop.' : `Forkop сообщил об ошибке обновления наборов правил. Проверьте журнал Forkop и доступность URL на роутере.${diagnostic}`, lastCode);
  }
  async updateV1(session, probe, sources) {
    // Совместимость 1.x: подтверждаем привязку URL и итоговый JSON конкретной секции.
    const refs = await session.exec("uci -q show forkop | grep -E '\\.(domain_ip_lists|remote_domain_lists|remote_subnet_lists)='");
    const targets = [];
    for (const source of sources) {
      const matches = refs.stdout.split('\n').filter((line) => line.includes(`'${source.url}'`));
      if (!matches.length) throw new AppError(`Список ${source.file} не подключён к Forkop. Настройте его Raw URL в LuCI.`, 'NOT_CONFIGURED');
      for (const line of matches) {
        const m = /^forkop\.([\w-]+)\.(domain_ip_lists|remote_domain_lists|remote_subnet_lists)=/.exec(line);
        if (!m) throw new AppError('Не удалось определить секцию списка Forkop 1.x.', 'VERIFY');
        targets.push({ source, path: `/tmp/sing-box/rulesets/${m[1]}-${m[2] === 'domain_ip_lists' ? 'lists' : m[2] === 'remote_domain_lists' ? 'remote-domains' : 'remote-subnets'}-ruleset.json` });
      }
    }
    const busy = await session.exec("p=/var/run/forkop_list_update.pid; [ -r \"$p\" ] && kill -0 \"$(cat \"$p\")\" 2>/dev/null && exit 9; exit 0");
    if (busy.code) throw new AppError('Обновление списков на роутере уже выполняется.', 'FORKOP_BUSY');
    for (let attempt = 1; attempt <= this.config.forkop.retryCount; attempt++) {
      const r = await session.exec(probe.command, this.config.forkop.timeoutMs);
      if (/already.*running|skipping/i.test(r.stdout + r.stderr)) throw new AppError('Обновление списков уже выполняется.', 'FORKOP_BUSY');
      if (!r.code) {
        let valid = true;
        for (const target of targets) {
          const read = await session.exec(`cat ${quote(target.path)}`);
          try {
            const rules = JSON.parse(read.stdout).rules;
            const present = new Set(rules.flatMap((rule) => [...(rule.domain_suffix || []), ...(rule.ip_cidr || [])]));
            if (read.code || !target.source.values.every((v) => present.has(v)) || target.source.removed.some((v) => present.has(v))) valid = false;
          } catch { valid = false; }
        }
        if (valid) return { mode: 'v1', version: probe.version, verified: true };
      }
      if (attempt < this.config.forkop.retryCount) await this.sleep(this.config.forkop.retryDelayMs);
    }
    throw new AppError('Обновление или применение списков Forkop 1.x не подтверждено. Проверьте журнал и runtime JSON.', 'VERIFY');
  }
  async update(sources, verification = {}) {
    await this.rawReady(sources);
    const session = await this.ssh.connect();
    try {
      const probe = await this.probe(session);
      return probe.mode === 'v2' ? await this.updateV2(session, probe, sources, verification) : await this.updateV1(session, probe, sources);
    } finally { session.close(); }
  }
  async status() {
    const session = await this.ssh.connect();
    try { return await this.probe(session); }
    catch (error) { error.sshConnected = true; throw error; }
    finally { session.close(); }
  }
}
