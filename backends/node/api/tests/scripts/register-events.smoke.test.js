// Smoke-тесты scripts/register-events.js. runScript({argv, deps: {config, logger,
// pool, installations, b24Client}}) тестируется без process.exit —
// DI-граф собирается из переданных deps. Шаблон — register-webhook.smoke.test.js,
// но с fake DB-deps (скрипт бутстрапит pool+installations ради b24_access_token,
// как register-connector; в smoke все DB-зависимости подменяются фейками — без Postgres).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runScript } from '../../scripts/register-events.js';

const PORTAL = 'example.bitrix24.ru';
const EVENT_HANDLER = 'https://example.test/webhook/b24';

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
    max: {},
    b24: {
      portal: PORTAL,
      eventHandlerUrl: EVENT_HANDLER,
      ...overrides.b24,
    },
    optional: {},
  };
}

// fake b24Client: callMethod диспетчеризуется по имени метода.
// getResult — что вернёт event.get (массив привязанных событий).
function fakeB24Client(getResult = []) {
  return {
    callMethod: vi.fn(async (method) => {
      if (method === 'event.get') return getResult;
      if (method === 'event.bind') return { result: true };
      if (method === 'event.unbind') return { result: true };
      return {};
    }),
  };
}

// Предусловие проверяется через фасад installationsService.findByPortal.
function fakeInstallations(installation = { b24AccessToken: 'fake-access-token' }) {
  return { findByPortal: vi.fn(async () => installation) };
}

function baseDeps(overrides = {}) {
  return {
    config: buildConfig(overrides.config),
    logger: silentLogger(),
    pool: { end: vi.fn(async () => {}) },
    installations: overrides.installations ?? fakeInstallations(),
    b24Client: overrides.b24Client ?? fakeB24Client(),
  };
}

