// Smoke-тесты scripts/register-webhook.js. runScript({argv, deps: {config, logger, maxClient}})
// тестируется без process.exit — DI-граф собирается из переданных deps.
// Шаблон — register-connector.smoke.test.js, но без БД (скрипт регистрации
// webhook не трогает Postgres).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runScript } from '../../scripts/register-webhook.js';

const PUBLIC_URL = 'https://example.test/webhook/max';
const SECRET = 'webhook-secret-1234567890';
const TOKEN = 'max-bot-token-XYZ';
const UPDATE_TYPES = ['message_created', 'bot_added', 'bot_removed', 'user_added', 'user_removed'];

function silentLogger() {
  const make = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => make(),
  });
  return make();
}

function buildConfig(overrides = {}) {
  return {
    env: 'test',
    http: { port: 8000 },
    db: {},
    log: { level: 'silent' },
    max: {
      botToken: TOKEN,
      webhookSecret: SECRET,
      apiBaseUrl: 'https://dev.max.ru/api',
      publicWebhookUrl: PUBLIC_URL,
      webhookUpdateTypes: UPDATE_TYPES,
      ...overrides.max,
    },
    b24: {},
    optional: {},
  };
}

function fakeMaxClient(overrides = {}) {
  return {
    listSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
    subscribe: vi.fn(async () => ({ success: true })),
    removeSubscription: vi.fn(async () => ({ success: true })),
    getChatMember: vi.fn(async () => ({})),
    hasToken: () => true,
    ...overrides,
  };
}

