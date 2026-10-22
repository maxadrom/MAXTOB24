// Unit-тесты MessagingService.routeInbound (M4.2) и routeOutbound (M5.2) —
// integration через моки адаптеров. БД/сеть не нужны.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { ConnectorMessage } from '../../src/modules/b24/models/ConnectorMessage.js';
import { escapeBbcode } from '../../src/modules/b24/bbcode.js';
import { ChatBinding } from '../../src/modules/bindings/models/ChatBinding.js';
import { contentHash } from '../../src/shared/crypto/contentHash.js';
import { MaxMessage } from '../../src/modules/max/models/MaxMessage.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { MediaTooLargeError } from '../../src/shared/media/mediaTooLargeError.js';

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

function logged(fnMock, msgPart) {
  return fnMock.mock.calls.some((c) => String(c[1] ?? '').includes(msgPart));
}

const renamingFailed = () => new B24ApiError('CHAT_RENAMING_FAILED', 'Chat renaming failed', {
  method: 'imconnector.chat.name.set',
  httpStatus: 400,
});

// b24ChatId по умолчанию задан: чат OL известен → интро группы (M24) не вклинивается.
function makeBinding(overrides = {}) {
  return {
    id: 10,
    connectorChatId: 'max:-70000000000954',
    maxChatTitle: 'Группа Север',
    b24ChatId: '21180',
    isReadyForRouting: () => true,
    ...overrides,
  };
}

// M24: настоящая доменная модель — для интро и синхронизации названия (needsOlTitleSync).
function chatBinding(overrides = {}) {
  return new ChatBinding({
    id: 10,
    installationId: 1,
    maxChatId: '-70000000000954',
    connectorChatId: 'max:-70000000000954',
    maxChatTitle: null,
    b24ChatId: null,
    olChatTitle: null,
    ...overrides,
  });
}

function fakeBindings(overrides = {}) {
  return {
    resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true })),
    ensureForMaxChat: vi.fn(async () => ({ binding: makeBinding(), created: true })),
    ensureParticipant: vi.fn(async () => ({ id: 1 })),
    // M-lifecycle: best-effort персист b24_chat_id на inbound.
    attachB24ChatId: vi.fn(async (id, b24ChatId) => makeBinding({ id, b24ChatId })),
    // M25: best-effort учёт сессии OL после отправки (опенеры — messagingService.session.test.js).
    rememberOlSession: vi.fn(async () => null),
    ...overrides,
  };
}

function fakeB24(overrides = {}) {
  return {
    sendConnectorMessage: vi.fn(async () => ({
      b24MsgId: 'max:mid:mid.ABC',
      sessionId: '15756',
      b24ChatId: '21180',
      raw: {},
    })),
    // M27: состояние чата OL на CHAT_RENAMING_FAILED — по умолчанию не прочитано.
    getOlChat: vi.fn(async () => null),
    ...overrides,
  };
}

function fakeLog(overrides = {}) {
  return {
    findInbound: vi.fn(async () => null),
    recordInbound: vi.fn(async () => ({ id: 100 })),
    // M27: ссылка на группу уже постилась — ленивый шаг не зовёт GET /chats (сценарии
    // ссылки — messagingService.groupLink.test.js).
    hasInboundKeyPrefix: vi.fn(async () => true),
    ...overrides,
  };
}

// maxService для inbound — getChatInfo (интро группы, M24) + getMemberAvatar (аватар, M10).
function fakeMaxInbound(overrides = {}) {
  return {
    getChatInfo: vi.fn(async () => ({
      title: 'Группа из MAX',
      iconUrl: 'https://i.oneme.ru/i?r=ICON',
      type: 'chat',
    })),
    getMemberAvatar: vi.fn(async () => 'https://i.oneme.ru/avatar.png'),
    ...overrides,
  };
}

// M11.2: mediaFiles — список нейтральных DTO { kind, url, name }, которые вернёт
// update.attachments() (зеркало MaxUpdate.attachments()). По умолчанию [].
function makeUpdate(overrides = {}) {
  const { mediaFiles, ...rest } = overrides;
  const update = {
    updateType: 'message_created',
    timestamp: 1700000000000, // мс — должно конвертироваться в 1700000000 сек
    chatId: -70000000000954,
    mid: 'mid.ABC',
    senderId: 54321,
    senderName: 'Иван',
    message: { body: { text: 'привет' } },
    ...rest,
  };
  // attachments() ставим ПОСЛЕ spread — чтобы overrides не подменили его не-функцией.
  update.attachments = () => mediaFiles ?? [];
  return update;
}

function buildService({ bindings, b24, log, max } = {}) {
  return new MessagingService({
    bindingsService: bindings ?? fakeBindings(),
    b24Service: b24 ?? fakeB24(),
    maxService: max,
    messageLogRepository: log ?? fakeLog(),
    logger: silentLogger(),
  });
}

describe('MessagingService constructor — reply config', () => {
  it('this.reply имеет безопасный дефолт, когда reply не передан', () => {
    const service = new MessagingService({
      bindingsService: fakeBindings(),
      messageLogRepository: fakeLog(),
      logger: silentLogger(),
    });
    expect(service.reply).toEqual({ resolveOutbound: false, searchLimit: 50, quoteMaxLen: 200 });
  });

  it('this.reply прокидывается из конструктора как есть', () => {
    const reply = { resolveOutbound: true, searchLimit: 120, quoteMaxLen: 64 };
    const service = new MessagingService({
      bindingsService: fakeBindings(),
      messageLogRepository: fakeLog(),
      logger: silentLogger(),
      reply,
    });
    expect(service.reply).toEqual(reply);
  });
});

