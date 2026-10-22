// M29: unit-тесты MessagingService.recoverInterruptedOutbound — разбор передач, прерванных
// прошлым процессом (строки job: со status 'in_progress' в журнале). Очередь — настоящий
// KeyedQueue сервиса, журнал — в памяти, оповещение оператора — через фейк
// b24.sendSystemMessage (notifyOperator).

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addEvent,
  BINDINGS,
  buildService,
  CHAT_A,
  CHAT_B,
  deferred,
  deleteEvent,
  fakeB24,
  fakeBindings,
  fakeMax,
  loggedFields,
  memoryLog,
  settle,
  spyLogger,
} from '../helpers/outboundFakes.js';

// Отметка старта процесса и время строк прошлого процесса.
const BOOT = new Date('2026-10-08T12:00:00Z');
const PAST = new Date('2026-10-08T11:59:00Z');
const AFTER_BOOT = new Date('2026-10-08T12:00:05Z');
// Когда ушла часть прерванного сообщения (запись file:<id>:<n> прошлого процесса).
const PART_AT = new Date('2026-10-08T11:59:30Z');

const TEXT_RESTART = '⚠️ Не доставлено в MAX: текст сообщения — мост перезапускался. Отправьте ещё раз.';
const EDIT_RESTART = '⚠️ Правка не доставлена в MAX: мост перезапускался. '
  + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.';

function setup() {
  const bindings = fakeBindings();
  const max = fakeMax();
  const b24 = fakeB24();
  const log = memoryLog();
  const logger = spyLogger();
  const service = buildService({ bindings, max, b24, log, logger });
  const recover = (opts = {}) => service.recoverInterruptedOutbound({ createdBefore: BOOT, logger, ...opts });
  return { service, bindings, max, b24, log, logger, recover };
}

// Строка задания «от прошлого процесса» (как пишет claim шага очереди).
function seedJob(log, { chat = CHAT_A, op = 'add', b24MsgId, createdAt = PAST, ...content }) {
  const binding = BINDINGS[chat] ?? { id: 99, b24ChatId: '29999' };
  let opKey = String(b24MsgId);
  if (op === 'delete') opKey = `delete:${b24MsgId}`;
  if (op === 'edit') opKey = `edit:${b24MsgId}:0123456789abcdef`;
  return log.seed({
    bindingId: binding.id,
    b24MsgId: `job:${opKey}`,
    status: 'in_progress',
    createdAt,
    payloadMeta: {
      kind: 'job', op, opKey, connectorChatId: chat, b24ChatId: binding.b24ChatId, b24MsgId: String(b24MsgId), ...content,
    },
  });
}

function addJob(log, b24MsgId, { chat, hasText = false, fileNames = [], textPrefix = '', createdAt } = {}) {
  return seedJob(log, {
    chat, b24MsgId, createdAt, textPrefix, hasText, filesCount: fileNames.length, fileNames,
  });
}

