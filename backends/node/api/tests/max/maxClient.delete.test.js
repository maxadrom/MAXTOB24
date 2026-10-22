// Unit-тесты OUTBOUND-удаления MaxClient.deleteMessage({ messageId }):
// DELETE /messages?message_id=<id> с заголовком Authorization=<token> (БЕЗ Bearer),
// без тела. Мокаем fetch; проверяем метод, message_id в query, auth-заголовок,
// валидацию аргументов, обработку non-2xx и отсутствие значения токена в логах.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxClient } from '../../src/modules/max/maxClient.js';

const BASE_URL = 'https://dev.max.ru/api';
const TOKEN = 'tok-test-max-123';
const MESSAGE_ID = 'mid.abc-123';

function fakeFetchResponse(body, { status = 200, ok = status < 400 } = {}) {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    async text() {
      return text;
    },
  };
}

function captureLogger() {
  const records = [];
  function make() {
    return {
      info: (...args) => records.push(['info', ...args]),
      warn: (...args) => records.push(['warn', ...args]),
      error: (...args) => records.push(['error', ...args]),
      debug: (...args) => records.push(['debug', ...args]),
      trace: (...args) => records.push(['trace', ...args]),
      child: () => make(),
    };
  }
  const logger = make();
  logger._records = records;
  return logger;
}

describe('MaxClient — deleteMessage (DELETE /messages)', () => {
  let fetchMock;
  let client;
  let logger;

  beforeEach(() => {
    fetchMock = vi.fn();
    logger = captureLogger();
    client = new MaxClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      logger,
      fetchImpl: fetchMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1) happy path: DELETE /messages?message_id=<id>, Authorization=token, без тела', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ success: true }));

    const data = await client.deleteMessage({ messageId: MESSAGE_ID });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/messages');
    expect(parsed.searchParams.get('message_id')).toBe(MESSAGE_ID);
    expect(init.method).toBe('DELETE');
    // Authorization = чистый токен, БЕЗ префикса 'Bearer '.
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.headers.Authorization).not.toMatch(/^Bearer /);
    // DELETE без тела.
    expect(init.body).toBeUndefined();
    expect(data).toEqual({ success: true });
  });

  it('2) идемпотентно: повтор того же mid → снова { success: true }', async () => {
    fetchMock.mockResolvedValue(fakeFetchResponse({ success: true }));

    const first = await client.deleteMessage({ messageId: MESSAGE_ID });
    const second = await client.deleteMessage({ messageId: MESSAGE_ID });

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('3) без messageId → TypeError, fetch не вызван', async () => {
    await expect(client.deleteMessage({})).rejects.toThrow(TypeError);
    await expect(client.deleteMessage({})).rejects.toThrow(/messageId required/);
    await expect(client.deleteMessage({ messageId: '' })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) non-2xx → throw Error с HTTP-кодом и снапшотом body (как в _fetchJson)', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse(
        { error: 'not_found', message: 'message not found' },
        { status: 404, ok: false },
      ),
    );

    await expect(client.deleteMessage({ messageId: MESSAGE_ID })).rejects.toThrow(
      /HTTP 404.*message not found/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5) логи не содержат значения токена', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ success: true }));
    await client.deleteMessage({ messageId: MESSAGE_ID });

    const dump = JSON.stringify(logger._records);
    expect(dump).not.toContain(TOKEN);
  });
});
