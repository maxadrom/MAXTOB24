// Unit-тесты M21: MaxService обрабатывает только сообщения групп. Личка с ботом →
// skip + одноразовая подсказка (POST /messages?user_id=), канал → skip молча, без
// chat_type → как до M21 (координатор). Мокаем maxClient и messagingService.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxService } from '../../src/modules/max/maxService.js';
import { MaxUpdate } from '../../src/modules/max/models/MaxUpdate.js';

const USER_ID = 1000001;

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
}

function update(updateType, recipient, { mid = 'mid.1', senderId = USER_ID } = {}) {
  return MaxUpdate.fromWebhookBody({
    update_type: updateType,
    timestamp: 1700000000000,
    message: {
      recipient,
      ...(senderId !== null ? { sender: { user_id: senderId, name: 'Олег' } } : {}),
      body: { mid, text: 'привет' },
    },
  });
}

describe('MaxService — только группы (M21)', () => {
  let client;
  let messaging;
  let service;

  beforeEach(() => {
    client = {
      hasToken: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    messaging = {
      routeInbound: vi.fn().mockResolvedValue({ ok: true }),
      routeInboundEdit: vi.fn().mockResolvedValue({ ok: true }),
    };
    service = new MaxService({ maxClient: client, messagingService: messaging, logger: makeLogger() });
  });

  it('1) личка: skip not-group-chat, координатор не вызван, подсказка — в user_id автора', async () => {
    const result = await service.handleIncomingUpdate(update('message_created', { chat_id: null, chat_type: 'dialog' }));

    expect(result).toEqual({ skipped: 'not-group-chat', chatType: 'dialog' });
    expect(messaging.routeInbound).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const [msg] = client.sendMessage.mock.calls[0];
    expect(msg).toEqual({ userId: USER_ID, text: expect.stringContaining('только в группах') });
    expect(msg).not.toHaveProperty('chatId');
  });

  it('2) второе сообщение в личку того же пользователя → подсказки нет (дедуп)', async () => {
    await service.handleIncomingUpdate(update('message_created', { chat_id: 5, chat_type: 'dialog' }, { mid: 'a' }));
    await service.handleIncomingUpdate(update('message_created', { chat_id: 5, chat_type: 'dialog' }, { mid: 'b' }));

    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it('3) сбой подсказки → всё равно 200-skip, следующее сообщение пробует снова', async () => {
    client.sendMessage.mockRejectedValueOnce(new Error('MAX down'));
    const dialog = { chat_id: 5, chat_type: 'dialog' };

    await expect(service.handleIncomingUpdate(update('message_created', dialog, { mid: 'a' })))
      .resolves.toEqual({ skipped: 'not-group-chat', chatType: 'dialog' });
    await service.handleIncomingUpdate(update('message_created', dialog, { mid: 'b' }));

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('4) пост канала (без sender) → skip молча: ни координатора, ни отправки', async () => {
    const result = await service.handleIncomingUpdate(
      update('message_created', { chat_id: -9, chat_type: 'channel' }, { senderId: null }),
    );

    expect(result).toEqual({ skipped: 'not-group-chat', chatType: 'channel' });
    expect(messaging.routeInbound).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('5) правка в личке → skip без подсказки', async () => {
    const result = await service.handleIncomingEdit(update('message_edited', { chat_id: 5, chat_type: 'dialog' }));

    expect(result).toEqual({ skipped: 'not-group-chat', chatType: 'dialog' });
    expect(messaging.routeInboundEdit).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['chat_type=chat', { chat_id: -1, chat_type: 'chat' }],
    ['без chat_type (fail-open)', { chat_id: -1 }],
  ])('6) группа (%s) → координатор, подсказки нет', async (_label, recipient) => {
    await service.handleIncomingUpdate(update('message_created', recipient));
    await service.handleIncomingEdit(update('message_edited', recipient));

    expect(messaging.routeInbound).toHaveBeenCalledOnce();
    expect(messaging.routeInboundEdit).toHaveBeenCalledOnce();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('7) нет токена бота → подсказку не шлём, skip остаётся', async () => {
    client.hasToken.mockReturnValue(false);

    const result = await service.handleIncomingUpdate(update('message_created', { chat_id: 5, chat_type: 'dialog' }));

    expect(result.skipped).toBe('not-group-chat');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
