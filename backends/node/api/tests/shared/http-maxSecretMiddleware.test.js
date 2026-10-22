// Unit-тесты buildMaxSecretMiddleware. Проверяем все ветки (503/401/next),
// семантику кодов SECRET_MISSING/SECRET_INVALID/WEBHOOK_NOT_CONFIGURED,
// отсутствие значения секрета в логах и кастомное имя заголовка.
//
// Шаблон fakeReq/fakeRes — как в http-hmacMiddleware.test.js.

import { describe, expect, it, vi } from 'vitest';
import { buildMaxSecretMiddleware } from '../../src/shared/http/maxSecretMiddleware.js';

const SECRET = 'super-secret-MAX-1234567890_-';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function fakeReq({ headers = {}, id = 'req-id-1' } = {}) {
  return {
    id,
    headers,
    originalUrl: '/webhook/max',
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  };
}

describe('shared/http/maxSecretMiddleware', () => {
  it('1) secret пуст → 503 WEBHOOK_NOT_CONFIGURED, next не вызван, warn-лог', () => {
    const mw = buildMaxSecretMiddleware('', {});
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(res.body.error.requestId).toBe('req-id-1');
    expect(next).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalledOnce();
  });

  it('2) header X-Max-Bot-Api-Secret отсутствует → 401 SECRET_MISSING', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SECRET_MISSING');
    expect(next).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalledOnce();
  });

  it('3) header — пустая строка → 401 SECRET_MISSING', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq({ headers: { 'x-max-bot-api-secret': '' } });
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SECRET_MISSING');
    expect(next).not.toHaveBeenCalled();
  });

  it('4) header не string (массив) → 401 SECRET_MISSING (защита on-principle)', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq({ headers: { 'x-max-bot-api-secret': ['a', 'b'] } });
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SECRET_MISSING');
    expect(next).not.toHaveBeenCalled();
  });

  it('5) header другой длины → 401 SECRET_INVALID, timingSafeEqual не упал', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq({ headers: { 'x-max-bot-api-secret': 'short' } });
    const res = fakeRes();
    const next = vi.fn();

    expect(() => mw(req, res, next)).not.toThrow();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SECRET_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  it('6) header той же длины, но другое значение → 401 SECRET_INVALID (timing-safe)', () => {
    const wrong = 'x'.repeat(SECRET.length);
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq({ headers: { 'x-max-bot-api-secret': wrong } });
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('SECRET_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  it('7) header совпадает с secret → next() вызван, ответа из middleware нет', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    const req = fakeReq({ headers: { 'x-max-bot-api-secret': SECRET } });
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headersSent).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('8) кастомное options.headerName → middleware читает из этого имени', () => {
    const mw = buildMaxSecretMiddleware(SECRET, { headerName: 'X-Custom-Sec' });
    // Express нормализует имена заголовков в lowercase — middleware тоже:
    const req = fakeReq({ headers: { 'x-custom-sec': SECRET } });
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headersSent).toBe(false);

    // А с дефолтным именем — отказ.
    const req2 = fakeReq({ headers: { 'x-max-bot-api-secret': SECRET } });
    const res2 = fakeRes();
    const next2 = vi.fn();
    mw(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(401);
    expect(res2.body.error.code).toBe('SECRET_MISSING');
  });

  it('9) значение секрета не появляется ни в одном лог-вызове', () => {
    const mw = buildMaxSecretMiddleware(SECRET, {});
    // Прокатываем по всем веткам, накапливаем lo args.
    const scenarios = [
      { headers: {} },
      { headers: { 'x-max-bot-api-secret': '' } },
      { headers: { 'x-max-bot-api-secret': 'short' } },
      { headers: { 'x-max-bot-api-secret': 'x'.repeat(SECRET.length) } },
      { headers: { 'x-max-bot-api-secret': SECRET } },
    ];

    const allLogArgs = [];
    for (const scenario of scenarios) {
      const req = fakeReq(scenario);
      const res = fakeRes();
      const next = vi.fn();
      mw(req, res, next);
      allLogArgs.push(...req.log.warn.mock.calls.flat());
      allLogArgs.push(...req.log.info.mock.calls.flat());
      allLogArgs.push(...req.log.debug.mock.calls.flat());
    }

    const dump = JSON.stringify(allLogArgs);
    expect(dump).not.toContain(SECRET);
    // И ответы из middleware тоже не должны печатать секрет.
  });

  it('10) options.logger используется, если req.log отсутствует', () => {
    const fallbackLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const mw = buildMaxSecretMiddleware('', { logger: fallbackLogger });
    const req = { id: 'r1', headers: {}, originalUrl: '/webhook/max' };
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(fallbackLogger.warn).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});
