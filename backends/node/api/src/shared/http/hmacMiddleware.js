// Фабрика middleware для HMAC-проверки webhook-подписи.
// Поведение:
//   1. secret пуст            -> 503 webhook not configured + warn-лог
//   2. signature header missing -> 401 missing signature + warn
//   3. signature invalid       -> 401 invalid signature + warn (без печати тела)
//   4. signature valid         -> next()
//
// Требует req.rawBody (от express.json({ verify: verifyRawBody })).

import { verifyHmacSha256 } from '../crypto/hmac.js';
import { sendError } from './errorResponse.js';

const DEFAULT_HEADER = 'x-content-hmac';

export function buildHmacMiddleware(secret, options = {}) {
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();

  return function hmacMiddleware(req, res, next) {
    const log = req.log ?? options.logger ?? null;

    if (!secret) {
      log?.warn(
        { requestId: req.id, route: req.originalUrl },
        'HMAC secret not configured — refusing webhook',
      );
      sendError(req, res, 503, 'WEBHOOK_NOT_CONFIGURED', 'webhook not configured');
      return;
    }

    const headerValue = req.headers?.[headerName];
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      log?.warn(
        { requestId: req.id, header: headerName },
        'HMAC header missing',
      );
      sendError(req, res, 401, 'HMAC_MISSING', 'missing signature');
      return;
    }

    const body = req.rawBody;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      log?.warn({ requestId: req.id }, 'HMAC verification skipped — req.rawBody empty');
      sendError(req, res, 400, 'EMPTY_BODY', 'empty body');
      return;
    }

    const ok = verifyHmacSha256(secret, body, headerValue);
    if (!ok) {
      log?.warn({ requestId: req.id }, 'HMAC verification failed');
      sendError(req, res, 401, 'HMAC_INVALID', 'invalid signature');
      return;
    }

    next();
  };
}