describe('MessagingService.routeInbound', () => {
  it('1) happy path: B24 вызван, participant апсёрчен, recordInbound записан; date в секундах', async () => {
    const bindings = fakeBindings();
    const b24 = fakeB24();
    const log = fakeLog();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInbound(makeUpdate());

    expect(bindings.ensureParticipant).toHaveBeenCalledWith(10, {
      maxUserId: 54321,
      displayName: 'Иван',
    });
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm).toBeInstanceOf(ConnectorMessage);
    expect(cm.connectorChatId).toBe('max:-70000000000954');
    expect(cm.externalMessageId).toBe('max:mid:mid.ABC');
    expect(cm.author).toEqual({ id: 54321, name: 'Иван' });
    // 1700000000000 мс → 1700000000 сек (10 цифр)
    expect(cm.date).toBe(1700000000);

    expect(log.recordInbound).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      bindingId: 10,
      maxMid: 'mid.ABC',
      b24MsgId: 'max:mid:mid.ABC',
      logId: 100,
    });
  });

  it('2) no binding → ensureForMaxChat вызван, B24-send выполнен, happy-path (авто-онбординг M7)', async () => {
    const b24 = fakeB24();
    const log = fakeLog();
    const installation = { id: 1 };
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false, installation })),
    });
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInbound(makeUpdate());

    // M21: installation из резолва — повторно её не читаем.
    expect(bindings.ensureForMaxChat).toHaveBeenCalledWith(-70000000000954, { installation });
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, bindingId: 10 });
  });

  it('3) M21: привязка без connector_chat_id → самовосстановление upsert\'ом, сообщение доставлено', async () => {
    const b24 = fakeB24();
    b24.resolveB24ChatId = vi.fn(async () => '21180');
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({
        binding: makeBinding({ connectorChatId: null }),
        isReady: false,
      })),
      // Адрес чата OL ещё не сохранён — проверяем, что интро не считает привязку новой.
      ensureForMaxChat: vi.fn(async () => ({ binding: makeBinding({ b24ChatId: null }), created: false })),
    });
    const service = buildService({ bindings, b24 });

    const result = await service.routeInbound(makeUpdate());

    expect(bindings.ensureForMaxChat).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, bindingId: 10 });
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    // Привязка не новая (created=false): чат OL мог существовать — интро проверяет dialog.get.
    expect(b24.resolveB24ChatId).toHaveBeenCalledOnce();
  });

  it('4) duplicate (findInbound → isDuplicate()===true) → {skipped:"duplicate"}, B24 не вызван', async () => {
    const b24 = fakeB24();
    const log = fakeLog({
      findInbound: vi.fn(async () => ({ id: 99, isDuplicate: () => true })),
    });
    const service = buildService({ b24, log });

    const result = await service.routeInbound(makeUpdate());
    expect(result).toEqual({ skipped: 'duplicate', logId: 99 });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('5) empty text (нет body.text, нет attachments) → {skipped:"empty-message"}, B24 не вызван', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    const result = await service.routeInbound(makeUpdate({ message: { body: {} } }));
    expect(result).toEqual({ skipped: 'empty-message' });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('6) B24 бросает B24ApiError → проброс, recordInbound НЕ вызван', async () => {
    const log = fakeLog();
    const b24 = fakeB24({
      sendConnectorMessage: vi.fn(async () => {
        throw new B24ApiError('CONNECTOR_SEND_FAILED', 'boom', { method: 'imconnector.send.messages' });
      }),
    });
    const service = buildService({ b24, log });

    await expect(service.routeInbound(makeUpdate())).rejects.toThrow(B24ApiError);
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('7) race (recordInbound вернул null из пустых rows) → {skipped:"duplicate-race"}', async () => {
    const log = fakeLog({ recordInbound: vi.fn(async () => null) });
    const b24 = fakeB24();
    const service = buildService({ b24, log });

    const result = await service.routeInbound(makeUpdate());
    expect(result).toEqual({ skipped: 'duplicate-race' });
    // B24 уже был отправлен до записи в лог.
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
  });

  it('8) no sender (senderId:null) → {skipped:"no-sender"}, ни B24, ни ensureParticipant', async () => {
    const b24 = fakeB24();
    const bindings = fakeBindings();
    const service = buildService({ bindings, b24 });

    const result = await service.routeInbound(makeUpdate({ senderId: null }));
    expect(result).toEqual({ skipped: 'no-sender' });
    expect(bindings.ensureParticipant).not.toHaveBeenCalled();
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('9) attachments без текста (M11.2) → НЕ skip, шлёт message.files, ok', async () => {
    const b24 = fakeB24();
    const log = fakeLog();
    const service = buildService({ b24, log });

    const result = await service.routeInbound(
      makeUpdate({
        message: { body: { text: '' } },
        mediaFiles: [{ kind: 'image', url: 'https://i.oneme.ru/a', name: '1.webp' }],
      }),
    );

    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('');
    expect(cm.files).toEqual([{ url: 'https://i.oneme.ru/a', name: '1.webp' }]);
    expect(result).toMatchObject({ ok: true });
    // payloadMeta содержит media-метаданные (filesCount/kinds).
    const meta = log.recordInbound.mock.calls[0][0].payloadMeta;
    expect(meta).toMatchObject({ filesCount: 1, kinds: ['image'] });
  });

  it('9b) text + files → ConnectorMessage с обоими, ok', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    await service.routeInbound(
      makeUpdate({
        message: { body: { text: 'смотри' } },
        mediaFiles: [
          { kind: 'image', url: 'https://i.oneme.ru/a', name: '1.webp' },
          { kind: 'file', url: 'https://fd.oneme.ru/b', name: 'd.pdf' },
        ],
      }),
    );

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('смотри');
    expect(cm.files).toHaveLength(2);
  });

  it('9c) ни text, ни files → {skipped:"empty-message"}', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    const result = await service.routeInbound(makeUpdate({ message: { body: { text: '' } } }));
    expect(result).toEqual({ skipped: 'empty-message' });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('9d) дубль mid с файлами → {skipped:"duplicate"}, B24 не дёрнут повторно', async () => {
    const b24 = fakeB24();
    const log = fakeLog({
      findInbound: vi.fn(async () => ({ id: 55, isDuplicate: () => true })),
    });
    const service = buildService({ b24, log });

    const result = await service.routeInbound(
      makeUpdate({
        message: { body: { text: '' } },
        mediaFiles: [{ kind: 'image', url: 'https://i.oneme.ru/a', name: '1.webp' }],
      }),
    );
    expect(result).toEqual({ skipped: 'duplicate', logId: 55 });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('10) body.markup (MAX format) → ConnectorMessage.text = BB-коды (markupToBbcode)', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    await service.routeInbound(
      makeUpdate({
        message: {
          body: {
            text: 'Жирный и Курсив',
            markup: [
              { from: 0, length: 6, type: 'strong' },
              { from: 9, length: 6, type: 'emphasized' },
            ],
          },
        },
      }),
    );

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('[b]Жирный[/b] и [i]Курсив[/i]');
  });

  // ─── Reply/цитирование MAX→OL ────────────────────────────────────────────

  it('R-1) inbound reply → ConnectorMessage.text начинается с [quote]-префикса + исходный текст', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    await service.routeInbound(
      makeUpdate({
        message: { body: { text: 'мой ответ' } },
        replyContext: {
          type: 'reply',
          parentMid: 'parent.1',
          parentText: 'текст родителя',
          parentSenderName: 'Пётр',
        },
      }),
    );

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('>>Пётр: текст родителя\nмой ответ');
  });

  it('R-2) reply-на-медиа с пустым body.text и без файлов → НЕ empty, шлёт цитату-как-текст', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    const result = await service.routeInbound(
      makeUpdate({
        message: { body: { text: '' } },
        replyContext: {
          type: 'reply',
          parentMid: 'parent.2',
          parentText: 'на это сообщение',
          parentSenderName: 'Анна',
        },
      }),
    );

    expect(result).toMatchObject({ ok: true });
    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('>>Анна: на это сообщение\n');
  });

  it('R-3) без replyContext → text без [quote] (регрессия)', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    await service.routeInbound(makeUpdate({ message: { body: { text: 'обычный' } } }));

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('обычный');
  });

  it('11) plain-текст без маркеров → ConnectorMessage.text без изменений (pass-through)', async () => {
    const b24 = fakeB24();
    const service = buildService({ b24 });

    await service.routeInbound(
      makeUpdate({ message: { body: { text: 'простой текст' } } }),
    );

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.text).toBe('простой текст');
  });

  // ─── M7: авто-онбординг и изоляция ─────────────────────────────────────────

  it('M7-1) две разные chatId → два разных connector_chat_id в B24-send (изоляция групп)', async () => {
    const b24 = fakeB24();
    const chatIdA = -100;
    const chatIdB = -200;

    function bindingFor(chatId) {
      return {
        id: chatId,
        connectorChatId: `max:${chatId}`,
        maxChatTitle: null,
        isReadyForRouting: () => true,
      };
    }

    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })),
      ensureForMaxChat: vi.fn(async (chatId) => ({ binding: bindingFor(chatId), created: true })),
    });
    const log = fakeLog();
    const service = buildService({ bindings, b24, log });

    await service.routeInbound(makeUpdate({ chatId: chatIdA }));
    await service.routeInbound(makeUpdate({ chatId: chatIdB, mid: 'mid.B' }));

    const calls = b24.sendConnectorMessage.mock.calls;
    expect(calls).toHaveLength(2);
    const connectorChatIds = calls.map((c) => c[0].connectorChatId);
    expect(connectorChatIds[0]).toBe('max:-100');
    expect(connectorChatIds[1]).toBe('max:-200');
    expect(connectorChatIds[0]).not.toBe(connectorChatIds[1]);
  });

  // ─── M21: сообщение без mid ─────────────────────────────────────────────────
  const NOMID_KEY = 'nomid:-70000000000954:54321:1700000000000';

  it('M21-1) mid=null → синтетический ключ nomid:<chat>:<sender>:<ts>, external id max:nomid:…', async () => {
    const b24 = fakeB24();
    const log = fakeLog();
    const service = buildService({ b24, log });

    const result = await service.routeInbound(makeUpdate({ mid: null }));

    expect(result.ok).toBe(true);
    expect(log.findInbound).toHaveBeenCalledWith(10, NOMID_KEY);
    expect(log.recordInbound.mock.calls[0][0]).toMatchObject({ bindingId: 10, maxMid: NOMID_KEY });
    expect(b24.sendConnectorMessage.mock.calls[0][0].externalMessageId).toBe(`max:${NOMID_KEY}`);
  });

  it('M21-2) ретрай того же события без mid → duplicate, B24 не дёрнут', async () => {
    const b24 = fakeB24();
    const log = fakeLog({ findInbound: vi.fn(async (_id, key) => (key === NOMID_KEY ? { id: 5 } : null)) });
    const service = buildService({ b24, log });

    const result = await service.routeInbound(makeUpdate({ mid: null }));

    expect(result).toEqual({ skipped: 'duplicate', logId: 5 });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('M21-3) нет ни mid, ни timestamp → no-mid до резолва и онбординга', async () => {
    const b24 = fakeB24();
    const bindings = fakeBindings();
    const log = fakeLog();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInbound(makeUpdate({ mid: null, timestamp: null }));

    expect(result).toEqual({ skipped: 'no-mid' });
    expect(bindings.resolveByMaxChat).not.toHaveBeenCalled();
    expect(bindings.ensureForMaxChat).not.toHaveBeenCalled();
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('M21-5) installation из резолва привязки уходит в sendConnectorMessage (одно чтение на входящее)', async () => {
    const b24 = fakeB24();
    const installation = { id: 1, connectorId: 'max_b24' };
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding(), isReady: true, installation })),
    });
    const service = buildService({ bindings, b24 });

    await service.routeInbound(makeUpdate());

    expect(b24.sendConnectorMessage.mock.calls[0][1]).toEqual({ installation });
  });

  it.each([null, undefined, ''])('M21-4) _once с пустым ключом (%j) → TypeError до find и эффекта', async (key) => {
    const log = fakeLog();
    const effect = vi.fn();
    const service = buildService({ log });

    await expect(
      service._once({ direction: 'inbound', bindingId: 10, key, fn: 'routeX', log: null }, effect),
    ).rejects.toThrow(/routeX: idempotency key required/);
    expect(log.findInbound).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it('M7-2) binding уже есть → ensureForMaxChat НЕ вызван', async () => {
    const b24 = fakeB24();
    const bindings = fakeBindings();
    const service = buildService({ bindings, b24 });

    await service.routeInbound(makeUpdate());

    expect(bindings.ensureForMaxChat).not.toHaveBeenCalled();
  });

  it('M7-3) дедуп по mid после авто-создания → skipped:duplicate, B24 не дёрнут второй раз', async () => {
    const b24 = fakeB24();
    const log = fakeLog({
      findInbound: vi.fn(async () => ({ id: 77, isDuplicate: () => true })),
    });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })),
    });
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInbound(makeUpdate());

    expect(bindings.ensureForMaxChat).toHaveBeenCalledOnce();
    expect(result).toEqual({ skipped: 'duplicate', logId: 77 });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  it('M7-4) регрессия no-sender: ensureForMaxChat вернул binding, но sender null → skipped:no-sender', async () => {
    const b24 = fakeB24();
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })),
    });
    const service = buildService({ bindings, b24 });

    const result = await service.routeInbound(makeUpdate({ senderId: null }));

    expect(result).toEqual({ skipped: 'no-sender' });
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
  });

  // ─── M24: интро группы и название чата OL ──────────────────────────────────

  const CHAT_ID = -70000000000954;
  const INTRO_KEY = 'group-intro:-70000000000954';
  const ICON = 'https://i.oneme.ru/i?r=ICON';

  // Фейки для сценария «новая группа»: первый resolve — привязки нет, дальше (перечитывание
  // при синхронизации названия) — привязка с названием из интро.
  function onboardingFakes({ title = 'Отдел продаж', iconUrl = ICON, type = 'chat' } = {}) {
    const b24 = fakeB24({ setChatName: vi.fn(async () => ({ success: true })) });
    const max = fakeMaxInbound({ getChatInfo: vi.fn(async () => ({ title, iconUrl, type })) });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn()
        .mockResolvedValueOnce({ binding: null, isReady: false })
        .mockResolvedValue({
          binding: chatBinding({ maxChatTitle: title, b24ChatId: '21180' }),
          isReady: true,
        }),
      ensureForMaxChat: vi.fn(async () => ({ binding: chatBinding(), created: true })),
      updateMaxChatTitle: vi.fn(async () => ({})),
      markOlChatTitle: vi.fn(async () => ({})),
    });
    const log = fakeLog();
    return { b24, max, bindings, log };
  }

  it('M24-1) новая группа: интро от «группы» (имя, иконка, текст) → реальное сообщение → chat.name.set', async () => {
    const { b24, max, bindings, log } = onboardingFakes();
    b24.resolveB24ChatId = vi.fn();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result).toEqual({ ok: true, bindingId: 10, maxMid: 'mid.ABC', b24MsgId: 'max:mid:mid.ABC', logId: 100 });
    expect(max.getChatInfo).toHaveBeenCalledWith(CHAT_ID);
    // Свежая привязка: чата OL точно нет — dialog.get не дёргаем.
    expect(b24.resolveB24ChatId).not.toHaveBeenCalled();
    expect(bindings.updateMaxChatTitle).toHaveBeenCalledWith(10, 'Отдел продаж');

    expect(b24.sendConnectorMessage).toHaveBeenCalledTimes(2);
    const intro = b24.sendConnectorMessage.mock.calls[0][0];
    expect(intro).toBeInstanceOf(ConnectorMessage);
    expect(intro.connectorChatId).toBe('max:-70000000000954');
    expect(intro.externalMessageId).toBe('max:group-intro:-70000000000954');
    expect(intro.text).toBe('Группа «Отдел продаж» в MAX подключена к Открытой линии');
    expect(intro.author).toEqual({
      id: 'group:-70000000000954',
      name: 'Отдел продаж',
      fallbackName: 'Группа MAX',
      picture: ICON,
    });
    const real = b24.sendConnectorMessage.mock.calls[1][0];
    expect(real.externalMessageId).toBe('max:mid:mid.ABC');
    expect(real.author.id).toBe(54321);

    // Интро записано под своим ключом, адрес чата OL — из ответа интро (один раз).
    expect(log.recordInbound.mock.calls.map((c) => c[0].maxMid)).toEqual([INTRO_KEY, 'mid.ABC']);
    expect(log.recordInbound.mock.calls[0][0].payloadMeta).toMatchObject({ kind: 'group-intro', hasIcon: true });
    expect(bindings.attachB24ChatId).toHaveBeenCalledOnce();
    expect(bindings.attachB24ChatId).toHaveBeenCalledWith(10, '21180');

    // Точное название — после доставки, затем отметка в привязке.
    expect(b24.setChatName).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954', name: 'Отдел продаж' });
    expect(bindings.markOlChatTitle).toHaveBeenCalledWith(10, 'Отдел продаж');
  });

  it('M24-2) группа без иконки → интро без picture (аватар чата пустой, не фото автора)', async () => {
    const { b24, max, bindings, log } = onboardingFakes({ iconUrl: null });
    const service = buildService({ bindings, b24, log, max });

    await service.routeInbound(makeUpdate());

    const intro = b24.sendConnectorMessage.mock.calls[0][0];
    expect(intro.author).not.toHaveProperty('picture');
    expect(log.recordInbound.mock.calls[0][0].payloadMeta).toMatchObject({ hasIcon: false });
  });

  it('M24-3) BB-теги в названии экранируются в тексте интро', async () => {
    const title = 'Группа [b]x[/b][url=https://evil]y[/url]';
    const { b24, max, bindings, log } = onboardingFakes({ title });
    const service = buildService({ bindings, b24, log, max });

    await service.routeInbound(makeUpdate());

    const intro = b24.sendConnectorMessage.mock.calls[0][0];
    expect(intro.text).toBe(`Группа «${escapeBbcode(title)}» в MAX подключена к Открытой линии`);
    expect(intro.text).not.toContain('[url=');
  });

  it('M24-4) чат OL известен (b24ChatId есть) → ни интро, ни getChatInfo; название синхронно → без chat.name.set', async () => {
    const b24 = fakeB24({ setChatName: vi.fn() });
    const max = fakeMaxInbound();
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({
        binding: chatBinding({ b24ChatId: '21180', maxChatTitle: 'Тест', olChatTitle: 'Тест' }),
        isReady: true,
      })),
    });
    const service = buildService({ bindings, b24, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('M24-5) getChatInfo → null (best-effort) → без интро и без переименования, сообщение доходит', async () => {
    const { b24, max, bindings, log } = onboardingFakes();
    max.getChatInfo = vi.fn(async () => null);
    bindings.resolveByMaxChat = vi.fn()
      .mockResolvedValueOnce({ binding: null, isReady: false })
      .mockResolvedValue({ binding: chatBinding({ b24ChatId: '21180' }), isReady: true });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    expect(b24.sendConnectorMessage.mock.calls[0][0].externalMessageId).toBe('max:mid:mid.ABC');
    expect(bindings.updateMaxChatTitle).not.toHaveBeenCalled();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('M24-6) чат не группа (type=channel) → без интро', async () => {
    const { b24, max, bindings, log } = onboardingFakes({ type: 'channel' });
    const service = buildService({ bindings, b24, log, max });

    await service.routeInbound(makeUpdate());

    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    expect(b24.sendConnectorMessage.mock.calls[0][0].externalMessageId).toBe('max:mid:mid.ABC');
  });

  it('M24-7) старая привязка без b24ChatId, чат OL уже есть (dialog.get) → персист адреса, без интро', async () => {
    const b24 = fakeB24({ resolveB24ChatId: vi.fn(async () => '21555') });
    const max = fakeMaxInbound();
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: chatBinding({ maxChatTitle: 'X', olChatTitle: 'X' }), isReady: true })),
    });
    const log = fakeLog();
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(b24.resolveB24ChatId).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954' });
    expect(bindings.attachB24ChatId).toHaveBeenCalledWith(10, '21555');
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    // Интро не отправлено — записи под его ключом нет.
    expect(log.recordInbound.mock.calls.map((c) => c[0].maxMid)).toEqual(['mid.ABC']);
  });

  it('M24-8) ретрай: привязка есть, чата OL нет (Б24 лежал на первом сообщении) → интро уходит', async () => {
    const b24 = fakeB24({ resolveB24ChatId: vi.fn(async () => null), setChatName: vi.fn(async () => ({})) });
    const max = fakeMaxInbound();
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: chatBinding(), isReady: true })),
      updateMaxChatTitle: vi.fn(async () => ({})),
      markOlChatTitle: vi.fn(async () => ({})),
    });
    const service = buildService({ bindings, b24, max });

    await service.routeInbound(makeUpdate());

    expect(b24.resolveB24ChatId).toHaveBeenCalledOnce();
    expect(b24.sendConnectorMessage).toHaveBeenCalledTimes(2);
    expect(b24.sendConnectorMessage.mock.calls[0][0].externalMessageId).toBe('max:group-intro:-70000000000954');
  });

  it('M24-9) интро упало → warn, реальное сообщение всё равно доставлено', async () => {
    const { b24, max, bindings, log } = onboardingFakes();
    b24.sendConnectorMessage = vi.fn()
      .mockRejectedValueOnce(new B24ApiError('TIMEOUT', 'timeout', { method: 'imconnector.send.messages' }))
      .mockResolvedValue({ b24MsgId: 'max:mid:mid.ABC', sessionId: '15756', b24ChatId: '21180', raw: {} });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result).toMatchObject({ ok: true, maxMid: 'mid.ABC' });
    expect(b24.sendConnectorMessage).toHaveBeenCalledTimes(2);
    expect(log.recordInbound.mock.calls.map((c) => c[0].maxMid)).toEqual(['mid.ABC']);
    // Название всё равно ставим: чат создал автор, но заголовок будет точным.
    expect(b24.setChatName).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954', name: 'Отдел продаж' });
  });

  it('M24-10) интро уже записано (ретрай после частичного успеха) → duplicate-intro, второго интро нет', async () => {
    const { b24, max, bindings } = onboardingFakes();
    const log = fakeLog({
      findInbound: vi.fn(async (bindingId, key) => (key === INTRO_KEY ? { id: 55 } : null)),
    });
    const service = buildService({ bindings, b24, log, max });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendConnectorMessage).toHaveBeenCalledOnce();
    expect(b24.sendConnectorMessage.mock.calls[0][0].externalMessageId).toBe('max:mid:mid.ABC');
  });

  it('M24-11) «пачка» первых сообщений: одно интро, оба сообщения — после него', async () => {
    let releaseIntro;
    const introGate = new Promise((resolve) => { releaseIntro = resolve; });
    const sent = [];
    const b24 = fakeB24({
      resolveB24ChatId: vi.fn(async () => null),
      setChatName: vi.fn(async () => ({})),
      sendConnectorMessage: vi.fn(async (cm) => {
        if (cm.externalMessageId.startsWith('max:group-intro:')) await introGate;
        sent.push(cm.externalMessageId);
        return { b24MsgId: cm.externalMessageId, sessionId: '15756', b24ChatId: '21180', raw: {} };
      }),
    });
    const records = new Map();
    const log = fakeLog({
      findInbound: vi.fn(async (bindingId, key) => records.get(key) ?? null),
      recordInbound: vi.fn(async ({ maxMid }) => {
        const row = { id: records.size + 1 };
        records.set(maxMid, row);
        return row;
      }),
    });
    const max = fakeMaxInbound();
    const bindings = fakeBindings({
      // Каждый запрос видит свою копию привязки без b24ChatId (как из БД до первого ответа Б24).
      resolveByMaxChat: vi.fn(async () => ({ binding: chatBinding(), isReady: true })),
      updateMaxChatTitle: vi.fn(async () => ({})),
      markOlChatTitle: vi.fn(async () => ({})),
    });
    const service = buildService({ bindings, b24, log, max });

    const first = service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    const second = service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    releaseIntro();
    const results = await Promise.all([first, second]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(sent[0]).toBe('max:group-intro:-70000000000954');
    expect(sent.filter((id) => id.startsWith('max:group-intro:'))).toHaveLength(1);
    expect(sent.slice(1).sort()).toEqual(['max:mid:mid.1', 'max:mid:mid.2']);
  });

  it('M24-12) название в MAX сменилось, а в OL старое → chat.name.set после доставки', async () => {
    const b24 = fakeB24({ setChatName: vi.fn(async () => ({ success: true })) });
    const pending = () => chatBinding({ b24ChatId: '21180', maxChatTitle: 'Новое', olChatTitle: 'Старое' });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: pending(), isReady: true })),
      markOlChatTitle: vi.fn(async () => ({})),
    });
    const service = buildService({ bindings, b24 });

    const result = await service.routeInbound(makeUpdate());

    expect(result).toEqual({ ok: true, bindingId: 10, maxMid: 'mid.ABC', b24MsgId: 'max:mid:mid.ABC', logId: 100 });
    expect(b24.setChatName).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954', name: 'Новое' });
    expect(bindings.markOlChatTitle).toHaveBeenCalledWith(10, 'Новое');
  });

  // M27: CHAT_RENAMING_FAILED → imopenlines.dialog.get (getOlChat). На входящем пути флаг
  // опенера не взводится никогда; то же имя при открытой сессии — отметка (без петли pending).
  function renameFailFakes(olChat) {
    const row = { maxChatTitle: 'Новое', olChatTitle: null };
    const b24 = fakeB24({
      setChatName: vi.fn(async () => { throw renamingFailed(); }),
      getOlChat: vi.fn(async () => olChat),
    });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: chatBinding({ b24ChatId: '21180', ...row }), isReady: true })),
      markOlChatTitle: vi.fn(async (id, title) => { row.olChatTitle = title; return {}; }),
      markOlSessionClosedByRename: vi.fn(),
    });
    const logger = silentLogger();
    return { b24, bindings, logger, service: buildService({ bindings, b24 }) };
  }

  it('M24-13) CHAT_RENAMING_FAILED, сессия закрыта (поле 6 = 0) → pending: без отметки и без флага', async () => {
    const { b24, bindings, logger, service } = renameFailFakes({ b24ChatId: '21180', name: 'Старое', sessionId: 0 });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(b24.setChatName).toHaveBeenCalledOnce();
    expect(b24.getOlChat).toHaveBeenCalledWith({ b24ChatId: '21180' });
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(logged(logger.info, 'OL session closed, chat title pending until next inbound')).toBe(true);
  });

  it('M24-13b) CHAT_RENAMING_FAILED, сессия открыта, имя в OL то же → отметка; следующее входящее без chat.name.set', async () => {
    const { b24, bindings, logger, service } = renameFailFakes({ b24ChatId: '21180', name: 'Новое', sessionId: 15756 });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(bindings.markOlChatTitle).toHaveBeenCalledWith(10, 'Новое');
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(logged(logger.info, 'OL chat already has this title')).toBe(true);

    await service.routeInbound(makeUpdate({ mid: 'mid.NEXT' }));
    expect(b24.setChatName).toHaveBeenCalledOnce();
    expect(b24.getOlChat).toHaveBeenCalledOnce();
  });

  it('M24-13c) CHAT_RENAMING_FAILED, сессия открыта, имя другое → pending без отметки и без флага', async () => {
    const { bindings, logger, service } = renameFailFakes({ b24ChatId: '21180', name: 'Ручное имя', sessionId: 15756 });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(logged(logger.info, 'rename failed with open session, chat title pending')).toBe(true);
  });

  it.each([
    ['dialog.get упал (null)', null],
    ['поле 6 не разобрать', { b24ChatId: '21180', name: 'Новое', sessionId: null }],
  ])('M24-13d) CHAT_RENAMING_FAILED, %s → pending без отметки и без флага', async (_label, olChat) => {
    const { bindings, logger, service } = renameFailFakes(olChat);

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(logged(logger.info, 'chat title pending (OL chat state unknown)')).toBe(true);
  });

  it('M24-13e) chat.name.set: другая ошибка (TIMEOUT) → warn, без dialog.get; доставка ok', async () => {
    const { b24, bindings, logger, service } = renameFailFakes(null);
    b24.setChatName = vi.fn(async () => { throw new B24ApiError('TIMEOUT', 'x', { method: 'imconnector.chat.name.set' }); });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(b24.setChatName).toHaveBeenCalledOnce();
    expect(b24.getOlChat).not.toHaveBeenCalled();
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(logged(logger.warn, 'OL chat title sync failed')).toBe(true);
  });

  it('M24-14) дубль mid → синхронизация названия не запускается', async () => {
    const b24 = fakeB24({ setChatName: vi.fn() });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({
        binding: chatBinding({ b24ChatId: '21180', maxChatTitle: 'Новое', olChatTitle: 'Старое' }),
        isReady: true,
      })),
    });
    const log = fakeLog({ findInbound: vi.fn(async () => ({ id: 99 })) });
    const service = buildService({ bindings, b24, log });

    const result = await service.routeInbound(makeUpdate());

    expect(result).toEqual({ skipped: 'duplicate', logId: 99 });
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  // ─── M10: аватарки авторов ───────────────────────────────────────────────

  it('M10-4) автор с аватаром → ConnectorMessage.author.picture проставлен', async () => {
    const b24 = fakeB24();
    const max = fakeMaxInbound({ getMemberAvatar: vi.fn(async () => 'https://i.oneme.ru/a.png') });
    const service = buildService({ b24, max });

    await service.routeInbound(makeUpdate());

    expect(max.getMemberAvatar).toHaveBeenCalledWith(-70000000000954, 54321);
    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.author.picture).toBe('https://i.oneme.ru/a.png');
  });

  it('M10-5) getMemberAvatar вернул null → author без picture, inbound ok', async () => {
    const b24 = fakeB24();
    const max = fakeMaxInbound({ getMemberAvatar: vi.fn(async () => null) });
    const service = buildService({ b24, max });

    const result = await service.routeInbound(makeUpdate());

    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.author).not.toHaveProperty('picture');
    expect(result.ok).toBe(true);
  });

  it('M10-6) аватар тянется раз на (binding, author): второе сообщение НЕ дёргает getMemberAvatar', async () => {
    const b24 = fakeB24();
    const max = fakeMaxInbound({ getMemberAvatar: vi.fn(async () => 'https://i.oneme.ru/a.png') });
    const service = buildService({ b24, max });

    await service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));

    expect(max.getMemberAvatar).toHaveBeenCalledTimes(1);
  });

  it('M10-7) без maxService (this.max=null) → ни интро, ни avatar не тянем (regression)', async () => {
    const b24 = fakeB24();
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })),
      ensureForMaxChat: vi.fn(async () => ({ binding: makeBinding(), created: true })),
    });
    const service = buildService({ bindings, b24 }); // без max

    const result = await service.routeInbound(makeUpdate());

    expect(bindings.ensureForMaxChat).toHaveBeenCalledOnce();
    const cm = b24.sendConnectorMessage.mock.calls[0][0];
    expect(cm.author).not.toHaveProperty('picture');
    expect(result.ok).toBe(true);
  });
});

