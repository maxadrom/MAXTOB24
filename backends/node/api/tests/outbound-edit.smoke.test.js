// Smoke полного OUTBOUND-edit-flow: POST /webhook/b24 (ONIMCONNECTORMESSAGEUPDATE) →
// b24Controller → b24Service.handleOpenLineMessageEdit → routeOutboundEdit →
// maxService.editOutgoing → maxClient.editMessage (PUT /messages, мок fetch на MAX) →
// best-effort delivery-status → messageLogRepository.recordOutbound (реальный pg).
// M28: сбой правки (200 success:false, 500, 400 «текст слишком длинный») → без записи и
// статуса доставки, оператору — im.message.add; 429 → один повтор.
//
// DB-gated: describe.skipIf(shouldSkipDb()). Зеркало outbound.smoke.test.js.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../src/modules/bindings/participantMapRepository.js';
import { BindingsService } from '../src/modules/bindings/bindingsService.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';
import { encodeForm } from './helpers/form.js';

function postWebhook(app, body) {
  return request(app)
    .post('/webhook/b24')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(body));
}

const PORTAL = 'example.bitrix24.ru';
const MAX_CHAT_ID = '-70000000000954';
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const APP_TOKEN = 'test-app-token-outbound-edit';

function buildTestConfig() {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test' },
    log: { level: 'silent' },
    max: {
      botToken: 'fake-max-token',
      webhookSecret: 'test-max-secret',
      apiBaseUrl: 'https://botapi.max.ru',
      publicWebhookUrl: null,
      webhookUpdateTypes: ['message_created'],
    },
    b24: {
      portal: PORTAL,
      clientId: null,
      clientSecret: null,
      applicationToken: APP_TOKEN,
      olLineId: OL_LINE_ID,
      connectorId: CONNECTOR_ID,
    },
    optional: {},
  });
}

// Ответ MAX PUT /messages (live 2026-10-08): успех — 200 {success:true} без сообщения;
// неудача — тоже 200, но success:false с причиной в message.
function maxJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function b24DeliveryResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result: { SUCCESS: true, DATA: [], time: {} }, time: {} };
    },
  };
}

function b24MessageAddResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result: 1534554, time: {} };
    },
  };
}

// Очередь ответов MAX на PUT /messages (по одному на вызов); пусто → {success:true}.
let maxPutQueue = [];

// MAX /messages → очередь maxPutQueue; Б24 im.message.add → id; остальное (Б24 delivery) →
// b24DeliveryResponse.
function smartFetchMock(url) {
  const u = String(url);
  if (u.includes('/messages') && !u.includes('bitrix24')) {
    const next = maxPutQueue.shift() ?? [200, { success: true }];
    return Promise.resolve(maxJsonResponse(...next));
  }
  if (u.includes('/rest/im.message.add')) return Promise.resolve(b24MessageAddResponse());
  return Promise.resolve(b24DeliveryResponse());
}

function maxPutCalls(fetchSpy) {
  return fetchSpy.mock.calls.filter(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
}

function updateBody(b24MsgId, { maxMid = 'mid.MAX777', editTs = 1700000123, token = APP_TOKEN, text = '[b]Оператор:[/b] [br]правка из Б24' } = {}) {
  return {
    event: 'ONIMCONNECTORMESSAGEUPDATE',
    auth: { application_token: token, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: String(b24MsgId) },
          message: { id: [maxMid], user_id: '1', text, date: editTs },
          chat: { id: `max:${MAX_CHAT_ID}` },
        },
      ],
    },
  };
}

async function countOutbound(pool, key) {
  const { rows } = await pool.query(
    `SELECT * FROM message_log WHERE direction = 'outbound' AND b24_msg_id = $1`,
    [String(key)],
  );
  return rows;
}

// Записи edit-правок конкретного b24MsgId. Ключ теперь edit:<b24MsgId>:<contentToken>,
// поэтому ищем по префиксу, а не по магическому хешу текста.
async function countOutboundEdits(pool, b24MsgId) {
  const { rows } = await pool.query(
    `SELECT * FROM message_log WHERE direction = 'outbound' AND b24_msg_id LIKE $1`,
    [`edit:${b24MsgId}:%`],
  );
  return rows;
}

