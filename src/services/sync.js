import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWrite, optionalRead } from '../utils/files.js';
import { withLock } from '../utils/lock.js';
import { AppError } from '../utils/errors.js';
import { redact } from '../utils/logger.js';
import { githubRawUrl } from './forkop.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');

export class SyncService {
  constructor(config, { domains, git, forkop, log = () => {} }) {
    Object.assign(this, { config, domains, git, forkop, log });
    this.stateFile = path.join(config.root, '.domains', 'last-sync.json');
  }
  async state() {
    try { return JSON.parse(await optionalRead(this.stateFile) || 'null'); }
    catch { return { success: false, message: 'Файл последней синхронизации повреждён.' }; }
  }
  async saveState(state) {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    await atomicWrite(this.stateFile, JSON.stringify(state, null, 2) + '\n');
  }
  async sync({ dryRun = false, file, locked = false } = {}) {
    if (!dryRun && !locked) return withLock(this.config.root, () => this.sync({ file, locked: true }));
    let phase = 'проверка', previous, published, sources, verificationBaseline;
    try {
      previous = await this.state();
      const check = await this.domains.check(file);
      if (!check.valid) throw new AppError('Списки содержат ошибки. Выполните domains check перед синхронизацией.', 'CHECK');
      const files = check.documents.map((d) => d.file);
      const plan = { ...await this.git.inspect(files), files, snapshots: Object.fromEntries(check.documents.map((d) => [d.file, d.text])) };
      sources = check.documents.map((doc) => {
        const values = doc.lines.filter((r) => r.type === 'domain' || r.type === 'ip').map((r) => r.value);
        const old = previous?.lastSuccess?.lists?.[doc.file]?.values || [];
        return { file: doc.file, text: doc.text, localHash: hash(doc.text), values, removed: old.filter((v) => !values.includes(v)),
          requireRevision: plan.changed.includes(doc.file) || previous?.pending?.includes(doc.file) ||
            (!!previous?.lastSuccess?.lists?.[doc.file] && previous.lastSuccess.lists[doc.file].hash !== hash(doc.text)),
          url: githubRawUrl(plan.url, plan.branch, doc.file) };
      });
      this.log(`${dryRun ? '[dry-run] ' : ''}Ветка ${plan.branch}, remote ${plan.remote}; списки: ${files.join(', ')}.`);
      if (dryRun) {
        this.log(`План: проверить GitHub; ${plan.changed.length ? `добавить и закоммитить только ${plan.changed.join(', ')}; ` : 'коммит не нужен; '}push текущей ветки; подтвердить HEAD и Raw; проверить версию Forkop; обновить списки и проверить активные правила.`);
        this.log('SSH, сеть, изменения файлов, commit и push не выполнялись. Доступность внешних систем не проверялась.');
        return { dryRun: true, plan };
      }
      phase = 'GitHub';
      published = await this.git.publish(plan);
      // Git filters/core.autocrlf могут менять окончания строк в опубликованном blob.
      // Raw сравнивается с blob, локальный формат остаётся прежним.
      for (const source of sources) if (published.contents?.[source.file] !== undefined) source.text = published.contents[source.file];
      verificationBaseline = previous?.oid === published.oid ? previous.verificationBaseline : undefined;
      for (const source of sources) if (published.modifiedFiles.includes(source.file)) source.requireRevision = true;
      this.log(`Публикация GitHub подтверждена: ${published.oid.slice(0, 12)}.`);
      // Сохраняем намерение до SSH, чтобы прерванное применение можно было повторить.
      await this.saveState({ success: false, phase: 'роутер', at: new Date().toISOString(), oid: published.oid,
        pending: sources.filter((s) => s.requireRevision).map((s) => s.file), lastSuccess: previous?.lastSuccess, verificationBaseline,
        message: 'Публикация завершена; применение на роутере ещё не подтверждено.' });
      phase = 'роутер';
      const applied = await this.forkop.update(sources, { baseline: verificationBaseline, checkpoint: async (baseline) => {
        verificationBaseline = baseline;
        await this.saveState({ success: false, phase, at: new Date().toISOString(), oid: published.oid,
          pending: sources.filter((s) => s.requireRevision).map((s) => s.file), lastSuccess: previous?.lastSuccess,
          verificationBaseline, message: 'Ожидание подтверждения активных правил.' });
      } });
      if (!applied.verified) throw new AppError('Применение правил не подтверждено.', 'VERIFY');
      const lastSuccess = { at: new Date().toISOString(), oid: published.oid, lists: Object.fromEntries(sources.map((s) => [s.file, { hash: s.localHash, values: s.values }])) };
      await this.saveState({ success: true, phase: 'завершено', at: lastSuccess.at, oid: published.oid, applied, lastSuccess, message: 'Синхронизация завершена; применение списков подтверждено.' });
      this.log('Синхронизация завершена: GitHub опубликован, списки обновлены, активные правила подтверждены.');
      return { success: true, published, applied };
    } catch (error) {
      if (!dryRun) {
        await this.saveState({ success: false, phase, at: new Date().toISOString(), oid: published?.oid,
          pending: sources?.filter((s) => s.requireRevision).map((s) => s.file) || previous?.pending,
          lastSuccess: previous?.lastSuccess, verificationBaseline, message: redact(error.message) }).catch(() => {});
      }
      throw error;
    }
  }
}