// Ушедший файл: запись file:<b24MsgId>:<idx> (пишет _sendOutboundFile); createdAt — когда
// файл ушёл в MAX (по умолчанию — сейчас).
function seedPart(log, b24MsgId, idx, maxMid, { chat = CHAT_A, withCaption = false, type = 'image', createdAt } = {}) {
  return log.seed({
    bindingId: BINDINGS[chat].id,
    b24MsgId: `file:${b24MsgId}:${idx}`,
    createdAt,
    payloadMeta: { kind: 'file', origB24MsgId: String(b24MsgId), idx, maxMid, type, withCaption },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MessagingService.recoverInterruptedOutbound — отправка', () => {
  it('прерванный текст → оповещение «текст сообщения — мост перезапускался» без ответа на сообщение, строка снята', async () => {
    const { recover, log, b24, max, logger } = setup();
    addJob(log, '901', { hasText: true, textPrefix: 'привет' });

    const res = await recover();

    expect(res).toEqual({ total: 1, notified: 1, completed: 0, dropped: 0, failedNotify: 0, failed: 0 });
    // ровно { b24ChatId, text }: ни REPLY_ID, ни installation
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: TEXT_RESTART });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
    expect(log.get(1, '901')).toBeNull();
    expect(loggedFields(logger.info, 'interrupted outbound jobs found')).toEqual({ count: 1 });
    expect(loggedFields(logger.info, 'interrupted outbound recovered')).toMatchObject({ total: 1, notified: 1 });
  });

  it('3 файла, ушёл первый → итоговая запись с maxMids, статус доставки, оповещение по двум именам', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '902', { fileNames: ['a.jpg', 'Договор.pdf', 'c.jpg'] });
    seedPart(log, '902', 0, 'mid.m0', { createdAt: PART_AT });

    const res = await recover();

    expect(res).toMatchObject({ total: 1, notified: 1 });
    expect(log.get(1, '902').payloadMeta).toEqual({
      maxMid: 'mid.m0',
      maxMids: ['mid.m0'],
      textPrefix: '',
      filesCount: 1,
      kinds: ['image'],
      failedCount: 2,
      interrupted: true,
      sentAt: PART_AT.toISOString(),
    });
    expect(b24.sendDeliveryStatus).toHaveBeenCalledWith(expect.objectContaining({
      b24ChatId: '21001', b24MsgId: '902', externalIds: ['mid.m0'], connectorChatId: CHAT_A,
    }));
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21001',
      text: '⚠️ Не доставлено в MAX: файл «Договор.pdf» — мост перезапускался; файл «c.jpg» — мост перезапускался. Отправьте ещё раз.',
    });
    expect(log.jobs()).toEqual([]);
  });

  it('подпись ушла с первым файлом (withCaption) → пункта «текст» нет', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '903', { hasText: true, textPrefix: 'подпись', fileNames: ['a.jpg', 'b.jpg'] });
    seedPart(log, '903', 0, 'mid.m0', { withCaption: true });

    await recover();

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21001',
      text: '⚠️ Не доставлено в MAX: файл «b.jpg» — мост перезапускался. Отправьте ещё раз.',
    });
    expect(log.get(1, '903').payloadMeta).toMatchObject({ textPrefix: 'подпись', failedCount: 1 });
  });

  it('файлы с подписью, не ушло ничего → файлы и текст в оповещении, записи нет; безымянный — «файл n»', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '904', { hasText: true, fileNames: ['a.jpg', null] });

    await recover();

    expect(b24.sendSystemMessage).toHaveBeenCalledWith({
      b24ChatId: '21001',
      text: '⚠️ Не доставлено в MAX: файл «a.jpg» — мост перезапускался; файл «файл 2» — мост перезапускался; '
        + 'текст сообщения — мост перезапускался. Отправьте ещё раз.',
    });
    expect(log.get(1, '904')).toBeNull();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
  });

  it('все файлы ушли (упал до итоговой записи) → запись и статус, без оповещения', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '905', { fileNames: ['a.jpg', 'b.jpg'] });
    seedPart(log, '905', 0, 'mid.m0');
    seedPart(log, '905', 1, 'mid.m1', { type: 'file' });

    const res = await recover();

    expect(res).toMatchObject({ completed: 1, notified: 0 });
    expect(log.get(1, '905').payloadMeta).toMatchObject({ maxMids: ['mid.m0', 'mid.m1'], kinds: ['image', 'file'], filesCount: 2 });
    expect(log.get(1, '905').payloadMeta).not.toHaveProperty('failedCount');
    expect(b24.sendDeliveryStatus).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('итоговая запись хранит время ушедших частей: «MAX не разрешил удалить» после простоя считает возраст от отправки, а не от разбора', async () => {
    const { recover, service, log, max, b24 } = setup();
    const HOUR = 3_600_000;
    addJob(log, '909', { fileNames: ['a.jpg', 'b.jpg', 'c.jpg'] });
    // файлы ушли за 30 и 29 ч до разбора (мост лежал), третий не ушёл
    seedPart(log, '909', 0, 'mid.m0', { createdAt: new Date(Date.now() - 30 * HOUR) });
    seedPart(log, '909', 1, 'mid.m1', { createdAt: new Date(Date.now() - 29 * HOUR) });

    await recover();

    const record = log.get(1, '909');
    expect(record.payloadMeta.sentAt).toBe(log.get(1, 'file:909:0').createdAt.toISOString());
    expect(Date.now() - record.createdAt.getTime()).toBeLessThan(HOUR);

    // оператор удаляет сообщение в ОЛ, MAX отказывает по всем id (max-window)
    b24.sendSystemMessage.mockClear();
    max.deleteOutgoing.mockResolvedValue({ deleted: false, maxMessage: null });
    const removed = await service.routeOutboundQueued('delete', deleteEvent('909'));

    expect(removed).toMatchObject({ results: [{ skipped: 'max-window' }] });
    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.m0', 'mid.m1']);
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage.mock.calls[0][0]).toEqual({
      b24ChatId: '21001',
      text: '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его (отправлено 30 ч назад). '
        + 'У клиентов в MAX оно осталось.',
    });
  });

  it('операция уже записана (упал между записью и снятием строки) → без оповещения, строка снята', async () => {
    const { recover, log, b24, logger } = setup();
    addJob(log, '906', { hasText: true });
    log.seed({ bindingId: 1, b24MsgId: '906', payloadMeta: { maxMid: 'mid.T' } });

    const res = await recover();

    expect(res).toMatchObject({ completed: 1 });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
    expect(loggedFields(logger.info, 'interrupted outbound job: already done')).toMatchObject({ b24MsgId: '906' });
  });

  it('привязки нет → dropped, строка снята', async () => {
    const { recover, log, b24 } = setup();
    seedJob(log, { chat: 'max:-999', b24MsgId: '907', hasText: true, filesCount: 0, fileNames: [] });

    const res = await recover();

    expect(res).toMatchObject({ total: 1, dropped: 1 });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
  });

  it('задание без текста и файлов → без оповещения', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '908');

    const res = await recover();

    expect(res).toMatchObject({ completed: 1 });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
  });
});

