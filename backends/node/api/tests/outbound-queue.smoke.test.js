// M29 smoke: очередь исходящих по чату через настоящий buildApp и pg. POST /webhook/b24 →
// b24Service → messaging.routeOutboundQueued: claim строки job: → FIFO чата → прежний
// маршрут (файл: скачивание → заливка на локальный приёмник → POST /messages) → release.
// MAX POST /messages с вложением «висит» на gate — так ловятся события, пришедшие во
// время передачи файла: текст, правка и удаление того же чата ждут её, другой чат — нет.
//
// DB-gated: describe.skipIf(shouldSkipDb()).

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
import { binaryResponse } from './helpers/http.js';
import { startUploadServer } from './helpers/uploadServer.js';

function postWebhook(app, body) {
  return request(app)
    .post('/webhook/b24')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(body));
}

// supertest ленив: запрос уходит на then. → промис ответа, запрос уже в пути.
function startPost(app, body) {
  return postWebhook(app, body).then((res) => res);
}

const PORTAL = 'example.bitrix24.ru';
const CHAT_A = '-70000000000954';
const CHAT_B = '-70000000000955';
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const APP_TOKEN = 'test-app-token-queue';
const MAX_API = 'https://botapi.max.ru';

function buildTestConfig({ tmpDir, queueMax }) {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test' },
    log: { level: 'silent' },
    max: {
      botToken: 'fake-max-token',
      webhookSecret: 'test-max-secret',
      apiBaseUrl: MAX_API,
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
    media: {
      maxUploadMaxRetries: 2,
      maxUploadRetryBaseMs: 1,
      maxUploadRetryFactor: 2,
      maxBytes: 256 * 1024 * 1024,
      transferTimeoutMs: 5_000,
      concurrency: 2,
      tmpDir,
    },
    outbound: { queueMax },
    optional: {},
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// fetch: скачивание файла оператора, MAX /uploads → локальный приёмник, MAX POST /messages
// (с вложением — ждёт gate, если он взведён), PUT/DELETE /messages, Б24 REST.
// posts — POST /messages по порядку: { kind: 'file-start'|'file'|'text', chatId, text, mid }.
function makeFetchMock({ uploadUrl }) {
  const posts = [];
  let gate = null;
  let files = 0;
  let texts = 0;
  return {
    posts,
    holdFiles() {
      gate = deferred();
      return gate;
    },
    releaseAll() {
      gate?.resolve();
    },
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/pub/im.file.php')) return binaryResponse([1, 2, 3, 4], { contentType: 'image/jpeg' });
      if (u.startsWith(MAX_API) && u.includes('/uploads')) return jsonResponse({ url: uploadUrl });
      if (u.startsWith(MAX_API) && u.includes('/messages')) {
        if (opts.method === 'DELETE' || opts.method === 'PUT') return jsonResponse({ success: true });
        const chatId = new URL(u).searchParams.get('chat_id');
        const body = JSON.parse(opts.body);
        if (body.attachments) {
          files += 1;
          const mid = `mid.q-file-${files}`;
          posts.push({ kind: 'file-start', chatId });
          if (gate) await gate.promise;
          posts.push({ kind: 'file', chatId, mid });
          return jsonResponse({ message: { body: { mid }, timestamp: 1748432100000 } });
        }
        texts += 1;
        const mid = `mid.q-text-${texts}`;
        posts.push({ kind: 'text', chatId, text: body.text, mid });
        return jsonResponse({ message: { body: { mid }, timestamp: 1748432100000 } });
      }
      if (u.includes('/rest/im.message.add')) return jsonResponse({ result: 777 });
      return jsonResponse({ result: { SUCCESS: true, DATA: [], time: {} }, time: {} });
    },
  };
}

function file(n) {
  return {
    name: `photo${n}.jpg`,
    type: 'image',
    mime: 'image/jpeg',
    link: `https://${PORTAL}/disk/${n}`,
    downloadLink: `https://${PORTAL}/pub/im.file.php?FILE_ID=${n}&SIGN=x&img=y`,
    size: 4,
    sizef: '4 B',
  };
}

function eventBody(event, messageId, { chat = CHAT_A, message }) {
  return {
    event,
    auth: { application_token: APP_TOKEN, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: chat === CHAT_A ? '21186' : '21187', message_id: String(messageId) },
          message: { user_id: '1', ...message },
          chat: { id: `max:${chat}` },
        },
      ],
    },
  };
}

