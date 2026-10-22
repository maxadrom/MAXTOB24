// Unit-тесты B24Client.imconnectorUpdateMessages (правка ранее доставленного
// сообщения OL по внешнему id). Мокаем fetch и installationsService целиком —
// БД не нужна. Контракт зеркалит imconnectorSendMessages (тот же toB24MessageShape):
// проверяем сборку method/URL/payload (CONNECTOR/LINE/MESSAGES[]) и валидацию входа.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { B24Client } from '../../src/modules/b24/b24Client.js';
import { ValidationError } from '../../src/shared/http/domainErrors.js';

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

function fakeInstallations({ portal = PORTAL, token = TOKEN } = {}) {
  return {
    getCurrent: vi.fn(async () => ({
      id: 1,
      b24Portal: portal,
      b24AccessToken: token,
    })),
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

describe('B24Client.imconnectorUpdateMessages', () => {
  let fetchMock;
  let client;

  function validMessages() {
    return [
      {
        chat: { id: 'max:-70000000000954', name: 'Группа Север' },
        user: { id: 54321, name: 'Иван', lastName: 'Петров' },
        message: { id: 'max:mid:mid.ABC', text: 'привет (исправлено)', date: 1700000000 },
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

  // ── happy path ──────────────────────────────────────────────────────────────
  it('1) вызывает imconnector.update.messages с CONNECTOR/LINE; MESSAGES сериализуются через toB24MessageShape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { DATA: { RESULT: [{ SUCCESS: true }] } }, time: {} }),
    );

    await client.imconnectorUpdateMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // метод в URL — именно update.messages, а не send.messages
    expect(url).toContain('/rest/imconnector.update.messages.json');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const sp = new URLSearchParams(init.body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    // toB24MessageShape: chat.id / user.id приведены к String, message.id/text/date в wire-форме
    expect(sp.get('MESSAGES[0][chat][id]')).toBe('max:-70000000000954');
    // M24: chat.name не шлём — imopenlines его не читает.
    expect(sp.get('MESSAGES[0][chat][name]')).toBeNull();
    expect(sp.get('MESSAGES[0][user][id]')).toBe('54321');
    expect(sp.get('MESSAGES[0][user][name]')).toBe('Иван');
    expect(sp.get('MESSAGES[0][user][last_name]')).toBe('Петров');
    expect(sp.get('MESSAGES[0][message][id]')).toBe('max:mid:mid.ABC');
    expect(sp.get('MESSAGES[0][message][text]')).toBe('привет (исправлено)');
    expect(sp.get('MESSAGES[0][message][date]')).toBe('1700000000');
    // type — отсутствует в Verified schema, не отправляем.
    expect(sp.get('MESSAGES[0][chat][type]')).toBeNull();
  });

  it('2) result проброшен из мок-ответа (data.result)', async () => {
    const raw = { DATA: { RESULT: [{ SUCCESS: true }] } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: raw, time: {} }));

    const result = await client.imconnectorUpdateMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    expect(result).toEqual(raw);
    expect(result.DATA.RESULT[0].SUCCESS).toBe(true);
  });

  // ── валидация входа (fetch не должен вызываться) ───────────────────────────────
  it('3) ValidationError на пустой connectorId, fetch не вызван', async () => {
    await expect(
      client.imconnectorUpdateMessages({ connectorId: '', lineId: 42, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) ValidationError на отсутствующий connectorId, fetch не вызван', async () => {
    await expect(
      client.imconnectorUpdateMessages({ lineId: 42, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5) ValidationError на отсутствующий lineId', async () => {
    await expect(
      client.imconnectorUpdateMessages({ connectorId: 'max_b24', lineId: null, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('6) ValidationError на пустой/не-массив messages', async () => {
    await expect(
      client.imconnectorUpdateMessages({ connectorId: 'max_b24', lineId: 42, messages: [] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorUpdateMessages({ connectorId: 'max_b24', lineId: 42, messages: null }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorUpdateMessages({ connectorId: 'max_b24', lineId: 42, messages: 'nope' }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
