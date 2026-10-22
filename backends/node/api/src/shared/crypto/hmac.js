// HMAC-SHA256 утилиты для верификации webhook-подписей. Работают с Buffer
// или string raw body; в реальном коде /webhook/max получает req.rawBody от
// express.json({ verify }) (см. shared/http/rawBody.js).

import crypto from 'node:crypto';

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  throw new TypeError('HMAC payload must be Buffer or string');
}

export function signHmacSha256(secret, payload) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('HMAC secret must be a non-empty string');
  }
  const buf = toBuffer(payload);
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

export function verifyHmacSha256(secret, payload, providedSignature) {
  if (typeof providedSignature !== 'string' || providedSignature.length === 0) {
    return false;
  }
  let expected;
  try {
    expected = signHmacSha256(secret, payload);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(providedSignature.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
