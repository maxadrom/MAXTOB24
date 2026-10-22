// M29: unit-тесты MessagingService.routeOutboundQueued — очередь исходящих по чату поверх
// прежних маршрутов: claim строки job: → задание в FIFO чата → маршрут → release. БД и
// сеть не нужны: журнал в памяти (claim/record делят ключи, как уникальный индекс
// message_log), MAX-фейк умеет «висеть» на заливке.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyedQueue } from '../../src/shared/concurrency/keyedQueue.js';
import { contentHash } from '../../src/shared/crypto/contentHash.js';
import { ValidationError } from '../../src/shared/http/domainErrors.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import {
  addEvent,
  buildService,
  CHAT_A,
  CHAT_B,
  deferred,
  deleteEvent,
  editEvent,
  fakeB24,
  fakeBindings,
  fakeMax,
  loggedFields,
  memoryLog,
  opFile,
  settle,
  spyLogger,
} from '../helpers/outboundFakes.js';

const SEND_UNCERTAIN_TEXT = '⚠️ Сообщение могло не дойти до MAX: внутренняя ошибка моста. '
  + 'Проверьте и при необходимости отправьте ещё раз.';
const EDIT_UNCERTAIN_TEXT = '⚠️ Правка могла не дойти до MAX: внутренняя ошибка моста. '
  + 'Если важно, отредактируйте сообщение ещё раз.';
const DELETE_UNCERTAIN_TEXT = '⚠️ Удаление могло не дойти до MAX: внутренняя ошибка моста. '
  + 'У клиентов в MAX сообщение могло остаться.';

function setup({ uploadGates, queue, mediaConcurrency } = {}) {
  const bindings = fakeBindings();
  const max = fakeMax({ uploadGates });
  const b24 = fakeB24();
  const log = memoryLog();
  const logger = spyLogger();
  const service = buildService({ bindings, max, b24, log, queue, logger, mediaConcurrency });
  return { service, bindings, max, b24, log, logger };
}

