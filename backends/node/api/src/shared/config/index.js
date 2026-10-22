// Единственная точка чтения process.env. В других модулях process.env.X запрещён —
// читаем только через config-объект, возвращаемый loadConfig().

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import {
  DB_ENV_KEYS,
  DEFAULTS,
  OPTIONAL_ENV,
  VALID_LOG_LEVELS,
} from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень backend (backends/node/api) — три уровня над src/shared/config; корень репо — ещё три.
// M26: до M26 было 5 уровней от config/ → backends/.env (файла нет): скрипты и server.js
// на хосте не видели корневой .env. В контейнере /app/../../../.env = /.env — файла нет,
// env даёт env_file compose.
const API_ROOT = path.resolve(__dirname, '../../..');
export const PROJECT_ROOT_ENV = path.resolve(API_ROOT, '../../../.env');

let dotenvLoaded = false;

// Один раз на процесс. override:false — env процесса (env_file compose, export в shell)
// главнее файла. Отсутствие .env допустимо. quiet — dotenv 17 иначе печатает
// «injected env …» в stdout на каждом config() (ломает JSON-вывод скриптов, шум в логе api).
export function loadDotenvOnce({ path: envPath = PROJECT_ROOT_ENV } = {}) {
  if (dotenvLoaded) return false;
  dotenvLoaded = true;
  dotenv.config({ path: envPath, override: false, quiet: true });
  return true;
}

function getEnv(key) {
  const value = process.env[key];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function buildDbConfig() {
  const url = getEnv(DB_ENV_KEYS.url);
  const host = getEnv(DB_ENV_KEYS.host);
  const port = getEnv(DB_ENV_KEYS.port);
  const name = getEnv(DB_ENV_KEYS.name);
  const user = getEnv(DB_ENV_KEYS.user);
  const password = getEnv(DB_ENV_KEYS.password);

  const hasFullDbSet = Boolean(host && port && name && user && password);

  if (!url && !hasFullDbSet) {
    throw new Error(
      `Config error: DATABASE_URL is required, or a full set of ${Object.values(DB_ENV_KEYS)
        .slice(1)
        .join(', ')} ` +
        '(used by shared/db/pool.js)',
    );
  }

  return Object.freeze({
    url: url ?? null,
    host: host ?? null,
    port: port ? Number(port) : null,
    name: name ?? null,
    user: user ?? null,
    password: password ?? null,
  });
}

function resolveLogLevel(rawLevel, nodeEnv) {
  const defaultLevel = nodeEnv === 'production' ? DEFAULTS.logLevelProd : DEFAULTS.logLevel;

  if (!rawLevel) {
    return { level: defaultLevel, fallback: false };
  }
  const lower = rawLevel.toLowerCase();
  if (VALID_LOG_LEVELS.includes(lower)) {
    return { level: lower, fallback: false };
  }
  // Невалидный — сигнализируем фолбэк (логгер залогирует warn при инициализации).
  return { level: 'info', fallback: true, original: rawLevel };
}

// M11.2: парсинг опциональной числовой env с дефолтом и валидацией.
// Пусто/undefined → дефолт. Непарсится/<= 0 → понятная ошибка старта (как остальной config).
function resolvePositiveNumber(key, fallback) {
  const raw = getEnv(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Config error: ${key} must be a positive number (got "${raw}")`);
  }
  return value;
}

// M11.2: настройки медиа-флоу (upload retry + лимит размера файла).
// M22: + дедлайн передачи, число одновременных передач, каталог временных файлов.
// Опциональные env с дефолтами из DEFAULTS — без новых обязательных секретов.
function buildMediaConfig() {
  return Object.freeze({
    maxUploadMaxRetries: resolvePositiveNumber('MAX_UPLOAD_MAX_RETRIES', DEFAULTS.maxUploadMaxRetries),
    maxUploadRetryBaseMs: resolvePositiveNumber('MAX_UPLOAD_RETRY_BASE_MS', DEFAULTS.maxUploadRetryBaseMs),
    maxUploadRetryFactor: resolvePositiveNumber('MAX_UPLOAD_RETRY_FACTOR', DEFAULTS.maxUploadRetryFactor),
    maxBytes: resolvePositiveNumber('MEDIA_MAX_BYTES', DEFAULTS.mediaMaxBytes),
    transferTimeoutMs: resolvePositiveNumber('MEDIA_TRANSFER_TIMEOUT_MS', DEFAULTS.mediaTransferTimeoutMs),
    concurrency: resolvePositiveInt('MEDIA_CONCURRENCY', DEFAULTS.mediaConcurrency),
    tmpDir: getEnv('MEDIA_TMP_DIR') ?? path.join(os.tmpdir(), DEFAULTS.mediaTmpDirName),
  });
}

// Reply: булевый env-флаг с дефолтом. Пусто/undefined → дефолт. Принимаем
// 1/0, true/false, yes/no, y/n, on/off (регистронезависимо). Неизвестное → дефолт.
function resolveBooleanEnv(key, fallback) {
  const raw = getEnv(key);
  if (raw === undefined) return fallback;
  const lower = raw.toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lower)) return false;
  return fallback;
}

// Позитивное целое. Пусто/undefined → дефолт. Непарсится/<= 0 → понятная ошибка старта
// (как resolvePositiveNumber). Значение больше max молча зажимается до max (напр. доковый
// предел LIMIT=200 для search).
function resolvePositiveInt(key, fallback, max = Number.POSITIVE_INFINITY) {
  const raw = getEnv(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Config error: ${key} must be a positive integer (got "${raw}")`);
  }
  return value > max ? max : value;
}