describe('MessagingService.recoverInterruptedOutbound — удаление и правка', () => {
  it('прерванное удаление → повтор: deleteOutgoing по maxMids из журнала, без оповещения о рестарте', async () => {
    const { recover, log, max, b24 } = setup();
    log.seed({ bindingId: 1, b24MsgId: '911', payloadMeta: { maxMid: 'mid.a', maxMids: ['mid.a', 'mid.b'] } });
    seedJob(log, { op: 'delete', b24MsgId: '911' });

    const res = await recover();

    expect(res).toMatchObject({ total: 1, completed: 1 });
    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.a', 'mid.b']);
    expect(log.get(1, 'delete:911')).not.toBeNull();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
  });

  it('прерванное удаление сообщения без записи в журнале → повтор по id MAX из события (externalIds строки)', async () => {
    const { recover, log, max, b24, logger } = setup();
    seedJob(log, { op: 'delete', b24MsgId: '915', externalIds: ['mid.ev'] });

    const res = await recover();

    expect(res).toMatchObject({ total: 1, completed: 1 });
    expect(max.deleteOutgoing).toHaveBeenCalledWith({ messageId: 'mid.ev' });
    expect(log.get(1, 'delete:915')).not.toBeNull();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(loggedFields(logger.warn, 'routeOutboundDelete: no-maxmid (cannot locate MAX message)')).toBeNull();
    expect(log.jobs()).toEqual([]);
  });

  it('прерваны отправка (ушёл файл 0) и удаление того же сообщения → запись, удаление m0; ни оповещений, ни статуса', async () => {
    const { recover, log, max, b24 } = setup();
    addJob(log, '912', { hasText: true, fileNames: ['a.jpg', 'b.jpg'] });
    seedPart(log, '912', 0, 'mid.m0', { withCaption: true });
    seedJob(log, { op: 'delete', b24MsgId: '912' });

    const res = await recover();

    expect(res).toMatchObject({ total: 2, completed: 2, notified: 0 });
    expect(log.get(1, '912').payloadMeta).toMatchObject({ maxMids: ['mid.m0'], interrupted: true });
    expect(max.deleteOutgoing).toHaveBeenCalledWith({ messageId: 'mid.m0' });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(b24.sendDeliveryStatus).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
  });

  it('прерванная правка → оповещение о сбое правки с причиной «мост перезапускался»', async () => {
    const { recover, log, max, b24 } = setup();
    seedJob(log, { op: 'edit', b24MsgId: '913' });

    const res = await recover();

    expect(res).toMatchObject({ notified: 1 });
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: EDIT_RESTART });
    expect(max.editOutgoing).not.toHaveBeenCalled();
    expect(log.jobs()).toEqual([]);
  });

  it('прерваны правка и удаление того же сообщения → без оповещения о правке', async () => {
    const { recover, log, b24, max } = setup();
    log.seed({ bindingId: 1, b24MsgId: '914', payloadMeta: { maxMid: 'mid.e' } });
    seedJob(log, { op: 'edit', b24MsgId: '914' });
    seedJob(log, { op: 'delete', b24MsgId: '914' });

    await recover();

    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(max.deleteOutgoing).toHaveBeenCalledWith({ messageId: 'mid.e' });
    expect(log.jobs()).toEqual([]);
  });
});

