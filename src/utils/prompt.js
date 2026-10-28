import { createInterface } from 'node:readline/promises';
import { AppError } from './errors.js';

export async function question(text) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(text)).trim(); }
  finally { rl.close(); }
}

export async function passwordPrompt(text = 'Пароль SSH (ввод скрыт): ', input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new AppError('Нет интерактивного терминала. Задайте секрет в локальном .env или используйте SSH-ключ/агент.', 'SECRET');
  output.write(text);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (data) => {
      for (const char of data) {
        if (char === '\u0003' || char === '\u0004') return finish(new AppError('Ввод секрета отменён.', 'CANCELLED'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}
