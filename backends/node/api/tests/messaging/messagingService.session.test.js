// Unit-тесты M25: опенер сессии OL от «группы» (_openGroupSessionSafe, _noteOlSessionSafe)
// и routeDialogFinish (OnImConnectorDialogFinish); M27 — флаг 0 без номера сессии от
// CHAT_RENAMING_FAILED. Моки адаптеров, БД/сеть не нужны.
// Фейк привязок хранит строку в памяти и повторяет guard'ы SQL репозитория
// (сам SQL проверяет bindingsRepository.olSession.int.test.js).

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { ConnectorMessage } from '../../src/modules/b24/models/ConnectorMessage.js';
import { escapeBbcode } from '../../src/modules/b24/bbcode.js';
import { ChatBinding } from '../../src/modules/bindings/models/ChatBinding.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { ValidationError } from '../../src/shared/http/domainErrors.js';

const CHAT_ID = -70000000000954;
const CONNECTOR_CHAT = 'max:-70000000000954';
const ICON = 'https://i.oneme.ru/i?r=ICON';
const CLOSED = 16340;
const NEXT = 16342;
const openerKey = (mid, closed = CLOSED) => `group-session:-70000000000954:${closed}:${mid}`;

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

// Строка привязки по умолчанию: чат OL известен, название синхронно, сессия CLOSED закрыта.
function bindingsStore(overrides = {}) {
  const row = {
    id: 10,
    installationId: 1,
    maxChatId: '-70000000000954',
    connectorChatId: CONNECTOR_CHAT,
    maxChatTitle: 'Отдел продаж',
    olChatTitle: 'Отдел продаж',
    b24ChatId: '21180',
    olSessionId: CLOSED,
    olClosedSessionId: CLOSED,
    ...overrides,
  };
  const snapshot = () => new ChatBinding({ ...row });
  const service = {
    resolveByMaxChat: vi.fn(async () => ({ binding: snapshot(), isReady: true })),
    resolveByConnectorChat: vi.fn(async (id) => ({ binding: id === row.connectorChatId ? snapshot() : null })),
    ensureParticipant: vi.fn(async () => ({ id: 1 })),
    attachB24ChatId: vi.fn(async (id, b24ChatId) => { row.b24ChatId = b24ChatId; return snapshot(); }),
    updateMaxChatTitle: vi.fn(async () => snapshot()),
    markOlChatTitle: vi.fn(async () => snapshot()),
    // Зеркало bindingsRepository.updateOlSession.
    rememberOlSession: vi.fn(async (id, sid) => {
      const known = row.olSessionId;
      const closed = row.olClosedSessionId;
      if (!(known === null || known < sid || (closed !== null && closed < sid))) return null;
      row.olSessionId = Math.max(known ?? sid, sid);
      if (closed !== null && closed < sid) row.olClosedSessionId = null;
      return snapshot();
    }),
    // Зеркало bindingsRepository.markOlSessionClosed.
    markOlSessionClosed: vi.fn(async (id, sid) => {
      if (!(row.olSessionId === null || row.olSessionId <= sid) || row.olClosedSessionId === sid) return null;
      row.olSessionId = Math.max(row.olSessionId ?? sid, sid);
      row.olClosedSessionId = sid;
      return snapshot();
    }),
    // Зеркало bindingsService.markOlSessionClosedByRename (M27): число → markOlSessionClosed,
    // null → markOlSessionClosedUnknown (флаг 0 при неизвестной сессии).
    markOlSessionClosedByRename: vi.fn(async (id, known) => {
      if (known !== null) return service.markOlSessionClosed(id, known);
      if (row.olSessionId !== null || row.olClosedSessionId !== null) return null;
      row.olClosedSessionId = 0;
      return snapshot();
    }),
    // Зеркало bindingsRepository.clearOlClosedSession.
    completeSessionOpener: vi.fn(async (id, closedSid, sid) => {
      if (row.olClosedSessionId !== closedSid) return null;
      row.olClosedSessionId = null;
      if (sid !== null) row.olSessionId = Math.max(row.olSessionId ?? sid, sid);
      return snapshot();
    }),
  };
  return { row, service };
}

