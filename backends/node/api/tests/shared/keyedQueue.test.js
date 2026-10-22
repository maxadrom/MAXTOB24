// M29: очередь заданий с FIFO по ключу (чат), лимитом на ключ и дренажом.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyedQueue } from '../../src/shared/concurrency/keyedQueue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Дать отработать микрозадачам и колбэкам промисов.
const tick = () => new Promise((r) => setImmediate(r));

describe('KeyedQueue (M29)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1) один ключ — FIFO: второе стартует после завершения первого', async () => {
    const q = new KeyedQueue();
    const gates = [deferred(), deferred(), deferred()];
    const events = [];
    const runs = gates.map((g, i) => q.push('chat-1', async () => {
      events.push(`start ${i}`);
      const v = await g.promise;
      events.push(`end ${i}`);
      return v;
    }));
    await tick();
    expect(events).toEqual(['start 0']);
    expect(q.pendingFor('chat-1')).toBe(3);
    expect(q.size).toBe(3);

    // Третье отпущено раньше второго — всё равно ждёт своей очереди.
    gates[2].resolve('c');
    gates[0].resolve('a');
    await tick();
    expect(events).toEqual(['start 0', 'end 0', 'start 1']);

    gates[1].resolve('b');
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect(q.size).toBe(0);
    expect(q.pendingFor('chat-1')).toBe(0);
    expect(q._chains.size).toBe(0);
  });

  it('2) разные ключи идут параллельно', async () => {
    const q = new KeyedQueue();
    const gateA = deferred();
    const started = [];
    const runA = q.push('chat-a', async () => {
      started.push('a');
      await gateA.promise;
      return 'a';
    });
    const runB = q.push('chat-b', async () => {
      started.push('b');
      return 'b';
    });
    // B завершилось, пока A висит.
    expect(await runB).toBe('b');
    expect(started).toEqual(['a', 'b']);
    expect(q.size).toBe(1);
    expect(q.pendingFor('chat-a')).toBe(1);
    expect(q.pendingFor('chat-b')).toBe(0);

    gateA.resolve();
    expect(await runA).toBe('a');
    expect(q.size).toBe(0);
  });

  it('3) ошибка задания летит вызывающему и не рвёт цепочку; size возвращается к 0', async () => {
    const q = new KeyedQueue();
    const first = q.push('chat-1', async () => {
      throw new Error('boom');
    });
    const syncThrow = q.push('chat-1', () => {
      throw new Error('sync boom');
    });
    const third = q.push('chat-1', async () => 'ok');

    await expect(first).rejects.toThrow('boom');
    await expect(syncThrow).rejects.toThrow('sync boom');
    await expect(third).resolves.toBe('ok');
    expect(q.size).toBe(0);
    expect(q._chains.size).toBe(0);
  });

  it('4) maxPerKey: 1 — при полной цепочке задание стартует сразу, вне её; drain ждёт оба', async () => {
    const q = new KeyedQueue({ maxPerKey: 1 });
    const gate1 = deferred();
    const gate2 = deferred();
    const started = [];

    expect(q.isFull('chat-1')).toBe(false);
    const run1 = q.push('chat-1', async () => {
      started.push(1);
      await gate1.promise;
      return 1;
    });
    expect(q.isFull('chat-1')).toBe(true);
    const run2 = q.push('chat-1', async () => {
      started.push(2);
      await gate2.promise;
      return 2;
    });
    await tick();
    // Второе не ждёт первого.
    expect(started).toEqual([1, 2]);
    // В цепочке только первое, обход учтён в size.
    expect(q.pendingFor('chat-1')).toBe(1);
    expect(q.size).toBe(2);

    // Другой ключ не затронут лимитом chat-1.
    expect(q.isFull('chat-2')).toBe(false);

    let drained = null;
    const draining = q.drain(Number.POSITIVE_INFINITY).then((r) => {
      drained = r;
    });
    gate1.resolve();
    expect(await run1).toBe(1);
    expect(q.isFull('chat-1')).toBe(false);
    await tick();
    expect(drained).toBeNull();

    gate2.resolve();
    expect(await run2).toBe(2);
    await draining;
    expect(drained).toEqual({ drained: true, pending: 0 });
    expect(q.size).toBe(0);
  });

  it('5) whenIdle — сразу на пустой очереди и после последнего задания', async () => {
    const q = new KeyedQueue();
    await expect(q.whenIdle()).resolves.toBeUndefined();

    const gate = deferred();
    const run = q.push('chat-1', () => gate.promise);
    let idle = false;
    const waiting = q.whenIdle().then(() => {
      idle = true;
    });
    await tick();
    expect(idle).toBe(false);

    gate.resolve();
    await run;
    await waiting;
    expect(idle).toBe(true);
  });

  it('6) drain на пустой очереди и после завершения → drained:true', async () => {
    const q = new KeyedQueue();
    await expect(q.drain(1000)).resolves.toEqual({ drained: true, pending: 0 });

    const gate = deferred();
    q.push('chat-1', () => gate.promise);
    const draining = q.drain(60_000);
    gate.resolve();
    await expect(draining).resolves.toEqual({ drained: true, pending: 0 });
  });

  it('7) drain(50) с висящим заданием → drained:false, pending:1; таймер снят', async () => {
    vi.useFakeTimers();
    const q = new KeyedQueue();
    const gate = deferred();
    const run = q.push('chat-1', () => gate.promise);

    let result = null;
    const draining = q.drain(50).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(result).toEqual({ drained: false, pending: 1 });
    expect(vi.getTimerCount()).toBe(0);

    gate.resolve();
    await run;
    expect(q.size).toBe(0);
  });

  it('8) drain(0) — только проверка size, без ожидания', async () => {
    const q = new KeyedQueue();
    const gate = deferred();
    const run = q.push('chat-1', () => gate.promise);
    await expect(q.drain(0)).resolves.toEqual({ drained: false, pending: 1 });
    await expect(q.drain(-5)).resolves.toEqual({ drained: false, pending: 1 });
    gate.resolve();
    await run;
    await expect(q.drain(0)).resolves.toEqual({ drained: true, pending: 0 });
  });

  it('9) задание, принятое во время drain, тоже ожидается', async () => {
    vi.useFakeTimers();
    const q = new KeyedQueue();
    const gate1 = deferred();
    const gate2 = deferred();
    q.push('chat-1', () => gate1.promise);

    let result = null;
    const draining = q.drain(10_000).then((r) => {
      result = r;
    });
    // Новое задание другого ключа пришло во время дренажа (порт ещё открыт).
    const run2 = q.push('chat-2', () => gate2.promise);
    gate1.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toBeNull();
    expect(q.size).toBe(1);

    gate2.resolve();
    await run2;
    await draining;
    expect(result).toEqual({ drained: true, pending: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[''], [null], [undefined]])('10) пустой ключ %j → TypeError, задание не принято', (key) => {
    const q = new KeyedQueue();
    const fn = vi.fn();
    expect(() => q.push(key, fn)).toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
    expect(q.size).toBe(0);
  });

  it('11) задание не функция → TypeError', () => {
    const q = new KeyedQueue();
    expect(() => q.push('chat-1', 'not a function')).toThrow(TypeError);
    expect(q.size).toBe(0);
  });

  it.each([0, -1, 1.5, null, 'abc'])('12) maxPerKey %j → TypeError', (maxPerKey) => {
    expect(() => new KeyedQueue({ maxPerKey })).toThrow(TypeError);
  });

  it('13) drain без числа → TypeError', async () => {
    const q = new KeyedQueue();
    await expect(q.drain()).rejects.toThrow(TypeError);
    await expect(q.drain(Number.NaN)).rejects.toThrow(TypeError);
  });

  it('14) ключ числом и строкой — одна цепочка', async () => {
    const q = new KeyedQueue();
    const gate = deferred();
    const started = [];
    const first = q.push(7, async () => {
      started.push('num');
      await gate.promise;
    });
    const second = q.push('7', async () => {
      started.push('str');
    });
    await tick();
    expect(started).toEqual(['num']);
    expect(q.pendingFor(7)).toBe(2);
    expect(q.pendingFor('7')).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(['num', 'str']);
  });
});