// ─── routeOutbound (M5.2) ────────────────────────────────────────────────────

const CONNECTOR_CHAT_ID = 'max:-70000000000954';
const MAX_CHAT_ID_RAW = '-70000000000954';
const B24_MSG_ID = '1459190';
const BINDING_ID_OUT = 20;

function makeBindingOut(overrides = {}) {
  return {
    id: BINDING_ID_OUT,
    connectorChatId: CONNECTOR_CHAT_ID,
    maxChatId: MAX_CHAT_ID_RAW,
    isReadyForRouting: () => true,
    ...overrides,
  };
}

// M28: снимок installation из резолва привязки — уходит в reply-резолв, статус доставки и
// оповещение оператора (Б24-вызовы не читают БД заново).
const INSTALLATION_OUT = Object.freeze({ id: 1, portal: 'example.bitrix24.ru', connectorId: 'max_b24', olLineId: 42 });

function fakeBindingsOut(overrides = {}) {
  return {
    resolveByConnectorChat: vi.fn(async () => ({
      binding: makeBindingOut(),
      isReady: true,
      installation: INSTALLATION_OUT,
    })),
    ...overrides,
  };
}

function fakeMax(overrides = {}) {
  return {
    sendOutgoingMessage: vi.fn(async () => ({
      maxMid: 'mid.OUT',
      timestampMs: 1748432100000,
    })),
    // M11.2: upload-флоу OL → MAX.
    uploadAndSend: vi.fn(async () => ({
      maxMid: 'mid.UP',
      timestampMs: 1748432100000,
    })),
    ...overrides,
  };
}

