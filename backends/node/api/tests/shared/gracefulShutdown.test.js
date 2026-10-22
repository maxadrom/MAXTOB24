// M29: остановка с дренажом очереди исходящих. Фейки server / pool / exit, очередь — настоящий
// KeyedQueue, таймеры — fake: порядок шагов, порт открыт во время дренажа (и пока HTTP-запросы
// в работе), дедлайн, второй сигнал, жёсткий таймер, keep-alive.

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyedQueue } from '../../src/shared/concurrency/keyedQueue.js';
import { createGracefulShutdown } from '../../src/shared/lifecycle/gracefulShutdown.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function spyLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log.child = () => log;
  return log;
}

function logged(fnMock, msgPart) {
  return fnMock.mock.calls.some((c) => String(c.at(-1) ?? '').includes(msgPart));
}

// http.Server: close(cb) — колбэк сразу (microtask) или вручную (hold), события 'request'.
class FakeServer extends EventEmitter {
  constructor(events, { hold = false } = {}) {
    super();
    this.events = events;
    this.hold = hold;
    this.closeCb = null;
    this.listening = true;
    this.closeIdleConnections = vi.fn(() => events.push('closeIdle'));
  }

  close(cb) {
    this.events.push('close');
    this.listening = false;
    this.closeCb = cb;
    if (!this.hold) queueMicrotask(() => cb());
    return this;
  }
}

// Ответ http: shouldKeepAlive и headersSent, 'close' по окончании.
function fakeResponse({ headersSent = false } = {}) {
  const res = new EventEmitter();
  res.shouldKeepAlive = true;
  res.headersSent = headersSent;
  return res;
}

