// Smoke-тесты scripts/register-connector.js. Импортируем runScript({argv, deps})
// напрямую — DI-граф собирается из переданных deps. Реальный pg-pool используется
// (нужен для seed installations); B24- и MAX-клиенты подменяются.
// Skip-policy: интеграционная часть пропускается, если Postgres недоступен.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runScript } from '../../scripts/register-connector.js';
import { InstallationsRepository } from '../../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../../src/modules/installations/installationsService.js';
import { B24_CONNECTOR_DEFAULTS } from '../../src/modules/b24/b24Constants.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

const PORTAL = 'example.bitrix24.ru';

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

function fakeConfig() {
  return {
    env: 'test',
    http: { port: 8000 },
    db: {},
    log: { level: 'silent' },
    max: {
      botToken: null,
      webhookSecret: null,
      apiBaseUrl: 'https://dev.max.ru/api',
    },
    b24: {
      portal: PORTAL,
      clientId: null,
      clientSecret: null,
      applicationToken: null,
      olLineId: 42,
      connectorId: 'max_b24',
      connectorName: 'MAX (group chats)',
      placementHandlerUrl: 'https://example.test/b24/connector-settings',
    },
  };
}

function fakeB24Client(overrides = {}) {
  return {
    imconnectorList: vi.fn(async () => ({})),
    imconnectorRegister: vi.fn(async () => ({ result: true })),
    imconnectorActivate: vi.fn(async () => ({ result: true })),
    imconnectorDeactivate: vi.fn(async () => ({ result: true })),
    imconnectorUnregister: vi.fn(async () => ({ result: true })),
    ...overrides,
  };
}

async function seedInstallation(repo) {
  const installation = await repo.upsertByPortal({ portal: PORTAL });
  await repo.updateTokens(installation.id, {
    access: 'fake-access-token',
    refresh: null,
    applicationToken: null,
  });
  return installation;
}

describe.skipIf(shouldSkipDb())('register-connector smoke', () => {
  let pool;
  let repo;
  let installations;
  let logger;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    logger = silentLogger();
    repo = new InstallationsRepository(pool, null);
    installations = new InstallationsService(repo, null);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) register happy path: register + activate, installations обновлены', async () => {
    await seedInstallation(repo);
    const b24Client = fakeB24Client();
    // Используем B24Service из реального графа: deps.b24Client уже мокаем,
    // поэтому передаём готовый сервис.
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });

    const result = await runScript({
      argv: ['node', 'script'],
      deps: {
        config: fakeConfig(),
        logger,
        pool,
        installationsRepo: repo,
        installations,
        b24Client,
        b24,
      },
    });

    expect(b24Client.imconnectorRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'max_b24',
        placementHandlerUrl: 'https://example.test/b24/connector-settings',
        chatGroup: true,
        needSignature: true,
      }),
    );
    expect(b24Client.imconnectorActivate).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      active: true,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('register');

    const refreshed = await repo.findByPortal(PORTAL);
    expect(refreshed.connectorId).toBe('max_b24');
    expect(refreshed.olLineId).toBe(42);
    expect(refreshed.b24AccessToken).toBe('fake-access-token');
  });

  it('2) register idempotent: list содержит max_b24 → register пропущен, activate вызван, wasAlreadyRegistered=true', async () => {
    await seedInstallation(repo);
    const b24Client = fakeB24Client({
      imconnectorList: vi.fn(async () => ({ max_b24: 'MAX (group chats)' })),
    });
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });

    const result = await runScript({
      argv: ['node', 'script'],
      deps: {
        config: fakeConfig(),
        logger,
        pool,
        installationsRepo: repo,
        installations,
        b24Client,
        b24,
      },
    });

    expect(b24Client.imconnectorRegister).not.toHaveBeenCalled();
    expect(b24Client.imconnectorActivate).toHaveBeenCalledTimes(1);
    expect(result.wasAlreadyRegistered).toBe(true);
  });

  it('3) unregister: deactivate + unregister, metadata cleared, токен сохранён', async () => {
    await seedInstallation(repo);
    // Заранее заполним metadata, чтобы было что чистить.
    await installations.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: '100000001',
    });

    const b24Client = fakeB24Client();
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });

    const result = await runScript({
      argv: ['node', 'script', '--unregister'],
      deps: {
        config: fakeConfig(),
        logger,
        pool,
        installationsRepo: repo,
        installations,
        b24Client,
        b24,
      },
    });

    expect(b24Client.imconnectorDeactivate).toHaveBeenCalled();
    expect(b24Client.imconnectorUnregister).toHaveBeenCalled();
    expect(result.mode).toBe('unregister');

    const refreshed = await repo.findByPortal(PORTAL);
    expect(refreshed.connectorId).toBeNull();
    expect(refreshed.olLineId).toBeNull();
    expect(refreshed.maxBotId).toBeNull();
    expect(refreshed.b24AccessToken).toBe('fake-access-token');
  });

  it('4) fast-fail без installation: бросаем Error с подсказкой про /api/install', async () => {
    const b24Client = fakeB24Client();
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });

    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: {
          config: fakeConfig(),
          logger,
          pool,
          installationsRepo: repo,
          installations,
          b24Client,
          b24,
        },
      }),
    ).rejects.toThrow(/POST \/api\/install/);

    expect(b24Client.imconnectorRegister).not.toHaveBeenCalled();
  });

  it('5) fast-fail без placementHandlerUrl: Error("B24_PLACEMENT_HANDLER_URL is not set...")', async () => {
    await seedInstallation(repo);
    const cfg = fakeConfig();
    cfg.b24 = { ...cfg.b24, placementHandlerUrl: null };

    const b24Client = fakeB24Client();
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });

    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: {
          config: cfg,
          logger,
          pool,
          installationsRepo: repo,
          installations,
          b24Client,
          b24,
        },
      }),
    ).rejects.toThrow(/B24_PLACEMENT_HANDLER_URL/);
  });

  it('6) --update: re-register существующего коннектора + activate, iconDisabled прокинут, seedSingleTenant НЕ зван (maxBotId защищён)', async () => {
    await seedInstallation(repo);
    // Предзаполним metadata боевым maxBotId — он НЕ должен затереться в --update.
    await installations.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: '100000001',
    });

    const b24Client = fakeB24Client({
      imconnectorList: vi.fn(async () => ({ max_b24: 'Старое имя' })),
    });
    const { B24Service } = await import('../../src/modules/b24/b24Service.js');
    const b24 = new B24Service({ b24Client, installationsService: installations, logger });
    const seedSpy = vi.spyOn(installations, 'seedSingleTenant');

    const result = await runScript({
      argv: ['node', 'script', '--update'],
      deps: {
        config: fakeConfig(),
        logger,
        pool,
        installationsRepo: repo,
        installations,
        b24Client,
        b24,
      },
    });

    // forceReregister=true → register ВЫЗВАН даже для уже зарегистрированного коннектора
    expect(b24Client.imconnectorRegister).toHaveBeenCalledTimes(1);
    expect(b24Client.imconnectorRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'max_b24',
        iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED,
      }),
    );
    expect(b24Client.imconnectorActivate).toHaveBeenCalledTimes(1);
    // Защита maxBotId: seedSingleTenant в --update НЕ зван
    expect(seedSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe('update');
    expect(result.wasAlreadyRegistered).toBe(true);

    // И в БД боевой maxBotId не тронут
    const refreshed = await repo.findByPortal(PORTAL);
    expect(refreshed.maxBotId).toBe('100000001');
  });
});
