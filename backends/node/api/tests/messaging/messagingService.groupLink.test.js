// Unit-тесты M27: ссылка на MAX-группу системным сообщением в чате OL — после интро новой
// группы, после опенера новой сессии (если ссылка перевыпущена или прошлый пост не удался)
// и лениво для старых привязок (раз за процесс: SELECT по префиксу ключа → GET /chats).
// Моки адаптеров; фейк журнала хранит записи в памяти. БД/сеть не нужны.

import { describe, expect, it, vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { ChatBinding } from '../../src/modules/bindings/models/ChatBinding.js';
import { contentHash } from '../../src/shared/crypto/contentHash.js';

const CHAT_ID = -70000000000954;
const MAX_CHAT = '-70000000000954';
const CONNECTOR_CHAT = `max:${MAX_CHAT}`;
const LINK = 'https://max.ru/join/abc';
const LINK2 = 'https://max.ru/join/reissued';
const CLOSED = 16340;
const NEXT = 16342;
const linkKey = (link) => `group-link:${MAX_CHAT}:${contentHash(link)}`;
const linkText = (link) => `Ссылка на группу в MAX: ${link}`;

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

// Строка привязки в памяти; по умолчанию — старая привязка: чат OL известен, сессия открыта.
// newGroup — первого resolve привязки нет, ensureForMaxChat создаёт её без адреса чата OL.
function bindingsStore(order, { newGroup = false, ...overrides } = {}) {
  const row = {
    id: 10,
    installationId: 1,
    maxChatId: MAX_CHAT,
    connectorChatId: CONNECTOR_CHAT,
    maxChatTitle: 'Отдел продаж',
    olChatTitle: 'Отдел продаж',
    b24ChatId: '21180',
    olSessionId: CLOSED,
    olClosedSessionId: null,
    ...(newGroup ? { maxChatTitle: null, olChatTitle: null, b24ChatId: null, olSessionId: null } : {}),
    ...overrides,
  };
  const snapshot = () => new ChatBinding({ ...row });
  const resolveByMaxChat = vi.fn(async () => ({ binding: snapshot(), isReady: true }));
  if (newGroup) resolveByMaxChat.mockResolvedValueOnce({ binding: null, isReady: false });
  const service = {
    resolveByMaxChat,
    ensureForMaxChat: vi.fn(async () => ({ binding: snapshot(), created: true })),
    ensureParticipant: vi.fn(async () => ({ id: 1 })),
    attachB24ChatId: vi.fn(async (id, b24ChatId) => { row.b24ChatId = b24ChatId; return snapshot(); }),
    updateMaxChatTitle: vi.fn(async (id, title) => { row.maxChatTitle = title; return snapshot(); }),
    markOlChatTitle: vi.fn(async (id, title) => { row.olChatTitle = title; return snapshot(); }),
    rememberOlSession: vi.fn(async (id, sid) => {
      if (row.olSessionId !== null && row.olSessionId >= sid
        && !(row.olClosedSessionId !== null && row.olClosedSessionId < sid)) return null;
      row.olSessionId = Math.max(row.olSessionId ?? sid, sid);
      if (row.olClosedSessionId !== null && row.olClosedSessionId < sid) row.olClosedSessionId = null;
      return snapshot();
    }),
    completeSessionOpener: vi.fn(async (id, closedSid, sid) => {
      if (row.olClosedSessionId !== closedSid) return null;
      row.olClosedSessionId = null;
      if (sid !== null) row.olSessionId = Math.max(row.olSessionId ?? sid, sid);
      return snapshot();
    }),
  };
  return { row, service };
}

function fakeB24(order, { sessionId = String(NEXT), b24ChatId = '21180', ...overrides } = {}) {
  return {
    sendConnectorMessage: vi.fn(async (cm) => {
      order.push(`send ${cm.externalMessageId}`);
      return { b24MsgId: cm.externalMessageId, sessionId, b24ChatId, raw: {} };
    }),
    sendSystemMessage: vi.fn(async ({ text }) => {
      order.push(`system ${text}`);
      return { b24MsgId: 777, dialogId: 'chat21180' };
    }),
    setChatName: vi.fn(async () => ({})),
    resolveB24ChatId: vi.fn(async () => null),
    getOlChat: vi.fn(async () => null),
    ...overrides,
  };
}

// Журнал в памяти: findInbound по точному ключу, hasInboundKeyPrefix — по префиксу.
function fakeLog(order, records = new Map()) {
  return {
    records,
    findInbound: vi.fn(async (bindingId, key) => records.get(key) ?? null),
    recordInbound: vi.fn(async ({ maxMid, payloadMeta }) => {
      order.push(`record ${maxMid}`);
      if (records.has(maxMid)) return null;
      const row = { id: records.size + 100, payloadMeta };
      records.set(maxMid, row);
      return row;
    }),
    hasInboundKeyPrefix: vi.fn(async (bindingId, prefix) => {
      order.push(`select ${prefix}`);
      return [...records.keys()].some((k) => k.startsWith(prefix));
    }),
  };
}

function fakeMax(order, info = { title: 'Отдел продаж', iconUrl: null, type: 'chat', link: LINK }) {
  return {
    getChatInfo: vi.fn(async () => {
      order.push('max chat');
      return typeof info === 'function' ? info() : info;
    }),
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

function build({ order = [], store, b24, log, max } = {}) {
  const s = store ?? bindingsStore(order);
  const deps = {
    store: s,
    b24: b24 ?? fakeB24(order),
    log: log ?? fakeLog(order),
    max: max ?? fakeMax(order),
  };
  const logger = silentLogger();
  const service = new MessagingService({
    bindingsService: deps.store.service,
    b24Service: deps.b24,
    maxService: deps.max,
    messageLogRepository: deps.log,
    logger,
  });
  return { service, order, logger, ...deps };
}

const recordedKeys = (log) => log.recordInbound.mock.calls.map((c) => c[0].maxMid);

describe('MessagingService — ссылка на группу в чате OL (M27): интро новой группы', () => {
  it('1) интро → системное сообщение со ссылкой → сообщение автора; GET /chats один раз', async () => {
    const order = [];
    const { service, b24, log, max, logger } = build({ order, store: bindingsStore(order, { newGroup: true }) });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result).toMatchObject({ ok: true, maxMid: 'mid.ABC' });
    expect(order.filter((o) => !o.startsWith('record'))).toEqual([
      'max chat',
      `send max:group-intro:${MAX_CHAT}`,
      `system ${linkText(LINK)}`,
      'send max:mid:mid.ABC',
    ]);
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21180', text: linkText(LINK) });
    expect(max.getChatInfo).toHaveBeenCalledOnce();
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
    expect(recordedKeys(log)).toEqual([`group-intro:${MAX_CHAT}`, linkKey(LINK), 'mid.ABC']);
    expect(log.recordInbound.mock.calls[1][0].payloadMeta).toEqual({ kind: 'group-link', via: 'intro', b24MsgId: 777 });
    // Ссылка — приглашение в закрытую группу: ни в журнал, ни в логи.
    expect(JSON.stringify(log.recordInbound.mock.calls)).not.toContain('max.ru/join');
    const allLogs = JSON.stringify(['info', 'warn', 'debug', 'error'].flatMap((l) => logger[l].mock.calls));
    expect(allLogs).not.toContain('max.ru/join');
    expect(logged(logger.info, 'group link posted to Open Line chat')).toBe(true);
  });

  it('2) у группы нет ссылки → без системного сообщения, GET /chats один раз', async () => {
    const order = [];
    const { service, b24, max } = build({
      order,
      store: bindingsStore(order, { newGroup: true }),
      max: fakeMax(order, { title: 'Отдел продаж', iconUrl: null, type: 'chat', link: null }),
    });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(max.getChatInfo).toHaveBeenCalledOnce();
  });

  it('3) Б24 не вернул адрес чата OL (CHAT_ID) → поста нет, ленивый шаг тоже молчит', async () => {
    const order = [];
    const { service, b24, log } = build({
      order,
      store: bindingsStore(order, { newGroup: true }),
      b24: fakeB24(order, { b24ChatId: null }),
    });

    const result = await service.routeInbound(makeUpdate());

    expect(result.ok).toBe(true);
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
  });

  it('3b) интро без CHAT_ID, адрес принесло сообщение автора → в этом процессе ссылки нет; после рестарта — лениво', async () => {
    const order = [];
    const store = bindingsStore(order, { newGroup: true });
    const b24 = fakeB24(order);
    const realSend = b24.sendConnectorMessage;
    b24.sendConnectorMessage = vi.fn(async (cm) => {
      const sent = await realSend(cm);
      return cm.externalMessageId.startsWith('max:group-intro:') ? { ...sent, b24ChatId: null } : sent;
    });
    const { service, log, max } = build({ order, store, b24 });

    await service.routeInbound(makeUpdate());
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));

    expect(store.row.b24ChatId).toBe('21180');
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    // Шаг ссылки в этом процессе уже был (интро) — ленивый шаг адреса не ждёт.
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
    expect(max.getChatInfo).toHaveBeenCalledOnce();

    const restarted = build({ order, store, log, b24, max });
    await restarted.service.routeInbound(makeUpdate({ mid: 'mid.3' }));
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(log.records.get(linkKey(LINK)).payloadMeta).toEqual({ kind: 'group-link', via: 'lazy', b24MsgId: 777 });
  });

  it('4) два параллельных первых сообщения новой группы → одно интро и одно системное сообщение', async () => {
    let releaseIntro;
    const introGate = new Promise((resolve) => { releaseIntro = resolve; });
    const order = [];
    const store = bindingsStore(order, { newGroup: true });
    // Оба запроса видят привязку без адреса чата OL (как из БД до первого ответа Б24).
    store.service.resolveByMaxChat = vi.fn(async () => ({
      binding: new ChatBinding({ ...store.row, b24ChatId: null }),
      isReady: true,
    }));
    store.service.resolveByMaxChat.mockResolvedValueOnce({ binding: null, isReady: false });
    store.service.ensureForMaxChat = vi.fn()
      .mockResolvedValueOnce({ binding: new ChatBinding({ ...store.row }), created: true })
      .mockResolvedValue({ binding: new ChatBinding({ ...store.row }), created: false });
    const b24 = fakeB24(order);
    const realSend = b24.sendConnectorMessage;
    b24.sendConnectorMessage = vi.fn(async (cm) => {
      if (cm.externalMessageId.startsWith('max:group-intro:')) await introGate;
      return realSend(cm);
    });
    // Запросы к журналу — с задержкой, как у настоящей БД: без неё вся гонка укладывается
    // в микротаски, и порядок постов ничего не проверяет.
    const log = fakeLog(order);
    const dbDelay = () => new Promise((resolve) => { setTimeout(resolve, 2); });
    for (const name of ['findInbound', 'recordInbound']) {
      const inner = log[name];
      log[name] = vi.fn(async (...args) => { await dbDelay(); return inner(...args); });
    }
    const { service } = build({ order, store, b24, log });

    const first = service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    const second = service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    releaseIntro();
    const results = await Promise.all([first, second]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(recordedKeys(log).filter((k) => k.startsWith('group-link:'))).toEqual([linkKey(LINK)]);
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
    // Ссылка встаёт сразу под интро: второй запрос ждёт и интро, и пост ссылки.
    const sends = order.filter((o) => o.startsWith('send') || o.startsWith('system'));
    expect(sends.slice(0, 2)).toEqual([`send max:group-intro:${MAX_CHAT}`, `system ${linkText(LINK)}`]);
    expect(sends.slice(2).sort()).toEqual(['send max:mid:mid.1', 'send max:mid:mid.2']);
  });
});

describe('MessagingService — ссылка на группу (M27): ленивый шаг для старых привязок', () => {
  it('5) записи нет → после доставки и записи: SELECT → GET /chats → системное сообщение; второе сообщение — без шага', async () => {
    const order = [];
    const { service, b24, log, max } = build({ order });

    const result = await service.routeInbound(makeUpdate());

    expect(result).toMatchObject({ ok: true, maxMid: 'mid.ABC' });
    expect(order).toEqual([
      'send max:mid:mid.ABC',
      'record mid.ABC',
      `select group-link:${MAX_CHAT}:`,
      'max chat',
      `system ${linkText(LINK)}`,
      `record ${linkKey(LINK)}`,
    ]);
    expect(log.recordInbound.mock.calls[1][0].payloadMeta).toEqual({ kind: 'group-link', via: 'lazy', b24MsgId: 777 });

    order.length = 0;
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    expect(order).toEqual(['send max:mid:mid.2', 'record mid.2']);
    expect(log.hasInboundKeyPrefix).toHaveBeenCalledOnce();
    expect(max.getChatInfo).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
  });

  it('6) запись уже есть → без GET /chats и поста; «рестарт» — снова один SELECT, поста нет', async () => {
    const order = [];
    const records = new Map([[linkKey(LINK), { id: 1 }]]);
    const store = bindingsStore(order);
    const log = fakeLog(order, records);
    const { service, b24, max } = build({ order, store, log });

    await service.routeInbound(makeUpdate());
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));

    expect(log.hasInboundKeyPrefix).toHaveBeenCalledOnce();
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();

    // Новый процесс на том же журнале.
    const restarted = build({ order, store, log, b24, max });
    await restarted.service.routeInbound(makeUpdate({ mid: 'mid.3' }));
    expect(log.hasInboundKeyPrefix).toHaveBeenCalledTimes(2);
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['GET /chats → null', null],
    ['ссылки нет', { title: 'Отдел продаж', iconUrl: null, type: 'chat', link: null }],
    ['не группа (channel)', { title: 'Канал', iconUrl: null, type: 'channel', link: LINK }],
  ])('7) %s → поста нет; в этом процессе шаг не повторяется', async (_label, info) => {
    const order = [];
    const { service, b24, log, max } = build({ order, max: fakeMax(order, info) });

    await service.routeInbound(makeUpdate());
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));

    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.hasInboundKeyPrefix).toHaveBeenCalledOnce();
    expect(max.getChatInfo).toHaveBeenCalledOnce();
  });

  it('8) im.message.add упал → доставка ok, записи group-link: нет, WARN; повтор — на следующем опенере', async () => {
    const order = [];
    const store = bindingsStore(order);
    const b24 = fakeB24(order, {
      sendSystemMessage: vi.fn(async () => { throw Object.assign(new Error('B24 down'), { b24Code: 'INTERNAL' }); }),
    });
    const { service, log, logger } = build({ order, store, b24 });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result).toMatchObject({ ok: true, maxMid: 'mid.ABC' });
    expect(recordedKeys(log)).toEqual(['mid.ABC']);
    expect(logged(logger.warn, 'group link post failed (best-effort)')).toBe(true);

    // Сессия закрылась; следующее входящее — опенер, и он постит ссылку.
    store.row.olClosedSessionId = CLOSED;
    b24.sendSystemMessage = vi.fn(async ({ text }) => {
      order.push(`system ${text}`);
      return { b24MsgId: 778 };
    });
    await service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(log.records.get(linkKey(LINK)).payloadMeta).toEqual({ kind: 'group-link', via: 'opener', b24MsgId: 778 });
  });

  it('9) SELECT по префиксу упал → доставка ok, WARN, без GET /chats', async () => {
    const order = [];
    const log = fakeLog(order);
    log.hasInboundKeyPrefix = vi.fn(async () => { throw new Error('db down'); });
    const { service, max, b24, logger } = build({ order, log });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(max.getChatInfo).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(logged(logger.warn, 'group link check failed (best-effort)')).toBe(true);
  });

  it('10) дубль mid → ленивого шага нет', async () => {
    const order = [];
    const log = fakeLog(order, new Map([['mid.ABC', { id: 7 }]]));
    const { service, max } = build({ order, log });

    const result = await service.routeInbound(makeUpdate());

    expect(result.skipped).toBe('duplicate');
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
    expect(max.getChatInfo).not.toHaveBeenCalled();
  });
});