function fakeB24Out(overrides = {}) {
  return {
    sendDeliveryStatus: vi.fn(async () => ({ SUCCESS: true, DATA: [], time: {} })),
    // M11.2/M22: скачивание файла оператора потоком во временный файл.
    downloadOperatorFile: vi.fn(async () => ({ contentType: 'image/jpeg', size: 8 })),
    // M22: оповещение оператора о недоставке.
    sendSystemMessage: vi.fn(async () => ({ b24MsgId: 777 })),
    // Reply/цитирование: добор REPLY_ID (по умолчанию не-reply → null).
    resolveReplyContext: vi.fn(async () => null),
    ...overrides,
  };
}

function fakeLogOut(overrides = {}) {
  return {
    findOutbound: vi.fn(async () => null),
    recordOutbound: vi.fn(async () => ({ id: 200 })),
    ...overrides,
  };
}

// Строит OpenLineEvent из verified-формы M5.1
function makeEvent(overrides = {}) {
  const base = {
    event: 'ONIMCONNECTORMESSAGEADD',
    data: {
      CONNECTOR: 'max_b24',
      LINE: '42',
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: B24_MSG_ID },
          message: { user_id: '1', text: '[b]Олег Смирнов:[/b] [br]Тык из Б24' },
          chat: { id: CONNECTOR_CHAT_ID },
        },
      ],
      ...overrides.data,
    },
    ...overrides,
  };
  return new OpenLineEvent({ event: base.event, data: base.data });
}

// M28: внутренняя ошибка отправки (БД/баг) → 500 + оповещение «могло не дойти».
const SEND_UNCERTAIN_TEXT = '⚠️ Сообщение могло не дойти до MAX: внутренняя ошибка моста. '
  + 'Проверьте и при необходимости отправьте ещё раз.';

// M22: временные файлы без диска — пути по счётчику, удаление фиксируется.
function fakeTemp() {
  let n = 0;
  return {
    allocate: vi.fn(async () => {
      n += 1;
      return `/tmp/m22/${n}.part`;
    }),
    remove: vi.fn(async () => {}),
  };
}

function buildServiceOut({ bindings, max, log, b24, mediaMaxBytes, reply, temp } = {}) {
  return new MessagingService({
    bindingsService: bindings ?? fakeBindingsOut(),
    maxService: max ?? fakeMax(),
    b24Service: b24 ?? fakeB24Out(),
    messageLogRepository: log ?? fakeLogOut(),
    logger: silentLogger(),
    mediaMaxBytes,
    mediaTempFiles: temp ?? fakeTemp(),
    reply,
  });
}

// M11.2: событие с файлами оператора в message.files[].
function makeEventWithFiles(files, { text = '' } = {}) {
  return new OpenLineEvent({
    event: 'ONIMCONNECTORMESSAGEADD',
    data: {
      CONNECTOR: 'max_b24',
      LINE: '42',
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: B24_MSG_ID },
          message: { user_id: '1', text, files },
          chat: { id: CONNECTOR_CHAT_ID },
        },
      ],
    },
  });
}

