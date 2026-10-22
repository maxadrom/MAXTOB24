// M11.2/M22 smoke: outbound медиа Open Lines → MAX. POST /webhook/b24
// (ONIMCONNECTORMESSAGEADD с message.files[]) → routeOutbound → b24 downloadFile (мок
// fetch, настоящий Response) во временный файл → MAX upload-флоу (/uploads → заливка
// потоком на локальный приёмник → /messages с attachments) → recordOutbound (реальный pg)
// по файлу и по сообщению. Зеркало outbound.smoke.test.js.
//
// DB-gated: describe.skipIf(shouldSkipDb()).

import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { parseSingleMultipart, startUploadServer } from './helpers/uploadServer.js';

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
const APP_TOKEN = 'test-app-token-media-out';
const MAX_API = 'https://botapi.max.ru';

function buildTestConfig({ tmpDir, maxBytes = 256 * 1024 * 1024 }) {
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
      maxBytes,
      transferTimeoutMs: 5_000,
      concurrency: 2,
      tmpDir,
    },
    optional: {},
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// Роутинг fetch: download(/pub/im.file.php?FILE_ID=n) → n-й файл; MAX /uploads → url локального
// приёмника заливки (M22: заливка идёт node:http.request, не fetch; M28: uploadUrl —
// строка или функция от type заливки); MAX POST /messages → mid по счётчику; MAX DELETE
// /messages → success; Б24 REST → im.message.add / delivery.
function makeFetchMock({ uploadUrl, files }) {
  let sent = 0;
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/pub/im.file.php')) {
      const id = new URL(u).searchParams.get('FILE_ID');
      return binaryResponse(files[id] ?? [1, 2, 3, 4], { contentType: 'image/jpeg' });
    }
    if (u.startsWith(MAX_API) && u.includes('/uploads')) {
      const type = new URL(u).searchParams.get('type');
      return jsonResponse({ url: typeof uploadUrl === 'function' ? uploadUrl(type) : uploadUrl });
    }
    if (u.startsWith(MAX_API) && u.includes('/messages')) {
      if (opts.method === 'DELETE') return jsonResponse({ success: true });
      sent += 1;
      return jsonResponse({ message: { body: { mid: `mid.media-out-${sent}` }, timestamp: 1748432100000 } });
    }
    if (u.includes('/rest/im.message.add')) return jsonResponse({ result: 777 });
    return jsonResponse({ result: { SUCCESS: true, DATA: [], time: {} }, time: {} });
  };
}

function file(n, extra = {}) {
  return {
    name: `photo${n}.jpg`,
    type: 'image',
    mime: 'image/jpeg',
    link: `https://${PORTAL}/disk/${n}`,
    downloadLink: `https://${PORTAL}/pub/im.file.php?FILE_ID=${n}&SIGN=x&img=y`,
    size: 4,
    sizef: '4 B',
    ...extra,
  };
}

function outboundMediaBody(messageId, { text = '[b]Оператор:[/b] [br]photo1.jpg', files = [file(1)] } = {}) {
  return {
    event: 'ONIMCONNECTORMESSAGEADD',
    auth: { application_token: APP_TOKEN, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: String(messageId) },
          message: { user_id: '1', text, files },
          chat: { id: `max:${MAX_CHAT_ID}` },
        },
      ],
    },
  };
}

// Удаление оператором: message.id приходит строкой (live M15).
function deleteBody(messageId, externalId) {
  return {
    event: 'ONIMCONNECTORMESSAGEDELETE',
    auth: { application_token: APP_TOKEN, domain: PORTAL, user_id: '1' },
    data: {
      CONNECTOR: CONNECTOR_ID,
      LINE: String(OL_LINE_ID),
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: String(messageId) },
          message: { id: externalId },
          chat: { id: `max:${MAX_CHAT_ID}` },
        },
      ],
    },
  };
}

