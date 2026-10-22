// M29: фейки для unit-тестов очереди исходящих по чату и восстановления прерванных
// (messagingService.queue.test.js, messagingService.recovery.test.js). Журнал — в памяти,
// с claim/release строк заданий и уникальностью ключа, как у message_log; MAX пишет порядок
// вызовов и умеет «висеть» на заливке (gate), чтобы ловить события, пришедшие во время неё.

import { vi } from 'vitest';

import { MessagingService } from '../../src/modules/messaging/messagingService.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';

// Логгер: child возвращает тот же объект — проверки логов смотрят в одно место.
export function spyLogger() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  log.child = () => log;
  return log;
}

// Был ли вызов уровня с сообщением, содержащим msgPart; → поля первого такого вызова.
export function loggedFields(fnMock, msgPart) {
  const call = fnMock.mock.calls.find((c) => String(c[1] ?? '').includes(msgPart));
  return call ? call[0] : null;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Дать отработать всему, что уже может отработать (микрозадачи и таймеры 0 мс).
export function settle(ms = 5) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const CHAT_A = 'max:-100';
export const CHAT_B = 'max:-200';

export const BINDINGS = Object.freeze({
  [CHAT_A]: Object.freeze({ id: 1, connectorChatId: CHAT_A, maxChatId: '-100', b24ChatId: '21001' }),
  [CHAT_B]: Object.freeze({ id: 2, connectorChatId: CHAT_B, maxChatId: '-200', b24ChatId: '21002' }),
});

export const INSTALLATION = Object.freeze({ id: 1, portal: 'example.bitrix24.ru', connectorId: 'max_b24', olLineId: 42 });

export function fakeBindings() {
  return {
    resolveByConnectorChat: vi.fn(async (connectorChatId) => {
      const b = BINDINGS[connectorChatId];
      if (!b) return { binding: null, isReady: false, installation: INSTALLATION };
      return { binding: { ...b, isReadyForRouting: () => true }, isReady: true, installation: INSTALLATION };
    }),
  };
}

// Журнал в памяти: ключ строки — (bindingId, b24_msg_id), как у уникального индекса
// message_log_outbound_dedup_idx; claim и record делят одно пространство ключей.
export function memoryLog() {
  const rows = new Map();
  let nextId = 1;
  const keyOf = (bindingId, key) => `${bindingId}|${key}`;
  const insert = ({ bindingId, b24MsgId, payloadMeta, status, createdAt }) => {
    const k = keyOf(bindingId, b24MsgId);
    if (rows.has(k)) return null;
    const entry = {
      id: nextId,
      bindingId,
      direction: 'outbound',
      b24MsgId: String(b24MsgId),
      status,
      payloadMeta: payloadMeta ?? null,
      createdAt: createdAt ?? new Date(),
    };
    nextId += 1;
    rows.set(k, entry);
    return entry;
  };
  const log = {
    rows,
    findOutbound: vi.fn(async (bindingId, key) => rows.get(keyOf(bindingId, key)) ?? null),
    recordOutbound: vi.fn(async ({ bindingId, b24MsgId, payloadMeta = null }) => (
      insert({ bindingId, b24MsgId, payloadMeta, status: 'received' })
    )),
    claimOutboundJob: vi.fn(async ({ bindingId, jobKey, payloadMeta = null }) => (
      insert({ bindingId, b24MsgId: jobKey, payloadMeta, status: 'in_progress' })
    )),
    releaseOutboundJob: vi.fn(async (id) => {
      for (const [k, e] of rows) {
        if (e.id === id && e.status === 'in_progress') {
          rows.delete(k);
          return 1;
        }
      }
      return 0;
    }),
    findOutboundJobs: vi.fn(async ({ createdBefore, limit = 500 }) => [...rows.values()]
      .filter((e) => e.status === 'in_progress' && e.createdAt < createdBefore)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)),
    // Тестовые ручки: строка «как от прошлого процесса» и выборки.
    seed: (entry) => insert({ status: 'received', ...entry }),
    keys: () => [...rows.values()].map((e) => e.b24MsgId),
    jobs: () => [...rows.values()].filter((e) => e.status === 'in_progress'),
    get: (bindingId, key) => rows.get(keyOf(bindingId, key)) ?? null,
  };
  return log;
}