describe('MessagingService.recoverInterruptedOutbound — повторы и сбои', () => {
  it('оповещение не ушло дважды, ушло на третий раз (паузы 2 и 5 с) → notified', async () => {
    vi.useFakeTimers();
    const { recover, log, b24 } = setup();
    addJob(log, '921', { hasText: true });
    b24.sendSystemMessage
      .mockRejectedValueOnce(new Error('b24 down'))
      .mockRejectedValueOnce(new Error('b24 down'));

    const p = recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;

    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ notified: 1, failedNotify: 0 });
    expect(log.jobs()).toEqual([]);
  });

  it('три неудачи оповещения → ERROR «giving up», строка всё равно снята, повторов на старте нет', async () => {
    vi.useFakeTimers();
    const { recover, log, b24, logger } = setup();
    addJob(log, '922', { hasText: true });
    b24.sendSystemMessage.mockRejectedValue(new Error('b24 down'));

    const p = recover();
    await vi.advanceTimersByTimeAsync(7_000);
    const res = await p;

    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ failedNotify: 1, notified: 0 });
    expect(loggedFields(logger.error, 'recovery notice failed, giving up')).toMatchObject({
      op: 'send', bindingId: 1, b24MsgId: '922', reason: 'send-failed',
    });
    expect(log.jobs()).toEqual([]);
  });

  it('ошибка одного задания не мешает следующему; строка упавшего тоже снята', async () => {
    const { recover, log, b24, bindings, logger } = setup();
    addJob(log, '923', { chat: CHAT_B, hasText: true });
    addJob(log, '924', { hasText: true });
    const real = bindings.resolveByConnectorChat.getMockImplementation();
    bindings.resolveByConnectorChat.mockImplementation(async (cid) => {
      if (cid === CHAT_B) throw new Error('db hiccup');
      return real(cid);
    });

    const res = await recover();

    expect(res).toMatchObject({ total: 2, failed: 1, notified: 1 });
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: TEXT_RESTART });
    expect(log.jobs()).toEqual([]);
    expect(loggedFields(logger.warn, 'interrupted outbound job recovery failed')).toMatchObject({ b24MsgId: '923' });
  });

  it('поиск строк упал дважды, на третий ответил (пауза retryMs) → задания разобраны', async () => {
    vi.useFakeTimers();
    const { recover, log, b24, logger } = setup();
    addJob(log, '925', { hasText: true });
    log.findOutboundJobs
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const p = recover({ attempts: 5, retryMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(log.findOutboundJobs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    const res = await p;

    expect(log.findOutboundJobs).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ total: 1, notified: 1 });
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls.filter((c) => c[1] === 'interrupted outbound lookup failed, retrying')).toHaveLength(2);
  });

  it('поиск падал attempts раз → ERROR, без throw, строки не тронуты', async () => {
    vi.useFakeTimers();
    const { recover, log, logger } = setup();
    addJob(log, '926', { hasText: true });
    log.findOutboundJobs.mockRejectedValue(new Error('ECONNREFUSED'));

    const p = recover({ attempts: 3, retryMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;

    expect(log.findOutboundJobs).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ total: 0 });
    expect(loggedFields(logger.error, 'interrupted outbound lookup gave up')).toMatchObject({ attempts: 3 });
    expect(log.jobs()).toHaveLength(1);
  });

  it('signal прерван после первого задания → второе не разобрано, его строка цела, INFO stopped by shutdown', async () => {
    const { recover, log, b24, logger } = setup();
    addJob(log, '927', { hasText: true });
    addJob(log, '928', { hasText: true });
    const ctrl = new AbortController();
    b24.sendSystemMessage.mockImplementationOnce(async () => {
      ctrl.abort();
      return { b24MsgId: 777 };
    });

    const res = await recover({ signal: ctrl.signal });

    expect(res).toMatchObject({ stopped: true, left: 1, notified: 1 });
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(log.jobs().map((j) => j.payloadMeta.b24MsgId)).toEqual(['928']);
    expect(loggedFields(logger.info, 'interrupted outbound recovery stopped by shutdown')).toEqual({ left: 1 });
  });

  it('signal прерван во время паузы между попытками поиска → выход без ожидания паузы', async () => {
    const { recover, log } = setup();
    const ctrl = new AbortController();
    log.findOutboundJobs.mockImplementationOnce(async () => {
      setTimeout(() => ctrl.abort(), 5);
      throw new Error('ECONNREFUSED');
    });

    const res = await recover({ signal: ctrl.signal, retryMs: 60_000 });

    expect(res).toMatchObject({ stopped: true });
    expect(log.findOutboundJobs).toHaveBeenCalledOnce();
  });

  it('строки, созданные после старта процесса, не разбираются; без createdBefore — ERROR без поиска', async () => {
    const { recover, service, log, b24, logger } = setup();
    addJob(log, '929', { hasText: true, createdAt: AFTER_BOOT });

    await expect(recover()).resolves.toMatchObject({ total: 0 });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
    expect(log.jobs()).toHaveLength(1);

    await expect(service.recoverInterruptedOutbound({ logger })).resolves.toMatchObject({ total: 0 });
    expect(log.findOutboundJobs).toHaveBeenCalledOnce();
    expect(loggedFields(logger.error, 'createdBefore (Date) required')).not.toBeNull();
  });

  it('повторный разбор (строки сняты) → без оповещений', async () => {
    const { recover, log, b24 } = setup();
    addJob(log, '930', { hasText: true });

    await recover();
    await recover();

    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
  });
});

