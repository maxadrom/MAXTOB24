// Unit-тесты MessagingService.routeInboundEdit (MAX→OL) и routeOutboundEdit (OL→MAX) —
// двусторонняя правка сообщений. Integration через моки адаптеров, БД/сеть не нужны.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';

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

function buildService({ bindings, b24, log, max } = {}) {
  return new MessagingService({
    bindingsService: bindings,
    b24Service: b24,
    maxService: max,
    messageLogRepository: log,
    logger: silentLogger(),
  });
}

// ── INBOUND: routeInboundEdit (MAX → Open Lines) ────────────────────────────
function makeEditUpdate(overrides = {}) {
  return {
    updateType: 'message_edited',
    timestamp: 1700000005000, // мс → 1700000005 сек
    chatId: -70000000000954,
    mid: 'mid.ABC',
    senderId: 54321,
    senderName: 'Иван',
    message: { body: { text: 'исправленный текст' } },
    replyContext: null,
    ...overrides,
  };
}

describe('MessagingService.routeInboundEdit (MAX → OL)', () => {
  // findInbound по ключу: edit:<mid>:<ts> — dedup (по умолчанию пуст), «голый» mid —
  // запись оригинала (по умолчанию есть: сообщение дошло до OL).
  const originalOnly = (bindingId, key) => (key === 'mid.ABC' ? { id: 1, payloadMeta: {} } : null);

  function deps(overrides = {}) {
    const bindings = {
      resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true })),
      ...overrides.bindings,
    };
    const b24 = {
      updateConnectorMessage: vi.fn(async () => ({ success: true, raw: {} })),
      ...overrides.b24,
    };
    const log = {
      findInbound: vi.fn(async (bindingId, key) => originalOnly(bindingId, key)),
      recordInbound: vi.fn(async () => ({ id: 100 })),
      ...overrides.log,
    };
    return { bindings, b24, log };
  }

  it('1) happy path: обновляет OL на тот же external id, клеит маркер «Изменено», пишет synthetic-key', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(makeEditUpdate());

    expect(b24.updateConnectorMessage).toHaveBeenCalledOnce();
    const msg = b24.updateConnectorMessage.mock.calls[0][0];
    expect(msg.externalMessageId).toBe('max:mid:mid.ABC');
    expect(msg.text).toContain('исправленный текст');
    expect(msg.text).toContain('[br]----[br][i]Изменено[/i]');
    expect(msg.date).toBe(1700000005); // секунды

    // synthetic-key в recordInbound (НЕ «голый» mid)
    expect(log.recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: 10,
        maxMid: 'edit:mid.ABC:1700000005000',
        payloadMeta: expect.objectContaining({ kind: 'edit', origMid: 'mid.ABC' }),
      }),
    );
    expect(result).toMatchObject({ ok: true, externalId: 'max:mid:mid.ABC' });
  });

  it('2) маркер не накапливается: текст пересобран с нуля → ровно один [br][i]Изменено[/i]', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    await service.routeInboundEdit(makeEditUpdate());
    const text = b24.updateConnectorMessage.mock.calls[0][0].text;
    const occurrences = text.split('[i]Изменено[/i]').length - 1;
    expect(occurrences).toBe(1);
  });

  it('3) идемпотентность: дубль правки (synthetic-key найден) → duplicate-edit, B24 НЕ вызван', async () => {
    const { bindings, b24, log } = deps({
      log: { findInbound: vi.fn(async () => ({ id: 7, isDuplicate: () => true })) },
    });
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(makeEditUpdate());

    expect(result).toMatchObject({ skipped: 'duplicate-edit' });
    expect(b24.updateConnectorMessage).not.toHaveBeenCalled();
    // dedup-ключ — синтетический edit:<mid>:<ts>, а не голый mid
    expect(log.findInbound).toHaveBeenCalledWith(10, 'edit:mid.ABC:1700000005000');
  });

  it('4) binding не найден → binding-not-ready, без онбординга и без B24', async () => {
    const { b24, log } = deps();
    const bindings = { resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })) };
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(makeEditUpdate());

    expect(result).toMatchObject({ skipped: 'binding-not-ready' });
    expect(b24.updateConnectorMessage).not.toHaveBeenCalled();
  });

  it('4a) оригинала нет в message_log (не доходил до OL) → skip no-original, B24 НЕ вызван, без 500', async () => {
    const { bindings, b24 } = deps();
    const log = { findInbound: vi.fn(async () => null), recordInbound: vi.fn() };
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(makeEditUpdate());

    expect(result).toMatchObject({ skipped: 'no-original' });
    expect(b24.updateConnectorMessage).not.toHaveBeenCalled();
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('5) пустой текст правки → empty-edit, B24 НЕ вызван', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(
      makeEditUpdate({ message: { body: { text: '' } } }),
    );

    expect(result).toMatchObject({ skipped: 'empty-edit' });
    expect(b24.updateConnectorMessage).not.toHaveBeenCalled();
  });

  it('6) правка без sender → no-sender (graceful, без 5xx)', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInboundEdit(makeEditUpdate({ senderId: null }));

    expect(result).toMatchObject({ skipped: 'no-sender' });
    expect(b24.updateConnectorMessage).not.toHaveBeenCalled();
  });

  it('7) ошибка B24 update → проброс (НЕ записываем; MAX ретраит)', async () => {
    const { bindings, log } = deps();
    const boom = new Error('B24 down');
    const b24 = { updateConnectorMessage: vi.fn(async () => { throw boom; }) };
    const service = buildService({ bindings, b24, log });

    await expect(service.routeInboundEdit(makeEditUpdate())).rejects.toBe(boom);
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('7b) ошибка B24 update → ровно один ERROR-лог координатора с b24Code/b24Description', async () => {
    const { bindings, log } = deps();
    const boom = new B24ApiError('WRONG_AUTH_TYPE', 'wrong auth type', {
      method: 'imconnector.update.messages',
    });
    const b24 = { updateConnectorMessage: vi.fn(async () => { throw boom; }) };
    const service = buildService({ bindings, b24, log });

    await expect(service.routeInboundEdit(makeEditUpdate())).rejects.toBe(boom);
    expect(service.logger.error).toHaveBeenCalledOnce();
    expect(service.logger.error.mock.calls[0][0]).toMatchObject({
      method: 'imconnector.update.messages',
      b24Code: 'WRONG_AUTH_TYPE',
      b24Description: 'wrong auth type',
    });
  });

  it('8) неверный updateType → ValidationError', async () => {
    const { bindings, b24, log } = deps();
    const service = buildService({ bindings, b24, log });
    await expect(
      service.routeInboundEdit(makeEditUpdate({ updateType: 'message_created' })),
    ).rejects.toThrow(/only message_edited/);
  });
});

