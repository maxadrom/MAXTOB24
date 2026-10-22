// M29 smoke: остановка с дренажом через настоящий buildApp, http.Server (app.listen на порту 0)
// и pg. Файл висит на POST /messages в MAX (gate) → shutdown('SIGTERM'): порт открыт, новый
// запрос (текст в другой чат) обслуживается и доставляется; пул жив, exit не зван. Gate
// отпущен → первый запрос 200, запись и никаких строк job:, порт закрыт, пул закрыт, exit(0).
// Вариант с коротким дедлайном: exit(1) по жёсткому таймеру, строка job: ещё in_progress (её
// разберёт следующий старт). Сигнал, пока запрос ещё в claim (очередь пуста): порт открыт, пока
// запрос не ответит.
//
// Пул приложения — отдельный buildPool: shutdown зовёт pool.end(). Фикстуры и очистка — через
// общий тестовый пул. Запросы — supertest по порту сервера через keep-alive агент (supertest
// по умолчанию шлёт без пула соединений): так проверяется «Connection: close» после сигнала и
// то, что закрытие порта не ждёт keepAliveTimeout простаивающего соединения.
//
// DB-gated: describe.skipIf(shouldSkipDb()).

import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config/index.js';
import { buildPool } from '../src/shared/db/pool.js';
import { createGracefulShutdown } from '../src/shared/lifecycle/gracefulShutdown.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../src/modules/bindings/participantMapRepository.js';
import { BindingsService } from '../src/modules/bindings/bindingsService.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';
import { encodeForm } from './helpers/form.js';
import { binaryResponse } from './helpers/http.js';
import { startUploadServer } from './helpers/uploadServer.js';

const PORTAL = 'example.bitrix24.ru';
const CHAT_A = '-70000000000964';
const CHAT_B = '-70000000000965';
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const APP_TOKEN = 'test-app-token-shutdown';
const MAX_API = 'https://botapi.max.ru';

function buildTestConfig({ tmpDir }) {
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
    outbound: { queueMax: 20 },
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

function spyLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log.child = () => log;
  return log;
}

// fetch: скачивание файла оператора, MAX /uploads → локальный приёмник, MAX POST /messages
// (с вложением — ждёт gate), Б24 REST. posts — POST /messages по порядку.
function makeFetchMock({ uploadUrl }) {
  const posts = [];
  const gate = deferred();
  let n = 0;
  return {
    posts,
    gate,
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/pub/im.file.php')) return binaryResponse([1, 2, 3, 4], { contentType: 'image/jpeg' });
      if (u.startsWith(MAX_API) && u.includes('/uploads')) return jsonResponse({ url: uploadUrl });
      if (u.startsWith(MAX_API) && u.includes('/messages')) {
        const chatId = new URL(u).searchParams.get('chat_id');
        const body = JSON.parse(opts.body);
        n += 1;
        const mid = `mid.sd-${n}`;
        if (body.attachments) {
          posts.push({ kind: 'file-start', chatId });
          await gate.promise;
          posts.push({ kind: 'file', chatId, mid });
        } else {
          posts.push({ kind: 'text', chatId, mid });
        }
        return jsonResponse({ message: { body: { mid }, timestamp: 1748432100000 } });
      }
      if (u.includes('/rest/im.message.add')) return jsonResponse({ result: 777 });
      return jsonResponse({ result: { SUCCESS: true, DATA: [], time: {} }, time: {} });
    },
  };
}

function addBody(messageId, { chat = CHAT_A, text = '[b]Оператор:[/b] [br]photo1.jpg', withFile = false } = {}) {
  const message = { user_id: '1', text };
  if (withFile) {
    message.files = [{
      name: 'photo1.jpg',
      type: 'image',
      mime: 'image/jpeg',
      link: `https://${PORTAL}/disk/1`,
      downloadLink: `https://${PORTAL}/pub/im.file.php?FILE_ID=1&SIGN=x&img=y`,
      size: 4,
      sizef: '4 B',
    }];
  }
  return {
    event: 'ONIMCONNECTORMESSAGEADD',
    auth: { application_token: APP_TOKEN, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [{
        im: { chat_id: chat === CHAT_A ? '21196' : '21197', message_id: String(messageId) },
        message,
        chat: { id: `max:${chat}` },
      }],
    },
  };
}