// Промис с флагом «уже завершился» — проверять, что запрос ещё ждёт.
function track(promise) {
  const t = { done: false, promise };
  promise.then(() => { t.done = true; }, () => { t.done = true; });
  return t;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MessagingService.routeOutboundQueued — вход и форма ответа', () => {
  it('отправка: результат как у routeOutbound; claim до MAX, release после, строки job: не остаётся', async () => {
    const { service, max, log, b24, logger } = setup();

    const result = await service.routeOutboundQueued('add', addEvent('501'), { logger });

    expect(result).toEqual({
      ok: true,
      results: [{ ok: true, bindingId: 1, b24MsgId: '501', maxMid: 'mid.text-1', logId: expect.any(Number) }],
    });
    expect(log.claimOutboundJob).toHaveBeenCalledWith({
      bindingId: 1,
      jobKey: 'job:501',
      payloadMeta: {
        kind: 'job',
        op: 'add',
        opKey: '501',
        connectorChatId: CHAT_A,
        b24ChatId: '21001',
        b24MsgId: '501',
        textPrefix: '**Оператор:**\nтекст 501',
        hasText: true,
        filesCount: 0,
        fileNames: [],
      },
    });
    const claimAt = log.claimOutboundJob.mock.invocationCallOrder[0];
    const sendAt = max.sendOutgoingMessage.mock.invocationCallOrder[0];
    const releaseAt = log.releaseOutboundJob.mock.invocationCallOrder[0];
    expect(claimAt).toBeLessThan(sendAt);
    expect(sendAt).toBeLessThan(releaseAt);
    expect(log.jobs()).toEqual([]);
    expect(log.keys()).toEqual(['501']);
    expect(b24.sendDeliveryStatus).toHaveBeenCalledOnce();

    const done = loggedFields(logger.info, 'outbound job done');
    expect(done).toMatchObject({ op: 'add', bindingId: 1, b24MsgId: '501', verdict: 'ok', bypass: false });
    expect(done.queuedMs).toBeGreaterThanOrEqual(0);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('промис события резолвится только после доставки (синхронный режим)', async () => {
    const gate = deferred();
    const { service, max } = setup({ uploadGates: [gate.promise] });

    const req = track(service.routeOutboundQueued('add', addEvent('502', { files: [opFile('a.jpg')] })));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());
    await settle();
    expect(req.done).toBe(false);

    gate.resolve();
    const result = await req.promise;
    expect(result.results[0]).toMatchObject({ ok: true, maxMids: ['mid.file-1'] });
  });

  it('файлы: в строке задания — имена файлов, подпись как текст, без цитаты в оповещении', async () => {
    const { service, log } = setup();

    await service.routeOutboundQueued('add', addEvent('503', {
      text: '[b]Оператор:[/b] [br]смотрите договор',
      files: [opFile('Договор.pdf'), opFile('Скан.jpg')],
    }));

    expect(log.claimOutboundJob.mock.calls[0][0].payloadMeta).toMatchObject({
      op: 'add',
      textPrefix: '**Оператор:**\nсмотрите договор',
      hasText: true,
      filesCount: 2,
      fileNames: ['Договор.pdf', 'Скан.jpg'],
    });
  });

  it('файл с ярлыком-именем вместо подписи → hasText:false', async () => {
    const { service, log } = setup();

    await service.routeOutboundQueued('add', addEvent('504', {
      text: '[b]Оператор:[/b] [br]a.jpg',
      files: [opFile('a.jpg')],
    }));

    expect(log.claimOutboundJob.mock.calls[0][0].payloadMeta).toMatchObject({ hasText: false, textPrefix: '', filesCount: 1 });
  });

  it('правка и удаление: ключи job:edit:<id>:<хеш> и job:delete:<id>, без содержимого сообщения', async () => {
    const { service, log } = setup();
    log.seed({ bindingId: 1, b24MsgId: '505', payloadMeta: { maxMid: 'mid.X', maxMids: ['mid.X'] } });

    const edited = await service.routeOutboundQueued('edit', editEvent('505', { text: 'новый текст' }));
    const removed = await service.routeOutboundQueued('delete', deleteEvent('505'));

    expect(edited.results[0]).toMatchObject({ ok: true, maxMid: 'mid.X' });
    expect(removed.results[0]).toMatchObject({ ok: true, maxMid: 'mid.X' });
    const [editClaim, deleteClaim] = log.claimOutboundJob.mock.calls.map((c) => c[0]);
    expect(editClaim.jobKey).toBe(`job:edit:505:${contentHash('новый текст')}`);
    expect(editClaim.payloadMeta).toEqual({
      kind: 'job', op: 'edit', opKey: `edit:505:${contentHash('новый текст')}`, connectorChatId: CHAT_A, b24ChatId: '21001', b24MsgId: '505',
    });
    expect(deleteClaim.jobKey).toBe('job:delete:505');
    // id MAX из события удаления (здесь их нет) — для повтора при разборе прерванных
    expect(deleteClaim.payloadMeta).toEqual({
      kind: 'job', op: 'delete', opKey: 'delete:505', connectorChatId: CHAT_A, b24ChatId: '21001', b24MsgId: '505', externalIds: [],
    });
    // записи операций — под теми же ключами, что и в строке задания (один источник ключа)
    expect(log.keys()).toEqual(['505', `edit:505:${contentHash('новый текст')}`, 'delete:505']);
    expect(log.jobs()).toEqual([]);
  });

  it('удаление: id MAX из события (message.id) — в строке задания', async () => {
    const { service, log } = setup();

    await service.routeOutboundQueued('delete', deleteEvent('506', { externalId: 'mid.ev' }));

    expect(log.claimOutboundJob.mock.calls[0][0].payloadMeta).toMatchObject({ op: 'delete', externalIds: ['mid.ev'] });
  });

  it('ignored-event / no-messages / no-binding / invalid-message — без claim', async () => {
    const { service, log, max } = setup();

    await expect(service.routeOutboundQueued('add', new OpenLineEvent({ event: 'OnImBotMessageAdd', data: {} })))
      .resolves.toEqual({ skipped: 'ignored-event' });
    await expect(service.routeOutboundQueued('edit', new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEUPDATE', data: { MESSAGES: [] } })))
      .resolves.toEqual({ skipped: 'no-messages' });
    await expect(service.routeOutboundQueued('add', addEvent('506', { chat: 'max:-999' })))
      .resolves.toEqual({ ok: true, results: [{ skipped: 'no-binding' }] });
    const noChat = new OpenLineEvent({
      event: 'ONIMCONNECTORMESSAGEDELETE',
      data: { MESSAGES: [{ im: { chat_id: '21001', message_id: '507' }, message: {}, chat: {} }] },
    });
    await expect(service.routeOutboundQueued('delete', noChat))
      .resolves.toEqual({ ok: true, results: [{ skipped: 'invalid-message' }] });

    expect(log.claimOutboundJob).not.toHaveBeenCalled();
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(service.outboundQueue.size).toBe(0);
  });

  it('неизвестный kind → TypeError; нет события → ValidationError', async () => {
    const { service } = setup();
    await expect(service.routeOutboundQueued('forward', addEvent('508'))).rejects.toBeInstanceOf(TypeError);
    await expect(service.routeOutboundQueued('add', null)).rejects.toBeInstanceOf(ValidationError);
  });

  it('claim вернул null (то же событие уже в работе) → duplicate-in-progress, MAX не вызван', async () => {
    const { service, log, max, logger } = setup();
    log.claimOutboundJob.mockResolvedValueOnce(null);

    const result = await service.routeOutboundQueued('add', addEvent('509'), { logger });

    expect(result).toEqual({ ok: true, results: [{ skipped: 'duplicate-in-progress' }] });
    expect(max.sendOutgoingMessage).not.toHaveBeenCalled();
    expect(log.releaseOutboundJob).not.toHaveBeenCalled();
    expect(loggedFields(logger.warn, 'routeOutbound: duplicate-in-progress')).toMatchObject({ bindingId: 1, opKey: '509' });
  });

  it('повтор того же события во время заливки → duplicate-in-progress сразу, в MAX одна копия', async () => {
    const gate = deferred();
    const { service, max, log } = setup({ uploadGates: [gate.promise] });
    const event = () => addEvent('510', { files: [opFile('a.jpg')] });

    const first = track(service.routeOutboundQueued('add', event()));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());

    // повтор отвечает, не дожидаясь первого
    await expect(service.routeOutboundQueued('add', event()))
      .resolves.toEqual({ ok: true, results: [{ skipped: 'duplicate-in-progress' }] });
    expect(first.done).toBe(false);

    gate.resolve();
    await first.promise;
    expect(max.uploadAndSend).toHaveBeenCalledOnce();
    expect(log.jobs()).toEqual([]);
  });

  it('release упал (БД) → WARN, результат задания не теряется; строка снимается повтором в фоне', async () => {
    vi.useFakeTimers();
    const { service, log, logger } = setup();
    log.releaseOutboundJob
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));

    const result = await service.routeOutboundQueued('add', addEvent('511'), { logger });

    expect(result.results[0]).toMatchObject({ ok: true, b24MsgId: '511' });
    expect(loggedFields(logger.warn, 'outbound job release failed, retrying in background')).toMatchObject({
      jobId: expect.any(Number), retryMs: 5_000,
    });
    expect(log.jobs()).toHaveLength(1);

    // повтор через 5 с снова упал, через ещё 30 с — снял
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.releaseOutboundJob).toHaveBeenCalledTimes(2);
    expect(log.jobs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.releaseOutboundJob).toHaveBeenCalledTimes(3);
    expect(log.jobs()).toEqual([]);
    expect(loggedFields(logger.info, 'outbound job released after retry')).toMatchObject({ attempt: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('release не прошёл и после всех повторов → ERROR, строка ждёт следующего старта', async () => {
    vi.useFakeTimers();
    const { service, log, logger } = setup();
    log.releaseOutboundJob.mockRejectedValue(new Error('db down'));

    await service.routeOutboundQueued('add', addEvent('512'), { logger });
    await vi.advanceTimersByTimeAsync(5_000 + 30_000 + 120_000 + 600_000);

    expect(log.releaseOutboundJob).toHaveBeenCalledTimes(5);
    expect(loggedFields(logger.error, 'outbound job release gave up (will be reported on next start)')).toMatchObject({
      attempts: 4,
    });
    expect(log.jobs()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MessagingService.routeOutboundQueued — порядок в чате', () => {
  it('файл, а следом текст того же чата: текст уходит в MAX после файла и отвечает после него; другой чат не ждёт', async () => {
    const gate = deferred();
    const { service, max } = setup({ uploadGates: [gate.promise] });

    const fileReq = track(service.routeOutboundQueued('add', addEvent('601', { files: [opFile('a.jpg')] })));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());
    const textReq = track(service.routeOutboundQueued('add', addEvent('602', { text: 'после файла' })));
    const otherReq = service.routeOutboundQueued('add', addEvent('603', { chat: CHAT_B, text: 'другой чат' }));

    // текст другого чата доставлен, пока файл висит
    await expect(otherReq).resolves.toMatchObject({ ok: true, results: [{ ok: true, b24MsgId: '603' }] });
    await settle();
    expect(max.order).toEqual(['upload-start:a.jpg', 'send:другой чат']);
    expect(textReq.done).toBe(false);
    expect(service.outboundQueue.pendingFor(CHAT_A)).toBe(2);

    gate.resolve();
    await expect(textReq.promise).resolves.toMatchObject({ ok: true, results: [{ ok: true, b24MsgId: '602' }] });
    expect(fileReq.done).toBe(true);
    expect(max.order).toEqual(['upload-start:a.jpg', 'send:другой чат', 'upload:a.jpg', 'send:после файла']);
  });

  it('удаление во время заливки ждёт её и удаляет все сообщения MAX из журнала (без no-maxmid)', async () => {
    const gate = deferred();
    const { service, max, b24, logger } = setup({ uploadGates: [gate.promise] });

    const fileReq = service.routeOutboundQueued('add', addEvent('604', {
      text: '',
      files: [opFile('a.jpg'), opFile('b.jpg')],
    }));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());
    const deleteReq = service.routeOutboundQueued('delete', deleteEvent('604'), { logger });
    await settle();
    expect(max.deleteOutgoing).not.toHaveBeenCalled();

    gate.resolve();
    await fileReq;
    const result = await deleteReq;

    expect(result.results[0]).toMatchObject({ ok: true, b24MsgId: '604', deletedCount: 2 });
    expect(max.deleteOutgoing.mock.calls.map((c) => c[0].messageId)).toEqual(['mid.file-1', 'mid.file-2']);
    expect(loggedFields(logger.warn, 'no-maxmid')).toBeNull();
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('правка во время заливки ждёт её и правит первое сообщение MAX, без оповещения «не найдено»', async () => {
    const gate = deferred();
    const { service, max, b24 } = setup({ uploadGates: [gate.promise] });

    const fileReq = service.routeOutboundQueued('add', addEvent('605', {
      text: '[b]Оператор:[/b] [br]подпись',
      files: [opFile('a.jpg'), opFile('b.jpg')],
    }));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());
    const editReq = service.routeOutboundQueued('edit', editEvent('605', { text: '[b]Оператор:[/b] [br]новая подпись' }));
    await settle();
    expect(max.editOutgoing).not.toHaveBeenCalled();

    gate.resolve();
    await fileReq;
    const result = await editReq;

    expect(result.results[0]).toMatchObject({ ok: true, maxMid: 'mid.file-1' });
    expect(max.editOutgoing).toHaveBeenCalledWith({ messageId: 'mid.file-1', text: '**Оператор:**\nновая подпись', format: 'markdown' });
    expect(b24.sendSystemMessage).not.toHaveBeenCalled();
  });

  it('файлы одного чата из трёх событий передаются строго по одному (второй слот семафора не занят)', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const { service, max } = setup({ uploadGates: gates.map((g) => g.promise), mediaConcurrency: 2 });

    const reqs = ['606', '607', '608'].map((id, i) => service.routeOutboundQueued('add', addEvent(id, {
      text: '',
      files: [opFile(`f${i}.jpg`)],
    })));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());
    await settle();
    expect(max.uploadAndSend).toHaveBeenCalledOnce();

    gates[0].resolve();
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledTimes(2));
    await settle();
    expect(max.uploadAndSend).toHaveBeenCalledTimes(2);
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(reqs);

    expect(max.stats.maxActiveUploads).toBe(1);
    expect(max.order).toEqual([
      'upload-start:f0.jpg', 'upload:f0.jpg',
      'upload-start:f1.jpg', 'upload:f1.jpg',
      'upload-start:f2.jpg', 'upload:f2.jpg',
    ]);
  });

  it('разные чаты: файлы идут параллельно под общим семафором', async () => {
    const gates = [deferred(), deferred()];
    const { service, max } = setup({ uploadGates: gates.map((g) => g.promise), mediaConcurrency: 2 });

    const a = service.routeOutboundQueued('add', addEvent('609', { text: '', files: [opFile('a.jpg')] }));
    const b = service.routeOutboundQueued('add', addEvent('610', { chat: CHAT_B, text: '', files: [opFile('b.jpg')] }));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledTimes(2));
    gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(max.stats.maxActiveUploads).toBe(2);
  });

  it('место в очереди задаёт порядок завершения claim (медленный claim первого → второе раньше)', async () => {
    const { service, max, log } = setup();
    const slowClaim = deferred();
    const realClaim = log.claimOutboundJob.getMockImplementation();
    log.claimOutboundJob.mockImplementationOnce(async (args) => {
      await slowClaim.promise;
      return realClaim(args);
    });

    const first = service.routeOutboundQueued('add', addEvent('611', { text: 'первое' }));
    const second = service.routeOutboundQueued('add', addEvent('612', { text: 'второе' }));
    await second;
    expect(max.order).toEqual(['send:второе']);

    slowClaim.resolve();
    await first;
    expect(max.order).toEqual(['send:второе', 'send:первое']);
  });
});