// MAX: порядок вызовов в order. uploadGates[i] — промис, на котором висит i-я заливка
// (по порядку вызова); stats.maxActiveUploads — сколько заливок шло одновременно.
export function fakeMax({ uploadGates = [] } = {}) {
  const order = [];
  const stats = { maxActiveUploads: 0 };
  let uploads = 0;
  let sends = 0;
  let active = 0;
  const max = {
    order,
    stats,
    uploadAndSend: vi.fn(async ({ file }) => {
      const i = uploads;
      uploads += 1;
      active += 1;
      stats.maxActiveUploads = Math.max(stats.maxActiveUploads, active);
      order.push(`upload-start:${file.filename}`);
      try {
        if (uploadGates[i]) await uploadGates[i];
      } finally {
        active -= 1;
      }
      order.push(`upload:${file.filename}`);
      return { maxMid: `mid.file-${i + 1}`, timestampMs: 1748432100000 };
    }),
    sendOutgoingMessage: vi.fn(async (msg) => {
      sends += 1;
      order.push(`send:${msg.text}`);
      return { maxMid: `mid.text-${sends}`, timestampMs: 1748432100000 };
    }),
    editOutgoing: vi.fn(async ({ messageId, text }) => {
      order.push(`edit:${messageId}:${text}`);
      return { timestampMs: 1748432200000 };
    }),
    deleteOutgoing: vi.fn(async ({ messageId }) => {
      order.push(`delete:${messageId}`);
      return { deleted: true, maxMessage: null };
    }),
  };
  return max;
}

export function fakeB24() {
  return {
    sendDeliveryStatus: vi.fn(async () => ({ SUCCESS: true, DATA: [], time: {} })),
    downloadOperatorFile: vi.fn(async () => ({ contentType: 'image/jpeg', size: 8 })),
    sendSystemMessage: vi.fn(async () => ({ b24MsgId: 777, dialogId: 'chat21001' })),
    resolveReplyContext: vi.fn(async () => null),
  };
}

// Временные файлы без диска: пути по счётчику.
export function fakeTemp() {
  let n = 0;
  return {
    allocate: vi.fn(async () => {
      n += 1;
      return `/tmp/m29/${n}.part`;
    }),
    remove: vi.fn(async () => {}),
  };
}

export function buildService({ bindings, max, b24, log, queue, logger, mediaConcurrency } = {}) {
  return new MessagingService({
    bindingsService: bindings ?? fakeBindings(),
    maxService: max ?? fakeMax(),
    b24Service: b24 ?? fakeB24(),
    messageLogRepository: log ?? memoryLog(),
    logger: logger ?? spyLogger(),
    mediaTempFiles: fakeTemp(),
    mediaConcurrency,
    ...(queue ? { outboundQueue: queue } : {}),
  });
}

export function opFile(name, extra = {}) {
  return {
    name,
    mime: 'image/jpeg',
    type: 'image',
    downloadLink: `https://example.bitrix24.ru/pub/im.file.php?FILE_ID=${encodeURIComponent(name)}&SIGN=x`,
    size: 8,
    ...extra,
  };
}

function messageEvent(event, messages) {
  return new OpenLineEvent({ event, data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: messages } });
}

function olMessage(id, chat, message) {
  return {
    im: { chat_id: BINDINGS[chat]?.b24ChatId ?? '29999', message_id: String(id) },
    message: { user_id: '1', ...message },
    chat: { id: chat },
  };
}

// Отправка оператора: одно сообщение (или несколько — messages: [{ id, chat, text, files }]).
export function addEvent(id, { chat = CHAT_A, text = `[b]Оператор:[/b] [br]текст ${id}`, files, messages } = {}) {
  const list = messages ?? [{ id, chat, text, files }];
  return messageEvent(
    'ONIMCONNECTORMESSAGEADD',
    list.map((m) => olMessage(m.id, m.chat ?? CHAT_A, { text: m.text ?? `[b]Оператор:[/b] [br]текст ${m.id}`, ...(m.files ? { files: m.files } : {}) })),
  );
}

export function editEvent(id, { chat = CHAT_A, text = '[b]Оператор:[/b] [br]исправлено', externalIds = [] } = {}) {
  return messageEvent('ONIMCONNECTORMESSAGEUPDATE', [olMessage(id, chat, { id: externalIds, text })]);
}

// Удаление: message.id приходит строкой (live M15) либо отсутствует.
export function deleteEvent(id, { chat = CHAT_A, externalId = null } = {}) {
  return messageEvent('ONIMCONNECTORMESSAGEDELETE', [olMessage(id, chat, externalId ? { id: externalId } : {})]);
}