describe('register-webhook smoke', () => {
  let logger;
  let stdoutSpy;

  beforeEach(() => {
    logger = silentLogger();
    // Скрипт пишет JSON в process.stdout в режиме --list. Глушим вывод теста.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('1) default mode + новая подписка: subscribe вызван с правильными args', async () => {
    const maxClient = fakeMaxClient();
    const result = await runScript({
      argv: ['node', 'script'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.listSubscriptions).toHaveBeenCalledOnce();
    expect(maxClient.subscribe).toHaveBeenCalledWith({
      url: PUBLIC_URL,
      secret: SECRET,
      updateTypes: UPDATE_TYPES,
    });
    expect(maxClient.removeSubscription).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      mode: 'register',
      alreadySubscribed: false,
    });
  });

  it('2) default mode + уже подписан: subscribe НЕ вызван, return alreadySubscribed=true', async () => {
    const maxClient = fakeMaxClient({
      listSubscriptions: vi.fn(async () => ({
        subscriptions: [{ url: PUBLIC_URL, update_types: UPDATE_TYPES, time: 1 }],
      })),
    });
    const result = await runScript({
      argv: ['node', 'script'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.subscribe).not.toHaveBeenCalled();
    expect(result.alreadySubscribed).toBe(true);
    expect(result.mode).toBe('register');
  });

  it('2a) M24: уже подписан, но update_types расходятся → без записи, warn с missing/extra', async () => {
    const maxClient = fakeMaxClient({
      listSubscriptions: vi.fn(async () => ({
        subscriptions: [{ url: PUBLIC_URL, update_types: ['message_created', 'bot_added', 'message_callback'] }],
      })),
    });
    const result = await runScript({
      argv: ['node', 'script'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.subscribe).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      alreadySubscribed: true,
      missing: ['bot_removed', 'user_added', 'user_removed'],
      extra: ['message_callback'],
    });
  });

  it('2b) M24: --force поверх существующей подписки → повторный POST с update_types из конфига', async () => {
    const maxClient = fakeMaxClient({
      listSubscriptions: vi.fn(async () => ({
        subscriptions: [{ url: PUBLIC_URL, update_types: ['message_created'] }],
      })),
    });
    const result = await runScript({
      argv: ['node', 'script', '--force'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.subscribe).toHaveBeenCalledWith({
      url: PUBLIC_URL,
      secret: SECRET,
      updateTypes: UPDATE_TYPES,
    });
    expect(result).toMatchObject({ ok: true, mode: 'register', alreadySubscribed: true, forced: true });
  });

  it('2c) --force вместе с --list/--unregister → throw', async () => {
    for (const flag of ['--list', '--unregister']) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        runScript({ argv: ['node', 'script', '--force', flag], deps: { config: buildConfig(), logger, maxClient: fakeMaxClient() } }),
      ).rejects.toThrow(/--force is only for register mode/);
    }
  });

  it('3) --list: subscribe/remove не вызваны, stdout получает JSON', async () => {
    const subs = { subscriptions: [{ url: PUBLIC_URL, update_types: UPDATE_TYPES }] };
    const maxClient = fakeMaxClient({
      listSubscriptions: vi.fn(async () => subs),
    });

    const result = await runScript({
      argv: ['node', 'script', '--list'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.listSubscriptions).toHaveBeenCalledOnce();
    expect(maxClient.subscribe).not.toHaveBeenCalled();
    expect(maxClient.removeSubscription).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy.mock.calls[0][0]).toContain(PUBLIC_URL);
    expect(result.mode).toBe('list');
  });

  it('4) --unregister: removeSubscription вызван c правильным url', async () => {
    const maxClient = fakeMaxClient();
    const result = await runScript({
      argv: ['node', 'script', '--unregister'],
      deps: { config: buildConfig(), logger, maxClient },
    });

    expect(maxClient.removeSubscription).toHaveBeenCalledWith({ url: PUBLIC_URL });
    expect(maxClient.subscribe).not.toHaveBeenCalled();
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
    expect(result.mode).toBe('unregister');
  });

  it('5) --list + --unregister → throw mutually exclusive', async () => {
    const maxClient = fakeMaxClient();
    await expect(
      runScript({
        argv: ['node', 'script', '--list', '--unregister'],
        deps: { config: buildConfig(), logger, maxClient },
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
  });

  it('6) без MAX_BOT_TOKEN → throw в начале, fetch не вызывается', async () => {
    const maxClient = fakeMaxClient();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: { config: buildConfig({ max: { botToken: null } }), logger, maxClient },
      }),
    ).rejects.toThrow(/MAX_BOT_TOKEN is not set/);
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
  });

  it('7) без MAX_PUBLIC_WEBHOOK_URL (default mode) → throw', async () => {
    const maxClient = fakeMaxClient();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: { config: buildConfig({ max: { publicWebhookUrl: null } }), logger, maxClient },
      }),
    ).rejects.toThrow(/MAX_PUBLIC_WEBHOOK_URL is not set/);
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
  });

  it('8) MAX_PUBLIC_WEBHOOK_URL="http://..." → throw про https', async () => {
    const maxClient = fakeMaxClient();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: {
          config: buildConfig({ max: { publicWebhookUrl: 'http://example.test/webhook/max' } }),
          logger,
          maxClient,
        },
      }),
    ).rejects.toThrow(/must start with https:\/\//);
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
  });

  it('9) без MAX_WEBHOOK_SECRET (default mode) → throw', async () => {
    const maxClient = fakeMaxClient();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: { config: buildConfig({ max: { webhookSecret: null } }), logger, maxClient },
      }),
    ).rejects.toThrow(/MAX_WEBHOOK_SECRET is not set/);
    expect(maxClient.listSubscriptions).not.toHaveBeenCalled();
  });

  it('10) --list без publicWebhookUrl — НЕ должен бросать (URL не нужен для list)', async () => {
    const maxClient = fakeMaxClient();
    const result = await runScript({
      argv: ['node', 'script', '--list'],
      deps: {
        config: buildConfig({ max: { publicWebhookUrl: null, webhookSecret: null } }),
        logger,
        maxClient,
      },
    });

    expect(maxClient.listSubscriptions).toHaveBeenCalledOnce();
    expect(result.mode).toBe('list');
  });
});
