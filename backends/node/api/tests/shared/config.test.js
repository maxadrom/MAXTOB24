import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_ROOT_ENV,
  loadConfig,
  loadDotenvOnce,
  logConfigWarnings,
} from '../../src/shared/config/index.js';

function withEnv(overrides, fn) {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe('shared/config', () => {
  // M26: loadConfig() грузит корневой .env один раз на модуль. Корневой .env уже в env
  // (его грузит globalSetup), прогрев делает загрузку no-op — иначе первый loadConfig()
  // теста, удалившего DATABASE_URL/DB_*, вернул бы их из файла (override:false).
  beforeAll(() => {
    loadDotenvOnce();
  });

  let originalEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when DATABASE_URL and full DB_* are both missing', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_NAME;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    expect(() => loadConfig()).toThrow(/DATABASE_URL is required/);
  });

  it('JWT_SECRET не нужен: JWT-зоны нет', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/db';
    delete process.env.JWT_SECRET;
    expect(loadConfig()).not.toHaveProperty('jwt');
  });

  it('accepts DATABASE_URL with Doctrine-style query params', () => {
    const url = 'postgresql://appuser:apppass@database:5432/appdb?serverVersion=17&charset=utf8';
    withEnv({ DATABASE_URL: url }, () => {
      const cfg = loadConfig();
      expect(cfg.db.url).toBe(url);
    });
  });

  it('API_PORT takes precedence over PORT (avoids collision with a stray PORT=3000)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        API_PORT: '8000',
        PORT: '3000',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.http.port).toBe(8000);
      },
    );
  });

  it('falls back to PORT when API_PORT is unset', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        API_PORT: undefined,
        PORT: '8000',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.http.port).toBe(8000);
      },
    );
  });

  it('marks LOG_LEVEL fallback when value is invalid', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        LOG_LEVEL: 'shouty',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.log.levelFallback).toBe(true);
        expect(cfg.log.level).toBe('info');
        expect(cfg.log.originalLevel).toBe('shouty');
      },
    );
  });

  it('parses MAX_WEBHOOK_UPDATE_TYPES CSV into array (M3)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_WEBHOOK_UPDATE_TYPES: 'message_created, bot_added , bot_removed',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.max.webhookUpdateTypes).toEqual([
          'message_created',
          'bot_added',
          'bot_removed',
        ]);
      },
    );
  });

  it('falls back to default MAX_WEBHOOK_UPDATE_TYPES when env is unset (M3)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_WEBHOOK_UPDATE_TYPES: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.max.webhookUpdateTypes).toEqual([
          'message_created',
          'message_edited',
          'message_removed',
          'bot_added',
          'bot_removed',
          'user_added',
          'user_removed',
          'chat_title_changed',
        ]);
      },
    );
  });

  it('exposes MAX_PUBLIC_WEBHOOK_URL via config.max.publicWebhookUrl (M3)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_PUBLIC_WEBHOOK_URL: 'https://example.com/webhook/max',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.max.publicWebhookUrl).toBe('https://example.com/webhook/max');
      },
    );
  });

  // ── M11.2: media-флоу config (upload retry + лимит размера) ──────────────────
  it('media: falls back to defaults when media env is unset (M11.2)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_UPLOAD_MAX_RETRIES: undefined,
        MAX_UPLOAD_RETRY_BASE_MS: undefined,
        MAX_UPLOAD_RETRY_FACTOR: undefined,
        MEDIA_MAX_BYTES: undefined,
        MEDIA_TRANSFER_TIMEOUT_MS: undefined,
        MEDIA_CONCURRENCY: undefined,
        MEDIA_TMP_DIR: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.media).toEqual({
          maxUploadMaxRetries: 14,
          maxUploadRetryBaseMs: 1000,
          maxUploadRetryFactor: 2,
          // M22: 256 МиБ, поток через диск.
          maxBytes: 256 * 1024 * 1024,
          transferTimeoutMs: 300_000,
          concurrency: 2,
          tmpDir: path.join(os.tmpdir(), 'maxtob24-media'),
        });
      },
    );
  });

  it('media: parses overrides from env (M11.2)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_UPLOAD_MAX_RETRIES: '3',
        MAX_UPLOAD_RETRY_BASE_MS: '500',
        MAX_UPLOAD_RETRY_FACTOR: '3',
        MEDIA_MAX_BYTES: '1048576',
        MEDIA_TRANSFER_TIMEOUT_MS: '60000',
        MEDIA_CONCURRENCY: '1',
        MEDIA_TMP_DIR: '/data/media-tmp',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.media.maxUploadMaxRetries).toBe(3);
        expect(cfg.media.maxUploadRetryBaseMs).toBe(500);
        expect(cfg.media.maxUploadRetryFactor).toBe(3);
        expect(cfg.media.maxBytes).toBe(1048576);
        expect(cfg.media.transferTimeoutMs).toBe(60000);
        expect(cfg.media.concurrency).toBe(1);
        expect(cfg.media.tmpDir).toBe('/data/media-tmp');
      },
    );
  });

  it('media: MEDIA_CONCURRENCY не целое → ошибка старта (M22)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MEDIA_CONCURRENCY: '1.5',
      },
      () => {
        expect(() => loadConfig()).toThrow(/MEDIA_CONCURRENCY must be a positive integer/);
      },
    );
  });

  it('media: invalid value → clear startup error (M11.2)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MEDIA_MAX_BYTES: 'not-a-number',
      },
      () => {
        expect(() => loadConfig()).toThrow(/MEDIA_MAX_BYTES must be a positive number/);
      },
    );
  });

  it('media: non-positive value → clear startup error (M11.2)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_UPLOAD_MAX_RETRIES: '0',
      },
      () => {
        expect(() => loadConfig()).toThrow(/MAX_UPLOAD_MAX_RETRIES must be a positive number/);
      },
    );
  });

  // ── M29: очередь исходящих по чату и дренаж при остановке ────────────────────
  describe('M29: OUTBOUND_QUEUE_MAX, SHUTDOWN_DRAIN_TIMEOUT_MS', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@h:5432/db' };

    it('не заданы → дефолты: очередь чата 20, дренаж 170 с', () => {
      withEnv({ ...base, OUTBOUND_QUEUE_MAX: undefined, SHUTDOWN_DRAIN_TIMEOUT_MS: undefined }, () => {
        const cfg = loadConfig();
        expect(cfg.outbound).toEqual({ queueMax: 20 });
        expect(cfg.shutdown).toEqual({ drainTimeoutMs: 170_000 });
      });
    });

    it('переопределяются из env', () => {
      withEnv({ ...base, OUTBOUND_QUEUE_MAX: '5', SHUTDOWN_DRAIN_TIMEOUT_MS: '55000' }, () => {
        const cfg = loadConfig();
        expect(cfg.outbound.queueMax).toBe(5);
        expect(cfg.shutdown.drainTimeoutMs).toBe(55_000);
      });
    });

    it('OUTBOUND_QUEUE_MAX больше предела → зажимается до 1000', () => {
      withEnv({ ...base, OUTBOUND_QUEUE_MAX: '5000' }, () => {
        expect(loadConfig().outbound.queueMax).toBe(1000);
      });
    });

    it.each(['abc', '0', '-3', '2.5'])('OUTBOUND_QUEUE_MAX=%s → ошибка старта', (raw) => {
      withEnv({ ...base, OUTBOUND_QUEUE_MAX: raw }, () => {
        expect(() => loadConfig()).toThrow(/OUTBOUND_QUEUE_MAX must be a positive integer/);
      });
    });

    it.each(['-1', '0', 'abc'])('SHUTDOWN_DRAIN_TIMEOUT_MS=%s → ошибка старта', (raw) => {
      withEnv({ ...base, SHUTDOWN_DRAIN_TIMEOUT_MS: raw }, () => {
        expect(() => loadConfig()).toThrow(/SHUTDOWN_DRAIN_TIMEOUT_MS must be a positive number/);
      });
    });

    it('оба — в карте опциональных env', () => {
      withEnv({ ...base, OUTBOUND_QUEUE_MAX: '7', SHUTDOWN_DRAIN_TIMEOUT_MS: undefined }, () => {
        const cfg = loadConfig();
        expect(cfg.optional.OUTBOUND_QUEUE_MAX).toBe(true);
        expect(cfg.optional.SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(false);
      });
    });
  });

  // ── Reply-флоу config (двусторонний мост «ответ на сообщение») ───────────────
  it('reply: falls back to defaults when reply env is unset', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        B24_REPLY_RESOLVE_OUTBOUND: undefined,
        REPLY_SEARCH_LIMIT: undefined,
        REPLY_QUOTE_MAX_LEN: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.reply).toEqual({
          resolveOutbound: true,
          searchLimit: 50,
          quoteMaxLen: 200,
        });
      },
    );
  });

  it('reply: parses overrides from env (bool + ints)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        B24_REPLY_RESOLVE_OUTBOUND: 'false',
        REPLY_SEARCH_LIMIT: '120',
        REPLY_QUOTE_MAX_LEN: '64',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.reply.resolveOutbound).toBe(false);
        expect(cfg.reply.searchLimit).toBe(120);
        expect(cfg.reply.quoteMaxLen).toBe(64);
      },
    );
  });

  it('reply: searchLimit clamps to 200 (B24 doc LIMIT max)', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        REPLY_SEARCH_LIMIT: '500',
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.reply.searchLimit).toBe(200);
      },
    );
  });

  it('reply: invalid searchLimit → clear startup error', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        REPLY_SEARCH_LIMIT: '0',
      },
      () => {
        expect(() => loadConfig()).toThrow(/REPLY_SEARCH_LIMIT must be a positive integer/);
      },
    );
  });

  it('reply: B24_REPLY_RESOLVE_OUTBOUND accepts 1/0', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        B24_REPLY_RESOLVE_OUTBOUND: '0',
      },
      () => {
        expect(loadConfig().reply.resolveOutbound).toBe(false);
      },
    );
  });

  describe('M20: TRUST_PROXY', () => {
    const BASE = { DATABASE_URL: 'postgresql://u:p@h:5432/db' };

    it('не задан → loopback + uniquelocal (Caddy → docker-proxy → шлюз bridge)', () => {
      withEnv({ ...BASE, TRUST_PROXY: undefined }, () => {
        expect(loadConfig().http.trustProxy).toEqual(['loopback', 'uniquelocal']);
      });
    });

    it.each([
      ['loopback, 172.19.0.0/16', ['loopback', '172.19.0.0/16']],
      ['10.0.0.1,fd00::/8', ['10.0.0.1', 'fd00::/8']],
      ['false', false],
      ['FALSE', false],
      ['1', 1],
    ])('%s → %j', (raw, expected) => {
      withEnv({ ...BASE, TRUST_PROXY: raw }, () => {
        expect(loadConfig().http.trustProxy).toEqual(expected);
      });
    });

    it.each(['true', 'TRUE', '*'])('%s → ошибка старта (XFF подделывается)', (raw) => {
      withEnv({ ...BASE, TRUST_PROXY: raw }, () => {
        expect(() => loadConfig()).toThrow(/TRUST_PROXY="[^"]+" trusts any X-Forwarded-For/);
      });
    });

    it.each(['caddy', '172.19.0.0/33', '10.0.0.1/abc', '1.2.3.4/8/9', ' , '])(
      '%j → ошибка старта',
      (raw) => {
        withEnv({ ...BASE, TRUST_PROXY: raw }, () => {
          expect(() => loadConfig()).toThrow(/TRUST_PROXY must be/);
        });
      },
    );
  });

  it('M20: дефолт MAX_API_BASE_URL — platform-api2.max.ru (не сайт доки dev.max.ru/api)', () => {
    withEnv(
      { DATABASE_URL: 'postgresql://u:p@h:5432/db', MAX_API_BASE_URL: undefined },
      () => {
        expect(loadConfig().max.apiBaseUrl).toBe('https://platform-api2.max.ru');
      },
    );
  });

  it.each([
    ['platform-api2 без NODE_EXTRA_CA_CERTS → warn', 'https://platform-api2.max.ru', undefined, true],
    ['platform-api2 с NODE_EXTRA_CA_CERTS → без warn', 'https://platform-api2.max.ru', '/app/certs/ca.pem', false],
    ['botapi (публичный CA) → без warn', 'https://botapi.max.ru', undefined, false],
  ])('M20: %s', (_label, apiBaseUrl, caFile, warned) => {
    const warns = [];
    const logger = { info() {}, debug() {}, warn: (_obj, msg) => warns.push(msg) };
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_API_BASE_URL: apiBaseUrl,
        NODE_EXTRA_CA_CERTS: caFile,
      },
      () => {
        const cfg = loadConfig({ logger });
        expect(cfg.max.caMissing).toBe(warned);
        expect(warns.some((msg) => msg.includes('Russian Trusted Root CA'))).toBe(warned);
        // server.js зовёт loadConfig() без логгера и предупреждения — отдельно.
        const serverWarns = [];
        logConfigWarnings(cfg, { warn: (_obj, msg) => serverWarns.push(msg) });
        expect(serverWarns.some((msg) => msg.includes('Russian Trusted Root CA'))).toBe(warned);
      },
    );
  });

  it('exposes optional env presence without throwing', () => {
    withEnv(
      {
        DATABASE_URL: 'postgresql://u:p@h:5432/db',
        MAX_BOT_TOKEN: 'token-xyz',
        // Изолируемся от родительского .env: тест проверяет, что отсутствующая
        // OPTIONAL_ENV-переменная даёт cfg.optional.<KEY> === false. Если .env
        // в корне задаёт B24_PORTAL/OL_LINE_ID/MAX_WEBHOOK_SECRET — тест ложно
        // увидит их как `true`. Принудительно сбрасываем всё, кроме MAX_BOT_TOKEN.
        MAX_WEBHOOK_SECRET: undefined,
        MAX_API_BASE_URL: undefined,
        MAX_PUBLIC_WEBHOOK_URL: undefined,
        MAX_WEBHOOK_UPDATE_TYPES: undefined,
        B24_PORTAL: undefined,
        B24_CLIENT_ID: undefined,
        B24_CLIENT_SECRET: undefined,
        B24_APPLICATION_TOKEN: undefined,
        OL_LINE_ID: undefined,
        B24_CONNECTOR_ID: undefined,
        B24_CONNECTOR_NAME: undefined,
        B24_PLACEMENT_HANDLER_URL: undefined,
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.optional.MAX_BOT_TOKEN).toBe(true);
        expect(cfg.optional.B24_PORTAL).toBe(false);
        expect(cfg.max.botToken).toBe('token-xyz');
      },
    );
  });
});