describe('MessagingService.routeOutbound', () => {
  it('1) happy-path: MAX вызван с markdown-текстом и format, recordOutbound записан, delivery sent', async () => {
    const bindings = fakeBindingsOut();
    const max = fakeMax();
    const log = fakeLogOut();
    const b24 = fakeB24Out();
    const service = buildServiceOut({ bindings, max, log, b24 });

    const result = await service.routeOutbound(makeEvent());

    expect(max.sendOutgoingMessage).toHaveBeenCalledOnce();
    const sentMsg = max.sendOutgoingMessage.mock.calls[0][0];
    expect(sentMsg).toBeInstanceOf(MaxMessage);
    expect(sentMsg.chatId).toBe(MAX_CHAT_ID_RAW);
    // BB → markdown: [b]Олег Смирнов:[/b] [br]Тык из Б24 → **Олег Смирнов:**\nТык из Б24
    expect(sentMsg.text).toBe('**Олег Смирнов:**\nТык из Б24');
    expect(sentMsg.format).toBe('markdown');

    // delivery status зван 1 раз с правильными параметрами
    expect(b24.sendDeliveryStatus).toHaveBeenCalledOnce();
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        b24MsgId: B24_MSG_ID,
        externalIds: ['mid.OUT'],
        connectorChatId: CONNECTOR_CHAT_ID,
      }),
    );

    expect(log.recordOutbound).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      results: [{ ok: true, bindingId: BINDING_ID_OUT, b24MsgId: B24_MSG_ID, maxMid: 'mid.OUT', logId: 200 }],
    });
  });

  it('2) no-binding → results[0]={skipped:"no-binding"}, MAX не зван', async () => {
    const max = fakeMax();
    const bindings = fakeBindingsOut({
      resolveByConnectorChat: vi.fn(async () => ({ binding: null, isReady: false })),
    });
    const service = buildServiceOut({ bindings, max });

    const result = await service.routeOutbound(makeEvent());
    expect(result.results[0]).toEqual({ skipped: 'no-binding' });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('3) binding-not-ready → results[0]={skipped:"binding-not-ready"}, MAX не зван', async () => {
    const max = fakeMax();
    const bindings = fakeBindingsOut({
      resolveByConnectorChat: vi.fn(async () => ({
        binding: makeBindingOut(),
        isReady: false,
      })),
    });
    const service = buildServiceOut({ bindings, max });

    const result = await service.routeOutbound(makeEvent());
    expect(result.results[0]).toEqual({ skipped: 'binding-not-ready' });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('4) duplicate (findOutbound → isDuplicate()===true) → {skipped:"duplicate",logId:9}, MAX не зван', async () => {
    const max = fakeMax();
    const log = fakeLogOut({
      findOutbound: vi.fn(async () => ({ id: 9, isDuplicate: () => true })),
    });
    const service = buildServiceOut({ max, log });

    const result = await service.routeOutbound(makeEvent());
    expect(result.results[0]).toEqual({ skipped: 'duplicate', logId: 9 });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(log.recordOutbound).not.toHaveBeenCalled();
  });

  it('5) empty после BB-strip (text="[br]") → {skipped:"empty-message"}, MAX не зван', async () => {
    const max = fakeMax();
    const event = makeEvent({
      data: {
        CONNECTOR: 'max_b24',
        LINE: '42',
        MESSAGES: [
          {
            im: { chat_id: '21186', message_id: B24_MSG_ID },
            message: { user_id: '1', text: '[br]' },
            chat: { id: CONNECTOR_CHAT_ID },
          },
        ],
      },
    });
    const service = buildServiceOut({ max });

    const result = await service.routeOutbound(event);
    expect(result.results[0]).toEqual({ skipped: 'empty-message' });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('6) не MaxApiError (баг) → проброс (rejects → 500), recordOutbound НЕ зван; M28: оповещение «могло не дойти»', async () => {
    const log = fakeLogOut();
    const b24 = fakeB24Out();
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const service = buildServiceOut({ max, log, b24 });

    await expect(service.routeOutbound(makeEvent())).rejects.toThrow('boom');
    expect(log.recordOutbound).not.toHaveBeenCalled();
    // Привязка на уровне цикла неизвестна — без installation, чат ОЛ из события.
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21186', text: SEND_UNCERTAIN_TEXT });
  });

  it('6-I1) M28: recordOutbound бросил (БД) после отправки в MAX → проброс той же ошибки + оповещение «могло не дойти»', async () => {
    const dbErr = new Error('db down');
    const log = fakeLogOut({ recordOutbound: vi.fn(async () => { throw dbErr; }) });
    const b24 = fakeB24Out();
    const max = fakeMax();
    const service = buildServiceOut({ max, log, b24 });

    await expect(service.routeOutbound(makeEvent())).rejects.toBe(dbErr);
    expect(max.sendOutgoingMessage).toHaveBeenCalledOnce();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage.mock.calls[0]).toEqual([{ b24ChatId: '21186', text: SEND_UNCERTAIN_TEXT }]);
  });

  it('6-I2) M28: оповещение не ушло (Б24 упал) → наружу исходная ошибка', async () => {
    const dbErr = new Error('db down');
    const log = fakeLogOut({ recordOutbound: vi.fn(async () => { throw dbErr; }) });
    const b24 = fakeB24Out({ sendSystemMessage: vi.fn(async () => { throw new B24ApiError('ACCESS_ERROR', 'no access'); }) });
    const service = buildServiceOut({ log, b24 });

    await expect(service.routeOutbound(makeEvent())).rejects.toBe(dbErr);
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
  });

  it('6-I3) M28: notifyOperator сам бросил → наружу исходная ошибка, а не ошибка оповещения', async () => {
    const dbErr = new Error('db down');
    const log = fakeLogOut({ recordOutbound: vi.fn(async () => { throw dbErr; }) });
    const service = buildServiceOut({ log });
    service.notifyOperator = vi.fn(async () => { throw new Error('notify boom'); });

    await expect(service.routeOutbound(makeEvent())).rejects.toBe(dbErr);
    expect(service.notifyOperator).toHaveBeenCalledOnce();
  });

  it('6-I4) M28: первая внутренняя ошибка обрывает остальные сообщения события; оповещение — только по упавшему', async () => {
    const max = fakeMax({
      sendOutgoingMessage: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ maxMid: 'mid.2', timestampMs: 1 }),
    });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ max, b24 });
    const msg = (id) => ({
      im: { chat_id: '21186', message_id: id },
      message: { user_id: '1', text: 'текст' },
      chat: { id: CONNECTOR_CHAT_ID },
    });
    const event = new OpenLineEvent({
      event: 'ONIMCONNECTORMESSAGEADD',
      data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: [msg('1001'), msg('1002')] },
    });

    await expect(service.routeOutbound(event)).rejects.toThrow('boom');
    expect(max.sendOutgoingMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage.mock.calls[0][0]).toEqual({ b24ChatId: '21186', text: SEND_UNCERTAIN_TEXT });
  });

  it('6-I5) M28: ValidationError (нет события) — до цикла, без оповещения', async () => {
    const b24 = fakeB24Out();
    const service = buildServiceOut({ b24 });

    await expect(service.routeOutbound(null)).rejects.toThrow(/event required/);
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('6a) M22: MAX не принял текст → delivery-failed (200), оператору системное сообщение, без записи', async () => {
    const log = fakeLogOut();
    const b24 = fakeB24Out();
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new MaxApiError('HTTP 403 — Chat closed', { httpStatus: 403, maxCode: 'chat.denied' });
      }),
    });
    const service = buildServiceOut({ max, log, b24 });

    const result = await service.routeOutbound(makeEvent());

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    // M28: installation из резолва привязки — вторым аргументом.
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Не доставлено в MAX: текст сообщения — MAX не принял (chat.denied). Отправьте ещё раз.',
    }, { installation: INSTALLATION_OUT });
  });

  it('6a1) M28: MAX отверг текст как слишком длинный → «текст слишком длинный…», «сократите или разбейте»', async () => {
    const b24 = fakeB24Out();
    const maxMessage = "Field 'text' size (4002) must be at most 4000";
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new MaxApiError(`HTTP 400 — ${maxMessage}`, { httpStatus: 400, maxCode: 'proto.payload', maxMessage });
      }),
    });
    const service = buildServiceOut({ max, b24 });

    const result = await service.routeOutbound(makeEvent());

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Не доставлено в MAX: текст слишком длинный (4002 символа при лимите MAX 4000). '
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
  });

  it('6b) M22: таймаут MAX → «MAX не ответил вовремя»; сбой оповещения не валит вебхук', async () => {
    const b24 = fakeB24Out({ sendSystemMessage: vi.fn(async () => { throw new B24ApiError('ACCESS_DENIED', 'x'); }) });
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new MaxApiError('timed out', { kind: 'timeout' });
      }),
    });
    const service = buildServiceOut({ max, b24 });

    const result = await service.routeOutbound(makeEvent());

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('MAX не ответил вовремя');
  });

  it('6b1) M28: в событии нет im.chat_id → оповещение по binding.b24ChatId', async () => {
    const b24 = fakeB24Out();
    const bindings = fakeBindingsOut({
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBindingOut({ b24ChatId: '21564' }), isReady: true })),
    });
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new MaxApiError('HTTP 403 — Chat closed', { httpStatus: 403, maxCode: 'chat.denied' });
      }),
    });
    const service = buildServiceOut({ max, b24, bindings });
    const event = makeEvent({
      data: {
        MESSAGES: [{
          im: { message_id: B24_MSG_ID },
          message: { user_id: '1', text: 'текст' },
          chat: { id: CONNECTOR_CHAT_ID },
        }],
      },
    });

    const result = await service.routeOutbound(event);

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21564',
      text: '⚠️ Не доставлено в MAX: текст сообщения — MAX не принял (chat.denied). Отправьте ещё раз.',
    });
  });

  it('H1) M28: installation из резолва привязки — тем же объектом в reply-резолв и статус доставки', async () => {
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };
    const bindings = fakeBindingsOut({
      resolveByConnectorChat: vi.fn(async () => ({ binding: makeBindingOut(), isReady: true, installation })),
    });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ bindings, b24, reply: { resolveOutbound: true, searchLimit: 50, quoteMaxLen: 200 } });

    const result = await service.routeOutbound(makeEvent());

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(b24.resolveReplyContext.mock.calls[0][0].installation).toBe(installation);
    expect(b24.sendDeliveryStatus.mock.calls[0][0].installation).toBe(installation);
  });

  it('H2) M28: недоставка → оповещение с тем же объектом installation; без installation в резолве — один аргумент', async () => {
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };
    const failingMax = () => fakeMax({
      sendOutgoingMessage: vi.fn(async () => {
        throw new MaxApiError('HTTP 403 — Chat closed', { httpStatus: 403, maxCode: 'chat.denied' });
      }),
    });

    const b24 = fakeB24Out();
    await buildServiceOut({
      max: failingMax(),
      b24,
      bindings: fakeBindingsOut({
        resolveByConnectorChat: vi.fn(async () => ({ binding: makeBindingOut(), isReady: true, installation })),
      }),
    }).routeOutbound(makeEvent());
    expect(b24.sendSystemMessage.mock.calls[0][1].installation).toBe(installation);

    const b24NoInst = fakeB24Out();
    await buildServiceOut({
      max: failingMax(),
      b24: b24NoInst,
      bindings: fakeBindingsOut({
        resolveByConnectorChat: vi.fn(async () => ({ binding: makeBindingOut(), isReady: true })),
      }),
    }).routeOutbound(makeEvent());
    expect(b24NoInst.sendSystemMessage.mock.calls[0]).toHaveLength(1);
  });

  it('6c) M22: сбой одного сообщения пачки не обрывает остальные', async () => {
    const max = fakeMax({
      sendOutgoingMessage: vi.fn()
        .mockRejectedValueOnce(new MaxApiError('HTTP 500', { httpStatus: 500 }))
        .mockResolvedValueOnce({ maxMid: 'mid.2', timestampMs: 1 }),
    });
    const service = buildServiceOut({ max });
    const msg = (id) => ({
      im: { chat_id: '21186', message_id: id },
      message: { user_id: '1', text: 'текст' },
      chat: { id: CONNECTOR_CHAT_ID },
    });
    const event = new OpenLineEvent({
      event: 'ONIMCONNECTORMESSAGEADD',
      data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: [msg('1001'), msg('1002')] },
    });

    const result = await service.routeOutbound(event);

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(result.results[1]).toMatchObject({ ok: true, maxMid: 'mid.2' });
  });

  it('7) race (recordOutbound → null) → {skipped:"duplicate-race"}, MAX зван 1 раз', async () => {
    const max = fakeMax();
    const log = fakeLogOut({ recordOutbound: vi.fn(async () => null) });
    const service = buildServiceOut({ max, log });

    const result = await service.routeOutbound(makeEvent());
    expect(result.results[0]).toEqual({ skipped: 'duplicate-race' });
    expect(max.sendOutgoingMessage).toHaveBeenCalledOnce();
  });

  it('8) ignored-event (event не OnImConnectorMessageAdd) → top-level {skipped:"ignored-event"}', async () => {
    const max = fakeMax();
    const bindings = fakeBindingsOut();
    const service = buildServiceOut({ bindings, max });

    const event = new OpenLineEvent({ event: 'OnImBotMessageAdd', data: {} });
    const result = await service.routeOutbound(event);

    expect(result).toEqual({ skipped: 'ignored-event' });
    expect(bindings.resolveByConnectorChat).not.toHaveBeenCalled();
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('9) no-messages (data.MESSAGES пуст) → top-level {skipped:"no-messages"}, resolve и MAX не званы', async () => {
    const max = fakeMax();
    const bindings = fakeBindingsOut();
    const service = buildServiceOut({ bindings, max });

    const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: { MESSAGES: [] } });
    const result = await service.routeOutbound(event);

    expect(result).toEqual({ skipped: 'no-messages' });
    expect(bindings.resolveByConnectorChat).not.toHaveBeenCalled();
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('10) invalid-message (нет chat.id) → results[0]={skipped:"invalid-message"}, resolve не зван', async () => {
    const max = fakeMax();
    const bindings = fakeBindingsOut();
    const service = buildServiceOut({ bindings, max });

    const event = new OpenLineEvent({
      event: 'ONIMCONNECTORMESSAGEADD',
      data: {
        MESSAGES: [
          {
            im: { chat_id: '21186', message_id: B24_MSG_ID },
            message: { user_id: '1', text: 'текст' },
            chat: {}, // нет id
          },
        ],
      },
    });
    const result = await service.routeOutbound(event);

    expect(result.results[0]).toEqual({ skipped: 'invalid-message' });
    expect(bindings.resolveByConnectorChat).not.toHaveBeenCalled();
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
  });

  it('11) sendDeliveryStatus бросает → routeOutbound НЕ бросает, вердикт ok:true (best-effort)', async () => {
    const b24 = fakeB24Out({
      sendDeliveryStatus: vi.fn(async () => {
        throw new Error('B24 delivery failed');
      }),
    });
    const service = buildServiceOut({ b24 });

    const result = await service.routeOutbound(makeEvent());
    // Delivery упало, но outbound-путь не сломался
    expect(result.ok).toBe(true);
    expect(result.results[0]).toMatchObject({ ok: true, b24MsgId: B24_MSG_ID });
  });

  it('12) нет maxMid (MAX ответил без mid) → delivery не вызван, вердикт ok:true', async () => {
    const max = fakeMax({
      sendOutgoingMessage: vi.fn(async () => ({ maxMid: null, timestampMs: null })), // нет mid
    });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ max, b24 });

    const result = await service.routeOutbound(makeEvent());
    expect(result.results[0]).toMatchObject({ ok: true, maxMid: null });
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
  });

  // ── Reply/цитирование OL→MAX (text-path) ───────────────────────────────────
  const REPLY_CFG = { resolveOutbound: true, searchLimit: 50, quoteMaxLen: 200 };

  it('R-out-1) reply (resolveOutbound, CONNECTOR_MID max:mid:*) → MaxMessage.link выставлен', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({
      resolveReplyContext: vi.fn(async () => ({
        replyId: 900,
        parentConnectorMid: 'max:mid:parentMid',
        forward: false,
      })),
    });
    const service = buildServiceOut({ max, b24, reply: REPLY_CFG });

    await service.routeOutbound(makeEvent());

    expect(b24.resolveReplyContext).toHaveBeenCalledWith({
      b24ChatId: '21186',
      b24MsgId: B24_MSG_ID,
      limit: 50,
      installation: INSTALLATION_OUT,
    });
    const sent = max.sendOutgoingMessage.mock.calls[0][0];
    expect(sent).toBeInstanceOf(MaxMessage);
    expect(sent.link).toEqual({ type: 'reply', mid: 'parentMid' });
  });

  it('R-out-1b) M24: reply на интро группы (CONNECTOR_MID max:group-intro:*) → без link, отправка ok', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({
      resolveReplyContext: vi.fn(async () => ({
        replyId: 901,
        parentConnectorMid: 'max:group-intro:-70000000000954',
        forward: false,
      })),
    });
    const service = buildServiceOut({ max, b24, reply: REPLY_CFG });

    const result = await service.routeOutbound(makeEvent());

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(max.sendOutgoingMessage.mock.calls[0][0].link).toBeNull();
  });

  it('R-out-2) обычное сообщение (resolveReplyContext→null) → без link', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({ resolveReplyContext: vi.fn(async () => null) });
    const service = buildServiceOut({ max, b24, reply: REPLY_CFG });

    await service.routeOutbound(makeEvent());

    expect(b24.resolveReplyContext).toHaveBeenCalledOnce();
    expect(max.sendOutgoingMessage.mock.calls[0][0].link).toBeNull();
  });

  it('R-out-3) resolveOutbound=false → resolveReplyContext НЕ зовётся, без link', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({
      resolveReplyContext: vi.fn(async () => ({ replyId: 1, parentConnectorMid: 'max:mid:x' })),
    });
    const service = buildServiceOut({
      max,
      b24,
      reply: { resolveOutbound: false, searchLimit: 50, quoteMaxLen: 200 },
    });

    await service.routeOutbound(makeEvent());

    expect(b24.resolveReplyContext).not.toHaveBeenCalled();
    expect(max.sendOutgoingMessage.mock.calls[0][0].link).toBeNull();
  });

  it('R-out-4) resolveReplyContext бросил → отправка без link, без падения', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({
      resolveReplyContext: vi.fn(async () => {
        throw new Error('search 500');
      }),
    });
    const service = buildServiceOut({ max, b24, reply: REPLY_CFG });

    const result = await service.routeOutbound(makeEvent());

    expect(result.ok).toBe(true);
    expect(max.sendOutgoingMessage.mock.calls[0][0].link).toBeNull();
  });

  it('R-out-5) fallback через message_log: нет connectorMid → mid из findOutbound', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({
      resolveReplyContext: vi.fn(async () => ({ replyId: 901, parentConnectorMid: null, forward: false })),
    });
    // dedup-проверка (key=b24MsgId) → null; резолв reply (key='901') → запись с maxMid.
    const log = fakeLogOut({
      findOutbound: vi.fn(async (bindingId, key) =>
        key === '901' ? { payloadMeta: { maxMid: 'mid.parentOp' }, isDuplicate: () => false } : null,
      ),
    });
    const service = buildServiceOut({ max, b24, log, reply: REPLY_CFG });

    await service.routeOutbound(makeEvent());

    const sent = max.sendOutgoingMessage.mock.calls[0][0];
    expect(sent.link).toEqual({ type: 'reply', mid: 'mid.parentOp' });
  });

  // ── M11.2: media OL → MAX ────────────────────────────────────────────────────
  const IMG_FILE = {
    name: 'photo.jpg',
    mime: 'image/jpeg',
    type: 'image',
    downloadLink: 'https://example.bitrix24.ru/pub/im.file.php?FILE_ID=1&SIGN=x&img=y',
    size: 2048,
  };

  it('M11.2-1) files-only оператор → download во временный файл + uploadAndSend, временный файл удалён', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out();
    const log = fakeLogOut();
    const temp = fakeTemp();
    const service = buildServiceOut({ max, b24, log, temp });

    const result = await service.routeOutbound(makeEventWithFiles([IMG_FILE], { text: '' }));

    expect(b24.downloadOperatorFile).toHaveBeenCalledWith(IMG_FILE.downloadLink, {
      destPath: '/tmp/m22/1.part',
      maxBytes: Number.POSITIVE_INFINITY,
      timeoutMs: 300_000,
    });
    expect(max.uploadAndSend).toHaveBeenCalledOnce();
    const arg = max.uploadAndSend.mock.calls[0][0];
    expect(arg.type).toBe('image');
    expect(arg.file).toEqual({ path: '/tmp/m22/1.part', filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(arg.text).toBe(''); // нет подписи
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(temp.remove).toHaveBeenCalledWith('/tmp/m22/1.part');
    expect(result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.UP', maxMids: ['mid.UP'] });
    // M22: запись файла (file:<id>:0) и итоговая по «голому» b24MsgId.
    const keys = log.recordOutbound.mock.calls.map((c) => c[0].b24MsgId);
    expect(keys).toEqual([`file:${B24_MSG_ID}:0`, B24_MSG_ID]);
    expect(log.recordOutbound.mock.calls[0][0].payloadMeta).toMatchObject({
      kind: 'file', origB24MsgId: B24_MSG_ID, idx: 0, maxMid: 'mid.UP', type: 'image', size: 8,
    });
    const meta = log.recordOutbound.mock.calls[1][0].payloadMeta;
    expect(meta).toMatchObject({ maxMid: 'mid.UP', maxMids: ['mid.UP'], filesCount: 1, kinds: ['image'] });
  });

  it('M11.2-2) text + file: реальный комментарий шлётся подписью к файлу', async () => {
    const max = fakeMax();
    const service = buildServiceOut({ max });

    await service.routeOutbound(
      makeEventWithFiles([IMG_FILE], { text: '[b]Оператор:[/b] [br]посмотри сюда' }),
    );

    const arg = max.uploadAndSend.mock.calls[0][0];
    expect(arg.text).toBe('**Оператор:**\nпосмотри сюда');
    expect(arg.format).toBe('markdown');
  });

  it('M11.2-3) filename-ярлык подавляется (caption = имя файла → text пустой)', async () => {
    const max = fakeMax();
    const service = buildServiceOut({ max });

    await service.routeOutbound(
      makeEventWithFiles([IMG_FILE], { text: '[b]Оператор:[/b] [br]photo.jpg' }),
    );

    const arg = max.uploadAndSend.mock.calls[0][0];
    expect(arg.text).toBe('');
  });

  it('M11.2-4) дубль b24_msg_id → skipped:duplicate, без download/upload', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out();
    const log = fakeLogOut({
      findOutbound: vi.fn(async () => ({ id: 9, isDuplicate: () => true })),
    });
    const service = buildServiceOut({ max, b24, log });

    const result = await service.routeOutbound(makeEventWithFiles([IMG_FILE]));
    expect(result.results[0]).toEqual({ skipped: 'duplicate', logId: 9 });
    expect(b24.downloadOperatorFile).not.toHaveBeenCalled();
    expect(max.uploadAndSend).not.toHaveBeenCalled();
  });

  it('M11.2-5) неизвестный mime/type → MAX type=file', async () => {
    const max = fakeMax();
    const service = buildServiceOut({ max });

    await service.routeOutbound(
      makeEventWithFiles([
        { name: 'archive.zip', mime: 'application/zip', type: 'file', downloadLink: 'https://p/pub/im.file.php?FILE_ID=2&SIGN=z', size: 10 },
      ]),
    );

    expect(max.uploadAndSend.mock.calls[0][0].type).toBe('file');
  });

  it('M11.2-6) видео по mime → MAX type=video', async () => {
    const max = fakeMax();
    const service = buildServiceOut({ max });

    await service.routeOutbound(
      makeEventWithFiles([
        { name: 'clip.mp4', mime: 'video/mp4', type: 'file', downloadLink: 'https://p/pub/im.file.php?FILE_ID=3&SIGN=z', size: 10 },
      ]),
    );

    expect(max.uploadAndSend.mock.calls[0][0].type).toBe('video');
  });

  it('M11.2-6a) M22: видео больше лимита MAX (250 МБ) → уходит как file', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out({ downloadOperatorFile: vi.fn(async () => ({ contentType: 'video/mp4', size: 250e6 + 1 })) });
    const service = buildServiceOut({ max, b24 });

    await service.routeOutbound(
      makeEventWithFiles([
        { name: 'big.mp4', mime: 'video/mp4', type: 'file', downloadLink: 'https://p/pub/im.file.php?FILE_ID=4&SIGN=z' },
      ]),
    );

    expect(max.uploadAndSend.mock.calls[0][0].type).toBe('file');
  });

  it('M28-F1) MAX отверг картинку, maxService перезалил файлом → в журнале type:file + fallbackFrom, kinds:[file], без оповещения', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn(async () => ({ maxMid: 'mid.FB', timestampMs: 1748432100000, type: 'file', fallbackFrom: 'image' })),
    });
    const b24 = fakeB24Out();
    const log = fakeLogOut();
    const temp = fakeTemp();
    const service = buildServiceOut({ max, b24, log, temp });

    const result = await service.routeOutbound(makeEventWithFiles([IMG_FILE], { text: '' }));

    // Координатор просит image — тип решает фасад MAX.
    expect(max.uploadAndSend).toHaveBeenCalledOnce();
    expect(max.uploadAndSend.mock.calls[0][0].type).toBe('image');
    expect(b24.downloadOperatorFile).toHaveBeenCalledOnce();
    expect(result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.FB', maxMids: ['mid.FB'] });
    expect(log.recordOutbound.mock.calls.map((c) => c[0].b24MsgId)).toEqual([`file:${B24_MSG_ID}:0`, B24_MSG_ID]);
    expect(log.recordOutbound.mock.calls[0][0].payloadMeta).toEqual({
      kind: 'file',
      origB24MsgId: B24_MSG_ID,
      idx: 0,
      maxMid: 'mid.FB',
      type: 'file',
      mime: 'image/jpeg',
      size: 8,
      withCaption: false,
      fallbackFrom: 'image',
    });
    expect(log.recordOutbound.mock.calls[1][0].payloadMeta).toMatchObject({ kinds: ['file'], maxMids: ['mid.FB'] });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(temp.remove).toHaveBeenCalledWith('/tmp/m22/1.part');
  });

  it('M28-F2) без фолбэка в payloadMeta нет fallbackFrom; старый фейк без type → тип из запроса', async () => {
    const log = fakeLogOut();
    const service = buildServiceOut({ log });

    await service.routeOutbound(makeEventWithFiles([IMG_FILE], { text: '' }));

    const meta = log.recordOutbound.mock.calls[0][0].payloadMeta;
    expect(meta).toMatchObject({ type: 'image', mime: 'image/jpeg' });
    expect(meta).not.toHaveProperty('fallbackFrom');
  });

  it('M28-G1) svg и картинка больше 7680 px по стороне (width/height события строками) → сразу file, webp → image', async () => {
    const max = fakeMax();
    const log = fakeLogOut();
    const service = buildServiceOut({ max, log });

    await service.routeOutbound(makeEventWithFiles([
      { ...IMG_FILE, name: 'logo.svg', mime: 'image/svg+xml' },
      { ...IMG_FILE, name: 'big.png', mime: 'image/png', width: '8000', height: '8000' },
      { ...IMG_FILE, name: 'pic.webp', mime: 'image/webp', width: '200', height: '200' },
    ]));

    expect(max.uploadAndSend.mock.calls.map((c) => c[0].type)).toEqual(['file', 'file', 'image']);
    expect(log.recordOutbound.mock.calls.slice(0, 3).map((c) => c[0].payloadMeta.type)).toEqual(['file', 'file', 'image']);
  });

  it('M11.2-7) M22: заявленный размер больше MEDIA_MAX_BYTES → без скачивания, delivery-failed + оповещение', async () => {
    const max = fakeMax();
    const b24 = fakeB24Out();
    const temp = fakeTemp();
    const log = fakeLogOut();
    const service = buildServiceOut({ max, b24, temp, log, mediaMaxBytes: 1024 * 1024 });

    const result = await service.routeOutbound(
      makeEventWithFiles([{ ...IMG_FILE, size: 2 * 1024 * 1024 }], { text: '' }),
    );

    expect(b24.downloadOperatorFile).not.toHaveBeenCalled();
    expect(temp.allocate).not.toHaveBeenCalled();
    expect(max.uploadAndSend).not.toHaveBeenCalled();
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, results: [{ skipped: 'delivery-failed' }] });
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Не доставлено в MAX: файл «photo.jpg» — больше 1 МиБ. Загрузите на диск и отправьте как ссылку.',
    }, { installation: INSTALLATION_OUT });
  });

  it('M11.2-7a) M22: файл больше лимита по факту (MediaTooLargeError при скачивании) → оповещение, временный файл удалён', async () => {
    const b24 = fakeB24Out({
      downloadOperatorFile: vi.fn(async () => {
        throw new MediaTooLargeError('too big', { size: 300 * 1024 * 1024, limit: 256 * 1024 * 1024 });
      }),
    });
    const temp = fakeTemp();
    const service = buildServiceOut({ b24, temp });

    const result = await service.routeOutbound(makeEventWithFiles([{ ...IMG_FILE, size: undefined }]));

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(temp.remove).toHaveBeenCalledWith('/tmp/m22/1.part');
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('«photo.jpg» — больше 256 МиБ');
  });

  it('M11.2-7b) M22: большой файл и сбой MAX в одном сообщении → обе подсказки', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn(async () => {
        throw new MaxApiError('HTTP 500', { httpStatus: 500 });
      }),
    });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ max, b24, mediaMaxBytes: 1024 * 1024 });
    const logger = silentLogger();

    await service.routeOutbound(makeEventWithFiles([
      { ...IMG_FILE, name: 'big.mp4', mime: 'video/x-msvideo', type: 'file', size: 2 * 1024 * 1024 },
      { ...IMG_FILE, name: 'small.jpg', size: 10 },
    ]), { logger });

    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Не доставлено в MAX: файл «big.mp4» — больше 1 МиБ; файл «small.jpg» — MAX не принял (HTTP 500). '
        + 'Большие файлы загрузите на диск и отправьте как ссылку, остальное отправьте ещё раз.',
    );
    // M30: mime и тип Б24 в строке недоставки — сигнал отказа MAX по формату без пробы.
    const notDelivered = logger.error.mock.calls
      .filter((c) => c[1] === 'routeOutbound: file not delivered to MAX')
      .map((c) => ({ idx: c[0].idx, mime: c[0].mime, b24Type: c[0].b24Type }));
    expect(notDelivered).toEqual([
      { idx: 0, mime: 'video/x-msvideo', b24Type: 'file' },
      { idx: 1, mime: 'image/jpeg', b24Type: 'image' },
    ]);
  });

  it('M11.2-8) M22: download упал (B24ApiError) → delivery-failed + оповещение, record не вызван', async () => {
    const b24 = fakeB24Out({
      downloadOperatorFile: vi.fn(async () => {
        throw new B24ApiError('DOWNLOAD_TIMEOUT', 'timed out', { method: '<downloadFile>' });
      }),
    });
    const log = fakeLogOut();
    const service = buildServiceOut({ b24, log });

    const result = await service.routeOutbound(makeEventWithFiles([IMG_FILE]));

    expect(result.results[0]).toEqual({ skipped: 'delivery-failed' });
    expect(log.recordOutbound).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain('не скачался из Битрикс24 вовремя');
  });

  it('M11.2-8a) M22: не-доставочная ошибка в файле (баг/БД) → проброс (500), временный файл удалён', async () => {
    const b24 = fakeB24Out({
      downloadOperatorFile: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const temp = fakeTemp();
    const service = buildServiceOut({ b24, temp });

    await expect(service.routeOutbound(makeEventWithFiles([IMG_FILE]))).rejects.toThrow('boom');
    expect(temp.remove).toHaveBeenCalledWith('/tmp/m22/1.part');
    // M28: не «не доставлено» по файлу, а общее «могло не дойти» (500 остаётся).
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(SEND_UNCERTAIN_TEXT);
  });

  // ── M22: несколько файлов в одном сообщении ───────────────────────────────
  const fileN = (n, extra = {}) => ({
    name: `doc${n}.pdf`,
    mime: 'application/pdf',
    type: 'file',
    downloadLink: `https://p/pub/im.file.php?FILE_ID=${n}&SIGN=z`,
    size: 10,
    ...extra,
  });

  it('M22-1) три файла → три сообщения MAX по очереди, итог с maxMids, статус доставки со всеми', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn()
        .mockResolvedValueOnce({ maxMid: 'mid.1', timestampMs: 1 })
        .mockResolvedValueOnce({ maxMid: 'mid.2', timestampMs: 2 })
        .mockResolvedValueOnce({ maxMid: 'mid.3', timestampMs: 3 }),
    });
    const b24 = fakeB24Out();
    const log = fakeLogOut();
    const service = buildServiceOut({ max, b24, log });

    const result = await service.routeOutbound(
      makeEventWithFiles([fileN(1), fileN(2), fileN(3)], { text: '[b]Оп:[/b] [br]договор' }),
    );

    expect(result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.1', maxMids: ['mid.1', 'mid.2', 'mid.3'] });
    // Подпись — только к первому файлу.
    expect(max.uploadAndSend.mock.calls.map((c) => c[0].text)).toEqual(['**Оп:**\nдоговор', '', '']);
    expect(log.recordOutbound.mock.calls.map((c) => c[0].b24MsgId)).toEqual([
      `file:${B24_MSG_ID}:0`, `file:${B24_MSG_ID}:1`, `file:${B24_MSG_ID}:2`, B24_MSG_ID,
    ]);
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ externalIds: ['mid.1', 'mid.2', 'mid.3'] }),
    );
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('M22-2) сбой второго файла: первый и третий доставлены, оповещение про второй, ответ ok', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn()
        .mockResolvedValueOnce({ maxMid: 'mid.1', timestampMs: 1 })
        .mockRejectedValueOnce(new MaxApiError('HTTP 400', { httpStatus: 400, maxCode: 'attachment.not.ready' }))
        .mockResolvedValueOnce({ maxMid: 'mid.3', timestampMs: 3 }),
    });
    const b24 = fakeB24Out();
    const log = fakeLogOut();
    const service = buildServiceOut({ max, b24, log });

    const result = await service.routeOutbound(makeEventWithFiles([fileN(1), fileN(2), fileN(3)]));

    expect(result.results[0]).toMatchObject({ ok: true, maxMids: ['mid.1', 'mid.3'], failedFiles: 1 });
    expect(log.recordOutbound.mock.calls.map((c) => c[0].b24MsgId)).toEqual([
      `file:${B24_MSG_ID}:0`, `file:${B24_MSG_ID}:2`, B24_MSG_ID,
    ]);
    expect(log.recordOutbound.mock.calls[2][0].payloadMeta).toMatchObject({ maxMids: ['mid.1', 'mid.3'], failedCount: 1 });
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21186',
      text: '⚠️ Не доставлено в MAX: файл «doc2.pdf» — MAX не принял (attachment.not.ready). Отправьте ещё раз.',
    }, { installation: INSTALLATION_OUT });
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(expect.objectContaining({ externalIds: ['mid.1', 'mid.3'] }));
  });

  it('M22-3) повтор события после частичного сбоя без итоговой записи: ушедший файл не перезаливается', async () => {
    // file:<id>:0 уже записан (прошлая попытка), итоговой записи нет.
    const log = fakeLogOut({
      findOutbound: vi.fn(async (_bindingId, key) => (
        key === `file:${B24_MSG_ID}:0`
          ? { id: 50, payloadMeta: { maxMid: 'mid.1', type: 'file', withCaption: true } }
          : null
      )),
    });
    const max = fakeMax({ uploadAndSend: vi.fn(async () => ({ maxMid: 'mid.2', timestampMs: 2 })) });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ max, b24, log });

    const result = await service.routeOutbound(
      makeEventWithFiles([fileN(1), fileN(2)], { text: '[b]Оп:[/b] [br]подпись' }),
    );

    expect(max.uploadAndSend).toHaveBeenCalledOnce();
    // Подпись уже ушла с первым файлом — второй без неё.
    expect(max.uploadAndSend.mock.calls[0][0].text).toBe('');
    expect(b24.downloadOperatorFile).toHaveBeenCalledOnce();
    expect(result.results[0]).toMatchObject({ ok: true, maxMids: ['mid.1', 'mid.2'] });
  });

  it('M22-4) первый файл не ушёл → подпись уходит со вторым', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn()
        .mockRejectedValueOnce(new MaxApiError('HTTP 500', { httpStatus: 500 }))
        .mockResolvedValueOnce({ maxMid: 'mid.2', timestampMs: 2 }),
    });
    const service = buildServiceOut({ max });

    await service.routeOutbound(makeEventWithFiles([fileN(1), fileN(2)], { text: '[b]Оп:[/b] [br]подпись' }));

    expect(max.uploadAndSend.mock.calls.map((c) => c[0].text)).toEqual(['**Оп:**\nподпись', '**Оп:**\nподпись']);
  });

  it('M22-5) все файлы не ушли, подпись есть → подпись текстом, оповещение про файлы', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn(async () => {
        throw new MaxApiError('network', { kind: 'network' });
      }),
    });
    const b24 = fakeB24Out();
    const log = fakeLogOut();
    const service = buildServiceOut({ max, b24, log });

    const result = await service.routeOutbound(
      makeEventWithFiles([fileN(1), fileN(2)], { text: '[b]Оп:[/b] [br]подпись' }),
    );

    expect(max.sendOutgoingMessage).toHaveBeenCalledOnce();
    expect(max.sendOutgoingMessage.mock.calls[0][0].text).toBe('**Оп:**\nподпись');
    expect(result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.OUT', failedFiles: 2 });
    expect(b24.sendSystemMessage.mock.calls[0][0].text).toBe(
      '⚠️ Не доставлено в MAX: файл «doc1.pdf» — MAX недоступен; файл «doc2.pdf» — MAX недоступен. Отправьте ещё раз.',
    );
  });

  it('M22-6) имя файла с BB-тегами экранируется в оповещении', async () => {
    const max = fakeMax({
      uploadAndSend: vi.fn(async () => {
        throw new MaxApiError('HTTP 500', { httpStatus: 500 });
      }),
    });
    const b24 = fakeB24Out();
    const service = buildServiceOut({ max, b24 });

    await service.routeOutbound(makeEventWithFiles([fileN(1, { name: '[url=http://evil]x[/url].pdf' })]));

    expect(b24.sendSystemMessage.mock.calls[0][0].text).toContain(`«${escapeBbcode('[url=http://evil]x[/url].pdf')}»`);
  });

  it('M22-7) ошибка БД на записи файла → проброс (500), временный файл удалён', async () => {
    const temp = fakeTemp();
    const log = fakeLogOut({
      recordOutbound: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const service = buildServiceOut({ log, temp });

    await expect(service.routeOutbound(makeEventWithFiles([fileN(1)]))).rejects.toThrow('db down');
    expect(temp.remove).toHaveBeenCalledWith('/tmp/m22/1.part');
  });
});