async function outboundKeys(pool, b24MsgId) {
  const { rows } = await pool.query(
    `SELECT b24_msg_id FROM message_log
      WHERE direction = 'outbound' AND (b24_msg_id = $1 OR b24_msg_id LIKE 'file:' || $1 || ':%')
      ORDER BY id`,
    [String(b24MsgId)],
  );
  return rows.map((r) => r.b24_msg_id);
}

function maxSendCalls(fetchSpy) {
  return fetchSpy.mock.calls.filter(
    ([u, o]) => String(u).startsWith(MAX_API) && String(u).includes('/messages') && o?.method === 'POST',
  );
}

// M28: MAX POST /messages — текст длиннее 4000 → живая форма отказа (live 2026-10-09, PUT /messages).
function rejectLongMaxText(fetchSpy) {
  const base = fetchSpy.getMockImplementation();
  fetchSpy.mockImplementation(async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(MAX_API) && u.includes('/messages') && opts.method === 'POST') {
      const { text = '' } = JSON.parse(opts.body);
      if (text.length > 4000) {
        return jsonResponse({ code: 'proto.payload', message: `Field 'text' size (${text.length}) must be at most 4000` }, 400);
      }
    }
    return base(url, opts);
  });
}
// «**Оператор:**\n» (14) + 4100 = 4114 символов в MAX.
const LONG_CAPTION = `[b]Оператор:[/b] [br]${'я'.repeat(4100)}`;
const LONG_REASON = 'текст слишком длинный (4114 символов при лимите MAX 4000)';