describe('MessagingService.routeOutboundQueued — лимит очереди чата', () => {
  it('очередь чата полна (maxPerKey: 1) → второе событие выполняется сразу, WARN, оба доставлены, bypass в логе', async () => {
    const gate = deferred();
    const queue = new KeyedQueue({ maxPerKey: 1 });
    const { service, max, logger } = setup({ uploadGates: [gate.promise], queue });

    const fileReq = track(service.routeOutboundQueued('add', addEvent('701', { text: '', files: [opFile('a.jpg')] }), { logger }));
    await vi.waitFor(() => expect(max.uploadAndSend).toHaveBeenCalledOnce());

    const textRes = await service.routeOutboundQueued('add', addEvent('702', { text: 'вне очереди' }), { logger });

    expect(textRes.results[0]).toMatchObject({ ok: true, b24MsgId: '702' });
    expect(fileReq.done).toBe(false);
    expect(max.order).toEqual(['upload-start:a.jpg', 'send:вне очереди']);
    expect(loggedFields(logger.warn, 'outbound chat queue full, processing without waiting')).toMatchObject({
      connectorChatId: CHAT_A, bindingId: 1, b24MsgId: '702', pending: 1, max: 1,
    });
    const doneCalls = logger.info.mock.calls.filter((c) => c[1] === 'outbound job done').map((c) => c[0]);
    expect(doneCalls).toEqual([expect.objectContaining({ b24MsgId: '702', bypass: true })]);

    gate.resolve();
    await fileReq.promise;
    expect(service.outboundQueue.size).toBe(0);
  });
});

