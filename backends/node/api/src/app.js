// Фабрика приложения. Никакой бизнес-логики и работы с process.env —
// всё приходит через config / pool / logger из server.js.
// Для unit-тестов pool и logger можно мокать через deps.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { buildHttpLogger } from './shared/logger/httpLogger.js';
import { verifyRawBody } from './shared/http/rawBody.js';
import { buildErrorHandler } from './shared/http/errorHandler.js';
import { buildMaxSecretMiddleware } from './shared/http/maxSecretMiddleware.js';
import { buildRateLimiters } from './shared/http/rateLimit.js';
import { buildHealthHandler } from './shared/http/health.js';
import { DEFAULTS } from './shared/config/schema.js';
import { KeyedQueue } from './shared/concurrency/keyedQueue.js';
import { MediaTempFiles } from './shared/media/tempFiles.js';
import { exchangeRefreshToken as b24ExchangeRefreshToken } from './modules/b24/b24OAuth.js';

import { InstallationsRepository } from './modules/installations/installationsRepository.js';
import { InstallationsService } from './modules/installations/installationsService.js';
import { InstallationsController } from './modules/installations/installationsController.js';

import { BindingsRepository } from './modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from './modules/bindings/participantMapRepository.js';
import { BindingsService } from './modules/bindings/bindingsService.js';

import { MessageLogRepository } from './modules/messaging/messageLogRepository.js';
import { MessagingService } from './modules/messaging/messagingService.js';

import { MaxClient } from './modules/max/maxClient.js';
import { MaxService } from './modules/max/maxService.js';
import { MaxController } from './modules/max/maxController.js';

import { B24Client } from './modules/b24/b24Client.js';
import { B24Service } from './modules/b24/b24Service.js';
import { B24Controller } from './modules/b24/b24Controller.js';

const ROUTES_MOUNTED = [
  'GET /',
  'GET /health',
  'POST /api/install',
  'POST /webhook/max',
  'POST /webhook/b24',
  'GET /b24/connector-settings',
];

