// Unit-тесты двух методов MaxService, связанных с удалением сообщений:
//   handleIncomingDelete — INBOUND-удаление MAX→OL, делегирует в координатор
//     messaging.routeInboundDelete; без подключённого messaging — бросает.
//   deleteOutgoing — OUTBOUND-удаление OL→MAX, фасад над maxClient.deleteMessage.
// Мокаем maxClient и messagingService через vi.fn(). Логгер — заглушка.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { MaxService } from '../../src/modules/max/maxService.js';

function makeClient(overrides = {}) {
  return {
    hasToken: vi.fn().mockReturnValue(true),
    getChatMember: vi.fn(),
    getChatMembers: vi.fn(),
    getChat: vi.fn(),
    getMe: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({}),
    editMessage: vi.fn().mockResolvedValue({}),
    deleteMessage: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe('MaxService.handleIncomingDelete (INBOUND-удаление MAX→OL)', () => {
  let client;
  let logger;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
  });

  it('messaging подключён → routeInboundDelete вызван ровно раз с тем же update и прокинутым logger; возвращает его результат', async () => {
    const routed = { ok: true, origMid: 'mid-1' };
    const messaging = { routeInboundDelete: vi.fn().mockResolvedValue(routed) };
    const service = new MaxService({ maxClient: client, messagingService: messaging, logger });

    const update = { updateType: 'message_removed', mid: 'mid-1', chatId: -100, senderId: 7 };
    const scopedLogger = makeLogger();

    const result = await service.handleIncomingDelete(update, { logger: scopedLogger });

    expect(messaging.routeInboundDelete).toHaveBeenCalledOnce();
    expect(messaging.routeInboundDelete).toHaveBeenCalledWith(update, { logger: scopedLogger });
    expect(messaging.routeInboundDelete.mock.calls[0][0]).toBe(update);
    expect(result).toBe(routed);
  });

  it('messaging подключён через setMessagingService → routeInboundDelete вызван', async () => {
    const messaging = { routeInboundDelete: vi.fn().mockResolvedValue({ ok: true }) };
    const service = new MaxService({ maxClient: client, logger });
    service.setMessagingService(messaging);

    const update = { updateType: 'message_removed', mid: 'mid-2' };
    await service.handleIncomingDelete(update, {});

    expect(messaging.routeInboundDelete).toHaveBeenCalledOnce();
    expect(messaging.routeInboundDelete.mock.calls[0][0]).toBe(update);
  });

  it('messaging НЕ подключён → бросает ошибку про "messagingService not wired"', async () => {
    const service = new MaxService({ maxClient: client, logger });

    await expect(
      service.handleIncomingDelete({ updateType: 'message_removed', mid: 'mid-3' }, {}),
    ).rejects.toThrow(/messagingService not wired/);
  });
});

describe('MaxService.deleteOutgoing (OUTBOUND-удаление OL→MAX)', () => {
  let client;
  let logger;
  let service;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
    service = new MaxService({ maxClient: client, logger, rateRetryMs: 1 });
  });

  it('вызывает client.deleteMessage с { messageId } и возвращает { deleted: true }', async () => {
    const resp = { success: true };
    client.deleteMessage.mockResolvedValue(resp);

    const result = await service.deleteOutgoing({ messageId: 'm-1' });

    expect(client.deleteMessage).toHaveBeenCalledOnce();
    expect(client.deleteMessage).toHaveBeenCalledWith({ messageId: 'm-1' });
    expect(result).toEqual({ deleted: true, maxMessage: null });
  });

  it('MAX вернул success:false без причины → { deleted: false, maxMessage: null }', async () => {
    client.deleteMessage.mockResolvedValue({ success: false });
    const result = await service.deleteOutgoing({ messageId: 'm-1' });
    expect(result).toEqual({ deleted: false, maxMessage: null });
  });

  // M28: форма ответа live 2026-10-08 (несуществующий mid).
  it('M28: success:false с message → { deleted: false, maxMessage } — причина MAX не теряется', async () => {
    client.deleteMessage.mockResolvedValue({ success: false, message: 'Invalid chatId: 0' });
    const result = await service.deleteOutgoing({ messageId: 'mid.000' });
    expect(result).toEqual({ deleted: false, maxMessage: 'Invalid chatId: 0' });
  });

  it('ошибка транспорта пробрасывается наружу', async () => {
    client.deleteMessage.mockRejectedValue(new Error('delete failed'));

    await expect(service.deleteOutgoing({ messageId: 'm-2' })).rejects.toThrow(/delete failed/);
  });

  it('M28: 429 → один повтор после паузы → удалено', async () => {
    client.deleteMessage
      .mockRejectedValueOnce(new MaxApiError('HTTP 429', { httpStatus: 429 }))
      .mockResolvedValueOnce({ success: true });

    await expect(service.deleteOutgoing({ messageId: 'm-1' })).resolves.toEqual({ deleted: true, maxMessage: null });
    expect(client.deleteMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'delete', messageId: 'm-1', delayMs: 1 },
      'max outgoing: HTTP 429, retrying once',
    );
  });

  it('M28: 429 дважды → проброс, вызовов ровно 2', async () => {
    client.deleteMessage.mockRejectedValue(new MaxApiError('HTTP 429', { httpStatus: 429 }));

    await expect(service.deleteOutgoing({ messageId: 'm-1' })).rejects.toMatchObject({ httpStatus: 429 });
    expect(client.deleteMessage).toHaveBeenCalledTimes(2);
  });

  it('M28: 400 proto.payload и таймаут → без повтора', async () => {
    const bad = new MaxApiError('Invalid message_id: bogus', { httpStatus: 400, maxCode: 'proto.payload' });
    client.deleteMessage.mockRejectedValueOnce(bad);
    await expect(service.deleteOutgoing({ messageId: 'mid.bogus' })).rejects.toBe(bad);
    expect(client.deleteMessage).toHaveBeenCalledOnce();

    const timeout = new MaxApiError('timed out', { kind: 'timeout' });
    client.deleteMessage.mockRejectedValueOnce(timeout);
    await expect(service.deleteOutgoing({ messageId: 'm-1' })).rejects.toBe(timeout);
    expect(client.deleteMessage).toHaveBeenCalledTimes(2);
  });
});
