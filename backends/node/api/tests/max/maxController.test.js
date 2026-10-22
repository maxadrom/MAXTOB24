// Unit-тесты MaxController.handleWebhook (диспатч):
//   - message_created  → service.handleIncomingUpdate (inbound routing)
//   - bot_added/bot_removed/user_added/user_removed → service.handleLifecycleEvent
//   - всё прочее → 200 status:"ignored"
//   - payload без update_type → ValidationError (через next)
//
// Сервис подменяется простым объектом с vi.fn(). Express req/res — лёгкие моки.

import { describe, expect, it, vi } from 'vitest';

import { MaxController } from '../../src/modules/max/maxController.js';
import { ValidationError } from '../../src/shared/http/domainErrors.js';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function fakeReq(body) {
  // log.child нужен для scoped-логгера routeInbound (M4.2). Возвращаем
  // logger-подобный объект — pino-http в проде даёт его через req.log.child.
  return {
    id: 'req-1',
    body,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    },
  };
}

function makeService(overrides = {}) {
  return {
    handleIncomingUpdate: vi.fn(),
    handleIncomingEdit: vi.fn(),
    handleLifecycleEvent: vi.fn(),
    handleChatTitleChanged: vi.fn(async () => ({ ok: true, bindingId: 7, olTitle: 'synced' })),
    ...overrides,
  };
}

const REAL_MESSAGE_EDITED = {
  update_type: 'message_edited',
  timestamp: 1700000005000,
  message: {
    recipient: { chat_id: -70000000000954, chat_type: 'chat' },
    sender: { user_id: 54321, first_name: 'Иван' },
    body: { mid: 'mid.ABC123', seq: 0, text: 'исправленный текст' },
  },
  user_locale: 'ru',
};

const REAL_MESSAGE_CREATED = {
  update_type: 'message_created',
  timestamp: 1700000000000,
  message: {
    recipient: { chat_id: -70000000000954, chat_type: 'chat' },
    sender: { user_id: 54321, first_name: 'Иван' },
    body: { mid: 'mid.ABC123', seq: 0, text: 'тест' },
  },
  user_locale: 'ru',
};

const REAL_BOT_ADDED = {
  update_type: 'bot_added',
  timestamp: 1700000000001,
  chat_id: -70000000000954,
  user: { user_id: 100000001, first_name: 'Bot', is_bot: true },
  is_channel: false,
};

