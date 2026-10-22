// Smoke полного INBOUND-edit-flow: POST /webhook/max (message_edited) →
// maxController → maxService.handleIncomingEdit → messagingService.routeInboundEdit →
// b24Service.updateConnectorMessage (мок globalThis.fetch на B24 REST) →
// messageLogRepository.recordInbound (реальный pg, синтетический ключ edit:<mid>:<ts>).
//
// DB-gated: describe.skipIf(shouldSkipDb()). Зеркало inbound.smoke.test.js.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../src/modules/bindings/participantMapRepository.js';
import { BindingsService } from '../src/modules/bindings/bindingsService.js';
import { MessageLogRepository } from '../src/modules/messaging/messageLogRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';

const PORTAL = 'example.bitrix24.ru';
const MAX_CHAT_ID = '-70000000000954';
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const WEBHOOK_SECRET = 'test-max-secret-1234567890';
const ORIGINAL_MIDS = ['mid-edit-1', 'mid-edit-dup'];

function buildTestConfig() {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test' },
    log: { level: 'silent' },
    max: {
      botToken: null,
      webhookSecret: WEBHOOK_SECRET,
      apiBaseUrl: 'https://dev.max.ru/api',
      publicWebhookUrl: null,
      webhookUpdateTypes: ['message_created', 'message_edited'],
    },
    b24: {
      portal: PORTAL,
      clientId: null,
      clientSecret: null,
      applicationToken: null,
      olLineId: OL_LINE_ID,
      connectorId: CONNECTOR_ID,
    },
    optional: {},
  });
}

// imconnector.update.messages: callMethod разворачивает .result; updateConnectorMessage
// проверяет DATA.RESULT[0].SUCCESS=true.
function b24UpdateResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true }] } },
      time: {},
    }),
  };
}

function messageEditedBody(mid, text = 'исправленный текст', ts = 1700000005000) {
  return {
    update_type: 'message_edited',
    timestamp: ts,
    message: {
      recipient: { chat_id: Number(MAX_CHAT_ID) },
      body: { mid, text },
      sender: { user_id: Number(MAX_BOT_ID), name: 'Иван' },
    },
  };
}

describe.skipIf(shouldSkipDb())('inbound-edit smoke (webhook message_edited → Open Line update)', () => {
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
      applicationToken: null,
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
    const { binding } = await bindings.ensureForMaxChat(MAX_CHAT_ID, { maxChatTitle: 'Группа Север для подключения MAX' });
    // Оригиналы, дошедшие до OL: без записи по «голому» mid правка/удаление → skip no-original.
    const messageLog = new MessageLogRepository(pool, null);
    for (const mid of ORIGINAL_MIDS) {
      await messageLog.recordInbound({ bindingId: binding.id, maxMid: mid, payloadMeta: { senderId: Number(MAX_BOT_ID) } });
    }

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(b24UpdateResponse());
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) message_edited → 200 ok, B24 imconnector.update.messages вызван с тем же external id + маркер «Изменено»', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageEditedBody('mid-edit-1'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toMatchObject({ ok: true, externalId: 'max:mid:mid-edit-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.update.messages');
    const params = new URLSearchParams(opts.body);
    // тот же external id, что у оригинала
    expect(params.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-edit-1');
    // текст с маркером правки
    expect(params.get('MESSAGES[0][message][text]')).toContain('исправленный текст');
    expect(params.get('MESSAGES[0][message][text]')).toContain('[br]----[br][i]Изменено[/i]');
    // date в секундах
    expect(params.get('MESSAGES[0][message][date]')).toBe('1700000005');

    // одна запись по синтетическому ключу edit:<mid>:<ts>
    const { rows } = await pool.query(
      `SELECT * FROM message_log WHERE direction = 'inbound' AND max_mid = $1`,
      ['edit:mid-edit-1:1700000005000'],
    );
    expect(rows).toHaveLength(1);
  });

  it('2) ретрай того же события (тот же mid+ts) → duplicate-edit, повторного B24-вызова нет', async () => {
    const body = messageEditedBody('mid-edit-dup');

    const first = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ ok: true });

    const second = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.result).toMatchObject({ skipped: 'duplicate-edit' });

    // dedup гасит до отправки → B24 update дёрнут только на первом запросе.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('3) оригинал не доходил до OL (нет записи по mid) → 200 skipped no-original, B24 не вызван', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageEditedBody('mid-edit-unknown'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ skipped: 'no-original' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
