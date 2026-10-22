// Smoke M25: «группа» открывает каждую новую сессию OL.
// Новая группа → POST /webhook/max (интро + сообщение, сессия запомнена) → POST /webhook/b24
// ONIMCONNECTORDIALOGFINISH (флаг опенера) → следующее входящее: GET /chats/{id} → опенер от
// «группы» → сообщение автора (флаг снят, новая сессия запомнена). Устаревший и чужой Finish
// флаг не взводят. M27: Finish потерян — переименование группы при закрытой сессии
// (CHAT_RENAMING_FAILED, поле 6 entity_data_1 = 0) взводит флаг; у старой привязки без
// ol_session_id — флаг 0. Ссылка на группу (M27): опенер постит её системным сообщением,
// только если MAX её перевыпустил. MAX и Б24 — один мок globalThis.fetch с роутингом по URL.
//
// DB-gated: describe.skipIf(shouldSkipDb()) + truncateAll(pool).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';
import { encodeForm } from './helpers/form.js';

const PORTAL = 'example.bitrix24.ru';
const MAX_CHAT_ID = '-70000000000218';
const CONNECTOR_CHAT_ID = `max:${MAX_CHAT_ID}`;
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const AUTHOR_ID = 1000001;
const WEBHOOK_SECRET = 'test-max-secret-1234567890';
const APP_TOKEN = 'test-app-token-m25';
const ICON = 'https://i.oneme.ru/i?r=ICONTEST';
const TITLE = 'Тестовая группа';

