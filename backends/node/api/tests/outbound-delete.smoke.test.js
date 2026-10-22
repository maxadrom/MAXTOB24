// Smoke полного OUTBOUND-delete-flow: POST /webhook/b24 (ONIMCONNECTORMESSAGEDELETE) →
// b24Controller → b24Service.handleOpenLineMessageDelete → routeOutboundDelete →
// maxService.deleteOutgoing → maxClient.deleteMessage (DELETE /messages, мок fetch на MAX) →
// messageLogRepository.recordOutbound (реальный pg, синтетический ключ delete:<b24MsgId>).
// Delivery-status для удаления НЕ шлём (в отличие от edit). M28: MAX не удалил → оператору
// im.message.add.
//
// DB-gated: describe.skipIf(shouldSkipDb()). Зеркало outbound-edit.smoke.test.js.

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
const APP_TOKEN = 'test-app-token-outbound-delete';

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

// MAX DELETE /messages → { success: true } (идемпотентно).
function maxDeleteResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true }),
  };
}

// MAX не удалил: 200 + success:false, причина в message (форма live 2026-10-08).
function maxDeleteWindowResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: false, message: 'Invalid chatId: 0' }),
  };
}

// Б24 im.message.add (оповещение оператора) → id системного сообщения.
function b24MessageAddResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { result: 1534554, time: {} };
    },
  };
}

// MAX DELETE /messages → maxResponse(); Б24 im.message.add → id.
function routeFetch(maxResponse) {
  return (url) => Promise.resolve(
    String(url).includes('/rest/im.message.add') ? b24MessageAddResponse() : maxResponse(),
  );
}

// ⚠️ delete-payload: message.id приходит СТРОКОЙ (внешний id), а не массивом.
function deleteBody(b24MsgId, { maxMid = 'mid.MAX777', token = APP_TOKEN } = {}) {
  return {
    event: 'ONIMCONNECTORMESSAGEDELETE',
    auth: { application_token: token, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: String(b24MsgId) },
          message: { id: maxMid },
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

describe.skipIf(shouldSkipDb())('outbound-delete smoke (b24 OnImConnectorMessageDelete → MAX DELETE /messages)', () => {
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

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(maxDeleteResponse());
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) ONIMCONNECTORMESSAGEDELETE → 200 ok, MAX DELETE /messages?message_id=<maxMid>, БЕЗ delivery-status, запись', async () => {
    const res = await postWebhook(app, deleteBody('1459190'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1459190', maxMid: 'mid.MAX777' });

    // MAX DELETE /messages вызван с message_id=<maxMid>.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [maxUrl, maxOpts] = fetchSpy.mock.calls[0];
    expect(maxOpts.method).toBe('DELETE');
    expect(String(maxUrl)).toContain('message_id=mid.MAX777');
    // delivery-status НЕ вызывается для удаления.
    const deliveryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('imconnector.send.status.delivery'));
    expect(deliveryCall).toBeUndefined();

    // одна запись по синтетическому ключу delete:<b24MsgId>
    const rows = await countOutbound(pool, 'delete:1459190');
    expect(rows).toHaveLength(1);
  });

  it('2) ретрай того же удаления (тот же b24MsgId) → duplicate-delete, MAX не удаляем второй раз', async () => {
    const body = deleteBody('1459190-dup');

    const first = await postWebhook(app, body);
    expect(first.status).toBe(200);
    expect(first.body.result.results[0]).toMatchObject({ ok: true });

    const second = await postWebhook(app, body);
    expect(second.status).toBe(200);
    expect(second.body.result.results[0]).toMatchObject({ skipped: 'duplicate-delete' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('3) MAX вернул success:false → 200, skip max-window, без записи, оператору im.message.add (M28)', async () => {
    fetchSpy.mockImplementation(routeFetch(maxDeleteWindowResponse));

    const res = await postWebhook(app, deleteBody('1459190-old'));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toEqual({ skipped: 'max-window', notified: true });

    const rows = await countOutbound(pool, 'delete:1459190-old');
    expect(rows).toHaveLength(0);

    // Записи оригинала нет → без возраста; лимита по давности нет → без срока («24 ч»).
    const noticeCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/rest/im.message.add'));
    expect(noticeCalls).toHaveLength(1);
    const form = new URLSearchParams(noticeCalls[0][1].body);
    expect(form.get('DIALOG_ID')).toBe('chat21186');
    expect(form.get('SYSTEM')).toBe('Y');
    expect(form.get('MESSAGE')).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его. У клиентов в MAX оно осталось.',
    );
  });

  it('4) неверный application_token → 401, MAX не вызван', async () => {
    const res = await postWebhook(app, deleteBody('1459190-badtoken', { token: 'WRONG-TOKEN' }));

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