function addBody(messageId, { chat, text = '[b]Оператор:[/b] [br]photo1.jpg', files } = {}) {
  return eventBody('ONIMCONNECTORMESSAGEADD', messageId, { chat, message: { text, ...(files ? { files } : {}) } });
}

// Во время заливки статуса доставки ещё не было — внешних id в событии нет.
function editBody(messageId, text) {
  return eventBody('ONIMCONNECTORMESSAGEUPDATE', messageId, { message: { text } });
}

function deleteBody(messageId) {
  return eventBody('ONIMCONNECTORMESSAGEDELETE', messageId, { message: {} });
}

async function outboundKeys(pool) {
  const { rows } = await pool.query(
    `SELECT b24_msg_id FROM message_log WHERE direction = 'outbound' AND status <> 'in_progress' ORDER BY id`,
  );
  return rows.map((r) => r.b24_msg_id);
}

async function jobRows(pool) {
  const { rows } = await pool.query(
    `SELECT b24_msg_id, status, payload_meta FROM message_log WHERE b24_msg_id LIKE 'job:%' ORDER BY id`,
  );
  return rows;
}

function maxCalls(fetchSpy, method) {
  return fetchSpy.mock.calls
    .filter(([u, o]) => String(u).startsWith(MAX_API) && String(u).includes('/messages') && o?.method === method)
    .map(([u]) => new URL(String(u)).searchParams.get('message_id'));
}

