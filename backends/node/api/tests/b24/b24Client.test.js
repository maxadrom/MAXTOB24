// Unit-тесты B24Client. Мокаем fetch и installationsService целиком —
// БД не нужна. Проверяем сборку URL/payload, обработку B24-ошибок,
// timeout, отсутствие токена в логах.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { B24Client, flattenParams } from '../../src/modules/b24/b24Client.js';
import { B24_CONNECTOR_DEFAULTS } from '../../src/modules/b24/b24Constants.js';
import { B24ApiError, NotFoundError, ValidationError } from '../../src/shared/http/domainErrors.js';
import { binaryResponse, hangingBodyResponse } from '../helpers/http.js';
import { MediaTooLargeError } from '../../src/shared/media/mediaTooLargeError.js';

const PORTAL = 'foo.bitrix24.ru';
const TOKEN = 'tok-test-12345';

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child() {
      return silentLogger();
    },
  };
}

function fakeInstallations({ portal = PORTAL, token = TOKEN, throwNotFound = false } = {}) {
  return {
    getCurrent: vi.fn(async () => {
      if (throwNotFound) {
        throw new NotFoundError('No installation found — call POST /api/install first');
      }
      return {
        id: 1,
        b24Portal: portal,
        b24AccessToken: token,
      };
    }),
  };
}