describe('MaxController.handleWebhook — dispatch', () => {
  it('1) message_created + service.handleIncomingUpdate возвращает результат → 200 { ok: true, result }; лог содержит ненулевые chatId/mid/senderId', async () => {
    const service = makeService({
      handleIncomingUpdate: vi.fn().mockResolvedValue({ routed: true }),
    });
    const controller = new MaxController(service);
    const req = fakeReq(REAL_MESSAGE_CREATED);
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(service.handleIncomingUpdate).toHaveBeenCalledOnce();
    expect(service.handleLifecycleEvent).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { routed: true } });

    // Лог-инвариант: chatId/mid/senderId не null
    const infoLogArg = req.log.info.mock.calls[0][0];
    expect(infoLogArg).toMatchObject({
      updateType: 'message_created',
      chatId: -70000000000954,
      mid: 'mid.ABC123',
      senderId: 54321,
    });
  });

  it('2) message_created + service бросает любую ошибку → next(err)', async () => {
    const boom = new Error('boom');
    const service = makeService({
      handleIncomingUpdate: vi.fn().mockRejectedValue(boom),
    });
    const controller = new MaxController(service);
    const req = fakeReq(REAL_MESSAGE_CREATED);
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.headersSent).toBe(false);
  });

  it('3) bot_added (плоский chat_id) → service.handleLifecycleEvent, 200 c lifecycle: "bot_added", лог содержит chatId', async () => {
    const service = makeService({
      handleLifecycleEvent: vi.fn().mockResolvedValue({ ok: true, lifecycle: 'bot_added' }),
    });
    const controller = new MaxController(service);
    const req = fakeReq(REAL_BOT_ADDED);
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(service.handleLifecycleEvent).toHaveBeenCalledOnce();
    expect(service.handleIncomingUpdate).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { ok: true, lifecycle: 'bot_added' } });

    const infoLogArg = req.log.info.mock.calls[0][0];
    expect(infoLogArg).toMatchObject({
      updateType: 'bot_added',
      chatId: -70000000000954,
      senderId: 100000001,
      mid: null,
    });
  });

  it('4) bot_removed/user_added/user_removed → handleLifecycleEvent + chatId из плоского payload', async () => {
    const service = makeService({
      handleLifecycleEvent: vi.fn().mockResolvedValue({ ok: true, lifecycle: 'x' }),
    });
    const controller = new MaxController(service);

    const types = [
      { update_type: 'bot_removed', chat_id: -1, user: { user_id: 100 }, timestamp: 1 },
      {
        update_type: 'user_added',
        chat_id: -2,
        user: { user_id: 200 },
        inviter_id: 999,
        timestamp: 2,
      },
      {
        update_type: 'user_removed',
        chat_id: -3,
        user: { user_id: 300 },
        admin_id: 888,
        timestamp: 3,
      },
    ];

    for (const payload of types) {
      const req = fakeReq(payload);
      const res = fakeRes();
      const next = vi.fn();
      await controller.handleWebhook(req, res, next);
      expect(res.statusCode).toBe(200);
      expect(next).not.toHaveBeenCalled();
      expect(req.log.info.mock.calls[0][0].chatId).toBe(payload.chat_id);
    }
    expect(service.handleLifecycleEvent).toHaveBeenCalledTimes(3);
    expect(service.handleIncomingUpdate).not.toHaveBeenCalled();
  });

  it('4b) message_edited → service.handleIncomingEdit (НЕ handleIncomingUpdate), 200 { ok, result }', async () => {
    const service = makeService({
      handleIncomingEdit: vi.fn().mockResolvedValue({ ok: true, origMid: 'mid.ABC123' }),
    });
    const controller = new MaxController(service);
    const req = fakeReq(REAL_MESSAGE_EDITED);
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(service.handleIncomingEdit).toHaveBeenCalledOnce();
    expect(service.handleIncomingUpdate).not.toHaveBeenCalled();
    expect(service.handleLifecycleEvent).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { ok: true, origMid: 'mid.ABC123' } });

    const infoLogArg = req.log.info.mock.calls[0][0];
    expect(infoLogArg).toMatchObject({
      updateType: 'message_edited',
      chatId: -70000000000954,
      mid: 'mid.ABC123',
      senderId: 54321,
    });
  });

  it('5) dialog_muted (не whitelist) → 200 { status: "ignored" }, никто из service не вызван', async () => {
    const service = makeService();
    const controller = new MaxController(service);
    const req = fakeReq({ update_type: 'dialog_muted', chat_id: -1, timestamp: 1 });
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 'ignored',
      updateType: 'dialog_muted',
    });
    expect(service.handleIncomingUpdate).not.toHaveBeenCalled();
    expect(service.handleLifecycleEvent).not.toHaveBeenCalled();
    expect(service.handleChatTitleChanged).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalled();
  });

  it('5a) M24: chat_title_changed → service.handleChatTitleChanged(MaxUpdate с chatTitle), 200 { ok, result }', async () => {
    const service = makeService();
    const controller = new MaxController(service);
    const req = fakeReq({
      update_type: 'chat_title_changed',
      timestamp: 1700000009000,
      chat_id: -70000000000218,
      user: { user_id: 1000001, first_name: 'Олег' },
      title: '  Тестовая группа 2  ',
    });
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(service.handleChatTitleChanged).toHaveBeenCalledOnce();
    const [update, opts] = service.handleChatTitleChanged.mock.calls[0];
    expect(update).toMatchObject({
      updateType: 'chat_title_changed',
      chatId: -70000000000218,
      senderId: 1000001,
      chatTitle: 'Тестовая группа 2',
      timestamp: 1700000009000,
    });
    expect(opts).toHaveProperty('logger');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { ok: true, bindingId: 7, olTitle: 'synced' } });
  });

  it('6) body без update_type → ValidationError через next', async () => {
    const service = makeService();
    const controller = new MaxController(service);
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(res.headersSent).toBe(false);
  });

  it('7) лог-инвариант: каждый info-лог содержит updateType + chatId + mid + senderId (даже null)', async () => {
    const service = makeService({
      handleLifecycleEvent: vi.fn().mockResolvedValue({ ok: true, lifecycle: 'bot_added' }),
      handleIncomingUpdate: vi.fn().mockResolvedValue({ ok: true }),
    });
    const controller = new MaxController(service);

    const inputs = [REAL_MESSAGE_CREATED, REAL_BOT_ADDED];
    for (const payload of inputs) {
      const req = fakeReq(payload);
      const res = fakeRes();
      await controller.handleWebhook(req, res, vi.fn());

      const args = req.log.info.mock.calls[0][0];
      expect(args).toHaveProperty('updateType');
      expect(args).toHaveProperty('chatId');
      expect(args).toHaveProperty('mid');
      expect(args).toHaveProperty('senderId');
    }
  });

  it('8) регрессия: старый legacy-шейп {update_type: "message_created", recipient, body} (без вложенного message) → chatId/mid/senderId === null', async () => {
    const service = makeService({
      handleIncomingUpdate: vi.fn().mockResolvedValue({ ok: true }),
    });
    const controller = new MaxController(service);
    const legacyPayload = {
      update_type: 'message_created',
      recipient: { chat_id: -1 },
      body: { mid: 'mid.X' },
      sender: { user_id: 7 },
      timestamp: 1,
    };
    const req = fakeReq(legacyPayload);
    const res = fakeRes();

    await controller.handleWebhook(req, res, vi.fn());

    const args = req.log.info.mock.calls[0][0];
    expect(args.chatId).toBeNull();
    expect(args.mid).toBeNull();
    expect(args.senderId).toBeNull();
  });
});