describe('loadDotenvOnce (M26)', () => {
  const PROBE_KEYS = ['M26_DOTENV_PROBE', 'M26_DOTENV_PROBE_KEEP'];
  let dir;
  let envFile;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'm26-dotenv-test-'));
    envFile = path.join(dir, '.env');
    await writeFile(envFile, 'M26_DOTENV_PROBE=from-file\nM26_DOTENV_PROBE_KEEP=from-file\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const key of PROBE_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  // Флаг «уже загружено» живёт в модуле: каждому тесту — свежий экземпляр.
  async function freshConfigModule() {
    vi.resetModules();
    return import('../../src/shared/config/index.js');
  }

  it('PROJECT_ROOT_ENV лежит в корне репо, а не в backends/', () => {
    // Сравнение с той же формулой path.resolve было бы тавтологией: ошибку на уровень
    // не поймало бы. Корень узнаём по файлам, которые есть только в нём.
    const root = path.dirname(PROJECT_ROOT_ENV);
    expect(path.basename(PROJECT_ROOT_ENV)).toBe('.env');
    expect(fs.existsSync(path.join(root, 'docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'backends', 'node', 'api', 'package.json'))).toBe(true);
  });

  it('читает файл один раз на процесс', async () => {
    const { loadDotenvOnce: load } = await freshConfigModule();
    expect(load({ path: envFile })).toBe(true);
    expect(process.env.M26_DOTENV_PROBE).toBe('from-file');
    expect(load({ path: envFile })).toBe(false);
  });

  it('не перебивает env процесса (override:false)', async () => {
    process.env.M26_DOTENV_PROBE_KEEP = 'env';
    const { loadDotenvOnce: load } = await freshConfigModule();
    load({ path: envFile });
    expect(process.env.M26_DOTENV_PROBE_KEEP).toBe('env');
    expect(process.env.M26_DOTENV_PROBE).toBe('from-file');
  });

  it('не пишет в stdout (quiet): ни с файлом, ни без него', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await freshConfigModule();
    first.loadDotenvOnce({ path: envFile });
    const second = await freshConfigModule();
    second.loadDotenvOnce({ path: path.join(dir, 'missing.env') });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
