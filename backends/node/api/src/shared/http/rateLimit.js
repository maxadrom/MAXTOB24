// Security M13 / M20: rate-limit публичных роутов через express-rate-limit.
// Три лимитера, у каждого свой MemoryStore:
//   installLimiter    — строгий ОБЩИЙ потолок (один бакет на всех): каждый install с
//                       верным доменом и форматом идёт обменом refresh_token на
//                       oauth.bitrix.info с нашим client_id; per-IP открыл бы поток
//                       invalid_grant с многих адресов.
//   maxWebhookLimiter — щадящий per-IP для /webhook/max;
//   b24WebhookLimiter — щадящий per-IP для /webhook/b24. Раздельные бакеты: мусор на
//                       один вебхук не выбивает другой.
// Per-IP ключ — req.ip, его точность зависит от `trust proxy` (TRUST_PROXY, см. app.js).
// Значение секрета/тела НЕ логируем; на превышение — WARN [FIX][ratelimit].

import rateLimit from 'express-rate-limit';

import { sendError } from './errorResponse.js';

function buildLimiter({ windowMs, max, name, logger, keyGenerator }) {
  return rateLimit({
    // Фолбэк на щедрые значения, если конфиг не передан (прод всегда передаёт явный
    // config.rateLimit; фолбэк нужен только тест-конфигам без секции rateLimit).
    windowMs: windowMs ?? 60_000,
    max: max ?? 10_000,
    // undefined → ключ по умолчанию (req.ip).
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const log = req.log ?? logger;
      log?.warn(
        { ip: req.ip, remoteAddress: req.socket?.remoteAddress, route: req.originalUrl, limiter: name },
        `[FIX][ratelimit] throttled ip=${req.ip} route=${req.originalUrl}`,
      );
      sendError(req, res, 429, 'RATE_LIMITED', 'too many requests');
    },
  });
}

/**
 * Собирает лимитеры из resolved-конфига (config.rateLimit).
 * RATE_LIMIT_WEBHOOK_* действуют на один бакет: один IP одного вебхука.
 * @param {{ installWindowMs:number, installMax:number, webhookWindowMs:number, webhookMax:number }} cfg
 * @returns {{ installLimiter: Function, maxWebhookLimiter: Function, b24WebhookLimiter: Function }}
 */
export function buildRateLimiters(cfg = {}, { logger } = {}) {
  const installLimiter = buildLimiter({
    windowMs: cfg.installWindowMs,
    max: cfg.installMax,
    name: 'install',
    logger,
    keyGenerator: () => 'install',
  });
  const webhook = (name) =>
    buildLimiter({ windowMs: cfg.webhookWindowMs, max: cfg.webhookMax, name, logger });
  return {
    installLimiter,
    maxWebhookLimiter: webhook('webhook-max'),
    b24WebhookLimiter: webhook('webhook-b24'),
  };
}
