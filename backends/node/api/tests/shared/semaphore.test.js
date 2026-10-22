// M22: счётный семафор передач медиа.

import { describe, expect, it } from 'vitest';

import { Semaphore } from '../../src/shared/concurrency/semaphore.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Semaphore', () => {
  it('1) не больше capacity задач одновременно, очередь FIFO', async () => {
    const sem = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const runs = gates.map((g, i) => sem.run(async () => {
      started.push(i);
      await g.promise;
      return i;
    }));
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await runs[0];
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    gates[2].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(sem._active).toBe(0);
  });

  it('2) ошибка задачи освобождает слот и летит наружу', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    expect(sem._active).toBe(0);
  });

  it.each([0, 1.5, null])('3) capacity %s → TypeError', (capacity) => {
    expect(() => new Semaphore(capacity)).toThrow(TypeError);
  });
});