// deps.exchangeRefreshToken — тестовый seam install-callback'а (M19): по умолчанию
// реальный обмен refresh_token на OAuth-сервере Б24; в тестах — стаб без сети.
export function buildApp(config, { pool, logger, exchangeRefreshToken } = {}) {
  if (!config) throw new TypeError('buildApp: config required');
  if (!pool) throw new TypeError('buildApp: pool required');
  if (!logger) throw new TypeError('buildApp: logger required');

  // -------- Repositories
  const installationsRepo = new InstallationsRepository(
    pool,
    logger.child({ module: 'installations' }),
  );
  const bindingsRepo = new BindingsRepository(pool, logger.child({ module: 'bindings' }));
  const participantMapRepo = new ParticipantMapRepository(
    pool,
    logger.child({ module: 'bindings' }),
  );
  const messageLogRepo = new MessageLogRepository(pool, logger.child({ module: 'messaging' }));

  // -------- Services
  // M19: подлинность публичного POST /api/install доказывает обмен refresh_token из
  // payload с нашими client creds (пара выдана нашему приложению) + client_endpoint
  // ответа = B24_PORTAL. Обмен приходит через DI: installations не импортирует b24/.
  const installationsService = new InstallationsService(
    installationsRepo,
    logger.child({ module: 'installations' }),
    {
      portal: config.b24.portal,
      clientId: config.b24.clientId,
      clientSecret: config.b24.clientSecret,
      exchangeRefreshToken: exchangeRefreshToken ?? b24ExchangeRefreshToken,
    },
  );

  const bindingsService = new BindingsService({
    bindingsRepository: bindingsRepo,
    participantMapRepository: participantMapRepo,
    installationsService,
    logger: logger.child({ module: 'bindings' }),
  });

  // Адаптеры: maxClient зависит от MAX_BOT_TOKEN, b24Client — от installationsService
  const maxClient = new MaxClient({
    baseUrl: config.max.apiBaseUrl,
    token: config.max.botToken,
    logger: logger.child({ module: 'max', layer: 'client' }),
    // M22: дедлайн заливки файла в MAX целиком.
    uploadTimeoutMs: config.media?.transferTimeoutMs,
  });
  const maxService = new MaxService({
    maxClient,
    messagingService: null, // прокинем после создания messagingService
    logger: logger.child({ module: 'max' }),
    // M11.2: readiness-retry шага POST /messages (upload-флоу OL → MAX).
    uploadRetry: {
      maxRetries: config.media?.maxUploadMaxRetries,
      baseMs: config.media?.maxUploadRetryBaseMs,
      factor: config.media?.maxUploadRetryFactor,
    },
  });

  const b24Client = new B24Client({
    installationsService,
    config: config.b24,
    logger: logger.child({ module: 'b24', layer: 'client' }),
  });
  const b24Service = new B24Service({
    b24Client,
    installationsService,
    messagingService: null,
    logger: logger.child({ module: 'b24' }),
  });

  // M29: очередь исходящих по чату — одна на процесс: её дренирует server.js при остановке.
  // Конфиг без секции outbound (тестовые) → дефолт лимита.
  const outboundQueue = new KeyedQueue({
    maxPerKey: config.outbound?.queueMax ?? DEFAULTS.outboundQueueMax,
  });

  // Координатор. Адаптер → координатор → адаптер — разрешённое направление.
  const messagingService = new MessagingService({
    bindingsService,
    b24Service,
    maxService,
    messageLogRepository: messageLogRepo,
    logger: logger.child({ module: 'messaging' }),
    // M11.2: лимит размера файла OL → MAX (config.media.maxBytes).
    mediaMaxBytes: config.media?.maxBytes,
    // M22: передача потоком через временный файл, с дедлайном и семафором.
    mediaTransferTimeoutMs: config.media?.transferTimeoutMs,
    mediaConcurrency: config.media?.concurrency,
    mediaTempFiles: config.media?.tmpDir
      ? new MediaTempFiles({ dir: config.media.tmpDir, logger: logger.child({ module: 'messaging' }) })
      : undefined,
    // Reply-флоу: настройки двустороннего моста «ответ на сообщение»
    // (resolveOutbound/searchLimit/quoteMaxLen).
    reply: config.reply,
    // M29: исходящие одного чата — по очереди (routeOutboundQueued).
    outboundQueue,
  });
  maxService.setMessagingService(messagingService);
  b24Service.setMessagingService(messagingService);

  // -------- Controllers
  const installationsCtrl = new InstallationsController(installationsService, {
    logger: logger.child({ module: 'installations', layer: 'controller' }),
  });
  const maxCtrl = new MaxController(
    maxService,
    logger.child({ module: 'max', layer: 'controller' }),
  );
  const b24Ctrl = new B24Controller({
    service: b24Service,
    installationsService,
    // M9: env-fallback B24_APPLICATION_TOKEN для верификации /webhook/b24,
    // когда токен в БД ещё NULL (install-callback «Только API» задержался).
    applicationToken: config.b24.applicationToken,
    logger: logger.child({ module: 'b24', layer: 'controller' }),
  });

  // -------- Middleware factories (нужны config.* — собираем здесь, не на верхнем уровне)
  // /webhook/max идёт под X-Max-Bot-Api-Secret middleware (plain secret-eq),
  // не HMAC (см. shared/http/maxSecretMiddleware.js).
  const maxSecretMiddleware = buildMaxSecretMiddleware(config.max.webhookSecret, {
    logger: logger.child({ module: 'max', layer: 'secret' }),
  });
  // Security M13 / M20: rate-limit публичных роутов. install — общий потолок
  // (защита client_id), вебхуки — щадящие per-IP бакеты, свой у MAX и у Б24.
  const { installLimiter, maxWebhookLimiter, b24WebhookLimiter } = buildRateLimiters(config.rateLimit, {
    logger: logger.child({ module: 'rate-limit' }),
  });

  // -------- App
  const app = express();
  app.disable('x-powered-by');
  // M20: req.ip = реальный клиент. Прод: Caddy → 127.0.0.1:5182 → docker-proxy →
  // контейнер видит шлюз bridge (uniquelocal), не loopback; Caddy перезаписывает XFF.
  // Значение — TRUST_PROXY (config), фолбэк — тест-конфигам без поля http.trustProxy.
  app.set('trust proxy', config.http?.trustProxy ?? DEFAULTS.trustProxy);
  // Security M13: security-заголовки. CSP отключаем — единственная HTML
  // (/b24/connector-settings) тривиальна и открывается в iframe B24-слайдера;
  // frameguard отключаем по той же причине (X-Frame-Options:DENY сломал бы фрейминг
  // плейсхолдера порталом). Остальные защиты (nosniff, HSTS за Caddy-TLS и пр.) активны.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      frameguard: false,
    }),
  );
  app.use(buildHttpLogger(logger));
  // raw body для будущей HMAC-проверки на /webhook/max (сейчас проверка — plain-secret)
  app.use(express.json({ limit: '256kb', verify: verifyRawBody }));
  // x-www-form-urlencoded: события Б24 (ONAPPINSTALL на /api/install, события на
  // /webhook/b24) приходят form-urlencoded с PHP-style ключами `auth[domain]=…`.
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));
  // Сужаем CORS с wildcard. Headless: кросс-оригин-браузер-вызовов нет
  // (вебхуки server-to-server, плейсхолдер — iframe, не XHR). Разрешаем только
  // origin портала (если задан), иначе кросс-оригин выключен.
  app.use(
    cors({
      origin: config.b24.portal ? [`https://${config.b24.portal}`] : false,
      methods: ['GET', 'POST'],
      credentials: false,
    }),
  );

  // API-only заглушка на корне. С M12.5 frontend снят, и Caddy catch-all `/`
  // уходит на api-node (:5182) — этот ответ видят health-пинги и любопытные.
  // Форма ответа — массив строк (исторический контракт, smoke-ассерт
  // Array.isArray в tests/app.smoke.test.js).
  app.get('/', (req, res) => {
    req.log?.debug({ requestId: req.id }, '[app] GET / root probe');
    res.json([
      'max-b24-connector',
      'mode: api-only',
      'routes: /api/*, /webhook/*, /b24/*, /health',
    ]);
  });
  // Публичный health (БЕЗ auth) — для внешнего мониторинга и Caddy-проб.
  // M13: JWT-only /api/health и POST /api/getToken удалены (вестигиальная
  // JWT-зона стартера: getToken выдавал 1-часовой JWT кому угодно, /api/health
  // дублировался публичным /health).
  app.get('/health', buildHealthHandler());
  // M19/M20: install под общим (не per-IP) потолком — каждый запрос может уйти
  // обменом refresh_token на oauth.bitrix.info; подлинность — обмен в сервисе.
  app.post('/api/install', installLimiter, installationsCtrl.handleInstall);

  // M20: вебхуки под per-IP лимитерами, у каждого свой бакет. На MAX секрет стоит
  // ДО лимитера: 401 дешёвый (без БД) и не расходует квоту. На Б24 токен сверяется
  // в контроллере (нужен SELECT installations) — лимитер раньше.
  app.post('/webhook/max', maxSecretMiddleware, maxWebhookLimiter, maxCtrl.handleWebhook);
  app.post('/webhook/b24', b24WebhookLimiter, b24Ctrl.handleWebhook);
  // PLACEMENT_HANDLER для imconnector.register — публичный, без middleware.
  app.get('/b24/connector-settings', b24Ctrl.getConnectorSettingsPlaceholder);

  app.use(
    buildErrorHandler({
      exposeStack: config.env !== 'production',
      // Security M13: в проде НЕ раскрываем err.details (включая сырое body
      // апстрима B24) в HTTP-ответе — только в серверном логе. Вне прода — раскрываем
      // для отладки. Проводка параллельна exposeStack (config.env !== 'production').
      exposeDetails: config.env !== 'production',
      logger: logger.child({ module: 'error-handler' }),
    }),
  );

  // M29: рантайм-ручки для server.js (дренаж очереди при остановке, разбор прерванных
  // передач после listen) и smoke-тестов (whenIdle до очистки БД).
  app.locals.outbound = Object.freeze({
    queue: outboundQueue,
    recoverInterrupted: (opts) => messagingService.recoverInterruptedOutbound(opts),
  });

  logger.info(
    {
      modules: ['installations', 'bindings', 'messaging', 'max', 'b24'],
      routes: ROUTES_MOUNTED,
    },
    'app composed',
  );

  return app;
}
