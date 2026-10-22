// Доменные ошибки для модулей. Используются вместо ad-hoc res.status(...) в контроллерах:
// бросаем DomainError из сервиса, errorHandler сериализует в JSON.

export class DomainError extends Error {
  constructor({ code, message, status = 400, cause, details } = {}) {
    super(message ?? code ?? 'Domain error');
    this.name = 'DomainError';
    this.code = code ?? 'DOMAIN_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export class ValidationError extends DomainError {
  constructor(message, details) {
    super({ code: 'VALIDATION_ERROR', message, status: 400, details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Not found', details) {
    super({ code: 'NOT_FOUND', message, status: 404, details });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message = 'Conflict', details) {
    super({ code: 'CONFLICT', message, status: 409, details });
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized', details) {
    super({ code: 'UNAUTHORIZED', message, status: 401, details });
    this.name = 'UnauthorizedError';
  }
}

// «Окружение/инсталляция не настроены — выполнение операции невозможно».
// Сценарии: installation без connectorId/olLineId, протухший токен,
// отсутствие обязательного env-значения на момент исполнения use-case.
// Отдельный класс (а не ValidationError), чтобы у нас был стабильный
// «опознавательный знак» для alerting'а и условного retry.
export class ConfigError extends DomainError {
  constructor(message = 'Configuration error', details) {
    super({ code: 'CONFIG_ERROR', message, status: 503, details });
    this.name = 'ConfigError';
  }
}

// Ошибка вызова Б24 REST. Унифицирует сетевые/HTTP/доменные сбои b24Client.
// b24Code сохраняем без префикса B24_ (это значение `error` из JSON-тела Б24),
// а внешний DomainError.code приходит с префиксом — единая точка идентификации.
// Статус ответа нашего вебхука — всегда 502. HTTP-статус апстрима — только в
// `httpStatus` (как MaxApiError): errorHandler отдаёт err.status ответом, и 4xx
// портала превратился бы в 4xx для MAX/Б24 — те перестали бы ретраить.
export class B24ApiError extends DomainError {
  constructor(code, description, { method, httpStatus, body } = {}) {
    super({
      code: `B24_${code}`,
      message: `B24 ${method ?? '<unknown>'} failed: ${code} — ${description ?? ''}`.trim(),
      status: 502,
      details: {
        method: method ?? null,
        b24Code: code,
        b24Description: description ?? null,
        httpStatus: httpStatus ?? null,
        body: body ?? null,
      },
    });
    this.name = 'B24ApiError';
    this.b24Code = code;
    this.b24Description = description ?? null;
    this.method = method ?? null;
    this.httpStatus = httpStatus ?? null;
    this.body = body ?? null;
  }
}