describe('MessagingService — ссылка на группу (M27): опенер новой сессии', () => {
  it('12) ссылка та же (ключ есть) → без системного сообщения и без WARN', async () => {
    const order = [];
    const log = fakeLog(order, new Map([[linkKey(LINK), { id: 1 }]]));
    const { service, b24, logger } = build({ order, store: bindingsStore(order, { olClosedSessionId: CLOSED }), log });

    const result = await service.routeInbound(makeUpdate(), { logger });

    expect(result.ok).toBe(true);
    expect(order.filter((o) => o.startsWith('send'))).toEqual([
      `send max:group-session:${MAX_CHAT}:${CLOSED}:mid.ABC`,
      'send max:mid:mid.ABC',
    ]);
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logged(logger.debug, 'routeInbound: link-posted, skipping')).toBe(true);
    // Опенер уже сделал GET /chats — ленивый шаг в этом процессе не нужен.
    expect(log.hasInboundKeyPrefix).not.toHaveBeenCalled();
  });

  it('13) MAX перевыпустил ссылку → опенер → системное с новой ссылкой → сообщение автора', async () => {
    const order = [];
    const log = fakeLog(order, new Map([[linkKey(LINK), { id: 1 }]]));
    const { service, b24 } = build({
      order,
      store: bindingsStore(order, { olClosedSessionId: CLOSED }),
      log,
      max: fakeMax(order, { title: 'Отдел продаж', iconUrl: null, type: 'chat', link: LINK2 }),
    });

    await service.routeInbound(makeUpdate());

    expect(order.filter((o) => o.startsWith('send') || o.startsWith('system'))).toEqual([
      `send max:group-session:${MAX_CHAT}:${CLOSED}:mid.ABC`,
      `system ${linkText(LINK2)}`,
      'send max:mid:mid.ABC',
    ]);
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21180', text: linkText(LINK2) });
    expect(log.records.get(linkKey(LINK2)).payloadMeta).toEqual({ kind: 'group-link', via: 'opener', b24MsgId: 777 });
  });

  it('13b) два параллельных сообщения после закрытия, ссылка перевыпущена → опенер → ссылка → оба сообщения', async () => {
    let releaseOpener;
    const openerGate = new Promise((resolve) => { releaseOpener = resolve; });
    const order = [];
    const store = bindingsStore(order, { olClosedSessionId: CLOSED });
    const b24 = fakeB24(order);
    const realSend = b24.sendConnectorMessage;
    b24.sendConnectorMessage = vi.fn(async (cm) => {
      if (cm.externalMessageId.startsWith('max:group-session:')) await openerGate;
      return realSend(cm);
    });
    // Журнал и привязки — с задержкой, как у настоящей БД (см. тест 4).
    const dbDelay = () => new Promise((resolve) => { setTimeout(resolve, 2); });
    const log = fakeLog(order, new Map([[linkKey(LINK), { id: 1 }]]));
    for (const name of ['findInbound', 'recordInbound']) {
      const inner = log[name];
      log[name] = vi.fn(async (...args) => { await dbDelay(); return inner(...args); });
    }
    const innerResolve = store.service.resolveByMaxChat;
    store.service.resolveByMaxChat = vi.fn(async (...args) => { await dbDelay(); return innerResolve(...args); });
    const { service } = build({
      order,
      store,
      b24,
      log,
      max: fakeMax(order, { title: 'Отдел продаж', iconUrl: null, type: 'chat', link: LINK2 }),
    });

    const first = service.routeInbound(makeUpdate({ mid: 'mid.1' }));
    const second = service.routeInbound(makeUpdate({ mid: 'mid.2' }));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    releaseOpener();
    const results = await Promise.all([first, second]);

    expect(results.every((r) => r.ok)).toBe(true);
    const sends = order.filter((o) => o.startsWith('send') || o.startsWith('system'));
    expect(sends.length).toBe(4);
    expect(sends[0]).toMatch(new RegExp(`^send max:group-session:${MAX_CHAT}:${CLOSED}:mid\\.[12]$`));
    expect(sends[1]).toBe(`system ${linkText(LINK2)}`);
    expect(sends.slice(2).sort()).toEqual(['send max:mid:mid.1', 'send max:mid:mid.2']);
  });

  it('14) опенер без ссылки (GET /chats упал, имя из привязки) → без системного сообщения', async () => {
    const order = [];
    const { service, b24 } = build({
      order,
      store: bindingsStore(order, { olClosedSessionId: CLOSED }),
      max: fakeMax(order, null),
    });

    await service.routeInbound(makeUpdate());

    expect(order.filter((o) => o.startsWith('send')).length).toBe(2);
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });
});
