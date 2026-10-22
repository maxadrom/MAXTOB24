// Smoke M26: удаление приложения Б24 целиком через buildApp и реальный pg.
//   POST /webhook/b24 ONAPPUNINSTALL (form-urlencoded, как шлёт Б24) → b24Controller (токен,
//   member_id) → b24Service.handleAppUninstall → installations.markUninstalled → при CLEAN=1
//   messaging.purgeBridgeData → bindings.purgeAll (participant_map и message_log — каскадом).
// Затем гейт uninstalled_at на /webhook/b24, guard онбординга на /webhook/max (503 — MAX
// ретраит входящее до переустановки) и переустановка через POST /api/install (обмен
// refresh_token — стаб, без сети).
//
// DB-gated: describe.skipIf(shouldSkipDb()) + truncateAll(pool). Внешние HTTP — подменённый
// globalThis.fetch: после удаления ни один запрос к порталу уходить не должен.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../src/modules/bindings/participantMapRepository.js';
import { MessageLogRepository } from '../src/modules/messaging/messageLogRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';
import { encodeForm } from './helpers/form.js';

const PORTAL = 'example.bitrix24.ru';
const APP_TOKEN = 'apptoken000000000000000000000001';
const NEW_APP_TOKEN = 'apptoken000000000000000000000002';
const MEMBER = 'memberid000000000000000000000001';
const WEBHOOK_SECRET = 'test-max-secret-1234567890';
const CHAT_A = '-70000000000954';
const CHAT_B = '-70000000000955';
const NEW_CHAT = '-70000000000999';

function buildTestConfig({ envApplicationToken = null } = {}) {
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
      clientId: 'local.app.m26',
      clientSecret: 'm26-secret',
      applicationToken: envApplicationToken,
      olLineId: 42,
      connectorId: 'max_b24',
    },
    optional: {},
  });
}

function uninstallForm({ clean = '1', token = APP_TOKEN, memberId = MEMBER } = {}) {
  return encodeForm({
    event: 'ONAPPUNINSTALL',
    event_handler_id: '13',
    data: { LANGUAGE_ID: 'ru', CLEAN: clean },
    ts: '1759917600',
    auth: {
      domain: PORTAL,
      server_endpoint: 'https://oauth.bitrix24.tech/rest/',
      client_endpoint: `https://${PORTAL}/rest/`,
      member_id: memberId,
      application_token: token,
    },
  });
}

// Событие ОЛ без сообщений: routeOutbound отвечает skip без вызовов наружу.
function messageAddForm(token) {
  return encodeForm({
    event: 'ONIMCONNECTORMESSAGEADD',
    data: { CONNECTOR: 'max_b24', LINE: '42' },
    auth: { domain: PORTAL, member_id: MEMBER, application_token: token },
  });
}

function messageCreated(chatId, mid) {
  return {
    update_type: 'message_created',
    timestamp: 1759917600000,
    message: {
      recipient: { chat_id: Number(chatId), chat_type: 'chat' },
      sender: { user_id: 1000001, name: 'Олег' },
      body: { mid, text: 'Привет после удаления' },
    },
  };
}

