// Smoke-тест композиции. Использует мок-пул вместо реального Postgres, чтобы
// тест проходил без БД. Проверяем контракт: правильные статус-коды на M1
// каркасе.

import { describe, expect, it, beforeAll, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../src/app.js';
import { B24ApiError } from '../src/shared/http/domainErrors.js';

class FakePool {
  async query() {
    return { rows: [] };
  }
}

// rateLimit с щедрыми лимитами — smoke-тесты шлют несколько запросов на роут,
// rate-limit не должен их зарубить.
const TEST_RATE_LIMIT = Object.freeze({
  installWindowMs: 60_000,
  installMax: 1000,
  webhookWindowMs: 60_000,
  webhookMax: 1000,
});

function buildTestConfig({ maxWebhookSecret = null, b24Portal = null, b24Creds = false } = {}) {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test', host: null, port: null, name: null, user: null, password: null },
    log: { level: 'silent', levelFallback: false, originalLevel: null },
    max: {
      botToken: null,
      webhookSecret: maxWebhookSecret,
      apiBaseUrl: 'https://dev.max.ru/api',
      publicWebhookUrl: null,
      webhookUpdateTypes: ['message_created', 'bot_added', 'bot_removed', 'user_added', 'user_removed'],
    },
    b24: {
      portal: b24Portal,
      clientId: b24Creds ? 'local.app.smoke' : null,
      clientSecret: b24Creds ? 'smoke-secret' : null,
      applicationToken: null,
      olLineId: null,
    },
    rateLimit: TEST_RATE_LIMIT,
    optional: {},
  });
}

