// Smoke полного outbound-flow M5.2: POST /webhook/b24 (ONIMCONNECTORMESSAGEADD) →
// b24Controller → b24Service → routeOutbound →
// maxService.sendOutgoingMessage (мок globalThis.fetch на MAX) →
// messageLogRepository.recordOutbound (реальный pg).
//
// DB-gated: describe.skipIf(shouldSkipDb()). В no-DB окружении suite пропускается.
// Зеркало inbound.smoke.test.js.

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

// /webhook/b24 принимает application/x-www-form-urlencoded с индексами массивов.
// superagent .type('form').send(obj) теряет [0] у массива-объектов → шлём строкой.
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
const APP_TOKEN = 'test-app-token-outbound';

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

// Verified MAX sendMessage response (M5.1)
function maxSendResponse() {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        message: {
          recipient: { chat_id: Number(MAX_CHAT_ID), chat_type: 'chat' },
          timestamp: 1748432100000,
          body: { mid: 'mid.smoke-out', seq: 1, text: '' },
          sender: { user_id: 100000001 },
        },
      }),
  };
}

// B24 delivery status response (M5.3)
function b24DeliveryResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result: { SUCCESS: true, DATA: [], time: {} }, time: {} };
    },
  };
}

// Роутит fetch-запросы: MAX /messages → maxSendResponse, B24 delivery → b24DeliveryResponse.
// Остальные Б24-запросы (callMethod) тоже отвечают delivery-ответом по умолчанию (достаточно для smoke).
function smartFetchMock(url) {
  const u = String(url);
  if (u.includes('/messages') && !u.includes('bitrix24')) {
    return Promise.resolve(maxSendResponse());
  }
  return Promise.resolve(b24DeliveryResponse());
}

// Б24 шлёт ONIMCONNECTORMESSAGEADD как application/x-www-form-urlencoded.
// supertest.send(obj) с .type('form') использует qs; вложенность вида
// data[MESSAGES][0][im][message_id] разворачивает express.urlencoded({extended:true}).
function outboundBody(messageId, text = '[b]Оператор:[/b] [br]ответ') {
  return {
    event: 'ONIMCONNECTORMESSAGEADD',
    auth: {
      application_token: APP_TOKEN,
      domain: PORTAL,
      user_id: '1',
    },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: String(messageId) },
          message: { user_id: '1', text },
          chat: { id: `max:${MAX_CHAT_ID}` },
        },
      ],
    },
  };
}

async function countOutbound(pool, b24MsgId) {
  const { rows } = await pool.query(
    `SELECT * FROM message_log WHERE direction = 'outbound' AND b24_msg_id = $1`,
    [String(b24MsgId)],
  );
  return rows;
}

describe.skipIf(shouldSkipDb())('outbound smoke (b24 webhook → MAX group)', () => {
  let pool;
  let app;
  let fetchSpy;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);

    const installationsRepo = new InstallationsRepository(pool, null);
    const installations = new InstallationsService(installationsRepo, null);
    const inst = await installationsRepo.upsertByPortal({ portal: PORTAL });
    // application_token обязателен — контроллер сверяет его
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

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(smartFetchMock);
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) ONIMCONNECTORMESSAGEADD → 200 ok, MAX вызван (markdown text + format), delivery отправлен, запись в message_log', async () => {
    const res = await postWebhook(app, outboundBody('1459190'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.results[0]).toMatchObject({
      ok: true,
      b24MsgId: '1459190',
      maxMid: 'mid.smoke-out',
    });

    // MAX /messages вызван с markdown-текстом и format
    const maxCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCall).toBeDefined();
    const [maxUrl, maxOpts] = maxCall;
    expect(String(maxUrl)).toContain(`chat_id=${MAX_CHAT_ID}`);
    const maxBody = JSON.parse(maxOpts.body);
    // [b]Оператор:[/b] [br]ответ → **Оператор:**\nответ
    expect(maxBody.text).toBe('**Оператор:**\nответ');
    expect(maxBody.format).toBe('markdown');

    // delivery status вызван (Б24 callMethod с imconnector.send.status.delivery)
    const deliveryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('imconnector.send.status.delivery'));
    expect(deliveryCall).toBeDefined();
    const deliveryParams = new URLSearchParams(deliveryCall[1].body);
    expect(deliveryParams.get('MESSAGES[0][im][message_id]')).toBe('1459190');

    // 1 строка в message_log
    const rows = await countOutbound(pool, '1459190');
    expect(rows).toHaveLength(1);
    // M29: строка задания очереди (job:<id>) снята по завершении
    const { rows: jobs } = await pool.query(`SELECT id FROM message_log WHERE b24_msg_id LIKE 'job:%'`);
    expect(jobs).toEqual([]);
  });

  it('2) дубль того же message_id → 200, skipped:"duplicate", MAX не зван второй раз', async () => {
    const body = outboundBody('1459190-dup');

    const first = await postWebhook(app, body);
    expect(first.status).toBe(200);
    expect(first.body.result.results[0]).toMatchObject({ ok: true });

    const second = await postWebhook(app, body);
    expect(second.status).toBe(200);
    expect(second.body.result.results[0]).toMatchObject({ skipped: 'duplicate' });

    // MAX зван только на первом запросе
    const maxCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/messages') && !String(u).includes('bitrix24'));
    expect(maxCalls).toHaveLength(1);

    // В message_log по-прежнему 1 строка
    const rows = await countOutbound(pool, '1459190-dup');
    expect(rows).toHaveLength(1);
  });

  it('3) delivery status провалился → ответ /webhook/b24 всё равно 200 ok:true (best-effort)', async () => {
    // Мокаем так, что delivery-запрос возвращает ошибку
    fetchSpy.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/messages') && !u.includes('bitrix24')) {
        return Promise.resolve(maxSendResponse());
      }
      // delivery endpoint — возвращаем HTTP ошибку
      if (u.includes('imconnector.send.status.delivery')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          async json() { return { error: 'INTERNAL_SERVER_ERROR' }; },
        });
      }
      return Promise.resolve(b24DeliveryResponse());
    });

    const res = await postWebhook(app, outboundBody('1459190-delivery-fail'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.results[0]).toMatchObject({ ok: true });

    // delivery-запрос реально был сделан (fetch зван на delivery endpoint)
    const deliveryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('imconnector.send.status.delivery'));
    expect(deliveryCall).toBeDefined();

    // В message_log 1 строка (доставка зафиксирована несмотря на провал delivery-статуса)
    const rows = await countOutbound(pool, '1459190-delivery-fail');
    expect(rows).toHaveLength(1);
  });
});
