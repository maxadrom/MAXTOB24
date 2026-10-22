// Smoke M24: название и иконка MAX-группы в чате Open Lines.
// Новая группа → POST /webhook/max (message_created) → routeInbound: авто-онбординг →
// GET /chats/{id} (название, иконка) → imconnector.send.messages (интро от «группы») →
// imconnector.send.messages (сообщение автора) → imconnector.chat.name.set. Затем
// chat_title_changed при закрытой сессии (400 CHAT_RENAMING_FAILED → imopenlines.dialog.get,
// поле 6 entity_data_1 = 0) → 200, название ждёт, флаг опенера взведён (M27); следующее
// входящее открывает сессию опенером и применяет название. То же имя при открытой сессии →
// отметка без флага. Ссылка на группу (M27): после интро — системное сообщение
// (im.message.add) со ссылкой из GET /chats, один раз; привязке без такой записи — на
// следующем входящем после рестарта. MAX и Б24 — один мок globalThis.fetch с роутингом по URL.
//
// DB-gated: describe.skipIf(shouldSkipDb()) + truncateAll(pool).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { contentHash } from '../src/shared/crypto/contentHash.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';

const PORTAL = 'example.bitrix24.ru';
const MAX_CHAT_ID = '-70000000000218';
const CONNECTOR_CHAT_ID = `max:${MAX_CHAT_ID}`;
const CONNECTOR_ID = 'max_b24';
const OL_LINE_ID = 42;
const MAX_BOT_ID = '100000001';
const AUTHOR_ID = 1000001;
const WEBHOOK_SECRET = 'test-max-secret-1234567890';
const ICON = 'https://i.oneme.ru/i?r=ICONTEST';

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

function b24SendOk(sessionId) {
  return {
    result: {
      SUCCESS: true,
      DATA: { RESULT: [{ SUCCESS: true, session: { ID: sessionId, CHAT_ID: '21180' } }] },
    },
    time: {},
  };
}