describe('app.js composition (smoke)', () => {
  let app;
  let config;

  beforeAll(() => {
    config = buildTestConfig();
    const logger = pino({ level: 'silent' });
    const pool = new FakePool();
    app = buildApp(config, { pool, logger });
  });

  it('GET / returns 200 with API-only hint payload (no JWT)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    // Исторический контракт: тело — массив строк (Array.isArray).
    expect(Array.isArray(res.body)).toBe(true);
    // M12.5: после снятия frontend `/` отдаёт внятную API-only заглушку.
    expect(res.body).toContain('max-b24-connector');
    expect(res.body.some((line) => line.includes('api-only'))).toBe(true);
  });

  // M13: JWT-only /api/health и POST /api/getToken удалены (вестигиальная JWT-зона).
  it('GET /api/health is no longer mounted (404)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(404);
  });

  it('GET /health (public) returns 200 healthy without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.backend).toBe('node');
  });

  it('POST /webhook/max returns 503 when MAX_WEBHOOK_SECRET is not set', async () => {
    const res = await request(app).post('/webhook/max').send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('POST /webhook/b24 returns 503 when application_token is not set on installation', async () => {
    const res = await request(app)
      .post('/webhook/b24')
      .send({ event: 'OnImConnectorMessageAdd', auth: { application_token: 'whatever' } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('B24_WEBHOOK_DISABLED');
  });

});

// M3: отдельный describe c конфигом, где MAX_WEBHOOK_SECRET непустой —
// здесь проверяем поведение maxSecretMiddleware на /webhook/max.
describe('POST /webhook/max with configured secret (smoke, M3)', () => {
  const TEST_SECRET = 'test-max-secret-1234567890';
  let app;

  beforeAll(() => {
    const config = buildTestConfig({ maxWebhookSecret: TEST_SECRET });
    const logger = pino({ level: 'silent' });
    const pool = new FakePool();
    app = buildApp(config, { pool, logger });
  });

  it('returns 401 SECRET_MISSING when X-Max-Bot-Api-Secret header is absent', async () => {
    const res = await request(app).post('/webhook/max').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SECRET_MISSING');
  });

  it('returns 401 SECRET_INVALID when X-Max-Bot-Api-Secret header is wrong', async () => {
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', 'wrong-value-which-is-different-length')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SECRET_INVALID');
  });

  it('passes middleware and reaches controller when secret matches', async () => {
    // Body без update_type → controller отдаст 400 ValidationError.
    // Этого достаточно, чтобы убедиться: middleware пропустил запрос.
    const res = await request(app)
      .post('/webhook/max')
      .set('X-Max-Bot-Api-Secret', TEST_SECRET)
      .send({});
    expect(res.status).toBe(400);
  });
});

// /api/install — server-to-server ONAPPINSTALL Б24 (M19): подлинность доказывает обмен
// refresh_token (стаб exchangeRefreshToken, без сети). Pool отдаёт пустую БД на SELECT и
// валидную строку на INSERT … RETURNING; capturing-логгер проверяет, что токены не логируются.
describe('POST /api/install (smoke, M19)', () => {
  const PORTAL = 'smoke.bitrix24.ru';
  const INSTALLED_ROW = {
    id: 1,
    b24_portal: PORTAL,
    b24_access_token: 'exchangedaccess1',
    b24_refresh_token: 'exchangedrefresh',
    b24_application_token: 'apptokensmoke001',
    b24_member_id: null,
    ol_line_id: null,
    connector_id: null,
    max_bot_id: null,
    created_at: null,
    updated_at: null,
  };

  class InstallFakePool {
    constructor() {
      this.writes = [];
    }

    async query(sql) {
      if (/^\s*SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
      this.writes.push(sql);
      return { rows: [INSTALLED_ROW], rowCount: 1 };
    }
  }

  function exchangeStub() {
    return vi.fn(async () => ({
      accessToken: 'exchangedaccess1',
      refreshToken: 'exchangedrefresh',
      memberId: 'membersmoke00001',
      clientEndpoint: `https://${PORTAL}/rest/`,
    }));
  }

  function onAppInstall(authOverrides = {}) {
    return {
      event: 'ONAPPINSTALL',
      auth: {
        domain: PORTAL,
        access_token: 'accesssmoke00001',
        refresh_token: 'refreshsmoke0001',
        application_token: 'apptokensmoke001',
        member_id: 'membersmoke00001',
        ...authOverrides,
      },
    };
  }

  function buildInstallApp({ creds = true, exchange = exchangeStub(), rateLimit } = {}) {
    const logs = [];
    const stream = { write: (line) => logs.push(line) };
    const logger = pino({ level: 'info' }, stream);
    const pool = new InstallFakePool();
    const config = Object.freeze({
      ...buildTestConfig({ b24Portal: PORTAL, b24Creds: creds }),
      ...(rateLimit ? { rateLimit } : {}),
    });
    const app = buildApp(config, { pool, logger, exchangeRefreshToken: exchange });
    return { app, logs, pool, exchange };
  }

  it('валидный ONAPPINSTALL (JSON) → 200, обмен и запись', async () => {
    const { app, pool, exchange } = buildInstallApp();
    const res = await request(app).post('/api/install').send(onAppInstall());
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('All success');
    expect(res.body.installation).toEqual({ id: 1, portal: PORTAL });
    expect(exchange).toHaveBeenCalledOnce();
    expect(pool.writes.length).toBeGreaterThan(0);
  });

  it('валидный ONAPPINSTALL в form-urlencoded (как шлёт Б24: auth[domain]=…) → 200', async () => {
    const { app } = buildInstallApp();
    const form = new URLSearchParams({
      event: 'ONAPPINSTALL',
      'auth[domain]': PORTAL,
      'auth[access_token]': 'accesssmoke00001',
      'auth[refresh_token]': 'refreshsmoke0001',
      'auth[application_token]': 'apptokensmoke001',
      'auth[member_id]': 'membersmoke00001',
    }).toString();
    const res = await request(app)
      .post('/api/install')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form);
    expect(res.status).toBe(200);
  });

  it('дубли auth[domain] в form-urlencoded (qs → массив) → 400, без обмена', async () => {
    const { app, exchange, pool } = buildInstallApp();
    const res = await request(app)
      .post('/api/install')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(
        `event=ONAPPINSTALL&auth[domain]=${PORTAL}&auth[domain]=evil.example&auth[refresh_token]=refreshsmoke0001&auth[application_token]=apptokensmoke001`,
      );
    expect(res.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    expect(pool.writes).toEqual([]);
  });

  it.each([
    ['пустое тело', {}, 400],
    ['form-style DOMAIN/AUTH_ID (снят)', { DOMAIN: PORTAL, AUTH_ID: 'accesssmoke00001', REFRESH_ID: 'refreshsmoke0001' }, 400],
    ['без токенов', onAppInstall({ access_token: undefined, refresh_token: undefined, application_token: undefined }), 400],
    ['только application_token (не с чем сверить)', onAppInstall({ access_token: undefined, refresh_token: undefined }), 401],
    ['чужой домен', onAppInstall({ domain: 'evil.bitrix24.ru' }), 401],
  ])('%s → %i, без обмена и записи', async (_label, payload, status) => {
    const { app, exchange, pool } = buildInstallApp();
    const res = await request(app).post('/api/install').send(payload);
    expect(res.status).toBe(status);
    expect(exchange).not.toHaveBeenCalled();
    expect(pool.writes).toEqual([]);
  });

  it('OAuth отверг refresh_token → 401, без записи', async () => {
    const exchange = vi.fn(async () => {
      throw new B24ApiError('OAUTH_REJECTED', 'invalid_grant', { body: { error: 'invalid_grant' } });
    });
    const { app, pool } = buildInstallApp({ exchange });
    const res = await request(app).post('/api/install').send(onAppInstall());
    expect(res.status).toBe(401);
    expect(pool.writes).toEqual([]);
  });

  it('B24_CLIENT_ID/SECRET не заданы → 503 (fail-closed)', async () => {
    const { app, exchange } = buildInstallApp({ creds: false });
    const res = await request(app).post('/api/install').send(onAppInstall());
    expect(res.status).toBe(503);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('#6: install сверх лимита → 429', async () => {
    const { app } = buildInstallApp({
      rateLimit: { installWindowMs: 60_000, installMax: 2, webhookWindowMs: 60_000, webhookMax: 1000 },
    });
    await request(app).post('/api/install').send(onAppInstall());
    await request(app).post('/api/install').send(onAppInstall());
    const third = await request(app).post('/api/install').send(onAppInstall());
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('M20: install — общий потолок для разных IP (защита client_id от потока invalid_grant)', async () => {
    const { app } = buildInstallApp({
      rateLimit: { installWindowMs: 60_000, installMax: 2, webhookWindowMs: 60_000, webhookMax: 1000 },
    });
    const from = (ip) =>
      request(app).post('/api/install').set('X-Forwarded-For', ip).send(onAppInstall());
    await from('203.0.113.1');
    await from('203.0.113.2');
    const third = await from('203.0.113.3');
    expect(third.status).toBe(429);
  });

  it('логи: только has*-флаги, значения токенов не утекают ни в один лог-лайн', async () => {
    const { app, logs } = buildInstallApp();
    await request(app).post('/api/install').send(onAppInstall());

    const entries = logs.map((l) => JSON.parse(l));
    const installLog = entries.find((e) => e.msg === 'install request received');
    expect(installLog).toMatchObject({ hasAccess: true, hasRefresh: true, hasApplicationToken: true });

    const allLogs = logs.join('\n');
    for (const secret of ['accesssmoke00001', 'refreshsmoke0001', 'apptokensmoke001', 'exchangedaccess1', 'exchangedrefresh']) {
      expect(allLogs).not.toContain(secret);
    }
  });
});

// M20: периметр. Supertest ходит с loopback → при дефолтном trust proxy (loopback,
// uniquelocal) X-Forwarded-For доверяется и задаёт req.ip — так эмулируем разных
// клиентов за Caddy. webhookMax: 2 — третий запрос из одного бакета получает 429.
describe('M20 периметр: реальный IP и раздельные лимитеры (smoke)', () => {
  const SECRET = 'test-max-secret-1234567890';
  const TIGHT = Object.freeze({
    installWindowMs: 60_000,
    installMax: 1000,
    webhookWindowMs: 60_000,
    webhookMax: 2,
  });

  function buildPerimeterApp({ trustProxy } = {}) {
    const logs = [];
    const logger = pino({ level: 'info' }, { write: (line) => logs.push(line) });
    const base = buildTestConfig({ maxWebhookSecret: SECRET });
    const config = Object.freeze({
      ...base,
      http: trustProxy === undefined ? base.http : { ...base.http, trustProxy },
      rateLimit: TIGHT,
    });
    return { app: buildApp(config, { pool: new FakePool(), logger }), logs };
  }

  // Без токена в БД/env контроллер Б24 отвечает 503 — нам важно лишь «не 429».
  const b24From = (app, ip) =>
    request(app)
      .post('/webhook/b24')
      .set('X-Forwarded-For', ip)
      .send({ event: 'OnImConnectorMessageAdd', auth: { application_token: 'whatever' } });
  // Верный секрет + пустое тело → контроллер MAX отвечает 400 (лимитер пройден).
  const maxFrom = (app, ip, secret = SECRET) =>
    request(app)
      .post('/webhook/max')
      .set('X-Forwarded-For', ip)
      .set('X-Max-Bot-Api-Secret', secret)
      .send({});

  it('разные IP → разные бакеты', async () => {
    const { app } = buildPerimeterApp();
    await b24From(app, '203.0.113.1');
    await b24From(app, '203.0.113.1');
    expect((await b24From(app, '203.0.113.1')).status).toBe(429);
    expect((await b24From(app, '203.0.113.2')).status).toBe(503);
  });

  it('/webhook/max: неверный секрет → 401 и квоту не расходует', async () => {
    const { app } = buildPerimeterApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await maxFrom(app, '203.0.113.1', 'wrong-secret-value')).status).toBe(401);
    }
    expect((await maxFrom(app, '203.0.113.1')).status).toBe(400);
  });

  it('бакеты /webhook/max и /webhook/b24 независимы', async () => {
    const { app } = buildPerimeterApp();
    await b24From(app, '203.0.113.1');
    await b24From(app, '203.0.113.1');
    expect((await b24From(app, '203.0.113.1')).status).toBe(429);
    expect((await maxFrom(app, '203.0.113.1')).status).toBe(400);
  });

  it('TRUST_PROXY=false: X-Forwarded-For игнорируется, все в одном бакете', async () => {
    const { app } = buildPerimeterApp({ trustProxy: false });
    await b24From(app, '203.0.113.1');
    await b24From(app, '203.0.113.2');
    expect((await b24From(app, '203.0.113.3')).status).toBe(429);
  });

  it('access-лог: ip клиента (с учётом trust proxy) и remoteAddress сокета', async () => {
    const { app, logs } = buildPerimeterApp();
    await request(app).get('/health').set('X-Forwarded-For', '198.51.100.7');
    const done = logs.map((l) => JSON.parse(l)).find((e) => e.req?.url === '/health' && e.res);
    expect(done.req.ip).toBe('198.51.100.7');
    expect(done.req.remoteAddress).toMatch(/127\.0\.0\.1|::1/);
  });
});
