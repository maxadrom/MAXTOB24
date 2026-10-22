// Middleware pino-http: автоматически вешает req.id (request-id), req.log (child),
// логирует завершение запроса с подходящим уровнем (5xx=error, 4xx=warn, иначе info).

import crypto from 'node:crypto';
import pinoHttp from 'pino-http';

function generateRequestId(req) {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) {
    return incoming;
  }
  return crypto.randomUUID();
}

function customLogLevel(_req, res, err) {
  if (err) return 'error';
  if (res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

// Scoped-логгер маршрута с requestId: child от req.log (pino-http). Без req.log.child
// (fakeReq в тестах) — req.log или fallback как есть, без child.
export function routeLogger(req, fallback, module) {
  return req.log?.child ? req.log.child({ module }) : (req.log ?? fallback);
}

export function buildHttpLogger(rootLogger) {
  return pinoHttp({
    logger: rootLogger,
    genReqId: generateRequestId,
    customLogLevel,
    serializers: {
      req(req) {
        // M20: ip — клиент с учётом trust proxy (express-геттер на исходном запросе
        // req.raw), remoteAddress — адрес сокета (за docker-proxy — шлюз bridge).
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          ip: req.raw?.ip ?? null,
          remoteAddress: req.remoteAddress ?? null,
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
      err: pinoErrSerializer,
    },
    // Сообщения уровня pino-http (мы хотим лаконичные)
    customSuccessMessage(req, res) {
      return `${req.method} ${req.url} → ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      return `${req.method} ${req.url} → ${res.statusCode} (${err?.message ?? 'error'})`;
    },
  });
}

function pinoErrSerializer(err) {
  if (!err) return err;
  return {
    type: err.name,
    message: err.message,
    code: err.code,
    status: err.status ?? err.statusCode,
    stack: err.stack,
  };
}