// ── OUTBOUND: routeOutboundEdit (Open Lines → MAX) ──────────────────────────
function makeUpdateEvent({
  externalIds = ['mid.MAX777'],
  editTs = 1700000123,
  text = '[b]Оператор:[/b] [br]правка из Б24',
  chatId = '21186',
} = {}) {
  return OpenLineEvent.fromWebhookBody({
    event: 'ONIMCONNECTORMESSAGEUPDATE',
    auth: { application_token: 'tok' },
    data: {
      CONNECTOR: 'max_b24',
      LINE: '42',
      MESSAGES: [
        {
          im: { ...(chatId != null ? { chat_id: chatId } : {}), message_id: '1459190' },
          message: {
            ...(externalIds ? { id: externalIds } : {}),
            user_id: '1',
            text,
            ...(editTs != null ? { date: editTs } : {}),
          },
          chat: { id: 'max:-70000000000954' },
        },
      ],
    },
  });
}

describe('MessagingService.routeOutboundEdit (OL → MAX)', () => {
  function deps(overrides = {}) {
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true })),
      ...overrides.bindings,
    };
    const max = {
      editOutgoing: vi.fn(async () => ({ timestampMs: 1700000123000 })),
      ...overrides.max,
    };
    const b24 = {
      sendDeliveryStatus: vi.fn(async () => ({ SUCCESS: true })),
      // M28: оповещение оператора о неудаче правки.
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

  // M28: тексты оповещений (operatorNotices.js).
  const EDIT_NOT_FOUND = '⚠️ Правка не доставлена в MAX: исходное сообщение не найдено в MAX '
    + '(не было доставлено или ещё доставлялось). Отправьте исправленный текст новым сообщением.';
  const editFailedText = (reason) => `⚠️ Правка не доставлена в MAX: ${reason}. `
    + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.';
  const editUncertainText = (reason) => `⚠️ Правка могла не дойти до MAX: ${reason}. `
    + 'Если важно, отредактируйте сообщение ещё раз.';

  it('1) happy path: maxMid из externalIds[0], editOutgoing вызван, synthetic-key записан, delivery-status best-effort', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(max.editOutgoing).toHaveBeenCalledOnce();
    const editArg = max.editOutgoing.mock.calls[0][0];
    expect(editArg.messageId).toBe('mid.MAX777');
    expect(editArg.text).toContain('правка из Б24');

    // synthetic-key edit:<b24MsgId>:<contentToken> (токен = хеш текста, не editTs)
    expect(log.recordOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: 10,
        b24MsgId: expect.stringMatching(/^edit:1459190:[0-9a-f]{16}$/),
        payloadMeta: expect.objectContaining({ kind: 'edit', maxMid: 'mid.MAX777' }),
      }),
    );
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ externalIds: ['mid.MAX777'] }),
    );
    expect(result).toMatchObject({ ok: true, results: [expect.objectContaining({ ok: true })] });
  });

  it('2) maxMid из fallback findOutbound(payloadMeta.maxMid), когда externalIds пуст', async () => {
    // findOutbound: первый вызов (по b24MsgId) → запись оригинала с maxMid;
    // второй вызов (по synthetic-key) → null (правки ещё не было).
    const findOutbound = vi.fn(async (bindingId, key) => {
      if (key === '1459190') return { id: 1, payloadMeta: { maxMid: 'mid.FALLBACK' }, isDuplicate: () => true };
      return null;
    });
    const { bindings, max, b24 } = deps();
    const log = { findOutbound, recordOutbound: vi.fn(async () => ({ id: 201 })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent({ externalIds: null }));

    expect(max.editOutgoing.mock.calls[0][0].messageId).toBe('mid.FALLBACK');
    expect(result).toMatchObject({ ok: true });
  });

  it('2a) M22: сообщение из нескольких файлов → правится первое, статус доставки несёт все maxMids', async () => {
    const findOutbound = vi.fn(async (_bindingId, key) => (
      key === '1459190' ? { id: 1, payloadMeta: { maxMid: 'mid.1', maxMids: ['mid.1', 'mid.2'] } } : null
    ));
    const { bindings, max, b24 } = deps();
    const log = { findOutbound, recordOutbound: vi.fn(async () => ({ id: 202 })) };
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundEdit(makeUpdateEvent({ externalIds: ['mid.1'] }));

    expect(max.editOutgoing).toHaveBeenCalledOnce();
    expect(max.editOutgoing.mock.calls[0][0].messageId).toBe('mid.1');
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(expect.objectContaining({ externalIds: ['mid.1', 'mid.2'] }));
  });

  it('3) нет maxMid (ни externalIds, ни fallback) → no-maxmid + оповещение «не найдено», editOutgoing НЕ вызван', async () => {
    const { bindings, max, b24 } = deps();
    const log = { findOutbound: vi.fn(async () => null), recordOutbound: vi.fn() };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent({ externalIds: null }));

    expect(result.results[0]).toEqual({ skipped: 'no-maxmid', notified: true });
    expect(max.editOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21186', text: EDIT_NOT_FOUND });
  });

  it('4) идемпотентность: synthetic-key найден → duplicate-edit, MAX НЕ правим', async () => {
    // ключ теперь edit:<b24MsgId>:<contentToken>; матчим по префиксу, не по магическому хешу
    const findOutbound = vi.fn(async (bindingId, key) => {
      if (/^edit:1459190:[0-9a-f]{16}$/.test(key)) return { id: 9, isDuplicate: () => true };
      return null;
    });
    const { bindings, max, b24 } = deps();
    const log = { findOutbound, recordOutbound: vi.fn() };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result.results[0]).toMatchObject({ skipped: 'duplicate-edit' });
    expect(max.editOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled(); // дубль — без оповещения
  });

  it('5) M28: сбой MAX (MaxApiError) → edit-failed + оповещение, без записи и статуса доставки, 200', async () => {
    const { bindings, b24, log } = deps();
    const max = { editOutgoing: vi.fn(async () => { throw new MaxApiError('HTTP 500', { httpStatus: 500 }); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-failed', notified: true }] });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: editFailedText('MAX не принял (HTTP 500)'),
    });
  });

  it('5a) M28: не MaxApiError (баг) → edit-error + оповещение «могла не дойти: внутренняя ошибка моста»', async () => {
    const { bindings, b24, log } = deps();
    const max = { editOutgoing: vi.fn(async () => { throw new Error('MAX 500'); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-error' }] });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: editUncertainText('внутренняя ошибка моста'),
    });
  });

  it('5b) M28: HTTP 400 proto.payload (некорректный mid, live) → «MAX не принял (proto.payload)»', async () => {
    const { bindings, b24, log } = deps();
    const max = {
      editOutgoing: vi.fn(async () => {
        throw new MaxApiError('Invalid message_id: bogus', { httpStatus: 400, maxCode: 'proto.payload' });
      }),
    };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result.results[0]).toEqual({ skipped: 'edit-failed', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(editFailedText('MAX не принял (proto.payload)'));
  });

  it('5b1) M28: HTTP 400 proto.payload «Field \'text\' size…» (live 2026-10-09) → «текст слишком длинный», «сократите текст»', async () => {
    const { bindings, b24, log } = deps();
    const maxMessage = "Field 'text' size (4321) must be at most 4000";
    const max = {
      editOutgoing: vi.fn(async () => {
        throw new MaxApiError(`HTTP 400 — ${maxMessage}`, { httpStatus: 400, maxCode: 'proto.payload', maxMessage });
      }),
    };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result.results[0]).toEqual({ skipped: 'edit-failed', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Правка не доставлена в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). '
      + 'У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.',
    );
  });

  it("5c) M28: success:false (kind 'rejected') → «MAX отказал», статус доставки не шлётся", async () => {
    const { bindings, b24, log } = deps();
    const max = {
      editOutgoing: vi.fn(async () => {
        throw new MaxApiError('PUT /messages: success:false — Error on message edit', { kind: 'rejected' });
      }),
    };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result.results[0]).toEqual({ skipped: 'edit-failed', notified: true });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(editFailedText('MAX отказал'));
  });

  it('5d) M28: таймаут MAX → «Правка могла не дойти…»', async () => {
    const { bindings, b24, log } = deps();
    const max = { editOutgoing: vi.fn(async () => { throw new MaxApiError('timed out', { kind: 'timeout' }); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result.results[0]).toEqual({ skipped: 'edit-failed', notified: true });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(editUncertainText('MAX не ответил вовремя'));
  });

  it('5e) M28: recordOutbound бросил (БД) → edit-error + оповещение «внутренняя ошибка моста»', async () => {
    const { bindings, b24, max } = deps();
    const log = {
      findOutbound: vi.fn(async () => null),
      recordOutbound: vi.fn(async () => { throw new Error('db down'); }),
    };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(max.editOutgoing).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-error' }] });
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: editUncertainText('внутренняя ошибка моста'),
    });
  });

  it('5f) M28: в событии нет im.chat_id → оповещение по binding.b24ChatId', async () => {
    const { b24, log } = deps();
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding({ b24ChatId: '21564' }), isReady: true })),
    };
    const max = { editOutgoing: vi.fn(async () => { throw new MaxApiError('HTTP 500', { httpStatus: 500 }); }) };
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundEdit(makeUpdateEvent({ chatId: null }));

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21564',
      text: editFailedText('MAX не принял (HTTP 500)'),
    });
  });

  // M28: installation из резолва привязки — в статус доставки и оповещение (без повторного
  // чтения БД); оповещение о внутренней ошибке (onError) её не получает — привязка там неизвестна.
  it('5h) M28: installation из резолва → тем же объектом в статус доставки', async () => {
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };
    const { max, b24, log } = deps();
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true, installation })),
    };
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundEdit(makeUpdateEvent());

    expect(b24.sendDeliveryStatus.mock.calls[0][0].installation).toBe(installation);
  });

  it('5i) M28: сбой MAX → оповещение с installation из резолва; внутренняя ошибка → без неё', async () => {
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };
    const bindings = {
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true, installation })),
    };

    const failed = deps({ max: { editOutgoing: vi.fn(async () => { throw new MaxApiError('HTTP 500', { httpStatus: 500 }); }) } });
    await buildService({ ...failed, bindings }).routeOutboundEdit(makeUpdateEvent());
    expect(failed.b24.sendSystemMessage).toHaveBeenCalledWith(
      { b24ChatId: '21186', text: editFailedText('MAX не принял (HTTP 500)') },
      { installation },
    );
    expect(failed.b24.sendSystemMessage.mock.calls[0][1].installation).toBe(installation);

    const internal = deps({ log: { recordOutbound: vi.fn(async () => { throw new Error('db down'); }) } });
    await buildService({ ...internal, bindings }).routeOutboundEdit(makeUpdateEvent());
    expect(internal.b24.sendSystemMessage.mock.calls[0]).toEqual([
      { b24ChatId: '21186', text: editUncertainText('внутренняя ошибка моста') },
    ]);
  });

  it('5g) M28: оповещение не ушло (Б24 упал) → вердикт прежний, notified:false, без throw', async () => {
    const { bindings, log } = deps();
    const b24 = {
      sendDeliveryStatus: vi.fn(),
      sendSystemMessage: vi.fn(async () => { throw new B24ApiError('ACCESS_ERROR', 'no access'); }),
    };
    const max = { editOutgoing: vi.fn(async () => { throw new MaxApiError('HTTP 500', { httpStatus: 500 }); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-failed', notified: false }] });
  });

  it('5h) M28: onError сам бросил → обвязка всё равно отдаёт edit-error, наружу не бросает', async () => {
    const { bindings, b24 } = deps();
    const log = {
      findOutbound: vi.fn(async () => { throw new Error('db down'); }),
      recordOutbound: vi.fn(),
    };
    const max = { editOutgoing: vi.fn() };
    const service = buildService({ bindings, b24, log, max });
    service.notifyOperator = vi.fn(() => { throw new Error('notify boom'); });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-error' }] });
    expect(service.notifyOperator).toHaveBeenCalledOnce();
  });

  it('6) delivery-status упал → правка всё равно успешна (non-fatal)', async () => {
    const { bindings, max, log } = deps();
    const b24 = { sendDeliveryStatus: vi.fn(async () => { throw new Error('delivery boom'); }) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());

    expect(max.editOutgoing).toHaveBeenCalledOnce();
    expect(result.results[0]).toMatchObject({ ok: true });
  });

  it('6a) M28: успешная правка — без оповещения', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });

    await service.routeOutboundEdit(makeUpdateEvent());

    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('7) нет binding → no-binding', async () => {
    const { max, b24, log } = deps();
    const bindings = { resolveByConnectorChat: vi.fn(async () => ({ binding: null, isReady: false })) };
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeOutboundEdit(makeUpdateEvent());
    expect(result.results[0]).toMatchObject({ skipped: 'no-binding' });
    expect(max.editOutgoing).not.toHaveBeenCalled();
  });

  it('8) событие без сообщений → no-messages', async () => {
    const { bindings, max, b24, log } = deps();
    const service = buildService({ bindings, b24, log, max });
    const empty = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEUPDATE', data: { MESSAGES: [] } });

    const result = await service.routeOutboundEdit(empty);
    expect(result).toMatchObject({ skipped: 'no-messages' });
  });

  // In-memory message_log: имитирует findOutbound + recordOutbound (INSERT ON CONFLICT
  // DO NOTHING) с дедупом по синтетическому ключу. Нужен, чтобы прогнать две
  // последовательные правки и проверить семантику контент-токена.
  function statefulLog() {
    const store = new Map(); // key → entry
    let seq = 0;
    return {
      findOutbound: vi.fn(async (bindingId, key) => store.get(key) ?? null),
      recordOutbound: vi.fn(async ({ b24MsgId: key }) => {
        if (store.has(key)) return null; // конфликт → ON CONFLICT DO NOTHING
        const entry = { id: ++seq, isDuplicate: () => true };
        store.set(key, entry);
        return entry;
      }),
      _store: store,
    };
  }

  it('9) фикс бага: две правки одного b24MsgId с РАЗНЫМ текстом → обе доходят до MAX, две записи', async () => {
    const { bindings, max, b24 } = deps();
    const log = statefulLog();
    const service = buildService({ bindings, b24, log, max });

    const r1 = await service.routeOutboundEdit(makeUpdateEvent({ text: 'первая правка' }));
    const r2 = await service.routeOutboundEdit(makeUpdateEvent({ text: 'вторая правка' }));

    expect(r1.results[0]).toMatchObject({ ok: true });
    expect(r2.results[0]).toMatchObject({ ok: true }); // НЕ duplicate-edit
    expect(max.editOutgoing).toHaveBeenCalledTimes(2);

    // две разные строки message_log с разными editKey
    const keys = [...log._store.keys()];
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    keys.forEach((k) => expect(k).toMatch(/^edit:1459190:[0-9a-f]{16}$/));
  });

  it('10) ретрай-идемпотентность: две правки одного b24MsgId с ОДИНАКОВЫМ текстом → вторая duplicate-edit', async () => {
    const { bindings, max, b24 } = deps();
    const log = statefulLog();
    const service = buildService({ bindings, b24, log, max });

    const r1 = await service.routeOutboundEdit(makeUpdateEvent({ text: 'тот же текст' }));
    const r2 = await service.routeOutboundEdit(makeUpdateEvent({ text: 'тот же текст' }));

    expect(r1.results[0]).toMatchObject({ ok: true });
    expect(r2.results[0]).toMatchObject({ skipped: 'duplicate-edit' });
    expect(max.editOutgoing).toHaveBeenCalledOnce();
    expect([...log._store.keys()]).toHaveLength(1);
  });
});
