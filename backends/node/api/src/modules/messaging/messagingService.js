// Координатор inbound/outbound. Единственная точка, где живёт идемпотентность
// и audit-лог. Адаптеры max/b24 НЕ знают друг про друга.
// Каждый маршрут: resolve binding → _once(find → эффект во внешней системе → record).
// routeInbound (+ Edit/Delete) — MAX → OL;
// routeOutbound (+ Edit/Delete) — OL → MAX; routeLifecycle — системные уведомления;
// routeChatTitleChanged — название чата OL из названия MAX-группы (M24) и второй сигнал
// закрытия сессии: CHAT_RENAMING_FAILED при закрытой сессии взводит опенер (M27);
// routeDialogFinish — сессия OL закрыта, следующую откроет «группа» (M25).
// routeOutboundQueued (M29) — вход исходящих из вебхука: очередь по чату поверх
// routeOutbound (+ Edit/Delete), строка задания job: в журнале на время выполнения.

import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../../shared/config/schema.js';
import { KeyedQueue } from '../../shared/concurrency/keyedQueue.js';
import { Semaphore } from '../../shared/concurrency/semaphore.js';
import { ValidationError } from '../../shared/http/domainErrors.js';
import { contentHash } from '../../shared/crypto/contentHash.js';
import { MediaTooLargeError } from '../../shared/media/mediaTooLargeError.js';
import { MediaTempFiles } from '../../shared/media/tempFiles.js';
import { ConnectorMessage } from '../b24/models/ConnectorMessage.js';
import {
  bbcodeToMarkdown,
  buildReplyQuoteBbcode,
  escapeBbcode,
  markupToBbcode,
  resolveMediaCaption,
} from '../b24/bbcode.js';
import { MaxApiError } from '../max/maxApiError.js';
import { maxUploadTypeForFile } from '../max/maxService.js';
import { MaxMessage } from '../max/models/MaxMessage.js';
import { sameOlTitle } from './olChatTitle.js';
import {
  deleteFailureNotice,
  deleteWindowNotice,
  deliveryFailureReason,
  editFailureNotice,
  fileLabel,
  INTERNAL_FAILURE_REASON,
  isTextTooLongFailure,
  isUncertainFailure,
  RESTART_FAILURE_REASON,
  sendFailureItem,
  sendFailureNotice,
  sendUncertainNotice,
} from './operatorNotices.js';

const MAX_TEXT_PREFIX = 32;
const MAX_OUTBOUND_FORMAT = 'markdown';

// M29: задание очереди исходящих отмечено строкой message_log с ключом job:<ключ операции>
// и status 'in_progress' (messageLogRepository.claimOutboundJob): пишется до отправки в MAX,
// снимается по завершении. Строка, оставшаяся после рестарта, — прерванная передача.
const OUTBOUND_JOB_PREFIX = 'job:';
// Вид исходящего → маршрут: fn — имя в логах, op — вид для notifyOperator, errorVerdict —
// вердикт внутренней ошибки best-effort правки и удаления (у отправки его нет: ошибка → 500).
const OUTBOUND_ROUTES = Object.freeze({
  add: Object.freeze({ fn: 'routeOutbound', op: 'send' }),
  edit: Object.freeze({ fn: 'routeOutboundEdit', op: 'edit', errorVerdict: 'edit-error' }),
  delete: Object.freeze({ fn: 'routeOutboundDelete', op: 'delete', errorVerdict: 'delete-error' }),
});

// M29: ключ операции исходящего — один источник для записи результата (_once) и строки
// задания (job:<ключ>). Отправка — «голый» b24MsgId; правка — edit:<b24MsgId>:<хеш текста>
// (см. _routeOutboundEditOne); удаление — delete:<b24MsgId>.
function outboundOpKey(kind, m) {
  if (kind === 'add') return String(m.b24MsgId);
  if (kind === 'edit') return `edit:${m.b24MsgId}:${contentHash(m.text)}`;
  if (kind === 'delete') return `delete:${m.b24MsgId}`;
  throw new TypeError(`outboundOpKey: unknown kind "${kind}"`);
}

// M29: что отправляется — в payload_meta строки задания отправки: по именам файлов
// оператор узнает сообщение в оповещении о прерванной передаче (без цитаты текста);
// textPrefix — только для итоговой записи при восстановлении. hasText — есть подпись
// (при файлах) или текст.
function outboundJobContent(m) {
  const files = Array.isArray(m.files) ? m.files : [];
  const text = files.length > 0 ? resolveMediaCaption(m.text, files) : bbcodeToMarkdown(m.text);
  return {
    textPrefix: text.slice(0, MAX_TEXT_PREFIX),
    hasText: Boolean(text),
    filesCount: files.length,
    fileNames: files.map((f) => f?.name ?? null),
  };
}

// M29: id сообщений MAX из события правки/удаления (message.id) — строки без пустых.
function outboundEventMids(m) {
  return Array.isArray(m?.externalIds) ? m.externalIds.filter(Boolean).map(String) : [];
}

// M29: оповещение о прерванной передаче не ушло (Б24 сбоит) → ещё попытки с этими паузами;
// дальше строка задания снимается с ERROR — повторного оповещения на следующем старте нет.
const RECOVERY_NOTICE_RETRY_MS = Object.freeze([2_000, 5_000]);

// M29: строка задания не снялась (сбой БД) → повторы в фоне с этими паузами (~12,5 мин в
// сумме: рестарт Postgres, кратковременный сбой). Без них строка висела бы до следующего
// старта процесса (хоть дни), и разбор прислал бы оператору запоздалое оповещение
// «мост перезапускался» — в том числе о задании, которое закончилось и уже оповестило сам.
const RELEASE_RETRY_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);

