// pg Pool с детальным логированием. error на пуле — обязательно logger.error,
// иначе потеря соединения с БД будет тихой.

import pg from 'pg';

const { Pool } = pg;

export function buildPool(config, logger) {
  const opts = {
    max: 10,
    idleTimeoutMillis: 30_000,
    application_name: 'maxtob24-api',
  };

  if (config.db.url) {
    opts.connectionString = config.db.url;
  } else {
    opts.host = config.db.host;
    opts.port = config.db.port;
    opts.database = config.db.name;
    opts.user = config.db.user;
    opts.password = config.db.password;
  }

  const pool = new Pool(opts);
  const log = logger?.child ? logger.child({ module: 'db' }) : logger;

  if (log) {
    log.info(
      {
        host: config.db.host,
        port: config.db.port,
        name: config.db.name,
        max: opts.max,
        hasUrl: Boolean(config.db.url),
      },
      'db pool created',
    );

    // Потеря соединения с БД — это error.
    pool.on('error', (err) => {
      log.error(
        { err: { message: err.message, code: err.code, name: err.name } },
        'pg pool error',
      );
    });

    // Трассировка лайфцикла — только на trace, чтобы не шуметь на debug.
    pool.on('connect', () => log.trace('pg client connected'));
    pool.on('acquire', () => log.trace('pg client acquired from pool'));
    pool.on('remove', () => log.trace('pg client removed from pool'));
  }

  return pool;
}
