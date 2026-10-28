import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomain, isSubnet } from '../utils/validation.js';
import { atomicWrite, listPath } from '../utils/files.js';
import { AppError } from '../utils/errors.js';

export function parseList(text, file = '') {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const content = text.slice(bom.length);
  const lines = [...content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .filter((m) => m[0] !== '').map((m, index) => {
      const raw = m[1], value = raw.trim();
      const row = { raw, ending: m[2], line: index + 1, file };
      if (!value) return { ...row, type: 'blank' };
      if (value.startsWith('#')) return { ...row, type: 'comment' };
      if (isSubnet(value)) return { ...row, type: 'ip', value: value.toLowerCase() };
      try { return { ...row, type: 'domain', value: normalizeDomain(value) }; }
      catch { return { ...row, type: 'invalid' }; }
    });
  return { file, text, bom, lines, newline: lines.find((r) => r.ending)?.ending || '\n', trailing: /[\r\n]$/.test(content) };
}

export class DomainService {
  constructor(config, git) { this.config = config; this.git = git; }
  async files(selected) {
    const configured = this.config.domains;
    const files = selected ? [selected] : configured.files || (configured.file !== 'auto' ? [configured.file] : await this.git.listFiles());
    const unique = [...new Set(await Promise.all(files.map((f) => listPath(this.config.root, f))))];
    if (!unique.length) throw new AppError('Файлы .lst не найдены. Укажите существующий список через --file.', 'FILE');
    return unique;
  }
  async read(file) {
    const bytes = await readFile(path.join(this.config.root, file));
    try { return parseList(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), file); }
    catch { throw new AppError(`Список ${file} должен иметь кодировку UTF-8.`, 'FORMAT'); }
  }
  async documents(selected) { return Promise.all((await this.files(selected)).map((f) => this.read(f))); }
  async entries(selected) { return (await this.documents(selected)).flatMap((doc) => doc.lines.filter((r) => r.type === 'domain')); }
  async search(query, selected) { return (await this.entries(selected)).filter((r) => r.value.includes(query.toLowerCase())); }
  async check(selected) {
    const documents = await this.documents(selected), issues = [], seen = new Map();
    for (const doc of documents) {
      if (doc.bom) issues.push({ file: doc.file, line: 1, level: 'error', message: 'BOM не допускается в переносимом plain-text списке Forkop.' });
      for (const row of doc.lines) {
        const base = { file: doc.file, line: row.line };
        if (row.type === 'invalid') issues.push({ ...base, level: 'error', message: 'Некорректная строка: ожидается домен, IP/CIDR или комментарий #.' });
        if (row.type === 'blank') issues.push({ ...base, level: 'info', message: 'Пустая строка: пропускается.' });
        if (row.type === 'domain' || row.type === 'ip') {
          const key = `${row.type}:${row.value}`;
          if (seen.has(key)) issues.push({ ...base, level: 'error', message: `Дубликат ${row.value}; первая запись ${seen.get(key)}.` });
          else seen.set(key, `${doc.file}:${row.line}`);
          if (row.type === 'domain' && row.raw !== row.value) issues.push({ ...base, level: 'warning', message: 'Рекомендуется ASCII-домен в нижнем регистре без пробелов и завершающей точки.' });
        }
      }
    }
    return { documents, issues, valid: !issues.some((r) => r.level === 'error') };
  }
  async target(selected) {
    if (selected || this.config.domains.file !== 'auto') return (await this.files(selected))[0];
    const docs = await this.documents();
    const candidates = docs.filter((doc) => doc.lines.some((r) => r.type === 'domain') || !doc.lines.some((r) => ['ip', 'invalid'].includes(r.type)));
    if (candidates.length !== 1) throw new AppError('Нельзя однозначно выбрать доменный список. Укажите --file путь.lst.', 'FILE');
    return candidates[0].file;
  }
  async save(doc, text) {
    if (text === doc.text) return false;
    // Не перезаписываем изменения редактора, появившиеся после чтения.
    if ((await readFile(path.join(this.config.root, doc.file), 'utf8')) !== doc.text) throw new AppError('Список изменён другим процессом. Повторите команду.', 'CONCURRENT');
    const mode = (await stat(path.join(this.config.root, doc.file))).mode & 0o777;
    await atomicWrite(path.join(this.config.root, doc.file), text, mode);
    return true;
  }
  async add(values, selected) {
    const normalized = [...new Set(values.map(normalizeDomain))];
    const file = await this.target(selected), doc = await this.read(file);
    const known = new Set((await this.entries()).map((r) => r.value));
    // --file может указывать на ещё не отслеживаемый список вне domains.files.
    doc.lines.filter((r) => r.type === 'domain').forEach((r) => known.add(r.value));
    const added = normalized.filter((d) => !known.has(d)), duplicates = normalized.filter((d) => known.has(d));
    if (!added.length) return { changed: false, file, added, duplicates };
    const prefix = doc.text && !doc.trailing ? doc.newline : '';
    let text = doc.text + prefix + added.join(doc.newline) + (doc.trailing || !doc.text ? doc.newline : '');
    if (this.config.domains.sort) {
      const sorted = parseList(text, file), domains = sorted.lines.filter((r) => r.type === 'domain').map((r) => r.value).sort();
      text = sorted.bom + sorted.lines.map((r) => (r.type === 'domain' ? domains.shift() : r.raw) + r.ending).join('');
    }
    return { changed: await this.save(doc, text), file, added, duplicates };
  }
  async remove(values, selected) {
    const wanted = new Set(values.map(normalizeDomain)), docs = await this.documents(selected), removed = [];
    // Сначала читаем и проверяем все входные данные, затем сохраняем каждый файл атомарно.
    for (const doc of docs) {
      const kept = doc.lines.filter((r) => {
        if (r.type !== 'domain' || !wanted.has(r.value)) return true;
        removed.push({ file: doc.file, value: r.value });
        return false;
      });
      if (!doc.trailing && kept.length) kept.at(-1).ending = '';
      await this.save(doc, doc.bom + kept.map((r) => r.raw + r.ending).join(''));
    }
    return { changed: removed.length > 0, removed, missing: [...wanted].filter((v) => !removed.some((r) => r.value === v)) };
  }
}
