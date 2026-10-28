const secrets = new Set();
export function registerSecret(value) {
  if (value) secrets.add(String(value));
}
export function redact(value) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[секрет скрыт]');
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[скрыто]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[скрыто]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export const logger = {
  info: (message) => console.log(redact(message)),
  warn: (message) => console.error(redact(`Внимание: ${message}`)),
  error: (message) => console.error(redact(`Ошибка: ${message}`))
};
