// Фабрика root-логгера pino. Уровень и pretty-режим выбираются по config.
// В prod — JSON, в dev — pino-pretty. Логгер фризится: модули получают child через .child().

import pino from 'pino';

const DEFAULT_REDACT_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.access_token',
  '*.refresh_token',
  '*.application_token',
  'config.db.password',
]);

export function buildLogger(config, overrides = {}) {
  const level = overrides.level ?? config.log.level;
  const isProduction = config.env === 'production';

  const baseOptions = {
    level,
    redact: {
      paths: [...DEFAULT_REDACT_PATHS, ...(overrides.extraRedactPaths ?? [])],
      censor: '[redacted]',
    },
    base: {
      pid: process.pid,
      service: 'maxtob24-api',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (!isProduction && level !== 'silent') {
    baseOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        singleLine: false,
        ignore: 'pid,hostname',
      },
    };
  }

  const logger = pino(baseOptions);
  if (level !== 'silent') {
    logger.info({ level, env: config.env }, 'logger initialized');
  }
  return logger;
}

export { DEFAULT_REDACT_PATHS };
