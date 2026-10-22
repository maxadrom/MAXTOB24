// M29: остановка без потерь исходящих. По SIGTERM/SIGINT порт остаётся открытым, пока очередь
// исходящих не опустеет и не ответят HTTP-запросы в работе: Б24 событий не повторяет, и
// закрытый порт означал бы потерянные сообщения операторов. Новые запросы за это время
// обслуживаются. Потом server.close, повторный дренаж на остаток дедлайна, pool.end и выход.
//
// Запросы в работе считаются наравне с очередью: событие Б24, ещё не дошедшее до очереди
// (проверка токена, резолв привязки, claim строки job:), очередь не видит — закрой порт по
// пустой очереди, и его задание пошло бы уже при закрытом порте, а события других чатов за
// это время получили бы 502. То же со входящим MAX → ОЛ в работе.
//
// Дедлайн дренажа — SHUTDOWN_DRAIN_TIMEOUT_MS. Не уложились — выход 1: строки job: в
// message_log остаются, и следующий старт оповестит оператора о прерванных передачах.
// Жёсткий таймер (дедлайн + closeTimeoutMs) завершает процесс, даже если закрытие повисло.
// Повторный SIGTERM дренаж не обрывает: Docker шлёт его заново на каждый docker stop, restart и
// пересоздание контейнера (параллельная остановка, повтор деплоя), а время и так ограничено
// дедлайном и жёстким таймером. SIGINT во время остановки (второй Ctrl+C в терминале) —
// немедленный выход 1.
//
// Keep-alive. После server.close Node продолжает принимать запросы по уже открытым keep-alive
// соединениям, а освободившееся соединение держит до keepAliveTimeout, и колбэк close ждёт его.
// Поэтому с первого сигнала все ответы, которые ещё не отправили заголовки, уходят с
// «Connection: close» (res.shouldKeepAlive = false): прокси не переиспользует соединение, и
// оно закрывается сразу после ответа, без гонки «прокси шлёт запрос в закрываемый сокет».
// Простаивающие соединения закрывает server.close, остальные — периодический closeIdleConnections.

// Предел таймера Node (2^31 − 1 мс): больше — setTimeout сработает через 1 мс.
const MAX_TIMER_MS = 2_147_483_647;

function errFields(err) {
  return { message: err?.message, code: err?.code };
}

