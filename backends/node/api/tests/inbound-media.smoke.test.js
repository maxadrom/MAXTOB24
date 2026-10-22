// M11.2 smoke: inbound медиа MAX → Open Lines. POST /webhook/max (message_created
// с body.attachments) → maxController → routeInbound → b24 imconnector.send.messages
// с message.files[] (мок globalThis.fetch на B24) → recordInbound (реальный pg).
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
    media: {
      maxUploadMaxRetries: 2,
      maxUploadRetryBaseMs: 1,
      maxUploadRetryFactor: 2,
      maxBytes: 4 * 1024 * 1024 * 1024,
    },
    optional: {},
  });
}

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

// message_created с одним вложением image (формат снят live в M11.1).
function imageMessageBody(mid) {
  return {
    update_type: 'message_created',
    timestamp: 1700000000000,
    message: {
      recipient: { chat_id: Number(MAX_CHAT_ID) },
      body: {
        mid,
        text: '',
        attachments: [
          { type: 'image', payload: { url: 'https://i.oneme.ru/i?123', photo_id: 987654, token: 't' } },
        ],
      },
      sender: { user_id: Number(MAX_BOT_ID), name: 'Иван' },
    },
  };
}

// M11.3: message_created с голосовым (audio) — host a.oneme.ru/audio,
// payload {url, token, id}, без filename/duration/transcript.
function audioMessageBody(mid) {
  return {
    update_type: 'message_created',
    timestamp: 1700000000000,
    message: {
      recipient: { chat_id: Number(MAX_CHAT_ID) },
      body: {
        mid,
        text: '',
        attachments: [
          {
            type: 'audio',
            payload: {
              url: 'https://a.oneme.ru/audio?expires=1&signatureToken=tok',
              token: 'tok',
              id: 777,
            },
          },
        ],
      },
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

describe.skipIf(shouldSkipDb())('inbound media smoke (MAX attachments → Open Line files)', () => {
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

  it('1) image-вложение → 200 ok, B24 получает message.files[url|name], запись в message_log', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(imageMessageBody('mid-media-1'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-media-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.send.messages');
    const sp = new URLSearchParams(opts.body);
    expect(sp.get('MESSAGES[0][message][files][0][url]')).toBe('https://i.oneme.ru/i?123');
    expect(sp.get('MESSAGES[0][message][files][0][name]')).toBe('987654.webp');

    const rows = await countInbound(pool, 'mid-media-1');
    expect(rows).toHaveLength(1);
  });

  it('2) дубль того же mid → второй записи нет, повторного B24-вызова нет', async () => {
    const body = imageMessageBody('mid-media-dup');

    const first = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(first.body.result).toMatchObject({ ok: true });

    const second = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(second.body.result).toMatchObject({ skipped: 'duplicate' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await countInbound(pool, 'mid-media-dup');
    expect(rows).toHaveLength(1);
  });

  it('3) audio-вложение (M11.3) → B24 files[url|<id>.ogg], payload_meta.kinds=["audio"]', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(audioMessageBody('mid-audio-1'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-audio-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('imconnector.send.messages');
    const sp = new URLSearchParams(opts.body);
    expect(sp.get('MESSAGES[0][message][files][0][url]')).toBe(
      'https://a.oneme.ru/audio?expires=1&signatureToken=tok',
    );
    expect(sp.get('MESSAGES[0][message][files][0][name]')).toBe('777.ogg');

    const rows = await countInbound(pool, 'mid-audio-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_meta.kinds).toContain('audio');
  });

  it('4) дубль audio-mid → второй записи нет, повторного B24-вызова нет', async () => {
    const body = audioMessageBody('mid-audio-dup');

    const first = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(first.body.result).toMatchObject({ ok: true });

    const second = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(body);
    expect(second.body.result).toMatchObject({ skipped: 'duplicate' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await countInbound(pool, 'mid-audio-dup');
    expect(rows).toHaveLength(1);
  });

  // M21 (live 2026-10-08): пересланная картинка с подписью дошла без картинки — своё тело
  // у пересылки пустое, пересланное — в message.link.message.
  it('5) пересылка картинки с подписью → B24 получает цитату с подписью и файл', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send({
        update_type: 'message_created',
        timestamp: 1700000000000,
        message: {
          recipient: { chat_id: Number(MAX_CHAT_ID), chat_type: 'chat' },
          body: { mid: 'mid-fwd-img', text: '' },
          sender: { user_id: Number(MAX_BOT_ID), name: 'Иван' },
          link: {
            type: 'forward',
            sender: { name: 'Пётр' },
            message: {
              mid: 'mid.orig',
              text: 'подпись к картинке',
              attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/i?fwd', photo_id: 555, token: 't' } }],
            },
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-fwd-img' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sp = new URLSearchParams(fetchSpy.mock.calls[0][1].body);
    expect(sp.get('MESSAGES[0][message][text]')).toContain('подпись к картинке');
    expect(sp.get('MESSAGES[0][message][files][0][url]')).toBe('https://i.oneme.ru/i?fwd');
    expect(sp.get('MESSAGES[0][message][files][0][name]')).toBe('555.webp');
  });
});
