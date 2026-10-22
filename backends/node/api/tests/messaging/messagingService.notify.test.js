// Unit-тесты M28: MessagingService.notifyOperator — системное сообщение оператору в чате ОЛ
// о неудаче OL → MAX. Контракт общий для вебхуков и фоновой работы (без HTTP-контекста):
// никогда не бросает, повторов не делает, installation — вторым аргументом, только если есть.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { B24ApiError, ValidationError } from '../../src/shared/http/domainErrors.js';

function spyLogger() {
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

function buildService({ b24 = undefined, logger = spyLogger() } = {}) {
  return new MessagingService({
    bindingsService: {},
    b24Service: b24 === undefined
      ? { sendSystemMessage: vi.fn(async () => ({ b24MsgId: 1534554, dialogId: 'chat21564' })) }
      : b24,
    maxService: {},
    messageLogRepository: {},
    logger,
  });
}

const TEXT = '⚠️ Правка не доставлена в MAX: MAX отказал. У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.';

describe('MessagingService.notifyOperator (M28)', () => {
  it('успех → { notified:true, noticeId }; op, bindingId, b24MsgId и noticeId — в info, текст в лог не пишется', async () => {
    const logger = spyLogger();
    const service = buildService();

    const out = await service.notifyOperator({
      b24ChatId: '21564', text: TEXT, op: 'edit', bindingId: 8, b24MsgId: '1459190', logger,
    });

    expect(out).toEqual({ notified: true, noticeId: 1534554 });
    expect(service.b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21564', text: TEXT });
    expect(logger.info).toHaveBeenCalledWith(
      { op: 'edit', bindingId: 8, b24MsgId: '1459190', noticeId: 1534554 },
      'notifyOperator: operator notified',
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('Правка');
  });

  it('вызов вне контекста запроса — только b24ChatId и text: op по умолчанию send, логгер сервиса', async () => {
    const serviceLogger = spyLogger();
    const service = buildService({ logger: serviceLogger });

    const out = await service.notifyOperator({ b24ChatId: '21564', text: TEXT });

    expect(out).toEqual({ notified: true, noticeId: 1534554 });
    // Без installation — ровно один аргумент: b24 сам читает installation из БД.
    expect(service.b24.sendSystemMessage.mock.calls[0]).toEqual([{ b24ChatId: '21564', text: TEXT }]);
    expect(serviceLogger.info).toHaveBeenCalledWith(
      { op: 'send', bindingId: null, b24MsgId: null, noticeId: 1534554 },
      'notifyOperator: operator notified',
    );
  });

  it('installation → вторым аргументом { installation }', async () => {
    const service = buildService();
    const installation = { id: 1, b24Portal: 'example.bitrix24.ru', b24AccessToken: 'tok' };

    await service.notifyOperator({ b24ChatId: '21564', text: TEXT, installation });

    expect(service.b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21564', text: TEXT }, { installation });
  });

  it('нет b24ChatId → { notified:false, reason:"no-chat" }, Б24 не вызван, warn', async () => {
    const logger = spyLogger();
    const service = buildService();

    for (const b24ChatId of [null, undefined, '']) {
      // eslint-disable-next-line no-await-in-loop
      const out = await service.notifyOperator({ b24ChatId, text: TEXT, op: 'delete', bindingId: 8, logger });
      expect(out).toEqual({ notified: false, reason: 'no-chat' });
    }
    expect(service.b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'delete', bindingId: 8, b24MsgId: null },
      'notifyOperator: no b24ChatId, operator not notified',
    );
  });

  it('Б24 бросил B24ApiError → send-failed, b24Code в warn, наружу не бросает', async () => {
    const logger = spyLogger();
    const b24 = {
      sendSystemMessage: vi.fn(async () => {
        throw new B24ApiError('ACCESS_ERROR', 'no access', { method: 'im.message.add' });
      }),
    };
    const service = buildService({ b24 });

    const out = await service.notifyOperator({ b24ChatId: '21564', text: TEXT, op: 'edit', logger });

    expect(out).toEqual({ notified: false, reason: 'send-failed' });
    expect(logger.warn).toHaveBeenCalledOnce();
    const [fields, msg] = logger.warn.mock.calls[0];
    expect(msg).toBe('notifyOperator: operator notification failed (non-fatal)');
    expect(fields).toMatchObject({ op: 'edit', b24Code: 'ACCESS_ERROR' });
  });

  it('ValidationError из b24 → send-failed, не бросает', async () => {
    const b24 = {
      sendSystemMessage: vi.fn(async () => {
        throw new ValidationError('B24Service.sendSystemMessage: text required (non-empty)');
      }),
    };
    const service = buildService({ b24 });

    await expect(service.notifyOperator({ b24ChatId: '21564', text: '' }))
      .resolves.toEqual({ notified: false, reason: 'send-failed' });
  });

  it('у фейка b24 нет sendSystemMessage (или b24 нет вовсе) → send-failed, не бросает', async () => {
    const withoutMethod = buildService({ b24: { sendDeliveryStatus: vi.fn() } });
    await expect(withoutMethod.notifyOperator({ b24ChatId: '21564', text: TEXT }))
      .resolves.toEqual({ notified: false, reason: 'send-failed' });

    const withoutB24 = buildService({ b24: null });
    await expect(withoutB24.notifyOperator({ b24ChatId: '21564', text: TEXT }))
      .resolves.toEqual({ notified: false, reason: 'send-failed' });
  });

  it('без аргументов вовсе → no-chat, не бросает', async () => {
    const service = buildService();
    await expect(service.notifyOperator()).resolves.toEqual({ notified: false, reason: 'no-chat' });
  });

  it('b24 вернул ответ без b24MsgId → notified:true, noticeId:null', async () => {
    const service = buildService({ b24: { sendSystemMessage: vi.fn(async () => undefined) } });
    await expect(service.notifyOperator({ b24ChatId: '21564', text: TEXT }))
      .resolves.toEqual({ notified: true, noticeId: null });
  });
});
