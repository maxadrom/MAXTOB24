// Unit-тесты двух методов MaxService, связанных с правками сообщений:
//   handleIncomingEdit — INBOUND-правка MAX→OL, делегирует в координатор
//     messaging.routeInboundEdit; без подключённого messaging — бросает.
//   editOutgoing — OUTBOUND-правка OL→MAX, фасад над maxClient.editMessage.
// Мокаем maxClient и messagingService через vi.fn(). Логгер — заглушка.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { MaxService } from '../../src/modules/max/maxService.js';
import { MaxUpdate } from '../../src/modules/max/models/MaxUpdate.js';

function makeClient(overrides = {}) {
  return {
    hasToken: vi.fn().mockReturnValue(true),
    getChatMember: vi.fn(),
    getChatMembers: vi.fn(),
    getChat: vi.fn(),
    getMe: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({}),
    editMessage: vi.fn().mockResolvedValue({}),
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

describe('MaxService.handleIncomingEdit (INBOUND-правка MAX→OL)', () => {
  let client;
  let logger;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
  });

  it('messaging подключён → routeInboundEdit вызван ровно раз с тем же update и прокинутым logger; возвращает его результат', async () => {
    const routed = { ok: true, edited: true, b24MsgId: 42 };
    const messaging = { routeInboundEdit: vi.fn().mockResolvedValue(routed) };
    const service = new MaxService({ maxClient: client, messagingService: messaging, logger });

    const update = new MaxUpdate({ updateType: 'message_edited', mid: 'mid-1', chatId: -100, senderId: 7 });
    const scopedLogger = makeLogger();

    const result = await service.handleIncomingEdit(update, { logger: scopedLogger });

    expect(messaging.routeInboundEdit).toHaveBeenCalledOnce();
    expect(messaging.routeInboundEdit).toHaveBeenCalledWith(update, { logger: scopedLogger });
    expect(messaging.routeInboundEdit.mock.calls[0][0]).toBe(update);
    expect(result).toBe(routed);
  });

  it('messaging подключён через setMessagingService → routeInboundEdit вызван', async () => {
    const messaging = { routeInboundEdit: vi.fn().mockResolvedValue({ ok: true }) };
    const service = new MaxService({ maxClient: client, logger });
    service.setMessagingService(messaging);

    const update = new MaxUpdate({ updateType: 'message_edited', mid: 'mid-2' });
    await service.handleIncomingEdit(update, {});

    expect(messaging.routeInboundEdit).toHaveBeenCalledOnce();
    expect(messaging.routeInboundEdit.mock.calls[0][0]).toBe(update);
  });

  it('messaging НЕ подключён → бросает ошибку про "messagingService not wired"', async () => {
    const service = new MaxService({ maxClient: client, logger });

    await expect(
      service.handleIncomingEdit(new MaxUpdate({ updateType: 'message_edited', mid: 'mid-3' }), {}),
    ).rejects.toThrow(/messagingService not wired/);
  });
});