function buildTestConfig() {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test' },
    log: { level: 'silent' },
    max: {
      botToken: 'test-bot-token',
      webhookSecret: WEBHOOK_SECRET,
      apiBaseUrl: 'https://platform-api2.max.ru',
      publicWebhookUrl: null,
      webhookUpdateTypes: ['message_created', 'chat_title_changed'],
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Роутер fetch по URL. state.sessionId — session.ID в ответе send.messages; state.calls —
// метки вызовов по порядку; state.bodies — тела B24-вызовов по методу. M27: state.renameFails —
// chat.name.set → 400 CHAT_RENAMING_FAILED; state.olChat — ответ imopenlines.dialog.get
// (null → ACCESS_ERROR); state.link — Chat.link в GET /chats.
function fetchRouter(state) {
  return vi.fn(async (input, init) => {
    const url = String(input);
    const b24 = url.match(/\/rest\/([a-z.]+)\.json/);
    if (b24) {
      const method = b24[1];
      state.calls.push(method);
      (state.bodies[method] ??= []).push(new URLSearchParams(init?.body ?? ''));
      if (method === 'imconnector.send.messages') {
        return json({
          result: {
            SUCCESS: true,
            DATA: { RESULT: [{ SUCCESS: true, session: { ID: state.sessionId, CHAT_ID: '21180' } }] },
          },
          time: {},
        });
      }
      if (method === 'imconnector.chat.name.set') {
        return state.renameFails
          ? json({ error: 'CHAT_RENAMING_FAILED', error_description: 'Chat renaming failed' }, 400)
          : json({ result: { SUCCESS: true, DATA: { RESULT: {} } }, time: {} });
      }
      if (method === 'imopenlines.dialog.get') {
        return state.olChat
          ? json({ result: state.olChat, time: {} })
          : json({ error: 'ACCESS_ERROR', error_description: 'no chat' }, 400);
      }
      if (method === 'im.message.add') return json({ result: 777, time: {} });
      throw new Error(`unexpected B24 method ${method}`);
    }
    if (url.includes(`/chats/${MAX_CHAT_ID}/members`)) {
      state.calls.push('max members');
      return json({ members: [] });
    }
    if (url.endsWith(`/chats/${MAX_CHAT_ID}`)) {
      state.calls.push('max chat');
      return json({
        chat_id: Number(MAX_CHAT_ID),
        type: 'chat',
        title: TITLE,
        icon: { url: ICON },
        ...(state.link ? { link: state.link } : {}),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function messageCreatedBody(mid, text = 'Добрый день') {
  return {
    update_type: 'message_created',
    timestamp: 1700000000000,
    message: {
      recipient: { chat_id: Number(MAX_CHAT_ID), chat_type: 'chat' },
      body: { mid, text },
      sender: { user_id: AUTHOR_ID, name: 'Олег Смирнов' },
    },
  };
}

function titleChangedBody(title, timestamp = 1700000100000) {
  return {
    update_type: 'chat_title_changed',
    timestamp,
    chat_id: Number(MAX_CHAT_ID),
    user: { user_id: AUTHOR_ID, first_name: 'Олег' },
    title,
  };
}

// Форма события по доке OnImConnectorDialogFinish (b24-dev-mcp, 2026-10-07); live (2026-10-08):
// connector.chat_id и chat.id — оба внешний id 'max:<chatId>'. chatId: null — поля нет.
function dialogFinishBody({ chatId = CONNECTOR_CHAT_ID, chatIdField = chatId, sessionId, connector = CONNECTOR_ID } = {}) {
  return {
    event: 'ONIMCONNECTORDIALOGFINISH',
    event_id: '1',
    data: {
      CONNECTOR: connector,
      LINE: String(OL_LINE_ID),
      DATA: [{
        connector: { connector_id: connector, line_id: String(OL_LINE_ID), chat_id: chatId, user_id: '0' },
        session: { id: String(sessionId), closed: 'Y', parent_id: '0', close_term: '10' },
        chat: { id: chatIdField },
        user: { id: '0' },
      }],
    },
    ts: '1714649632',
    auth: { application_token: APP_TOKEN, domain: PORTAL },
  };
}

function postMax(app, body) {
  return request(app).post('/webhook/max').set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET).send(body);
}

function postB24(app, body) {
  return request(app)
    .post('/webhook/b24')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(body));
}

async function sessionCols(pool) {
  const { rows } = await pool.query(
    'SELECT ol_session_id, ol_closed_session_id FROM chat_bindings WHERE max_chat_id = $1',
    [MAX_CHAT_ID],
  );
  return rows[0] ?? null;
}

async function inboundKeys(pool) {
  const { rows } = await pool.query(
    `SELECT max_mid FROM message_log WHERE direction = 'inbound' ORDER BY id`,
  );
  return rows.map((r) => r.max_mid);
}

describe.skipIf(shouldSkipDb())('inbound group session smoke (M25: «группа» открывает каждую сессию)', () => {
  let pool;
  let app;
  let state;

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

    state = { calls: [], bodies: {}, sessionId: '15756', renameFails: false, olChat: null, link: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchRouter(state));
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) закрытие сессии → следующее входящее открывает опенер от «группы»; дальше — без опенера', async () => {
    // Новая группа: интро + сообщение, сессия 15756 запомнена.
    await postMax(app, messageCreatedBody('mid-1'));
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: null });

    // Оператор закрыл диалог.
    const fin = await postB24(app, dialogFinishBody({ sessionId: 15756 }));
    expect(fin.status).toBe(200);
    expect(fin.body.result).toMatchObject({ ok: true, results: [{ ok: true, sessionId: 15756 }] });
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: 15756 });

    // Следующее входящее — в новую сессию 15758: сначала опенер от «группы».
    state.sessionId = '15758';
    state.calls.length = 0;
    state.bodies = {};
    const res = await postMax(app, messageCreatedBody('mid-2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });
    expect(state.calls).toEqual(['max chat', 'imconnector.send.messages', 'imconnector.send.messages']);
    const [opener, real] = state.bodies['imconnector.send.messages'];
    expect(opener.get('MESSAGES[0][chat][id]')).toBe(CONNECTOR_CHAT_ID);
    expect(opener.get('MESSAGES[0][user][id]')).toBe(`group:${MAX_CHAT_ID}`);
    expect(opener.get('MESSAGES[0][user][name]')).toBe(TITLE);
    expect(opener.get('MESSAGES[0][user][picture][url]')).toBe(ICON);
    expect(opener.get('MESSAGES[0][message][id]')).toBe(`max:group-session:${MAX_CHAT_ID}:15756:mid-2`);
    expect(opener.get('MESSAGES[0][message][text]')).toBe(`Новое обращение из группы «${TITLE}» в MAX`);
    expect(real.get('MESSAGES[0][user][id]')).toBe(String(AUTHOR_ID));
    expect(real.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-2');
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15758, ol_closed_session_id: null });

    // Та же сессия — одна отправка, без GET /chats.
    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-3'));
    expect(state.calls).toEqual(['imconnector.send.messages']);

    expect(await inboundKeys(pool)).toEqual([
      `group-intro:${MAX_CHAT_ID}`,
      'mid-1',
      `group-session:${MAX_CHAT_ID}:15756:mid-2`,
      'mid-2',
      'mid-3',
    ]);
  });

  it('2) устаревший Finish (новая сессия уже открыта), чужой чат и чужой коннектор → флаг не взводится', async () => {
    await postMax(app, messageCreatedBody('mid-1'));
    state.sessionId = '15758';
    await postMax(app, messageCreatedBody('mid-2'));
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15758, ol_closed_session_id: null });

    const stale = await postB24(app, dialogFinishBody({ sessionId: 15756 }));
    expect(stale.status).toBe(200);
    expect(stale.body.result.results).toEqual([{ skipped: 'stale-session', bindingId: expect.anything() }]);

    const foreignChat = await postB24(app, dialogFinishBody({ chatId: 'max:-1', sessionId: 15760 }));
    expect(foreignChat.status).toBe(200);
    expect(foreignChat.body.result.results).toEqual([{ skipped: 'no-binding' }]);

    const foreignConnector = await postB24(app, dialogFinishBody({ connector: 'telegrambot', sessionId: 15762 }));
    expect(foreignConnector.status).toBe(200);
    expect(foreignConnector.body.result).toEqual({ skipped: 'foreign-connector' });

    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15758, ol_closed_session_id: null });
  });

  it('3) connector.chat_id нет → внешний id берётся из chat.id, флаг взведён', async () => {
    await postMax(app, messageCreatedBody('mid-1'));

    const res = await postB24(app, dialogFinishBody({ chatId: null, chatIdField: CONNECTOR_CHAT_ID, sessionId: 15756 }));

    expect(res.status).toBe(200);
    expect(res.body.result.results[0]).toMatchObject({ ok: true, sessionId: 15756 });
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: 15756 });
  });

  it('4) чужой application_token → 401, флаг не взводится', async () => {
    await postMax(app, messageCreatedBody('mid-1'));
    const body = dialogFinishBody({ sessionId: 15756 });
    body.auth.application_token = 'wrong';

    const res = await postB24(app, body);

    expect(res.status).toBe(401);
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: null });
  });

  it('5) M27: Finish потерян, сессия старой привязки неизвестна — переименование при закрытой сессии → флаг 0 → опенер', async () => {
    await postMax(app, messageCreatedBody('mid-1'));
    // Старая привязка (до M25): сессия неизвестна.
    await pool.query('UPDATE chat_bindings SET ol_session_id = NULL WHERE max_chat_id = $1', [MAX_CHAT_ID]);

    state.calls.length = 0;
    state.bodies = {};
    state.renameFails = true;
    state.olChat = { id: 21180, name: TITLE, avatar: '', entity_data_1: 'N|NONE|0|N|N|0|0|42|0|0' };
    const res = await postMax(app, titleChangedBody('Тестовая группа 2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, olTitle: 'pending' });
    expect(state.calls).toEqual(['imconnector.chat.name.set', 'imopenlines.dialog.get']);
    expect(state.bodies['imopenlines.dialog.get'][0].get('CHAT_ID')).toBe('21180');
    expect(await sessionCols(pool)).toEqual({ ol_session_id: null, ol_closed_session_id: 0 });

    // Следующее входящее — в новую сессию 15758: опенер с ключом …:0:<mid>, флаг снят.
    state.renameFails = false;
    state.sessionId = '15758';
    state.calls.length = 0;
    state.bodies = {};
    const next = await postMax(app, messageCreatedBody('mid-2'));

    expect(next.status).toBe(200);
    expect(next.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });
    expect(state.calls).toEqual([
      'max chat',
      'imconnector.send.messages',
      'imconnector.send.messages',
      'imconnector.chat.name.set',
    ]);
    const [opener, real] = state.bodies['imconnector.send.messages'];
    expect(opener.get('MESSAGES[0][message][id]')).toBe(`max:group-session:${MAX_CHAT_ID}:0:mid-2`);
    expect(real.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-2');
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15758, ol_closed_session_id: null });
    expect((await inboundKeys(pool)).slice(-2)).toEqual([`group-session:${MAX_CHAT_ID}:0:mid-2`, 'mid-2']);
  });

  it('6) M27: Finish дошёл, затем переименование при закрытой сессии → флаг тот же (already armed), опенер один', async () => {
    await postMax(app, messageCreatedBody('mid-1'));
    await postB24(app, dialogFinishBody({ sessionId: 15756 }));
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: 15756 });

    state.renameFails = true;
    state.olChat = { id: 21180, name: TITLE, avatar: '', entity_data_1: 'N|NONE|0|N|N|0|0|42|0|0' };
    const res = await postMax(app, titleChangedBody('Тестовая группа 2'));
    expect(res.body.result).toMatchObject({ ok: true, olTitle: 'pending' });
    expect(await sessionCols(pool)).toEqual({ ol_session_id: 15756, ol_closed_session_id: 15756 });

    state.renameFails = false;
    state.sessionId = '15758';
    state.bodies = {};
    await postMax(app, messageCreatedBody('mid-2'));
    const ids = state.bodies['imconnector.send.messages'].map((p) => p.get('MESSAGES[0][message][id]'));
    expect(ids).toEqual([`max:group-session:${MAX_CHAT_ID}:15756:mid-2`, 'max:mid:mid-2']);
  });

  it('7) M27: опенер с перевыпущенной ссылкой → системное сообщение с новой; с той же ссылкой — без него', async () => {
    state.link = 'https://max.ru/join/first';
    await postMax(app, messageCreatedBody('mid-1'));
    expect(state.calls.filter((c) => c === 'im.message.add')).toHaveLength(1);

    // Сессия закрыта, MAX перевыпустил ссылку → опенер, затем ссылка, затем сообщение.
    await postB24(app, dialogFinishBody({ sessionId: 15756 }));
    state.link = 'https://max.ru/join/second';
    state.sessionId = '15758';
    state.calls.length = 0;
    state.bodies = {};
    await postMax(app, messageCreatedBody('mid-2'));
    expect(state.calls).toEqual([
      'max chat',
      'imconnector.send.messages',
      'im.message.add',
      'imconnector.send.messages',
    ]);
    expect(state.bodies['im.message.add'][0].get('MESSAGE')).toBe('Ссылка на группу в MAX: https://max.ru/join/second');

    // Следующая сессия — ссылка та же → опенер без системного сообщения.
    await postB24(app, dialogFinishBody({ sessionId: 15758 }));
    state.sessionId = '15760';
    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-3'));
    expect(state.calls).toEqual(['max chat', 'imconnector.send.messages', 'imconnector.send.messages']);

    const { rows } = await pool.query(
      `SELECT payload_meta->>'via' AS via FROM message_log WHERE max_mid LIKE 'group-link:%' ORDER BY id`,
    );
    expect(rows).toEqual([{ via: 'intro' }, { via: 'opener' }]);
  });
});
