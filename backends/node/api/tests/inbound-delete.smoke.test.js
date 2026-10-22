// Smoke полного INBOUND-delete-flow: POST /webhook/max (message_removed) →
// maxController → maxService.handleIncomingDelete → messagingService.routeInboundDelete →
// b24Service.deleteConnectorMessage (мок globalThis.fetch на B24 REST) →
// messageLogRepository.recordInbound (реальный pg, синтетический ключ delete:<mid>).
//
// DB-gated: describe.skipIf(shouldSkipDb()). Зеркало inbound-edit.smoke.test.js.

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
const ORIGINAL_MIDS = ['mid-del-1', 'mid-del-dup'];

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
      webhookUpdateTypes: ['message_created', 'message_edited', 'message_removed'],
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

// imconnector.delete.messages: callMethod разворачивает .result; deleteConnectorMessage
// проверяет DATA.RESULT[0].SUCCESS=true.
function b24DeleteResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true }] } },
      time: {},
    }),
  };
}

// message_removed — плоский payload: chat_id/message_id/user_id.
function messageRemovedBody(mid, { userId = Number(MAX_BOT_ID), ts = 1700000005000 } = {}) {
  return {
    update_type: 'message_removed',
    timestamp: ts,
    chat_id: Number(MAX_CHAT_ID),
    message_id: mid,
    user_id: userId,
  };
}

describe.skipIf(shouldSkipDb())('inbound-delete smoke (webhook message_removed → Open Line delete)', () => {
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
    // M23: имя автора для delete — из participant_map (пишет routeInbound на каждое входящее).
    await bindings.ensureParticipant(binding.id, { maxUserId: Number(MAX_BOT_ID), displayName: 'Иван Петров' });
    // Оригинал автора, которого нет в participant_map → fallback MAX user <id>.
    await messageLog.recordInbound({ bindingId: binding.id, maxMid: 'mid-del-noname', payloadMeta: { senderId: 777 } });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(b24DeleteResponse());
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) message_removed → 200 ok, B24 imconnector.delete.messages вызван с тем же external id и именем автора', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageRemovedBody('mid-del-1'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toMatchObject({ ok: true, externalId: 'max:mid:mid-del-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.delete.messages');
    const params = new URLSearchParams(opts.body);
    // тот же external id, что у оригинала
    expect(params.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-del-1');
    expect(params.get('MESSAGES[0][chat][id]')).toBe(`max:${MAX_CHAT_ID}`);
    expect(params.get('MESSAGES[0][user][id]')).toBe(MAX_BOT_ID);
    // M23: имя автора из participant_map — иначе Б24 сделает его «Гостем»
    expect(params.get('MESSAGES[0][user][name]')).toBe('Иван Петров');
    expect(params.get('MESSAGES[0][user][last_name]')).toBe('');
    // text/date НЕ отправляются
    expect(params.get('MESSAGES[0][message][text]')).toBeNull();
    expect(params.get('MESSAGES[0][message][date]')).toBeNull();

    // одна запись по синтетическому ключу delete:<mid>
    const { rows } = await pool.query(
      `SELECT * FROM message_log WHERE direction = 'inbound' AND max_mid = $1`,
      ['delete:mid-del-1'],
    );
    expect(rows).toHaveLength(1);
  });

  it('2) ретрай того же события (тот же mid) → duplicate-delete, повторного B24-вызова нет', async () => {
    const body = messageRemovedBody('mid-del-dup');

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
    expect(second.body.result).toMatchObject({ skipped: 'duplicate-delete' });

    // dedup гасит до отправки → B24 delete дёрнут только на первом запросе.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('3) оригинал не доходил до OL (нет записи по mid) → 200 skipped no-original, B24 не вызван', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageRemovedBody('mid-del-unknown'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ skipped: 'no-original' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('4) M23: автора оригинала нет в participant_map → user.name = MAX user <id>, не пустое', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageRemovedBody('mid-del-noname'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true });
    const params = new URLSearchParams(fetchSpy.mock.calls[0][1].body);
    expect(params.get('MESSAGES[0][user][id]')).toBe('777');
    expect(params.get('MESSAGES[0][user][name]')).toBe('MAX user 777');
  });
});