function jsonResponse(body, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function brokenJsonResponse({ status = 500 } = {}) {
  return {
    ok: false,
    status,
    async json() {
      throw new Error('Unexpected token');
    },
  };
}

describe('B24Client.callMethod', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) happy path: собирает URL, body, возвращает data.result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { ok: true }, time: { duration: 0.1 } }));

    const result = await client.callMethod('user.current', { foo: 'bar' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${PORTAL}/rest/user.current.json?auth=${encodeURIComponent(TOKEN)}`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('foo=bar');
    expect(result).toEqual({ ok: true });
  });

  it('2) NotFoundError из installationsService пробрасывается наружу (callMethod не маскирует)', async () => {
    const c = new B24Client({
      installationsService: fakeInstallations({ throwNotFound: true }),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
    });
    await expect(c.callMethod('user.current')).rejects.toThrow(NotFoundError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3) пустой b24AccessToken → B24ApiError NO_AUTH', async () => {
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: null,
      })),
    };
    const c = new B24Client({
      installationsService: installations,
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
    });
    await expect(c.callMethod('user.current')).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'NO_AUTH',
      code: 'B24_NO_AUTH',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) data.error=expired_token без clientId/clientSecret → B24ApiError expired_token без retry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'expired_token', error_description: 'The access token provided has expired.' }),
    );
    // client создан с config:{} — нет clientId/clientSecret → авто-refresh не запускается
    await expect(client.callMethod('user.current')).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'expired_token',
      code: 'B24_expired_token',
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4a) expired_token + clientId/clientSecret → refresh + retry → возвращает результат', async () => {
    const newToken = 'new-access-token-xyz';
    // Реалистичный ответ OAuth: domain — сервер авторизации, портал — в client_endpoint.
    const refreshResponse = jsonResponse({
      access_token: newToken,
      refresh_token: 'new-refresh-xyz',
      expires_in: 3600,
      domain: 'oauth.bitrix.info',
      client_endpoint: `https://${PORTAL}/rest/`,
      member_id: 'member-xyz',
    });
    const retryResponse = jsonResponse({ result: { ok: true }, time: {} });

    const saveRefreshedTokens = vi.fn(async () => ({ id: 1, b24Portal: PORTAL, b24AccessToken: newToken }));
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: TOKEN,
        b24RefreshToken: 'old-refresh-token',
      })),
      saveRefreshedTokens,
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'expired_token', error_description: 'expired' }))
      .mockResolvedValueOnce(refreshResponse)
      .mockResolvedValueOnce(retryResponse);

    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    const result = await c.callMethod('user.current', { foo: 'bar' });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // refresh запрос к oauth.bitrix.info
    expect(fetchMock.mock.calls[1][0]).toBe('https://oauth.bitrix.info/oauth/token/');
    // M19: новая пара пишется compare-and-swap по старому refresh_token + member_id.
    expect(saveRefreshedTokens).toHaveBeenCalledWith(1, {
      oldRefresh: 'old-refresh-token',
      access: newToken,
      refresh: 'new-refresh-xyz',
      memberId: 'member-xyz',
    });
  });

  it('4a2) ответ рефреша без refresh_token → сохраняем прежний refresh', async () => {
    const saveRefreshedTokens = vi.fn(async () => ({ id: 1 }));
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: TOKEN,
        b24RefreshToken: 'old-refresh-token',
      })),
      saveRefreshedTokens,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'expired_token', error_description: 'expired' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'only-access' }))
      .mockResolvedValueOnce(jsonResponse({ result: true, time: {} }));

    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    await c.callMethod('user.current');
    expect(saveRefreshedTokens).toHaveBeenCalledWith(1, {
      oldRefresh: 'old-refresh-token',
      access: 'only-access',
      refresh: 'old-refresh-token',
      memberId: null,
    });
  });

  it('4a3) refresh_token в БД пуст → обмен не вызывается, бросает expired_token', async () => {
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: TOKEN,
        b24RefreshToken: null,
      })),
      saveRefreshedTokens: vi.fn(),
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'expired_token', error_description: 'expired' }),
    );

    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    await expect(c.callMethod('user.current')).rejects.toMatchObject({ b24Code: 'expired_token' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(installations.saveRefreshedTokens).not.toHaveBeenCalled();
  });

  it('4b) expired_token + clientId/clientSecret, refresh упал → бросает expired_token', async () => {
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: TOKEN,
        b24RefreshToken: 'old-refresh-token',
      })),
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'expired_token', error_description: 'expired' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'INVALID_GRANT', error_description: 'Refresh token invalid' }, { status: 400, ok: false }));

    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    await expect(c.callMethod('user.current')).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'expired_token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4c) expired_token на retry (_isRetry=true) → бросает немедленно, без второго refresh', async () => {
    const installations = {
      getCurrent: vi.fn(async () => ({
        id: 1,
        b24Portal: PORTAL,
        b24AccessToken: TOKEN,
        b24RefreshToken: 'old-refresh-token',
      })),
    };

    // Оба вызова (первый и retry) возвращают expired_token
    fetchMock.mockResolvedValue(jsonResponse({ error: 'expired_token', error_description: 'expired' }));

    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    // Вызываем напрямую с _isRetry: true — не должен пытаться refresh
    await expect(c.callMethod('user.current', {}, { _isRetry: true })).rejects.toMatchObject({
      b24Code: 'expired_token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // M21: координатор передаёт installation, прочитанную при резолве привязки.
  it('4d) installation передана → токен из неё, getCurrent не вызван', async () => {
    const installations = fakeInstallations();
    const c = new B24Client({
      installationsService: installations,
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { ok: true }, time: {} }));

    const installation = { id: 1, b24Portal: PORTAL, b24AccessToken: 'tok-from-request' };
    await expect(c.callMethod('user.current', {}, { installation })).resolves.toEqual({ ok: true });

    expect(installations.getCurrent).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://${PORTAL}/rest/user.current.json?auth=tok-from-request`);
  });

  it('4e) installation передана, expired_token → refresh, ретрай берёт новый токен из БД', async () => {
    const newToken = 'new-access-from-db';
    const installations = {
      // _doRefresh читает старую пару, ретрай — уже записанную новую.
      getCurrent: vi.fn()
        .mockResolvedValueOnce({ id: 1, b24Portal: PORTAL, b24AccessToken: TOKEN, b24RefreshToken: 'old-refresh' })
        .mockResolvedValueOnce({ id: 1, b24Portal: PORTAL, b24AccessToken: newToken, b24RefreshToken: 'new-refresh' }),
      saveRefreshedTokens: vi.fn(async () => ({ id: 1 })),
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'expired_token', error_description: 'expired' }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: newToken,
        refresh_token: 'new-refresh',
        client_endpoint: `https://${PORTAL}/rest/`,
        member_id: 'member-xyz',
      }))
      .mockResolvedValueOnce(jsonResponse({ result: { ok: true }, time: {} }));
    const c = new B24Client({
      installationsService: installations,
      config: { clientId: 'client-id', clientSecret: 'client-secret' },
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });

    const installation = { id: 1, b24Portal: PORTAL, b24AccessToken: TOKEN };
    await expect(c.callMethod('user.current', {}, { installation })).resolves.toEqual({ ok: true });

    expect(installations.getCurrent).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://${PORTAL}/rest/user.current.json?auth=${newToken}`);
  });

  it('5) data.error=WRONG_AUTH_TYPE → B24ApiError WRONG_AUTH_TYPE', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'WRONG_AUTH_TYPE', error_description: 'Application context required' }),
    );
    await expect(client.callMethod('imconnector.list')).rejects.toMatchObject({
      b24Code: 'WRONG_AUTH_TYPE',
      code: 'B24_WRONG_AUTH_TYPE',
    });
  });

  it('6) HTTP 500 без JSON-тела → B24ApiError HTTP_ERROR, статус апстрима — в httpStatus', async () => {
    fetchMock.mockResolvedValueOnce(brokenJsonResponse({ status: 500 }));
    await expect(client.callMethod('user.current')).rejects.toMatchObject({
      b24Code: 'HTTP_ERROR',
      httpStatus: 500,
      status: 502,
    });
  });

  it('6a) HTML-ответ 403 (WAF/портал) → status 502, не 403: иначе вебхук ответит 4xx и ретраи отключатся', async () => {
    fetchMock.mockResolvedValueOnce(brokenJsonResponse({ status: 403 }));
    await expect(client.callMethod('imconnector.send.messages')).rejects.toMatchObject({
      b24Code: 'HTTP_ERROR',
      httpStatus: 403,
      status: 502,
    });
  });

  it('7) AbortError (timeout) → B24ApiError TIMEOUT', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(client.callMethod('user.current')).rejects.toMatchObject({
      b24Code: 'TIMEOUT',
    });
  });

  it('7a) M22: тело ответа зависло → TIMEOUT (дедлайн покрывает и чтение тела)', async () => {
    fetchMock.mockImplementationOnce(async (_url, { signal }) => hangingBodyResponse(signal));
    // Свой короткий дедлайн: тест ждёт его целиком.
    const fast = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 20,
    });
    await expect(fast.callMethod('user.current')).rejects.toMatchObject({
      b24Code: 'TIMEOUT',
    });
  });

  it('8) flattenParams сериализует bool/object/array/null корректно', () => {
    expect(flattenParams({ a: true })).toEqual([['a', '1']]);
    expect(flattenParams({ a: false })).toEqual([['a', '0']]);

    const nested = flattenParams({ a: { b: 1, c: 'x' } });
    expect(nested).toEqual([
      ['a[b]', '1'],
      ['a[c]', 'x'],
    ]);

    const arr = flattenParams({ arr: [1, 2] });
    expect(arr).toEqual([
      ['arr[0]', '1'],
      ['arr[1]', '2'],
    ]);

    const skipped = flattenParams({ a: null, b: 1, c: undefined });
    expect(skipped).toEqual([['b', '1']]);

    const urlEncoded = new URLSearchParams(flattenParams({ a: { b: 1 } })).toString();
    expect(urlEncoded).toBe('a%5Bb%5D=1');
  });

  it('9) imconnectorRegister собирает payload c полем ID (не CONNECTOR), CHAT_GROUP=1, NEED_SIGNATURE=1', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: true }));

    await client.imconnectorRegister({
      connectorId: 'max_b24',
      name: 'MAX (group chats)',
      icon: B24_CONNECTOR_DEFAULTS.ICON,
      placementHandlerUrl: 'https://example.test/b24/connector-settings',
    });

    const [, init] = fetchMock.mock.calls[0];
    const sp = new URLSearchParams(init.body);
    expect(sp.get('ID')).toBe('max_b24');
    expect(sp.get('CONNECTOR')).toBeNull();
    expect(sp.get('NAME')).toBe('MAX (group chats)');
    expect(sp.get('CHAT_GROUP')).toBe('1');
    expect(sp.get('NEED_SIGNATURE')).toBe('1');
    expect(sp.get('PLACEMENT_HANDLER')).toBe('https://example.test/b24/connector-settings');
    expect(sp.get('ICON[DATA_IMAGE]')).toBe(B24_CONNECTOR_DEFAULTS.ICON.DATA_IMAGE);
    expect(sp.get('ICON[COLOR]')).toBe('#E33D32');
  });

  it('10) imconnectorRegister без placementHandlerUrl → ValidationError, fetch не вызывается', async () => {
    await expect(
      client.imconnectorRegister({
        connectorId: 'max_b24',
        name: 'MAX',
        icon: B24_CONNECTOR_DEFAULTS.ICON,
        placementHandlerUrl: null,
      }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('11) imconnectorActivate: active=true → ACTIVE=1, active=false → ACTIVE=0', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: true }));

    await client.imconnectorActivate({ connectorId: 'max_b24', lineId: 42, active: true });
    let sp = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    expect(sp.get('ACTIVE')).toBe('1');

    await client.imconnectorActivate({ connectorId: 'max_b24', lineId: 42, active: false });
    sp = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    expect(sp.get('ACTIVE')).toBe('0');
  });

  it('12) imconnectorUnregister собирает payload с полем ID (грабля B24: НЕ CONNECTOR)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: true }));

    await client.imconnectorUnregister({ connectorId: 'max_b24' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imconnector.unregister.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('ID')).toBe('max_b24');
    expect(sp.get('CONNECTOR')).toBeNull();
  });

  it('13) imconnectorList парсит объект {connector_id: connector_name} как есть', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        result: { livechat: 'Онлайн-чат', max_b24: 'MAX (group chats)' },
      }),
    );

    const result = await client.imconnectorList();
    expect(result).toEqual({ livechat: 'Онлайн-чат', max_b24: 'MAX (group chats)' });
  });

  it('14) логи не содержат access token ни в одной записи', async () => {
    const records = [];
    function captureLogger() {
      return {
        info: (...args) => records.push(['info', ...args]),
        warn: (...args) => records.push(['warn', ...args]),
        error: (...args) => records.push(['error', ...args]),
        debug: (...args) => records.push(['debug', ...args]),
        trace: (...args) => records.push(['trace', ...args]),
        child: () => captureLogger(),
      };
    }
    const c = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: captureLogger(),
      fetchImpl: fetchMock,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: true }));
    await c.callMethod('user.current');
    const flat = JSON.stringify(records);
    expect(flat).not.toContain(TOKEN);
    expect(flat).not.toContain(`auth=${TOKEN}`);
  });
});