// Роутер fetch по URL. state.calls — метки вызовов по порядку (B24-метод или «max …»),
// state.bodies — тело B24-вызова по метке (последний вызов). state.renameFails —
// chat.name.set → 400 CHAT_RENAMING_FAILED (сессия закрыта или имя то же); state.olChat —
// ответ imopenlines.dialog.get (null → ACCESS_ERROR: чата OL ещё нет); state.sessionId —
// session.ID в ответе send.messages; state.link — Chat.link в GET /chats (M27).
function fetchRouter(state) {
  return vi.fn(async (input, init) => {
    const url = String(input);
    const b24 = url.match(/\/rest\/([a-z.]+)\.json/);
    if (b24) {
      const method = b24[1];
      state.calls.push(method);
      (state.bodies[method] ??= []).push(new URLSearchParams(init?.body ?? ''));
      if (state.b24Down) return json({ error: 'INTERNAL_SERVER_ERROR', error_description: 'down' }, 500);
      if (method === 'imconnector.send.messages') return json(b24SendOk(state.sessionId));
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
        title: state.title,
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

function postMax(app, body) {
  return request(app).post('/webhook/max').set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET).send(body);
}

async function bindingRow(pool) {
  const { rows } = await pool.query('SELECT * FROM chat_bindings WHERE max_chat_id = $1', [MAX_CHAT_ID]);
  return rows[0] ?? null;
}

async function inboundKeys(pool) {
  const { rows } = await pool.query(
    `SELECT max_mid FROM message_log WHERE direction = 'inbound' ORDER BY id`,
  );
  return rows.map((r) => r.max_mid);
}

describe.skipIf(shouldSkipDb())('inbound group intro smoke (M24: название и иконка группы)', () => {
  let pool;
  let app;
  let state;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);

    const installationsRepo = new InstallationsRepository(pool, null);
    const installations = new InstallationsService(installationsRepo, null);
    const inst = await installationsRepo.upsertByPortal({ portal: PORTAL });
    await installationsRepo.updateTokens(inst.id, { access: 'fake-access-token', refresh: null, applicationToken: null });
    await installations.seedSingleTenant({
      portal: PORTAL,
      olLineId: OL_LINE_ID,
      connectorId: CONNECTOR_ID,
      maxBotId: MAX_BOT_ID,
    });

    state = {
      calls: [],
      bodies: {},
      title: 'Тестовая группа 🚀 «Ромашка»',
      renameFails: false,
      olChat: null,
      sessionId: '15756',
      link: null,
      b24Down: false,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchRouter(state));
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) новая группа: интро от «группы» с иконкой → сообщение автора → точное название; повтор — без интро', async () => {
    const res = await postMax(app, messageCreatedBody('mid-1'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-1' });
    expect(state.calls.filter((c) => !c.startsWith('max'))).toEqual([
      'imconnector.send.messages',
      'imconnector.send.messages',
      'imconnector.chat.name.set',
    ]);

    const [intro, real] = state.bodies['imconnector.send.messages'];
    expect(intro.get('MESSAGES[0][chat][id]')).toBe(CONNECTOR_CHAT_ID);
    expect(intro.get('MESSAGES[0][user][id]')).toBe(`group:${MAX_CHAT_ID}`);
    // Имя пользователя коннектора — санитизировано (вне BMP вырезано), picture — иконка группы.
    expect(intro.get('MESSAGES[0][user][name]')).toBe('Тестовая группа «Ромашка»');
    expect(intro.get('MESSAGES[0][user][picture][url]')).toBe(ICON);
    expect(intro.get('MESSAGES[0][message][id]')).toBe(`max:group-intro:${MAX_CHAT_ID}`);
    expect(intro.get('MESSAGES[0][message][text]'))
      .toBe('Группа «Тестовая группа 🚀 «Ромашка»» в MAX подключена к Открытой линии');
    expect(intro.get('MESSAGES[0][chat][name]')).toBeNull();
    expect(real.get('MESSAGES[0][user][id]')).toBe(String(AUTHOR_ID));
    expect(real.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-1');

    // Название — без санитизации имени пользователя: chat.name.set принимает эмодзи.
    const [rename] = state.bodies['imconnector.chat.name.set'];
    expect(rename.get('CONNECTOR')).toBe(CONNECTOR_ID);
    expect(rename.get('LINE')).toBe(String(OL_LINE_ID));
    expect(rename.get('CHAT_ID')).toBe(CONNECTOR_CHAT_ID);
    expect(rename.get('NAME')).toBe('Тестовая группа 🚀 «Ромашка»');

    const row = await bindingRow(pool);
    expect(row).toMatchObject({
      max_chat_title: 'Тестовая группа 🚀 «Ромашка»',
      ol_chat_title: 'Тестовая группа 🚀 «Ромашка»',
      b24_chat_id: '21180',
    });
    expect(await inboundKeys(pool)).toEqual([`group-intro:${MAX_CHAT_ID}`, 'mid-1']);

    // Второе сообщение: чат OL известен, название синхронно → один вызов Б24.
    state.calls.length = 0;
    const res2 = await postMax(app, messageCreatedBody('mid-2'));
    expect(res2.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });
    expect(state.calls).toEqual(['imconnector.send.messages']);
  });

  // Чат OL по imopenlines.dialog.get: поле 6 entity_data_1 — id текущей сессии, 0 у закрытой.
  function olChat(name, sessionId) {
    return { id: 21180, name, avatar: '', entity_data_1: `N|NONE|0|N|N|${sessionId}|0|42|0|0` };
  }

  it('2) chat_title_changed при закрытой сессии → 200, флаг опенера; следующее входящее: опенер, сообщение, название', async () => {
    await postMax(app, messageCreatedBody('mid-1'));

    state.calls.length = 0;
    state.bodies = {};
    state.renameFails = true;
    state.olChat = olChat('Тестовая группа 🚀 «Ромашка»', 0);
    state.title = 'Тестовая группа 2';
    const res = await postMax(app, titleChangedBody('Тестовая группа 2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, olTitle: 'pending' });
    expect(state.calls).toEqual(['imconnector.chat.name.set', 'imopenlines.dialog.get']);
    const [dialogGet] = state.bodies['imopenlines.dialog.get'];
    expect(dialogGet.get('CHAT_ID')).toBe('21180');
    expect(dialogGet.has('USER_CODE')).toBe(false);
    expect(await bindingRow(pool)).toMatchObject({
      max_chat_title: 'Тестовая группа 2',
      ol_chat_title: 'Тестовая группа 🚀 «Ромашка»',
      ol_session_id: 15756,
      ol_closed_session_id: 15756,
    });

    // Ретрай того же события — duplicate, без повторного переименования.
    state.calls.length = 0;
    const dup = await postMax(app, titleChangedBody('Тестовая группа 2'));
    expect(dup.body.result).toMatchObject({ skipped: 'duplicate' });
    expect(state.calls).toEqual([]);

    // Новое входящее (новая сессия 15758): опенер от «группы» → сообщение → название.
    state.calls.length = 0;
    state.bodies = {};
    state.renameFails = false;
    state.sessionId = '15758';
    const next = await postMax(app, messageCreatedBody('mid-2'));
    expect(next.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });
    expect(state.calls).toEqual([
      'max chat',
      'imconnector.send.messages',
      'imconnector.send.messages',
      'imconnector.chat.name.set',
    ]);
    const [opener, real] = state.bodies['imconnector.send.messages'];
    expect(opener.get('MESSAGES[0][message][id]')).toBe(`max:group-session:${MAX_CHAT_ID}:15756:mid-2`);
    expect(opener.get('MESSAGES[0][user][id]')).toBe(`group:${MAX_CHAT_ID}`);
    expect(real.get('MESSAGES[0][message][id]')).toBe('max:mid:mid-2');
    expect(state.bodies['imconnector.chat.name.set'].at(-1).get('NAME')).toBe('Тестовая группа 2');
    expect(await bindingRow(pool)).toMatchObject({
      ol_chat_title: 'Тестовая группа 2',
      ol_session_id: 15758,
      ol_closed_session_id: null,
    });
  });

  it('2b) M27: сессия открыта, имя в OL уже равно новому названию (CHAT_RENAMING_FAILED) → synced, флага нет', async () => {
    await postMax(app, messageCreatedBody('mid-1'));

    state.calls.length = 0;
    state.bodies = {};
    state.renameFails = true;
    state.olChat = olChat('Тестовая группа 2', 15756);
    const res = await postMax(app, titleChangedBody('Тестовая группа 2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, olTitle: 'synced' });
    expect(state.calls).toEqual(['imconnector.chat.name.set', 'imopenlines.dialog.get']);
    expect(await bindingRow(pool)).toMatchObject({
      max_chat_title: 'Тестовая группа 2',
      ol_chat_title: 'Тестовая группа 2',
      ol_session_id: 15756,
      ol_closed_session_id: null,
    });

    // Петли pending нет: следующее входящее без chat.name.set и без опенера.
    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-2'));
    expect(state.calls).toEqual(['imconnector.send.messages']);
  });

  it('2c) M27: CHAT_RENAMING_FAILED, а dialog.get упал → pending, флаг не взводится; следующее входящее без опенера', async () => {
    await postMax(app, messageCreatedBody('mid-1'));

    state.calls.length = 0;
    state.renameFails = true;
    state.olChat = null; // dialog.get → ACCESS_ERROR
    const res = await postMax(app, titleChangedBody('Тестовая группа 2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, olTitle: 'pending' });
    expect(state.calls).toEqual(['imconnector.chat.name.set', 'imopenlines.dialog.get']);
    expect(await bindingRow(pool)).toMatchObject({ ol_session_id: 15756, ol_closed_session_id: null });

    state.calls.length = 0;
    state.renameFails = false;
    await postMax(app, messageCreatedBody('mid-2'));
    expect(state.calls).toEqual(['imconnector.send.messages', 'imconnector.chat.name.set']);
  });

  it('3) Б24 лежал на первом сообщении → 5xx; ретрай MAX: интро всё равно уходит первым', async () => {
    state.b24Down = true;
    const failed = await postMax(app, messageCreatedBody('mid-1'));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await inboundKeys(pool)).toEqual([]);

    state.b24Down = false;
    state.calls.length = 0;
    state.bodies = {};
    const res = await postMax(app, messageCreatedBody('mid-1'));

    expect(res.status).toBe(200);
    // Привязка уже есть → сначала проверка, нет ли чата OL (нет), потом интро.
    expect(state.calls.filter((c) => !c.startsWith('max'))).toEqual([
      'imopenlines.dialog.get',
      'imconnector.send.messages',
      'imconnector.send.messages',
      'imconnector.chat.name.set',
    ]);
    expect(state.bodies['imconnector.send.messages'][0].get('MESSAGES[0][user][id]')).toBe(`group:${MAX_CHAT_ID}`);
    expect(await inboundKeys(pool)).toEqual([`group-intro:${MAX_CHAT_ID}`, 'mid-1']);
  });

  // M21: до атомарного upsert'а второе сообщение либо падало на unique violation (500),
  // либо попадало между INSERT и UPDATE привязки и молча терялось (binding-not-ready).
  it('5) M21: два первых сообщения новой группы одновременно → оба доходят, одна привязка, одно интро', async () => {
    const [a, b] = await Promise.all([
      postMax(app, messageCreatedBody('mid-1', 'Первое')),
      postMax(app, messageCreatedBody('mid-2', 'Второе')),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.result).toMatchObject({ ok: true, maxMid: 'mid-1' });
    expect(b.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chat_bindings');
    expect(rows[0].n).toBe(1);
    const sent = state.bodies['imconnector.send.messages'].map((p) => p.get('MESSAGES[0][user][id]'));
    expect(sent.filter((id) => id === `group:${MAX_CHAT_ID}`)).toHaveLength(1);
    expect(sent.filter((id) => id === String(AUTHOR_ID))).toHaveLength(2);
    expect(state.calls.filter((c) => c === 'imconnector.chat.name.set')).toHaveLength(1);
    expect((await inboundKeys(pool)).sort()).toEqual([`group-intro:${MAX_CHAT_ID}`, 'mid-1', 'mid-2'].sort());
  });

  it('4) chat_title_changed для неподключённой группы → 200 skipped:no-binding, Б24 не зовётся', async () => {
    const res = await postMax(app, titleChangedBody('Что-то'));

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ skipped: 'no-binding' });
    expect(state.calls).toEqual([]);
    expect(await bindingRow(pool)).toBeNull();
  });

  // ─── M27: ссылка на группу системным сообщением ─────────────────────────────

  const LINK = 'https://max.ru/join/test-link';
  const LINK_KEY = `group-link:${MAX_CHAT_ID}:${contentHash(LINK)}`;
  const b24Calls = () => state.calls.filter((c) => !c.startsWith('max'));

  it('6) M27: новая группа со ссылкой → интро, системное сообщение со ссылкой, сообщение автора; второе — без ссылки', async () => {
    state.link = LINK;

    const res = await postMax(app, messageCreatedBody('mid-1'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-1' });
    expect(b24Calls()).toEqual([
      'imconnector.send.messages',
      'im.message.add',
      'imconnector.send.messages',
      'imconnector.chat.name.set',
    ]);
    expect(state.calls.filter((c) => c === 'max chat')).toHaveLength(1);
    const [system] = state.bodies['im.message.add'];
    expect(system.get('DIALOG_ID')).toBe('chat21180');
    expect(system.get('SYSTEM')).toBe('Y');
    expect(system.get('URL_PREVIEW')).toBe('N');
    expect(system.get('MESSAGE')).toBe(`Ссылка на группу в MAX: ${LINK}`);
    expect(await inboundKeys(pool)).toEqual([`group-intro:${MAX_CHAT_ID}`, LINK_KEY, 'mid-1']);
    const { rows: [meta] } = await pool.query(
      'SELECT payload_meta FROM message_log WHERE max_mid = $1',
      [LINK_KEY],
    );
    expect(meta.payload_meta).toEqual({ kind: 'group-link', via: 'intro', b24MsgId: 777 });

    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-2'));
    expect(state.calls).toEqual(['imconnector.send.messages']);
  });

  it('7) M27: рестарт → повторного поста нет; старая привязка без записи → одно сообщение на следующем входящем', async () => {
    state.link = LINK;
    await postMax(app, messageCreatedBody('mid-1'));

    // Рестарт: новый процесс на той же БД — запись group-link: есть, GET /chats не нужен.
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-2'));
    expect(state.calls.filter((c) => c !== 'max members')).toEqual(['imconnector.send.messages']);

    // Старая привязка (до M27): записи нет → ссылка уходит после сообщения, один раз.
    await pool.query(`DELETE FROM message_log WHERE max_mid LIKE 'group-link:%'`);
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });
    state.calls.length = 0;
    state.bodies = {};
    const res = await postMax(app, messageCreatedBody('mid-3'));
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-3' });
    expect(state.calls.filter((c) => c !== 'max members')).toEqual([
      'imconnector.send.messages',
      'max chat',
      'im.message.add',
    ]);
    expect(state.bodies['im.message.add'][0].get('MESSAGE')).toBe(`Ссылка на группу в MAX: ${LINK}`);
    const { rows } = await pool.query(
      `SELECT payload_meta->>'via' AS via FROM message_log WHERE max_mid LIKE 'group-link:%'`,
    );
    expect(rows).toEqual([{ via: 'lazy' }]);

    state.calls.length = 0;
    await postMax(app, messageCreatedBody('mid-4'));
    expect(state.calls).toEqual(['imconnector.send.messages']);
  });

  it.each([
    ['GET /chats упал', 'max-down'],
    ['im.message.add упал', 'b24-system-down'],
  ])('8) M27: %s → сообщение автора доставлено, 200, записи group-link: нет', async (_label, failure) => {
    state.link = LINK;
    await postMax(app, messageCreatedBody('mid-1'));
    await pool.query(`DELETE FROM message_log WHERE max_mid LIKE 'group-link:%'`);
    app = buildApp(buildTestConfig(), { pool, logger: pino({ level: 'silent' }) });

    const router = fetchRouter(state);
    globalThis.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (failure === 'max-down' && url.endsWith(`/chats/${MAX_CHAT_ID}`)) {
        state.calls.push('max chat');
        return json({ code: 'internal', message: 'down' }, 500);
      }
      if (failure === 'b24-system-down' && url.includes('/rest/im.message.add.json')) {
        state.calls.push('im.message.add');
        return json({ error: 'INTERNAL_SERVER_ERROR', error_description: 'down' }, 500);
      }
      return router(input, init);
    });
    state.calls.length = 0;
    const res = await postMax(app, messageCreatedBody('mid-2'));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, maxMid: 'mid-2' });
    expect(state.calls).toContain('max chat');
    expect((await inboundKeys(pool)).filter((k) => k.startsWith('group-link:'))).toEqual([]);
    expect(await inboundKeys(pool)).toContain('mid-2');
  });

  it('9) M27: у группы нет ссылки → системного сообщения нет', async () => {
    const res = await postMax(app, messageCreatedBody('mid-1'));

    expect(res.status).toBe(200);
    expect(state.calls).not.toContain('im.message.add');
    expect((await inboundKeys(pool)).filter((k) => k.startsWith('group-link:'))).toEqual([]);
  });
});
