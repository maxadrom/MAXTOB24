// Unit-тесты MessagingService.routeInboundDelete (MAX→OL) и routeOutboundDelete (OL→MAX) —
// двустороннее удаление сообщений. Integration через моки адаптеров, БД/сеть не нужны.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';

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

function makeBinding(overrides = {}) {
  return {
    id: 10,
    connectorChatId: 'max:-70000000000954',
    maxChatId: -70000000000954,
    maxChatTitle: 'Группа Север',
    isReadyForRouting: () => true,
    ...overrides,
  };
}

function buildService({ bindings, b24, log, max, logger } = {}) {
  return new MessagingService({
    bindingsService: bindings,
    b24Service: b24,
    maxService: max,
    messageLogRepository: log,
    logger: logger ?? silentLogger(),
  });
}

// ── INBOUND: routeInboundDelete (MAX → Open Lines) ──────────────────────────
function makeDeleteUpdate(overrides = {}) {
  return {
    updateType: 'message_removed',
    timestamp: 1700000005000,
    chatId: -70000000000954,
    mid: 'mid.ABC',
    senderId: 54321,
    ...overrides,
  };
}

describe('MessagingService.routeInboundDelete (MAX → OL)', () => {
  // findInbound диспетчеризуется по ключу: delete:<mid> — для dedup, «голый» mid —
  // запись оригинала (есть ли что удалять + автор). По умолчанию: dedup пуст, оригинал
  // дошёл до OL, но без senderId в payloadMeta.
  const originalOnly = (bindingId, key) => (key === 'mid.ABC' ? { id: 1, payloadMeta: {} } : null);
  function deps(overrides = {}) {
    const bindings = {
      resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true })),
      // M23: имя автора для delete — из participant_map
      findParticipantName: vi.fn(async () => 'Иван Петров'),
      ...overrides.bindings,
    };
    const b24 = {
      deleteConnectorMessage: vi.fn(async () => ({ success: true, raw: {} })),
      ...overrides.b24,
    };
    const log = {
      findInbound: vi.fn(async (bindingId, key) => originalOnly(bindingId, key)),
      recordInbound: vi.fn(async () => ({ id: 100 })),
      ...overrides.log,
    };
    return { bindings, b24, log };
  }

  it('1) happy path: удаляет OL по тому же external id, пишет synthetic-key delete:<mid>', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate());

    expect(b24.deleteConnectorMessage).toHaveBeenCalledOnce();
    const msg = b24.deleteConnectorMessage.mock.calls[0][0];
    expect(msg.externalMessageId).toBe('max:mid:mid.ABC');
    expect(msg.connectorChatId).toBe('max:-70000000000954');
    // в записи оригинала нет senderId → fallback на senderId события;
    // M23: имя автора из participant_map, иначе Б24 сделает его «Гостем»
    expect(msg.author).toEqual({ id: 54321, name: 'Иван Петров' });
    expect(bindings.findParticipantName).toHaveBeenCalledWith(10, 54321);

    expect(log.recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: 10,
        maxMid: 'delete:mid.ABC',
        payloadMeta: expect.objectContaining({ kind: 'delete', origMid: 'mid.ABC', senderId: 54321 }),
      }),
    );
    expect(result).toMatchObject({ ok: true, externalId: 'max:mid:mid.ABC' });
  });

  it('2) автор берётся из записи оригинала (payloadMeta.senderId), а не из события', async () => {
    // user_id события — тот, КТО удалил (мог быть админ). Для delete нужен автор оригинала.
    const findInbound = vi.fn(async (bindingId, key) => {
      if (key === 'mid.ABC') return { id: 1, payloadMeta: { senderId: 999 } };
      return null; // delete:<mid> — дубля нет
    });
    const { bindings, b24 } = deps();
    const log = { findInbound, recordInbound: vi.fn(async () => ({ id: 101 })) };
    const service = buildService({ bindings, b24, log });

    await service.routeInboundDelete(makeDeleteUpdate({ senderId: 54321 }));

    expect(b24.deleteConnectorMessage.mock.calls[0][0].author).toEqual({ id: 999, name: 'Иван Петров' });
    // имя ищем по автору оригинала, а не по удалившему
    expect(bindings.findParticipantName).toHaveBeenCalledWith(10, 999);
  });

  it('2b) M23: автора нет в participant_map → name: null (непустой fallback ставит b24Service)', async () => {
    const { bindings, b24, log } = deps({
      bindings: { findParticipantName: vi.fn(async () => null) },
    });
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate());

    expect(b24.deleteConnectorMessage.mock.calls[0][0].author).toEqual({ id: 54321, name: null });
    expect(result).toMatchObject({ ok: true });
  });

  it('3) идемпотентность: дубль (synthetic-key delete:<mid> найден) → duplicate-delete, B24 НЕ вызван', async () => {
    const findInbound = vi.fn(async (bindingId, key) => {
      if (key === 'delete:mid.ABC') return { id: 7, isDuplicate: () => true };
      return null;
    });
    const { bindings, b24 } = deps();
    const log = { findInbound, recordInbound: vi.fn() };
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate());

    expect(result).toMatchObject({ skipped: 'duplicate-delete' });
    expect(b24.deleteConnectorMessage).not.toHaveBeenCalled();
    expect(log.findInbound).toHaveBeenCalledWith(10, 'delete:mid.ABC');
  });

  it('4) binding не найден → binding-not-ready, без B24', async () => {
    const { b24, log } = deps();
    const bindings = { resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })) };
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate());

    expect(result).toMatchObject({ skipped: 'binding-not-ready' });
    expect(b24.deleteConnectorMessage).not.toHaveBeenCalled();
  });

  it('5) ошибка B24 delete → проброс (НЕ записываем; MAX ретраит)', async () => {
    const { bindings, log } = deps();
    const boom = new Error('B24 down');
    const b24 = { deleteConnectorMessage: vi.fn(async () => { throw boom; }) };
    const service = buildService({ bindings, b24, log });

    await expect(service.routeInboundDelete(makeDeleteUpdate())).rejects.toBe(boom);
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('5a) оригинала нет в message_log (не доходил до OL) → skip no-original, B24 НЕ вызван, без 500', async () => {
    const { bindings, b24 } = deps();
    const log = { findInbound: vi.fn(async () => null), recordInbound: vi.fn() };
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate());

    expect(result).toMatchObject({ skipped: 'no-original' });
    expect(b24.deleteConnectorMessage).not.toHaveBeenCalled();
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('6) нет mid → skip no-mid, B24 НЕ вызван', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate({ mid: null }));

    expect(result).toMatchObject({ skipped: 'no-mid' });
    expect(b24.deleteConnectorMessage).not.toHaveBeenCalled();
  });

  it('7) нет автора (в оригинале нет senderId + senderId события null) → skip no-author, B24 НЕ вызван', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundDelete(makeDeleteUpdate({ senderId: null }));

    expect(result).toMatchObject({ skipped: 'no-author' });
    expect(b24.deleteConnectorMessage).not.toHaveBeenCalled();
    expect(bindings.findParticipantName).not.toHaveBeenCalled();
  });

  it('8) неверный updateType → ValidationError', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });
    await expect(
      service.routeInboundDelete(makeDeleteUpdate({ updateType: 'message_created' })),
    ).rejects.toThrow(/only message_removed/);
  });
});