describe('B24Client.imconnectorSendMessages', () => {
  let fetchMock;
  let client;

  function validMessages() {
    return [
      {
        chat: { id: 'max:-70000000000954', name: 'Группа Север' },
        user: { id: 54321, name: 'Иван', lastName: 'Петров' },
        message: { id: 'max:mid:mid.ABC', text: 'привет', date: 1700000000 },
      },
    ];
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) ValidationError на пустой connectorId, fetch не вызван', async () => {
    await expect(
      client.imconnectorSendMessages({ connectorId: '', lineId: 42, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2) ValidationError на пустой lineId', async () => {
    await expect(
      client.imconnectorSendMessages({ connectorId: 'max_b24', lineId: null, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3) ValidationError на пустой/не-массив messages', async () => {
    await expect(
      client.imconnectorSendMessages({ connectorId: 'max_b24', lineId: 42, messages: [] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorSendMessages({ connectorId: 'max_b24', lineId: 42, messages: null }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) callMethod получает расплющенный набор (MESSAGES[0][chat][id], [user][last_name]); chat.type НЕ шлётся', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { DATA: { RESULT: [{ SUCCESS: true }] } }, time: {} }),
    );

    await client.imconnectorSendMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imconnector.send.messages.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    expect(sp.get('MESSAGES[0][chat][id]')).toBe('max:-70000000000954');
    // M24: chat.name не шлём даже если задан — imopenlines его не читает.
    expect(sp.get('MESSAGES[0][chat][name]')).toBeNull();
    expect(sp.get('MESSAGES[0][user][id]')).toBe('54321');
    expect(sp.get('MESSAGES[0][user][name]')).toBe('Иван');
    expect(sp.get('MESSAGES[0][user][last_name]')).toBe('Петров');
    expect(sp.get('MESSAGES[0][message][id]')).toBe('max:mid:mid.ABC');
    expect(sp.get('MESSAGES[0][message][text]')).toBe('привет');
    expect(sp.get('MESSAGES[0][message][date]')).toBe('1700000000');
    // type — отсутствует в Verified schema, не отправляем.
    expect(sp.get('MESSAGES[0][chat][type]')).toBeNull();
  });

  it('5) last_name пустой, если lastName не задан', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { DATA: { RESULT: [{ SUCCESS: true }] } } }),
    );
    await client.imconnectorSendMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: [
        {
          chat: { id: 'max:-1' },
          user: { id: 7, name: 'Аноним' },
          message: { id: 'm1', text: 'hi', date: 1700000000 },
        },
      ],
    });
    const sp = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sp.get('MESSAGES[0][user][last_name]')).toBe('');
    expect(sp.get('MESSAGES[0][chat][name]')).toBeNull();
  });

  it('6) result проброшен из мок-ответа (data.result)', async () => {
    const raw = { DATA: { RESULT: [{ SUCCESS: true, session: { ID: '15756', CHAT_ID: '21180' } }] } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: raw, time: {} }));

    const result = await client.imconnectorSendMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    expect(result).toEqual(raw);
    expect(result.DATA.RESULT[0].SUCCESS).toBe(true);
  });
});

