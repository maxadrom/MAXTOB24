// Constant-time сравнение строковых секретов (application_token Б24 и т.п.).
// Разная длина → false без crypto.timingSafeEqual (тот бросает на буферах разной
// длины). Пустые строки и не-строки → false: «нет секрета» никогда не совпадает.

import crypto from 'node:crypto';

export function timingSafeStrEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
