// Unit-тесты M26: messagingService.purgeBridgeData — очистка данных моста при удалении
// приложения Б24 с CLEAN=1. Координатор делегирует в bindings.purgeAll (журнал уходит
// каскадом по FK), сам в message_log не пишет. Моки, БД не нужна.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function build(purgeAll) {
  const bindings = { purgeAll: vi.fn(purgeAll) };
  const messageLog = { recordInbound: vi.fn(), recordOutbound: vi.fn() };
  const logger = silentLogger();
  const service = new MessagingService({
    bindingsService: bindings,
    messageLogRepository: messageLog,
    logger,
  });
  return { service, bindings, messageLog, logger };
}

describe('MessagingService.purgeBridgeData (M26)', () => {
  it('делегирует в bindings.purgeAll, логирует итог, журнал не пишет', async () => {
    const { service, bindings, messageLog, logger } = build(async () => ({ bindings: 12 }));

    await expect(service.purgeBridgeData(1)).resolves.toEqual({ bindings: 12 });

    expect(bindings.purgeAll).toHaveBeenCalledWith(1);
    expect(logger.info).toHaveBeenCalledWith(
      { installationId: 1, bindings: 12 },
      'app uninstall: bridge data purged',
    );
    expect(messageLog.recordInbound).not.toHaveBeenCalled();
    expect(messageLog.recordOutbound).not.toHaveBeenCalled();
  });

  it('scoped-логгер вызывающего главнее своего', async () => {
    const { service, logger } = build(async () => ({ bindings: 0 }));
    const scoped = silentLogger();

    await service.purgeBridgeData(1, { logger: scoped });

    expect(scoped.info).toHaveBeenCalledWith({ installationId: 1, bindings: 0 }, 'app uninstall: bridge data purged');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('ошибка bindings пробрасывается, итог не логируется', async () => {
    const { service, logger } = build(async () => { throw new Error('deadlock detected'); });

    await expect(service.purgeBridgeData(1)).rejects.toThrow('deadlock detected');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
