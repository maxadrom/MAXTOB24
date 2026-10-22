// Unit-тесты OUTBOUND-правки MaxClient.editMessage({ messageId, text, format }):
// PUT /messages?message_id=<id> с заголовком Authorization=<token> (БЕЗ Bearer)
// и телом { text, format? }. Мокаем fetch; проверяем метод, message_id в query,
// auth-заголовок, тело, валидацию аргументов, обработку non-2xx и отсутствие
// значения токена в логах.
//
// Шаблон fetch-мока — как в maxClient.subscriptions.test.js: response.text()
// имитирует настоящий Response (MaxClient._fetchJson читает текст и parse'ит).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxClient } from '../../src/modules/max/maxClient.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';

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

describe('MaxClient — editMessage (PUT /messages)', () => {
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

  it('1) happy path: PUT /messages?message_id=<id>, Authorization=token, body={text}', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: MESSAGE_ID } } }));

    const data = await client.editMessage({ messageId: MESSAGE_ID, text: 'исправленный текст' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/messages');
    expect(parsed.searchParams.get('message_id')).toBe(MESSAGE_ID);
    expect(init.method).toBe('PUT');
    // Authorization = чистый токен, БЕЗ префикса 'Bearer '.
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.headers.Authorization).not.toMatch(/^Bearer /);
    expect(init.headers['Content-Type']).toBe('application/json');
    // Тело — { text } без format, раз format не задан.
    const body = JSON.parse(init.body);
    expect(body).toEqual({ text: 'исправленный текст' });
    expect(body).not.toHaveProperty('format');
    expect(data).toEqual({ message: { body: { mid: MESSAGE_ID } } });
  });

  it('2) с format: тело содержит { text, format }', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: MESSAGE_ID } } }));

    await client.editMessage({ messageId: MESSAGE_ID, text: 'жирный', format: 'markdown' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ text: 'жирный', format: 'markdown' });
  });

  it('3) без messageId → TypeError, fetch не вызван', async () => {
    await expect(client.editMessage({ text: 'x' })).rejects.toThrow(TypeError);
    await expect(client.editMessage({ text: 'x' })).rejects.toThrow(/messageId required/);
    await expect(client.editMessage({ messageId: '', text: 'x' })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) text не строка → TypeError, fetch не вызван', async () => {
    await expect(client.editMessage({ messageId: MESSAGE_ID, text: 123 })).rejects.toThrow(
      TypeError,
    );
    await expect(client.editMessage({ messageId: MESSAGE_ID, text: 123 })).rejects.toThrow(
      /text must be string/,
    );
    await expect(client.editMessage({ messageId: MESSAGE_ID })).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5) non-2xx → throw Error с HTTP-кодом и снапшотом body (как в _fetchJson)', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse(
        { error: 'not_found', message: 'message not found' },
        { status: 404, ok: false },
      ),
    );

    await expect(
      client.editMessage({ messageId: MESSAGE_ID, text: 'упс' }),
    ).rejects.toThrow(/HTTP 404.*message not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5b) non-2xx → MaxApiError с httpStatus/maxCode, без поля status (его читает errorHandler)', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse(
        { code: 'not.found', message: 'message not found' },
        { status: 404, ok: false },
      ),
    );

    const err = await client.editMessage({ messageId: MESSAGE_ID, text: 'упс' }).catch((e) => e);
    expect(err).toBeInstanceOf(MaxApiError);
    expect(err.httpStatus).toBe(404);
    expect(err.maxCode).toBe('not.found');
    expect(err.method).toBe('PUT');
    expect(err.path).toBe('/messages');
    expect(err.status).toBeUndefined();
    expect(err.maxMessage).toBe('message not found');
  });

  it('5c) M28: 400 proto.payload на длинный текст (live 2026-10-09) → maxMessage — текст MAX как есть', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse(
        { code: 'proto.payload', message: "Field 'text' size (4321) must be at most 4000" },
        { status: 400, ok: false },
      ),
    );

    const err = await client.editMessage({ messageId: MESSAGE_ID, text: 'я'.repeat(4321) }).catch((e) => e);
    expect(err).toBeInstanceOf(MaxApiError);
    expect(err).toMatchObject({
      kind: 'http',
      httpStatus: 400,
      maxCode: 'proto.payload',
      maxMessage: "Field 'text' size (4321) must be at most 4000",
    });
  });

  it('5d) M28: тело не JSON → maxMessage — начало тела; пустое тело → null', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse('Bad Gateway', { status: 502, ok: false }));
    const err = await client.editMessage({ messageId: MESSAGE_ID, text: 'x' }).catch((e) => e);
    expect(err.maxMessage).toBe('Bad Gateway');
    expect(err.maxCode).toBeNull();

    fetchMock.mockResolvedValueOnce(fakeFetchResponse(null, { status: 500, ok: false }));
    const empty = await client.editMessage({ messageId: MESSAGE_ID, text: 'x' }).catch((e) => e);
    expect(empty.maxMessage).toBeNull();
  });

  it('6) логи не содержат значения токена', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: MESSAGE_ID } } }));
    await client.editMessage({ messageId: MESSAGE_ID, text: 'привет' });

    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({ error: 'bad' }, { status: 400, ok: false }),
    );
    await expect(client.editMessage({ messageId: MESSAGE_ID, text: 'привет' })).rejects.toThrow();

    const dump = JSON.stringify(logger._records);
    expect(dump).not.toContain(TOKEN);
  });
});
