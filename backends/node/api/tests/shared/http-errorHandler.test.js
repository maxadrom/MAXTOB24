// Security M13: errorHandler не раскрывает err.details (сырое body апстрима B24)
// в HTTP-ответе, когда exposeDetails=false (прод). В логе details остаётся.

import { describe, expect, it, vi } from 'vitest';

import { buildErrorHandler } from '../../src/shared/http/errorHandler.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeError() {
  // B24ApiError кладёт сырое body апстрима в details.body.
  return new B24ApiError('QUERY_LIMIT_EXCEEDED', 'rate', {
    method: 'imconnector.send.messages',
    status: 502,
    body: { error: 'QUERY_LIMIT_EXCEEDED', secret_internal: 'leak-me' },
  });
}

describe('buildErrorHandler exposeDetails gate', () => {
  it('exposeDetails=false (прод) → ответ БЕЗ details, лог содержит', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const handler = buildErrorHandler({ exposeDetails: false, logger: log });
    const req = { id: 'r1', log };
    const res = mockRes();

    handler(makeError(), req, res, () => {});

    expect(res.statusCode).toBe(502);
    expect(res.body.error.details).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('leak-me');
  });

  it('exposeDetails=true (вне прода) → ответ С details', () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const handler = buildErrorHandler({ exposeDetails: true, logger: log });
    const req = { id: 'r2', log };
    const res = mockRes();

    handler(makeError(), req, res, () => {});

    expect(res.body.error.details).toBeDefined();
    expect(res.body.error.details.b24Code).toBe('QUERY_LIMIT_EXCEEDED');
  });

  it('по умолчанию exposeDetails=true (обратная совместимость)', () => {
    const handler = buildErrorHandler({ logger: { warn: vi.fn(), error: vi.fn() } });
    const res = mockRes();
    handler(makeError(), { id: 'r3' }, res, () => {});
    expect(res.body.error.details).toBeDefined();
  });
});