function fakeB24({ sessionId = String(NEXT), ...overrides } = {}) {
  return {
    sendConnectorMessage: vi.fn(async (cm) => ({
      b24MsgId: cm.externalMessageId,
      sessionId,
      b24ChatId: '21180',
      raw: {},
    })),
    setChatName: vi.fn(async () => ({})),
    resolveB24ChatId: vi.fn(async () => '21180'),
    // M27: состояние чата OL на CHAT_RENAMING_FAILED — по умолчанию не прочитано.
    getOlChat: vi.fn(async () => null),
    ...overrides,
  };
}

function fakeLog(records = new Map()) {
  return {
    records,
    findInbound: vi.fn(async (bindingId, key) => records.get(key) ?? null),
    recordInbound: vi.fn(async ({ maxMid, payloadMeta }) => {
      const row = { id: records.size + 100, payloadMeta };
      records.set(maxMid, row);
      return row;
    }),
    // M27: ссылка на группу уже постилась — ленивый шаг не зовёт GET /chats.
    hasInboundKeyPrefix: vi.fn(async () => true),
  };
}

function fakeMax(info = { title: 'Отдел продаж', iconUrl: ICON, type: 'chat' }) {
  return {
    getChatInfo: vi.fn(async () => info),
    getMemberAvatar: vi.fn(async () => null),
  };
}

function makeUpdate(overrides = {}) {
  const update = {
    updateType: 'message_created',
    timestamp: 1700000000000,
    chatId: CHAT_ID,
    mid: 'mid.ABC',
    senderId: 54321,
    senderName: 'Иван',
    message: { body: { text: 'привет' } },
    ...overrides,
  };
  update.attachments = () => [];
  return update;
}

function build({ store = bindingsStore(), b24 = fakeB24(), log = fakeLog(), max = fakeMax() } = {}) {
  const logger = silentLogger();
  const service = new MessagingService({
    bindingsService: store.service,
    b24Service: b24,
    maxService: max,
    messageLogRepository: log,
    logger,
  });
  return { service, store, b24, log, max, logger };
}

const sentIds = (b24) => b24.sendConnectorMessage.mock.calls.map((c) => c[0].externalMessageId);