describe('MessagingService.recoverInterruptedOutbound — через очередь чата', () => {
  it('новое событие того же чата, пришедшее во время разбора, выполняется после задания разбора', async () => {
    const { recover, service, log, b24, max } = setup();
    addJob(log, '941', { hasText: true });
    const gate = deferred();
    b24.sendSystemMessage.mockImplementationOnce(async () => {
      await gate.promise;
      return { b24MsgId: 777 };
    });

    const rec = recover();
    await vi.waitFor(() => expect(b24.sendSystemMessage).toHaveBeenCalledOnce());
    const fresh = service.routeOutboundQueued('add', addEvent('942', { text: 'новое' }));
    await settle();
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(service.outboundQueue.pendingFor(CHAT_A)).toBe(2);

    gate.resolve();
    await rec;
    await expect(fresh).resolves.toMatchObject({ ok: true, results: [{ ok: true, b24MsgId: '942' }] });
    expect(b24.sendSystemMessage.mock.invocationCallOrder[0])
      .toBeLessThan(max.sendOutgoingMessage.mock.invocationCallOrder[0]);
  });

  it('очереди всех затронутых чатов заняты сразу: удаление в чате B, пока висит разбор чата A, ждёт разбора B и находит ушедшую часть', async () => {
    const { recover, service, log, b24, max, logger } = setup();
    addJob(log, '951', { hasText: true });
    addJob(log, '952', { chat: CHAT_B, fileNames: ['a.jpg', 'b.jpg'] });
    seedPart(log, '952', 0, 'mid.b0', { chat: CHAT_B });
    // оповещение в чат A висит (Б24 медленный), в чат B — сразу
    const gate = deferred();
    b24.sendSystemMessage.mockImplementation(async ({ b24ChatId }) => {
      if (b24ChatId === BINDINGS[CHAT_A].b24ChatId) await gate.promise;
      return { b24MsgId: 777 };
    });

    const rec = recover();
    await vi.waitFor(() => expect(b24.sendSystemMessage).toHaveBeenCalledTimes(2));
    expect(service.outboundQueue.pendingFor(CHAT_A)).toBe(1);

    // оператор удаляет в ОЛ частично ушедшее сообщение чата B
    const removed = await service.routeOutboundQueued('delete', deleteEvent('952', { chat: CHAT_B }));

    expect(removed).toMatchObject({ ok: true, results: [{ ok: true, maxMid: 'mid.b0' }] });
    expect(max.deleteOutgoing).toHaveBeenCalledWith({ messageId: 'mid.b0' });
    expect(loggedFields(logger.warn, 'no-maxmid')).toBeNull();

    gate.resolve();
    await expect(rec).resolves.toMatchObject({ total: 2, notified: 2 });
    expect(log.jobs()).toEqual([]);
  });

  it('задания одного чата разбираются по порядку id одним заданием очереди (лимит чата не забивается)', async () => {
    const { recover, service, log, b24 } = setup();
    addJob(log, '961', { hasText: true });
    addJob(log, '962', { hasText: true });
    addJob(log, '963', { chat: CHAT_B, hasText: true });
    const push = vi.spyOn(service.outboundQueue, 'push');

    await recover();

    expect(push.mock.calls.map((c) => c[0])).toEqual([CHAT_A, CHAT_B]);
    const chatA = b24.sendSystemMessage.mock.calls.filter((c) => c[0].b24ChatId === '21001');
    expect(chatA).toHaveLength(2);
    expect(b24.sendSystemMessage).toHaveBeenCalledTimes(3);
  });
});