describe('MessagingService.routeOutboundQueued — ошибки', () => {
  it('ошибка БД в задании отправки → проброс, release вызван, оповещение «могло не дойти»', async () => {
    const { service, log, b24, logger } = setup();
    const dbErr = new Error('db write failed');
    log.recordOutbound.mockRejectedValueOnce(dbErr);

    await expect(service.routeOutboundQueued('add', addEvent('801'), { logger })).rejects.toBe(dbErr);

    expect(log.releaseOutboundJob).toHaveBeenCalledOnce();
    expect(log.jobs()).toEqual([]);
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: SEND_UNCERTAIN_TEXT });
    expect(loggedFields(logger.error, 'outbound job failed')).toMatchObject({ op: 'add', b24MsgId: '801' });
  });

  it('сообщение 1 упало (БД) → сообщение 2 события всё равно доставлено, затем проброс', async () => {
    const { service, log, max, b24 } = setup();
    const dbErr = new Error('db write failed');
    const realRecord = log.recordOutbound.getMockImplementation();
    log.recordOutbound.mockImplementation(async (args) => {
      if (args.b24MsgId === '802') throw dbErr;
      return realRecord(args);
    });

    const event = addEvent(null, { messages: [{ id: '802', text: 'раз' }, { id: '803', text: 'два' }] });
    await expect(service.routeOutboundQueued('add', event)).rejects.toBe(dbErr);

    expect(max.order).toEqual(['send:раз', 'send:два']);
    expect(log.get(1, '803')).not.toBeNull();
    expect(log.releaseOutboundJob).toHaveBeenCalledTimes(2);
    expect(log.jobs()).toEqual([]);
    expect(b24.sendSystemMessage).toHaveBeenCalledOnce();
  });

  it('claim отправки бросил → MAX для неё не вызван, поставленные сообщения события доставлены, затем проброс + оповещение', async () => {
    const { service, log, max, b24 } = setup();
    const claimErr = new Error('db connection lost');
    const realClaim = log.claimOutboundJob.getMockImplementation();
    log.claimOutboundJob.mockImplementation(async (args) => {
      if (args.jobKey === 'job:805') throw claimErr;
      return realClaim(args);
    });

    const event = addEvent(null, {
      messages: [{ id: '804', text: 'раз' }, { id: '805', text: 'два' }, { id: '806', text: 'три' }],
    });
    await expect(service.routeOutboundQueued('add', event)).rejects.toBe(claimErr);

    // 804 доставлено, 805 не ставилось, 806 — уже не ставится
    expect(max.order).toEqual(['send:раз']);
    expect(log.claimOutboundJob).toHaveBeenCalledTimes(2);
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: SEND_UNCERTAIN_TEXT });
    expect(log.jobs()).toEqual([]);
  });

  it('claim правки бросил → edit-error + оповещение «могла не дойти», без throw', async () => {
    const { service, log, max, b24 } = setup();
    log.claimOutboundJob.mockRejectedValueOnce(new Error('db down'));

    const result = await service.routeOutboundQueued('edit', editEvent('807'));

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-error' }] });
    expect(max.editOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: EDIT_UNCERTAIN_TEXT });
  });

  it('claim удаления бросил → delete-error + оповещение «могло не дойти», без throw', async () => {
    const { service, log, max, b24 } = setup();
    log.claimOutboundJob.mockRejectedValueOnce(new Error('db down'));

    const result = await service.routeOutboundQueued('delete', deleteEvent('808', { externalId: 'mid.Z' }));

    expect(result).toEqual({ ok: true, results: [{ skipped: 'delete-error' }] });
    expect(max.deleteOutgoing).not.toHaveBeenCalled();
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: DELETE_UNCERTAIN_TEXT });
  });

  it('внутренняя ошибка правки в задании → edit-error + оповещение (M28), строка снята', async () => {
    const { service, log, max, b24 } = setup();
    log.seed({ bindingId: 1, b24MsgId: '809', payloadMeta: { maxMid: 'mid.Y' } });
    max.editOutgoing.mockRejectedValueOnce(new TypeError('bug'));

    const result = await service.routeOutboundQueued('edit', editEvent('809'));

    expect(result).toEqual({ ok: true, results: [{ skipped: 'edit-error' }] });
    expect(b24.sendSystemMessage).toHaveBeenCalledWith({ b24ChatId: '21001', text: EDIT_UNCERTAIN_TEXT });
    expect(log.jobs()).toEqual([]);
  });
});
