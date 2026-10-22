// Единый error-middleware. Контроллеры/сервисы только бросают (или next(err)).
// В JSON-ответ попадает только код, message и requestId — стек остаётся в логе.

import { DomainError } from './domainErrors.js';
import { errorBody } from './errorResponse.js';

export function buildErrorHandler({ exposeStack = false, exposeDetails = true, logger = null } = {}) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, _next) {
    const log = req.log ?? logger;
    const status =
      err instanceof DomainError
        ? err.status
        : Number.isInteger(err?.status)
          ? err.status
          : 500;

    const code =
      err instanceof DomainError
        ? err.code
        : err?.code && typeof err.code === 'string'
          ? err.code
          : 'INTERNAL_ERROR';

    const safeMessage =
      err instanceof DomainError
        ? err.message
        : status >= 500
          ? 'Internal Server Error'
          : (err?.message ?? 'Error');

    const logPayload = {
      requestId: req.id,
      status,
      code,
      err: {
        name: err?.name,
        message: err?.message,
        code: err?.code,
        stack: err?.stack,
      },
    };

    if (status >= 500) log?.error(logPayload, 'request failed');
    else log?.warn(logPayload, 'request failed (client error)');

    const body = errorBody(req, code, safeMessage);
    if (exposeStack && err?.stack) body.error.stack = err.stack;
    // Details (в т.ч. сырое body апстрима B24) раскрываем в ответе только когда
    // exposeDetails (вне прода). В проде details остаётся в логе выше, не в ответе.
    if (exposeDetails && err instanceof DomainError && err.details !== undefined) {
      body.error.details = err.details;
    }
    res.status(status).json(body);
  };
}
