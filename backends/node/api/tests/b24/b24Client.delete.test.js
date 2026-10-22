// Unit-тесты B24Client.imconnectorDeleteMessages (удаление ранее доставленного
// сообщения OL по внешнему id). Мокаем fetch и installationsService целиком —
// БД не нужна. Контракт toB24DeleteShape: три id + имя автора (M23: без имени Б24
// делает автора «Гостем»), без text/date/chat.name. Проверяем сборку method/URL/payload
// и валидацию входа.

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

describe('B24Client.imconnectorDeleteMessages', () => {
  let fetchMock;
  let client;

  // Для delete нужны три id и имя автора. Передаём «лишние» поля (text/date/chat.name) —
  // toB24DeleteShape обязан их отбросить.
  function validMessages() {
    return [
      {
        chat: { id: 'max:-70000000000954', name: 'Группа Север' },
        user: { id: 54321, name: 'Иван', lastName: 'Петров' },
        message: { id: 'max:mid:mid.ABC', text: 'не должно попасть', date: 1700000000 },
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

  // ── happy path: shape {user,message,chat} + имя автора, без text/date ─────────
  it('1) вызывает imconnector.delete.messages; MESSAGES — id и имя автора, без text/date', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { DATA: { RESULT: [{ SUCCESS: true }] } }, time: {} }),
    );

    await client.imconnectorDeleteMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/imconnector.delete.messages.json');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const sp = new URLSearchParams(init.body);
    expect(sp.get('CONNECTOR')).toBe('max_b24');
    expect(sp.get('LINE')).toBe('42');
    // три id, приведены к String
    expect(sp.get('MESSAGES[0][user][id]')).toBe('54321');
    expect(sp.get('MESSAGES[0][message][id]')).toBe('max:mid:mid.ABC');
    expect(sp.get('MESSAGES[0][chat][id]')).toBe('max:-70000000000954');
    // M23: имя автора уходит — иначе Б24 сделает его «Гостем»
    expect(sp.get('MESSAGES[0][user][name]')).toBe('Иван');
    expect(sp.get('MESSAGES[0][user][last_name]')).toBe('Петров');
    // text/date/chat.name НЕ отправляются
    expect(sp.get('MESSAGES[0][message][text]')).toBeNull();
    expect(sp.get('MESSAGES[0][message][date]')).toBeNull();
    expect(sp.get('MESSAGES[0][chat][name]')).toBeNull();
  });

  it('1b) без имени автора — user только с id, last_name не добавляется', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { DATA: { RESULT: [{ SUCCESS: true }] } }, time: {} }),
    );

    await client.imconnectorDeleteMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: [{ chat: { id: 'max:1' }, user: { id: 54321 }, message: { id: 'max:mid:x' } }],
    });

    const sp = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sp.get('MESSAGES[0][user][id]')).toBe('54321');
    expect(sp.get('MESSAGES[0][user][name]')).toBeNull();
    expect(sp.get('MESSAGES[0][user][last_name]')).toBeNull();
  });

  it('2) result проброшен из мок-ответа (data.result)', async () => {
    const raw = { DATA: { RESULT: [{ SUCCESS: true }] } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: raw, time: {} }));

    const result = await client.imconnectorDeleteMessages({
      connectorId: 'max_b24',
      lineId: 42,
      messages: validMessages(),
    });

    expect(result).toEqual(raw);
    expect(result.DATA.RESULT[0].SUCCESS).toBe(true);
  });

  // ── валидация входа (fetch не должен вызываться) ───────────────────────────────
  it('3) ValidationError на пустой/отсутствующий connectorId, fetch не вызван', async () => {
    await expect(
      client.imconnectorDeleteMessages({ connectorId: '', lineId: 42, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorDeleteMessages({ lineId: 42, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) ValidationError на отсутствующий lineId', async () => {
    await expect(
      client.imconnectorDeleteMessages({ connectorId: 'max_b24', lineId: null, messages: validMessages() }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5) ValidationError на пустой/не-массив messages', async () => {
    await expect(
      client.imconnectorDeleteMessages({ connectorId: 'max_b24', lineId: 42, messages: [] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.imconnectorDeleteMessages({ connectorId: 'max_b24', lineId: 42, messages: null }),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
