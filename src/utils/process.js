import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export function run(file, args, { cwd, env = process.env, timeoutMs = 60000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const timer = setTimeout(() => {
      failure = new AppError(`Истёк таймаут команды ${file}.`, 'TIMEOUT');
      child.kill();
    }, timeoutMs);
    const collect = (key) => (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = new AppError(`Слишком большой вывод команды ${file}.`, 'OUTPUT_LIMIT');
        child.kill();
        return;
      }
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError(`Не удалось запустить ${file}. Проверьте установку и PATH.`, 'EXEC'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}