// M29: пауза с таймером unref; signal (остановка процесса) прерывает её досрочно.
function pause(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

// External id входящего MAX-сообщения в OL. На него же ссылаются правка/удаление
// (тот же id, что у оригинала) и reply-резолв OL→MAX (CONNECTOR_MID родителя).
const EXTERNAL_MID_PREFIX = 'max:mid:';

function toExternalMid(mid) {
  return `${EXTERNAL_MID_PREFIX}${mid}`;
}

// M24: интро группы — первое сообщение нового чата OL от псевдо-пользователя «группа».
// External id начинается с 'max:', но за ним нет сообщения MAX: reply оператора на интро
// (и на опенер сессии M25) уходит без link (см. _resolveReplyMaxMid). Пользователь
// коннектора — 'group:<chatId>' (MAX user_id числовые, коллизий нет).
const CONNECTOR_ID_PREFIX = 'max:';
const GROUP_INTRO_MID_PREFIX = 'max:group-intro:';
const GROUP_USER_PREFIX = 'group:';
// Имя «группы», если от названия после санитизации ничего не осталось (одни эмодзи).
const GROUP_FALLBACK_NAME = 'Группа MAX';

// M21: сообщение без mid (по доке MAX body бывает null у пересылки без своего текста).
// Ключ message_log — nomid:<chatId>:<senderId>:<timestamp> (timestamp стабилен на ретраях
// одного события, как у lifecycle), external id — 'max:' + ключ. Префикс не 'max:mid:',
// поэтому reply оператора на такое сообщение уходит без link (см. _resolveReplyMaxMid),
// а правка и удаление его в OL недостижимы: в их событиях будет уже настоящий mid.
const NOMID_KEY_PREFIX = 'nomid:';

// M21: ключ идемпотентности и external id входящего сообщения. null — ключ не построить
// (нет ни mid, ни timestamp): без ключа ретраи MAX дублировали бы сообщение.
function inboundRef(maxUpdate) {
  const mid = maxUpdate.mid ?? null;
  if (mid !== null && mid !== '') return { key: mid, externalId: toExternalMid(mid) };
  const ts = maxUpdate.timestamp ?? null;
  if (ts === null) return null;
  const key = `${NOMID_KEY_PREFIX}${maxUpdate.chatId}:${maxUpdate.senderId ?? 'na'}:${ts}`;
  return { key, externalId: `${CONNECTOR_ID_PREFIX}${key}` };
}

// M25: опенер — первое сообщение каждой следующей сессии OL от той же «группы» (клиент
// сессии = автор её первого сообщения). Ключ message_log и external id (с префиксом
// 'max:'): group-session:<chatId>:<закрытая сессия>:<mid триггерного сообщения>.
const GROUP_SESSION_KEY_PREFIX = 'group-session:';

// Текст интро. Название задаёт пользователь MAX — экранируем BB-теги.
function groupIntroText(title) {
  return `Группа «${escapeBbcode(title)}» в MAX подключена к Открытой линии`;
}

// M25: текст опенера.
function groupSessionText(title) {
  return `Новое обращение из группы «${escapeBbcode(title)}» в MAX`;
}

// M27: ссылка на MAX-группу — системным сообщением в чате OL (im.message.add SYSTEM=Y: в
// коннектор и в MAX не уходит). Ключ message_log — group-link:<chatId>:<hash ссылки>: та же
// ссылка второй раз не постится, перевыпущенная MAX — уходит под новым ключом. Саму ссылку
// не пишем ни в журнал, ни в логи: это приглашение в закрытую группу клиента.
const GROUP_LINK_KEY_PREFIX = 'group-link:';

function groupLinkKey(maxChatId, link) {
  return `${GROUP_LINK_KEY_PREFIX}${maxChatId}:${contentHash(link)}`;
}

// Шапку [b]MAXTOB24[/b] (имя приложения) Б24 ставит перед системным сообщением сам — свой
// заголовок не добавляем. Форму ссылки проверяет maxService.getChatInfo; BB-теги всё равно
// экранируем, как любой текст из MAX.
function groupLinkText(link) {
  return `Ссылка на группу в MAX: ${escapeBbcode(link)}`;
}

// M25: id сессии OL (session.ID приходит строкой) → положительное целое либо null.
function toSessionId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// MAX timestamp — В МИЛЛИСЕКУНДАХ, B24 ждёт секунды. Нет значения → текущее время.
function toUnixSeconds(ms) {
  return Math.floor((ms || Date.now()) / 1000);
}

// M28: сколько часов прошло с момента (Date из pg или строка) либо null — момента нет.
function hoursSince(at) {
  if (at === null || at === undefined) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}

// Заголовочный guard inbound-маршрутов: ожидаемый update_type и chatId обязательны.
function assertMaxUpdate(maxUpdate, expectedType, fn) {
  if (maxUpdate?.updateType !== expectedType) {
    throw new ValidationError(
      `${fn}: only ${expectedType} supported (got "${maxUpdate?.updateType ?? 'unknown'}")`,
    );
  }
  if (maxUpdate.chatId === null || maxUpdate.chatId === undefined) {
    throw new ValidationError(`${fn}: maxUpdate.chatId required`);
  }
}

// M-lifecycle: текст системного уведомления о вступлении/выходе участника.
// BB-код [b]…[/b] рендерит имя жирным; имя приложения ([b]MAXTOB24[/b]) дописывает
// сам Б24 сверху — второй раз его НЕ добавляем. Имя задаёт пользователь MAX —
// экранируем BB-теги, иначе `[/b][url=…]` в имени станет ссылкой в чате оператора.
function membershipText(type, name) {
  const safeName = escapeBbcode(name);
  if (type === 'user_added') return `👋 Новое вступление в группу [b]${safeName}[/b]`;
  return `🚪 Участник покинул группу [b]${safeName}[/b]`;
}

// Методы message_log по направлению: inbound ключуется max_mid, outbound — b24_msg_id.
const LOG_OPS = {
  inbound: {
    find: (repo, bindingId, key) => repo.findInbound(bindingId, key),
    record: (repo, bindingId, key, payloadMeta) =>
      repo.recordInbound({ bindingId, maxMid: key, payloadMeta }),
  },
  outbound: {
    find: (repo, bindingId, key) => repo.findOutbound(bindingId, key),
    record: (repo, bindingId, key, payloadMeta) =>
      repo.recordOutbound({ bindingId, b24MsgId: key, payloadMeta }),
  },
};

export class MessagingService {
  constructor({
    bindingsService,
    b24Service,
    maxService,
    messageLogRepository,
    logger,
    mediaMaxBytes,
    mediaTransferTimeoutMs,
    mediaConcurrency,
    mediaTempFiles,
    reply,
    outboundQueue,
  }) {
    if (!bindingsService) throw new TypeError('MessagingService: bindingsService required');
    if (!messageLogRepository) throw new TypeError('MessagingService: messageLogRepository required');
    this.bindings = bindingsService;
    this.b24 = b24Service ?? null;
    this.max = maxService ?? null;
    this.log = messageLogRepository;
    this.logger = logger;
    // M11.2: лимит размера файла OL → MAX (config.media.maxBytes). Превышение → файл
    // пропускается, оператору — системное сообщение (M22). Без значения — без лимита.
    this.mediaMaxBytes = mediaMaxBytes ?? Number.POSITIVE_INFINITY;
    // M22: передача файла — потоком через временный файл, не больше mediaConcurrency
    // одновременно на процесс, каждая передача (скачивание, заливка) — с дедлайном.
    this.mediaTransferTimeoutMs = mediaTransferTimeoutMs ?? DEFAULTS.mediaTransferTimeoutMs;
    this._mediaSlots = new Semaphore(mediaConcurrency ?? DEFAULTS.mediaConcurrency);
    this.mediaTemp = mediaTempFiles
      ?? new MediaTempFiles({ dir: path.join(os.tmpdir(), DEFAULTS.mediaTmpDirName), logger });
    // Reply-флоу: настройки двустороннего моста «ответ на сообщение». Безопасный
    // дефолт (resolveOutbound:false) для CLI/тестов без полного config — чтобы
    // отсутствие проводки НЕ включало случайно +1 REST на каждое исходящее.
    this.reply = reply ?? { resolveOutbound: false, searchLimit: 50, quoteMaxLen: 200 };
    // M10: дедуп best-effort аватаров по паре (bindingId:senderId) за время жизни
    // процесса — чтобы не дёргать getChatMember на каждое входящее сообщение.
    this._avatarTried = new Set();
    // M24: цепочки _serialized по bindingId — своя очередь, не outboundQueue: шаги входящих
    // не ждут заливку файлов исходящих.
    this._bindingSteps = new KeyedQueue();
    // M27: привязки, по которым в этом процессе шаг ссылки на группу уже был — GET /chats
    // в интро, опенере или ленивом пути либо найденная запись group-link:. Ленивый путь
    // больше не дёргает ни БД, ни MAX; повтор — на опенере новой сессии или после рестарта.
    this._linkChecked = new Set();
    // M29: очередь исходящих по чату (routeOutboundQueued). app.js отдаёт свою — с лимитом
    // OUTBOUND_QUEUE_MAX, её же дренирует server.js при остановке; по умолчанию — без
    // лимита (unit-тесты, CLI).
    this.outboundQueue = outboundQueue ?? new KeyedQueue();
  }

  // M24: шаги по одной привязке выполняются по очереди (интро группы, синхронизация
  // названия): «пачка» первых сообщений не шлёт два интро и не обгоняет его, параллельные
  // переименования не оставляют в OL устаревшее название. FIFO по ключу (KeyedQueue); ошибка
  // шага не рвёт цепочку. Блокировка внутри процесса: api-node — один процесс (single-tenant).
  _serialized(key, fn) {
    return this._bindingSteps.push(key, fn);
  }

  // Текст inbound для OL: MAX body.markup (offset/length/type) → BB-коды (M5.3) +
  // reply/forward-цитата. markupToBbcode экранирует пользовательские BB-теги ([b]/[i]) —
  // инъекция нейтрализуется. Коннектор Б24 не переносит нативный reply, поэтому связь
  // «ответ/пересылка» эмулируем визуальной цитатой `>>` в начале текста (тега [quote] в
  // чатах Б24 нет — рендерится литерально; см. bbcode.js).
  _buildInboundText(maxUpdate, bindingId, log, fn) {
    const maxBody = maxUpdate.message?.body ?? {};
    const text = markupToBbcode(maxBody.text ?? '', maxBody.markup);
    const replyContext = maxUpdate.replyContext ?? null;
    if (!replyContext) return text;
    const quotePrefix = buildReplyQuoteBbcode(replyContext, { maxLen: this.reply.quoteMaxLen });
    if (!quotePrefix) return text;
    log?.debug(
      {
        bindingId,
        mid: maxUpdate.mid ?? null,
        replyType: replyContext.type,
        parentSenderNamePresent: Boolean(replyContext.parentSenderName),
        parentTextLen: (replyContext.parentText ?? '').length,
        quoteLen: quotePrefix.length,
      },
      `${fn}: inbound reply quote prefixed`,
    );
    return quotePrefix + text;
  }

  // Персист адреса OL-чата (session.CHAT_ID) на binding'е — best-effort. Нужен для
  // системных lifecycle-уведомлений (im.message.add вне активной сессии); ошибка
  // персиста НЕ валит основной поток. Значение стабильно между сессиями (проверено live):
  // пишем, только когда оно появилось впервые или изменилось — лишний UPDATE не плодим.
  async _persistB24ChatId(binding, b24ChatId, log, fn) {
    if (!b24ChatId || binding.b24ChatId === b24ChatId) return;
    try {
      await this.bindings.attachB24ChatId(binding.id, b24ChatId);
      binding.b24ChatId = b24ChatId;
      log?.debug({ bindingId: binding.id, b24ChatId }, `${fn}: b24ChatId persisted`);
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, err: { message: err?.message } },
        `${fn}: b24ChatId persist failed (best-effort)`,
      );
    }
  }

  // Inbound-правка/удаление применимы только к сообщению, которое дошло до OL:
  // запись оригинала в message_log по «голому» mid. Нет записи — сообщение не доходило
  // до Б24 (empty-message, эхо бота, чат до привязки): update/delete.messages вернули
  // бы SUCCESS=false → 500 → бесполезные ретраи MAX. Возвращает запись либо null.
  async _findInboundOriginal(bindingId, mid, log, fn) {
    const orig = await this.log.findInbound(bindingId, mid);
    if (!orig) {
      log?.warn(
        { bindingId, mid },
        `${fn}: original not in message_log (never reached Open Line), skipping`,
      );
    }
    return orig;
  }

  // Каркас идемпотентности всех маршрутов: find → effect → record → duplicate-race.
  //   key    — «голый» id (mid / b24MsgId) либо синтетический (edit:/delete:/lifecycle),
  //            чтобы правка/удаление не схлопнулись с записью оригинала;
  //   effect — побочный эффект во внешней системе. Возвращает { skipped } (проброс без
  //            записи) либо { payloadMeta, result, logFields }. Ошибка effect летит наружу
  //            без записи — отправитель вебхука ретраит;
  //   done   — хвост INFO-лога успеха;
  //   quietDuplicate — дубль пишется DEBUG, а не WARN (повтор — норма, не ретрай).
  // Запись — INSERT ON CONFLICT DO NOTHING: пустой результат = конкурентный ретрай уже
  // записал факт (эффект применён дважды не по нашей вине) → duplicate-race.
  // Успех → { ...result, logId }.
  async _once({ direction, bindingId, key, fn, log, duplicate = 'duplicate', quietDuplicate = false, done }, effect) {
    // M21: пустой ключ — ошибка вызывающего, а не тихий пропуск дедупа: find по null
    // ничего не находит, а NULL в message_log обходит частичный уникальный индекс.
    if (key === null || key === undefined || key === '') {
      throw new TypeError(`${fn}: idempotency key required`);
    }
    const ops = LOG_OPS[direction];
    log?.debug({ bindingId, key }, `${fn}: dedup check`);
    const existing = await ops.find(this.log, bindingId, key);
    if (existing) {
      log?.[quietDuplicate ? 'debug' : 'warn']({ bindingId, key, logId: existing.id }, `${fn}: ${duplicate}, skipping`);
      return { skipped: duplicate, logId: existing.id };
    }

    const startedAt = Date.now();
    const outcome = await effect();
    if (outcome.skipped) return outcome;

    const recorded = await ops.record(this.log, bindingId, key, outcome.payloadMeta);
    if (!recorded) {
      log?.info({ bindingId, key }, `${fn}: duplicate-race (concurrent insert), effect already applied`);
      return { skipped: 'duplicate-race' };
    }
    log?.info(
      { bindingId, ...outcome.logFields, logId: recorded.id, durationMs: Date.now() - startedAt },
      `${fn}: ${done}`,
    );
    return { ...outcome.result, logId: recorded.id };
  }

  // Единственный ERROR-лог сбоя вызова Б24 в inbound-маршрутах (b24Service его не пишет).
  // Пишем до проброса: дальше ошибка уходит в errorHandler → 500 → MAX ретраит.
  _logB24Failure(log, fn, method, fields, err) {
    log?.error(
      {
        ...fields,
        method,
        b24Code: err?.b24Code ?? null,
        b24Description: err?.b24Description ?? null,
        err: { message: err?.message },
      },
      `${fn}: B24 call failed, not recording (MAX will retry)`,
    );
  }

  // M24: интро группы. Б24 создаёт чат OL с заголовком «<клиент> - <линия>» и аватаром =
  // фото клиента первого сообщения, а chat.name игнорирует. Поэтому первым в новый чат пишет
  // псевдо-пользователь «группа» (group:<chatId>, имя = название, picture = иконка группы):
  // аватар чата = иконка (live P1/P10), точное название ставит _syncOlTitleSafe. Группа без
  // иконки → аватар пустой, а не фото случайного автора.
  // Триггер — адрес чата OL ещё неизвестен (b24ChatId пуст): если Б24 лежал на первом
  // сообщении, интро уйдёт на ретрае. Дедуп — _once по 'group-intro:<chatId>'. Старая
  // привязка без b24ChatId (или ретрай) сначала ищет чат через imopenlines.dialog.get:
  // чат есть → интро не нужно. best-effort: сбой → warn, реальное сообщение идёт дальше
  // (чат создаст автор — прежнее поведение).
  // M27: сразу после интро, под той же блокировкой, — ссылка на группу системным сообщением.
  async _introduceGroupSafe(binding, maxUpdate, { log, onboardedNow }) {
    try {
      return await this._serialized(binding.id, async () => {
        const res = await this._once(
          {
            direction: 'inbound',
            bindingId: binding.id,
            key: `group-intro:${binding.maxChatId}`,
            fn: 'routeInbound',
            log,
            duplicate: 'duplicate-intro',
            done: 'group intro delivered to Open Line',
          },
          async () => {
            if (!onboardedNow) {
              const existing = await this.b24.resolveB24ChatId({ connectorChatId: binding.connectorChatId });
              if (existing) {
                await this._persistB24ChatId(binding, existing, log, 'routeInbound');
                log?.debug({ bindingId: binding.id }, 'routeInbound: OL chat already exists, no group intro');
                return { skipped: 'chat-exists' };
              }
            }

            this._linkChecked.add(binding.id);
            const info = this.max ? await this.max.getChatInfo(maxUpdate.chatId) : null;
            if (!info?.title || (info.type && info.type !== 'chat')) {
              log?.warn(
                { bindingId: binding.id, type: info?.type ?? null, hasTitle: Boolean(info?.title) },
                'routeInbound: no group title (or not a group chat), skipping group intro',
              );
              return { skipped: 'no-group-info' };
            }
            if (info.title !== binding.maxChatTitle) {
              await this.bindings.updateMaxChatTitle(binding.id, info.title);
              binding.maxChatTitle = info.title;
            }

            const sent = await this._sendAsGroup(binding, {
              externalMessageId: `${GROUP_INTRO_MID_PREFIX}${binding.maxChatId}`,
              text: groupIntroText(info.title),
              title: info.title,
              iconUrl: info.iconUrl,
              timestamp: maxUpdate.timestamp,
            });
            await this._persistB24ChatId(binding, sent.b24ChatId, log, 'routeInbound');
            await this._noteOlSessionSafe(binding, sent, log, 'routeInbound');

            const hasIcon = Boolean(info.iconUrl);
            return {
              payloadMeta: { kind: 'group-intro', b24MsgId: sent.b24MsgId, sessionId: sent.sessionId, hasIcon },
              result: { ok: true, bindingId: binding.id, b24MsgId: sent.b24MsgId, link: info.link ?? null },
              logFields: { b24MsgId: sent.b24MsgId, sessionId: sent.sessionId, hasIcon },
            };
          },
        );
        // M27: ссылка — под той же блокировкой, сразу после интро: параллельный первый запрос
        // этой привязки ждёт и интро, и пост ссылки, его сообщение не встанет между ними.
        // _postGroupLinkSafe не бросает — сбой поста не превращает интро в intro-failed.
        if (res?.ok) await this._postGroupLinkSafe(binding, res.link, { log, via: 'intro' });
        return res;
      });
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        'routeInbound: group intro failed (best-effort), delivering message without it',
      );
      return { skipped: 'intro-failed' };
    }
  }

  // M27: ссылка на группу → системное сообщение в чате OL (im.message.add SYSTEM=Y).
  // Своей блокировки НЕ берёт: вызывающий уже держит _serialized по привязке — интро и
  // опенер зовут его изнутри своей цепочки (вложенный _serialized по той же привязке ждал
  // бы сам себя), ленивый шаг оборачивает вызов в _serialized. Поэтому параллельные запросы
  // шлют одно сообщение, а сообщение автора не встаёт между интро/опенером и ссылкой.
  // Пост — через _once по ключу group-link:<chatId>:<hash>; опенер с прежней ссылкой проходит
  // молча (вердикт link-posted, DEBUG вместо WARN). best-effort: не бросает;
  // сбой → WARN, записи нет — повтор на следующем опенере или после рестарта.
  async _postGroupLinkSafe(binding, link, { log, via }) {
    if (!link) return { skipped: 'no-link' };
    if (!binding.b24ChatId) {
      log?.debug({ bindingId: binding.id, via }, 'routeInbound: OL chat address unknown, group link not posted');
      return { skipped: 'no-chat' };
    }
    try {
      return await this._once(
        {
          direction: 'inbound',
          bindingId: binding.id,
          key: groupLinkKey(binding.maxChatId, link),
          fn: 'routeInbound',
          log,
          duplicate: 'link-posted',
          quietDuplicate: true,
          done: 'group link posted to Open Line chat',
        },
        async () => {
          const { b24MsgId } = await this.b24.sendSystemMessage({
            b24ChatId: binding.b24ChatId,
            text: groupLinkText(link),
          });
          return {
            payloadMeta: { kind: 'group-link', via, b24MsgId },
            result: { ok: true, bindingId: binding.id, b24MsgId },
            logFields: { via, b24MsgId },
          };
        },
      );
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, via, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        'routeInbound: group link post failed (best-effort)',
      );
      return { skipped: 'link-failed' };
    }
  }

  // M27: ленивый шаг ссылки для привязок, которым её ещё не постили (группы до M27,
  // прошлый пост не удался). Раз за процесс на привязку (_linkChecked): один SELECT по
  // префиксу ключа; записи нет → GET /chats → пост. Запись есть → ни одного вызова MAX.
  // Не группа (type ≠ chat) или ссылки нет → ничего. best-effort: не бросает.
  async _ensureGroupLinkSafe(binding, chatId, log) {
    if (this._linkChecked.has(binding.id) || !this.max || !binding.b24ChatId) return;
    this._linkChecked.add(binding.id);
    try {
      const posted = await this.log.hasInboundKeyPrefix(
        binding.id,
        `${GROUP_LINK_KEY_PREFIX}${binding.maxChatId}:`,
      );
      if (posted) return;
      const info = await this.max.getChatInfo(chatId);
      if (info?.type && info.type !== 'chat') return;
      // Пост — под _serialized привязки (интро и опенер постят под своей цепочкой).
      await this._serialized(
        binding.id,
        () => this._postGroupLinkSafe(binding, info?.link ?? null, { log, via: 'lazy' }),
      );
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, err: { message: err?.message } },
        'routeInbound: group link check failed (best-effort)',
      );
    }
  }

  // M24/M25: служебное сообщение от псевдо-пользователя «группа» (интро, опенер сессии).
  // Имя — название группы (одни эмодзи → «Группа MAX»), picture — иконка группы.
  async _sendAsGroup(binding, { externalMessageId, text, title, iconUrl, timestamp }) {
    return this.b24.sendConnectorMessage(new ConnectorMessage({
      connectorChatId: binding.connectorChatId,
      externalMessageId,
      text,
      date: toUnixSeconds(timestamp),
      author: {
        id: `${GROUP_USER_PREFIX}${binding.maxChatId}`,
        name: title,
        fallbackName: GROUP_FALLBACK_NAME,
        ...(iconUrl ? { picture: iconUrl } : {}),
      },
    }));
  }

  // M25: поля сессии из обновлённой строки привязки → в объект текущего запроса.
  _applySessionFields(binding, updated) {
    if (!updated) return;
    binding.olSessionId = updated.olSessionId ?? null;
    binding.olClosedSessionId = updated.olClosedSessionId ?? null;
  }

  // M25: сессия OL из ответа send.messages → ol_session_id. Пишем, только если сессия
  // новее известной или снимает флаг закрытия: обычное сообщение в ту же сессию — без
  // запросов. Смена сессии без события Finish — признак потерянного события (Б24 не
  // ретраит): клиентом новой сессии уже стал автор, исправить нельзя, только INFO.
  // best-effort: до миграции 0011 колонок нет — ошибка не роняет доставку.
  async _noteOlSessionSafe(binding, sent, log, fn) {
    const sessionId = toSessionId(sent?.sessionId);
    if (sessionId === null) return;
    const known = binding.olSessionId ?? null;
    const closed = binding.olClosedSessionId ?? null;
    const advances = known === null || sessionId > known;
    const clearsFlag = closed !== null && closed < sessionId;
    if (!advances && !clearsFlag) return;
    try {
      this._applySessionFields(binding, await this.bindings.rememberOlSession(binding.id, sessionId));
      if (known !== null && sessionId > known && closed === null) {
        log?.info(
          { bindingId: binding.id, prevSessionId: known, sessionId },
          `${fn}: OL session changed without DialogFinish (event lost?), client is the author`,
        );
      } else if (clearsFlag) {
        log?.info(
          { bindingId: binding.id, closedSessionId: closed, sessionId },
          `${fn}: OL session advanced past closed one without group opener, flag cleared`,
        );
      }
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, sessionId, err: { message: err?.message } },
        `${fn}: OL session persist failed (best-effort)`,
      );
    }
  }

  // M25: снять флаг закрытой сессии (опенер ушёл или не нужен). best-effort: не снялся —
  // его снимет _noteOlSessionSafe после реального сообщения (сессия новее закрытой).
  // apply=false (опенер отменён): память запроса не трогаем — сообщение автора уйдёт
  // в новую сессию, и _noteOlSessionSafe залогирует её как «без опенера», а не как
  // потерянный Finish.
  async _completeSessionOpenerSafe(binding, closedSessionId, sessionId, log, { apply = true } = {}) {
    try {
      const updated = await this.bindings.completeSessionOpener(binding.id, closedSessionId, sessionId);
      if (apply) this._applySessionFields(binding, updated);
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, closedSessionId, err: { message: err?.message } },
        'routeInbound: session opener flag clear failed (best-effort)',
      );
    }
  }

  // M25: опенер сессии. Клиент сессии OL — автор её первого сообщения; после закрытия
  // сессии (OnImConnectorDialogFinish → ol_closed_session_id) следующее входящее сначала
  // уходит от «группы» — «Новое обращение из группы «<название>» в MAX» — и клиентом новой
  // сессии становится группа. Под _serialized с перечитыванием привязки: пачка сообщений
  // после закрытия даёт один опенер (второй запрос видит флаг снятым). Ключ _once включает
  // mid: ретрай MAX того же сообщения не шлёт второй опенер, а повторно закрытая
  // возобновлённая сессия снова открывается группой.
  // Название — из MAX (иконка могла смениться), иначе сохранённое; maxChatTitle НЕ
  // обновляем: его синхронизирует chat_title_changed, а старые чаты M24 не трогает.
  // Не группа или названия нет вовсе → флаг снимаем (иначе GET /chats на каждое
  // сообщение). best-effort: сбой → warn, реальное сообщение идёт дальше.
  // M27: сразу после опенера, под той же блокировкой, — ссылка на группу, если MAX её
  // перевыпустил или прошлый пост не удался (ключа с хешем текущей ссылки ещё нет).
  async _openGroupSessionSafe(binding, maxUpdate, { log }) {
    if (!binding.needsSessionOpener?.()) return { skipped: 'not-needed' };
    try {
      return await this._serialized(binding.id, async () => {
        const { binding: fresh } = await this.bindings.resolveByMaxChat(binding.maxChatId);
        if (!fresh?.needsSessionOpener()) {
          this._applySessionFields(binding, fresh);
          log?.debug({ bindingId: binding.id }, 'routeInbound: session opener already handled');
          return { skipped: 'opener-done' };
        }
        const closedSessionId = fresh.olClosedSessionId;
        const key = `${GROUP_SESSION_KEY_PREFIX}${binding.maxChatId}:${closedSessionId}:`
          + `${maxUpdate.mid ?? maxUpdate.timestamp ?? 'na'}`;
        const res = await this._once(
          {
            direction: 'inbound',
            bindingId: binding.id,
            key,
            fn: 'routeInbound',
            log,
            duplicate: 'duplicate-opener',
            done: 'group session opener delivered to Open Line',
          },
          async () => {
            this._linkChecked.add(binding.id);
            const info = this.max ? await this.max.getChatInfo(maxUpdate.chatId) : null;
            const title = info?.title || fresh.maxChatTitle;
            if ((info?.type && info.type !== 'chat') || !title) {
              log?.warn(
                { bindingId: binding.id, type: info?.type ?? null, hasTitle: Boolean(title) },
                'routeInbound: no group title (or not a group chat), dropping session opener',
              );
              await this._completeSessionOpenerSafe(binding, closedSessionId, null, log, { apply: false });
              return { skipped: 'no-group-info' };
            }

            const sent = await this._sendAsGroup(binding, {
              externalMessageId: `${CONNECTOR_ID_PREFIX}${key}`,
              text: groupSessionText(title),
              title,
              iconUrl: info?.iconUrl,
              timestamp: maxUpdate.timestamp,
            });
            const sessionId = toSessionId(sent.sessionId);
            await this._completeSessionOpenerSafe(binding, closedSessionId, sessionId, log);
            if (sessionId === closedSessionId) {
              log?.info(
                { bindingId: binding.id, sessionId },
                'routeInbound: session opener landed in the closed session (resumed)',
              );
            }
            await this._persistB24ChatId(binding, sent.b24ChatId, log, 'routeInbound');

            const hasIcon = Boolean(info?.iconUrl);
            return {
              payloadMeta: {
                kind: 'group-session',
                b24MsgId: sent.b24MsgId,
                closedSessionId,
                sessionId,
                hasIcon,
              },
              result: { ok: true, bindingId: binding.id, b24MsgId: sent.b24MsgId, link: info?.link ?? null },
              logFields: { b24MsgId: sent.b24MsgId, closedSessionId, sessionId, hasIcon },
            };
          },
        );
        // M27: ссылка — под той же блокировкой, сразу после опенера: запрос, ждавший опенер,
        // отправит своё сообщение уже после ссылки. _postGroupLinkSafe не бросает.
        if (res?.ok) await this._postGroupLinkSafe(binding, res.link, { log, via: 'opener' });
        return res;
      });
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        'routeInbound: group session opener failed (best-effort), delivering message without it',
      );
      return { skipped: 'opener-failed' };
    }
  }

  // M24: точное название MAX-группы → чат OL (imconnector.chat.name.set). Метод работает
  // только при открытой сессии: зовём после доставки входящего (сессия открыта) и по
  // chat_title_changed. CHAT_RENAMING_FAILED — сессия закрыта либо имя то же (M27):
  // разбирает _onOlRenameFailed по imopenlines.dialog.get. armOnClosed (только
  // chat_title_changed) — закрытая сессия взводит флаг опенера. Под _serialized с
  // перечитыванием привязки — параллельные переименования не оставят в OL устаревшее
  // название. best-effort: не бросает. Возвращает 'not-needed' | 'synced' | 'pending' | 'failed'.
  async _syncOlTitleSafe(binding, log, fn, { armOnClosed = false } = {}) {
    if (!binding.needsOlTitleSync?.()) return 'not-needed';
    try {
      return await this._serialized(binding.id, async () => {
        const { binding: fresh } = await this.bindings.resolveByMaxChat(binding.maxChatId);
        if (!fresh?.needsOlTitleSync()) return 'not-needed';
        try {
          await this.b24.setChatName({ connectorChatId: fresh.connectorChatId, name: fresh.maxChatTitle });
        } catch (err) {
          if (err?.b24Code !== 'CHAT_RENAMING_FAILED') throw err;
          return this._onOlRenameFailed(binding, fresh, { armOnClosed, log, fn });
        }
        return this._markOlTitleSynced(binding, fresh, log, `${fn}: OL chat title synced`);
      });
    } catch (err) {
      log?.warn(
        { bindingId: binding.id, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        `${fn}: OL chat title sync failed (best-effort, will retry on next inbound)`,
      );
      return 'failed';
    }
  }

  // Название в OL совпало с MAX (переименовали или уже такое) → отметка в привязке и в
  // объекте вызывающего. Ошибка отметки летит наружу (→ WARN 'failed' в _syncOlTitleSafe).
  async _markOlTitleSynced(binding, fresh, log, msg) {
    const title = fresh.maxChatTitle;
    await this.bindings.markOlChatTitle(fresh.id, title);
    binding.maxChatTitle = title;
    binding.olChatTitle = title;
    log?.info({ bindingId: fresh.id, titleLen: title.length }, msg);
    return 'synced';
  }

  // M27: CHAT_RENAMING_FAILED на chat.name.set (внутри _serialized _syncOlTitleSafe). Б24
  // отвечает так и на закрытой сессии, и на открытой, если имя не меняется (live 2026-10-08),
  // поэтому смотрим чат OL (imopenlines.dialog.get по CHAT_ID): поле 6 entity_data_1 —
  // id текущей сессии, 0 у закрытой.
  //   0   → сессия закрыта: armOnClosed (chat_title_changed) взводит флаг опенера — второй
  //         сигнал закрытия на случай потерянного OnImConnectorDialogFinish. Номер — из
  //         ol_session_id, NULL → 0 «номер неизвестен». На входящем пути флага нет: сессия
  //         только что получила сообщение, 0 там — гонка с закрытием;
  //   > 0 → сессия открыта: имя в OL уже то же (правило CIMChat::Rename) → отметка, иначе
  //         причина неизвестна — название ждёт;
  //   чат не прочитан / поле не разобрать → флаг не трогаем (безопасная сторона).
  // Всегда без проброса, кроме ошибки отметки названия (→ WARN 'failed' в _syncOlTitleSafe).
  async _onOlRenameFailed(binding, fresh, { armOnClosed, log, fn }) {
    const base = { bindingId: fresh.id };
    const ol = await this.b24.getOlChat({ b24ChatId: fresh.b24ChatId });
    if (!ol || ol.sessionId === null) {
      log?.info(base, `${fn}: chat title pending (OL chat state unknown)`);
      return 'pending';
    }

    if (ol.sessionId === 0) {
      if (!armOnClosed) {
        log?.info(base, `${fn}: OL session closed, chat title pending until next inbound`);
        return 'pending';
      }
      const knownSessionId = fresh.olSessionId ?? null;
      let updated;
      try {
        updated = await this.bindings.markOlSessionClosedByRename(fresh.id, knownSessionId);
      } catch (err) {
        log?.warn(
          { ...base, step: 'arm-opener', knownSessionId, err: { message: err?.message } },
          `${fn}: OL chat title sync failed (best-effort, will retry on next inbound)`,
        );
        return 'failed';
      }
      this._applySessionFields(binding, updated);
      log?.info(
        { ...base, knownSessionId },
        updated
          ? `${fn}: OL session closed (CHAT_RENAMING_FAILED), group opener armed`
          : `${fn}: OL session closed (CHAT_RENAMING_FAILED), opener already armed`,
      );
      return 'pending';
    }

    if (sameOlTitle(ol.name, fresh.maxChatTitle)) {
      return this._markOlTitleSynced(binding, fresh, log, `${fn}: OL chat already has this title`);
    }
    log?.info(
      { ...base, sessionId: ol.sessionId },
      `${fn}: rename failed with open session, chat title pending`,
    );
    return 'pending';
  }

  // Inbound MAX → Open Lines (M4.2/M7). Возвращает один из skip-вердиктов
  // ({skipped:'no-sender'|'duplicate'|'duplicate-race'|'empty-message'})
  // либо {ok:true, bindingId, maxMid, b24MsgId, logId}.
  // M7/M21: незнакомый или неготовый чат авто-онбордится (ensureForMaxChat), поэтому
  // 'no-binding' и 'binding-not-ready' здесь не возвращаются.
  // Все skip-вердикты → контроллер отдаёт 200 OK (MAX не ретраит). 5xx-ошибки B24
  // пробрасываются → 500 → MAX ретраит (свой outbox не делаем: MAX повторяет вебхук до 10 раз за 8 ч).
  //
  // logger: scoped-логгер с requestId (протащен из maxController через maxService);
  // fallback на this.logger для CLI-вызовов вне HTTP.
  async routeInbound(maxUpdate, { logger } = {}) {
    const log = logger ?? this.logger;

    assertMaxUpdate(maxUpdate, 'message_created', 'routeInbound');

    const chatId = maxUpdate.chatId;
    const mid = maxUpdate.mid ?? null;

    // 0) ключ идемпотентности — до онбординга: без ключа сообщение не маршрутизируем.
    const ref = inboundRef(maxUpdate);
    if (!ref) {
      log?.warn({ chatId }, 'routeInbound: message without mid and timestamp, skipping');
      return { skipped: 'no-mid' };
    }
    if (mid === null) {
      log?.info({ chatId, key: ref.key }, 'routeInbound: message without mid, synthetic key');
    }

    // 1) resolve binding. Нет привязки — авто-онбординг (M7); привязка без connector_chat_id
    // (сбой онбординга до M21) — самовосстановление тем же атомарным upsert'ом. onboardedNow —
    // привязку создал этот запрос: конкурентный первый запрос получит created=false.
    // Название и иконку группы берёт интро (M24) — уже после создания привязки.
    log?.debug({ chatId, mid }, 'routeInbound: resolve binding');
    let onboardedNow = false;
    let { binding, isReady, installation } = await this.bindings.resolveByMaxChat(chatId);
    if (!binding || !isReady) {
      const repairing = Boolean(binding);
      log?.debug({ chatId, repairing }, 'routeInbound: no ready binding, auto-onboarding');
      const ensured = await this.bindings.ensureForMaxChat(chatId, { installation });
      binding = ensured.binding;
      onboardedNow = ensured.created;
      if (onboardedNow) {
        log?.info({ chatId, bindingId: binding.id }, `auto-onboarded ${chatId} → binding ${binding.id}`);
      } else if (repairing) {
        log?.warn({ chatId, bindingId: binding.id }, 'routeInbound: binding without connector chat repaired');
      }
      // Иначе привязку только что создал конкурентный первый запрос.
    }

    // 2) идемпотентность по «голому» mid (без mid — синтетический ключ, M21) через _once:
    // дубль отсекается ДО отправки в B24.
    const result = await this._once(
      {
        direction: 'inbound',
        bindingId: binding.id,
        key: ref.key,
        fn: 'routeInbound',
        log,
        done: 'delivered to Open Line',
      },
      () => this._deliverInbound(binding, maxUpdate, { log, onboardedNow, externalId: ref.externalId, installation }),
    );

    // 3) M24: название группы → чат OL. После записи в message_log (не внутри эффекта):
    // лишний REST между отправкой и записью расширил бы окно duplicate-race. Сессия
    // только что получила сообщение — открыта. best-effort.
    if (result.ok) {
      await this._syncOlTitleSafe(binding, log, 'routeInbound');
      // 4) M27: ссылка на группу старой привязке — один раз, после записи (доставку не
      // задерживает, только ответ вебхука). best-effort.
      await this._ensureGroupLinkSafe(binding, chatId, log);
    }
    return result;
  }

  // Эффект routeInbound (под _once): участник → текст/медиа → ConnectorMessage → B24.
  // Ошибка B24 → проброс без записи → 500 → MAX ретраит (свой outbox не делаем).
  // installation (M21) — из резолва привязки: Б24-вызов не читает её из БД ещё раз.
  async _deliverInbound(binding, maxUpdate, { log, onboardedNow, externalId, installation }) {
    const chatId = maxUpdate.chatId;
    const mid = maxUpdate.mid ?? null;
    const senderId = maxUpdate.senderId ?? null;

    // 3) sender guard — message_created без sender (системное) не маршрутизируем.
    // Иначе ensureParticipant/ConnectorMessage бросят → 500 → MAX ретраит без записи.
    if (senderId === null || senderId === undefined) {
      log?.warn(
        { bindingId: binding.id, mid },
        'routeInbound: message_created without sender, skipping (no 5xx)',
      );
      return { skipped: 'no-sender' };
    }
    log?.debug({ bindingId: binding.id, senderId }, 'routeInbound: ensureParticipant');
    await this.bindings.ensureParticipant(binding.id, {
      maxUserId: senderId,
      displayName: maxUpdate.senderName,
    });

    // 4) текст + медиа. M11.2: вложения MAX (image/file/video/sticker) → message.files[]
    // (Б24 качает сам по url). files = атрибут того же сообщения (тот же mid) —
    // идемпотентность не меняется. Пусто И без файлов → empty-message; иначе шлём
    // text и/или files. Reply-цитата входит в text ДО empty-message-guard: reply-на-медиа
    // с пустым body.text и без файлов иначе отсеялся бы как empty.
    const text = this._buildInboundText(maxUpdate, binding.id, log, 'routeInbound');

    const media = typeof maxUpdate.attachments === 'function'
      ? maxUpdate.attachments({ logger: log })
      : [];
    const files = media.map((a) => ({ url: a.url, name: a.name }));
    const kinds = media.map((a) => a.kind);
    if (!text && files.length === 0) {
      log?.warn(
        { bindingId: binding.id, mid },
        'routeInbound: empty message (no text, no files), skipping',
      );
      return { skipped: 'empty-message' };
    }
    if (files.length > 0) {
      log?.debug(
        { bindingId: binding.id, mid, filesCount: files.length, kinds },
        'routeInbound: inbound media collected',
      );
    }

    // M10: аватар автора (best-effort). Тянем НЕ на каждое сообщение, а один раз
    // на пару (binding, author) за время жизни процесса — иначе getChatMember
    // дёргался бы на каждый inbound. Ошибка/пусто → picture не ставим (косметика
    // не должна ронять мост); сквозной путь user.picture готов (b24Service→b24Client).
    // Тянем ПОСЛЕ empty-message-guard: пустое сообщение не тратит попытку.
    let authorPicture = null;
    if (this.max) {
      const avatarKey = `${binding.id}:${senderId}`;
      if (!this._avatarTried.has(avatarKey)) {
        this._avatarTried.add(avatarKey);
        authorPicture = await this.max.getMemberAvatar(chatId, senderId);
        log?.debug(
          { bindingId: binding.id, senderId, hasAvatar: Boolean(authorPicture) },
          'routeInbound: author avatar resolved (first message)',
        );
      }
    }

    // 4.5) M24: адрес чата OL ещё неизвестен → сначала интро от «группы» (best-effort).
    // M25: сессия OL закрыта → сначала опенер от «группы» (best-effort). Не else: старая
    // привязка без адреса (интро пропущено с chat-exists) тоже получает опенер.
    if (!binding.b24ChatId) await this._introduceGroupSafe(binding, maxUpdate, { log, onboardedNow });
    if (binding.needsSessionOpener?.()) await this._openGroupSessionSafe(binding, maxUpdate, { log });

    // 5) build ConnectorMessage.
    const connectorMessage = new ConnectorMessage({
      connectorChatId: binding.connectorChatId,
      externalMessageId: externalId,
      text,
      date: toUnixSeconds(maxUpdate.timestamp),
      author: {
        id: senderId,
        name: maxUpdate.senderName ?? `MAX user ${senderId}`,
        // M10: аватар MAX → user.picture (best-effort, см. выше).
        ...(authorPicture ? { picture: authorPicture } : {}),
      },
      // M11.2: медиа inbound — Б24 качает файлы сам по message.files[].url.
      files,
    });
    // Никогда не логируем полный text (PII) — только префикс ≤32 символов на debug.
    log?.debug(
      {
        bindingId: binding.id,
        externalMessageId: connectorMessage.externalMessageId,
        textPrefix: text.slice(0, MAX_TEXT_PREFIX),
      },
      'routeInbound: built ConnectorMessage, calling B24',
    );

    // 6) send to B24.
    let sent;
    try {
      sent = await this.b24.sendConnectorMessage(connectorMessage, { installation });
    } catch (err) {
      this._logB24Failure(log, 'routeInbound', 'imconnector.send.messages', { bindingId: binding.id, mid }, err);
      throw err;
    }

    // 6.5) персист адреса OL-чата — best-effort, только новое значение.
    await this._persistB24ChatId(binding, sent.b24ChatId, log, 'routeInbound');
    // 6.6) M25: сессия OL — для отсечения устаревшего Finish и диагностики (best-effort).
    await this._noteOlSessionSafe(binding, sent, log, 'routeInbound');

    return {
      payloadMeta: {
        b24MsgId: sent.b24MsgId,
        senderId,
        sessionId: sent.sessionId,
        textPrefix: text.slice(0, MAX_TEXT_PREFIX),
        // M11.2: медиа-метаданные (без миграции — через существующий jsonb).
        ...(files.length > 0 ? { filesCount: files.length, kinds } : {}),
      },
      result: { ok: true, bindingId: binding.id, maxMid: mid, b24MsgId: sent.b24MsgId },
      logFields: {
        maxMid: mid,
        b24MsgId: sent.b24MsgId,
        sessionId: sent.sessionId,
        filesCount: files.length,
      },
    };
  }

  // INBOUND-правка MAX → Open Lines (message_edited). Отдельный путь от routeInbound:
  // dedup routeInbound по «голому» mid нашёл бы запись оригинала и отсёк бы правку
  // как duplicate. Здесь идемпотентность — по синтетическому ключу edit:<mid>:<ts>
  // (образец routeLifecycle). Правка маппится на ТОТ ЖЕ external id (max:mid:<mid>),
  // версионная таблица/миграция не нужны. Без миграции БД.
  //
  // logger: scoped-логгер с requestId (протащен из maxController через maxService).
  async routeInboundEdit(maxUpdate, { logger } = {}) {
    const log = logger ?? this.logger;

    assertMaxUpdate(maxUpdate, 'message_edited', 'routeInboundEdit');

    const chatId = maxUpdate.chatId;
    const mid = maxUpdate.mid ?? null;
    const senderId = maxUpdate.senderId ?? null;
    const ts = maxUpdate.timestamp ?? null;

    if (mid === null) {
      log?.warn({ chatId }, 'routeInboundEdit: edit without mid, skipping');
      return { skipped: 'no-mid' };
    }

    // 1) resolve binding. Правку несуществующего/неготового чата НЕ онбордим —
    // оригинала в OL всё равно нет, обновлять нечего.
    log?.debug({ chatId, mid }, 'routeInboundEdit: resolve binding');
    const { binding, isReady, installation } = await this.bindings.resolveByMaxChat(chatId);
    if (!binding || !isReady) {
      log?.warn(
        { chatId, bindingId: binding?.id ?? null },
        'routeInboundEdit: binding not ready, skipping',
      );
      return { skipped: 'binding-not-ready' };
    }

    // 2) sender guard — правка без sender не даёт построить author → graceful skip.
    if (senderId === null || senderId === undefined) {
      log?.warn(
        { bindingId: binding.id, mid },
        'routeInboundEdit: edit without sender, skipping (no 5xx)',
      );
      return { skipped: 'no-sender' };
    }

    // 3) идемпотентность правки — синтетический ключ edit:<mid>:<ts> (образец
    // routeLifecycle). НЕ «голый» mid: он нашёл бы запись оригинала и отсёк бы
    // правку как duplicate. ts стабилен при ретраях того же webhook-события.
    // Запись оригинала (maxMid=mid) не трогаем — фиксируем ФАКТ правки.
    return this._once(
      {
        direction: 'inbound',
        bindingId: binding.id,
        key: `edit:${mid}:${ts}`,
        fn: 'routeInboundEdit',
        log,
        duplicate: 'duplicate-edit',
        done: 'edit applied to Open Line',
      },
      async () => {
        // 3.5) правим только то, что дошло до OL.
        if (!(await this._findInboundOriginal(binding.id, mid, log, 'routeInboundEdit'))) {
          return { skipped: 'no-original' };
        }

        // 4) собрать новый текст С НУЛЯ: markup→BB + reply-префикс + маркер «Изменено».
        // Пересборка из нового body.text => маркер не накапливается между правками.
        let text = this._buildInboundText(maxUpdate, binding.id, log, 'routeInboundEdit');
        if (!text) {
          // Текст вычистили в пустоту. Медиа-правка — вне скоупа MVP (отдельный backlog).
          log?.warn(
            { bindingId: binding.id, mid },
            'routeInboundEdit: empty edit (no text), skipping',
          );
          return { skipped: 'empty-edit' };
        }
        // Маркер правки. MAX сам ставит «Ред.» на своей стороне; в OL автоматического
        // маркера нет, поэтому помечаем явно. Разделитель `----` визуально отделяет
        // маркер от тела сообщения. Идемпотентно (один раз, текст пересобран с нуля).
        text = `${text}[br]----[br][i]Изменено[/i]`;

        // 5) build ConnectorMessage на ТОТ ЖЕ external id, что и оригинал.
        const connectorMessage = new ConnectorMessage({
          connectorChatId: binding.connectorChatId,
          externalMessageId: toExternalMid(mid),
          text,
          date: toUnixSeconds(ts),
          author: {
            id: senderId,
            name: maxUpdate.senderName ?? `MAX user ${senderId}`,
          },
        });
        const externalId = connectorMessage.externalMessageId;
        log?.debug(
          { bindingId: binding.id, externalMessageId: externalId, textPrefix: text.slice(0, MAX_TEXT_PREFIX) },
          'routeInboundEdit: built ConnectorMessage, calling B24 update',
        );

        // 6) update в B24. Ошибка → проброс без записи → 500 → MAX ретраит.
        try {
          await this.b24.updateConnectorMessage(connectorMessage, { installation });
        } catch (err) {
          this._logB24Failure(log, 'routeInboundEdit', 'imconnector.update.messages', { bindingId: binding.id, mid }, err);
          throw err;
        }

        return {
          payloadMeta: { kind: 'edit', origMid: mid, senderId, textPrefix: text.slice(0, MAX_TEXT_PREFIX) },
          result: { ok: true, bindingId: binding.id, origMid: mid, externalId },
          logFields: { origMid: mid, externalId },
        };
      },
    );
  }

  // INBOUND-удаление MAX → Open Lines (message_removed). Отдельный путь от routeInbound:
  // dedup routeInbound по «голому» mid нашёл бы запись оригинала и отсёк бы удаление как
  // duplicate. Идемпотентность — по синтетическому ключу delete:<mid> (без <ts>: удалить
  // сообщение можно лишь раз). Удаление маппится на ТОТ ЖЕ external id (max:mid:<mid>),
  // версионная таблица/миграция не нужны. Без миграции БД.
  //
  // Эхо-guard бота НЕ в координаторе (симметрия с routeInboundEdit): петли «delete→delete»
  // в MAX нет — пользователь не может удалять сообщения бота.
  //
  // logger: scoped-логгер с requestId (протащен из maxController через maxService).
  async routeInboundDelete(maxUpdate, { logger } = {}) {
    const log = logger ?? this.logger;

    assertMaxUpdate(maxUpdate, 'message_removed', 'routeInboundDelete');

    const chatId = maxUpdate.chatId;
    const mid = maxUpdate.mid ?? null;
    const senderId = maxUpdate.senderId ?? null;

    if (mid === null) {
      log?.warn({ chatId }, 'routeInboundDelete: delete without mid, skipping');
      return { skipped: 'no-mid' };
    }

    // 1) resolve binding. Удаление в несуществующем/неготовом чате НЕ онбордим —
    // оригинала в OL всё равно нет, удалять нечего.
    log?.debug({ chatId, mid }, 'routeInboundDelete: resolve binding');
    const { binding, isReady, installation } = await this.bindings.resolveByMaxChat(chatId);
    if (!binding || !isReady) {
      log?.warn(
        { chatId, bindingId: binding?.id ?? null },
        'routeInboundDelete: binding not ready, skipping',
      );
      return { skipped: 'binding-not-ready' };
    }

    // 2) идемпотентность удаления — синтетический ключ delete:<mid> (без <ts>:
    // удалить сообщение можно лишь раз). НЕ «голый» mid — он нашёл бы запись оригинала.
    // Запись оригинала (maxMid=mid) не трогаем — фиксируем ФАКТ удаления.
    return this._once(
      {
        direction: 'inbound',
        bindingId: binding.id,
        key: `delete:${mid}`,
        fn: 'routeInboundDelete',
        log,
        duplicate: 'duplicate-delete',
        done: 'delete applied to Open Line',
      },
      async () => {
        // 3) удаляем только то, что дошло до OL. Резолв user.id (автор оригинала):
        // imconnector.delete.messages ждёт user.id = автор оригинала (те же значения, что
        // при send). user_id события — это тот, КТО удалил (мог быть админ), поэтому тянем
        // senderId из записи оригинала; fallback — senderId события (удаление идёт по
        // message.id, автор второстепенен).
        const orig = await this._findInboundOriginal(binding.id, mid, log, 'routeInboundDelete');
        if (!orig) return { skipped: 'no-original' };
        const author = orig.payloadMeta?.senderId ?? senderId;
        if (author === null || author === undefined) {
          log?.warn(
            { bindingId: binding.id, mid },
            'routeInboundDelete: cannot resolve author (no senderId in original record or event), skipping',
          );
          return { skipped: 'no-author' };
        }
        // M23: имя автора обязательно — Б24 переписывает имя пользователя коннектора
        // и на delete, без него автор становится «Гостем». Источник — participant_map
        // (последнее имя с входящих); нет записи → null, fallback ставит b24Service.
        const authorName = await this.bindings.findParticipantName(binding.id, author);
        log?.debug(
          {
            bindingId: binding.id,
            mid,
            authorSource: orig.payloadMeta?.senderId != null ? 'message-log' : 'event',
            hasName: authorName !== null,
          },
          'routeInboundDelete: author resolved',
        );

        // 4) delete в B24 на ТОТ ЖЕ external id. Ошибка → проброс без записи → 500 → MAX ретраит.
        const externalId = toExternalMid(mid);
        log?.debug(
          { bindingId: binding.id, externalMessageId: externalId, connectorChatId: binding.connectorChatId },
          'routeInboundDelete: built payload, calling B24 delete',
        );
        try {
          await this.b24.deleteConnectorMessage({
            connectorChatId: binding.connectorChatId,
            externalMessageId: externalId,
            author: { id: author, name: authorName },
          }, { installation });
        } catch (err) {
          this._logB24Failure(log, 'routeInboundDelete', 'imconnector.delete.messages', { bindingId: binding.id, mid }, err);
          throw err;
        }

        return {
          payloadMeta: { kind: 'delete', origMid: mid, senderId: author },
          result: { ok: true, bindingId: binding.id, origMid: mid, externalId },
          logFields: { origMid: mid, externalId },
        };
      },
    );
  }

  // Reply/цитирование (OL→MAX): сырьё от b24Service.resolveReplyContext → MAX mid
  // родителя. Граница чистая: b24Service даёт сырые REPLY_ID/CONNECTOR_MID, а маппинг
  // в MAX-mid (с доступом к message_log/binding) делает координатор. Возвращает
  // { maxMid, resolvedVia }:
  //   connector-mid-client   — CONNECTOR_MID = "max:mid:<mid>" (родитель — клиентское) → strip
  //   connector-mid-operator — CONNECTOR_MID = "<maxMid>" (родитель — операторское, уже доставлен)
  //   none (служебный)       — CONNECTOR_MID = "max:…" без mid сообщения MAX (интро группы
  //                            M24, опенер сессии M25, сообщение без mid M21)
  //   message-log            — fallback findOutbound(b24_msg_id=REPLY_ID).payloadMeta.maxMid
  //   none                   — mid не добыт ни одним путём → шлём без reply
  async _resolveReplyMaxMid({ binding, replyContext, logger } = {}) {
    const log = logger ?? this.logger;
    const connectorMid = replyContext?.parentConnectorMid;
    const replyId = replyContext?.replyId ?? null;
    let result = { maxMid: null, resolvedVia: 'none' };

    if (typeof connectorMid === 'string' && connectorMid.length > 0) {
      if (connectorMid.startsWith(EXTERNAL_MID_PREFIX)) {
        result = { maxMid: connectorMid.slice(EXTERNAL_MID_PREFIX.length), resolvedVia: 'connector-mid-client' };
      } else if (!connectorMid.startsWith(CONNECTOR_ID_PREFIX)) {
        result = { maxMid: connectorMid, resolvedVia: 'connector-mid-operator' };
      }
      // Иначе — служебное сообщение коннектора (интро группы, опенер сессии) или сообщение без
      // mid (M21): mid в MAX неизвестен, битый link уронил бы отправку ответа оператора
      // (Б24 событие не повторяет) → шлём без reply.
    } else if (replyId !== null && replyId !== undefined && replyId !== '') {
      // Fallback (родитель-оператор, гарантированный путь). findOutbound возвращает
      // null, когда строки нет (MessageLogEntry.fromRow → null) — optional chaining
      // ОБЯЗАТЕЛЕН, иначе entry.payloadMeta.maxMid бросит на null → пустой результат
      // должен уходить в ветку 'none', не падать.
      const entry = await this.log.findOutbound(binding.id, String(replyId));
      const maxMid = entry?.payloadMeta?.maxMid ?? null;
      if (maxMid) result = { maxMid, resolvedVia: 'message-log' };
    }

    log?.debug(
      {
        bindingId: binding.id,
        replyId,
        resolvedVia: result.resolvedVia,
        maxMidPresent: Boolean(result.maxMid),
      },
      'routeOutbound: reply maxMid resolution',
    );
    return result;
  }

  // Общий шаг исходящих маршрутов: guard обязательных полей + resolve binding по
  // connectorChatId (формат "max:<chatId>"). Возвращает { binding, installation } либо
  // { skipped }. M28: installation — снимок, прочитанный резолвом привязки; маршрут отдаёт
  // его в reply-резолв, статус доставки и оповещение оператора, чтобы Б24-вызовы не читали
  // БД заново (устаревший токен обновит callMethod на expired_token).
  async _resolveOutboundBinding({ connectorChatId, b24MsgId }, log, fn) {
    if (!connectorChatId || !b24MsgId) {
      log?.warn({ connectorChatId, b24MsgId }, `${fn}: invalid-message (missing chat.id or im.message_id)`);
      return { skipped: 'invalid-message' };
    }
    log?.debug({ connectorChatId, b24MsgId }, `${fn}: resolve binding`);
    const { binding, isReady, installation } = await this.bindings.resolveByConnectorChat(connectorChatId);
    if (!binding) {
      log?.warn({ connectorChatId }, `${fn}: no-binding for connectorChatId`);
      return { skipped: 'no-binding' };
    }
    if (!isReady) {
      log?.warn({ connectorChatId, bindingId: binding.id }, `${fn}: binding-not-ready`);
      return { skipped: 'binding-not-ready' };
    }
    return { binding, installation: installation ?? null };
  }

  // maxMid'ы доставленного в MAX сообщения (для правки/удаления): externalIds события
  // (message.id — то, что мы отдали в статусе доставки) + запись оригинала (findOutbound по
  // «голому» b24MsgId: payloadMeta.maxMids, у записей до M22 — только maxMid). M22: берём
  // объединение — в событии удаления Б24 присылает message.id строкой (live M15), и сколько
  // id он вернёт для сообщения из нескольких файлов, не гарантировано. Порядок: сначала id
  // из события (строками, как в журнале — без дублей в объединении; правка берёт первый).
  // → { maxMids, logMids, sentAt }: maxMids — объединение ([] → не нашли); logMids (M28) —
  // только из записи оригинала (по ним удаление считает «не полностью»); sentAt — когда
  // сообщение ушло в MAX, или null (возраст сообщения в оповещении о несработавшем удалении):
  // payloadMeta.sentAt у записи, которую дописал разбор прерванных (M29: сама запись создана
  // на следующем старте, после простоя), иначе createdAt записи оригинала.
  async _resolveOutboundMaxMids(binding, m, log, fn) {
    const { b24MsgId } = m;
    const fromEvent = outboundEventMids(m);
    const orig = await this.log.findOutbound(binding.id, b24MsgId);
    const meta = orig?.payloadMeta;
    const logMids = [...new Set((meta?.maxMids ?? [meta?.maxMid]).filter(Boolean))];
    const sentAt = meta?.sentAt ?? orig?.createdAt ?? null;
    const maxMids = [...new Set([...fromEvent, ...logMids])];
    if (maxMids.length === 0) {
      log?.warn({ bindingId: binding.id, b24MsgId }, `${fn}: no-maxmid (cannot locate MAX message)`);
    } else {
      log?.debug(
        { bindingId: binding.id, b24MsgId, fromEvent: fromEvent.length, fromLog: logMids.length, count: maxMids.length },
        `${fn}: maxMid resolved`,
      );
    }
    return { maxMids, logMids, sentAt };
  }

  // Delivery status в Б24 — best-effort: ошибка НЕ валит доставку/правку (в MAX уже ушло).
  // maxMids — все сообщения MAX (M22: по одному на файл) → externalIds события правки/удаления.
  // installation (M28) — снимок из резолва привязки того же маршрута (null → b24 читает БД).
  async _sendDeliveryStatusSafe({ bindingId, b24ChatId, b24MsgId, maxMids, date, connectorChatId, installation = null }, log, fn) {
    try {
      await this.b24.sendDeliveryStatus({
        b24ChatId,
        b24MsgId,
        externalIds: maxMids,
        date,
        connectorChatId,
        ...(installation ? { installation } : {}),
      });
      log?.debug({ bindingId, b24MsgId }, `${fn}: delivery status sent`);
    } catch (err) {
      log?.warn(
        { bindingId, b24MsgId, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        `${fn}: delivery status failed (non-fatal)`,
      );
    }
  }

  // M28: системное сообщение оператору в чате ОЛ о неудаче OL → MAX (im.message.add
  // SYSTEM=Y: клиенту в MAX не уходит и в коннектор не возвращается). Б24 события OL не
  // повторяет, а ответ вебхука никто не увидит — оператор узнаёт о сбое только так (M22:
  // отправка; M28: правка, удаление, внутренняя ошибка отправки).
  // Не зависит от HTTP-запроса (ни req, ни requestId): зовётся из вебхуков и из фоновой
  // работы (задание очереди по чату, восстановление на старте). Никогда не бросает и
  // повторов не делает — повторяет, если нужно, вызывающий.
  //   b24ChatId    — id чата ОЛ без префикса 'chat' (вызывающий: m.b24ChatId ?? binding.b24ChatId);
  //   text         — готовый текст из operatorNotices.js (BB в именах и причинах экранирован);
  //   op, bindingId, b24MsgId (сообщение оператора, не оповещения) — только для лога;
  //   installation — снимок из резолва привязки в том же маршруте. Снимок из вебхука в
  //                  отложенную работу НЕ переносить (токен мог обновиться): без него b24
  //                  читает БД;
  //   logger       — null → this.logger.
  // Текст оповещения в лог не пишется (имена файлов). → { notified: true, noticeId } |
  // { notified: false, reason: 'no-chat' | 'send-failed' }.
  async notifyOperator({
    b24ChatId,
    text,
    op = 'send',
    bindingId = null,
    b24MsgId = null,
    installation = null,
    logger = null,
  } = {}) {
    const log = logger ?? this.logger;
    if (!b24ChatId) {
      log?.warn({ op, bindingId, b24MsgId }, 'notifyOperator: no b24ChatId, operator not notified');
      return { notified: false, reason: 'no-chat' };
    }
    try {
      // installation — вторым аргументом, только если есть.
      const sent = installation
        ? await this.b24.sendSystemMessage({ b24ChatId, text }, { installation })
        : await this.b24.sendSystemMessage({ b24ChatId, text });
      const noticeId = sent?.b24MsgId ?? null;
      log?.info({ op, bindingId, b24MsgId, noticeId }, 'notifyOperator: operator notified');
      return { notified: true, noticeId };
    } catch (err) {
      // Сюда же ValidationError и TypeError (нет b24 или sendSystemMessage у фейка).
      log?.warn(
        { op, bindingId, b24MsgId, b24Code: err?.b24Code ?? null, err: { name: err?.name, message: err?.message } },
        'notifyOperator: operator notification failed (non-fatal)',
      );
      return { notified: false, reason: 'send-failed' };
    }
  }

  // Outbound Open Lines → MAX (M5.2). Возвращает один из skip-вердиктов
  // ({skipped:'ignored-event'|'no-messages'}) либо {ok:true, results:[...]}, где у
  // каждого сообщения — {ok:true,...} или skip ('invalid-message'|'no-binding'|
  // 'binding-not-ready'|'duplicate'|'empty-message'|'duplicate-race'|'delivery-failed').
  // Все вердикты → контроллер 200. M22: Б24 событие не повторяет («Повторных отправок
  // нет»), поэтому недоставка в MAX (файл или текст) — не 500, а 'delivery-failed' /
  // failedFiles + системное сообщение оператору; остальные файлы сообщения уходят.
  // 500 — только ошибки БД и программные (recordOutbound при этом не пишется). M28: Б24
  // событие не повторит и о них — оповещение «могло не дойти» (best-effort: при упавшей
  // БД оно, скорее всего, тоже не уйдёт — тогда только лог), ответ по-прежнему 500.
  //
  // logger: scoped-логгер с requestId (протащен из b24Controller через b24Service);
  // fallback на this.logger.
  async routeOutbound(openLineEvent, { logger } = {}) {
    const log = logger ?? this.logger;

    if (!openLineEvent) {
      throw new ValidationError('routeOutbound: event required');
    }

    if (!openLineEvent.isMessageAdd()) {
      log?.warn(
        { event: openLineEvent.event },
        'routeOutbound: ignored-event (not OnImConnectorMessageAdd)',
      );
      return { skipped: 'ignored-event' };
    }

    const messages = openLineEvent.normalizedMessages();
    if (messages.length === 0) {
      log?.warn(
        { lineId: openLineEvent.lineId },
        'routeOutbound: no-messages in event',
      );
      return { skipped: 'no-messages' };
    }

    const results = [];
    for (const m of messages) {
      // Ошибка БД/баг → 500 остаётся, первая ошибка обрывает остальные сообщения события.
      // eslint-disable-next-line no-await-in-loop
      results.push(await this._routeOutboundOneOrNotify(m, log));
    }
    return { ok: true, results };
  }

  // M28: внутренняя ошибка отправки одного сообщения (БД, баг) → оповещение «могло не
  // дойти» и проброс исходной ошибки (500). Сообщение могло и уйти в MAX (упала, например,
  // запись в журнал). Зовут routeOutbound и задание очереди (M29).
  async _routeOutboundOneOrNotify(m, log, { bindingId = null, b24ChatId = null } = {}) {
    try {
      return await this._routeOutboundOne(m, log);
    } catch (err) {
      await this._sendInternalErrorNotify(m, log, { bindingId, b24ChatId });
      throw err;
    }
  }

  // M28: оповещение «сообщение могло не дойти» (best-effort, не бросает). Чат ОЛ — из
  // события; b24ChatId и bindingId — из строки задания (M29), если она уже есть: без неё
  // привязка неизвестна. installation не передаём: снимок вебхука в отложенную работу не
  // переносим, b24 прочитает БД.
  async _sendInternalErrorNotify(m, log, { bindingId = null, b24ChatId = null } = {}) {
    try {
      await this.notifyOperator({
        op: 'send',
        b24ChatId: m?.b24ChatId ?? b24ChatId,
        bindingId,
        b24MsgId: m?.b24MsgId ?? null,
        text: sendUncertainNotice(),
        logger: log,
      });
    } catch (notifyErr) {
      log?.warn(
        { b24MsgId: m?.b24MsgId ?? null, err: { message: notifyErr?.message } },
        'routeOutbound: operator notification on error failed (swallowed)',
      );
    }
  }

  // M29: вход исходящих OL → MAX из вебхука (b24Service): kind — 'add' (отправка), 'edit',
  // 'delete'. Исходящие одного чата (connectorChatId) идут строго по очереди: правка и
  // удаление не обгоняют заливку файла в MAX. Порядок — среди событий, уже пришедших в мост:
  // о файле Б24 сообщает только после его загрузки в Битрикс24 (текст, отправленный во время
  // этой загрузки, придёт раньше — это порядок Б24, live 2026-10-09). Разные чаты —
  // параллельно, передачи файлов — под общим семафором (M22). Обработка синхронная:
  // промис резолвится после всех заданий события, ответ Б24 — после доставки.
  // По сообщению события, в его порядке:
  //   1) резолв привязки — skip-вердикт ('invalid-message' | 'no-binding' |
  //      'binding-not-ready') сразу в ответ;
  //   2) claim строки job:<ключ операции> — конфликт → 'duplicate-in-progress' (то же
  //      событие уже в работе: без этого оба повтора прошли бы _once и дали дубль в MAX);
  //   3) задание в очередь чата. В ней уже maxPerKey заданий → выполняется сразу, вне
  //      порядка (WARN): лимит — страховка от зависшей передачи, событие не теряется;
  //   4) задание — прежний маршрут (routeOutbound/Edit/Delete одного сообщения), затем
  //      снятие строки job:.
  // Место в очереди задаёт порядок завершения claim. Форма ответа — как у routeOutbound
  // (+Edit/Delete). Ошибка отправки (БД, баг) → оповещение «могло не дойти» и проброс
  // (500) после того, как остальные задания события выполнены: сообщение 2 уже в очереди и
  // уйдёт, даже если сообщение 1 упало. Внутренние ошибки правки и удаления — вердикты
  // 'edit-error'/'delete-error' с оповещением (M28), без 500.
  async routeOutboundQueued(kind, openLineEvent, { logger } = {}) {
    const route = OUTBOUND_ROUTES[kind];
    if (!route) throw new TypeError(`routeOutboundQueued: unknown kind "${kind}"`);
    const { fn, errorVerdict } = route;
    const log = logger ?? this.logger;

    if (!openLineEvent) {
      throw new ValidationError(`${fn}: event required`);
    }
    if (kind === 'add' && !openLineEvent.isMessageAdd()) {
      log?.warn({ event: openLineEvent.event }, 'routeOutbound: ignored-event (not OnImConnectorMessageAdd)');
      return { skipped: 'ignored-event' };
    }
    const messages = openLineEvent.normalizedMessages();
    if (messages.length === 0) {
      log?.warn({ lineId: openLineEvent.lineId }, `${fn}: no-messages in event`);
      return { skipped: 'no-messages' };
    }

    // Слоты ответа в порядке сообщений события. Задание сразу оборачивается в исход
    // ({ status, value|reason }): его отказ, случившийся, пока идут claim следующих
    // сообщений, не становится необработанным.
    const slots = [];
    let claimError = null;
    for (const m of messages) {
      let claim;
      if (kind === 'add') {
        try {
          // eslint-disable-next-line no-await-in-loop
          claim = await this._claimOutboundJob(kind, m, log);
        } catch (err) {
          // Ошибка БД на резолве привязки или claim: в MAX ничего не ушло, но Б24 событие не
          // повторит. Дальше сообщения события не ставим; поставленные дожидаемся → 500.
          log?.error(
            { connectorChatId: m?.connectorChatId ?? null, b24MsgId: m?.b24MsgId ?? null, err: { message: err?.message } },
            'routeOutbound: outbound job claim failed, not queued',
          );
          // eslint-disable-next-line no-await-in-loop
          await this._sendInternalErrorNotify(m, log);
          claimError = err;
          break;
        }
      } else {
        // Правка/удаление: ошибка claim — как внутренняя ошибка best-effort маршрута
        // (ERROR, оповещение «могла не дойти», вердикт errorVerdict), без 500.
        // eslint-disable-next-line no-await-in-loop
        claim = await this._outboundBestEffortOne(
          m,
          log,
          fn,
          errorVerdict,
          (x) => this._claimOutboundJob(kind, x, log),
          this._bestEffortHandlers(kind, log).onError,
        );
      }
      if (claim.skipped) {
        slots.push(Promise.resolve({ status: 'fulfilled', value: { skipped: claim.skipped } }));
        continue;
      }

      const chatKey = m.connectorChatId;
      const bypass = this.outboundQueue.isFull(chatKey);
      if (bypass) {
        log?.warn(
          {
            connectorChatId: chatKey,
            bindingId: claim.bindingId,
            b24MsgId: m.b24MsgId,
            pending: this.outboundQueue.pendingFor(chatKey),
            max: this.outboundQueue.maxPerKey,
          },
          'outbound chat queue full, processing without waiting',
        );
      }
      const acceptedAt = Date.now();
      const done = this.outboundQueue.push(
        chatKey,
        () => this._runOutboundJob(kind, m, claim, { log, acceptedAt, bypass }),
      );
      slots.push(done.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ));
    }

    const settled = await Promise.all(slots);
    // Первая ошибка в порядке сообщений события (только отправка: правка и удаление не
    // бросают); ошибка claim — у последнего принятого сообщения.
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
    if (claimError) throw claimError;
    return { ok: true, results: settled.map((s) => s.value) };
  }

  // M29: резолв привязки и claim строки задания одного сообщения. → { skipped } | { jobId,
  // bindingId, b24ChatId, opKey }. Бросает на ошибке БД. Привязку маршрут в задании
  // резолвит заново (installation + привязка, 2 SELECT): задание могло ждать очереди, а они
  // нужны свежие (снимок из вебхука в отложенную работу не переносим).
  async _claimOutboundJob(kind, m, log) {
    const { fn } = OUTBOUND_ROUTES[kind];
    const { binding, skipped } = await this._resolveOutboundBinding(m, log, fn);
    if (skipped) return { skipped };

    const opKey = outboundOpKey(kind, m);
    const b24ChatId = m.b24ChatId ?? binding.b24ChatId ?? null;
    const payloadMeta = {
      kind: 'job',
      op: kind,
      opKey,
      connectorChatId: m.connectorChatId,
      b24ChatId,
      b24MsgId: String(m.b24MsgId),
      ...(kind === 'add' ? outboundJobContent(m) : {}),
      // id сообщений MAX из события удаления: у сообщения без записи в журнале (старше
      // журнала, запись без maxMids) других источников нет — повтор при разборе без них
      // получил бы no-maxmid и молча не удалил.
      ...(kind === 'delete' ? { externalIds: outboundEventMids(m) } : {}),
    };
    const claimed = await this.log.claimOutboundJob({
      bindingId: binding.id,
      jobKey: `${OUTBOUND_JOB_PREFIX}${opKey}`,
      payloadMeta,
    });
    if (!claimed) {
      log?.warn({ bindingId: binding.id, b24MsgId: m.b24MsgId, opKey }, `${fn}: duplicate-in-progress, skipping`);
      return { skipped: 'duplicate-in-progress' };
    }
    return { jobId: claimed.id, bindingId: binding.id, b24ChatId, opKey };
  }

  // M29: обработчики одного сообщения best-effort правки/удаления: маршрут и оповещение о
  // внутренней ошибке (M28 onError).
  _bestEffortHandlers(kind, log) {
    if (kind === 'edit') {
      return {
        handleOne: (x) => this._routeOutboundEditOne(x, { log }),
        onError: (x) => this._editInternalErrorNotify(x, log),
      };
    }
    return {
      handleOne: (x) => this._routeOutboundDeleteOne(x, { log }),
      onError: (x) => this._deleteInternalErrorNotify(x, log),
    };
  }

  // M29: задание очереди — прежний маршрут одного сообщения, итог в лог (queuedMs — сколько
  // ждало очереди чата), снятие строки job: всегда. Отправка бросает на ошибке БД/бага
  // (оповещение уже ушло в _routeOutboundOneOrNotify); правка и удаление не бросают.
  async _runOutboundJob(kind, m, claim, { log, acceptedAt, bypass }) {
    const { fn, errorVerdict } = OUTBOUND_ROUTES[kind];
    const startedAt = Date.now();
    const fields = {
      op: kind,
      bindingId: claim.bindingId,
      connectorChatId: m.connectorChatId,
      b24MsgId: m.b24MsgId,
      bypass,
    };
    try {
      let result;
      if (kind === 'add') {
        result = await this._routeOutboundOneOrNotify(m, log, { bindingId: claim.bindingId, b24ChatId: claim.b24ChatId });
      } else {
        const { handleOne, onError } = this._bestEffortHandlers(kind, log);
        result = await this._outboundBestEffortOne(m, log, fn, errorVerdict, handleOne, onError);
      }
      log?.info(
        {
          ...fields,
          verdict: result?.skipped ?? 'ok',
          queuedMs: startedAt - acceptedAt,
          durationMs: Date.now() - startedAt,
        },
        'outbound job done',
      );
      return result;
    } catch (err) {
      log?.error(
        {
          ...fields,
          queuedMs: startedAt - acceptedAt,
          durationMs: Date.now() - startedAt,
          err: { name: err?.name, message: err?.message },
        },
        'outbound job failed',
      );
      throw err;
    } finally {
      await this._releaseOutboundJobSafe(claim.jobId, log);
    }
  }

  // M29: снять строку задания — best-effort, ответ и очередь чата не ждут. Не снялась (БД) →
  // повторы в фоне (RELEASE_RETRY_MS, таймеры unref — процесс не держат). Исчерпаны → ERROR:
  // строка дождётся следующего старта, и разбор примет её за прерванную (запись операции
  // есть — только снимет; нет — оповестит «мост перезапускался»).
  async _releaseOutboundJobSafe(jobId, log) {
    try {
      await this._releaseOutboundJob(jobId, log);
    } catch (err) {
      log?.warn(
        { jobId, retryMs: RELEASE_RETRY_MS[0], err: { message: err?.message } },
        'outbound job release failed, retrying in background',
      );
      this._retryReleaseOutboundJob(jobId, log, 0);
    }
  }

  async _releaseOutboundJob(jobId, log) {
    const removed = await this.log.releaseOutboundJob(jobId);
    if (removed === 0) log?.debug({ jobId }, 'outbound job row already gone');
  }

  _retryReleaseOutboundJob(jobId, log, attempt) {
    const timer = setTimeout(async () => {
      try {
        await this._releaseOutboundJob(jobId, log);
        log?.info({ jobId, attempt: attempt + 1 }, 'outbound job released after retry');
      } catch (err) {
        if (attempt + 1 >= RELEASE_RETRY_MS.length) {
          log?.error(
            { jobId, attempts: RELEASE_RETRY_MS.length, err: { message: err?.message } },
            'outbound job release gave up (will be reported on next start)',
          );
          return;
        }
        this._retryReleaseOutboundJob(jobId, log, attempt + 1);
      }
    }, RELEASE_RETRY_MS[attempt]);
    timer.unref?.();
  }

  // M29: разбор передач, прерванных прошлым процессом (рестарт, падение, дедлайн дренажа):
  // строки job: со status 'in_progress', созданные раньше createdBefore (момент старта
  // процесса — свои новые строки не попадают). Зовёт server.js после listen, не дожидаясь:
  // до listen к БД не ходим (у пула нет connectionTimeoutMillis — недоступная БД повесила
  // бы старт). Ошибка БД при поиске → до attempts попыток с паузой retryMs. Задания идут
  // через очередь своего чата: сразу после поиска очередь каждого затронутого чата занимается
  // одним заданием, внутри которого строки этого чата разбираются по одной, в порядке id.
  // Так события, пришедшие после поиска, не обгоняют разбор своего чата (удаление частично
  // ушедшего сообщения находит дописанные части), лимит очереди чата не забивается, а дренаж
  // при остановке ждёт и разбор. Чаты разбираются параллельно, как обычные исходящие.
  // signal (остановка) проверяется перед каждой попыткой поиска и каждой строкой: оставшиеся
  // строки разберёт следующий старт. Никогда не бросает.
  // → { total, notified, completed, dropped, failedNotify, failed } (+ stopped, left).
  async recoverInterruptedOutbound({ createdBefore, signal = null, attempts = 5, retryMs = 5_000, logger } = {}) {
    const log = logger ?? this.logger;
    const summary = { total: 0, notified: 0, completed: 0, dropped: 0, failedNotify: 0, failed: 0 };
    const stoppedAt = (left) => {
      log?.info({ left }, 'interrupted outbound recovery stopped by shutdown');
      return { ...summary, stopped: true, left };
    };
    try {
      if (!(createdBefore instanceof Date) || Number.isNaN(createdBefore.getTime())) {
        log?.error(
          { createdBefore: createdBefore === undefined ? null : String(createdBefore) },
          'interrupted outbound recovery skipped: createdBefore (Date) required',
        );
        return summary;
      }

      let jobs = null;
      for (let attempt = 1; jobs === null; attempt += 1) {
        if (signal?.aborted) return stoppedAt(null);
        try {
          // eslint-disable-next-line no-await-in-loop
          jobs = await this.log.findOutboundJobs({ createdBefore });
        } catch (err) {
          if (attempt >= attempts) {
            log?.error(
              { attempts, err: { message: err?.message } },
              'interrupted outbound lookup gave up (rows wait for next start)',
            );
            return summary;
          }
          log?.warn(
            { attempt, attempts, retryMs, err: { message: err?.message } },
            'interrupted outbound lookup failed, retrying',
          );
          // eslint-disable-next-line no-await-in-loop
          await pause(retryMs, signal);
        }
      }

      summary.total = jobs.length;
      if (jobs.length === 0) {
        log?.debug('no interrupted outbound jobs');
        return summary;
      }
      log?.info({ count: jobs.length }, 'interrupted outbound jobs found');

      // Удаление того же сообщения среди прерванных: оператор его удалил — об отправке и
      // правке не оповещаем, отправку только дописываем в журнал (удаление сотрёт части).
      const deletedMsgs = new Set(jobs
        .filter((j) => j.payloadMeta?.op === 'delete')
        .map((j) => `${j.bindingId}:${j.payloadMeta?.b24MsgId}`));

      // Строки по чатам (порядок id сохраняется внутри чата).
      const byChat = new Map();
      for (const job of jobs) {
        const key = job.payloadMeta?.connectorChatId || 'recovery';
        if (!byChat.has(key)) byChat.set(key, []);
        byChat.get(key).push(job);
      }
      let started = 0;
      let stopped = false;
      const recoverChat = async (chatJobs) => {
        for (const job of chatJobs) {
          if (signal?.aborted) {
            stopped = true;
            return;
          }
          started += 1;
          const meta = job.payloadMeta ?? {};
          const deletedLater = meta.op !== 'delete' && deletedMsgs.has(`${job.bindingId}:${meta.b24MsgId}`);
          try {
            // eslint-disable-next-line no-await-in-loop
            summary[await this._recoverOutboundJob(job, { log, deletedLater })] += 1;
          } catch (err) {
            summary.failed += 1;
            log?.warn(
              { jobId: job.id, op: meta.op ?? null, b24MsgId: meta.b24MsgId ?? null, err: { message: err?.message } },
              'interrupted outbound job recovery failed, row released',
            );
          }
        }
      };
      if (signal?.aborted) return stoppedAt(jobs.length);
      // Все push — синхронно, в одном тике: места в очередях чатов заняты до любых новых событий.
      await Promise.all([...byChat].map(([key, chatJobs]) => this.outboundQueue.push(key, () => recoverChat(chatJobs))));
      if (stopped) return stoppedAt(jobs.length - started);
      log?.info(summary, 'interrupted outbound recovered');
      return summary;
    } catch (err) {
      log?.error({ err: { message: err?.message } }, 'interrupted outbound recovery failed');
      return summary;
    }
  }

  // M29: одна прерванная строка задания. → 'notified' | 'completed' | 'dropped' |
  // 'failedNotify'. Строка снимается всегда (finally): повторного оповещения на следующем
  // старте нет. Оповещения — без ответа на сообщение (REPLY_ID у системного сообщения Б24 не
  // сохраняет) и без цитаты текста; installation не передаём — b24 читает БД.
  async _recoverOutboundJob(job, { log, deletedLater = false } = {}) {
    const meta = job.payloadMeta ?? {};
    const fields = { jobId: job.id, op: meta.op ?? null, bindingId: job.bindingId, b24MsgId: meta.b24MsgId ?? null };
    try {
      if (!OUTBOUND_ROUTES[meta.op] || !meta.connectorChatId || !meta.opKey || !meta.b24MsgId) {
        log?.warn(fields, 'interrupted outbound job: malformed row, dropped');
        return 'dropped';
      }
      const { binding } = await this.bindings.resolveByConnectorChat(meta.connectorChatId);
      if (!binding) {
        log?.warn({ ...fields, connectorChatId: meta.connectorChatId }, 'interrupted outbound job: no binding, dropped');
        return 'dropped';
      }
      // Процесс упал между записью операции и снятием строки — операция выполнена.
      if (await this.log.findOutbound(binding.id, meta.opKey)) {
        log?.info(fields, 'interrupted outbound job: already done');
        return 'completed';
      }

      const ctx = {
        op: OUTBOUND_ROUTES[meta.op].op,
        b24ChatId: meta.b24ChatId ?? binding.b24ChatId ?? null,
        bindingId: binding.id,
        b24MsgId: meta.b24MsgId,
        logger: log,
      };
      if (meta.op === 'add') return await this._recoverOutboundSend(binding, meta, ctx, { log, deletedLater });

      if (meta.op === 'delete') {
        // Повтор путём M28: MAX на повторный DELETE того же mid отвечает success:true, так
        // что частично выполненное удаление повторять безопасно. id сообщений MAX — из
        // журнала и из события (externalIds строки задания). Сбой MAX оповестит сам маршрут;
        // no-maxmid — сообщения нет ни в журнале, ни в событии: удалять нечего, оповещения
        // нет, как у обычного удаления.
        const m = {
          connectorChatId: meta.connectorChatId,
          b24ChatId: ctx.b24ChatId,
          b24MsgId: meta.b24MsgId,
          externalIds: outboundEventMids(meta),
        };
        const { handleOne, onError } = this._bestEffortHandlers('delete', log);
        const result = await this._outboundBestEffortOne(m, log, 'routeOutboundDelete', 'delete-error', handleOne, onError);
        log?.info({ ...fields, verdict: result?.skipped ?? 'ok' }, 'interrupted outbound delete retried');
        return result?.notified ? 'notified' : 'completed';
      }

      // Правка: повторить нечем (текста в журнале нет) — оповестить, если сообщение не удалено.
      if (deletedLater) {
        log?.info(fields, 'interrupted outbound edit: message deleted later, not notifying');
        return 'completed';
      }
      return await this._notifyRecovery(ctx, editFailureNotice({ reason: RESTART_FAILURE_REASON }));
    } finally {
      await this._releaseOutboundJobSafe(job.id, log);
    }
  }

  // M29: прерванная отправка. Ушедшие файлы (записи file:<b24MsgId>:<n>) дописываются
  // итоговой записью — по ней удаление в ОЛ потом сотрёт их в MAX — и статусом доставки в
  // Б24. Об остальном (файлы по именам, текст) — оповещение «мост перезапускался».
  // Итоговая запись создаётся сейчас, на старте, а файлы ушли до рестарта: время самой ранней
  // записи части идёт в payloadMeta.sentAt — по нему считается возраст сообщения в оповещении
  // «MAX не разрешил удалить» (иначе после простоя возраст занижен на время простоя).
  async _recoverOutboundSend(binding, meta, ctx, { log, deletedLater }) {
    const filesCount = Number.isInteger(meta.filesCount) && meta.filesCount > 0 ? meta.filesCount : 0;
    const fileNames = Array.isArray(meta.fileNames) ? meta.fileNames : [];
    const parts = [];
    const failures = [];
    let sentAtMs = null;
    for (let n = 0; n < filesCount; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const part = await this.log.findOutbound(binding.id, `file:${meta.b24MsgId}:${n}`);
      if (part) {
        parts.push(part.payloadMeta ?? {});
        const at = part.createdAt instanceof Date ? part.createdAt.getTime() : Date.parse(part.createdAt ?? '');
        if (Number.isFinite(at) && (sentAtMs === null || at < sentAtMs)) sentAtMs = at;
      } else {
        failures.push({ name: fileLabel(fileNames[n], n), reason: RESTART_FAILURE_REASON });
      }
    }
    // Подпись уходит с первым доставленным файлом; не ушла ни с одним — текст не доставлен.
    if (meta.hasText && !parts.some((p) => p.withCaption)) {
      failures.push({ name: null, reason: RESTART_FAILURE_REASON });
    }

    const maxMids = parts.map((p) => p.maxMid).filter(Boolean);
    if (maxMids.length > 0) {
      const kinds = parts.map((p) => p.type).filter(Boolean);
      const failedCount = filesCount - parts.length;
      const recorded = await this.log.recordOutbound({
        bindingId: binding.id,
        b24MsgId: meta.b24MsgId,
        payloadMeta: {
          maxMid: maxMids[0],
          maxMids,
          textPrefix: meta.textPrefix ?? '',
          filesCount: parts.length,
          kinds,
          ...(failedCount > 0 ? { failedCount } : {}),
          interrupted: true,
          ...(sentAtMs !== null ? { sentAt: new Date(sentAtMs).toISOString() } : {}),
        },
      });
      log?.info(
        { bindingId: binding.id, b24MsgId: meta.b24MsgId, delivered: parts.length, filesCount, recorded: Boolean(recorded) },
        'interrupted outbound send: delivered parts recorded',
      );
      // Сообщение удалено в ОЛ — статус доставки ему уже не нужен.
      if (!deletedLater) {
        await this._sendDeliveryStatusSafe(
          {
            bindingId: binding.id,
            b24ChatId: ctx.b24ChatId,
            b24MsgId: meta.b24MsgId,
            maxMids,
            date: toUnixSeconds(null),
            connectorChatId: meta.connectorChatId,
          },
          log,
          'recoverOutbound',
        );
      }
    }

    if (deletedLater) {
      log?.info({ bindingId: binding.id, b24MsgId: meta.b24MsgId }, 'interrupted outbound send: message deleted later, not notifying');
      return 'completed';
    }
    if (failures.length === 0) return 'completed';
    return this._notifyRecovery(ctx, sendFailureNotice(failures));
  }

  // M29: оповещение о прерванной передаче. notifyOperator повторов не делает — здесь ещё
  // RECOVERY_NOTICE_RETRY_MS попыток на send-failed (чат ждёт ≤ ~7 с, только если Б24
  // сбоит); no-chat — без повторов. → 'notified' | 'failedNotify'.
  async _notifyRecovery(ctx, text) {
    const log = ctx.logger ?? this.logger;
    let res = null;
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      res = await this.notifyOperator({ ...ctx, text });
      if (res.notified) return 'notified';
      if (res.reason !== 'send-failed' || attempt >= RECOVERY_NOTICE_RETRY_MS.length) break;
      // eslint-disable-next-line no-await-in-loop
      await pause(RECOVERY_NOTICE_RETRY_MS[attempt]);
    }
    log?.error(
      { op: ctx.op, bindingId: ctx.bindingId, b24MsgId: ctx.b24MsgId, reason: res?.reason ?? null },
      'recovery notice failed, giving up',
    );
    return 'failedNotify';
  }

  async _routeOutboundOne(m, log) {
    const { connectorChatId, b24ChatId, b24MsgId, userId, text: rawText } = m;

    // 1-2) guard обязательных полей + resolve binding (+ installation для вызовов Б24)
    const { binding, installation, skipped } = await this._resolveOutboundBinding(m, log, 'routeOutbound');
    if (skipped) return { skipped };

    // 3) идемпотентность по b24_msg_id (_once): дубль отсекается ДО отправки в MAX.
    // Запись — если в MAX ушла хоть одна часть (M22); ничего не ушло → записи нет.
    let timestampMs = null;
    let failures = [];
    const result = await this._once(
      {
        direction: 'outbound',
        bindingId: binding.id,
        key: b24MsgId,
        fn: 'routeOutbound',
        log,
        done: 'delivered to MAX',
      },
      async () => {
        // 4) контент: текст (BB → markdown, M5.3) + медиа оператора (M11.2).
        const text = bbcodeToMarkdown(rawText);
        const files = Array.isArray(m.files) ? m.files : [];
        log?.debug(
          {
            bindingId: binding.id,
            b24MsgId,
            textPrefix: text.slice(0, MAX_TEXT_PREFIX),
            filesCount: files.length,
          },
          'routeOutbound: bb-converted text + files',
        );
        // M11.2: skip только когда НЕТ ни текста, ни файлов (файл-без-текста больше не дропаем).
        if (!text && files.length === 0) {
          log?.warn({ bindingId: binding.id, b24MsgId }, 'routeOutbound: empty-message (no text, no files)');
          return { skipped: 'empty-message' };
        }

        // 5) отправка в MAX. Недоставка → failures (оповещение после _once), не throw.
        const sent = files.length > 0
          ? await this._sendOutboundMedia(binding, m, files, log)
          : await this._sendOutboundText(binding, m, text, log, { installation });
        failures = sent.failures ?? [];
        if (sent.skipped) return { skipped: sent.skipped };
        const { maxMids, kinds, replyLink } = sent;
        timestampMs = sent.timestampMs;
        const maxMid = maxMids[0] ?? null;
        const failedFiles = failures.length;

        return {
          payloadMeta: {
            maxMid,
            userId,
            textPrefix: text.slice(0, MAX_TEXT_PREFIX),
            // M11.2: media-метаданные (без миграции — через существующий jsonb).
            // M22: maxMids — все сообщения MAX (по одному на файл) для удаления.
            ...(kinds.length > 0 ? { filesCount: kinds.length, kinds, maxMids } : {}),
            ...(failedFiles > 0 ? { failedCount: failedFiles } : {}),
          },
          result: {
            ok: true,
            bindingId: binding.id,
            b24MsgId,
            maxMid,
            ...(kinds.length > 0 ? { maxMids } : {}),
            ...(failedFiles > 0 ? { failedFiles } : {}),
          },
          logFields: { b24MsgId, maxMid, filesCount: kinds.length, failedFiles, reply: Boolean(replyLink) },
        };
      },
    );

    // 6) недоставка (частичная или полная) → системное сообщение оператору. Чат ОЛ — из
    // события, иначе из привязки.
    if (failures.length > 0) {
      await this.notifyOperator({
        op: 'send',
        b24ChatId: b24ChatId ?? binding.b24ChatId,
        text: sendFailureNotice(failures),
        bindingId: binding.id,
        b24MsgId,
        installation,
        logger: log,
      });
    }
    if (result.skipped) return result;

    // 7) delivery status — best-effort, никогда не валит outbound.
    const maxMids = result.maxMids ?? [result.maxMid].filter(Boolean);
    if (maxMids.length === 0) {
      log?.warn(
        { bindingId: binding.id, b24MsgId },
        'routeOutbound: no maxMid from MAX, skipping delivery status',
      );
    } else {
      await this._sendDeliveryStatusSafe(
        {
          bindingId: binding.id,
          b24ChatId,
          b24MsgId,
          maxMids,
          date: toUnixSeconds(timestampMs),
          connectorChatId,
          installation,
        },
        log,
        'routeOutbound',
      );
    }
    return result;
  }

  // M11.2/M22: медиа OL → MAX. Файлы — по одному (скачал → залил → отправил → записал →
  // удалил временный файл): у каждого свой ключ file:<b24MsgId>:<idx> в message_log, так
  // что повтор события не шлёт уже ушедшие файлы, а сбой одного не теряет остальные.
  // Подпись оператора — с первым реально доставленным файлом; не ушёл ни один — подпись
  // уходит текстом. Возвращает { maxMids, timestampMs, kinds, failures } либо
  // { skipped: 'delivery-failed' | 'empty-message', failures }.
  async _sendOutboundMedia(binding, m, files, log) {
    const { b24MsgId, text: rawText } = m;
    // подпись оператора: реальный комментарий, а не filename-ярлык.
    const caption = resolveMediaCaption(rawText, files);
    const maxMids = [];
    const kinds = [];
    const failures = [];
    let delivered = 0;
    let timestampMs = null;
    let captionPending = Boolean(caption);

    for (let idx = 0; idx < files.length; idx += 1) {
      const f = files[idx];
      let part;
      try {
        // eslint-disable-next-line no-await-in-loop
        part = await this._sendOutboundFile(binding, m, f, idx, captionPending ? caption : '', log);
      } catch (err) {
        const failure = sendFailureItem(err, fileLabel(f.name, idx));
        if (!failure) throw err; // БД/баг — не недоставка → 500
        // M30: mime/b24Type — по ним видно отказ MAX по формату (видео вне MP4/MOV/MKV/WEBM)
        // без пробы; type в строках доставки — уже тип заливки MAX, поэтому здесь b24Type.
        log?.error(
          {
            bindingId: binding.id, b24MsgId, idx, mime: f.mime ?? null, b24Type: f.type ?? null,
            reason: failure.reason, err: { name: err?.name, message: err?.message },
          },
          'routeOutbound: file not delivered to MAX',
        );
        failures.push(failure);
        continue;
      }
      delivered += 1;
      if (part.maxMid) maxMids.push(part.maxMid);
      if (part.type) kinds.push(part.type);
      timestampMs ??= part.timestampMs;
      if (part.withCaption) captionPending = false;
    }

    if (delivered === 0 && captionPending) {
      // ни один файл не ушёл, а комментарий есть — шлём его текстом.
      try {
        const ref = await this.max.sendOutgoingMessage(
          new MaxMessage({ chatId: binding.maxChatId, text: caption, format: MAX_OUTBOUND_FORMAT }),
        );
        return { maxMids: [ref.maxMid].filter(Boolean), timestampMs: ref.timestampMs, kinds: [], failures };
      } catch (err) {
        const failure = sendFailureItem(err);
        if (!failure) throw err;
        failures.push(failure);
      }
    }
    if (delivered === 0) {
      log?.warn({ bindingId: binding.id, b24MsgId, failed: failures.length }, 'routeOutbound: nothing delivered to MAX');
      return { skipped: failures.length > 0 ? 'delivery-failed' : 'empty-message', failures };
    }
    return { maxMids, timestampMs, kinds, failures };
  }

  // M22: один файл оператора → одно сообщение MAX, под семафором передач и своим _once.
  // Временный файл удаляется в finally (и после успеха, и после сбоя). Повтор события
  // (дубль ключа) берёт maxMid уже ушедшего файла из записи. Бросает при недоставке.
  // M28: перезаливка отвергнутого MAX типа файлом (maxService.uploadAndSend) идёт внутри
  // этого же слота семафора и этого же _once, тем же временным файлом — запись одна.
  async _sendOutboundFile(binding, { b24MsgId }, f, idx, text, log) {
    const key = `file:${b24MsgId}:${idx}`;
    return this._mediaSlots.run(async () => {
      const out = await this._once(
        { direction: 'outbound', bindingId: binding.id, key, fn: 'routeOutboundFile', log, done: 'file delivered to MAX' },
        async () => {
          // Заявленный в событии размер отсекает заведомо большой файл ДО скачивания;
          // фактический ограничивает скачивание (Content-Length и счётчик байт).
          const declared = Number(f.size);
          if (f.size != null && Number.isFinite(declared) && declared > this.mediaMaxBytes) {
            throw new MediaTooLargeError(`declared size ${declared} exceeds limit`, { size: declared, limit: this.mediaMaxBytes });
          }
          const tmpPath = await this.mediaTemp.allocate();
          try {
            const dl = await this.b24.downloadOperatorFile(f.downloadLink, {
              destPath: tmpPath,
              maxBytes: this.mediaMaxBytes,
              timeoutMs: this.mediaTransferTimeoutMs,
            });
            const type = maxUploadTypeForFile(f, dl.size);
            const ref = await this.max.uploadAndSend(
              {
                chatId: binding.maxChatId,
                file: { path: tmpPath, filename: f.name, contentType: dl.contentType },
                type,
                text,
                // подпись BB→markdown — рендерим как форматирование (жирное имя автора),
                // а не сырыми `**` (M11.2 live-фикс).
                format: text ? MAX_OUTBOUND_FORMAT : null,
              },
              { logger: log },
            );
            const withCaption = Boolean(text);
            // M28: MAX отверг тип (картинку и т.п.) → maxService перезалил тот же файл как
            // `file`: в журнал и в kinds — фактический тип, исходный — в fallbackFrom.
            const sentType = ref.type ?? type;
            const fallback = ref.fallbackFrom ? { fallbackFrom: ref.fallbackFrom } : {};
            const mime = f.mime ?? null;
            // Размеры картинки из события — в лог: видно, ушла ли она файлом превентивно.
            const dims = f.width || f.height ? { width: f.width ?? null, height: f.height ?? null } : {};
            return {
              payloadMeta: {
                kind: 'file', origB24MsgId: b24MsgId, idx, maxMid: ref.maxMid, type: sentType, mime, size: dl.size, withCaption, ...fallback,
              },
              result: { maxMid: ref.maxMid, timestampMs: ref.timestampMs, type: sentType, withCaption },
              logFields: { b24MsgId, idx, maxMid: ref.maxMid, type: sentType, mime, size: dl.size, ...dims, ...fallback },
            };
          } finally {
            await this.mediaTemp.remove(tmpPath);
          }
        },
      );
      if (!out.skipped) return out;
      // Дубль: файл ушёл раньше (повтор события) — берём его ссылку из записи.
      const meta = (await this.log.findOutbound(binding.id, key))?.payloadMeta ?? {};
      return { maxMid: meta.maxMid ?? null, timestampMs: null, type: meta.type ?? null, withCaption: Boolean(meta.withCaption) };
    });
  }

  // Текст-только (M5.2/M5.3). Reply/цитирование (OL→MAX): добор нативного reply через
  // im.dialog.messages.search (best-effort, +1 REST/исходящее, gated
  // config.reply.resolveOutbound). Любая ошибка/null → шлём БЕЗ link (мост не падает).
  // limit передаём явно (владелец config.reply.searchLimit — координатор, а не
  // b24Service). Media-reply вне MVP. Возвращает { maxMids:[mid], timestampMs, kinds:[],
  // replyLink } либо { skipped: 'delivery-failed', failures } (M22).
  // installation (M28) — снимок из резолва привязки (null → b24 читает БД).
  async _sendOutboundText(binding, { b24ChatId, b24MsgId }, text, log, { installation = null } = {}) {
    let replyLink = null;
    if (this.reply.resolveOutbound) {
      try {
        const rc = await this.b24.resolveReplyContext({
          b24ChatId,
          b24MsgId,
          limit: this.reply.searchLimit,
          ...(installation ? { installation } : {}),
        });
        if (rc) {
          const { maxMid: parentMaxMid } = await this._resolveReplyMaxMid({
            binding,
            replyContext: rc,
            logger: log,
          });
          if (parentMaxMid) replyLink = { type: 'reply', mid: parentMaxMid };
        }
      } catch (err) {
        log?.warn(
          { bindingId: binding.id, b24MsgId, err: { message: err?.message } },
          'routeOutbound: reply resolve failed (best-effort, sending without link)',
        );
      }
      log?.debug(
        { bindingId: binding.id, b24MsgId, replyMidPresent: Boolean(replyLink) },
        'routeOutbound: reply resolved',
      );
    }
    const maxMessage = new MaxMessage({
      chatId: binding.maxChatId,
      text,
      format: MAX_OUTBOUND_FORMAT,
      ...(replyLink ? { link: replyLink } : {}),
    });
    log?.debug(
      { bindingId: binding.id, b24MsgId, chatId: binding.maxChatId, textPrefix: text.slice(0, MAX_TEXT_PREFIX) },
      'routeOutbound: sending to MAX',
    );
    let sentRef;
    try {
      sentRef = await this.max.sendOutgoingMessage(maxMessage);
    } catch (err) {
      const failure = sendFailureItem(err);
      if (!failure) throw err;
      log?.error(
        { bindingId: binding.id, b24MsgId, chatId: binding.maxChatId, reason: failure.reason, err: { message: err?.message } },
        'routeOutbound: MAX send failed, not recording (operator will be notified)',
      );
      return { skipped: 'delivery-failed', failures: [failure] };
    }
    return { maxMids: [sentRef.maxMid].filter(Boolean), timestampMs: sentRef.timestampMs, kinds: [], replyLink };
  }

  // Best-effort обвязка исходящих правки/удаления: НИКОГДА не бросает наружу — ошибка
  // по одному сообщению → лог + errorVerdict, контроллер отдаёт 200 (Б24 не ретраит).
  // M28: onError(m) — оповещение оператора о внутренней ошибке (привязка здесь неизвестна,
  // только im.chat_id события); его собственный сбой тоже глотается.
  // Петель нет: эхо-защита B24 не триггерит update/delete на действия из внешнего канала
  // (нашего). isMessageAdd guard НЕ применяем — работаем по normalizedMessages().
  async _routeOutboundBestEffort(openLineEvent, log, fn, errorVerdict, handleOne, onError = null) {
    if (!openLineEvent) {
      throw new ValidationError(`${fn}: event required`);
    }
    const messages = openLineEvent.normalizedMessages();
    if (messages.length === 0) {
      log?.warn({ lineId: openLineEvent.lineId }, `${fn}: no-messages in event`);
      return { skipped: 'no-messages' };
    }

    const results = [];
    for (const m of messages) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this._outboundBestEffortOne(m, log, fn, errorVerdict, handleOne, onError));
    }
    return { ok: true, results };
  }

  // Одно сообщение best-effort правки/удаления (M29: его же зовут задание очереди и
  // восстановление прерванных). Никогда не бросает: ошибка → ERROR, onError(m), вердикт
  // errorVerdict.
  async _outboundBestEffortOne(m, log, fn, errorVerdict, handleOne, onError = null) {
    try {
      return await handleOne(m);
    } catch (err) {
      log?.error(
        {
          connectorChatId: m?.connectorChatId ?? null,
          b24MsgId: m?.b24MsgId ?? null,
          err: { message: err?.message },
        },
        `${fn}: failed (swallowed, returning 200)`,
      );
      if (onError) {
        try {
          await onError(m);
        } catch (notifyErr) {
          log?.warn(
            { b24MsgId: m?.b24MsgId ?? null, err: { message: notifyErr?.message } },
            `${fn}: operator notification on error failed (swallowed)`,
          );
        }
      }
      return { skipped: errorVerdict };
    }
  }

  // OUTBOUND-правка OL → MAX (OnImConnectorMessageUpdate). Best-effort (см.
  // _routeOutboundBestEffort): Б24 событие не повторяет, поэтому неудача правки (M28) видна
  // оператору системным сообщением в чате ОЛ, а вебхук отвечает 200:
  //   - сбой MAX (транспорт, HTTP, success:false) → skip 'edit-failed' + оповещение;
  //   - сообщения нет в MAX → skip 'no-maxmid' + оповещение «не найдено»;
  //   - внутренняя ошибка (БД, баг) → skip 'edit-error' + оповещение «могла не дойти».
  // Идемпотентность — синтетический ключ edit:<b24MsgId>:<contentToken>,
  // contentToken = contentHash(новый текст) (НЕ «голый» b24MsgId — он нашёл бы запись
  // оригинала). По доке OnImConnectorMessageUpdate per-message message.date НЕТ (сверено
  // docs MCP 2026-06-17) → editTs всегда null, как часть ключа непригоден; токен текста
  // различает повторные правки одного сообщения.
  //
  // logger: scoped-логгер с requestId (протащен из b24Controller через b24Service).
  async routeOutboundEdit(openLineEvent, { logger } = {}) {
    const log = logger ?? this.logger;
    return this._routeOutboundBestEffort(
      openLineEvent,
      log,
      'routeOutboundEdit',
      'edit-error',
      (m) => this._routeOutboundEditOne(m, { log }),
      (m) => this._editInternalErrorNotify(m, log),
    );
  }

  // M28: оповещение о внутренней ошибке правки (onError best-effort обвязки). Исход
  // неизвестен — правка могла и дойти до MAX (упала, например, запись в журнал).
  _editInternalErrorNotify(m, log) {
    return this.notifyOperator({
      op: 'edit',
      b24ChatId: m?.b24ChatId,
      b24MsgId: m?.b24MsgId,
      text: editFailureNotice({ reason: INTERNAL_FAILURE_REASON, uncertain: true }),
      logger: log,
    });
  }

  // Обработка одной правки. Может бросить — _routeOutboundBestEffort ловит.
  async _routeOutboundEditOne(m, { log } = {}) {
    const { connectorChatId, b24ChatId, b24MsgId, userId, text: rawText, editTs } = m;

    // 1-2) guard обязательных полей + resolve binding (+ installation для вызовов Б24)
    const { binding, installation, skipped } = await this._resolveOutboundBinding(m, log, 'routeOutboundEdit');
    if (skipped) return { skipped };

    // Оповещение оператора о неудаче (M28): чат ОЛ — из события, иначе из привязки.
    const notice = {
      op: 'edit', b24ChatId: b24ChatId ?? binding.b24ChatId, bindingId: binding.id, b24MsgId, installation, logger: log,
    };

    // 3) maxMid правимого сообщения в MAX. M22: у сообщения из нескольких файлов правится
    // первое (на нём подпись); статус доставки ниже несёт все — иначе Б24 забыл бы остальные.
    // M28: не нашли — правка молча не дойдёт (исходное до MAX не доходило, старше журнала
    // или ещё доставляется) → оповещение «не найдено».
    const { maxMids } = await this._resolveOutboundMaxMids(binding, m, log, 'routeOutboundEdit');
    if (maxMids.length === 0) {
      const { notified } = await this.notifyOperator({ ...notice, text: editFailureNotice({ notFound: true }) });
      return { skipped: 'no-maxmid', notified };
    }
    const [maxMid] = maxMids;

    // 4) идемпотентность правки — синтетический ключ edit:<b24MsgId>:<contentToken>.
    // НЕ «голый» b24MsgId: он нашёл бы запись оригинала и отсёк бы как duplicate.
    // contentToken = contentHash(новый текст). По доке OnImConnectorMessageUpdate per-message
    // message.date в событии НЕТ (сверено docs MCP 2026-06-17) → editTs всегда null и как
    // компонента ключа непригоден. Хеш текста даёт нужную семантику:
    //   - разный текст правки → разный токен → повторная правка доходит до MAX (фикс бага);
    //   - тот же текст (ретрай вебхука) → тот же токен → корректно дедупится.
    // Corner-case A→B→A (возврат к ровно прежнему тексту): коллизия токена → второй возврат
    // ложно дедупится; редко, без падения, диагностируемо по логу 'duplicate-edit'.
    let timestampMs = null;
    let failure = null;
    const result = await this._once(
      {
        direction: 'outbound',
        bindingId: binding.id,
        key: outboundOpKey('edit', m),
        fn: 'routeOutboundEdit',
        log,
        duplicate: 'duplicate-edit',
        done: 'edit applied to MAX',
      },
      async () => {
        // 5) текст BB → markdown. Маркер на MAX-стороне НЕ добавляем (MAX сам ставит «Ред.»).
        const text = bbcodeToMarkdown(rawText);
        if (!text) {
          // Медиа-правка вне скоупа MVP; пустой текст править нечем.
          log?.warn({ bindingId: binding.id, b24MsgId }, 'routeOutboundEdit: empty-edit (no text)');
          return { skipped: 'empty-edit' };
        }

        // 6) правка в MAX через фасад maxService.editOutgoing (НЕ maxClient напрямую).
        // M28: сбой MAX (MaxApiError, в т.ч. success:false — kind 'rejected') → без записи
        // и без статуса доставки, skip 'edit-failed' + оповещение после _once: повтор
        // события (если будет) — новая попытка. Прочая ошибка (баг) → проброс →
        // _routeOutboundBestEffort → skip 'edit-error'.
        log?.debug(
          { bindingId: binding.id, b24MsgId, maxMid, textPrefix: text.slice(0, MAX_TEXT_PREFIX) },
          'routeOutboundEdit: editing MAX message',
        );
        try {
          ({ timestampMs } = await this.max.editOutgoing({ messageId: maxMid, text, format: MAX_OUTBOUND_FORMAT }));
        } catch (err) {
          // Не deliveryFailureReason !== null: та отдаёт причину и для B24ApiError /
          // MediaTooLargeError, которых здесь быть не должно — пусть идут в edit-error.
          if (!(err instanceof MaxApiError)) throw err;
          const reason = deliveryFailureReason(err);
          log?.error(
            {
              bindingId: binding.id,
              b24MsgId,
              maxMid,
              reason,
              kind: err.kind,
              httpStatus: err.httpStatus,
              maxCode: err.maxCode,
              err: { message: err.message },
            },
            'routeOutboundEdit: MAX edit failed, not recording (operator will be notified)',
          );
          failure = { reason, uncertain: isUncertainFailure(err), textTooLong: isTextTooLongFailure(err) };
          return { skipped: 'edit-failed' };
        }

        return {
          payloadMeta: {
            kind: 'edit',
            origB24MsgId: b24MsgId,
            maxMid,
            userId,
            textPrefix: text.slice(0, MAX_TEXT_PREFIX),
          },
          result: { ok: true, bindingId: binding.id, b24MsgId, maxMid },
          logFields: { b24MsgId, maxMid },
        };
      },
    );
    if (failure) {
      const { notified } = await this.notifyOperator({ ...notice, text: editFailureNotice(failure) });
      return { skipped: 'edit-failed', notified };
    }
    if (result.skipped) return result;

    // 7) delivery status — best-effort (дока события …MessageUpdate требует вызвать
    // после обработки правки). editTs (message.date) в событии не приходит (см. шаг 4) →
    // всегда падаем в fallback на timestamp ответа MAX / Date.now(). Корневой event-`ts`
    // сознательно НЕ используем (per-EVENT, ретрай-ненадёжен); date здесь — best-effort.
    await this._sendDeliveryStatusSafe(
      {
        bindingId: binding.id,
        b24ChatId,
        b24MsgId,
        maxMids,
        date: editTs ?? toUnixSeconds(timestampMs),
        connectorChatId,
        installation,
      },
      log,
      'routeOutboundEdit',
    );
    return result;
  }

  // OUTBOUND-удаление OL → MAX (OnImConnectorMessageDelete). Best-effort (см.
  // _routeOutboundBestEffort): Б24 событие не повторяет, поэтому неудача удаления (M28)
  // видна оператору системным сообщением в чате ОЛ, а вебхук отвечает 200:
  //   - все сообщения MAX не удалились из-за сбоя MAX → skip 'delete-failed' + оповещение;
  //   - MAX отказал (success:false) на все → skip 'max-window' + оповещение с возрастом;
  //   - удалено не всё → запись + оповещение «не полностью»;
  //   - внутренняя ошибка (БД, баг) → skip 'delete-error' + оповещение «могло не дойти».
  // Исход и причину решают mid из журнала (пуст — все): id, пришедшие только в событии,
  // на них не влияют.
  // Сообщения нет в MAX (no-maxmid) — без оповещения: обычно оно туда и не доходило.
  // Идемпотентность — синтетический ключ delete:<b24MsgId> (без <ts>: удалить можно лишь
  // раз; НЕ «голый» b24MsgId — он нашёл бы запись оригинала). Delivery-status НЕ шлём
  // (для удаления не требуется).
  //
  // logger: scoped-логгер с requestId (протащен из b24Controller через b24Service).
  async routeOutboundDelete(openLineEvent, { logger } = {}) {
    const log = logger ?? this.logger;
    return this._routeOutboundBestEffort(
      openLineEvent,
      log,
      'routeOutboundDelete',
      'delete-error',
      (m) => this._routeOutboundDeleteOne(m, { log }),
      (m) => this._deleteInternalErrorNotify(m, log),
    );
  }

  // M28: оповещение о внутренней ошибке удаления (onError best-effort обвязки). Исход
  // неизвестен — удаление могло и дойти до MAX.
  _deleteInternalErrorNotify(m, log) {
    return this.notifyOperator({
      op: 'delete',
      b24ChatId: m?.b24ChatId,
      b24MsgId: m?.b24MsgId,
      text: deleteFailureNotice({ reason: INTERNAL_FAILURE_REASON, uncertain: true }),
      logger: log,
    });
  }

  // Обработка одного удаления. Может бросить — _routeOutboundBestEffort ловит.
  async _routeOutboundDeleteOne(m, { log } = {}) {
    const { b24ChatId, b24MsgId } = m;

    // 1-2) guard обязательных полей + resolve binding (+ installation для оповещения)
    const { binding, installation, skipped } = await this._resolveOutboundBinding(m, log, 'routeOutboundDelete');
    if (skipped) return { skipped };

    // 3) maxMid'ы удаляемого сообщения в MAX (M22: по одному на файл). Не нашли — без
    // оповещения (M28): в MAX удалять нечего (кроме удаления во время заливки файла).
    const { maxMids, logMids, sentAt } = await this._resolveOutboundMaxMids(binding, m, log, 'routeOutboundDelete');
    if (maxMids.length === 0) return { skipped: 'no-maxmid' };

    // 4) идемпотентность удаления — синтетический ключ delete:<b24MsgId> (без <ts>).
    // НЕ «голый» b24MsgId: он нашёл бы запись оригинала и отсёк бы как duplicate.
    let noticeText = null;
    const result = await this._once(
      {
        direction: 'outbound',
        bindingId: binding.id,
        key: outboundOpKey('delete', m),
        fn: 'routeOutboundDelete',
        log,
        duplicate: 'duplicate-delete',
        done: 'delete applied to MAX',
      },
      async () => {
        // 5) удаление в MAX через фасад maxService.deleteOutgoing (НЕ maxClient напрямую),
        // каждое сообщение — отдельно: сбой одного не мешает остальным. MAX идемпотентен
        // (повтор того же mid → снова success:true). success:false → deleted:false, причина
        // — в maxMessage (лимита по давности нет: live удалено и через 63 ч).
        log?.debug(
          { bindingId: binding.id, b24MsgId, count: maxMids.length },
          'routeOutboundDelete: deleting MAX message',
        );
        const failed = []; // [{ maxMid, err }] — err null у success:false
        for (const maxMid of maxMids) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const { deleted, maxMessage } = await this.max.deleteOutgoing({ messageId: maxMid });
            if (deleted) continue;
            failed.push({ maxMid, err: null });
            log?.warn(
              { bindingId: binding.id, b24MsgId, maxMid, maxMessage: maxMessage ?? null },
              'routeOutboundDelete: MAX returned success:false for one message',
            );
          } catch (err) {
            failed.push({ maxMid, err });
            log?.warn(
              {
                bindingId: binding.id,
                b24MsgId,
                maxMid,
                kind: err?.kind ?? null,
                httpStatus: err?.httpStatus ?? null,
                maxCode: err?.maxCode ?? null,
                err: { message: err?.message },
              },
              'routeOutboundDelete: MAX delete failed for one message',
            );
          }
        }
        const deletedCount = maxMids.length - failed.length;
        // Исход решают только учитываемые mid — из журнала: id, который пришёл лишь в
        // событии (форма нескольких id в событии удаления не гарантирована — например,
        // склейка, на которую MAX ответит 400), не должен ни давать ложное «не полностью»,
        // ни подменять своей ошибкой отказ success:false по mid журнала. Журнал пуст
        // (запись старше M22 или её нет) → учитываем все.
        const counted = logMids.length > 0 ? logMids : maxMids;
        const notDeleted = failed.filter((f) => counted.includes(f.maxMid));
        const countedError = notDeleted.find((f) => f.err)?.err ?? null;
        const eventOnlyNotDeleted = failed.filter((f) => !counted.includes(f.maxMid)).map((f) => f.maxMid);

        // Итог: не удалено ничего и у учитываемых mid был сбой → не MAX (баг) — throw →
        // delete-error; MAX — skip 'delete-failed'. Не удалено ничего, а учитываемые mid
        // ответили только success:false → skip 'max-window' (ошибка id «только из события» —
        // лишь в WARN по этому mid). Без записи: повтор события (если будет) — новая попытка.
        if (deletedCount === 0 && countedError) {
          if (!(countedError instanceof MaxApiError)) throw countedError;
          const reason = deliveryFailureReason(countedError);
          log?.error(
            { bindingId: binding.id, b24MsgId, count: maxMids.length, reason, kind: countedError.kind },
            'routeOutboundDelete: MAX delete failed, not recording (operator will be notified)',
          );
          noticeText = deleteFailureNotice({ reason, uncertain: isUncertainFailure(countedError) });
          return { skipped: 'delete-failed' };
        }
        if (deletedCount === 0) {
          const ageHours = hoursSince(sentAt);
          log?.warn(
            {
              bindingId: binding.id,
              b24MsgId,
              count: maxMids.length,
              ageHours,
              ...(eventOnlyNotDeleted.length > 0 ? { eventOnlyNotDeleted } : {}),
            },
            'routeOutboundDelete: MAX refused to delete (success:false), not recording (operator will be notified)',
          );
          noticeText = deleteWindowNotice({ ageHours });
          return { skipped: 'max-window' };
        }

        // Удалено не всё → «не полностью» по учитываемым mid (см. выше). Не удалились лишь
        // id «только из события» при полностью удалённом журнале — оператору не показываем.
        if (failed.length > 0) {
          if (notDeleted.length > 0) {
            noticeText = deleteFailureNotice({
              reason: countedError
                ? (deliveryFailureReason(countedError) ?? INTERNAL_FAILURE_REASON)
                : 'MAX не разрешил удалить',
              notDeleted: notDeleted.length,
              total: counted.length,
            });
          } else {
            log?.warn(
              { bindingId: binding.id, b24MsgId, notDeleted: failed.map((f) => f.maxMid) },
              'routeOutboundDelete: only event-only ids not deleted, message_log ids deleted — not notifying',
            );
          }
        }

        const [maxMid] = maxMids;
        return {
          payloadMeta: {
            kind: 'delete',
            origB24MsgId: b24MsgId,
            maxMid,
            ...(maxMids.length > 1 ? { maxMids, deletedCount } : {}),
          },
          result: { ok: true, bindingId: binding.id, b24MsgId, maxMid, ...(maxMids.length > 1 ? { deletedCount } : {}) },
          logFields: { b24MsgId, maxMid, deletedCount, notDeleted: failed.length },
        };
      },
    );

    // 6) неудача (полная или частичная) → системное сообщение оператору. Чат ОЛ — из
    // события, иначе из привязки.
    if (noticeText) {
      const { notified } = await this.notifyOperator({
        op: 'delete',
        b24ChatId: b24ChatId ?? binding.b24ChatId,
        text: noticeText,
        bindingId: binding.id,
        b24MsgId,
        installation,
        logger: log,
      });
      return { ...result, notified };
    }
    return result;
  }

  // M24: группу переименовали в MAX (chat_title_changed) → название чата OL. MAX главный:
  // ручное имя оператора перезатирается. Неподключённую группу не
  // онбордим — название возьмёт интро на первом сообщении. Эффект под _once — только запись
  // названия в chat_bindings (ошибка БД → 500 → MAX ретраит). Переименование в Б24 — после,
  // best-effort: при закрытой сессии название применится на следующем входящем, а флаг
  // опенера взводится (M27: второй сигнал закрытия, если Finish потерян). Ключ —
  // chat_title_changed:<chatId>:<timestamp> (timestamp стабилен на ретраях одного события).
  async routeChatTitleChanged(maxUpdate, { logger } = {}) {
    const log = logger ?? this.logger;

    assertMaxUpdate(maxUpdate, 'chat_title_changed', 'routeChatTitleChanged');

    const chatId = maxUpdate.chatId;
    const title = maxUpdate.chatTitle ?? null;
    if (!title) {
      log?.warn({ chatId }, 'routeChatTitleChanged: empty title, skipping');
      return { skipped: 'no-title' };
    }

    const { binding } = await this.bindings.resolveByMaxChat(chatId);
    if (!binding) {
      log?.debug({ chatId }, 'routeChatTitleChanged: no binding (group not connected), skipping');
      return { skipped: 'no-binding' };
    }

    const result = await this._once(
      {
        direction: 'inbound',
        bindingId: binding.id,
        key: `chat_title_changed:${chatId}:${maxUpdate.timestamp ?? contentHash(title)}`,
        fn: 'routeChatTitleChanged',
        log,
        done: 'chat title stored',
      },
      async () => {
        await this.bindings.updateMaxChatTitle(binding.id, title);
        binding.maxChatTitle = title;
        return {
          payloadMeta: { kind: 'chat_title_changed', userId: maxUpdate.senderId ?? null, titleLen: title.length },
          result: { ok: true, bindingId: binding.id },
          logFields: { titleLen: title.length },
        };
      },
    );
    if (!result.ok) return result;

    // M27: закрытая сессия (CHAT_RENAMING_FAILED + dialog.get) взводит флаг опенера.
    const olTitle = await this._syncOlTitleSafe(binding, log, 'routeChatTitleChanged', { armOnClosed: true });
    return { ...result, olTitle };
  }

  // M25: сессия OL закрыта (OnImConnectorDialogFinish) → ol_closed_session_id. Опенер
  // от «группы» уйдёт перед следующим входящим (_openGroupSessionSafe): сразу слать нельзя —
  // сообщение в закрытую сессию создаст новую пустую. Внешнего эффекта нет, поэтому без
  // _once и message_log: UPDATE идемпотентен (guard'ы в SQL), а дедуп по session.id
  // сломал бы повторное закрытие возобновлённой сессии. Аудит — INFO-лог и запись
  // опенера (payloadMeta.closedSessionId). Ошибка БД → проброс → 500 (Б24 событие не
  // ретраит — только видимость). Skip-вердикты → 200.
  async routeDialogFinish(openLineEvent, { logger } = {}) {
    const log = logger ?? this.logger;
    if (!openLineEvent?.isDialogFinish?.()) {
      throw new ValidationError('routeDialogFinish: OnImConnectorDialogFinish event required');
    }
    const dialogs = openLineEvent.normalizedDialogs();
    if (dialogs.length === 0) {
      log?.warn({ lineId: openLineEvent.lineId }, 'routeDialogFinish: no dialogs in event');
      return { skipped: 'no-dialogs' };
    }
    const results = [];
    for (const d of dialogs) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this._routeDialogFinishOne(d, log));
    }
    return { ok: true, results };
  }

  async _routeDialogFinishOne(d, log) {
    const fields = {
      connectorChatId: d.connectorChatId,
      sessionId: d.sessionId,
      parentSessionId: d.parentSessionId,
      closed: d.closed,
    };
    log?.info(fields, 'routeDialogFinish: OL dialog finished');
    if (d.sessionId === null) {
      log?.warn(fields, 'routeDialogFinish: no session id, skipping');
      return { skipped: 'no-session' };
    }
    if (d.closed !== null && String(d.closed).toUpperCase() !== 'Y') {
      log?.warn(fields, 'routeDialogFinish: session not closed, skipping');
      return { skipped: 'not-closed' };
    }

    if (!d.connectorChatId) {
      log?.warn(fields, 'routeDialogFinish: no chat id, skipping');
      return { skipped: 'no-chat' };
    }

    // connector.chat_id (= chat.id) — внешний id чата коннектора 'max:<chatId>' (live 2026-10-08).
    const { binding } = await this.bindings.resolveByConnectorChat(d.connectorChatId);
    if (!binding) {
      log?.info(fields, 'routeDialogFinish: no binding (foreign or probe chat), skipping');
      return { skipped: 'no-binding' };
    }
    const base = { bindingId: binding.id, sessionId: d.sessionId };
    if (binding.isStaleSessionFinish(d.sessionId)) {
      log?.info(
        { ...base, knownSessionId: binding.olSessionId },
        'routeDialogFinish: stale finish (newer session already open), skipping',
      );
      return { skipped: 'stale-session', bindingId: binding.id };
    }
    if (binding.olClosedSessionId === d.sessionId) {
      log?.info(base, 'routeDialogFinish: session already marked closed, skipping');
      return { skipped: 'already-marked', bindingId: binding.id };
    }
    const marked = await this.bindings.markOlSessionClosed(binding.id, d.sessionId);
    if (!marked) {
      log?.info(base, 'routeDialogFinish: concurrent update won (stale or marked), skipping');
      return { skipped: 'stale-session', bindingId: binding.id };
    }
    log?.info(base, 'routeDialogFinish: OL session closed, group opener armed');
    return { ok: true, bindingId: binding.id, sessionId: d.sessionId };
  }

  // M-lifecycle: координатор системного уведомления MAX-группа → OL-чат (im.message.add).
  // Вызывается из maxService для user_added(чужой)/user_removed. Best-effort: НИКОГДА
  // не бросает наружу — возвращает {skipped}/{ok}, чтобы /webhook/max отдал 200 (иначе
  // MAX зря ретраит косметику). Идемпотентность — через message_log по синтетическому
  // ключу <event>:<chatId>:<userId>:<timestamp> (lifecycle не имеет mid; direction
  // 'inbound', payload_meta.kind='lifecycle' помечает семантику).
  //
  // logger: scoped-логгер с requestId (протащен из maxController через maxService);
  // fallback на this.logger.
  async routeLifecycle(maxUpdate, { logger } = {}) {
    const log = logger ?? this.logger;
    const event = maxUpdate?.updateType ?? null;
    const chatId = maxUpdate?.chatId ?? null;
    const userId = maxUpdate?.senderId ?? null;

    // 1) resolve binding. Нет binding → группа не подключена, тихий skip.
    log?.debug({ event, chatId, userId }, 'routeLifecycle: resolve binding');
    const { binding } = await this.bindings.resolveByMaxChat(chatId);
    if (!binding) {
      log?.debug({ event, chatId }, 'routeLifecycle: no binding, skipping');
      return { skipped: 'no-binding' };
    }

    // 1.5) адрес OL-чата. Обычно уже персистнут (побочно на первом inbound), но
    // если ещё пуст (колонка свежая / вход ДО первого сообщения после деплоя) —
    // дорезолвываем напрямую через imopenlines.dialog.get, БЕЗ отправки сообщения
    // и без открытия сессии. Резолв удаётся, только если OL-чат уже существует
    // (в группе была переписка). Нет чата → null → graceful skip. Успешный резолв
    // персистим, чтобы дальше не дёргать B24 на каждый lifecycle.
    let b24ChatId = binding.b24ChatId;
    if (!b24ChatId) {
      b24ChatId = await this.b24.resolveB24ChatId({ connectorChatId: binding.connectorChatId });
      // персист — best-effort; уведомление всё равно отправляем по resolved-адресу
      await this._persistB24ChatId(binding, b24ChatId, log, 'routeLifecycle');
    }
    if (!b24ChatId) {
      log?.debug(
        { event, chatId, bindingId: binding.id },
        'routeLifecycle: no OL chat yet (group has no messages), skipping',
      );
      return { skipped: 'no-chat' };
    }

    // 2) синтетический ключ дедупа. timestamp одинаков при ретраях MAX того же
    // события (НЕ Date.now()); разные вступления одного юзера → разные timestamps.
    return this._once(
      {
        direction: 'inbound',
        bindingId: binding.id,
        key: `${event}:${chatId}:${userId}:${maxUpdate.timestamp}`,
        fn: 'routeLifecycle',
        log,
        done: 'membership notification sent',
      },
      async () => {
        // 3) текст уведомления. Имя из lifecycle-апдейта; финальный fallback — id.
        const name = maxUpdate.senderName ?? `MAX user ${userId}`;
        const text = membershipText(event, name);

        // 4) отправка системного сообщения в OL-чат. Ошибку ловим (best-effort) → 200.
        let b24MsgId;
        try {
          log?.debug(
            { bindingId: binding.id, b24ChatId, event },
            'routeLifecycle: sending system message',
          );
          ({ b24MsgId } = await this.b24.sendSystemMessage({ b24ChatId, text }));
        } catch (err) {
          log?.error(
            { bindingId: binding.id, event, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
            'routeLifecycle: system message send failed (best-effort, returning 200)',
          );
          return { skipped: 'send-failed' };
        }

        return {
          payloadMeta: { kind: 'lifecycle', event, userId, b24MsgId },
          result: { ok: true, bindingId: binding.id, event, b24MsgId },
          logFields: { event, b24MsgId },
        };
      },
    );
  }

  // M26: удаление приложения Б24 с CLEAN=1. Координатор — владелец журнала: привязки
  // удаляет bindings, participant_map и message_log уходят каскадом (FK 0004/0005).
  // Не пишется в message_log: внешнего эффекта нет, повтор удалит 0 строк.
  async purgeBridgeData(installationId, { logger } = {}) {
    const log = logger ?? this.logger;
    const purged = await this.bindings.purgeAll(installationId);
    log?.info({ installationId, ...purged }, 'app uninstall: bridge data purged');
    return purged;
  }
}
