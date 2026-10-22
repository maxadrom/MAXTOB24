// M8: публичный health-эндпоинт для внешнего мониторинга и Caddy-проб.
// Контракт: GET /health отвечает 200 без auth; JWT-only GET /api/health стартера
// снят (M13) — 404. Мок-пул вместо реального Postgres (health stateless).

import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import pino from 'pino';

import { buildApp } from '../../src/app.js';

class FakePool {
  async query() {
    return { rows: [] };
  }
}

function buildTestConfig() {
  return Object.freeze({
    env: 'test',
    http: { port: 0 },
    db: { url: 'postgresql://test', host: null, port: null, name: null, user: null, password: null },
    log: { level: 'silent', levelFallback: false, originalLevel: null },
    max: {
      botToken: null,
      webhookSecret: null,
      apiBaseUrl: 'https://dev.max.ru/api',
      publicWebhookUrl: null,
      webhookUpdateTypes: ['message_created'],
    },
    b24: { portal: null, clientId: null, clientSecret: null, applicationToken: null, olLineId: null },
    optional: {},
  });
}

describe('public /health (M8)', () => {
  let app;

  beforeAll(() => {
    const config = buildTestConfig();
    const logger = pino({ level: 'silent' });
    const pool = new FakePool();
    app = buildApp(config, { pool, logger });
  });

  it('GET /health returns 200 healthy WITHOUT Authorization header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.backend).toBe('node');
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('GET /api/health is no longer mounted (M13: JWT-зона удалена) — 404', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(404);
  });
});
