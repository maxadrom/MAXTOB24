// Smoke полного inbound-flow M4.2: POST /webhook/max (message_created) →
// maxController → maxService → messagingService.routeInbound →
// b24Service.sendConnectorMessage (мок globalThis.fetch на B24 REST) →
// messageLogRepository.recordInbound (реальный pg).
//
// DB-gated: describe.skipIf(shouldSkipDb()) + truncateAll(pool). В no-DB
// окружении (`make test` без Postgres) suite пропускается, а НЕ падает.
// app.smoke.test.js (FakePool, без БД) намеренно НЕ трогаем — там M1-контракт.
//
// Эталон seed'а installations/binding — register-connector.smoke.test.js.

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

const PORTAL = 'example.bitrix24.ru';
const MAX_CHAT_ID = '-70000000000954';
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const WEBHOOK_SECRET = 'test-max-secret-1234567890';

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
      webhookUpdateTypes: ['message_created'],
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

// Verified schema M4.1: B24 оборачивает успех в {result, time}; callMethod
// разворачивает .result. RESULT[0].SUCCESS=true + session.{ID,CHAT_ID} (строки).
function b24SendResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        SUCCESS: true,
        DATA: {
          RESULT: [
            {
              chat: { id: `max:${MAX_CHAT_ID}` },
              user: 9860,
              message: { id: 'echo', date: {} },
              SUCCESS: true,
              session: { ID: '15756', CHAT_ID: '21180' },
            },
          ],
        },
      },
      time: {},
    }),
  };
}

function messageCreatedBody(mid, text = 'Привет из MAX', markup = undefined) {
  return {
    update_type: 'message_created',
    timestamp: 1700000000000, // мс — routeInbound конвертит в секунды
    message: {
      // recipient.chat_id приходит числом; max_chat_id в БД — text. node-pg
      // стрингифицирует число-параметр → text-сравнение совпадает.
      recipient: { chat_id: Number(MAX_CHAT_ID) },
      body: markup ? { mid, text, markup } : { mid, text },
      sender: { user_id: Number(MAX_BOT_ID), name: 'Иван' },
    },
  };
}

async function countInbound(pool, mid) {
  const { rows } = await pool.query(
    `SELECT * FROM message_log WHERE direction = 'inbound' AND max_mid = $1`,
    [mid],
  );
  return rows;
}

describe.skipIf(shouldSkipDb())('inbound smoke (webhook → Open Line)', () => {
  let pool;
  let app;
  let fetchSpy;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);

    // Seed installation (portal + access token + connector metadata) и binding —
    // через отдельный DI-граф на том же pool, что использует buildApp.
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
    // Чат OL уже существует (b24_chat_id известен), название не задано: интро группы и
    // синхронизация названия (M24) здесь не вклиниваются — их покрывает
    // inbound-group-intro.smoke.test.js.
    const { binding } = await bindings.ensureForMaxChat(MAX_CHAT_ID);
    await bindings.attachB24ChatId(binding.id, '21180');

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(b24SendResponse());
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) message_created → 200 ok, B24 вызван (date в секундах), запись в message_log', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageCreatedBody('mid-smoke-1'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toMatchObject({
      ok: true,
      maxMid: 'mid-smoke-1',
      b24MsgId: 'max:mid:mid-smoke-1',
    });

    // B24 вызван ровно один раз, на корректный метод.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.send.messages');
    // date сконвертирована из мс в секунды (10 цифр), а не отправлена как мс.
    const sentParams = new URLSearchParams(opts.body);
    expect(sentParams.get('MESSAGES[0][message][date]')).toBe('1700000000');
    expect(sentParams.get('MESSAGES[0][user][name]')).toBe('Иван');

    const rows = await countInbound(pool, 'mid-smoke-1');
    expect(rows).toHaveLength(1);
  });

  it('2) дубль того же mid → второй записи нет, повторного B24-вызова нет', async () => {
    const body = messageCreatedBody('mid-smoke-dup');

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
    expect(second.body.result).toMatchObject({ skipped: 'duplicate' });

    // dedup гасит до отправки → B24 дёрнут только на первом запросе.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const rows = await countInbound(pool, 'mid-smoke-dup');
    expect(rows).toHaveLength(1);
  });

  it('3) body.markup (verified MAX format) → B24 получает BB-коды (markupToBbcode E2E)', async () => {
    // Verified MAX payload (2026-05-28): body.text = plain, body.markup = [{from,length,type}]
    // "Жирный и Курсив": Жирный[0..6]=strong, Курсив[9..15]=emphasized
    const markup = [
      { from: 0, length: 6, type: 'strong' },
      { from: 9, length: 6, type: 'emphasized' },
    ];
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageCreatedBody('mid-smoke-bb', 'Жирный и Курсив', markup));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.send.messages');
    const params = new URLSearchParams(opts.body);
    expect(params.get('MESSAGES[0][message][text]')).toBe('[b]Жирный[/b] и [i]Курсив[/i]');
  });

  it('4) plain-текст без markdown-маркеров → B24 получает текст без изменений (pass-through)', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageCreatedBody('mid-smoke-plain', 'просто текст'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const params = new URLSearchParams(opts.body);
    expect(params.get('MESSAGES[0][message][text]')).toBe('просто текст');
  });

  // M21: до guard'а chat_type личка онбордилась как группа (сессия ОЛ), а личка с
  // chat_id=null падала в assertMaxUpdate → 400 → ретраи MAX.
  it.each([
    ['личка с chat_id=null', { chat_id: null, chat_type: 'dialog', user_id: Number(MAX_BOT_ID) }, true],
    ['пост канала без sender', { chat_id: -555, chat_type: 'channel' }, false],
  ])('5) M21: %s → 200 skipped not-group-chat, привязки и вызова Б24 нет', async (_label, recipient, withSender) => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send({
        update_type: 'message_created',
        timestamp: 1700000000000,
        message: {
          recipient,
          body: { mid: 'mid-not-group', text: 'привет' },
          ...(withSender ? { sender: { user_id: 1000001, name: 'Иван' } } : {}),
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ skipped: 'not-group-chat', chatType: recipient.chat_type });
    expect(fetchSpy).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT max_chat_id FROM chat_bindings');
    expect(rows).toEqual([{ max_chat_id: MAX_CHAT_ID }]);
  });

  // M21: по доке MAX у пересылки без своего текста body=null → mid нет. До M21 такие
  // сообщения шли с external id max:mid:null и дублировались на ретраях.
  it('6) M21: пересылка без своего текста (body=null) → синтетический ключ, ретрай → duplicate', async () => {
    const body = {
      update_type: 'message_created',
      timestamp: 1700000000000,
      message: {
        recipient: { chat_id: Number(MAX_CHAT_ID), chat_type: 'chat' },
        sender: { user_id: 1000001, name: 'Иван' },
        body: null,
        link: { type: 'forward', sender: { name: 'Пётр' }, message: { mid: 'mid.orig', text: 'пересланное' } },
      },
    };
    const key = `nomid:${MAX_CHAT_ID}:1000001:1700000000000`;

    const first = await request(app).post('/webhook/max').set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET).send(body);
    const second = await request(app).post('/webhook/max').set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET).send(body);

    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ ok: true, maxMid: null });
    expect(second.body.result).toMatchObject({ skipped: 'duplicate' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const params = new URLSearchParams(fetchSpy.mock.calls[0][1].body);
    expect(params.get('MESSAGES[0][message][id]')).toBe(`max:${key}`);
    expect(params.get('MESSAGES[0][message][text]')).toContain('пересланное');
    expect(await countInbound(pool, key)).toHaveLength(1);
  });
});
