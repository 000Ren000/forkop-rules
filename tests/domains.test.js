import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomain, isSubnet } from '../src/utils/validation.js';
import { DomainService, parseList } from '../src/services/domains.js';
import { fixture } from './helpers.js';

test('нормализация ASCII, IDN и завершающей точки', () => {
  assert.equal(normalizeDomain('EXAMPLE.COM.'), 'example.com');
  assert.equal(normalizeDomain('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(normalizeDomain('a-b.example.com'), 'a-b.example.com');
});
for (const value of ['https://example.com', 'example.com:80', 'a@b.com', 'a b.com', '*.example.com', 'example', 'a..com', '-a.com', 'a_.com', '1.2.3.4', 'a.123', '', 'a.com;touch x', 'a'.repeat(64) + '.com', 'a.com\n']) {
  test(`неверный домен: ${JSON.stringify(value)}`, () => assert.throws(() => normalizeDomain(value), { code: 'DOMAIN' }));
}
test('IP и CIDR', () => {
  for (const value of ['1.2.3.4', '192.168.0.0/24', '::1', '2001:db8::/32']) assert.equal(isSubnet(value), true);
  for (const value of ['1.2.3.4/33', '::/129', '1.2.3.4/-1', '1.2.3.4/24/1', '999.0.0.0', 'example.com']) assert.equal(isSubnet(value), false);
});
test('пакетное добавление, дубликаты без учёта регистра', async (t) => {
  const f = await fixture(t); const svc = new DomainService(f.config, f.git);
  const r = await svc.add(['EXAMPLE.COM', 'New.com', 'NEW.COM']);
  assert.deepEqual(r.added, ['new.com']); assert.deepEqual(r.duplicates, ['example.com']);
  assert.equal(await readFile(path.join(f.root, 'domains.lst'), 'utf8'), 'example.com\nnew.com\n');
});
test('весь пакет валидируется до записи', async (t) => {
  const f = await fixture(t); const svc = new DomainService(f.config, f.git);
  await assert.rejects(svc.add(['ok.com', 'https://bad.com']), { code: 'DOMAIN' });
  assert.equal(await readFile(path.join(f.root, 'domains.lst'), 'utf8'), 'example.com\n');
});
for (const text of ['# Заголовок\r\n\r\nEXAMPLE.COM\r\n1.2.3.4\r\n', '# Header\nexample.com', '# Header\nexample.com\n', '# Header\r\nexample.com']) {
  test(`формат сохраняется при add/remove: ${JSON.stringify(text)}`, async (t) => {
    const f = await fixture(t, { 'actual.lst': text }); const svc = new DomainService(f.config, f.git);
    await svc.add(['new.com']);
    const added = await readFile(path.join(f.root, 'actual.lst'), 'utf8');
    assert.ok(added.startsWith(text));
    await svc.remove(['NEW.COM']);
    const removed = await readFile(path.join(f.root, 'actual.lst'), 'utf8');
    assert.equal(removed, text);
  });
}
test('удаляет все вхождения, оставляет IP, комментарии и чужой файл', async (t) => {
  const f = await fixture(t, { 'domains.lst': '# keep\nexample.com\nEXAMPLE.COM\n1.2.3.4\n', 'other.txt': 'original' });
  const svc = new DomainService(f.config, f.git), r = await svc.remove(['example.com', 'missing.com']);
  assert.equal(r.removed.length, 2); assert.deepEqual(r.missing, ['missing.com']);
  assert.equal(await readFile(path.join(f.root, 'domains.lst'), 'utf8'), '# keep\n1.2.3.4\n');
  assert.equal(await readFile(path.join(f.root, 'other.txt'), 'utf8'), 'original');
});
test('поиск по подстроке без учёта регистра', async (t) => {
  const f = await fixture(t, { 'domains.lst': 'google.com\nmail.google.com\nexample.com\n' });
  assert.equal((await new DomainService(f.config, f.git).search('GOOGLE')).length, 2);
});
test('check: комментарии, пустые строки, дубликаты и ошибки', async (t) => {
  const f = await fixture(t, { 'domains.lst': '# comment\n\nexample.com\nEXAMPLE.COM\nbad value\n1.2.3.4/33\n' });
  const r = await new DomainService(f.config, f.git).check();
  assert.equal(r.valid, false);
  assert.equal(r.issues.filter((i) => i.level === 'error').length, 3);
  assert.equal(r.issues.filter((i) => i.level === 'info').length, 1);
});
test('check: BOM сохраняется при чтении и считается непереносимым', async (t) => {
  const f = await fixture(t, { 'domains.lst': '\ufeffexample.com\n' });
  const r = await new DomainService(f.config, f.git).check();
  assert.equal(r.documents[0].bom, '\ufeff'); assert.equal(r.valid, false);
});
test('UTF-8 проверяется строго', async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'domains.lst'), Buffer.from([0xff]));
  await assert.rejects(new DomainService(f.config, f.git).check(), { code: 'FORMAT' });
});
test('автовыбор фактического доменного файла рядом с IP-списком', async (t) => {
  const f = await fixture(t, { 'services.lst': 'example.com\n', 'ips.lst': '1.2.3.4\n' });
  assert.equal(await new DomainService(f.config, f.git).target(), 'services.lst');
});
test('неоднозначный выбор требует --file; дубликаты между списками', async (t) => {
  const f = await fixture(t, { 'a.lst': 'example.com\n', 'b.lst': 'second.com\n' }); const svc = new DomainService(f.config, f.git);
  await assert.rejects(svc.add(['third.com']), { code: 'FILE' });
  assert.equal((await svc.add(['example.com'], 'b.lst')).changed, false);
});
test('--file ограничивает удаление выбранным списком', async (t) => {
  const f = await fixture(t, { 'a.lst': 'example.com\n', 'b.lst': 'example.com\n' });
  await new DomainService(f.config, f.git).remove(['example.com'], 'a.lst');
  assert.equal(await readFile(path.join(f.root, 'b.lst'), 'utf8'), 'example.com\n');
});
test('не создаёт отсутствующий файл и не выходит из репозитория', async (t) => {
  const f = await fixture(t); const svc = new DomainService(f.config, f.git);
  for (const file of ['missing.lst', '../escape.lst', '.env', 'README.md']) await assert.rejects(svc.files(file), { code: 'FILE' });
});
test('сортировка явно включается и сохраняет позиции комментариев', async (t) => {
  const f = await fixture(t, { 'domains.lst': '# head\nz.com\n# middle\na.com\n' }); f.config.domains.sort = true;
  await new DomainService(f.config, f.git).add(['m.com']);
  assert.equal(await readFile(path.join(f.root, 'domains.lst'), 'utf8'), '# head\na.com\n# middle\nm.com\nz.com\n');
});
test('защита от перезаписи свежего изменения редактора', async (t) => {
  const f = await fixture(t); const svc = new DomainService(f.config, f.git), doc = await svc.read('domains.lst');
  await writeFile(path.join(f.root, 'domains.lst'), 'edited.com\n');
  await assert.rejects(svc.save(doc, 'new.com\n'), { code: 'CONCURRENT' });
});
test('парсер сохраняет смешанные окончания строк и комментарии', () => {
  const text = '# a\r\na.com\n\r\nb.com'; const doc = parseList(text);
  assert.equal(doc.lines.map((r) => r.raw + r.ending).join(''), text);
});