// ── OUTBOUND: routeOutboundDelete (Open Lines → MAX) ────────────────────────
// delete-payload: message.id приходит СТРОКОЙ (не массивом).
function makeDeleteEvent({ externalId = 'mid.MAX777', chatId = '21186' } = {}) {
  return OpenLineEvent.fromWebhookBody({
    event: 'ONIMCONNECTORMESSAGEDELETE',
    auth: { application_token: 'tok' },
    data: {
      CONNECTOR: 'max_b24',
      LINE: '42',
      MESSAGES: [
        {
          im: { ...(chatId != null ? { chat_id: chatId } : {}), message_id: '1459190' },
          message: { ...(externalId ? { id: externalId } : {}) },
          chat: { id: 'max:-70000000000954' },
        },
      ],
    },
  });
}

describe('MessagingService.routeOutboundDelete (OL → MAX)', () => {
  function deps(overrides = {}) {
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true })),
      ...overrides.bindings,
    };
    const max = {
      deleteOutgoing: vi.fn(async () => ({ deleted: true, maxMessage: null })),
      ...overrides.max,
    };
    const b24 = {
      sendDeliveryStatus: vi.fn(async () => ({ SUCCESS: true })),
      // M28: оповещение оператора о неудаче удаления.
      sendSystemMessage: vi.fn(async () => ({ b24MsgId: 777, dialogId: 'chat21186' })),
      ...overrides.b24,
    };
    const log = {
      findOutbound: vi.fn(async () => null),
      recordOutbound: vi.fn(async () => ({ id: 200 })),
      ...overrides.log,
    };
    return { bindings, max, b24, log };
  }

  it('1) happy path: maxMid из externalIds[0] (строка), deleteOutgoing вызван, synthetic-key, БЕЗ delivery-status', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(max.deleteOutgoing).toHaveBeenCalledOnce();
    expect(max.deleteOutgoing.mock.calls[0][0]).toEqual({ messageId: 'mid.MAX777' });

    expect(log.recordOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: 10,
        b24MsgId: 'delete:1459190',
        payloadMeta: expect.objectContaining({ kind: 'delete', origB24MsgId: '1459190', maxMid: 'mid.MAX777' }),
      }),
    );
    // delivery-status для удаления НЕ требуется
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, results: [expect.objectContaining({ ok: true })] });
  });

  it('2) maxMid из fallback findOutbound(payloadMeta.maxMid), когда externalIds пуст', async () => {
    const findOutbound = vi.fn(async (bindingId, key) => {
      if (key === '1459190') return { id: 1, payloadMeta: { maxMid: 'mid.FALLBACK' } };
      return null; // delete:<b24MsgId> — дубля нет
    });
    const { bindings, max, b24 } = deps();
    const log = { findOutbound, recordOutbound: vi.fn(async () => ({ id: 201 })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(max.deleteOutgoing.mock.calls[0][0].messageId).toBe('mid.FALLBACK');
    expect(result).toMatchObject({ ok: true });
  });

  it('3) нет maxMid (ни externalIds, ни fallback) → no-maxmid, deleteOutgoing НЕ вызван', async () => {
    const { bindings, max, b24 } = deps();
    const log = { findOutbound: vi.fn(async () => null), recordOutbound: vi.fn() };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toEqual({ skipped: 'no-maxmid' });
    expect(max.deleteOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled(); // M28: no-maxmid удаления — без оповещения
  });

  it('4) идемпотентность: synthetic-key delete:<b24MsgId> найден → duplicate-delete, MAX НЕ удаляем', async () => {
    const findOutbound = vi.fn(async (bindingId, key) => {
      if (key === 'delete:1459190') return { id: 9, isDuplicate: () => true };
      return null;
    });
    const { bindings, max, b24 } = deps();
    const log = { findOutbound, recordOutbound: vi.fn() };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(result.results[0]).toMatchObject({ skipped: 'duplicate-delete' });
    expect(max.deleteOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled(); // дубль — без оповещения
  });

  it('5) best-effort: не-MAX ошибка deleteOutgoing (баг) → ok:true + delete-error + «могло не дойти: внутренняя ошибка моста»', async () => {
    const { bindings, b24, log } = deps();
    const max = { deleteOutgoing: vi.fn(async () => { throw new Error('MAX 500'); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'delete-error' }] });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Удаление могло не дойти до MAX: внутренняя ошибка моста. У клиентов в MAX сообщение могло остаться.',
    });
  });

  it('5a) M28: recordOutbound бросил (БД) → delete-error + оповещение «внутренняя ошибка моста»', async () => {
    const { bindings, b24, max } = deps();
    const log = { findOutbound: vi.fn(async () => null), recordOutbound: vi.fn(async () => { throw new Error('db down'); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(max.deleteOutgoing).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, results: [{ skipped: 'delete-error' }] });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('могло не дойти до MAX: внутренняя ошибка моста');
  });

  it('6) MAX вернул success:false, записи оригинала нет → max-window + оповещение без возраста и без «24 ч», без record', async () => {
    const { bindings, b24, log } = deps();
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: 'Invalid chatId: 0' })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(result.results[0]).toEqual({ skipped: 'max-window', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    const { text } = b24.sendSystemMessage.mock.calls[0][0];
    expect(text).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его. У клиентов в MAX оно осталось.',
    );
    expect(text).not.toMatch(/24 ч|сутк/);
  });

  it('6a) M28: success:false с message → maxMessage MAX в warn (причина видна в логах)', async () => {
    const { bindings, b24, log } = deps();
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: 'Invalid chatId: 0' })) };
    const logger = silentLogger();
    const service = buildService({ bindings, b24, log, max, logger });

    await service.routeOutboundDelete(makeDeleteEvent());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ maxMid: 'mid.MAX777', maxMessage: 'Invalid chatId: 0' }),
      'routeOutboundDelete: MAX returned success:false for one message',
    );
  });

  it('6b) M28: в событии нет im.chat_id → оповещение по binding.b24ChatId', async () => {
    const { b24, log } = deps();
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding({ b24ChatId: '21564' }), isReady: true })),
    };
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: null })) };
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundDelete(makeDeleteEvent({ chatId: null }));

    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage.mock.calls[0][0].b24ChatId).toBe('21564');
  });

  it('6b1) M28: оповещение о неудаче — с installation из резолва привязки; внутренняя ошибка — без неё', async () => {
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true, installation })),
    };

    const refused = deps({ max: { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: null })) } });
    await buildService({ ...refused, bindings }).routeOutboundDelete(makeDeleteEvent());
    expect(refused.b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(refused.b24.sendSystemMessage.mock.calls[0][1].installation).toBe(installation);

    const internal = deps({ max: { deleteOutgoing: vi.fn(async () => { throw new Error('boom'); }) } });
    await buildService({ ...internal, bindings }).routeOutboundDelete(makeDeleteEvent());
    expect(internal.b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(internal.b24.sendSystemMessage.mock.calls[0]).toHaveLength(1);
  });

  it('6c) M28: успешное удаление — без оповещения', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(result.results[0]).not.toHaveProperty('notified');
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('6d) M28: оповещение не ушло (Б24 упал) → вердикт прежний, notified:false, без throw', async () => {
    const { bindings, log } = deps();
    const b24 = { sendSystemMessage: vi.fn(async () => { throw new Error('B24 down'); }) };
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: null })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'max-window', notified: false }] });
  });

  it('7) нет binding → no-binding', async () => {
    const { max, b24, log } = deps();
    const bindings = { resolveByConnectorChat: vi.fn(async () => ({ binding: null, isReady: false })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent());
    expect(result.results[0]).toMatchObject({ skipped: 'no-binding' });
    expect(max.deleteOutgoing).not.toHaveBeenCalled();
  });

  // ── M22: сообщение из нескольких файлов ───────────────────────────────────
  const multiLog = (extra = {}, { createdAt = null, maxMids = ['mid.1', 'mid.2', 'mid.3'] } = {}) => ({
    findOutbound: vi.fn(async (_bindingId, key) => (
      key === '1459190' ? { id: 1, payloadMeta: { maxMid: maxMids[0], maxMids }, createdAt } : null
    )),
    recordOutbound: vi.fn(async () => ({ id: 202 })),
    ...extra,
  });

  it('9) M22: несколько файлов → удаляются все maxMids (событие + message_log без дублей)', async () => {
    const { bindings, max, b24 } = deps();
    const log = multiLog();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: 'mid.1' }));

    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.1', 'mid.2', 'mid.3']);
    expect(log.recordOutbound.mock.calls[0][0].payloadMeta).toMatchObject({
      kind: 'delete', maxMid: 'mid.1', maxMids: ['mid.1', 'mid.2', 'mid.3'], deletedCount: 3,
    });
    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 3 });
  });

  it('10) M22: сбой удаления одного файла не мешает остальным; запись есть + M28 оповещение «не полностью»', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.2') throw new MaxApiError('HTTP 500', { httpStatus: 500 });
        return { deleted: true, maxMessage: null };
      }),
    };
    const log = multiLog();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(max.deleteOutgoing).toHaveBeenCalledTimes(3);
    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 2, notified: true });
    expect(log.recordOutbound).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Удаление доставлено в MAX не полностью: не удалено 1 из 3 вложений (MAX не принял (HTTP 500)). '
        + 'У клиентов в MAX они остались.',
    });
  });

  it('10a) M28: частично — success:false у одного → «не удалено 1 из 2 вложений (MAX не разрешил удалить)»', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => (
        messageId === 'mid.2' ? { deleted: false, maxMessage: 'Invalid chatId: 0' } : { deleted: true, maxMessage: null }
      )),
    };
    const log = multiLog({}, { maxMids: ['mid.1', 'mid.2'] });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 1, notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('не удалено 1 из 2 вложений (MAX не разрешил удалить)');
  });

  it('10a1) M28: частично — success:false и ошибка MAX → причина первой ОШИБКИ (success:false пропускается)', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.2') return { deleted: false, maxMessage: 'Invalid chatId: 0' };
        if (messageId === 'mid.3') throw new MaxApiError('HTTP 500', { httpStatus: 500 });
        return { deleted: true, maxMessage: null };
      }),
    };
    const service = buildService({ bindings, b24, log: multiLog(), max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 1, notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Удаление доставлено в MAX не полностью: не удалено 2 из 3 вложений (MAX не принял (HTTP 500)). '
      + 'У клиентов в MAX они остались.',
    );
  });

  it('10b) M28: частично из-за не-MAX ошибки → запись, причина «внутренняя ошибка моста»', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.3') throw new TypeError('bug');
        return { deleted: true, maxMessage: null };
      }),
    };
    const service = buildService({ bindings, b24, log: multiLog(), max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 2, notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('не удалено 1 из 3 вложений (внутренняя ошибка моста)');
  });

  it('10c) M28: журнал удалён целиком, не удалился лишь id из события (склейка, 400 proto.payload) → запись БЕЗ оповещения', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.1,mid.2') {
          throw new MaxApiError('Invalid message_id: mid.1,mid.2', { httpStatus: 400, maxCode: 'proto.payload' });
        }
        return { deleted: true, maxMessage: null };
      }),
    };
    const log = multiLog({}, { maxMids: ['mid.1', 'mid.2'] });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: 'mid.1,mid.2' }));

    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.1,mid.2', 'mid.1', 'mid.2']);
    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 2 });
    expect(result.results[0]).not.toHaveProperty('notified');
    expect(log.recordOutbound).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('10c1) M28: журнал целиком success:false, склейка из события упала 400 → max-window с возрастом, а не delete-failed', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.1,mid.2') {
          throw new MaxApiError('Invalid message_id: mid.1,mid.2', { httpStatus: 400, maxCode: 'proto.payload' });
        }
        return { deleted: false, maxMessage: 'Invalid chatId: 0' };
      }),
    };
    const createdAt = new Date(Date.now() - 30 * 3_600_000 - 60_000);
    const log = multiLog({}, { maxMids: ['mid.1', 'mid.2'], createdAt });
    const logger = silentLogger();
    const service = buildService({ bindings, b24, log, max, logger });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: 'mid.1,mid.2' }));

    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.1,mid.2', 'mid.1', 'mid.2']);
    expect(result.results[0]).toEqual({ skipped: 'max-window', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его (отправлено 30 ч назад). '
      + 'У клиентов в MAX оно осталось.',
    );
    // WARN max-window с возрастом пишется (по нему разбирают отказы MAX), ERROR — нет.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ageHours: expect.any(Number), eventOnlyNotDeleted: ['mid.1,mid.2'] }),
      'routeOutboundDelete: MAX refused to delete (success:false), not recording (operator will be notified)',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('10c2) M28: журнал целиком success:false, id из события упал таймаутом → max-window, не «могло не дойти»', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.EVT') throw new MaxApiError('timed out', { kind: 'timeout' });
        return { deleted: false, maxMessage: null };
      }),
    };
    const log = multiLog({}, { maxMids: ['mid.1', 'mid.2'] });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: 'mid.EVT' }));

    expect(result.results[0]).toEqual({ skipped: 'max-window', notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('MAX не разрешил удалить его');
  });

  it('10c3) M28: ничего не удалено, mid журнала упал ошибкой MAX → delete-failed с его причиной, а не ошибкой id события', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.1,mid.2') {
          throw new MaxApiError('Invalid message_id: mid.1,mid.2', { httpStatus: 400, maxCode: 'proto.payload' });
        }
        if (messageId === 'mid.2') throw new MaxApiError('HTTP 500', { httpStatus: 500 });
        return { deleted: false, maxMessage: null };
      }),
    };
    const log = multiLog({}, { maxMids: ['mid.1', 'mid.2'] });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: 'mid.1,mid.2' }));

    expect(result.results[0]).toEqual({ skipped: 'delete-failed', notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Удаление не доставлено в MAX: MAX не принял (HTTP 500). У клиентов в MAX сообщение осталось.',
    );
  });

  it('10d) M28: журнал пуст, один id события не удалился, другой удалён → «не полностью» по id события', async () => {
    const { bindings, b24 } = deps();
    const max = {
      deleteOutgoing: vi.fn(async ({ messageId }) => {
        if (messageId === 'mid.B') throw new MaxApiError('HTTP 500', { httpStatus: 500 });
        return { deleted: true, maxMessage: null };
      }),
    };
    const log = { findOutbound: vi.fn(async () => null), recordOutbound: vi.fn(async () => ({ id: 203 })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: ['mid.A', 'mid.B'] }));

    expect(result.results[0]).toMatchObject({ ok: true, deletedCount: 1, notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('не удалено 1 из 2 вложений (MAX не принял (HTTP 500))');
  });

  it('11) M22/M28: все удаления упали ошибкой MAX → delete-failed + оповещение, без записи', async () => {
    const { bindings, b24 } = deps();
    const max = { deleteOutgoing: vi.fn(async () => { throw new MaxApiError('HTTP 500', { httpStatus: 500 }); }) };
    const log = multiLog();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(max.deleteOutgoing).toHaveBeenCalledTimes(3);
    expect(result.results[0]).toEqual({ skipped: 'delete-failed', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Удаление не доставлено в MAX: MAX не принял (HTTP 500). У клиентов в MAX сообщение осталось.',
    });
  });

  it('11a) M28: все упали таймаутом → delete-failed + «могло не дойти»', async () => {
    const { bindings, b24 } = deps();
    const max = { deleteOutgoing: vi.fn(async () => { throw new MaxApiError('timed out', { kind: 'timeout' }); }) };
    const service = buildService({ bindings, b24, log: multiLog(), max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toEqual({ skipped: 'delete-failed', notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Удаление могло не дойти до MAX: MAX не ответил вовремя. У клиентов в MAX сообщение могло остаться.',
    );
  });

  it('12) M22/M28: все success:false → max-window + оповещение с возрастом из записи оригинала, без «24 ч»', async () => {
    const { bindings, b24 } = deps();
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: 'Invalid chatId: 0' })) };
    const createdAt = new Date(Date.now() - 30 * 3_600_000 - 60_000);
    const log = multiLog({}, { createdAt });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(result.results[0]).toEqual({ skipped: 'max-window', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    const { text } = b24.sendSystemMessage.mock.calls[0][0];
    expect(text).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его (отправлено 30 ч назад). '
      + 'У клиентов в MAX оно осталось.',
    );
    expect(text).not.toMatch(/24 ч|сутк/);
  });

  it('12a) M28: createdAt строкой (свежее сообщение) → «отправлено меньше часа назад»', async () => {
    const { bindings, b24 } = deps();
    const max = { deleteOutgoing: vi.fn(async () => ({ deleted: false, maxMessage: null })) };
    const log = multiLog({}, { createdAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundDelete(makeDeleteEvent({ externalId: null }));

    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('(отправлено меньше часа назад)');
  });

  it('8) событие без сообщений → no-messages', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });
    const empty = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEDELETE', data: { MESSAGES: [] } });

    const result = await service.routeOutboundDelete(empty);
    expect(result).toMatchObject({ skipped: 'no-messages' });
  });
});