// Дать отработать микрозадачам при fake timers.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createGracefulShutdown (M29)', () => {
  let events;
  let queue;
  let pool;
  let exit;
  let log;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    queue = new KeyedQueue();
    const drain = queue.drain.bind(queue);
    queue.drain = vi.fn(async (ms) => {
      events.push('drain');
      return drain(ms);
    });
    pool = { end: vi.fn(async () => { events.push('pool.end'); }) };
    exit = vi.fn((code) => events.push(`exit ${code}`));
    log = spyLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(overrides = {}) {
    const server = overrides.server ?? new FakeServer(events);
    const shutdown = createGracefulShutdown({
      server,
      queue,
      pool,
      logger: log,
      drainTimeoutMs: 10_000,
      closeTimeoutMs: 1_000,
      idleSweepMs: 100,
      exit,
      onSignal: () => events.push('onSignal'),
      ...overrides,
    });
    return { server, shutdown };
  }

  // Висящее задание чата: → { gate, done }.
  function hangingJob(key = 'chat-1') {
    const gate = deferred();
    const done = queue.push(key, () => gate.promise);
    return { gate, done };
  }

  it('1) порядок: onSignal → drain → close → drain → pool.end → exit(0)', async () => {
    const { shutdown } = build();

    await shutdown('SIGTERM');

    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle', 'drain', 'pool.end', 'exit 0']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logged(log.info, 'shutdown requested: draining outbound queue (still listening)')).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM', pending: 0, requests: 0, drainTimeoutMs: 10_000 },
      'shutdown requested: draining outbound queue (still listening)',
    );
    expect(logged(log.info, 'outbound queue drained')).toBe(true);
    expect(logged(log.info, 'http server closed')).toBe(true);
    expect(logged(log.info, 'pg pool closed')).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ signal: 'SIGTERM', code: 0 }), 'shutdown complete');
    expect(log.error).not.toHaveBeenCalled();
    // жёсткий таймер снят
    expect(vi.getTimerCount()).toBe(0);
  });

  it('2) пока задание выполняется, порт открыт: close не зовётся; задание, принятое во время дренажа, тоже ожидается', async () => {
    const { server, shutdown } = build();
    const first = hangingJob('chat-1');

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual(['onSignal', 'drain']);
    expect(server.listening).toBe(true);
    expect(pool.end).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 1 }),
      'shutdown requested: draining outbound queue (still listening)',
    );

    // новое событие во время дренажа (другой чат) — принимается и выполняется
    const second = hangingJob('chat-2');
    first.gate.resolve('a');
    await flush();
    expect(events).toEqual(['onSignal', 'drain']);

    second.gate.resolve('b');
    await done;
    expect(await first.done).toBe('a');
    expect(await second.done).toBe('b');
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle', 'drain', 'pool.end', 'exit 0']);
  });

  it('3) дедлайн дренажа: ERROR, close и pool.end всё равно, exit(1)', async () => {
    const { shutdown } = build();
    const job = hangingJob();

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events).toEqual(['onSignal', 'drain']);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle', 'drain', 'pool.end', 'exit 1']);
    expect(log.error).toHaveBeenCalledWith(
      { pending: 1, requests: 0, drainTimeoutMs: 10_000 },
      'drain timeout: interrupted jobs will be reported on next start',
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ code: 1 }), 'shutdown complete');

    job.gate.resolve();
    await job.done;
  });

  it('4) повторный SIGTERM (Docker шлёт его на каждый docker stop) дренаж не обрывает: WARN, exit(0) по окончании', async () => {
    const { server, shutdown } = build();
    const job = hangingJob();

    const done = shutdown('SIGTERM');
    await flush();
    await shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).not.toHaveBeenCalled();
    expect(server.listening).toBe(true);
    expect(log.warn).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'shutdown: repeated signal ignored, still draining');

    job.gate.resolve();
    await done;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // onSignal — только на первом сигнале
    expect(events.filter((e) => e === 'onSignal')).toHaveLength(1);
  });

  it('4b) SIGINT во время остановки (второй Ctrl+C) — немедленный exit(1); первый потом exit не повторяет', async () => {
    const { shutdown } = build();
    const job = hangingJob();

    const done = shutdown('SIGTERM');
    await flush();
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutdown: second signal, force exit');

    job.gate.resolve();
    await done;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e === 'onSignal')).toHaveLength(1);
  });

  it('5) server.close висит → жёсткий таймер (дедлайн + closeTimeoutMs) → exit(1); поздний колбэк exit не зовёт', async () => {
    const server = new FakeServer(events, { hold: true });
    const { shutdown } = build({ server });

    const done = shutdown('SIGTERM');
    await flush();
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle']);

    await vi.advanceTimersByTimeAsync(10_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledWith({ timeoutMs: 11_000, pending: 0 }, 'graceful shutdown timeout — force exit');

    server.closeCb();
    await done;
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logged(log.info, 'shutdown complete')).toBe(false);
  });

  it('6) pool.end бросил → ERROR в лог, exit(0)', async () => {
    pool.end = vi.fn(async () => { throw new Error('pool boom'); });
    const { shutdown } = build();

    await shutdown('SIGTERM');

    expect(log.error).toHaveBeenCalledWith({ err: { message: 'pool boom', code: undefined } }, 'pg pool close error');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('7) onSignal бросил → ERROR в лог, дренаж идёт, exit(0)', async () => {
    const { shutdown } = build({ onSignal: () => { throw new Error('abort boom'); } });

    await shutdown('SIGTERM');

    expect(log.error).toHaveBeenCalledWith({ err: { message: 'abort boom', code: undefined } }, 'shutdown: onSignal failed');
    expect(queue.drain).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('8) задание, принятое между первым дренажом и колбэком close, дожидается вторым дренажом до pool.end', async () => {
    const server = new FakeServer(events, { hold: true });
    const { shutdown } = build({ server });

    const done = shutdown('SIGTERM');
    await flush();
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle']);

    // запрос по keep-alive соединению успел поставить задание, пока закрывался порт
    const late = hangingJob('chat-late');
    server.closeCb();
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle', 'drain']);
    expect(pool.end).not.toHaveBeenCalled();

    late.gate.resolve();
    await done;
    expect(events.slice(-2)).toEqual(['pool.end', 'exit 0']);
  });

  it('9) задание из окна закрытия не уложилось в остаток дедлайна → ERROR, exit(1)', async () => {
    const server = new FakeServer(events, { hold: true });
    const { shutdown } = build({ server });

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(4_000);
    const late = hangingJob('chat-late');
    server.closeCb();

    // остаток дедлайна — 6 с от момента второго дренажа
    await vi.advanceTimersByTimeAsync(5_999);
    expect(pool.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log.error).toHaveBeenCalledWith(
      { pending: 1, requests: 0, drainTimeoutMs: 10_000 },
      'drain timeout: interrupted jobs will be reported on next start',
    );
    expect(events.slice(-2)).toEqual(['pool.end', 'exit 1']);

    late.gate.resolve();
    await late.done;
  });

  it('10) keep-alive: ответам без отправленных заголовков — Connection: close; закрытие подметает простаивающие соединения', async () => {
    const server = new FakeServer(events, { hold: true });
    const { shutdown } = build({ server });

    const before = fakeResponse();
    const sent = fakeResponse({ headersSent: true });
    const finished = fakeResponse();
    server.emit('request', {}, before);
    server.emit('request', {}, sent);
    server.emit('request', {}, finished);
    finished.emit('close');
    // Обработчик стоит раньше Express (prependListener).
    expect(server.listeners('request')).toHaveLength(1);

    const done = shutdown('SIGTERM');
    await flush();
    expect(before.shouldKeepAlive).toBe(false);
    expect(sent.shouldKeepAlive).toBe(true);
    expect(finished.shouldKeepAlive).toBe(true);

    // запрос после сигнала (порт ещё открыт или keep-alive) — сразу без keep-alive
    const after = fakeResponse();
    server.emit('request', {}, after);
    expect(after.shouldKeepAlive).toBe(false);

    // запросы ответили — порт закрывается
    expect(events).toEqual(['onSignal', 'drain']);
    for (const res of [before, sent, after]) res.emit('close');
    await flush();

    // closeIdleConnections — при close и далее раз в idleSweepMs, пока не пришёл колбэк
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(4);
    server.closeCb();
    await done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(4);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('11) ошибка server.close → ERROR, дальше pool.end и exit(0)', async () => {
    const server = new FakeServer(events, { hold: true });
    const { shutdown } = build({ server });

    const done = shutdown('SIGTERM');
    await flush();
    const err = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' });
    server.closeCb(err);
    await done;

    expect(log.error).toHaveBeenCalledWith(
      { err: { message: 'Server is not running.', code: 'ERR_SERVER_NOT_RUNNING' } },
      'http server close error',
    );
    expect(events.slice(-2)).toEqual(['pool.end', 'exit 0']);
  });

  it('12) огромный дедлайн: жёсткий таймер зажат до предела Node и не срабатывает сразу', async () => {
    const { shutdown } = build({ drainTimeoutMs: 1e12 });
    const job = hangingJob();

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();

    job.gate.resolve();
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('14) очередь пуста, а запрос в работе (claim): порт открыт, пока он не ответит; его задание тоже ожидается', async () => {
    const { server, shutdown } = build();
    const res = fakeResponse();
    server.emit('request', {}, res);

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toEqual(['onSignal', 'drain']);
    expect(server.listening).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 0, requests: 1 }),
      'shutdown requested: draining outbound queue (still listening)',
    );

    // claim завершился — задание в очереди; запрос ответит после него
    const job = hangingJob('chat-1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.listening).toBe(true);
    // ещё один запрос, пока первый в работе (другой чат, короткий)
    const short = fakeResponse();
    server.emit('request', {}, short);
    short.emit('close');

    job.gate.resolve();
    await flush();
    expect(server.listening).toBe(true);
    res.emit('close');
    await done;
    expect(events).toEqual(['onSignal', 'drain', 'close', 'closeIdle', 'drain', 'pool.end', 'exit 0']);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('16) запросы ответили, а в очереди задание без запроса (разбор прерванных) → порт закрывается после него', async () => {
    const { server, shutdown } = build();
    const res = fakeResponse();
    server.emit('request', {}, res);

    const done = shutdown('SIGTERM');
    await flush();
    const recovery = hangingJob('chat-recovery');
    res.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['onSignal', 'drain', 'drain']);
    expect(server.listening).toBe(true);

    recovery.gate.resolve();
    await done;
    expect(events).toEqual(['onSignal', 'drain', 'drain', 'close', 'closeIdle', 'drain', 'pool.end', 'exit 0']);
  });

  it('15) запрос не ответил к дедлайну → ERROR (requests), close и exit(1)', async () => {
    const { server, shutdown } = build();
    const res = fakeResponse();
    server.emit('request', {}, res);

    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events).toEqual(['onSignal', 'drain']);
    expect(server.listening).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log.error).toHaveBeenCalledWith(
      { pending: 0, requests: 1, drainTimeoutMs: 10_000 },
      'drain timeout: interrupted jobs will be reported on next start',
    );
    expect(events.slice(-5)).toEqual(['close', 'closeIdle', 'drain', 'pool.end', 'exit 1']);
  });

  it('13) валидация: без server/queue/pool или с невалидным дедлайном — TypeError', () => {
    const server = new FakeServer(events);
    const base = { server, queue, pool, logger: log, drainTimeoutMs: 1_000 };
    expect(() => createGracefulShutdown({ ...base, server: null })).toThrow(TypeError);
    expect(() => createGracefulShutdown({ ...base, queue: {} })).toThrow(TypeError);
    expect(() => createGracefulShutdown({ ...base, pool: null })).toThrow(TypeError);
    for (const drainTimeoutMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      expect(() => createGracefulShutdown({ ...base, drainTimeoutMs })).toThrow(TypeError);
    }
    expect(() => createGracefulShutdown({ ...base, closeTimeoutMs: -1 })).toThrow(TypeError);
    expect(() => createGracefulShutdown(base)).not.toThrow();
  });
});