describe('MessagingService — опенер сессии OL (M25)', () => {
  it('M25-1) сессия закрыта → опенер от «группы» первым, затем сообщение; флаг снят, сессия запомнена', async () => {
    const { service, store, b24, log, max, logger } = build();

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result).toMatchObject({ ok: true, maxMid: 'mid.ABC' });
    expect(max.getChatInfo).toHaveBeenCalledWith(CHAT_ID);
    expect(b24.sendConnectorMessage).toHaveBeenCalledTimes(2);
    const opener = b24.sendConnectorMessage.mock.calls[0][0];
    expect(opener).toBeInstanceOf(ConnectorMessage);
    expect(opener.connectorChatId).toBe(CONNECTOR_CHAT);
    expect(opener.externalMessageId).toBe(`max:${openerKey('mid.ABC')}`);
    expect(opener.text).toBe('Новое обращение из группы «Отдел продаж» в MAX');
    expect(opener.date).toBe(1700000000);
    expect(opener.author).toEqual({
      id: 'group:-70000000000954',
      name: 'Отдел продаж',
      fallbackName: 'Группа MAX',
      picture: ICON,
    });
    expect(b24.sendConnectorMessage.mock.calls[1][0].externalMessageId).toBe('max:mid:mid.ABC');

    expect(store.service.completeSessionOpener).toHaveBeenCalledWith(10, CLOSED, NEXT);
    expect(store.row).toMatchObject({ olClosedSessionId: null, olSessionId: NEXT });
    // Реальное сообщение ушло в ту же сессию — второй записи сессии нет.
    expect(store.service.rememberOlSession).not.toHaveBeenCalled();

    expect(log.recordInbound.mock.calls.map((c) => c[0].maxMid)).toEqual([openerKey('mid.ABC'), 'mid.ABC']);
    expect(log.recordInbound.mock.calls[0][0].payloadMeta).toEqual({
      kind: 'group-session',
      b24MsgId: `max:${openerKey('mid.ABC')}`,
      closedSessionId: CLOSED,
      sessionId: NEXT,
      hasIcon: true,
    });
    // Название синхронно — без chat.name.set; maxChatTitle не трогаем.
    expect(b24.setChatName).not.toHaveBeenCalled();
    expect(store.service.updateMaxChatTitle).not.toHaveBeenCalled();
  });

  it('M25-2) getChatInfo → null (best-effort) → имя из сохранённого названия, без picture', async () => {
    const { service, b24 } = build({ max: fakeMax(null) });

    await service.routeInbound(makeUpdate());

    const opener = b24.sendConnectorMessage.mock.calls[0][0];
    expect(opener.text).toBe('Новое обращение из группы «Отдел продаж» в MAX');
    expect(opener.author).toEqual({ id: 'group:-70000000000954', name: 'Отдел продаж', fallbackName: 'Группа MAX' });
  });

  it('M25-3) название в MAX новее сохранённого → опенер со свежим, привязку и чат OL не трогаем', async () => {
    const { service, store, b24 } = build({ max: fakeMax({ title: 'Продажи 2.0', iconUrl: null, type: 'chat' }) });

    await service.routeInbound(makeUpdate());

    const opener = b24.sendConnectorMessage.mock.calls[0][0];
    expect(opener.author.name).toBe('Продажи 2.0');
    expect(opener.author.picture).toBeUndefined();
    expect(store.service.updateMaxChatTitle).not.toHaveBeenCalled();
    expect(b24.setChatName).not.toHaveBeenCalled();
  });

  it('M25-4) названия нет ни в MAX, ни в привязке → опенер отменён, флаг снят, сообщение доставлено', async () => {
    const { service, store, b24, logger } = build({
      store: bindingsStore({ maxChatTitle: null, olChatTitle: null }),
      max: fakeMax(null),
    });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(sentIds(b24)).toEqual(['max:mid:mid.ABC']);
    expect(store.service.completeSessionOpener).toHaveBeenCalledWith(10, CLOSED, null);
    expect(store.row.olClosedSessionId).toBeNull();
    expect(store.row.olSessionId).toBe(NEXT);
    expect(logged(logger.warn, 'dropping session opener')).toBe(true);
    // Finish дошёл — лог не должен говорить о потерянном событии.
    expect(logged(logger.info, 'without DialogFinish')).toBe(false);
    expect(logged(logger.info, 'without group opener')).toBe(true);
  });

  it('M25-5) чат не группа (type=channel) → опенер отменён, флаг снят', async () => {
    const { service, store, b24 } = build({ max: fakeMax({ title: 'Канал', iconUrl: null, type: 'channel' }) });

    await service.routeInbound(makeUpdate());

    expect(sentIds(b24)).toEqual(['max:mid:mid.ABC']);
    expect(store.service.completeSessionOpener).toHaveBeenCalledWith(10, CLOSED, null);
    expect(store.row.olClosedSessionId).toBeNull();
  });

  it('M25-6) опенер упал → warn, сообщение доставлено, флаг снят по сессии сообщения', async () => {
    const b24 = fakeB24({
      sendConnectorMessage: vi.fn(async (cm) => {
        if (cm.externalMessageId.startsWith('max:group-session:')) throw new Error('B24 down');
        return { b24MsgId: cm.externalMessageId, sessionId: String(NEXT), b24ChatId: '21180', raw: {} };
      }),
    });
    const { service, store, log, logger } = build({ b24 });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(logged(logger.warn, 'group session opener failed')).toBe(true);
    expect(log.recordInbound.mock.calls.map((c) => c[0].maxMid)).toEqual(['mid.ABC']);
    expect(store.service.rememberOlSession).toHaveBeenCalledWith(10, NEXT);
    expect(store.row).toMatchObject({ olClosedSessionId: null, olSessionId: NEXT });
    expect(logged(logger.info, 'without group opener')).toBe(true);
  });

  it('M25-7) ретрай MAX: опенер ушёл, сообщение упало → на повторе второго опенера нет', async () => {
    let failReal = true;
    const b24 = fakeB24({
      sendConnectorMessage: vi.fn(async (cm) => {
        if (cm.externalMessageId === 'max:mid:mid.ABC' && failReal) {
          failReal = false;
          throw new Error('B24 5xx');
        }
        return { b24MsgId: cm.externalMessageId, sessionId: String(NEXT), b24ChatId: '21180', raw: {} };
      }),
    });
    const { service } = build({ b24 });

    await expect(service.routeInbound(makeUpdate())).rejects.toThrow('B24 5xx');
    const retry = await service.routeInbound(makeUpdate());

    expect(retry.ok).toBe(true);
    expect(sentIds(b24)).toEqual([`max:${openerKey('mid.ABC')}`, 'max:mid:mid.ABC', 'max:mid:mid.ABC']);
  });

  it('M25-7b) ретрай: опенер ушёл, флаг не снялся (сбой БД) → duplicate-opener, флаг снимет сообщение', async () => {
    let failReal = true;
    const b24 = fakeB24({
      sendConnectorMessage: vi.fn(async (cm) => {
        if (cm.externalMessageId === 'max:mid:mid.ABC' && failReal) {
          failReal = false;
          throw new Error('B24 5xx');
        }
        return { b24MsgId: cm.externalMessageId, sessionId: String(NEXT), b24ChatId: '21180', raw: {} };
      }),
    });
    const store = bindingsStore();
    store.service.completeSessionOpener.mockRejectedValueOnce(new Error('db down'));
    const { service, logger } = build({ b24, store });

    await expect(service.routeInbound(makeUpdate(), { logger })).rejects.toThrow('B24 5xx');
    expect(store.row.olClosedSessionId).toBe(CLOSED);
    const retry = await service.routeInbound(makeUpdate(), { logger });

    expect(retry.ok).toBe(true);
    expect(sentIds(b24).filter((id) => id.startsWith('max:group-session:'))).toHaveLength(1);
    expect(logged(logger.warn, 'duplicate-opener')).toBe(true);
    expect(store.row).toMatchObject({ olClosedSessionId: null, olSessionId: NEXT });
  });

  it('M25-8) пачка сообщений после закрытия → один опенер, оба сообщения после него', async () => {
    let releaseOpener;
    const gate = new Promise((resolve) => { releaseOpener = resolve; });
    const sent = [];
    const b24 = fakeB24({
      sendConnectorMessage: vi.fn(async (cm) => {
        if (cm.externalMessageId.startsWith('max:group-session:')) await gate;
        sent.push(cm.externalMessageId);
        return { b24MsgId: cm.externalMessageId, sessionId: String(NEXT), b24ChatId: '21180', raw: {} };
      }),
    });
    const { service } = build({ b24 });

    const first = service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    const second = service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    releaseOpener();
    const results = await Promise.all([first, second]);

    expect(results.every((r) => r.ok)).toBe(true);
    // Опенер — от того сообщения, что первым дошло до _serialized.
    expect(sent[0]).toMatch(/^max:group-session:-70000000000954:16340:mid\.[12]$/);
    expect(sent.filter((id) => id.startsWith('max:group-session:'))).toHaveLength(1);
    expect(sent.slice(1).sort()).toEqual(['max:mid:mid.1', 'max:mid:mid.2']);
  });

  it('M25-9) опенер попал в ту же закрытую сессию (возобновление) → INFO, флаг снят', async () => {
    const { service, store, logger } = build({ b24: fakeB24({ sessionId: String(CLOSED) }) });

    await service.routeInbound(makeUpdate(), { logger });

    expect(store.service.completeSessionOpener).toHaveBeenCalledWith(10, CLOSED, CLOSED);
    expect(store.row.olClosedSessionId).toBeNull();
    expect(logged(logger.info, 'resumed')).toBe(true);
  });

  it('M25-10) сессия не закрыта → ни перечитывания, ни getChatInfo, одна отправка, без записи сессии', async () => {
    const store = bindingsStore({ olSessionId: NEXT, olClosedSessionId: null });
    const { service, b24, max } = build({ store });

    await service.routeInbound(makeUpdate());

    expect(store.service.resolveByMaxChat).toHaveBeenCalledOnce();
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(sentIds(b24)).toEqual(['max:mid:mid.ABC']);
    expect(store.service.rememberOlSession).not.toHaveBeenCalled();
  });

  it('M25-11) сессия сменилась без DialogFinish → запись сессии + INFO (событие потеряно)', async () => {
    const store = bindingsStore({ olSessionId: CLOSED, olClosedSessionId: null });
    const { service, logger } = build({ store });

    await service.routeInbound(makeUpdate(), { logger });

    expect(store.service.rememberOlSession).toHaveBeenCalledWith(10, NEXT);
    expect(store.row.olSessionId).toBe(NEXT);
    expect(logged(logger.info, 'without DialogFinish')).toBe(true);
  });

  it('M25-12) старая привязка без b24ChatId, чат OL есть (интро пропущено) + флаг → опенер уходит', async () => {
    const store = bindingsStore({ b24ChatId: null });
    const { service, b24 } = build({ store });

    await service.routeInbound(makeUpdate());

    expect(b24.resolveB24ChatId).toHaveBeenCalledOnce();
    expect(sentIds(b24)).toEqual([`max:${openerKey('mid.ABC')}`, 'max:mid:mid.ABC']);
  });

  it('M25-13) BB-теги в названии экранируются в тексте опенера', async () => {
    const title = 'Отдел [b]продаж[/b]';
    const { service, b24 } = build({ max: fakeMax({ title, iconUrl: null, type: 'chat' }) });

    await service.routeInbound(makeUpdate());

    expect(b24.sendConnectorMessage.mock.calls[0][0].text)
      .toBe(`Новое обращение из группы «${escapeBbcode(title)}» в MAX`);
  });

  it('M25-14) опенер уже записан под этим ключом → duplicate-opener, повторно не шлём', async () => {
    const log = fakeLog(new Map([[openerKey('mid.ABC'), { id: 7 }]]));
    const { service, b24 } = build({ log });

    await service.routeInbound(makeUpdate());

    expect(sentIds(b24)).toEqual(['max:mid:mid.ABC']);
  });

  it('M25-15) дубль mid → опенер не запускается', async () => {
    const log = fakeLog(new Map([['mid.ABC', { id: 7 }]]));
    const { service, b24, store } = build({ log });

    const result = await service.routeInbound(makeUpdate());

    expect(result.skipped).toBe('duplicate');
    expect(b24.sendConnectorMessage).not.toHaveBeenCalled();
    expect(store.row.olClosedSessionId).toBe(CLOSED);
  });

  it('M25-16) интро новой группы запоминает сессию один раз (сообщение в ту же сессию)', async () => {
    const store = bindingsStore({ b24ChatId: null, olSessionId: null, olClosedSessionId: null, maxChatTitle: null, olChatTitle: null });
    store.service.resolveByMaxChat
      .mockResolvedValueOnce({ binding: null, isReady: false });
    store.service.ensureForMaxChat = vi.fn(async () => ({ binding: new ChatBinding({ ...store.row }), created: true }));
    const { service, b24 } = build({ store, b24: fakeB24({ sessionId: String(CLOSED) }) });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(sentIds(b24)[0]).toBe('max:group-intro:-70000000000954');
    expect(store.service.rememberOlSession).toHaveBeenCalledOnce();
    expect(store.service.rememberOlSession).toHaveBeenCalledWith(10, CLOSED);
    expect(store.row.olSessionId).toBe(CLOSED);
  });

  it('M25-17) запись сессии упала (до миграции 0011) → warn, доставка ok', async () => {
    const store = bindingsStore({ olSessionId: null, olClosedSessionId: null });
    store.service.rememberOlSession.mockRejectedValue(new Error('column "ol_session_id" does not exist'));
    const { service, logger } = build({ store });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(logged(logger.warn, 'OL session persist failed')).toBe(true);
  });
});