// Reply-флоу: двусторонний мост «ответ на сообщение». Опциональные env с
// дефолтами из DEFAULTS — без новых обязательных секретов.
function buildReplyConfig() {
  return Object.freeze({
    resolveOutbound: resolveBooleanEnv('B24_REPLY_RESOLVE_OUTBOUND', DEFAULTS.replyResolveOutbound),
    searchLimit: resolvePositiveInt('REPLY_SEARCH_LIMIT', DEFAULTS.replySearchLimit, DEFAULTS.replySearchLimitMax),
    quoteMaxLen: resolvePositiveNumber('REPLY_QUOTE_MAX_LEN', DEFAULTS.replyQuoteMaxLen),
  });
}

// M29: очередь исходящих по чату. queueMax — лимит заданий в очереди одного чата: сверх
// него задание выполняется без ожидания (см. KeyedQueue). Целое ≥ 1, больше предела —
// зажимается; невалидное → ошибка старта.
function buildOutboundConfig() {
  return Object.freeze({
    queueMax: resolvePositiveInt('OUTBOUND_QUEUE_MAX', DEFAULTS.outboundQueueMax, DEFAULTS.outboundQueueMaxLimit),
  });
}

// M29: остановка процесса — дедлайн дренажа очереди исходящих (server.js). Должен быть
// меньше stop_grace_period контейнера, иначе Docker добьёт процесс SIGKILL раньше.
function buildShutdownConfig() {
  return Object.freeze({
    drainTimeoutMs: resolvePositiveNumber('SHUTDOWN_DRAIN_TIMEOUT_MS', DEFAULTS.shutdownDrainTimeoutMs),
  });
}

// Security M13: rate-limit. Опциональные env с дефолтами из DEFAULTS —
// без новых обязательных секретов. Невалидное значение → понятная ошибка старта.
function buildRateLimitConfig() {
  return Object.freeze({
    installWindowMs: resolvePositiveNumber('RATE_LIMIT_INSTALL_WINDOW_MS', DEFAULTS.rateLimitInstallWindowMs),
    installMax: resolvePositiveNumber('RATE_LIMIT_INSTALL_MAX', DEFAULTS.rateLimitInstallMax),
    webhookWindowMs: resolvePositiveNumber('RATE_LIMIT_WEBHOOK_WINDOW_MS', DEFAULTS.rateLimitWebhookWindowMs),
    webhookMax: resolvePositiveNumber('RATE_LIMIT_WEBHOOK_MAX', DEFAULTS.rateLimitWebhookMax),
  });
}

