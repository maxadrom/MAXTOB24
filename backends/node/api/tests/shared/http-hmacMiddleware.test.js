import { describe, expect, it, vi } from 'vitest';
import { buildHmacMiddleware } from '../../src/shared/http/hmacMiddleware.js';
import { signHmacSha256 } from '../../src/shared/crypto/hmac.js';

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

function fakeReq({ headers = {}, body = '{}' } = {}) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    id: 'req-id-1',
    headers,
    rawBody,
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  };
}

describe('shared/http/hmacMiddleware', () => {
  it('returns 503 when secret is empty', () => {
    const mw = buildHmacMiddleware('', {});
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(next).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalled();
  });

  it('returns 401 when signature header is missing', () => {
    const mw = buildHmacMiddleware('secret', {});
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('HMAC_MISSING');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when signature is invalid', () => {
    const mw = buildHmacMiddleware('secret', {});
    const req = fakeReq({ headers: { 'x-content-hmac': 'deadbeef' } });
    const res = fakeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('HMAC_INVALID');
    expect(next).not.toHaveBeenCalled();
    // Тело не печатается в логе: проверим, что в args не появляется JSON-payload.
    const logArgs = req.log.warn.mock.calls.flat();
    expect(JSON.stringify(logArgs)).not.toContain('{}');
  });

  it('calls next() when signature is valid', () => {
    const body = '{"a":1}';
    const sig = signHmacSha256('secret', body);
    const mw = buildHmacMiddleware('secret', {});
    const req = fakeReq({ headers: { 'x-content-hmac': sig }, body });
    const res = fakeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.headersSent).toBe(false);
  });
});