describe.skipIf(shouldSkipDb())('outbound-edit smoke (b24 OnImConnectorMessageUpdate → MAX PUT /messages)', () => {
  let pool;
  let app;
  let fetchSpy;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);

    const installationsRepo = new InstallationsRepository(pool, null);
    const installations = new InstallationsService(installationsRepo, null);
    const inst = await installationsRepo.upsertByPortal({ portal: PORTAL });
    await installationsRepo.updateTokens(inst.id, {
      access: 'fake-access-token',
      refresh: null,
      applicationToken: APP_TOKEN,
    });
    await installations.seedSingleTenant({
      portal: PORTAL,
      olLineId: OL_LINE_ID,
      connectorId: CONNECTOR_ID,
      maxBotId: MAX_BOT_ID,
    });

    const bindings = new BindingsService({
      bindingsRepository: new BindingsRepository(pool, null),
      participantMapRepository: new ParticipantMapRepository(pool, null),
      installationsService: installations,
      logger: null,
    });
    await bindings.ensureForMaxChat(MAX_CHAT_ID, { maxChatTitle: 'Группа Север для подключения MAX' });

    maxPutQueue = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(smartFetchMock);
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) ONIMCONNECTORMESSAGEUPDATE → 200 ok, MAX PUT /messages?message_id=<maxMid> с новым текстом, delivery best-effort, запись', async () => {
    const res = await postWebhook(app, updateBody('1459190'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1459190', maxMid: 'mid.MAX777' });

    // MAX PUT /messages вызван с message_id=<maxMid> и markdown-текстом.
    const maxCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCall).toBeDefined();
    const [maxUrl, maxOpts] = maxCall;
    expect(maxOpts.method).toBe('PUT');
    expect(String(maxUrl)).toContain('message_id=mid.MAX777');
    const maxBody = JSON.parse(maxOpts.body);
    expect(maxBody.text).toBe('**Оператор:**\nправка из Б24');

    // delivery-status best-effort вызван.
    const deliveryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('imconnector.send.status.delivery'));
    expect(deliveryCall).toBeDefined();

    // одна запись по синтетическому ключу edit:<b24MsgId>:<contentToken>
    const rows = await countOutboundEdits(pool, '1459190');
    expect(rows).toHaveLength(1);
    expect(rows[0].b24_msg_id).toMatch(/^edit:1459190:[0-9a-f]{16}$/);
  });

  it('2) ретрай той же правки (тот же b24MsgId + тот же текст) → duplicate-edit, MAX не правим второй раз', async () => {
    const body = updateBody('1459190-dup');

    const first = await postWebhook(app, body);
    expect(first.status).toBe(200);
    expect(first.body.result.results[0]).toMatchObject({ ok: true });

    const second = await postWebhook(app, body);
    expect(second.status).toBe(200);
    expect(second.body.result.results[0]).toMatchObject({ skipped: 'duplicate-edit' });

    const maxCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCalls).toHaveLength(1);
  });

  it('3) фикс бага: две правки одного b24MsgId с РАЗНЫМ текстом → обе доходят до MAX, две записи', async () => {
    const first = await postWebhook(app, updateBody('1459190-edit2', { text: '[b]Оператор:[/b] [br]правка №1' }));
    expect(first.status).toBe(200);
    expect(first.body.result.results[0]).toMatchObject({ ok: true });

    const second = await postWebhook(app, updateBody('1459190-edit2', { text: '[b]Оператор:[/b] [br]правка №2' }));
    expect(second.status).toBe(200);
    expect(second.body.result.results[0]).toMatchObject({ ok: true }); // НЕ duplicate-edit

    const maxCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCalls).toHaveLength(2);

    const rows = await countOutboundEdits(pool, '1459190-edit2');
    expect(rows).toHaveLength(2);
  });

  it('4) неверный application_token → 401, MAX не вызван', async () => {
    const res = await postWebhook(app, updateBody('1459190-badtoken', { token: 'WRONG-TOKEN' }));

    expect(res.status).toBe(401);
    const maxCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCalls).toHaveLength(0);
  });

  // M28: сбой правки виден оператору. Форма ответа — live 2026-10-08; длинный текст — live
  // 2026-10-09 (4321 = текст 4300 + подпись оператора).
  it.each([
    ['200 success:false «Error on message edit»', [200, { success: false, message: 'Error on message edit' }],
      '⚠️ Правка не доставлена в MAX: MAX отказал. '
      + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.'],
    ['HTTP 500', [500, { code: 'internal', message: 'boom' }],
      '⚠️ Правка не доставлена в MAX: MAX не принял (internal). '
      + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.'],
    ["HTTP 400 proto.payload «Field 'text' size (4321) must be at most 4000»",
      [400, { code: 'proto.payload', message: "Field 'text' size (4321) must be at most 4000" }],
      '⚠️ Правка не доставлена в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). '
      + 'У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.'],
  ])('5) M28: PUT /messages → %s → 200, записи edit нет, статуса доставки нет, оператору im.message.add', async (_label, reply, text) => {
    maxPutQueue = [reply];

    const res = await postWebhook(app, updateBody('1459190-fail'));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toEqual({ skipped: 'edit-failed', notified: true });
    expect(await countOutboundEdits(pool, '1459190-fail')).toHaveLength(0);
    expect(maxPutCalls(fetchSpy)).toHaveLength(1);

    const deliveryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('imconnector.send.status.delivery'));
    expect(deliveryCall).toBeUndefined();

    const noticeCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/rest/im.message.add'));
    expect(noticeCalls).toHaveLength(1);
    const form = new URLSearchParams(noticeCalls[0][1].body);
    expect(form.get('DIALOG_ID')).toBe('chat21186');
    expect(form.get('SYSTEM')).toBe('Y');
    expect(form.get('MESSAGE')).toBe(text);
    expect(form.has('REPLY_ID')).toBe(false); // Б24 не хранит REPLY_ID у SYSTEM=Y (live)

    // Повтор той же правки после сбоя — новая попытка (ключ edit на неудаче не записан).
    const retry = await postWebhook(app, updateBody('1459190-fail'));
    expect(retry.body.result.results[0]).toMatchObject({ ok: true });
    expect(await countOutboundEdits(pool, '1459190-fail')).toHaveLength(1);
  });

  it('6) M28: PUT /messages → 429, затем {success:true} → правка записана после одного повтора, без оповещения', async () => {
    maxPutQueue = [[429, { code: 'too.many.requests', message: 'the number of requests is exceeded' }]];

    const res = await postWebhook(app, updateBody('1459190-429'));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.MAX777' });
    expect(maxPutCalls(fetchSpy)).toHaveLength(2);
    expect(await countOutboundEdits(pool, '1459190-429')).toHaveLength(1);
    const noticeCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/rest/im.message.add'));
    expect(noticeCalls).toHaveLength(0);
  });
});