// M20: TRUST_PROXY → значение express `trust proxy`. Пусто → DEFAULTS.trustProxy.
// `false` — не доверять никому; целое — число хопов; иначе CSV из пресетов
// (loopback|linklocal|uniquelocal) и IP/CIDR. `true`/`*` отклоняем: с ними клиент
// подставляет любой IP через X-Forwarded-For и обходит per-IP rate-limit.
const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isTrustProxyEntry(entry) {
  if (TRUST_PROXY_PRESETS.has(entry)) return true;
  const [ip, prefix, ...rest] = entry.split('/');
  const family = net.isIP(ip);
  if (!family || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function resolveTrustProxy() {
  const raw = getEnv('TRUST_PROXY');
  if (raw === undefined) return DEFAULTS.trustProxy;
  if (raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true' || raw === '*') {
    throw new Error(
      `Config error: TRUST_PROXY="${raw}" trusts any X-Forwarded-For — list proxy subnets instead`,
    );
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = entries.find((entry) => !isTrustProxyEntry(entry));
  if (entries.length === 0 || bad !== undefined) {
    throw new Error(
      `Config error: TRUST_PROXY must be false, a hop count or a CSV of loopback|linklocal|uniquelocal|IP|CIDR (got "${raw}")`,
    );
  }
  return Object.freeze(entries);
}

const MINTSIFRY_CA_HOSTS = new Set(['platform-api2.max.ru']);

function needsMintsifryCa(apiBaseUrl) {
  try {
    return MINTSIFRY_CA_HOSTS.has(new URL(apiBaseUrl).hostname);
  } catch {
    return false;
  }
}

function resolveHttpPort() {
  // API_PORT имеет приоритет над PORT.
  // PORT остаётся как фолбэк для совместимости с docker-compose, который проставляет PORT=8000.
  const apiPort = getEnv('API_PORT');
  const port = getEnv('PORT');
  const resolved = Number(apiPort ?? port ?? DEFAULTS.apiPort);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 65535) {
    throw new Error(
      `Config error: API_PORT/PORT must be a valid TCP port (got "${apiPort ?? port}")`,
    );
  }
  return resolved;
}

// M20: предупреждения о конфиге, которые нужны и боевому процессу: server.js зовёт
// loadConfig() без логгера (логгер строится из config) и логирует сводку сам.
export function logConfigWarnings(config, logger) {
  // platform-api2.max.ru подписан Russian Trusted Sub CA — без корня Минцифры Node
  // рвёт TLS (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). В Docker-образе он задан.
  if (config.max?.caMissing) {
    logger.warn(
      { apiBaseUrl: config.max.apiBaseUrl },
      'MAX API host needs Russian Trusted Root CA: set NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem or MAX_API_BASE_URL=https://botapi.max.ru',
    );
  }
}

export function loadConfig({ logger } = {}) {
  loadDotenvOnce();

  const nodeEnv = getEnv('NODE_ENV') ?? 'development';

  const db = buildDbConfig();
  const httpPort = resolveHttpPort();
  const trustProxy = resolveTrustProxy();
  const logLevelResult = resolveLogLevel(getEnv('LOG_LEVEL'), nodeEnv);
  const media = buildMediaConfig();
  const outbound = buildOutboundConfig();
  const shutdown = buildShutdownConfig();
  const reply = buildReplyConfig();
  const rateLimit = buildRateLimitConfig();
  const maxApiBaseUrl = getEnv('MAX_API_BASE_URL') ?? DEFAULTS.maxApiBaseUrl;

  // Опциональные — собираем "присутствие" и значения. Не падаем.
  const optionalPresence = {};
  for (const { key } of OPTIONAL_ENV) {
    optionalPresence[key] = Boolean(getEnv(key));
  }

  const config = Object.freeze({
    env: nodeEnv,
    http: Object.freeze({ port: httpPort, trustProxy }),
    db,
    log: Object.freeze({
      level: logLevelResult.level,
      levelFallback: logLevelResult.fallback,
      originalLevel: logLevelResult.original ?? null,
    }),
    max: Object.freeze({
      botToken: getEnv('MAX_BOT_TOKEN') ?? null,
      webhookSecret: getEnv('MAX_WEBHOOK_SECRET') ?? null,
      apiBaseUrl: maxApiBaseUrl,
      // M20: хост требует корень Минцифры, а NODE_EXTRA_CA_CERTS не задан (запуск вне
      // Docker-образа) → TLS к MAX упадёт. Сам env читается только здесь.
      caMissing: needsMintsifryCa(maxApiBaseUrl) && !getEnv('NODE_EXTRA_CA_CERTS'),
      // M3: HTTPS-URL до /webhook/max — читает scripts/register-webhook.js.
      publicWebhookUrl: getEnv('MAX_PUBLIC_WEBHOOK_URL') ?? null,
      // M3: whitelist update_types (CSV → array). Default — DEFAULTS.maxWebhookUpdateTypes.
      webhookUpdateTypes: (getEnv('MAX_WEBHOOK_UPDATE_TYPES') ?? DEFAULTS.maxWebhookUpdateTypes)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    b24: Object.freeze({
      portal: getEnv('B24_PORTAL') ?? null,
      clientId: getEnv('B24_CLIENT_ID') ?? null,
      clientSecret: getEnv('B24_CLIENT_SECRET') ?? null,
      applicationToken: getEnv('B24_APPLICATION_TOKEN') ?? null,
      olLineId: getEnv('OL_LINE_ID') ? Number(getEnv('OL_LINE_ID')) : null,
      connectorId: getEnv('B24_CONNECTOR_ID') ?? DEFAULTS.b24ConnectorId,
      connectorName: getEnv('B24_CONNECTOR_NAME') ?? DEFAULTS.b24ConnectorName,
      placementHandlerUrl: getEnv('B24_PLACEMENT_HANDLER_URL') ?? null,
      // M5.1: HTTPS-URL до POST /webhook/b24 — читает scripts/register-events.js (event.bind).
      eventHandlerUrl: getEnv('B24_EVENT_HANDLER_URL') ?? null,
    }),
    // M11.2: медиа-флоу — upload retry (пока MAX готовит вложение) + лимит размера файла.
    media,
    // M29: очередь исходящих по чату (queueMax) и дренаж при остановке (drainTimeoutMs).
    outbound,
    shutdown,
    // Reply-флоу: двусторонний мост «ответ на сообщение» (resolveOutbound/searchLimit/quoteMaxLen).
    reply,
    // Security M13: rate-limit публичных роутов (install строгий, webhook щадящий).
    rateLimit,
    optional: Object.freeze(optionalPresence),
  });

  if (logger) {
    logger.info(
      {
        env: config.env,
        db: { host: config.db.host, port: config.db.port, name: config.db.name, hasUrl: Boolean(config.db.url) },
        log: { level: config.log.level },
        http: { port: config.http.port, trustProxy: config.http.trustProxy },
        b24: {
          portal: config.b24.portal,
          olLineId: config.b24.olLineId,
          connectorId: config.b24.connectorId,
          hasPlacementHandlerUrl: Boolean(config.b24.placementHandlerUrl),
          hasEventHandlerUrl: Boolean(config.b24.eventHandlerUrl),
        },
        max: {
          hasBotToken: Boolean(config.max.botToken),
          hasWebhookSecret: Boolean(config.max.webhookSecret),
          hasPublicWebhookUrl: Boolean(config.max.publicWebhookUrl),
          webhookUpdateTypes: config.max.webhookUpdateTypes,
          apiBaseUrl: config.max.apiBaseUrl,
        },
      },
      'config loaded',
    );
    logger.debug({ optional: config.optional }, 'optional env presence');
    // M11.2: резолвнутые media-настройки (значения, не секреты).
    logger.debug({ media: config.media }, 'media flow config resolved');
    // M29: очередь исходящих и дренаж при остановке.
    logger.debug({ outbound: config.outbound, shutdown: config.shutdown }, 'outbound queue config resolved');
    // Reply-флоу: резолвнутые настройки (значения, не секреты).
    logger.debug({ reply: config.reply }, 'reply flow config resolved');
    if (config.log.levelFallback) {
      logger.warn(
        { provided: config.log.originalLevel, fallback: config.log.level },
        'LOG_LEVEL value is not in fatal|error|warn|info|debug|trace|silent — fallback to info',
      );
    }
    logConfigWarnings(config, logger);
    for (const { key, usedBy } of OPTIONAL_ENV) {
      if (!config.optional[key]) {
        logger.warn({ key, usedBy }, 'optional env missing — feature disabled until M2+');
      }
    }
  }

  return config;
}

export { DEFAULTS, VALID_LOG_LEVELS };