// ─── M27: флаг 0 — сессия закрыта, номер неизвестен (CHAT_RENAMING_FAILED) ─────

describe('MessagingService — флаг опенера без номера сессии (M27)', () => {
  it('M27-1) флаг 0 → опенер с ключом group-session:<chatId>:0:<mid>, флаг снят по сессии опенера', async () => {
    const store = bindingsStore({ olSessionId: null, olClosedSessionId: 0 });
    const { service, b24, log } = build({ store });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(sentIds(b24)).toEqual([`max:${openerKey('mid.ABC', 0)}`, 'max:mid:mid.ABC']);
    expect(store.service.completeSessionOpener).toHaveBeenCalledWith(10, 0, NEXT);
    expect(store.row).toMatchObject({ olClosedSessionId: null, olSessionId: NEXT });
    expect(log.recordInbound.mock.calls[0][0]).toMatchObject({
      maxMid: openerKey('mid.ABC', 0),
      payloadMeta: { kind: 'group-session', closedSessionId: 0, sessionId: NEXT },
    });
  });

  it('M27-2) chat_title_changed при закрытой сессии (поле 6 = 0), ol_session_id NULL → флаг 0 → следующее входящее с опенером', async () => {
    const store = bindingsStore({ olSessionId: null, olClosedSessionId: null, maxChatTitle: 'Старое', olChatTitle: 'Старое' });
    const b24 = fakeB24({
      setChatName: vi.fn(async () => {
        throw Object.assign(new Error('Chat renaming failed'), { b24Code: 'CHAT_RENAMING_FAILED' });
      }),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
    });
    store.service.updateMaxChatTitle = vi.fn(async (id, title) => { store.row.maxChatTitle = title; return null; });
    const { service, logger } = build({ store, b24 });

    const renamed = await service.routeChatTitleChanged({
      updateType: 'chat_title_changed',
      timestamp: 1700000009000,
      chatId: CHAT_ID,
      senderId: 54321,
      chatTitle: 'Новое',
    }, { logger });

    expect(renamed).toMatchObject({ ok: true, olTitle: 'pending' });
    expect(store.service.markOlSessionClosedByRename).toHaveBeenCalledWith(10, null);
    expect(store.row.olClosedSessionId).toBe(0);
    expect(logged(logger.info, 'group opener armed')).toBe(true);

    b24.setChatName = vi.fn(async () => ({}));
    await service.routeInbound(makeUpdate());

    expect(sentIds(b24)).toEqual([`max:${openerKey('mid.ABC', 0)}`, 'max:mid:mid.ABC']);
    expect(store.row).toMatchObject({ olClosedSessionId: null, olSessionId: NEXT });
    expect(b24.setChatName).toHaveBeenCalledWith({ connectorChatId: CONNECTOR_CHAT, name: 'Новое' });
  });

  it('M27-3) входящий путь: CHAT_RENAMING_FAILED при поле 6 = 0 флаг не взводит', async () => {
    const store = bindingsStore({ olSessionId: CLOSED, olClosedSessionId: null, maxChatTitle: 'Новое', olChatTitle: 'Старое' });
    const b24 = fakeB24({
      setChatName: vi.fn(async () => {
        throw Object.assign(new Error('Chat renaming failed'), { b24Code: 'CHAT_RENAMING_FAILED' });
      }),
      getOlChat: vi.fn(async () => ({ b24ChatId: '21180', name: 'Старое', sessionId: 0 })),
    });
    const { service } = build({ store, b24 });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(b24.getOlChat).toHaveBeenCalledOnce();
    expect(store.service.markOlSessionClosedByRename).not.toHaveBeenCalled();
    expect(store.row.olClosedSessionId).toBeNull();
  });
});

