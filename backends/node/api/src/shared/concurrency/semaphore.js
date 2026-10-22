// M22: счётный семафор — не больше capacity задач одновременно, остальные ждут по
// очереди (FIFO). Ограничивает передачи медиа OL → MAX на весь процесс: диск под
// временные файлы ≤ MEDIA_MAX_BYTES × capacity. Блокировка внутри процесса: api-node —
// один процесс (single-tenant).

export class Semaphore {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError(`Semaphore: capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this._active = 0;
    this._waiters = [];
  }

  async run(fn) {
    if (this._active < this.capacity) {
      this._active += 1;
    } else {
      // Слот передаётся ожидающему напрямую в _release — счётчик не меняется.
      await new Promise((resolve) => {
        this._waiters.push(resolve);
      });
    }
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  _release() {
    const next = this._waiters.shift();
    if (next) next();
    else this._active -= 1;
  }
}
