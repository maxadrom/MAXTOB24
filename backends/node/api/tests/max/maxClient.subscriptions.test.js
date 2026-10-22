// Unit-тесты M3-методов MaxClient: subscribe / listSubscriptions /
// removeSubscription / getChatMember. Мокаем fetch, проверяем сборку URL,
// HTTP-методы, headers, body, обработку non-2xx и timeout, отсутствие
// токена и значения secret в логах.
//
// Шаблон fetch-мока — как в b24/b24Client.test.js, response.text() имитирует
// поведение настоящего Response (MaxClient._fetchJson читает текст и parse'ит).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxClient } from '../../src/modules/max/maxClient.js';
import { hangingBodyResponse } from '../helpers/http.js';

const BASE_URL = 'https://dev.max.ru/api';
const TOKEN = 'tok-test-max-123';
const WEBHOOK_URL = 'https://example.test/webhook/max';
const SECRET = 'webhook-secret-XYZ-1234567890';

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

describe('MaxClient — M3 subscriptions/chat-members', () => {
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

  it('1) subscribe(): POST /subscriptions с правильным URL, headers, body', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ success: true }));

    const data = await client.subscribe({
      url: WEBHOOK_URL,
      secret: SECRET,
      updateTypes: ['message_created', 'bot_added'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${BASE_URL}/subscriptions`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      url: WEBHOOK_URL,
      secret: SECRET,
      update_types: ['message_created', 'bot_added'],
    });
    expect(data).toEqual({ success: true });
  });

  it('2) subscribe({url: "http://..."}) → throw, fetch не вызван', async () => {
    await expect(
      client.subscribe({ url: 'http://example.test/webhook', secret: SECRET, updateTypes: ['x'] }),
    ).rejects.toThrow(/must start with https:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3) subscribe({updateTypes: []}) → throw, fetch не вызван', async () => {
    await expect(
      client.subscribe({ url: WEBHOOK_URL, secret: SECRET, updateTypes: [] }),
    ).rejects.toThrow(/updateTypes must be non-empty array/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3b) subscribe без secret → throw, fetch не вызван', async () => {
    await expect(
      client.subscribe({ url: WEBHOOK_URL, secret: '', updateTypes: ['message_created'] }),
    ).rejects.toThrow(/secret is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4) subscribe на 4xx → throw Error с HTTP-кодом и снапшотом body', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse(
        { error: 'invalid_url', message: 'URL must be HTTPS' },
        { status: 400, ok: false },
      ),
    );

    await expect(
      client.subscribe({ url: WEBHOOK_URL, secret: SECRET, updateTypes: ['message_created'] }),
    ).rejects.toThrow(/HTTP 400.*URL must be HTTPS/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5) subscribe — AbortError (timeout) → throw "timed out after"', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);

    await expect(
      client.subscribe({ url: WEBHOOK_URL, secret: SECRET, updateTypes: ['message_created'] }),
    ).rejects.toThrow(/timed out after/);
  });

  it('5a) M22: таймаут и сеть → MaxApiError (httpStatus=null, kind)', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(client.listSubscriptions()).rejects.toMatchObject({
      name: 'MaxApiError', httpStatus: null, kind: 'timeout',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.listSubscriptions()).rejects.toMatchObject({
      name: 'MaxApiError', httpStatus: null, kind: 'network',
    });
  });

  it('5b) M22: тело ответа зависло → timed out (дедлайн покрывает и чтение тела)', async () => {
    const c = new MaxClient({ baseUrl: BASE_URL, token: TOKEN, logger, fetchImpl: fetchMock, timeoutMs: 50 });
    fetchMock.mockImplementationOnce(async (_url, { signal }) => hangingBodyResponse(signal));
    await expect(c.getMe()).rejects.toMatchObject({ kind: 'timeout', message: expect.stringMatching(/timed out after 50ms/) });
  });

  it('6) listSubscriptions(): GET /subscriptions, без body, возвращает data', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({ subscriptions: [{ url: WEBHOOK_URL, update_types: ['message_created'] }] }),
    );

    const data = await client.listSubscriptions();

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${BASE_URL}/subscriptions`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0].url).toBe(WEBHOOK_URL);
  });

  it('7) removeSubscription({url}): DELETE /subscriptions?url=<encoded>', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ success: true }));

    await client.removeSubscription({ url: WEBHOOK_URL });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    // URLSearchParams encode уже сам по себе превращает символы — проверяем
    // что url содержит наш WEBHOOK_URL в качестве значения query-параметра.
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/subscriptions');
    expect(parsed.searchParams.get('url')).toBe(WEBHOOK_URL);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('7b) removeSubscription без url → throw, fetch не вызван', async () => {
    await expect(client.removeSubscription({})).rejects.toThrow(/url required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('8) getChatMember(-70000000000954): GET /chats/.../members/me', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({
        user_id: 100000001,
        is_admin: true,
        permissions: ['read_all_messages', 'write'],
      }),
    );

    const member = await client.getChatMember(-70000000000954, 'me');

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/chats/-70000000000954/members/me');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(member.is_admin).toBe(true);
    expect(member.permissions).toContain('read_all_messages');
  });

  it('8b) getChatMember без chatId → throw, fetch не вызван', async () => {
    await expect(client.getChatMember(null)).rejects.toThrow(/chatId required/);
    await expect(client.getChatMember('')).rejects.toThrow(/chatId required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── M10: getChat (имя OL-сессии из названия MAX-группы) ─────────────────────
  it('8c) getChat(-70000000000954): GET /chats/<id> → chat-объект с title', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({ chat_id: -70000000000954, type: 'chat', title: 'Отдел продаж' }),
    );

    const chat = await client.getChat(-70000000000954);

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/chats/-70000000000954');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.body).toBeUndefined();
    expect(chat.title).toBe('Отдел продаж');
  });

  it('8d) getChat без chatId → throw, fetch не вызван', async () => {
    await expect(client.getChat(null)).rejects.toThrow(/chatId required/);
    await expect(client.getChat('')).rejects.toThrow(/chatId required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── M10 (fix): getChatMembers — аватар автора. Регрессия: НЕ /members/{userId}
  // (такого пути нет → MAX 404), а /members?user_ids=<id>.
  it('8e) getChatMembers(chatId, {userIds}): GET /chats/<id>/members?user_ids=<id> → {members}', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({
        members: [{ user_id: 1000001, name: 'Иван', avatar_url: 'https://i.oneme.ru/a.png' }],
      }),
    );

    const data = await client.getChatMembers(-70000000000954, { userIds: [1000001] });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    // Путь — СПИСОК участников, НЕ /members/{userId} (тот валиден только для 'me').
    expect(parsed.pathname).toBe('/api/chats/-70000000000954/members');
    expect(parsed.searchParams.get('user_ids')).toBe('1000001');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(init.body).toBeUndefined();
    expect(data.members[0].avatar_url).toBe('https://i.oneme.ru/a.png');
  });

  it('8f) getChatMembers без userIds → GET /chats/<id>/members без user_ids', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ members: [] }));

    await client.getChatMembers(-70000000000954);

    const [calledUrl] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/chats/-70000000000954/members');
    expect(parsed.searchParams.get('user_ids')).toBeNull();
  });

  it('8g) getChatMembers без chatId → throw, fetch не вызван', async () => {
    await expect(client.getChatMembers(null)).rejects.toThrow(/chatId required/);
    await expect(client.getChatMembers('')).rejects.toThrow(/chatId required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('9) без токена — все 4 метода throw до fetch', async () => {
    const c = new MaxClient({
      baseUrl: BASE_URL,
      token: null,
      logger: captureLogger(),
      fetchImpl: fetchMock,
    });

    await expect(
      c.subscribe({ url: WEBHOOK_URL, secret: SECRET, updateTypes: ['message_created'] }),
    ).rejects.toThrow(/token is not configured/);
    await expect(c.listSubscriptions()).rejects.toThrow(/token is not configured/);
    await expect(c.removeSubscription({ url: WEBHOOK_URL })).rejects.toThrow(
      /token is not configured/,
    );
    await expect(c.getChatMember(-1)).rejects.toThrow(/token is not configured/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('10) логи не содержат значения токена и raw secret (через redactBody)', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ success: true }));
    await client.subscribe({
      url: WEBHOOK_URL,
      secret: SECRET,
      updateTypes: ['message_created'],
    });

    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse({ error: 'bad' }, { status: 400, ok: false }),
    );
    await expect(
      client.subscribe({ url: WEBHOOK_URL, secret: SECRET, updateTypes: ['message_created'] }),
    ).rejects.toThrow();

    const dump = JSON.stringify(logger._records);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(SECRET);
    // Однако маркер [REDACTED] должен присутствовать — проверяем, что redact-логика реально сработала.
    expect(dump).toContain('[REDACTED]');
  });
});