export function createGracefulShutdown({
  server,
  queue,
  pool,
  logger,
  drainTimeoutMs,
  closeTimeoutMs = 5_000,
  idleSweepMs = 1_000,
  onSignal = () => {},
  exit = (code) => process.exit(code),
  now = Date.now,
} = {}) {
  if (typeof server?.close !== 'function') throw new TypeError('createGracefulShutdown: server required');
  if (typeof queue?.drain !== 'function') throw new TypeError('createGracefulShutdown: queue required');
  if (typeof pool?.end !== 'function') throw new TypeError('createGracefulShutdown: pool required');
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    throw new TypeError(`createGracefulShutdown: drainTimeoutMs must be a positive number (got ${drainTimeoutMs})`);
  }
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0) {
    throw new TypeError(`createGracefulShutdown: closeTimeoutMs must be a non-negative number (got ${closeTimeoutMs})`);
  }

  let started = false;
  let exited = false;
  let closing = false;
  // HTTP-ответы в работе (до и после сигнала) и ожидающие, когда их станет 0. Тем, что
  // пришли до сигнала, при сигнале ещё можно выставить «Connection: close».
  const inflight = new Set();
  let requestIdleWaiters = [];

  function requestDone(res) {
    inflight.delete(res);
    if (inflight.size > 0) return;
    const waiters = requestIdleWaiters;
    requestIdleWaiters = [];
    for (const resolve of waiters) resolve(true);
  }

  // prependListener — раньше обработчика Express: к его ответу заголовки ещё не ушли.
  // 'close' ответа — ответ отправлен или соединение оборвано.
  server.prependListener?.('request', (req, res) => {
    if (closing) res.shouldKeepAlive = false;
    inflight.add(res);
    res.once('close', () => requestDone(res));
  });

  // → true, когда запросов в работе 0 (сразу, если уже); false — вышло timeoutMs.
  function whenRequestsIdle(timeoutMs) {
    if (inflight.size === 0) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        requestIdleWaiters = requestIdleWaiters.filter((w) => w !== done);
        resolve(false);
      }, Math.min(timeoutMs, MAX_TIMER_MS));
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve(true);
      }
      requestIdleWaiters.push(done);
    });
  }

  // Дренаж до порта: очередь пуста и запросов в работе нет — одновременно, не дольше
  // дедлайна. Запросы кончились — очередь проверяется снова: задание могли поставить и не
  // из запроса (разбор прерванных), а за это время мог прийти новый запрос.
  // → { drained, pending, requests }.
  async function drainBeforeClose(deadlineAt) {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const q = await queue.drain(deadlineAt - now());
      if (!q.drained) return { drained: false, pending: q.pending, requests: inflight.size };
      if (inflight.size === 0) return { drained: true, pending: 0, requests: 0 };
      // eslint-disable-next-line no-await-in-loop
      const idle = await whenRequestsIdle(deadlineAt - now());
      if (!idle) return { drained: false, pending: queue.size, requests: inflight.size };
      if (queue.size === 0 && inflight.size === 0) return { drained: true, pending: 0, requests: 0 };
    }
  }

  function stopKeepAlive() {
    closing = true;
    for (const res of inflight) {
      if (!res.headersSent) res.shouldKeepAlive = false;
    }
  }

  // exit — один раз: после жёсткого таймера поздний колбэк close не зовёт его повторно.
  function exitOnce(code) {
    if (exited) return;
    exited = true;
    exit(code);
  }

  // server.close: порт закрыт, колбэк — когда закончились все HTTP-запросы и соединения.
  function closeServer() {
    return new Promise((resolve) => {
      let done = false;
      let sweep = null;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (sweep) clearInterval(sweep);
        if (err) logger?.error({ err: errFields(err) }, 'http server close error');
        else logger?.info('http server closed');
        resolve();
      };
      try {
        server.close(finish);
      } catch (err) {
        finish(err);
        return;
      }
      if (typeof server.closeIdleConnections !== 'function') return;
      server.closeIdleConnections();
      if (!done && idleSweepMs > 0) {
        sweep = setInterval(() => server.closeIdleConnections(), idleSweepMs);
        sweep.unref?.();
      }
    });
  }

  async function endPool() {
    try {
      await pool.end();
      logger?.info('pg pool closed');
    } catch (err) {
      logger?.error({ err: errFields(err) }, 'pg pool close error');
    }
  }

  return async function shutdown(signal) {
    if (started) {
      if (signal !== 'SIGINT') {
        logger?.warn({ signal }, 'shutdown: repeated signal ignored, still draining');
        return;
      }
      logger?.warn({ signal }, 'shutdown: second signal, force exit');
      exitOnce(1);
      return;
    }
    started = true;
    const startedAt = now();

    // server.js: прервать разбор прерванных — недоразобранное дождётся следующего старта.
    try {
      onSignal();
    } catch (err) {
      logger?.error({ err: errFields(err) }, 'shutdown: onSignal failed');
    }
    stopKeepAlive();
    logger?.info(
      { signal, pending: queue.size, requests: inflight.size, drainTimeoutMs },
      'shutdown requested: draining outbound queue (still listening)',
    );

    const hardTimeoutMs = drainTimeoutMs + closeTimeoutMs;
    const hardTimer = setTimeout(() => {
      logger?.error({ timeoutMs: hardTimeoutMs, pending: queue.size }, 'graceful shutdown timeout — force exit');
      exitOnce(1);
    }, Math.min(hardTimeoutMs, MAX_TIMER_MS));
    hardTimer.unref?.();

    try {
      const first = await drainBeforeClose(startedAt + drainTimeoutMs);
      if (first.drained) {
        logger?.info({ durationMs: now() - startedAt }, 'outbound queue drained');
      } else {
        logger?.error(
          { pending: first.pending, requests: first.requests, drainTimeoutMs },
          'drain timeout: interrupted jobs will be reported on next start',
        );
      }

      await closeServer();

      // Страховка: задания, принятые, пока закрывался порт (запрос пришёл по keep-alive
      // соединению). Обычно очередь уже пуста; остаток ≤ 0 — только проверка.
      const second = await queue.drain(drainTimeoutMs - (now() - startedAt));
      if (first.drained && !second.drained) {
        logger?.error(
          { pending: second.pending, requests: inflight.size, drainTimeoutMs },
          'drain timeout: interrupted jobs will be reported on next start',
        );
      }

      await endPool();
      clearTimeout(hardTimer);
      if (exited) return;
      const code = first.drained && second.drained ? 0 : 1;
      logger?.info({ signal, code, durationMs: now() - startedAt }, 'shutdown complete');
      exitOnce(code);
    } catch (err) {
      clearTimeout(hardTimer);
      logger?.error({ err: errFields(err) }, 'shutdown failed — force exit');
      exitOnce(1);
    }
  };
}