describe.skipIf(shouldSkipDb())('outbound queue smoke (исходящие одного чата — по очереди)', () => {
  let pool;
  let app;
  let fetchSpy;
  let mock;
  let server;
  let tmpDir;

  function setup({ queueMax = 20 } = {}) {
    mock = makeFetchMock({ uploadUrl: server.url('/upload?sig=q') });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch);
    app = buildApp(buildTestConfig({ tmpDir, queueMax }), { pool, logger: pino({ level: 'silent' }) });
  }

  // Заливка дошла до POST /messages и висит на gate.
  function fileStarted(n = 1) {
    return vi.waitFor(() => {
      expect(mock.posts.filter((p) => p.kind === 'file-start')).toHaveLength(n);
    }, { timeout: 3_000 });
  }

  // Событие принято: строка задания записана (дальше оно ждёт очереди чата).
  function claimed(jobKey) {
    return vi.waitFor(async () => {
      expect((await jobRows(pool)).map((r) => r.b24_msg_id)).toContain(jobKey);
    }, { timeout: 3_000 });
  }

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
    await bindings.ensureForMaxChat(CHAT_A, { maxChatTitle: 'Группа А' });
    await bindings.ensureForMaxChat(CHAT_B, { maxChatTitle: 'Группа Б' });

    server = await startUploadServer(() => ({ status: 200, body: { photos: { p0: { token: 'tok-abc' } } } }));
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm29-queue-smoke-'));
  });

  afterEach(async () => {
    // Задания дописывают в БД после ответа MAX: дождаться их ДО очистки следующего теста.
    mock?.releaseAll();
    await app?.locals.outbound.queue.whenIdle();
    vi.restoreAllMocks();
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) файл висит на отправке в MAX: строка job: in_progress, повтор того же события → 200 duplicate-in-progress', async () => {
    setup();
    const gate = mock.holdFiles();

    const first = startPost(app, addBody('1600001', { files: [file(1)] }));
    await fileStarted();

    const jobs = await jobRows(pool);
    expect(jobs).toEqual([{
      b24_msg_id: 'job:1600001',
      status: 'in_progress',
      payload_meta: expect.objectContaining({ op: 'add', opKey: '1600001', filesCount: 1, fileNames: ['photo1.jpg'] }),
    }]);

    const dup = await postWebhook(app, addBody('1600001', { files: [file(1)] }));
    expect(dup.status).toBe(200);
    expect(dup.body.result.results[0]).toEqual({ skipped: 'duplicate-in-progress' });

    gate.resolve();
    const res = await first;
    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600001', maxMids: ['mid.q-file-1'] });
    expect(mock.posts.filter((p) => p.kind === 'file')).toHaveLength(1);
    expect(await jobRows(pool)).toEqual([]);
  });

  it('2) текст того же чата ждёт файл и уходит после него; текст другого чата не ждёт', async () => {
    setup();
    const gate = mock.holdFiles();

    const fileReq = startPost(app, addBody('1600010', { files: [file(1)] }));
    await fileStarted();
    const textReq = startPost(app, addBody('1600011', { text: 'после файла' }));
    await claimed('job:1600011');

    const other = await postWebhook(app, addBody('1600012', { chat: CHAT_B, text: 'другой чат' }));
    expect(other.status).toBe(200);
    expect(other.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600012' });
    // в чат А пока ушло только начало файла
    expect(mock.posts.map((p) => `${p.kind}:${p.chatId}`)).toEqual([`file-start:${CHAT_A}`, `text:${CHAT_B}`]);

    gate.resolve();
    const [fileRes, textRes] = await Promise.all([fileReq, textReq]);
    expect(fileRes.status).toBe(200);
    expect(textRes.status).toBe(200);
    expect(textRes.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600011' });
    expect(mock.posts.filter((p) => p.chatId === CHAT_A).map((p) => p.kind)).toEqual(['file-start', 'file', 'text']);

    expect(await outboundKeys(pool)).toEqual(
      expect.arrayContaining(['file:1600010:0', '1600010', '1600011', '1600012']),
    );
    expect(await jobRows(pool)).toEqual([]);
  });

  it('3) удаление во время заливки выполняется после неё и удаляет файл в MAX по его mid', async () => {
    setup();
    const gate = mock.holdFiles();

    const fileReq = startPost(app, addBody('1600020', { files: [file(1)] }));
    await fileStarted();
    const delReq = startPost(app, deleteBody('1600020'));
    await claimed('job:delete:1600020');
    expect(maxCalls(fetchSpy, 'DELETE')).toEqual([]);

    gate.resolve();
    expect((await fileReq).status).toBe(200);
    const del = await delReq;
    expect(del.status).toBe(200);
    expect(del.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600020', maxMid: 'mid.q-file-1' });
    expect(maxCalls(fetchSpy, 'DELETE')).toEqual(['mid.q-file-1']);
    expect(await outboundKeys(pool)).toContain('delete:1600020');
    expect(await jobRows(pool)).toEqual([]);
  });

  it('4) правка подписи во время заливки применяется после неё к mid файла, без оповещения «не найдено»', async () => {
    setup();
    const gate = mock.holdFiles();

    const fileReq = startPost(app, addBody('1600030', { text: '[b]Оператор:[/b] [br]подпись', files: [file(1)] }));
    await fileStarted();
    const editReq = startPost(app, editBody('1600030', '[b]Оператор:[/b] [br]новая подпись'));
    await vi.waitFor(async () => {
      expect((await jobRows(pool)).some((r) => r.b24_msg_id.startsWith('job:edit:1600030:'))).toBe(true);
    }, { timeout: 3_000 });
    expect(maxCalls(fetchSpy, 'PUT')).toEqual([]);

    gate.resolve();
    expect((await fileReq).status).toBe(200);
    const edit = await editReq;
    expect(edit.status).toBe(200);
    expect(edit.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600030', maxMid: 'mid.q-file-1' });
    expect(maxCalls(fetchSpy, 'PUT')).toEqual(['mid.q-file-1']);
    const notices = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/rest/im.message.add'));
    expect(notices).toHaveLength(0);
  });

  it('5) очередь чата полна (OUTBOUND_QUEUE_MAX=1) → событие того же чата обрабатывается без ожидания', async () => {
    setup({ queueMax: 1 });
    const gate = mock.holdFiles();

    const fileReq = startPost(app, addBody('1600040', { files: [file(1)] }));
    await fileStarted();

    const text = await postWebhook(app, addBody('1600041', { text: 'вне очереди' }));
    expect(text.status).toBe(200);
    expect(text.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1600041' });
    expect(mock.posts.map((p) => p.kind)).toEqual(['file-start', 'text']);

    gate.resolve();
    expect((await fileReq).status).toBe(200);
    expect(await jobRows(pool)).toEqual([]);
  });
});
