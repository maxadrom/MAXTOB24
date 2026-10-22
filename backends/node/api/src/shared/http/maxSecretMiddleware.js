// MAX Bot API доставляет webhook-секрет в заголовке X-Max-Bot-Api-Secret
// (plain string, без HMAC от тела и без timestamp). Сравниваем через
// crypto.timingSafeEqual. Подтверждено официальным OpenAPI MAX (schema.yaml:2842,
// SubscriptionRequestBody.secret) и SDK Go/Java/Python/PHP.
//
// Поведение:
//   1. secret пуст в config             -> 503 WEBHOOK_NOT_CONFIGURED + warn
//   2. header X-Max-Bot-Api-Secret пуст -> 401 SECRET_MISSING + warn
//   3. header другой длины              -> 401 SECRET_INVALID + warn (без timingSafeEqual)
//   4. header той же длины, не совпал   -> 401 SECRET_INVALID + warn
//   5. header совпал                    -> next()
//
// Значение секрета НИКОГДА не пишется в лог.

import crypto from 'node:crypto';

import { sendError } from './errorResponse.js';

const DEFAULT_HEADER = 'x-max-bot-api-secret';

export function buildMaxSecretMiddleware(secret, options = {}) {
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();

  return function maxSecretMiddleware(req, res, next) {
    const log = req.log ?? options.logger ?? null;

    if (!secret) {
      log?.warn(
        { requestId: req.id, route: req.originalUrl },
        'MAX webhook secret not configured — refusing webhook',
      );
      sendError(req, res, 503, 'WEBHOOK_NOT_CONFIGURED', 'webhook not configured');
      return;
    }

    const headerValue = req.headers?.[headerName];
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      log?.warn({ requestId: req.id, header: headerName }, 'MAX secret header missing');
      sendError(req, res, 401, 'SECRET_MISSING', 'missing secret header');
      return;
    }

    const expectedBuf = Buffer.from(secret, 'utf8');
    const gotBuf = Buffer.from(headerValue, 'utf8');
    if (expectedBuf.length !== gotBuf.length) {
      log?.warn({ requestId: req.id }, 'MAX secret length mismatch');
      sendError(req, res, 401, 'SECRET_INVALID', 'invalid secret');
      return;
    }

    const ok = crypto.timingSafeEqual(expectedBuf, gotBuf);
    if (!ok) {
      log?.warn({ requestId: req.id }, 'MAX secret value mismatch');
      sendError(req, res, 401, 'SECRET_INVALID', 'invalid secret');
      return;
    }

    next();
  };
}