describe.skipIf(shouldSkipDb())('outbound media smoke (b24 files → MAX upload)', () => {
  let pool;
  let app;
  let fetchSpy;
  let server;
  let tmpDir;

  async function setup({ files = {}, maxBytes, uploadUrl = server.url('/upload?sig=zzz') } = {}) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeFetchMock({ uploadUrl, files }));
    app = buildApp(buildTestConfig({ tmpDir, maxBytes }), { pool, logger: pino({ level: 'silent' }) });
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
    await bindings.ensureForMaxChat(MAX_CHAT_ID, { maxChatTitle: 'Группа Север' });

    // Заливка image отдаёт {photos} (live: токена нет).
    server = await startUploadServer(() => ({ status: 200, body: { photos: { p0: { token: 'tok-abc' } } } }));
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm22-smoke-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) файл оператора → download во временный файл + заливка потоком + /messages с attachments', async () => {
    await setup();
    const res = await postWebhook(app, outboundMediaBody('1500001'));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({
      ok: true,
      b24MsgId: '1500001',
      maxMid: 'mid.media-out-1',
      maxMids: ['mid.media-out-1'],
    });

    const calls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes('/pub/im.file.php'))).toBe(true);
    expect(calls.some((u) => u.includes('/uploads'))).toBe(true);
    // заливка бинаря — на выданный upload-url (локальный приёмник), тело — файл целиком
    expect(server.requests).toHaveLength(1);
    const part = parseSingleMultipart(server.requests[0]);
    expect(part.name).toBe('data');
    expect(part.filename).toBe('photo1.jpg');
    expect([...part.data]).toEqual([1, 2, 3, 4]);

    // MAX /messages вызван с attachments (filename-ярлык подавлён → без text)
    const [maxSend] = maxSendCalls(fetchSpy);
    const body = JSON.parse(maxSend[1].body);
    expect(body.attachments[0].type).toBe('image');
    expect(body).not.toHaveProperty('text');

    expect(await outboundKeys(pool, '1500001')).toEqual(['file:1500001:0', '1500001']);
    // временный файл удалён
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('2) реальный комментарий → caption уходит подписью к файлу (body.text)', async () => {
    await setup();
    const res = await postWebhook(app, outboundMediaBody('1500002', { text: '[b]Оператор:[/b] [br]посмотри' }));

    expect(res.status).toBe(200);
    const [maxSend] = maxSendCalls(fetchSpy);
    const body = JSON.parse(maxSend[1].body);
    expect(body.text).toBe('**Оператор:**\nпосмотри');
    expect(body.attachments).toBeDefined();
  });

  it('3) дубль того же message_id → skipped:duplicate, повторной заливки нет', async () => {
    await setup();
    const body = outboundMediaBody('1500003-dup');

    const first = await postWebhook(app, body);
    expect(first.body.result.results[0]).toMatchObject({ ok: true });

    const second = await postWebhook(app, body);
    expect(second.body.result.results[0]).toMatchObject({ skipped: 'duplicate' });

    expect(server.requests).toHaveLength(1);
    expect(await outboundKeys(pool, '1500003-dup')).toEqual(['file:1500003-dup:0', '1500003-dup']);
  });

  it('4) M22: три файла, второй не залился → 200, первый и третий в MAX, оператору системное сообщение', async () => {
    await setup();
    server.setHandler((req) => (
      parseSingleMultipart(req).filename === 'photo2.jpg'
        ? { status: 500, body: { code: 'internal', message: 'oops' } }
        : { status: 200, body: { photos: { p0: { token: 'tok-abc' } } } }
    ));

    const res = await postWebhook(app, outboundMediaBody('1500004', { text: '', files: [file(1), file(2), file(3)] }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({
      ok: true,
      maxMids: ['mid.media-out-1', 'mid.media-out-2'],
      failedFiles: 1,
    });
    expect(await outboundKeys(pool, '1500004')).toEqual(['file:1500004:0', 'file:1500004:2', '1500004']);

    const notify = fetchSpy.mock.calls.find(([u]) => String(u).includes('/rest/im.message.add'));
    expect(notify).toBeDefined();
    const form = new URLSearchParams(notify[1].body);
    expect(form.get('DIALOG_ID')).toBe('chat21186');
    expect(form.get('SYSTEM')).toBe('Y');
    expect(form.get('MESSAGE')).toBe('⚠️ Не доставлено в MAX: файл «photo2.jpg» — MAX не принял (internal). Отправьте ещё раз.');
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('5) M22: удаление сообщения из нескольких файлов стирает в MAX все файлы', async () => {
    await setup();
    await postWebhook(app, outboundMediaBody('1500005', { text: '', files: [file(1), file(2), file(3)] }));

    const res = await postWebhook(app, deleteBody('1500005', 'mid.media-out-1'));

    expect(res.status).toBe(200);
    const deleted = fetchSpy.mock.calls
      .filter(([u, o]) => String(u).startsWith(MAX_API) && o?.method === 'DELETE')
      .map(([u]) => new URL(String(u)).searchParams.get('message_id'));
    expect(deleted).toEqual(['mid.media-out-1', 'mid.media-out-2', 'mid.media-out-3']);
  });

  it('6) M22: файл больше MEDIA_MAX_BYTES по Content-Length → не заливается, 200 + оповещение', async () => {
    await setup({ maxBytes: 3, files: { 1: [1, 2, 3, 4, 5] } });

    const res = await postWebhook(app, outboundMediaBody('1500006', { text: '', files: [file(1, { size: undefined, sizef: undefined })] }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(server.requests).toHaveLength(0);
    expect(await outboundKeys(pool, '1500006')).toEqual([]);
    const notify = fetchSpy.mock.calls.find(([u]) => String(u).includes('/rest/im.message.add'));
    expect(new URLSearchParams(notify[1].body).get('MESSAGE')).toBe(
      '⚠️ Не доставлено в MAX: файл «photo1.jpg» — больше 1 КиБ. Загрузите на диск и отправьте как ссылку.',
    );
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('7a) M28: подпись длиннее лимита MAX (400 proto.payload) → без перезаливки файлом, оповещение «текст слишком длинный»', async () => {
    await setup();
    rejectLongMaxText(fetchSpy);

    const res = await postWebhook(app, outboundMediaBody('1500071', { text: LONG_CAPTION }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ skipped: 'delivery-failed' });
    // Заливка одна (image) — перезаливки файлом нет: файлом ушла бы та же подпись.
    const calls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(calls.filter((u) => u.includes('/uploads')).map((u) => new URL(u).searchParams.get('type'))).toEqual(['image']);
    expect(server.requests).toHaveLength(1);
    // Отправки две: файл с подписью, затем подпись текстом — обе отвергнуты.
    expect(maxSendCalls(fetchSpy)).toHaveLength(2);
    expect(await outboundKeys(pool, '1500071')).toEqual([]);

    const notify = fetchSpy.mock.calls.find(([u]) => String(u).includes('/rest/im.message.add'));
    expect(new URLSearchParams(notify[1].body).get('MESSAGE')).toBe(
      `⚠️ Не доставлено в MAX: ${LONG_REASON} — файл «photo1.jpg» и подпись. `
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('7a2) M30: длинная подпись к двум файлам → MAX отверг оба и подпись, в оповещении причина один раз', async () => {
    await setup();
    rejectLongMaxText(fetchSpy);

    const res = await postWebhook(app, outboundMediaBody('1500072', {
      text: LONG_CAPTION,
      files: [file(1), file(2)],
    }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ skipped: 'delivery-failed' });
    // Подпись идёт с каждым файлом, пока ни один не доставлен, затем — текстом: три отказа.
    expect(maxSendCalls(fetchSpy)).toHaveLength(3);
    expect(await outboundKeys(pool, '1500072')).toEqual([]);

    const notify = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/rest/im.message.add'));
    expect(notify).toHaveLength(1);
    expect(new URLSearchParams(notify[0][1].body).get('MESSAGE')).toBe(
      `⚠️ Не доставлено в MAX: ${LONG_REASON} — файлы «photo1.jpg», «photo2.jpg» и подпись. `
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('7) M28: MAX отверг картинку (200 + error_data, без photos) → тот же файл перезалит как file, без оповещения', async () => {
    // Живая форма отказа (live 2026-10-08, PNG 1×1): HTTP 200 заливки, код — в error_data.
    await setup({ uploadUrl: (type) => server.url(type === 'image' ? '/img' : '/file') });
    server.setHandler((req) => (
      req.url === '/img'
        ? { status: 200, body: { error_code: '503', error_data: 'IMAGE_INVALID_FORMAT' } }
        : { status: 200, body: { fileId: 1, token: 'tok-file' } }
    ));

    const res = await postWebhook(app, outboundMediaBody('1500007', { text: '' }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.media-out-1', maxMids: ['mid.media-out-1'] });

    // Скачивание из Б24 одно; заливок две — тот же файл, сначала как image, потом как file.
    const calls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(calls.filter((u) => u.includes('/pub/im.file.php'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/uploads')).map((u) => new URL(u).searchParams.get('type')))
      .toEqual(['image', 'file']);
    expect(server.requests.map((r) => r.url)).toEqual(['/img', '/file']);
    expect(server.requests.map((r) => [...parseSingleMultipart(r).data])).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);

    // В MAX — одно сообщение, уже файлом.
    const sends = maxSendCalls(fetchSpy);
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0][1].body).attachments).toEqual([{ type: 'file', payload: { token: 'tok-file' } }]);

    expect(await outboundKeys(pool, '1500007')).toEqual(['file:1500007:0', '1500007']);
    const { rows } = await pool.query(
      `SELECT b24_msg_id, payload_meta FROM message_log WHERE direction = 'outbound' AND b24_msg_id LIKE '%1500007%' ORDER BY id`,
    );
    expect(rows[0].payload_meta).toMatchObject({ type: 'file', fallbackFrom: 'image', mime: 'image/jpeg' });
    expect(rows[1].payload_meta).toMatchObject({ kinds: ['file'] });

    expect(calls.some((u) => u.includes('/rest/im.message.add'))).toBe(false);
    expect(await readdir(tmpDir)).toEqual([]);
  });
});