describe.skipIf(shouldSkipDb())('app uninstall smoke (ONAPPUNINSTALL → гейт → переустановка, M26)', () => {
  let pool;
  let installationId;
  let fetchSpy;
  let exchange;

  async function seed() {
    const installations = new InstallationsRepository(pool, null);
    const inst = await installations.saveInstallTokens({
      portal: PORTAL,
      access: 'access-before-uninstall',
      refresh: 'refresh-before-uninstall',
      applicationToken: APP_TOKEN,
    });
    await installations.setMemberId(inst.id, MEMBER);
    await installations.updateConnectorMetadata(inst.id, { olLineId: 42, connectorId: 'max_b24', maxBotId: '100000001' });

    const bindings = new BindingsRepository(pool, null);
    const participants = new ParticipantMapRepository(pool, null);
    const log = new MessageLogRepository(pool, null);
    for (const [chatId, idx] of [[CHAT_A, 1], [CHAT_B, 2]]) {
      // eslint-disable-next-line no-await-in-loop
      const { binding } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: chatId });
      // eslint-disable-next-line no-await-in-loop
      await bindings.updateB24ChatId(binding.id, String(21180 + idx));
      // eslint-disable-next-line no-await-in-loop
      await participants.upsert({ bindingId: binding.id, maxUserId: 1000001, maxDisplayName: 'Олег' });
      // eslint-disable-next-line no-await-in-loop
      await log.recordInbound({ bindingId: binding.id, maxMid: `mid.seed.${idx}`, payloadMeta: { text: 'привет' } });
      // eslint-disable-next-line no-await-in-loop
      await log.recordOutbound({ bindingId: binding.id, b24MsgId: `${1459190 + idx}` });
    }
    return inst.id;
  }

  async function installationRow() {
    const { rows } = await pool.query('SELECT * FROM installations WHERE id = $1', [installationId]);
    return rows[0];
  }

  async function counts() {
    const { rows: [row] } = await pool.query(
      `SELECT (SELECT count(*)::int FROM chat_bindings) AS bindings,
              (SELECT count(*)::int FROM participant_map) AS participants,
              (SELECT count(*)::int FROM message_log) AS log`,
    );
    return row;
  }

  function buildTestApp(opts) {
    return buildApp(buildTestConfig(opts), {
      pool,
      logger: pino({ level: 'silent' }),
      exchangeRefreshToken: exchange,
    });
  }

  function postB24(app, form) {
    return request(app)
      .post('/webhook/b24')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form);
  }

  function portalCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).includes(PORTAL));
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    installationId = await seed();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    exchange = vi.fn(async () => ({
      accessToken: 'access-after-reinstall',
      refreshToken: 'refresh-after-reinstall',
      memberId: MEMBER,
      clientEndpoint: `https://${PORTAL}/rest/`,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) CLEAN=1 → 200; токены NULL, uninstalled_at стоит, member_id цел; привязки, участники и журнал удалены', async () => {
    expect(await counts()).toEqual({ bindings: 2, participants: 2, log: 4 });
    const app = buildTestApp();

    const res = await postB24(app, uninstallForm());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      result: { ok: true, clean: true, installationId, purged: { bindings: 2 } },
    });
    const row = await installationRow();
    expect(row).toMatchObject({
      b24_portal: PORTAL,
      b24_access_token: null,
      b24_refresh_token: null,
      b24_application_token: null,
      b24_member_id: MEMBER,
      connector_id: 'max_b24',
      ol_line_id: 42,
    });
    expect(row.uninstalled_at).toBeInstanceOf(Date);
    expect(await counts()).toEqual({ bindings: 0, participants: 0, log: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('2) после удаления: любое событие → 503 B24_APP_UNINSTALLED, в т.ч. со старым токеном и совпавшим env-fallback', async () => {
    await postB24(buildTestApp(), uninstallForm());
    const app = buildTestApp({ envApplicationToken: APP_TOKEN });

    const res = await postB24(app, messageAddForm(APP_TOKEN));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('B24_APP_UNINSTALLED');
    expect(portalCalls()).toEqual([]);
  });

  it('3) повтор ONAPPUNINSTALL → 503, строка не меняется (uninstalled_at и updated_at прежние)', async () => {
    const app = buildTestApp();
    await postB24(app, uninstallForm());
    const before = await installationRow();

    const res = await postB24(app, uninstallForm());

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('B24_APP_UNINSTALLED');
    expect(await installationRow()).toEqual(before);
  });

  it.each([
    ['чужой application_token (другое приложение портала)', { token: 'apptoken000000000000000000000003' }, 'B24_AUTH_INVALID'],
    ['чужой member_id', { memberId: 'memberid000000000000000000000002' }, 'B24_MEMBER_MISMATCH'],
  ])('4) поддельный ONAPPUNINSTALL: %s → 401, строка и данные моста не тронуты', async (_label, override, code) => {
    const app = buildTestApp();
    const before = await installationRow();

    const res = await postB24(app, uninstallForm(override));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(code);
    expect(await installationRow()).toEqual(before);
    expect(before.b24_application_token).toBe(APP_TOKEN);
    expect(await counts()).toEqual({ bindings: 2, participants: 2, log: 4 });
  });

  it('5) CLEAN=0 → токены сброшены, привязки, участники и журнал на месте', async () => {
    const app = buildTestApp();

    const res = await postB24(app, uninstallForm({ clean: '0' }));

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ ok: true, clean: false, installationId });
    const row = await installationRow();
    expect(row.b24_application_token).toBeNull();
    expect(row.uninstalled_at).toBeInstanceOf(Date);
    expect(await counts()).toEqual({ bindings: 2, participants: 2, log: 4 });
  });

  it('6) CLEAN=1, затем входящее MAX из новой группы → 503 CONFIG_ERROR, привязка не создаётся, в Б24 ничего', async () => {
    const app = buildTestApp();
    await postB24(app, uninstallForm());

    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageCreated(NEW_CHAT, 'mid.after-uninstall'));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONFIG_ERROR');
    expect(await counts()).toEqual({ bindings: 0, participants: 0, log: 0 });
    expect(portalCalls()).toEqual([]);
  });

  it('6b) CLEAN=0, затем входящее MAX из старой группы → 502 B24_NO_AUTH (MAX ретраит), журнал не растёт', async () => {
    const app = buildTestApp();
    await postB24(app, uninstallForm({ clean: '0' }));

    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', WEBHOOK_SECRET)
      .send(messageCreated(CHAT_A, 'mid.after-uninstall'));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('B24_NO_AUTH');
    expect(await counts()).toEqual({ bindings: 2, participants: 2, log: 4 });
    expect(portalCalls()).toEqual([]);
  });

  it('7) переустановка: ONAPPINSTALL с обменом refresh_token → новые токены, uninstalled_at снят, события снова принимаются', async () => {
    const app = buildTestApp();
    await postB24(app, uninstallForm());

    const install = await request(app)
      .post('/api/install')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(encodeForm({
        event: 'ONAPPINSTALL',
        data: { VERSION: '1', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
        auth: {
          domain: PORTAL,
          access_token: 'accesstoken000000000000000000001',
          refresh_token: 'refreshtoken00000000000000000001',
          member_id: MEMBER,
          application_token: NEW_APP_TOKEN,
        },
      }));

    expect(install.status).toBe(200);
    expect(install.body.installation).toEqual({ id: installationId, portal: PORTAL });
    expect(exchange).toHaveBeenCalledOnce();
    expect(await installationRow()).toMatchObject({
      b24_access_token: 'access-after-reinstall',
      b24_refresh_token: 'refresh-after-reinstall',
      b24_application_token: NEW_APP_TOKEN,
      b24_member_id: MEMBER,
      uninstalled_at: null,
    });

    const accepted = await postB24(app, messageAddForm(NEW_APP_TOKEN));
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);

    // Старый токен удалённого приложения вебхук больше не открывает.
    const stale = await postB24(app, messageAddForm(APP_TOKEN));
    expect(stale.status).toBe(401);
  });

  it('8) гонка: между проверкой токена A и UPDATE install-callback нового приложения записал токен B → удаление не применяется, 200 stale-uninstall', async () => {
    const app = buildTestApp();
    // Окно гонки: контроллер и сервис уже прочли строку с токеном A, и прямо перед UPDATE
    // install-callback нового локального приложения пишет свою тройку (токен B).
    const original = InstallationsRepository.prototype.markUninstalled;
    const markSpy = vi
      .spyOn(InstallationsRepository.prototype, 'markUninstalled')
      .mockImplementation(async function markUninstalledAfterReinstall(...args) {
        await new InstallationsRepository(pool, null).saveInstallTokens({
          id: installationId,
          portal: PORTAL,
          access: 'access-new-app',
          refresh: 'refresh-new-app',
          applicationToken: NEW_APP_TOKEN,
        });
        return original.apply(this, args);
      });

    const res = await postB24(app, uninstallForm());

    expect(markSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { skipped: 'stale-uninstall', installationId } });
    expect(await installationRow()).toMatchObject({
      b24_access_token: 'access-new-app',
      b24_refresh_token: 'refresh-new-app',
      b24_application_token: NEW_APP_TOKEN,
      uninstalled_at: null,
    });
    expect(await counts()).toEqual({ bindings: 2, participants: 2, log: 4 });

    // Новая установка жива: её события принимаются.
    const accepted = await postB24(app, messageAddForm(NEW_APP_TOKEN));
    expect(accepted.status).toBe(200);
  });
});
