// Описание env-переменных: обязательные и опциональные.
// Используется loadConfig() для валидации и формирования сообщения об ошибке.

export const VALID_LOG_LEVELS = Object.freeze([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

// "Псевдо-обязательные": нужен ИЛИ DATABASE_URL, ИЛИ полный набор DB_*.
// loadConfig() проверяет это отдельно.
export const DB_ENV_KEYS = Object.freeze({
  url: 'DATABASE_URL',
  host: 'DB_HOST',
  port: 'DB_PORT',
  name: 'DB_NAME',
  user: 'DB_USER',
  password: 'DB_PASSWORD',
});

// Опциональные. Логируются на debug-уровне, отсутствие — warn-лог,
// но loadConfig не падает.
export const OPTIONAL_ENV = Object.freeze([
  { key: 'MAX_BOT_TOKEN', group: 'max', usedBy: 'modules/max/maxClient.js' },
  { key: 'MAX_WEBHOOK_SECRET', group: 'max', usedBy: 'shared/http/maxSecretMiddleware.js' },
  { key: 'MAX_API_BASE_URL', group: 'max', usedBy: 'modules/max/maxClient.js' },
  { key: 'MAX_PUBLIC_WEBHOOK_URL', group: 'max', usedBy: 'scripts/register-webhook.js' },
  { key: 'MAX_WEBHOOK_UPDATE_TYPES', group: 'max', usedBy: 'scripts/register-webhook.js (optional override)' },
  { key: 'B24_PORTAL', group: 'b24', usedBy: 'modules/b24/b24Client.js' },
  // Без них install-callback отвечает 503 (fail-closed), а рефреш access_token невозможен.
  { key: 'B24_CLIENT_ID', group: 'b24', usedBy: 'POST /api/install + OAuth-рефреш (modules/b24/b24OAuth.js)' },
  { key: 'B24_CLIENT_SECRET', group: 'b24', usedBy: 'POST /api/install + OAuth-рефреш (modules/b24/b24OAuth.js)' },
  { key: 'B24_APPLICATION_TOKEN', group: 'b24', usedBy: 'modules/b24/b24Controller.js' },
  { key: 'OL_LINE_ID', group: 'b24', usedBy: 'modules/installations' },
  { key: 'B24_CONNECTOR_ID', group: 'b24', usedBy: 'scripts/register-connector.js' },
  { key: 'B24_CONNECTOR_NAME', group: 'b24', usedBy: 'scripts/register-connector.js' },
  {
    key: 'B24_PLACEMENT_HANDLER_URL',
    group: 'b24',
    usedBy: 'scripts/register-connector.js + modules/b24/b24Controller.js',
  },
  { key: 'B24_EVENT_HANDLER_URL', group: 'b24', usedBy: 'scripts/register-events.js' },
  // Reply/цитирование (двусторонний мост «ответ на сообщение»).
  {
    key: 'B24_REPLY_RESOLVE_OUTBOUND',
    group: 'b24',
    usedBy: 'modules/messaging/messagingService.js (routeOutbound: добор REPLY_ID)',
  },
  {
    key: 'REPLY_SEARCH_LIMIT',
    group: 'messaging',
    usedBy: 'modules/messaging/messagingService.js (im.dialog.messages.search LIMIT)',
  },
  {
    key: 'REPLY_QUOTE_MAX_LEN',
    group: 'messaging',
    usedBy: 'modules/messaging/messagingService.js (routeInbound: обрезка цитаты)',
  },
  // M29: очередь исходящих по чату и остановка с дренажом (есть дефолты).
  {
    key: 'OUTBOUND_QUEUE_MAX',
    group: 'messaging',
    usedBy: 'modules/messaging/messagingService.js (routeOutboundQueued: лимит очереди чата)',
  },
  {
    key: 'SHUTDOWN_DRAIN_TIMEOUT_MS',
    group: 'lifecycle',
    usedBy: 'server.js (gracefulShutdown: дедлайн дренажа очереди исходящих)',
  },
]);

export const DEFAULTS = Object.freeze({
  apiPort: 8000,
  // M20: trust proxy для req.ip (rate-limit, access-лог). Прод: Caddy → 127.0.0.1:5182 →
  // docker-proxy → контейнер видит шлюз bridge (172.16/12 = uniquelocal), не loopback.
  // При прямой публикации порта DNAT сохраняет публичный источник — XFF не доверяется.
  trustProxy: Object.freeze(['loopback', 'uniquelocal']),
  logLevel: 'debug',
  logLevelProd: 'info',
  // M20: канонический хост по доке/SDK MAX. Сертификат — Russian Trusted Sub CA →
  // нужен корень Минцифры в NODE_EXTRA_CA_CERTS (Dockerfile, certs/). dev.max.ru/api — сайт доки.
  maxApiBaseUrl: 'https://platform-api2.max.ru',
  // Подписываемся только на типы, которые контроллер действительно обрабатывает.
  // message_edited — нужен для INBOUND-правки (MAX→OL), бот MAX по дефолту на него НЕ подписан.
  // message_removed — нужен для INBOUND-удаления (MAX→OL), также не входит в дефолт-подписку бота.
  // chat_title_changed — переименование группы → название чата OL (M24).
  maxWebhookUpdateTypes: 'message_created,message_edited,message_removed,bot_added,bot_removed,user_added,user_removed,chat_title_changed',
  b24ConnectorId: 'max_b24',
  // Имя коннектора в Контакт-центре. Может быть переопределено env
  // B24_CONNECTOR_NAME (см. config/index.js) — на проде сверять.
  b24ConnectorName: 'Макс для групп',
  // Параметры медиа-флоу (опциональные env с дефолтами).
  // RETRY на шаге POST /messages — только «файл ещё обрабатывается» (HTTP 400
  // attachment.not.ready) и 429. Перезаливки файла НЕ делаем — ретраим только отправку.
  // M22: 14 попыток ≈ 150 с ожидания (паузы 1,2,4,8, дальше по 15 с): live 2026-10-08
  // файл 60 МБ стал готов через 16–31 с, линейно 256 МиБ — до ~135 с; видео 30 МБ — 3 с.
  maxUploadMaxRetries: 14,
  maxUploadRetryBaseMs: 1000,
  maxUploadRetryFactor: 2,
  // M22: лимит размера файла OL → MAX. 256 МиБ покрывает максимум MAX для видео/аудио;
  // файл идёт потоком через диск (≤ лимит × mediaConcurrency). Превышение → файл
  // пропускается, оператору — системное сообщение.
  mediaMaxBytes: 256 * 1024 * 1024,
  // M22: дедлайн одной передачи (скачивание из Б24 и заливка в MAX — каждая отдельно).
  mediaTransferTimeoutMs: 300_000,
  // M22: сколько файлов передаётся одновременно (на все вебхуки процесса).
  mediaConcurrency: 2,
  // M22: каталог временных файлов внутри os.tmpdir(), если MEDIA_TMP_DIR не задан.
  mediaTmpDirName: 'maxtob24-media',
  // M29: лимит очереди исходящих одного чата (принятые и незавершённые задания). Сверх него
  // задание выполняется сразу, без ожидания очереди и вне порядка (WARN): страховка от
  // зависшей передачи (худший случай ~1200 с: скачивание, две заливки по 300 с — вторая, если
  // MAX отверг тип и файл перезаливается как file (M28), — и два ожидания готовности по
  // ~150 с), а не рабочий режим — live-пачка 3 события (три файла с десктопа). Больше
  // outboundQueueMaxLimit — зажимается.
  outboundQueueMax: 20,
  outboundQueueMaxLimit: 1000,
  // M29: дедлайн дренажа очереди исходящих при SIGTERM/SIGINT (порт открыт всё это время).
  // stop_grace_period контейнера (180 с) минус закрытие порта и пула (≤ 5 с) и запас до
  // SIGKILL (5 с): жёсткий таймер процесса — дедлайн + 5 с = 175 с. Покрывает один проход
  // файла 256 МиБ на замеренной полосе с полным бюджетом готовности MAX (~150 с); перезаливка
  // отвергнутого типа файлом (M28) — второй проход, такая передача может не уложиться. Не
  // уложился — выход 1, прерванное оповестит следующий старт.
  shutdownDrainTimeoutMs: 170_000,
  // Reply/цитирование (двусторонний мост «ответ на сообщение»).
  //   resolveOutbound — звать ли im.dialog.messages.search на каждое исходящее
  //     (добор REPLY_ID для нативного reply OL→MAX); +1 REST/исходящее.
  //   searchLimit     — LIMIT окна im.dialog.messages.search (clamp ≤ 200 по доке).
  //   quoteMaxLen     — макс. длина текста родителя в [quote]-префиксе (MAX→OL).
  replyResolveOutbound: true,
  replySearchLimit: 50,
  replySearchLimitMax: 200,
  replyQuoteMaxLen: 200,
  // Security M13: rate-limit. install — строгий (редкий callback); webhook —
  // щадящий (легитимные бёрсты MAX/B24). Переопределяемы env (см. config/index.js).
  rateLimitInstallWindowMs: 15 * 60 * 1000, // 15 минут
  rateLimitInstallMax: 30,
  rateLimitWebhookWindowMs: 60 * 1000, // 1 минута
  rateLimitWebhookMax: 600, // ~10 rps — с запасом для бёрстов
});
