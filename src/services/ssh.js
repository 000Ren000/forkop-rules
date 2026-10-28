import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { run } from '../utils/process.js';
import { passwordPrompt } from '../utils/prompt.js';
import { registerSecret } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

// Поиск OpenSSH обрабатывает в том числе hashed known_hosts и нестандартные порты.
export async function knownKeys(router, runner = run) {
  const host = router.port === 22 ? router.host : `[${router.host}]:${router.port}`;
  const r = await runner('ssh-keygen', ['-F', host, '-f', router.knownHosts], { timeoutMs: 5000 });
  if (r.code) throw new AppError('SSH host key неизвестен или known_hosts недоступен. Сверьте fingerprint роутера и добавьте его штатным OpenSSH вручную.', 'HOST_KEY');
  const keys = [], revoked = [], algorithms = new Set();
  for (const line of r.stdout.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    const marker = fields[0].startsWith('@') ? fields.shift() : '';
    const key = Buffer.from(fields[2] || '', 'base64');
    if (!key.length) continue;
    if (marker === '@revoked') revoked.push(key);
    else if (!marker) {
      keys.push(key);
      if (fields[1] === 'ssh-rsa') { algorithms.add('rsa-sha2-512'); algorithms.add('rsa-sha2-256'); }
      else algorithms.add(fields[1]);
    }
  }
  if (!keys.length) throw new AppError('Нет поддерживаемого host key в known_hosts. Host certificates требуют отдельной настройки OpenSSH.', 'HOST_KEY');
  const matches = (a, b) => a.length === b.length && timingSafeEqual(a, b);
  const verifier = (key) => !revoked.some((k) => matches(k, key)) && keys.some((k) => matches(k, key));
  verifier.algorithms = [...algorithms];
  return verifier;
}

export class SSHService {
  constructor(config, { runner = run, prompt = passwordPrompt, clientFactory } = {}) {
    this.config = config; this.runner = runner; this.prompt = prompt; this.clientFactory = clientFactory;
  }
  async connect() {
    const cfg = this.config.router;
    const verify = await knownKeys(cfg, this.runner);
    let password = cfg.password;
    const options = { host: cfg.host, port: cfg.port, username: cfg.username, readyTimeout: cfg.connectTimeoutMs,
      keepaliveInterval: 5000, keepaliveCountMax: 2, tryKeyboard: false,
      algorithms: { serverHostKey: verify.algorithms } };
    if (cfg.auth === 'password') {
      password ||= await this.prompt();
      if (!password) throw new AppError('Пароль SSH не задан.', 'SECRET');
      registerSecret(password);
      options.password = password;
    } else if (cfg.auth === 'key') {
      try { options.privateKey = await readFile(cfg.sshKey); }
      catch { throw new AppError('Не удалось прочитать приватный SSH-ключ.', 'SSH_KEY'); }
      options.passphrase = cfg.passphrase || undefined;
    } else {
      if (!process.env.SSH_AUTH_SOCK) throw new AppError('Для router.auth=agent требуется SSH_AUTH_SOCK.', 'SSH_KEY');
      options.agent = process.env.SSH_AUTH_SOCK;
    }
    const factory = this.clientFactory || (() => new this.Client());
    if (!this.clientFactory) this.Client = (await import('ssh2')).default.Client;
    const client = factory();
    let hostRejected = false;
    options.hostVerifier = (key) => { const ok = verify(key); if (!ok) hostRejected = true; return ok; };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.destroy(); reject(new AppError('Роутер недоступен: таймаут SSH.', 'SSH_TIMEOUT')); }, cfg.connectTimeoutMs);
      client.once('ready', () => { clearTimeout(timer); resolve(); });
      client.on('error', (error) => {
        clearTimeout(timer);
        const message = hostRejected ? 'SSH host key изменился или отозван. Подключение отклонено.' : error.level === 'client-authentication' ? 'Неправильный пароль SSH или ключ не принят.' : 'Ошибка SSH: роутер недоступен или соединение прервано.';
        reject(new AppError(message, hostRejected ? 'HOST_KEY' : 'SSH'));
      });
      client.once('close', () => { clearTimeout(timer); reject(new AppError('SSH-соединение закрыто.', 'SSH')); });
      client.connect(options);
    }).catch((error) => { client.destroy(); throw error; });
    return new SSHSession(client);
  }
}

export class SSHSession {
  constructor(client) { this.client = client; }
  // HTTP только через уже проверенное SSH-соединение к loopback роутера.
  request(api, requestPath, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let socket, request, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.client.removeListener('close', disconnected);
        this.client.removeListener('error', disconnected);
        if (error) { socket?.destroy(); request?.destroy(); reject(error); }
        else { socket?.end(); resolve(result); }
      };
      const disconnected = () => finish(new AppError('SSH-соединение прервано во время проверки API.', 'SSH'));
      this.client.once('close', disconnected).once('error', disconnected);
      const timer = setTimeout(() => {
        finish(new AppError('Таймаут проверки API ядра через SSH.', 'API_TIMEOUT'));
      }, timeoutMs);
      const fail = () => finish(new AppError('API ядра недоступен через SSH.', 'API'));
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', api.port, (error, channel) => {
        if (settled) { channel?.destroy(); return; }
        if (error) return fail();
        socket = channel;
        const agent = new http.Agent({ keepAlive: false });
        agent.createConnection = () => channel;
        request = http.request({ hostname: '127.0.0.1', port: api.port, path: requestPath, method: 'GET',
          agent,
          headers: api.secret ? { Authorization: `Bearer ${api.secret}` } : {} }, (response) => {
          let body = '', bytes = 0;
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 8 * 1024 * 1024) { response.destroy(); fail(); }
            else body += chunk;
          });
          response.once('error', fail);
          response.once('end', () => finish(null, { code: response.statusCode, body }));
        });
        request.once('error', fail);
        request.end();
      });
    });
  }
  exec(command, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', size = 0, done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer); this.client.removeListener('close', closed); this.client.removeListener('error', failed);
        if (error) reject(error); else resolve(result);
      };
      const closed = () => finish(new AppError('SSH-соединение прервано во время команды.', 'SSH'));
      const failed = () => finish(new AppError('Ошибка SSH во время команды.', 'SSH'));
      this.client.once('close', closed).once('error', failed);
      const timer = setTimeout(() => {
        finish(new AppError('Таймаут SSH-команды. Удалённая операция могла продолжить работу; проверьте состояние перед повтором.', 'SSH_TIMEOUT'));
        this.client.destroy();
      }, timeoutMs);
      this.client.exec(command, (error, stream) => {
        if (error) return finish(new AppError('SSH не разрешил выполнение команды.', 'SSH_EXEC'));
        const collect = (stderrStream) => (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            stream.close(); finish(new AppError('Превышен лимит диагностического вывода SSH.', 'OUTPUT_LIMIT')); return;
          }
          if (stderrStream) stderr += chunk; else stdout += chunk;
        };
        stream.on('data', collect(false));
        stream.stderr.on('data', collect(true));
        stream.once('error', failed);
        stream.once('close', (code) => finish(null, { code, stdout, stderr }));
      });
    });
  }
  close() { this.client.end(); }
}