describe('MaxService.editOutgoing (OUTBOUND-правка OL→MAX)', () => {
  let client;
  let logger;
  let service;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
    service = new MaxService({ maxClient: client, logger, rateRetryMs: 1 });
  });

  it('вызывает client.editMessage с { messageId, text, format } и возвращает { timestampMs }', async () => {
    const resp = { success: true, message: { body: { mid: 'm-1' }, timestamp: 1700000123000 } };
    client.editMessage.mockResolvedValue(resp);

    const args = { messageId: 'm-1', text: 'правленый текст', format: 'markdown' };
    const result = await service.editOutgoing(args);

    expect(client.editMessage).toHaveBeenCalledOnce();
    expect(client.editMessage).toHaveBeenCalledWith({
      messageId: 'm-1',
      text: 'правленый текст',
      format: 'markdown',
    });
    expect(result).toEqual({ timestampMs: 1700000123000 });
  });

  it('ответ без message → { timestampMs: null }', async () => {
    client.editMessage.mockResolvedValue({ success: true });
    const result = await service.editOutgoing({ messageId: 'm-1', text: 't' });
    expect(result).toEqual({ timestampMs: null });
  });

  it('ошибка транспорта пробрасывается наружу', async () => {
    client.editMessage.mockRejectedValue(new Error('edit failed'));

    await expect(
      service.editOutgoing({ messageId: 'm-2', text: 't', format: null }),
    ).rejects.toThrow(/edit failed/);
  });

  // M28: PUT /messages отвечает 200 и на неудачу (live 2026-10-08).
  it("M28: 200 { success:false, message } → MaxApiError kind 'rejected', message MAX в тексте", async () => {
    client.editMessage.mockResolvedValue({ success: false, message: 'Error on message edit' });

    const err = await service.editOutgoing({ messageId: 'm-1', text: 't' }).catch((e) => e);

    expect(err).toBeInstanceOf(MaxApiError);
    expect(err).toMatchObject({ kind: 'rejected', method: 'PUT', path: '/messages', httpStatus: null });
    expect(err.message).toBe('PUT /messages: success:false — Error on message edit');
    expect(client.editMessage).toHaveBeenCalledOnce(); // success:false не повторяется
  });

  it('M28: success:false без message → тоже ошибка', async () => {
    client.editMessage.mockResolvedValue({ success: false });
    await expect(service.editOutgoing({ messageId: 'm-1', text: 't' }))
      .rejects.toMatchObject({ kind: 'rejected', message: 'PUT /messages: success:false' });
  });

  it('M28: 429 → один повтор после паузы → успех', async () => {
    client.editMessage
      .mockRejectedValueOnce(new MaxApiError('HTTP 429', { httpStatus: 429 }))
      .mockResolvedValueOnce({ success: true });

    await expect(service.editOutgoing({ messageId: 'm-1', text: 't' })).resolves.toEqual({ timestampMs: null });
    expect(client.editMessage).toHaveBeenCalledTimes(2);
    expect(client.editMessage.mock.calls[1][0]).toEqual(client.editMessage.mock.calls[0][0]);
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'edit', messageId: 'm-1', delayMs: 1 },
      'max outgoing: HTTP 429, retrying once',
    );
  });

  it('M28: 429 дважды → проброс второй ошибки, вызовов ровно 2', async () => {
    client.editMessage
      .mockRejectedValueOnce(new MaxApiError('HTTP 429 #1', { httpStatus: 429 }))
      .mockRejectedValueOnce(new MaxApiError('HTTP 429 #2', { httpStatus: 429 }));

    await expect(service.editOutgoing({ messageId: 'm-1', text: 't' })).rejects.toThrow('HTTP 429 #2');
    expect(client.editMessage).toHaveBeenCalledTimes(2);
  });

  it('M28: 429, затем success:false → rejected (повтор был один)', async () => {
    client.editMessage
      .mockRejectedValueOnce(new MaxApiError('HTTP 429', { httpStatus: 429 }))
      .mockResolvedValueOnce({ success: false, message: 'Error on message edit' });

    await expect(service.editOutgoing({ messageId: 'm-1', text: 't' })).rejects.toMatchObject({ kind: 'rejected' });
    expect(client.editMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['400 proto.payload', new MaxApiError('Invalid message_id: bogus', { httpStatus: 400, maxCode: 'proto.payload' })],
    ['403', new MaxApiError('HTTP 403', { httpStatus: 403, maxCode: 'chat.denied' })],
    ['500', new MaxApiError('HTTP 500', { httpStatus: 500 })],
    ['таймаут', new MaxApiError('timed out', { kind: 'timeout' })],
    ['сеть', new MaxApiError('ECONNRESET', { kind: 'network' })],
  ])('M28: %s → без повтора, проброс', async (_label, error) => {
    client.editMessage.mockRejectedValue(error);

    await expect(service.editOutgoing({ messageId: 'm-1', text: 't' })).rejects.toBe(error);
    expect(client.editMessage).toHaveBeenCalledOnce();
  });
});
