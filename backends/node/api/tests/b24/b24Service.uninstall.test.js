// Unit-тесты M26: B24Service.handleAppUninstall — удаление приложения Б24 (ONAPPUNINSTALL).
// Цепочка через координатор messaging — владельца журнала: installations.markUninstalled →
// при CLEAN=1 messaging.purgeBridgeData → bindings.purgeAll. Моки, БД и сеть не нужны.

import { describe, expect, it, vi } from 'vitest';

import { B24Service } from '../../src/modules/b24/b24Service.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';

function silentLogger() {
  const make = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => make(),
  });
  return make();
}

function uninstallEvent(clean) {
  return OpenLineEvent.fromWebhookBody({
    event: 'ONAPPUNINSTALL',
    auth: { application_token: 'app-token', member_id: 'member-1' },
    data: { LANGUAGE_ID: 'ru', ...(clean === undefined ? {} : { CLEAN: clean }) },
  });
}

// Общий журнал вызовов фиксирует порядок: сначала токены, потом очистка.
function build({ marked = { installation: { id: 1 }, alreadyUninstalled: false }, purge, messaging = true } = {}) {
  const calls = [];
  const installations = {
    getCurrent: vi.fn(),
    markUninstalled: vi.fn(async () => {
      calls.push('markUninstalled');
      return marked;
    }),
  };
  const messagingService = messaging
    ? {
        purgeBridgeData: vi.fn(async (id) => {
          calls.push(`purgeBridgeData:${id}`);
          if (purge) return purge();
          return { bindings: 2 };
        }),
      }
    : null;
  const service = new B24Service({
    b24Client: { callMethod: vi.fn() },
    installationsService: installations,
    messagingService,
    logger: silentLogger(),
  });
  return { service, installations, messagingService, calls };
}

describe('B24Service.handleAppUninstall (M26)', () => {
  it('CLEAN=1 → сначала markUninstalled (с токеном события для CAS), затем messaging.purgeBridgeData(id) с логгером вызывающего', async () => {
    const { service, installations, messagingService, calls } = build();
    const logger = silentLogger();

    const result = await service.handleAppUninstall(uninstallEvent('1'), { logger });

    expect(result).toEqual({ ok: true, clean: true, installationId: 1, purged: { bindings: 2 } });
    expect(installations.markUninstalled).toHaveBeenCalledWith({ applicationToken: 'app-token' });
    expect(calls).toEqual(['markUninstalled', 'purgeBridgeData:1']);
    expect(messagingService.purgeBridgeData).toHaveBeenCalledWith(1, { logger });
    expect(logger.info).toHaveBeenCalledWith(
      { event: 'ONAPPUNINSTALL', clean: true, languageId: 'ru' },
      'b24 app uninstall received',
    );
  });

  it('CLEAN=1 числом (JSON) → очистка', async () => {
    const { service, calls } = build();

    await service.handleAppUninstall(uninstallEvent(1));

    expect(calls).toEqual(['markUninstalled', 'purgeBridgeData:1']);
  });

  it.each([['0'], [0], [undefined]])('CLEAN=%j → токены сброшены, данные моста не трогаются', async (clean) => {
    const { service, messagingService, calls } = build();

    const result = await service.handleAppUninstall(uninstallEvent(clean));

    expect(result).toEqual({ ok: true, clean: false, installationId: 1 });
    expect(calls).toEqual(['markUninstalled']);
    expect(messagingService.purgeBridgeData).not.toHaveBeenCalled();
  });

  it('строки installations нет → no-installation, очистка не зовётся', async () => {
    const { service, messagingService } = build({ marked: null });

    await expect(service.handleAppUninstall(uninstallEvent('1'))).resolves.toEqual({ skipped: 'no-installation' });
    expect(messagingService.purgeBridgeData).not.toHaveBeenCalled();
  });

  it.each([['1'], ['0']])('CLEAN=%s, CAS не прошёл (переустановка успела раньше) → stale-uninstall, очистка не зовётся', async (clean) => {
    const { service, messagingService, calls } = build({ marked: { stale: true, installationId: 1 } });

    await expect(service.handleAppUninstall(uninstallEvent(clean))).resolves.toEqual({
      skipped: 'stale-uninstall',
      installationId: 1,
    });
    expect(calls).toEqual(['markUninstalled']);
    expect(messagingService.purgeBridgeData).not.toHaveBeenCalled();
  });

  it('очистка упала → error-лог с отсылкой к runbook и проброс; токены уже сброшены', async () => {
    const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const { service, installations } = build({ purge: () => { throw boom; } });
    const logger = silentLogger();

    await expect(service.handleAppUninstall(uninstallEvent('1'), { logger })).rejects.toBe(boom);
    expect(installations.markUninstalled).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { installationId: 1, err: { message: 'deadlock detected', code: '40P01' } },
      'app uninstall: tokens cleared, bridge data NOT purged — see app-installation.md',
    );
  });

  it('координатор не подключён и CLEAN=1 → ошибка ДО markUninstalled: токены не тронуты', async () => {
    const { service, installations } = build({ messaging: false });

    await expect(service.handleAppUninstall(uninstallEvent('1'))).rejects.toThrow('messagingService not wired');
    expect(installations.markUninstalled).not.toHaveBeenCalled();
  });

  it('координатор не подключён, но CLEAN=0 → токены сброшены, координатор не нужен', async () => {
    const { service, installations } = build({ messaging: false });

    await expect(service.handleAppUninstall(uninstallEvent('0'))).resolves.toMatchObject({ ok: true, clean: false });
    expect(installations.markUninstalled).toHaveBeenCalledOnce();
  });
});
