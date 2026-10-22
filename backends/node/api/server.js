// Точка входа. Никакой бизнес-логики — только bootstrap:
// config → logger → pool → buildApp → app.listen + graceful shutdown.
// M29: после listen — разбор передач, прерванных прошлым процессом; по SIGTERM/SIGINT —
// дренаж очереди исходящих с открытым портом (src/shared/lifecycle/gracefulShutdown.js).

import { loadConfig, logConfigWarnings } from './src/shared/config/index.js';
import { buildLogger } from './src/shared/logger/index.js';
import { buildPool } from './src/shared/db/pool.js';
import { buildApp } from './src/app.js';
import { MediaTempFiles } from './src/shared/media/tempFiles.js';
import { createGracefulShutdown } from './src/shared/lifecycle/gracefulShutdown.js';

async function main() {
  // Создаём минимальный pre-logger, чтобы loadConfig мог логировать
  // (но используем уровень из process.env напрямую как fallback —
  // тут ещё нет config).
  const config = loadConfig();
  const logger = buildLogger(config);
  // Повторяем log "config loaded" с настоящим логгером (loadConfig вызывался без logger)
  logger.info(
    {
      env: config.env,
      http: { port: config.http.port, trustProxy: config.http.trustProxy },
      log: { level: config.log.level },
      db: { hasUrl: Boolean(config.db.url), host: config.db.host, name: config.db.name },
      max: { apiBaseUrl: config.max.apiBaseUrl },
    },
    'config loaded',
  );
  logConfigWarnings(config, logger);

  const pool = buildPool(config, logger);

  // M22: остатки временных файлов медиа от прошлого процесса (рестарт посреди передачи).
  // Best-effort: старт моста важнее чистки.
  await new MediaTempFiles({ dir: config.media.tmpDir, logger }).sweep().catch((err) => {
    logger.warn({ err: { message: err?.message } }, 'media temp sweep failed');
  });

  // M29: строки job: в message_log с created_at раньше этой отметки оставил прошлый процесс
  // (рестарт посреди передачи) — их разбирает восстановление после listen. Свои задания
  // процесс пишет позже отметки, и восстановление их не трогает.
  const bootAt = new Date();
  const app = buildApp(config, { pool, logger });
  const { outbound } = app.locals;
  // Остановка прерывает разбор прерванных: недоразобранные строки дождутся следующего старта.
  const recovery = new AbortController();

  // M29: listen не ждёт БД. У пула нет connectionTimeoutMillis, и запрос к недоступной БД
  // до listen повесил бы старт. Разбор прерванных идёт после listen, не блокируя приём
  // событий, через очередь исходящих (с повторами поиска, если БД ещё не поднялась).
  const server = app.listen(config.http.port, () => {
    logger.info({ port: config.http.port }, 'server listening');
    outbound.recoverInterrupted({ createdBefore: bootAt, signal: recovery.signal }).catch((err) => {
      logger.warn({ err: { message: err?.message } }, 'interrupted outbound recovery failed');
    });
  });

  const shutdown = createGracefulShutdown({
    server,
    queue: outbound.queue,
    pool,
    logger,
    drainTimeoutMs: config.shutdown.drainTimeoutMs,
    onSignal: () => recovery.abort(),
  });

  // Обработчики обязательны. В контейнере node — PID 1 (CMD ["node","server.js"]), а ядро не
  // применяет к PID 1 действие сигнала по умолчанию: без обработчика SIGTERM игнорируется, и
  // docker stop заканчивается SIGKILL по истечении stop_grace_period — без дренажа.
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaughtException');
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