// M-lifecycle: координатор системных уведомлений о вступлении/выходе участника.
describe('MessagingService.routeLifecycle', () => {
  function makeLifecycle(overrides = {}) {
    return {
      updateType: 'user_added',
      chatId: -70000000000954,
      senderId: 54321,
      senderName: 'Иван Петров',
      timestamp: 1700000000123,
      ...overrides,
    };
  }

  function fakeBindingsLc(overrides = {}) {
    return {
      resolveByMaxChat: vi.fn(async () => ({
        binding: makeBinding({ b24ChatId: '21180' }),
        isReady: true,
      })),
      attachB24ChatId: vi.fn(async (id, b24ChatId) => makeBinding({ id, b24ChatId })),
      ...overrides,
    };
  }

  function fakeB24Lc(overrides = {}) {
    return {
      sendSystemMessage: vi.fn(async () => ({ b24MsgId: 9876, dialogId: 'chat21180' })),
      // M-lifecycle: дорезолвинг b24_chat_id (вызывается только когда binding.b24ChatId пуст).
      resolveB24ChatId: vi.fn(async () => '21999'),
      ...overrides,
    };
  }

  function fakeLogLc(overrides = {}) {
    return {
      findInbound: vi.fn(async () => null),
      recordInbound: vi.fn(async () => ({ id: 555 })),
      ...overrides,
    };
  }

  it('1) happy path user_added: текст с эмодзи+имя, sendSystemMessage вызван, record записан', async () => {
    const bindings = fakeBindingsLc();
    const b24 = fakeB24Lc();
    const log = fakeLogLc();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeLifecycle(makeLifecycle());

    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21180',
      text: '👋 Новое вступление в группу [b]Иван Петров[/b]',
    });
    expect(log.recordInbound).toHaveBeenCalledWith({
      bindingId: 10,
      maxMid: 'user_added:-70000000000954:54321:1700000000123',
      payloadMeta: { kind: 'lifecycle', event: 'user_added', userId: 54321, b24MsgId: 9876 },
    });
    expect(result).toEqual({ ok: true, bindingId: 10, event: 'user_added', b24MsgId: 9876, logId: expect.anything() });
  });

  it('2) happy path user_removed: текст «покинул группу»', async () => {
    const b24 = fakeB24Lc();
    const service = buildService({ bindings: fakeBindingsLc(), b24, log: fakeLogLc() });

    const result = await service.routeLifecycle(makeLifecycle({ updateType: 'user_removed' }));

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21180',
      text: '🚪 Участник покинул группу [b]Иван Петров[/b]',
    });
    expect(result).toMatchObject({ ok: true, event: 'user_removed', b24MsgId: 9876 });
  });

  it('3) senderName=null → fallback "MAX user <id>" в тексте', async () => {
    const b24 = fakeB24Lc();
    const service = buildService({ bindings: fakeBindingsLc(), b24, log: fakeLogLc() });

    await service.routeLifecycle(makeLifecycle({ senderName: null }));

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21180',
      text: '👋 Новое вступление в группу [b]MAX user 54321[/b]',
    });
  });

  it('3a) BB-теги в имени участника экранируются (нет инъекции ссылки в чат оператора)', async () => {
    const b24 = fakeB24Lc();
    const service = buildService({ bindings: fakeBindingsLc(), b24, log: fakeLogLc() });

    await service.routeLifecycle(
      makeLifecycle({ senderName: '[/b][url=https://phish.example]Оплатить[/url]' }),
    );

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21180',
      text: '👋 Новое вступление в группу [b][\u200b/b][\u200burl=https://phish.example]Оплатить[\u200b/url][/b]',
    });
  });

  it('4) нет binding → {skipped:"no-binding"}, sendSystemMessage не вызван', async () => {
    const b24 = fakeB24Lc();
    const bindings = fakeBindingsLc({
      resolveByMaxChat: vi.fn(async () => ({ binding: null, isReady: false })),
    });
    const service = buildService({ bindings, b24, log: fakeLogLc() });

    const result = await service.routeLifecycle(makeLifecycle());
    expect(result).toEqual({ skipped: 'no-binding' });
    expect(b24.resolveB24ChatId).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('5) binding без b24ChatId → дорезолвинг через resolveB24ChatId, персист, отправка', async () => {
    const b24 = fakeB24Lc();
    const bindings = fakeBindingsLc({
      resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding({ b24ChatId: null }), isReady: true })),
    });
    const service = buildService({ bindings, b24, log: fakeLogLc() });

    const result = await service.routeLifecycle(makeLifecycle());

    // резолвинг по connectorChatId binding'а, без отправки сообщения
    expect(b24.resolveB24ChatId).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954' });
    // резолвнутый адрес персистится
    expect(bindings.attachB24ChatId).toHaveBeenCalledWith(10, '21999');
    // и используется для отправки уведомления
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21999',
      text: '👋 Новое вступление в группу [b]Иван Петров[/b]',
    });
    expect(result).toMatchObject({ ok: true, bindingId: 10, b24MsgId: 9876 });
  });

  it('5b) binding без b24ChatId и резолвинг вернул null (нет OL-чата) → {skipped:"no-chat"}', async () => {
    const b24 = fakeB24Lc({ resolveB24ChatId: vi.fn(async () => null) });
    const bindings = fakeBindingsLc({
      resolveByMaxChat: vi.fn(async () => ({ binding: makeBinding({ b24ChatId: null }), isReady: true })),
    });
    const service = buildService({ bindings, b24, log: fakeLogLc() });

    const result = await service.routeLifecycle(makeLifecycle());
    expect(result).toEqual({ skipped: 'no-chat' });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('5c) binding с b24ChatId → резолвинг НЕ дёргается (адрес уже есть)', async () => {
    const b24 = fakeB24Lc();
    const service = buildService({ bindings: fakeBindingsLc(), b24, log: fakeLogLc() });

    await service.routeLifecycle(makeLifecycle());
    expect(b24.resolveB24ChatId).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21180',
      text: '👋 Новое вступление в группу [b]Иван Петров[/b]',
    });
  });

  it('6) дубль (findInbound → isDuplicate()) → {skipped:"duplicate"}, send не вызван', async () => {
    const b24 = fakeB24Lc();
    const log = fakeLogLc({
      findInbound: vi.fn(async () => ({ id: 7, isDuplicate: () => true })),
    });
    const service = buildService({ bindings: fakeBindingsLc(), b24, log });

    const result = await service.routeLifecycle(makeLifecycle());
    expect(result).toEqual({ skipped: 'duplicate', logId: 7 });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('7) send-failed: ошибка sendSystemMessage НЕ бросается наружу → {skipped:"send-failed"}', async () => {
    const b24 = fakeB24Lc({
      sendSystemMessage: vi.fn(async () => {
        throw new B24ApiError('ACCESS_ERROR', 'no access', { method: 'im.message.add' });
      }),
    });
    const log = fakeLogLc();
    const service = buildService({ bindings: fakeBindingsLc(), b24, log });

    const result = await service.routeLifecycle(makeLifecycle());
    expect(result).toEqual({ skipped: 'send-failed' });
    expect(log.recordInbound).not.toHaveBeenCalled();
  });

  it('8) duplicate-race: recordInbound вернул пусто → {skipped:"duplicate-race"}', async () => {
    const b24 = fakeB24Lc();
    const log = fakeLogLc({ recordInbound: vi.fn(async () => null) });
    const service = buildService({ bindings: fakeBindingsLc(), b24, log });

    const result = await service.routeLifecycle(makeLifecycle());
    expect(result).toEqual({ skipped: 'duplicate-race' });
  });
});

