import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SSHService, SSHSession, knownKeys } from '../src/services/ssh.js';
import { fixture, ok } from './helpers.js';
import { redact, registerSecret } from '../src/utils/logger.js';
import http from 'node:http';
import net from 'node:net';

const key = Buffer.from('test-only-host-key');
const runner = async () => ok(`192.168.0.1 ssh-ed25519 ${key.toString('base64')}\n`);
test('known_hosts проверяется побайтово: неизвестный/изменённый ключ отвергается', async (t) => {
  const { config } = await fixture(t); const verify = await knownKeys(config.router, runner);
  assert.equal(verify(key), true); assert.equal(verify(Buffer.from('other-key')), false);
  await assert.rejects(knownKeys(config.router, async () => ({ ...ok(), code: 1 })), { code: 'HOST_KEY' });
});
test('known_hosts: нестандартный порт и отозванный ключ', async (t) => {
  const { config } = await fixture(t); config.router.port = 2222;
  const verify = await knownKeys(config.router, async (file, args) => {
    assert.equal(file, 'ssh-keygen'); assert.equal(args[1], '[192.168.0.1]:2222');
    return ok(`[192.168.0.1]:2222 ssh-ed25519 ${key.toString('base64')}\n@revoked [192.168.0.1]:2222 ssh-ed25519 ${key.toString('base64')}`);
  }); assert.equal(verify(key), false);
});
test('SSH: отсутствующий секрет запрашивается, hostVerifier обязателен', async (t) => {
  const { config } = await fixture(t); let prompts = 0, captured;
  class Client extends EventEmitter {
    connect(options) { captured = options; queueMicrotask(() => this.emit(options.hostVerifier(key) ? 'ready' : 'error', new Error())); }
    end() {} destroy() {}
  }
  const ssh = new SSHService(config, { runner, prompt: async () => { prompts++; return 'test-only-password'; }, clientFactory: () => new Client() });
  const session = await ssh.connect(); session.close(); assert.equal(prompts, 1); assert.equal(captured.password, 'test-only-password'); assert.equal(captured.hostVerifier(key), true);
});
test('SSH: неверная аутентификация выдаёт понятную ошибку', async (t) => {
  const { config } = await fixture(t); config.router.password = 'wrong-test-only';
  class Client extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('error', { level: 'client-authentication' })); }
    destroy() {}
  }
  const ssh = new SSHService(config, { runner, clientFactory: () => new Client() });
  await assert.rejects(ssh.connect(), /Неправильный пароль SSH/);
});
test('SSH: неизвестный host key блокирует запрос пароля и соединение', async (t) => {
  const { config } = await fixture(t); let touched = false;
  const ssh = new SSHService(config, { runner: async () => ({ ...ok(), code: 1 }), prompt: async () => { touched = true; }, clientFactory: () => { touched = true; } });
  await assert.rejects(ssh.connect(), { code: 'HOST_KEY' }); assert.equal(touched, false);
});
test('SSH: код завершения и stderr возвращаются без изменения', async () => {
  class Client extends EventEmitter {
    exec(command, cb) {
      const stream = new EventEmitter(); stream.stderr = new EventEmitter(); cb(null, stream);
      queueMicrotask(() => { stream.emit('data', Buffer.from('output')); stream.stderr.emit('data', Buffer.from('failure')); stream.emit('close', 9); });
    }
  }
  const r = await new SSHSession(new Client()).exec('test'); assert.deepEqual(r, { code: 9, stdout: 'output', stderr: 'failure' });
});
test('секреты и управляющие символы не выводятся', () => {
  registerSecret('unique-test-secret');
  assert.equal(redact('secret unique-test-secret \x1b[31mtext'), 'secret [секрет скрыт] text');
  assert.ok(!redact('https://user:password@example.com/x?token=abc').includes('password'));
});
test('API читается через транспорт SSH к loopback, без внешнего HTTP-подключения', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/providers/rules'); assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    res.setHeader('Content-Type', 'application/json'); res.end('{"providers":{}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  class Client extends EventEmitter {
    forwardOut(srcHost, srcPort, host, port, callback) {
      assert.equal(host, '127.0.0.1'); assert.equal(port, 9090);
      const socket = net.connect(server.address().port, '127.0.0.1'); callback(null, socket);
    }
  }
  const r = await new SSHSession(new Client()).request({ port: 9090, secret: 'fixture-secret' }, '/providers/rules');
  assert.equal(r.code, 200); assert.deepEqual(JSON.parse(r.body), { providers: {} });
});
test('SSH exec имеет конечный таймаут', async () => {
  class Client extends EventEmitter { exec() {} destroy() { this.emit('close'); } }
  await assert.rejects(new SSHSession(new Client()).exec('never-finishes', 10), { code: 'SSH_TIMEOUT' });
});