describe('B24Client.imconnectorSendStatusDelivery (M5.3)', () => {
  let fetchMock;
  let client;

  function validStatuses() {
    return [
      {
        imChatId: '21186',
        imMessageId: '1459190',
        externalIds: ['mid.ext-007'],
        date: 1748432100,
        chatId: 'max:-70000000000954',
      },
    ];
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) ValidationError на пустой connectorId', async () => {
    await expect(
      client.imconnectorSendStatusDelivery({ connectorId: '', lineId: 42, statuses: validStatuses() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2) ValidationError на пустой lineId', async () => {
    await expect(
      client.imconnectorSendStatusDelivery({ connectorId: 'max_b24', lineId: null, statuses: validStatuses() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3) ValidationError на пустой/не-массив statuses', async () => {
    await expect(
      client.imconnectorSendStatusDelivery({ connectorId: 'max_b24', lineId: 42, statuses: [] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorSendStatusDelivery({ connectorId: 'max_b24', lineId: 42, statuses: null }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) wire-форма: CONNECTOR/LINE/MESSAGES[0][im][chat_id]/[message][id][0]/[chat][id]', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { SUCCESS: true, DATA: [], time: {} }, time: {} }),
    );

    await client.imconnectorSendStatusDelivery({
      connectorId: 'max_b24',
      lineId: 42,
      statuses: validStatuses(),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imconnector.send.status.delivery.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    expect(sp.get('MESSAGES[0][im][chat_id]')).toBe('21186');
    expect(sp.get('MESSAGES[0][im][message_id]')).toBe('1459190');
    // id — массив внешних id
    expect(sp.get('MESSAGES[0][message][id][0]')).toBe('mid.ext-007');
    expect(sp.get('MESSAGES[0][message][date]')).toBe('1748432100');
    expect(sp.get('MESSAGES[0][chat][id]')).toBe('max:-70000000000954');
  });

  it('5) result проброшен из мок-ответа', async () => {
    const raw = { SUCCESS: true, DATA: [], time: {} };
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: raw, time: {} }));

    const result = await client.imconnectorSendStatusDelivery({
      connectorId: 'max_b24',
      lineId: 42,
      statuses: validStatuses(),
    });

    expect(result).toEqual(raw);
    expect(result.SUCCESS).toBe(true);
  });
});

// ── M-lifecycle: imDialogGet (резолвинг CHAT_ID по USER_CODE) ─────────────────
describe('B24Client.imDialogGet', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) шлёт imopenlines.dialog.get с USER_CODE, возвращает result (объект чата с id)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { id: 21564, dialog_id: 'chat21564' }, time: {} }));

    const chat = await client.imDialogGet({ userCode: 'max_b24|42|max:-70000000000218|0' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imopenlines.dialog.get.json');
    expect(new URLSearchParams(init.body).get('USER_CODE')).toBe('max_b24|42|max:-70000000000218|0');
    expect(chat).toEqual({ id: 21564, dialog_id: 'chat21564' });
  });

  it('2) пустой userCode → ValidationError, fetch не вызывается', async () => {
    await expect(client.imDialogGet({ userCode: '' })).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3) M27: chatId → тело CHAT_ID (число), без USER_CODE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { id: 21564, name: 'Чат', entity_data_1: 'N|NONE|0|N|N|16338|1791370000|0|0|0' },
      time: {},
    }));

    const chat = await client.imDialogGet({ chatId: '21564' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imopenlines.dialog.get.json');
    const body = new URLSearchParams(init.body);
    expect(body.get('CHAT_ID')).toBe('21564');
    expect(body.has('USER_CODE')).toBe(false);
    expect(chat).toMatchObject({ id: 21564, entity_data_1: 'N|NONE|0|N|N|16338|1791370000|0|0|0' });
  });

  it.each([
    [{}],
    [undefined],
    [{ userCode: 'max_b24|42|max:-1|0', chatId: '21564' }],
    [{ chatId: 'abc' }],
    [{ chatId: '0' }],
    [{ chatId: '-5' }],
    [{ chatId: '1.5' }],
    [{ chatId: '' }],
  ])('4) M27: ни одного параметра, оба или нечисловой chatId (%j) → ValidationError, fetch не вызывается', async (args) => {
    await expect(client.imDialogGet(args)).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── M24: imconnector.chat.name.set (название чата OL) ─────────────────────────
describe('B24Client.imconnectorChatNameSet (M24)', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) шлёт CONNECTOR/LINE/CHAT_ID (внешний id)/NAME, возвращает result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { SUCCESS: true, DATA: { RESULT: {} } }, time: {} }));

    const raw = await client.imconnectorChatNameSet({
      connectorId: 'max_b24',
      lineId: 42,
      chatId: 'max:-70000000000218',
      name: 'Тестовая группа 🚀',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imconnector.chat.name.set.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    expect(sp.get('CHAT_ID')).toBe('max:-70000000000218');
    expect(sp.get('NAME')).toBe('Тестовая группа 🚀');
    expect(sp.get('USER_ID')).toBeNull();
    expect(raw).toEqual({ SUCCESS: true, DATA: { RESULT: {} } });
  });

  it('2) 400 CHAT_RENAMING_FAILED (сессия закрыта) → B24ApiError с этим кодом', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'CHAT_RENAMING_FAILED', error_description: 'Chat renaming failed' },
        { status: 400, ok: false },
      ),
    );
    await expect(
      client.imconnectorChatNameSet({ connectorId: 'max_b24', lineId: 42, chatId: 'max:-1', name: 'X' }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'CHAT_RENAMING_FAILED' });
  });

  it('3) пустое имя → ValidationError, fetch не вызывается', async () => {
    await expect(
      client.imconnectorChatNameSet({ connectorId: 'max_b24', lineId: 42, chatId: 'max:-1', name: '' }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Reply/цитирование: imDialogMessagesSearch (добор REPLY_ID) ────────────────
describe('B24Client.imDialogMessagesSearch', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) собирает params: CHAT_ID, ORDER[ID]=DESC, LIMIT; возвращает result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { messages: [{ id: 1 }], additionalMessages: [] }, time: {} }),
    );

    const result = await client.imDialogMessagesSearch({ chatId: '21564', limit: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/im.dialog.messages.search.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('CHAT_ID')).toBe('21564');
    expect(sp.get('ORDER[ID]')).toBe('DESC');
    expect(sp.get('LIMIT')).toBe('50');
    expect(sp.has('LAST_ID')).toBe(false);
    expect(result).toEqual({ messages: [{ id: 1 }], additionalMessages: [] });
  });

  it('2) LAST_ID добавляется только когда задан', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { messages: [] }, time: {} }));

    await client.imDialogMessagesSearch({ chatId: 21564, limit: 100, lastId: 999 });

    const sp = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sp.get('LAST_ID')).toBe('999');
    expect(sp.get('LIMIT')).toBe('100');
  });

  it('3) пустой chatId → ValidationError, fetch не зван', async () => {
    await expect(client.imDialogMessagesSearch({ chatId: '' })).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) нечисловой chatId → ValidationError', async () => {
    await expect(client.imDialogMessagesSearch({ chatId: 'abc' })).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5) проброс ошибки B24 (callMethod бросает B24ApiError)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'too many' }),
    );
    await expect(
      client.imDialogMessagesSearch({ chatId: 21564 }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'QUERY_LIMIT_EXCEEDED' });
  });

  // M28: reply-резолв исходящего передаёт снимок installation из резолва привязки.
  it('6) installation передана → токен из неё, БД не читается; параметры запроса прежние', async () => {
    const installations = fakeInstallations();
    const c = new B24Client({
      installationsService: installations,
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { messages: [] }, time: {} }));
    const installation = { id: 1, b24Portal: PORTAL, b24AccessToken: 'tok-from-route' };

    await c.imDialogMessagesSearch({ chatId: '21564', limit: 50, installation });

    expect(installations.getCurrent).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${PORTAL}/rest/im.dialog.messages.search.json?auth=tok-from-route`);
    const sp = new URLSearchParams(init.body);
    expect([...sp.keys()].sort()).toEqual(['CHAT_ID', 'LIMIT', 'ORDER[ID]']);
  });
});

// ── M11.2/M22: downloadFile (скачивание файла оператора потоком во временный файл) ──
describe('B24Client.downloadFile', () => {
  let client;
  let fetchMock;
  let dir;
  let dest;

  beforeEach(async () => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
    });
    dir = await mkdtemp(path.join(os.tmpdir(), 'm22-dl-test-'));
    dest = path.join(dir, 'file.part');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const LINK = 'https://example.bitrix24.ru/pub/im.file.php?FILE_ID=1&SIGN=abc';

  function redirectTo(location) {
    return new Response(null, { status: 302, headers: { location } });
  }

  // Тело из нескольких чанков без Content-Length (размер заранее неизвестен).
  function chunkedResponse(chunks) {
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } });
  }

  it('1) успех → тело записано в destPath, { size, contentType }, БЕЗ auth-заголовка', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse([1, 2, 3, 4], { contentType: 'application/pdf' }));

    const result = await client.downloadFile(LINK, { destPath: dest });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(LINK);
    expect(init.method).toBe('GET');
    // Анонимно: никакого Authorization/auth.
    expect(init.headers).toBeUndefined();
    expect(result).toEqual({ size: 4, contentType: 'application/pdf' });
    expect([...(await readFile(dest))]).toEqual([1, 2, 3, 4]);
  });

  it('2) не-2xx → B24ApiError DOWNLOAD_FAILED, status 502 (403 апстрима — только в httpStatus)', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse([], { status: 403 }));

    await expect(client.downloadFile(LINK, { destPath: dest })).rejects.toMatchObject({
      name: 'B24ApiError', b24Code: 'DOWNLOAD_FAILED', httpStatus: 403, status: 502,
    });
  });

  it('3) без downloadLink или destPath → ValidationError, fetch не зван', async () => {
    await expect(client.downloadFile('', { destPath: dest })).rejects.toThrow(ValidationError);
    await expect(client.downloadFile(LINK)).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) сетевая ошибка → B24ApiError DOWNLOAD_NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(client.downloadFile(LINK, { destPath: dest })).rejects.toMatchObject({
      name: 'B24ApiError', b24Code: 'DOWNLOAD_NETWORK_ERROR',
    });
  });

  // ── SSRF-guard ────────────────────────────────────────────────────────────
  it('5) не-https ссылка → DOWNLOAD_BLOCKED, fetch НЕ зван', async () => {
    await expect(
      client.downloadFile('http://example.bitrix24.ru/pub/x', { destPath: dest }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'DOWNLOAD_BLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('6) ссылка на metadata/приватный IP → DOWNLOAD_BLOCKED, fetch НЕ зван', async () => {
    await expect(
      client.downloadFile('https://169.254.169.254/latest/meta-data/', { destPath: dest }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'DOWNLOAD_BLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7) редирект на приватный IP блокируется на следующем хопе', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo('https://169.254.169.254/x'));

    await expect(client.downloadFile(LINK, { destPath: dest })).rejects.toMatchObject({
      name: 'B24ApiError', b24Code: 'DOWNLOAD_BLOCKED',
    });
    // fetch вызван ровно один раз — на второй (приватный) хоп уже не пошли.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // redirect:'manual' — fetch сам по редиректам не ходит.
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('7a) публичный редирект → следующий хоп скачивается', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://cdn.bitrix24.ru/f/1'))
      .mockResolvedValueOnce(binaryResponse([9, 9]));

    const result = await client.downloadFile(LINK, { destPath: dest });
    expect(result.size).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.bitrix24.ru/f/1');
  });

  // ── M22: лимит и дедлайн ──────────────────────────────────────────────────
  it('8) M22: Content-Length больше maxBytes → MediaTooLargeError, файл не пишется', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse(new Array(10).fill(1)));

    await expect(client.downloadFile(LINK, { destPath: dest, maxBytes: 5 })).rejects.toMatchObject({
      name: 'MediaTooLargeError', size: 10, limit: 5,
    });
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('9) M22: без Content-Length поток обрывает счётчик байт', async () => {
    fetchMock.mockResolvedValueOnce(chunkedResponse([[1, 2, 3], [4, 5, 6], [7, 8, 9]]));

    await expect(client.downloadFile(LINK, { destPath: dest, maxBytes: 5 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
  });

  it('9a) M22: ровно maxBytes — проходит', async () => {
    fetchMock.mockResolvedValueOnce(chunkedResponse([[1, 2], [3, 4, 5]]));
    await expect(client.downloadFile(LINK, { destPath: dest, maxBytes: 5 })).resolves.toMatchObject({ size: 5 });
  });

  it('10) M22: тело зависло → DOWNLOAD_TIMEOUT (дедлайн на всё тело)', async () => {
    fetchMock.mockImplementationOnce(async (_url, { signal }) => hangingBodyResponse(signal));

    await expect(client.downloadFile(LINK, { destPath: dest, timeoutMs: 50 })).rejects.toMatchObject({
      name: 'B24ApiError', b24Code: 'DOWNLOAD_TIMEOUT',
    });
  });
});

// M-lifecycle: системное сообщение в OL-чат.
describe('B24Client.imMessageAdd', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new B24Client({
      installationsService: fakeInstallations(),
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) собирает вызов im.message.add с DIALOG_ID/MESSAGE/SYSTEM=Y/URL_PREVIEW=N, возвращает result (msgId)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: 9876, time: {} }));

    const msgId = await client.imMessageAdd({ dialogId: 'chat21180', message: 'привет [b]Иван[/b]' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/im.message.add.json');
    const sp = new URLSearchParams(init.body);
    expect(sp.get('DIALOG_ID')).toBe('chat21180');
    expect(sp.get('MESSAGE')).toBe('привет [b]Иван[/b]');
    expect(sp.get('SYSTEM')).toBe('Y');
    expect(sp.get('URL_PREVIEW')).toBe('N');
    expect(msgId).toBe(9876);
  });

  it('2) system=false → SYSTEM=N', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: 1, time: {} }));

    await client.imMessageAdd({ dialogId: 'chat1', message: 'x', system: false });

    const sp = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sp.get('SYSTEM')).toBe('N');
  });

  it('3) пустой message → ValidationError, fetch не вызывается (не уходит в B24 MESSAGE_EMPTY)', async () => {
    await expect(
      client.imMessageAdd({ dialogId: 'chat1', message: '' }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) пустой dialogId → ValidationError, fetch не вызывается', async () => {
    await expect(
      client.imMessageAdd({ dialogId: '', message: 'x' }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // M28: оповещение исходящего пути передаёт снимок installation из резолва привязки.
  it('5) installation передана → токен из неё, БД не читается; параметры запроса прежние', async () => {
    const installations = fakeInstallations();
    const c = new B24Client({
      installationsService: installations,
      config: {},
      logger: silentLogger(),
      fetchImpl: fetchMock,
      timeoutMs: 500,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: 555, time: {} }));
    const installation = { id: 1, b24Portal: PORTAL, b24AccessToken: 'tok-from-route' };

    const msgId = await c.imMessageAdd({ dialogId: 'chat21564', message: '⚠️ x', installation });

    expect(msgId).toBe(555);
    expect(installations.getCurrent).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${PORTAL}/rest/im.message.add.json?auth=tok-from-route`);
    const sp = new URLSearchParams(init.body);
    expect([...sp.keys()].sort()).toEqual(['DIALOG_ID', 'MESSAGE', 'SYSTEM', 'URL_PREVIEW']);
    expect(sp.get('SYSTEM')).toBe('Y');
  });
});