// ─── routeDialogFinish ────────────────────────────────────────────────────────

function finishEvent(items, { event = 'ONIMCONNECTORDIALOGFINISH' } = {}) {
  return OpenLineEvent.fromWebhookBody({
    event,
    data: { CONNECTOR: 'max_b24', LINE: '42', DATA: items },
    auth: { application_token: 'tok', member_id: 'mem' },
  });
}

// Live (2026-10-08): connector.chat_id и chat.id — оба внешний id 'max:<chatId>'.
function dialog({ chatId = CONNECTOR_CHAT, chatIdField = chatId, sessionId = String(NEXT), closed = 'Y' } = {}) {
  return {
    connector: { connector_id: 'max_b24', line_id: '42', chat_id: chatId, user_id: '0' },
    session: { id: sessionId, closed, parent_id: String(CLOSED), close_term: '10' },
    chat: { id: chatIdField },
    user: { id: '0' },
  };
}

describe('MessagingService.routeDialogFinish (M25)', () => {
  const openStore = (overrides = {}) => bindingsStore({ olSessionId: NEXT, olClosedSessionId: null, ...overrides });

  it('закрытие по connector.chat_id → флаг опенера взведён', async () => {
    const { service, store, logger } = build({ store: openStore() });

    const result = await service.routeDialogFinish(finishEvent([dialog()]), { logger });

    expect(result).toEqual({ ok: true, results: [{ ok: true, bindingId: 10, sessionId: NEXT }] });
    expect(store.service.resolveByConnectorChat).toHaveBeenCalledWith(CONNECTOR_CHAT);
    expect(store.service.markOlSessionClosed).toHaveBeenCalledWith(10, NEXT);
    expect(store.row.olClosedSessionId).toBe(NEXT);
    expect(logged(logger.info, 'group opener armed')).toBe(true);
  });

  it('connector.chat_id нет → берём chat.id (тот же внешний id); нет обоих → no-chat', async () => {
    const { service, store } = build({ store: openStore() });

    const result = await service.routeDialogFinish(finishEvent([
      dialog({ chatId: null, chatIdField: CONNECTOR_CHAT }),
      dialog({ chatId: null, chatIdField: null, sessionId: String(NEXT + 2) }),
    ]));

    expect(result.results).toEqual([{ ok: true, bindingId: 10, sessionId: NEXT }, { skipped: 'no-chat' }]);
    expect(store.service.resolveByConnectorChat).toHaveBeenCalledOnce();
  });

  it('привязки нет (чужой или пробный чат) → no-binding', async () => {
    const { service, store } = build({ store: openStore() });

    const result = await service.routeDialogFinish(finishEvent([dialog({ chatId: 'max:probe-1' })]));

    expect(result.results).toEqual([{ skipped: 'no-binding' }]);
    expect(store.service.markOlSessionClosed).not.toHaveBeenCalled();
  });

  it('устаревший Finish (входящее уже открыло новую сессию) → stale-session, флаг не взведён', async () => {
    const { service, store } = build({ store: openStore({ olSessionId: NEXT }) });

    const result = await service.routeDialogFinish(finishEvent([dialog({ sessionId: String(CLOSED) })]));

    expect(result.results).toEqual([{ skipped: 'stale-session', bindingId: 10 }]);
    expect(store.service.markOlSessionClosed).not.toHaveBeenCalled();
    expect(store.row.olClosedSessionId).toBeNull();
  });

  it('повтор события → already-marked', async () => {
    const { service, store } = build({ store: openStore({ olClosedSessionId: NEXT }) });

    const result = await service.routeDialogFinish(finishEvent([dialog()]));

    expect(result.results).toEqual([{ skipped: 'already-marked', bindingId: 10 }]);
    expect(store.service.markOlSessionClosed).not.toHaveBeenCalled();
  });

  it('сессия старой привязки неизвестна (ol_session_id NULL) → флаг взводится', async () => {
    const { service, store } = build({ store: openStore({ olSessionId: null }) });

    await service.routeDialogFinish(finishEvent([dialog()]));

    expect(store.row).toMatchObject({ olSessionId: NEXT, olClosedSessionId: NEXT });
  });

  it('closed ≠ Y → not-closed; нет session.id → no-session', async () => {
    const { service, store } = build({ store: openStore() });

    const result = await service.routeDialogFinish(finishEvent([
      dialog({ closed: 'N' }),
      dialog({ sessionId: '' }),
    ]));

    expect(result.results).toEqual([{ skipped: 'not-closed' }, { skipped: 'no-session' }]);
    expect(store.service.markOlSessionClosed).not.toHaveBeenCalled();
  });

  it('гонка: guard SQL не пустил (mark → null) → stale-session', async () => {
    const store = openStore();
    store.service.markOlSessionClosed.mockResolvedValueOnce(null);
    const { service } = build({ store });

    const result = await service.routeDialogFinish(finishEvent([dialog()]));

    expect(result.results).toEqual([{ skipped: 'stale-session', bindingId: 10 }]);
  });

  it('DATA объектом (form-urlencoded) и несколько диалогов → по результату на каждый', async () => {
    const { service } = build({ store: openStore() });

    const result = await service.routeDialogFinish(finishEvent({ 0: dialog(), 1: dialog({ chatId: 'max:other' }) }));

    expect(result.results).toEqual([{ ok: true, bindingId: 10, sessionId: NEXT }, { skipped: 'no-binding' }]);
  });

  it('пустой DATA → no-dialogs; ошибка БД пробрасывается; чужое событие → ValidationError', async () => {
    const store = openStore();
    const { service } = build({ store });

    expect(await service.routeDialogFinish(finishEvent([]))).toEqual({ skipped: 'no-dialogs' });

    store.service.markOlSessionClosed.mockRejectedValueOnce(new Error('db down'));
    await expect(service.routeDialogFinish(finishEvent([dialog()]))).rejects.toThrow('db down');

    await expect(service.routeDialogFinish(finishEvent([dialog()], { event: 'ONIMCONNECTORMESSAGEADD' })))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('Finish → следующее входящее открывает «группа» (сквозной сценарий на фейках)', async () => {
    const { service, b24 } = build({ store: openStore({ olSessionId: CLOSED }), b24: fakeB24({ sessionId: String(NEXT) }) });

    await service.routeDialogFinish(finishEvent([dialog({ sessionId: String(CLOSED) })]));
    await service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));

    expect(sentIds(b24)).toEqual([`max:${openerKey('mid.1')}`, 'max:mid:mid.1', 'max:mid:mid.2']);
  });
});
