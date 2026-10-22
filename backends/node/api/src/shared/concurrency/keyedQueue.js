// M29: очередь заданий с FIFO по ключу (чат) и общим счётчиком. Разные ключи идут
// параллельно, один ключ — строго по очереди: следующее задание стартует после завершения
// предыдущего. Ошибка задания летит вызывающему и цепочку не рвёт.
//
// Лимит на ключ (maxPerKey): если в цепочке ключа уже столько принятых и незавершённых
// заданий, новое выполняется сразу, вне цепочки и вне порядка (back-pressure без потерь:
// задание не отклоняется). Такое задание не входит в pendingFor(key), но учитывается в size,
// whenIdle и drain. Обход логирует вызывающий: isFull(key) и push идут синхронно, гонки нет.
//
// Задание не должно ставить задания в свою же цепочку и ждать их: следующее в цепочке
// стартует только после текущего, и цепочка заблокирует сама себя.
//
// В памяти процесса: api-node — один процесс (single-tenant).

// Предел таймера Node (2^31 − 1 мс, ~24,8 сут): больше — setTimeout сработает через 1 мс.
const MAX_TIMER_MS = 2_147_483_647;

// Ключ — строка: один чат числом и строкой (7 и '7') попадает в одну цепочку.
function toKey(key) {
  if (key === null || key === undefined || key === '') {
    throw new TypeError('KeyedQueue: key required');
  }
  return String(key);
}

export class KeyedQueue {
  constructor({ maxPerKey = Number.POSITIVE_INFINITY } = {}) {
    const valid = maxPerKey === Number.POSITIVE_INFINITY || (Number.isInteger(maxPerKey) && maxPerKey >= 1);
    if (!valid) {
      throw new TypeError(`KeyedQueue: maxPerKey must be a positive integer or Infinity (got ${maxPerKey})`);
    }
    this.maxPerKey = maxPerKey;
    // key → { tail, pending }: хвост цепочки (промис без отказа) и сколько в ней заданий.
    this._chains = new Map();
    this._size = 0;
    this._idleWaiters = [];
  }

  // Принято и не завершено, всего: в цепочках и вне их.
  get size() {
    return this._size;
  }

  // Принято и не завершено в цепочке ключа: ждут + выполняется.
  pendingFor(key) {
    return this._chains.get(String(key))?.pending ?? 0;
  }

  isFull(key) {
    return this.pendingFor(key) >= this.maxPerKey;
  }

  // → промис результата fn (или её ошибки). fn стартует асинхронно: в цепочке — после
  // предыдущего задания ключа, при полной цепочке — сразу, вне её.
  push(key, fn) {
    const k = toKey(key);
    if (typeof fn !== 'function') {
      throw new TypeError('KeyedQueue: task must be a function');
    }
    const run = this.isFull(k) ? Promise.resolve().then(() => fn()) : this._chain(k, fn);
    this._size += 1;
    return run.finally(() => this._settle());
  }

  _chain(key, fn) {
    let chain = this._chains.get(key);
    if (!chain) {
      chain = { tail: Promise.resolve(), pending: 0 };
      this._chains.set(key, chain);
    }
    chain.pending += 1;
    const run = chain.tail.then(() => fn()).finally(() => {
      chain.pending -= 1;
      if (chain.pending === 0 && this._chains.get(key) === chain) this._chains.delete(key);
    });
    chain.tail = run.catch(() => {});
    return run;
  }

  _settle() {
    this._size -= 1;
    if (this._size > 0) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // → промис, который резолвится, когда size станет 0 (сразу, если уже 0). Задания,
  // принятые до этого момента, тоже ожидаются.
  whenIdle() {
    if (this._size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this._idleWaiters.push(resolve);
    });
  }

  // Ждёт whenIdle, но не дольше timeoutMs. → { drained: true, pending: 0 } |
  // { drained: false, pending: size }. timeoutMs ≤ 0 — только проверка size; Infinity —
  // без таймера. Таймер unref (не держит процесс) и снимается после ожидания.
  async drain(timeoutMs) {
    if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) {
      throw new TypeError(`KeyedQueue.drain: timeoutMs must be a number (got ${timeoutMs})`);
    }
    if (this._size === 0) return { drained: true, pending: 0 };
    if (timeoutMs <= 0) return { drained: false, pending: this._size };

    let timer = null;
    const idle = this.whenIdle().then(() => true);
    const waits = [idle];
    if (timeoutMs !== Number.POSITIVE_INFINITY) {
      waits.push(new Promise((resolve) => {
        timer = setTimeout(resolve, Math.min(timeoutMs, MAX_TIMER_MS), false);
        timer.unref?.();
      }));
    }
    try {
      const drained = await Promise.race(waits);
      return drained ? { drained: true, pending: 0 } : { drained: false, pending: this._size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
