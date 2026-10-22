// Unit-тесты обмена refresh_token (b24OAuth). fetch мокаем — сеть не нужна.

import { describe, expect, it, vi } from 'vitest';

import { B24_OAUTH_TOKEN_URL, exchangeRefreshToken } from '../../src/modules/b24/b24OAuth.js';

const CREDS = { clientId: 'local.app.1', clientSecret: 'secret-xyz', refreshToken: 'old-refresh' };

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Реалистичный ответ: domain — сервер OAuth, портал — в client_endpoint.
const OK_BODY = {
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  client_endpoint: 'https://example.bitrix24.ru/rest/',
  domain: 'oauth.bitrix.info',
  member_id: 'member-abc',
  server_endpoint: 'https://oauth.bitrix.info/rest/',
  status: 'L',
  expires_in: 3600,
  scope: 'imopenlines,imconnector,im',
};

describe('b24OAuth.exchangeRefreshToken', () => {
  it('успех: POST на константный URL с grant_type=refresh_token и client creds', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_BODY));
    const result = await exchangeRefreshToken({ ...CREDS, fetchImpl });

    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      memberId: 'member-abc',
      clientEndpoint: 'https://example.bitrix24.ru/rest/',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(B24_OAUTH_TOKEN_URL);
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body);
    expect(Object.fromEntries(params)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'local.app.1',
      client_secret: 'secret-xyz',
      refresh_token: 'old-refresh',
    });
  });

  it('2xx без refresh_token/member_id/client_endpoint → null в этих полях (решает вызывающий)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a' }));
    await expect(exchangeRefreshToken({ ...CREDS, fetchImpl })).resolves.toEqual({
      accessToken: 'a',
      refreshToken: null,
      memberId: null,
      clientEndpoint: null,
    });
  });

  it.each([
    ['invalid_grant 400', { error: 'invalid_grant', error_description: 'bad' }, 400, 'OAUTH_REJECTED'],
    ['expired_token 401', { error: 'expired_token' }, 401, 'OAUTH_REJECTED'],
    ['error при HTTP 200', { error: 'NO_AUTH_FOUND' }, 200, 'OAUTH_REJECTED'],
    ['4xx без error', {}, 403, 'OAUTH_REJECTED'],
    ['invalid_client', { error: 'invalid_client' }, 401, 'OAUTH_INVALID_CLIENT'],
    ['QUERY_LIMIT_EXCEEDED', { error: 'QUERY_LIMIT_EXCEEDED' }, 503, 'OAUTH_UNAVAILABLE'],
    ['429', {}, 429, 'OAUTH_UNAVAILABLE'],
    ['5xx с error', { error: 'internal' }, 502, 'OAUTH_UNAVAILABLE'],
    ['2xx без access_token', { refresh_token: 'r' }, 200, 'OAUTH_UNAVAILABLE'],
  ])('%s → %s', async (_label, body, status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, { status }));
    await expect(exchangeRefreshToken({ ...CREDS, fetchImpl })).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: code,
      httpStatus: status,
    });
  });

  it('отказ OAuth: в body — только error/error_description, без лишних полей ответа', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'bad', access_token: 'leak' }, { status: 400 }),
    );
    const err = await exchangeRefreshToken({ ...CREDS, fetchImpl }).catch((e) => e);
    expect(err.body).toEqual({ error: 'invalid_grant', error_description: 'bad' });
    expect(err.status).toBe(502);
  });

  it('сетевая ошибка → OAUTH_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(exchangeRefreshToken({ ...CREDS, fetchImpl })).rejects.toMatchObject({
      b24Code: 'OAUTH_UNAVAILABLE',
    });
  });

  it('ответ не JSON → OAUTH_UNAVAILABLE со статусом апстрима', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    await expect(exchangeRefreshToken({ ...CREDS, fetchImpl })).rejects.toMatchObject({
      b24Code: 'OAUTH_UNAVAILABLE',
      httpStatus: 502,
    });
  });

  it('таймаут: сигнал обрывает запрос → OAUTH_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(exchangeRefreshToken({ ...CREDS, fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      b24Code: 'OAUTH_UNAVAILABLE',
    });
  });

  it.each([
    ['refreshToken', { ...CREDS, refreshToken: null }, 'OAUTH_REJECTED'],
    ['clientId', { ...CREDS, clientId: '' }, 'OAUTH_INVALID_CLIENT'],
    ['clientSecret', { ...CREDS, clientSecret: undefined }, 'OAUTH_INVALID_CLIENT'],
  ])('нет %s → %s без сетевого вызова', async (_label, args, code) => {
    const fetchImpl = vi.fn();
    await expect(exchangeRefreshToken({ ...args, fetchImpl })).rejects.toMatchObject({
      b24Code: code,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