// supertest по порту уже слушающего сервера, keep-alive агент; .then — запрос уходит сразу.
function post(server, agent, body) {
  return request(server)
    .post('/webhook/b24')
    .agent(agent)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(body))
    .then((res) => res);
}

async function jobRows(pool) {
  const { rows } = await pool.query(
    `SELECT b24_msg_id, status FROM message_log WHERE b24_msg_id LIKE 'job:%' ORDER BY id`,
  );
  return rows;
}

async function outboundKeys(pool) {
  const { rows } = await pool.query(
    `SELECT b24_msg_id FROM message_log WHERE direction = 'outbound' AND status <> 'in_progress' ORDER BY id`,
  );
  return rows.map((r) => r.b24_msg_id);
}

// Соединение с закрытым портом: → код ошибки (ECONNREFUSED) или статус, если порт открыт.
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ port, host: '127.0.0.1', path: '/health', agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (err) => resolve(err.code));
  });
}

describe.skipIf(shouldSkipDb())('shutdown drain smoke (остановка дожидается очереди исходящих)', () => {
  let pool;
  let appPool;
  let app;
  let server;
  let mock;
  let uploads;
  let tmpDir;
  let exit;
  let log;
  let agent;

  async function start({ drainTimeoutMs = 10_000, closeTimeoutMs = 2_000 } = {}) {
    mock = makeFetchMock({ uploadUrl: uploads.url('/upload?sig=sd') });
    vi.spyOn(globalThis, 'fetch').mockImplementation(mock.fetch);
    appPool = buildPool(loadConfig(), null);
    app = buildApp(buildTestConfig({ tmpDir }), { pool: appPool, logger: pino({ level: 'silent' }) });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    exit = vi.fn();
    log = spyLogger();
    agent = new http.Agent({ keepAlive: true });
    return createGracefulShutdown({
      server,
      queue: app.locals.outbound.queue,
      pool: appPool,
      logger: log,
      drainTimeoutMs,
      closeTimeoutMs,
      idleSweepMs: 100,
      exit,
    });
  }

  function fileStarted() {
    return vi.waitFor(() => {
      expect(mock.posts.filter((p) => p.kind === 'file-start')).toHaveLength(1);
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

    uploads = await startUploadServer(() => ({ status: 200, body: { photos: { p0: { token: 'tok-sd' } } } }));
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm29-shutdown-smoke-'));
  });

  afterEach(async () => {
    // Задания дописывают в БД после ответа MAX: дождаться их ДО очистки следующего теста.
    mock?.gate.resolve();
    await app?.locals.outbound.queue.whenIdle();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (appPool && !appPool.ending) await appPool.end();
    agent?.destroy();
    vi.restoreAllMocks();
    await uploads.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) SIGTERM во время заливки: порт открыт, новый запрос обслужен; после заливки — 200, порт и пул закрыты, exit(0)', async () => {
    const shutdown = await start();
    const { port } = server.address();

    // до сигнала соединения keep-alive; это соединение останется простаивать в пуле агента
    const before = await request(server).get('/health').agent(agent);
    expect(before.headers.connection).toBe('keep-alive');

    const fileReq = post(server, agent, addBody('1700001', { withFile: true }));
    await fileStarted();

    const done = shutdown('SIGTERM');

    // Пока файл висит — порт открыт: текст в другой чат принят, доставлен, ответ 200.
    const other = await post(server, agent, addBody('1700002', { chat: CHAT_B, text: 'во время дренажа' }));
    expect(other.status).toBe(200);
    expect(other.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1700002' });
    // после сигнала ответы — без keep-alive
    expect(other.headers.connection).toBe('close');
    expect(mock.posts.map((p) => `${p.kind}:${p.chatId}`)).toEqual([`file-start:${CHAT_A}`, `text:${CHAT_B}`]);
    const health = await request(server).get('/health').agent(agent);
    expect(health.status).toBe(200);
    expect(health.headers.connection).toBe('close');

    expect(server.listening).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect((await appPool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    expect((await jobRows(pool)).map((r) => r.b24_msg_id)).toEqual(['job:1700001']);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM', pending: 1 }),
      'shutdown requested: draining outbound queue (still listening)',
    );

    mock.gate.resolve();
    const fileRes = await fileReq;
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.result.results[0]).toMatchObject({ ok: true, b24MsgId: '1700001', maxMids: ['mid.sd-1'] });
    // ответ, ждавший очереди во время сигнала, тоже закрывает соединение
    expect(fileRes.headers.connection).toBe('close');

    // закрытие не ждёт keepAliveTimeout (5 с) простаивающих соединений
    const closeStarted = Date.now();
    await done;
    expect(Date.now() - closeStarted).toBeLessThan(2_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.listening).toBe(false);
    expect(appPool.ended).toBe(true);
    expect(await probePort(port)).toBe('ECONNREFUSED');

    expect(await outboundKeys(pool)).toEqual(expect.arrayContaining(['file:1700001:0', '1700001', '1700002']));
    expect(await jobRows(pool)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map((c) => c.at(-1))).toEqual(expect.arrayContaining([
      'outbound queue drained',
      'http server closed',
      'pg pool closed',
      'shutdown complete',
    ]));
  });

  it('3) SIGTERM, пока запрос ещё в claim (очередь пуста): порт открыт, пока запрос не ответит; задание этого запроса тоже дожидается', async () => {
    const shutdown = await start();
    // claim (INSERT строки job:) ждёт claimGate: запрос принят, а в очереди ещё ничего нет
    const claimGate = deferred();
    let claimHeld = false;
    const query = appPool.query.bind(appPool);
    appPool.query = async (...args) => {
      const sql = String(args[0]);
      if (sql.includes('INSERT') && sql.includes("'in_progress'")) {
        claimHeld = true;
        await claimGate.promise;
      }
      return query(...args);
    };

    const fileReq = post(server, agent, addBody('1700020', { withFile: true }));
    await vi.waitFor(() => expect(claimHeld).toBe(true), { timeout: 3_000 });
    expect(app.locals.outbound.queue.size).toBe(0);

    const done = shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // очередь пуста, но запрос в работе — порт не закрыт
    expect(server.listening).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM', pending: 0, requests: 1 }),
      'shutdown requested: draining outbound queue (still listening)',
    );

    // claim завершился → задание в очереди, файл льётся; порт всё ещё открыт
    claimGate.resolve();
    await fileStarted();
    const other = await post(server, agent, addBody('1700021', { chat: CHAT_B, text: 'во время заливки' }));
    expect(other.status).toBe(200);
    expect(server.listening).toBe(true);

    mock.gate.resolve();
    expect((await fileReq).status).toBe(200);
    await done;
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.listening).toBe(false);
    expect(await outboundKeys(pool)).toEqual(expect.arrayContaining(['file:1700020:0', '1700020', '1700021']));
    expect(await jobRows(pool)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('2) дедлайн дренажа: exit(1) один раз, строка job: остаётся in_progress до следующего старта', async () => {
    const shutdown = await start({ drainTimeoutMs: 50, closeTimeoutMs: 50 });

    const fileReq = post(server, agent, addBody('1700010', { withFile: true }));
    await fileStarted();

    const done = shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 3_000 });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledWith(
      { pending: 1, requests: 1, drainTimeoutMs: 50 },
      'drain timeout: interrupted jobs will be reported on next start',
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 100 }),
      'graceful shutdown timeout — force exit',
    );
    // процесс в проде здесь уже вышел: строка задания осталась для восстановления на старте
    expect(await jobRows(pool)).toEqual([{ b24_msg_id: 'job:1700010', status: 'in_progress' }]);

    // в тесте процесс жив: отпустить заливку и дождаться конца, exit больше не зовётся
    mock.gate.resolve();
    expect((await fileReq).status).toBe(200);
    await done;
    await app.locals.outbound.queue.whenIdle();
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