// ── Reply/цитирование: _resolveReplyMaxMid (CONNECTOR_MID/REPLY_ID → MAX mid) ──
describe('MessagingService._resolveReplyMaxMid', () => {
  const binding = { id: 20 };
  function buildSvc(log) {
    return new MessagingService({
      bindingsService: fakeBindings(),
      messageLogRepository: log ?? fakeLogOut(),
      logger: silentLogger(),
    });
  }

  it('connector-mid-client: "max:mid:*" → strip префикса', async () => {
    const r = await buildSvc()._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 1, parentConnectorMid: 'max:mid:abc123' },
    });
    expect(r).toEqual({ maxMid: 'abc123', resolvedVia: 'connector-mid-client' });
  });

  it('connector-mid-operator: без префикса → maxMid как есть', async () => {
    const r = await buildSvc()._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 1, parentConnectorMid: '77.99' },
    });
    expect(r).toEqual({ maxMid: '77.99', resolvedVia: 'connector-mid-operator' });
  });

  it('message-log fallback: нет connectorMid → findOutbound.payloadMeta.maxMid', async () => {
    const log = fakeLogOut({
      findOutbound: vi.fn(async () => ({ payloadMeta: { maxMid: 'mid.parent' } })),
    });
    const r = await buildSvc(log)._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 555, parentConnectorMid: null },
    });
    expect(log.findOutbound).toHaveBeenCalledWith(20, '555');
    expect(r).toEqual({ maxMid: 'mid.parent', resolvedVia: 'message-log' });
  });

  it('none: findOutbound вернул null (нет строки) → не падает', async () => {
    const log = fakeLogOut({ findOutbound: vi.fn(async () => null) });
    const r = await buildSvc(log)._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 555, parentConnectorMid: null },
    });
    expect(r).toEqual({ maxMid: null, resolvedVia: 'none' });
  });

  it('none (служебный): "max:group-session:*" (опенер сессии M25) → без link, findOutbound не зван', async () => {
    const log = fakeLogOut();
    const r = await buildSvc(log)._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 1, parentConnectorMid: 'max:group-session:-70000000000954:16340:mid.X' },
    });
    expect(r).toEqual({ maxMid: null, resolvedVia: 'none' });
    expect(log.findOutbound).not.toHaveBeenCalled();
  });

  it('none: "max:nomid:*" (сообщение без mid, M21) → без link, findOutbound не зван', async () => {
    const log = fakeLogOut();
    const r = await buildSvc(log)._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: 1, parentConnectorMid: 'max:nomid:-70000000000954:54321:1700000000000' },
    });
    expect(r).toEqual({ maxMid: null, resolvedVia: 'none' });
    expect(log.findOutbound).not.toHaveBeenCalled();
  });

  it('none: ни connectorMid, ни replyId → none, findOutbound не зван', async () => {
    const log = fakeLogOut();
    const r = await buildSvc(log)._resolveReplyMaxMid({
      binding,
      replyContext: { replyId: null, parentConnectorMid: null },
    });
    expect(r).toEqual({ maxMid: null, resolvedVia: 'none' });
    expect(log.findOutbound).not.toHaveBeenCalled();
  });
});

