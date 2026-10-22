// Unit-тесты общего каркаса скриптов (scripts/lib/bootstrap.js) и isInvokedDirectly.
// БД/сеть не нужны: пул и installations подменяются через deps.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInvokedDirectly } from '../../src/shared/cli/isInvokedDirectly.js';
import { Installation } from '../../src/modules/installations/models/Installation.js';
import {
  b24Graph,
  requireInstallation,
  runCli,
  scriptContext,
} from '../../scripts/lib/bootstrap.js';

function silentLogger() {
  const make = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => make()),
  });
  return make();
}

const config = { b24: { portal: 'example.bitrix24.ru' }, max: {} };

describe('isInvokedDirectly', () => {
  const file = path.resolve('scripts/register-events.js');
  const url = pathToFileURL(file).href;

  it('относительный argv[1] того же файла → true', () => {
    expect(isInvokedDirectly(url, 'scripts/register-events.js')).toBe(true);
  });

  it('другой файл или пустой argv[1] → false', () => {
    expect(isInvokedDirectly(url, 'scripts/register-webhook.js')).toBe(false);
    expect(isInvokedDirectly(url, undefined)).toBe(false);
  });

  it('не file:-URL → false без исключения', () => {
    expect(isInvokedDirectly('https://example.com/x.js', file)).toBe(false);
  });
});

describe('scriptContext', () => {
  it('logger — child с полем script', () => {
    const logger = silentLogger();
    const ctx = scriptContext('register-events', { config, logger });
    expect(ctx.config).toBe(config);
    expect(logger.child).toHaveBeenCalledWith({ script: 'register-events' });
  });
});

describe('b24Graph.close', () => {
  it('чужой пул из deps не закрывает', async () => {
    const pool = { end: vi.fn(async () => {}) };
    const graph = b24Graph({ config, logger: silentLogger() }, { pool, installations: {}, b24Client: {} });
    await graph.close();
    expect(pool.end).not.toHaveBeenCalled();
  });
});

describe('requireInstallation', () => {
  it('есть installation с токеном → возвращает её (через фасад findByPortal)', async () => {
    const installation = { b24AccessToken: 'tok' };
    const installations = { findByPortal: vi.fn(async () => installation) };
    await expect(requireInstallation(installations, 'p.bitrix24.ru', 'x')).resolves.toBe(installation);
    expect(installations.findByPortal).toHaveBeenCalledWith('p.bitrix24.ru');
  });

  it.each([null, { b24AccessToken: null }])('installation %j → ошибка с подсказкой про /api/install', async (row) => {
    const installations = { findByPortal: vi.fn(async () => row) };
    await expect(requireInstallation(installations, 'p.bitrix24.ru', 'register-events')).rejects.toThrow(
      /POST \/api\/install.*re-run register-events/,
    );
  });

  it('M26: приложение удалено → ошибка с датой удаления и подсказкой переустановить', async () => {
    const row = new Installation({
      id: 1,
      b24Portal: 'p.bitrix24.ru',
      uninstalledAt: new Date('2026-10-08T10:00:00Z'),
    });
    const installations = { findByPortal: vi.fn(async () => row) };
    await expect(requireInstallation(installations, 'p.bitrix24.ru', 'register-events')).rejects.toThrow(
      'Bitrix24 app was uninstalled at 2026-10-08T10:00:00.000Z — reinstall it ' +
        '(re-save the app form, POST /api/install), then re-run register-events.',
    );
  });
});

describe('runCli', () => {
  let errSpy;
  afterEach(() => errSpy?.mockRestore());

  it('успех → exit 0', async () => {
    const exit = vi.fn();
    await runCli('s', async () => ({ ok: true }), { exit });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('{ ok:false } → notOkExitCode (пробы: 2), по умолчанию 0', async () => {
    const exit = vi.fn();
    await runCli('s', async () => ({ ok: false }), { notOkExitCode: 2, exit });
    await runCli('s', async () => ({ ok: false }), { exit });
    expect(exit.mock.calls).toEqual([[2], [0]]);
  });

  it('исключение → exit 1 + сообщение и код Б24 в stderr', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    const err = Object.assign(new Error('boom'), { b24Code: 'WRONG_AUTH_TYPE', b24Description: 'desc' });
    await runCli('register-events', async () => { throw err; }, { exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith('register-events failed:', 'boom');
    expect(errSpy).toHaveBeenCalledWith('  B24 code:', 'WRONG_AUTH_TYPE', '—', 'desc');
  });
});