describe('register-events smoke', () => {
  let stdoutSpy;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('1) default mode + event.get пуст: event.bind вызван для ВСЕХ ПЯТИ событий (M26: + OnAppUninstall)', async () => {
    const b24Client = fakeB24Client([]);
    const result = await runScript({
      argv: ['node', 'script'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageAdd', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageUpdate', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageDelete', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorDialogFinish', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnAppUninstall', handler: EVENT_HANDLER }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'bind', alreadyBound: false });
    expect(result.events).toHaveLength(5);
  });

  it('2) default mode + ВСЕ события уже привязаны (UPPER-CASE): event.bind НЕ вызван (idempotent skip)', async () => {
    // Б24 реально отдаёт код события в ВЕРХНЕМ регистре — сравнение должно быть регистронезависимым.
    const b24Client = fakeB24Client([
      { event: 'ONIMCONNECTORMESSAGEADD', handler: EVENT_HANDLER, auth_type: 0 },
      { event: 'ONIMCONNECTORMESSAGEUPDATE', handler: EVENT_HANDLER, auth_type: 0 },
      { event: 'ONIMCONNECTORMESSAGEDELETE', handler: EVENT_HANDLER, auth_type: 0 },
      { event: 'ONIMCONNECTORDIALOGFINISH', handler: EVENT_HANDLER, auth_type: 0 },
      { event: 'ONAPPUNINSTALL', handler: EVENT_HANDLER, auth_type: 0 },
    ]);
    const result = await runScript({
      argv: ['node', 'script'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).toHaveBeenCalledWith('event.get', {});
    expect(b24Client.callMethod).not.toHaveBeenCalledWith('event.bind', expect.anything());
    expect(result).toMatchObject({ ok: true, mode: 'bind', alreadyBound: true });
  });

  it('2b) частичная привязка: Add уже привязан, остальные — нет → bind для Update, Delete, DialogFinish (M25) и AppUninstall (M26)', async () => {
    const b24Client = fakeB24Client([
      { event: 'ONIMCONNECTORMESSAGEADD', handler: EVENT_HANDLER },
    ]);
    const result = await runScript({
      argv: ['node', 'script'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).not.toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageAdd' }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageUpdate', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageDelete', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorDialogFinish', handler: EVENT_HANDLER }),
    );
    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnAppUninstall', handler: EVENT_HANDLER }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'bind', alreadyBound: false });
  });

  // M26: выкат на прод — четыре события M25 уже подписаны, доподписывается только новое.
  it('2c) подписаны четыре события M25 → bind только для OnAppUninstall', async () => {
    const b24Client = fakeB24Client([
      { event: 'ONIMCONNECTORMESSAGEADD', handler: EVENT_HANDLER },
      { event: 'ONIMCONNECTORMESSAGEUPDATE', handler: EVENT_HANDLER },
      { event: 'ONIMCONNECTORMESSAGEDELETE', handler: EVENT_HANDLER },
      { event: 'ONIMCONNECTORDIALOGFINISH', handler: EVENT_HANDLER },
    ]);
    const result = await runScript({
      argv: ['node', 'script'],
      deps: baseDeps({ b24Client }),
    });

    const binds = b24Client.callMethod.mock.calls.filter(([method]) => method === 'event.bind');
    expect(binds).toEqual([['event.bind', { event: 'OnAppUninstall', handler: EVENT_HANDLER }]]);
    expect(result).toMatchObject({ ok: true, mode: 'bind', alreadyBound: false });
    expect(result.events.filter((e) => !e.alreadyBound).map((e) => e.event)).toEqual(['OnAppUninstall']);
  });

  it('3) handler привязан, но другой URL → всё равно bind (skip только при совпадении handler)', async () => {
    const b24Client = fakeB24Client([
      { event: 'ONIMCONNECTORMESSAGEADD', handler: 'https://old.test/webhook/b24' },
    ]);
    const result = await runScript({
      argv: ['node', 'script'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).toHaveBeenCalledWith(
      'event.bind',
      expect.objectContaining({ event: 'OnImConnectorMessageAdd', handler: EVENT_HANDLER }),
    );
    expect(result.alreadyBound).toBe(false);
  });

  it('4) --unregister: event.unbind вызван с event + handler', async () => {
    const b24Client = fakeB24Client();
    const result = await runScript({
      argv: ['node', 'script', '--unregister'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).toHaveBeenCalledWith('event.unbind', {
      event: 'OnImConnectorMessageAdd',
      handler: EVENT_HANDLER,
    });
    expect(b24Client.callMethod).toHaveBeenCalledWith('event.unbind', {
      event: 'OnImConnectorMessageDelete',
      handler: EVENT_HANDLER,
    });
    expect(b24Client.callMethod).toHaveBeenCalledWith('event.unbind', {
      event: 'OnImConnectorDialogFinish',
      handler: EVENT_HANDLER,
    });
    expect(b24Client.callMethod).toHaveBeenCalledWith('event.unbind', {
      event: 'OnAppUninstall',
      handler: EVENT_HANDLER,
    });
    expect(b24Client.callMethod).not.toHaveBeenCalledWith('event.bind', expect.anything());
    expect(result.mode).toBe('unregister');
    expect(result.events).toHaveLength(5);
  });

  it('5) --list: event.get вызван, stdout получает JSON, bind/unbind не вызваны', async () => {
    const b24Client = fakeB24Client([{ event: 'ONIMCONNECTORMESSAGEADD', handler: EVENT_HANDLER }]);
    const result = await runScript({
      argv: ['node', 'script', '--list'],
      deps: baseDeps({ b24Client }),
    });

    expect(b24Client.callMethod).toHaveBeenCalledWith('event.get', {});
    expect(b24Client.callMethod).not.toHaveBeenCalledWith('event.bind', expect.anything());
    expect(b24Client.callMethod).not.toHaveBeenCalledWith('event.unbind', expect.anything());
    expect(stdoutSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy.mock.calls[0][0]).toContain(EVENT_HANDLER);
    expect(result.mode).toBe('list');
  });

  it('6) --list + --unregister → throw mutually exclusive', async () => {
    const b24Client = fakeB24Client();
    await expect(
      runScript({
        argv: ['node', 'script', '--list', '--unregister'],
        deps: baseDeps({ b24Client }),
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(b24Client.callMethod).not.toHaveBeenCalled();
  });

  it('7) fast-fail без installation с токеном: throw с подсказкой про /api/install', async () => {
    const b24Client = fakeB24Client();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: baseDeps({
          b24Client,
          installations: fakeInstallations(null),
        }),
      }),
    ).rejects.toThrow(/POST \/api\/install/);
    expect(b24Client.callMethod).not.toHaveBeenCalled();
  });

  it('8) fast-fail без B24_EVENT_HANDLER_URL (default mode) → throw', async () => {
    const b24Client = fakeB24Client();
    await expect(
      runScript({
        argv: ['node', 'script'],
        deps: baseDeps({ b24Client, config: { b24: { portal: PORTAL, eventHandlerUrl: null } } }),
      }),
    ).rejects.toThrow(/B24_EVENT_HANDLER_URL/);
    expect(b24Client.callMethod).not.toHaveBeenCalled();
  });

  it('9) --help: справка, B24 не зовётся', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b24Client = fakeB24Client();
    const result = await runScript({
      argv: ['node', 'script', '--help'],
      deps: baseDeps({ b24Client }),
    });
    expect(result.mode).toBe('help');
    expect(b24Client.callMethod).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
