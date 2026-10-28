import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

export function normalizeDomain(value) {
  if (typeof value !== 'string' || !value || /[\s/:@*\\?#%\x00-\x1f]/u.test(value)) {
    throw new AppError('Неверный домен: требуется имя без URL, порта, пробелов и маски.', 'DOMAIN');
  }
  const domain = domainToASCII(value.replace(/\.$/, '').toLowerCase());
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || isIP(domain) || labels.length < 2 ||
      labels.some((x) => x.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)) ||
      !/[a-z]/.test(labels.at(-1))) {
    throw new AppError('Неверный формат домена.', 'DOMAIN');
  }
  return domain;
}

export function isSubnet(value) {
  const parts = value.split('/');
  const version = isIP(parts[0]);
  return !!version && (parts.length === 1 || (parts.length === 2 && /^\d+$/.test(parts[1]) &&
    Number(parts[1]) <= (version === 4 ? 32 : 128)));
}
