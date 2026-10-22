// M29 smoke: разбор передач, прерванных прошлым процессом, через настоящий buildApp и pg.
// В message_log руками кладутся строка задания job:<id> (status 'in_progress', как от
// упавшего процесса) и запись ушедшего файла file:<id>:0; app.locals.outbound.
// recoverInterrupted дописывает итоговую запись, шлёт статус доставки и системное
// сообщение оператору (im.message.add SYSTEM=Y, без REPLY_ID), снимает строку. Строка,
// созданная после отметки старта, — задание нового процесса: её не трогает.
//
// DB-gated: describe.skipIf(shouldSkipDb()).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const CONNECTOR_CHAT_ID = `max:${MAX_CHAT_ID}`;
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const APP_TOKEN = 'test-app-token-recovery';
const MAX_API = 'https://botapi.max.ru';

function buildTestConfig() {
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
    optional: {},
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function fetchMock(url, opts = {}) {
  const u = String(url);
  if (u.startsWith(MAX_API) && u.includes('/messages') && opts.method === 'DELETE') {
    return Promise.resolve(jsonResponse({ success: true }));
  }
  if (u.includes('/rest/im.message.add')) return Promise.resolve(jsonResponse({ result: 777 }));
  return Promise.resolve(jsonResponse({ result: { SUCCESS: true, DATA: [], time: {} }, time: {} }));
}

function b24Calls(fetchSpy, method) {
  return fetchSpy.mock.calls
    .filter(([u]) => String(u).includes(`/rest/${method}`))
    .map(([, o]) => new URLSearchParams(o.body));
}

describe.skipIf(shouldSkipDb())('outbound recovery smoke (прерванные передачи на старте)', () => {
  let pool;
  let app;
  let fetchSpy;
  let bindingId;

  // Строка в message_log с created_at «ago» назад от часов Postgres (отрицательное — в будущем).
  async function insertRow(b24MsgId, { status = 'received', payloadMeta, agoSeconds = 0 }) {
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, status, payload_meta, created_at)
       VALUES ($1, 'outbound', $2, $3, $4, now() - make_interval(secs => $5))`,
      [bindingId, b24MsgId, status, JSON.stringify(payloadMeta), agoSeconds],
    );
  }

  async function row(b24MsgId) {
    const { rows } = await pool.query(
      `SELECT b24_msg_id, status, payload_meta FROM message_log WHERE b24_msg_id = $1`,
      [b24MsgId],
    );
    return rows[0] ?? null;
  }

  function jobMeta(b24MsgId, extra) {
    return {
      kind: 'job',
      op: 'add',
      opKey: b24MsgId,
      connectorChatId: CONNECTOR_CHAT_ID,
      b24ChatId: '21186',
      b24MsgId,
      textPrefix: '',
      hasText: false,
      ...extra,
    };
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
    const { binding } = await bindings.ensureForMaxChat(MAX_CHAT_ID, { maxChatTitle: 'Группа Север' });
    bindingId = binding.id;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(async () => {
    await app?.locals.outbound.queue.whenIdle();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) файл 0 из двух ушёл → итоговая запись, статус доставки, оповещение «файл «b.jpg» — мост перезапускался» без REPLY_ID; новая строка не тронута', async () => {
    await insertRow('job:1700001', {
      status: 'in_progress',
      payloadMeta: jobMeta('1700001', { filesCount: 2, fileNames: ['a.jpg', 'b.jpg'] }),
      agoSeconds: 60,
    });
    await insertRow('file:1700001:0', {
      payloadMeta: { kind: 'file', origB24MsgId: '1700001', idx: 0, maxMid: 'mid.part-0', type: 'image', withCaption: false },
      agoSeconds: 59,
    });
    // Задание нового процесса: создано после отметки старта.
    await insertRow('job:1700002', {
      status: 'in_progress',
      payloadMeta: jobMeta('1700002', { hasText: true, filesCount: 0, fileNames: [] }),
    });
    const { rows: [{ mark }] } = await pool.query(`SELECT now() - interval '30 seconds' AS mark`);

    const res = await app.locals.outbound.recoverInterrupted({ createdBefore: mark });

    expect(res).toMatchObject({ total: 1, notified: 1, failedNotify: 0, failed: 0 });

    const notices = b24Calls(fetchSpy, 'im.message.add');
    expect(notices).toHaveLength(1);
    expect(notices[0].get('DIALOG_ID')).toBe('chat21186');
    expect(notices[0].get('SYSTEM')).toBe('Y');
    expect(notices[0].get('MESSAGE')).toBe(
      '⚠️ Не доставлено в MAX: файл «b.jpg» — мост перезапускался. Отправьте ещё раз.',
    );
    expect(notices[0].has('REPLY_ID')).toBe(false);

    const delivery = b24Calls(fetchSpy, 'imconnector.send.status.delivery');
    expect(delivery).toHaveLength(1);
    expect(delivery[0].get('MESSAGES[0][im][message_id]')).toBe('1700001');

    const record = await row('1700001');
    expect(record).toMatchObject({
      status: 'received',
      payload_meta: { maxMid: 'mid.part-0', maxMids: ['mid.part-0'], filesCount: 1, failedCount: 1, interrupted: true },
    });
    // Время отправки — от записи ушедшей части, а не от момента разбора (возраст в «MAX не
    // разрешил удалить» после простоя).
    const { rows: [part] } = await pool.query(
      `SELECT created_at FROM message_log WHERE b24_msg_id = 'file:1700001:0'`,
    );
    expect(record.payload_meta.sentAt).toBe(part.created_at.toISOString());
    expect(await row('job:1700001')).toBeNull();
    expect(await row('job:1700002')).toMatchObject({ status: 'in_progress' });

    // Повторный разбор: строка снята — оповещения второй раз нет.
    const again = await app.locals.outbound.recoverInterrupted({ createdBefore: mark });
    expect(again).toMatchObject({ total: 0 });
    expect(b24Calls(fetchSpy, 'im.message.add')).toHaveLength(1);
  });

  it('2) прерваны отправка (ушёл файл 0) и удаление того же сообщения → файл удалён в MAX, оповещений нет', async () => {
    await insertRow('job:1700010', {
      status: 'in_progress',
      payloadMeta: jobMeta('1700010', { filesCount: 2, fileNames: ['a.jpg', 'b.jpg'] }),
      agoSeconds: 60,
    });
    await insertRow('file:1700010:0', {
      payloadMeta: { kind: 'file', origB24MsgId: '1700010', idx: 0, maxMid: 'mid.part-10', type: 'image', withCaption: false },
      agoSeconds: 59,
    });
    await insertRow('job:delete:1700010', {
      status: 'in_progress',
      payloadMeta: { ...jobMeta('1700010'), op: 'delete', opKey: 'delete:1700010' },
      agoSeconds: 58,
    });

    const res = await app.locals.outbound.recoverInterrupted({ createdBefore: new Date(Date.now() + 60_000) });

    expect(res).toMatchObject({ total: 2, completed: 2, notified: 0 });
    const deletes = fetchSpy.mock.calls
      .filter(([u, o]) => String(u).startsWith(MAX_API) && o?.method === 'DELETE')
      .map(([u]) => new URL(String(u)).searchParams.get('message_id'));
    expect(deletes).toEqual(['mid.part-10']);
    expect(b24Calls(fetchSpy, 'im.message.add')).toHaveLength(0);
    expect(b24Calls(fetchSpy, 'imconnector.send.status.delivery')).toHaveLength(0);
    expect(await row('delete:1700010')).not.toBeNull();
    const { rows } = await pool.query(`SELECT id FROM message_log WHERE status = 'in_progress'`);
    expect(rows).toEqual([]);
  });
});