// ─── M24: routeChatTitleChanged (переименование группы в MAX → чат OL) ────────
describe('MessagingService.routeChatTitleChanged (M24)', () => {
  const TS = 1700000009000;

  function titleUpdate(overrides = {}) {
    return {
      updateType: 'chat_title_changed',
      timestamp: TS,
      chatId: -70000000000954,
      senderId: 1000001,
      senderName: 'Олег',
      chatTitle: 'Новое',
      ...overrides,
    };
  }

  // resolve: 1-й вызов — привязка со старым названием, дальше (перечитывание при
  // синхронизации) — уже с новым max_chat_title.
  function titleFakes({ setChatName, getOlChat, olSessionId = 15756 } = {}) {
    const b24 = fakeB24({
      setChatName: setChatName ?? vi.fn(async () => ({ success: true })),
      ...(getOlChat ? { getOlChat } : {}),
    });
    const bindings = fakeBindings({
      resolveByMaxChat: vi.fn()
        .mockResolvedValueOnce({
          binding: chatBinding({ b24ChatId: '21180', maxChatTitle: 'Старое', olChatTitle: 'Старое', olSessionId }),
          isReady: true,
        })
        .mockResolvedValue({
          binding: chatBinding({ b24ChatId: '21180', maxChatTitle: 'Новое', olChatTitle: 'Старое', olSessionId }),
          isReady: true,
        }),
      updateMaxChatTitle: vi.fn(async () => ({})),
      markOlChatTitle: vi.fn(async () => ({})),
      markOlSessionClosedByRename: vi.fn(async (id, known) => chatBinding({
        olSessionId: known,
        olClosedSessionId: known ?? 0,
      })),
    });
    const log = fakeLog();
    return { b24, bindings, log };
  }

  const renameFails = () => vi.fn(async () => { throw renamingFailed(); });

  it('1) happy path: название записано (_once), chat.name.set, отметка → {ok, olTitle:"synced"}', async () => {
    const { b24, bindings, log } = titleFakes();
    const service = buildService({ bindings, b24, log });

    const result = await service.routeChatTitleChanged(titleUpdate());

    expect(result).toEqual({ ok: true, bindingId: 10, logId: 100, olTitle: 'synced' });
    expect(bindings.updateMaxChatTitle).toHaveBeenCalledWith(10, 'Новое');
    expect(log.recordInbound).toHaveBeenCalledWith({
      bindingId: 10,
      maxMid: `chat_title_changed:-70000000000954:${TS}`,
      payloadMeta: { kind: 'chat_title_changed', userId: 1000001, titleLen: 5 },
    });
    expect(b24.setChatName).toHaveBeenCalledWith({ connectorChatId: 'max:-70000000000954', name: 'Новое' });
    expect(bindings.markOlChatTitle).toHaveBeenCalledWith(10, 'Новое');
  });

  it('2) сессия закрыта (CHAT_RENAMING_FAILED, поле 6 = 0) → olTitle:"pending", флаг опенера по ol_session_id', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
    });
    const service = buildService({ bindings, b24, log });
    const logger = silentLogger();

    const result = await service.routeChatTitleChanged(titleUpdate(), { logger });

    expect(result).toEqual({ ok: true, bindingId: 10, logId: 100, olTitle: 'pending' });
    expect(bindings.updateMaxChatTitle).toHaveBeenCalledWith(10, 'Новое');
    expect(b24.getOlChat).toHaveBeenCalledWith({ b24ChatId: '21180' });
    expect(bindings.markOlSessionClosedByRename).toHaveBeenCalledWith(10, 15756);
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(logged(logger.info, 'OL session closed (CHAT_RENAMING_FAILED), group opener armed')).toBe(true);
  });

  it('2b) M27: сессия старой привязки неизвестна (ol_session_id NULL) → флаг 0', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
      olSessionId: null,
    });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toMatchObject({ ok: true, olTitle: 'pending' });
    expect(bindings.markOlSessionClosedByRename).toHaveBeenCalledWith(10, null);
  });

  it('2c) M27: флаг уже взведён (Finish дошёл) → INFO «already armed», olTitle:"pending"', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
    });
    bindings.markOlSessionClosedByRename = vi.fn(async () => null);
    const service = buildService({ bindings, b24, log });
    const logger = silentLogger();

    await expect(service.routeChatTitleChanged(titleUpdate(), { logger })).resolves.toMatchObject({ ok: true, olTitle: 'pending' });
    expect(logged(logger.info, 'opener already armed')).toBe(true);
    expect(logged(logger.info, 'group opener armed')).toBe(false);
  });

  it('2d) M27: сессия открыта, имя в OL уже новое → olTitle:"synced" (already), без флага', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Новое', sessionId: 15756 })),
    });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toMatchObject({ ok: true, olTitle: 'synced' });
    expect(bindings.markOlChatTitle).toHaveBeenCalledWith(10, 'Новое');
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
  });

  it('2e) M27: сессия открыта, имя другое → olTitle:"pending" без флага и без отметки', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Ручное имя', sessionId: 15756 })),
    });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toMatchObject({ ok: true, olTitle: 'pending' });
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
  });

  it('2f) M27: dialog.get упал (getOlChat → null) → olTitle:"pending", флаг не взводим', async () => {
    const { b24, bindings, log } = titleFakes({ setChatName: renameFails() });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toMatchObject({ ok: true, olTitle: 'pending' });
    expect(b24.getOlChat).toHaveBeenCalledOnce();
    expect(bindings.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(bindings.markOlChatTitle).not.toHaveBeenCalled();
  });

  it('2g) M27: ошибка БД при взведении флага → olTitle:"failed" (WARN step arm-opener), вердикт ok', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: renameFails(),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
    });
    bindings.markOlSessionClosedByRename = vi.fn(async () => { throw new Error('db down'); });
    const service = buildService({ bindings, b24, log });
    const logger = silentLogger();

    const result = await service.routeChatTitleChanged(titleUpdate(), { logger });

    expect(result).toEqual({ ok: true, bindingId: 10, logId: 100, olTitle: 'failed' });
    expect(logger.warn.mock.calls.some((c) => c[0]?.step === 'arm-opener')).toBe(true);
  });

  it('3) Б24 недоступен → olTitle:"failed", вердикт ok (название ждёт следующего входящего)', async () => {
    const { b24, bindings, log } = titleFakes({
      setChatName: vi.fn(async () => { throw new B24ApiError('TIMEOUT', 'timeout', {}); }),
    });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toMatchObject({ ok: true, olTitle: 'failed' });
  });

  it('4) группа не подключена → {skipped:"no-binding"}, ничего не пишем', async () => {
    const { b24, bindings, log } = titleFakes();
    bindings.resolveByMaxChat = vi.fn(async () => ({ binding: null, isReady: false }));
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toEqual({ skipped: 'no-binding' });
    expect(bindings.updateMaxChatTitle).not.toHaveBeenCalled();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('5) пустое название → {skipped:"no-title"}, resolve не зовётся', async () => {
    const { bindings } = titleFakes();
    const service = buildService({ bindings });

    await expect(service.routeChatTitleChanged(titleUpdate({ chatTitle: null }))).resolves.toEqual({ skipped: 'no-title' });
    expect(bindings.resolveByMaxChat).not.toHaveBeenCalled();
  });

  it('6) ретрай того же события (запись есть) → duplicate, без записи названия и переименования', async () => {
    const { b24, bindings } = titleFakes();
    const log = fakeLog({ findInbound: vi.fn(async () => ({ id: 77 })) });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).resolves.toEqual({ skipped: 'duplicate', logId: 77 });
    expect(bindings.updateMaxChatTitle).not.toHaveBeenCalled();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('7) ошибка БД при записи названия → проброс (500 → MAX ретраит), без записи в лог', async () => {
    const { b24, bindings, log } = titleFakes();
    bindings.updateMaxChatTitle = vi.fn(async () => { throw new Error('db down'); });
    const service = buildService({ bindings, b24, log });

    await expect(service.routeChatTitleChanged(titleUpdate())).rejects.toThrow('db down');
    expect(log.recordInbound).not.toHaveBeenCalled();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('8) нет timestamp → ключ по хешу названия', async () => {
    const { b24, bindings, log } = titleFakes();
    const service = buildService({ bindings, b24, log });

    await service.routeChatTitleChanged(titleUpdate({ timestamp: null }));

    expect(log.recordInbound.mock.calls[0][0].maxMid)
      .toBe(`chat_title_changed:-70000000000954:${contentHash('Новое')}`);
  });

  it('9) не тот update_type → ValidationError', async () => {
    const service = buildService();
    await expect(service.routeChatTitleChanged(titleUpdate({ updateType: 'message_created' }))).rejects.toThrow(
      /only chat_title_changed supported/,
    );
  });
});
