// MAX use-case service.
//
// handleIncomingUpdate — делегирует входящие message-апдейты в координатор
// (messagingService.routeInbound). Полноценный inbound-routing появился в M4.
//
// handleLifecycleEvent — обрабатывает bot_added/bot_removed/user_added/user_removed.
// M6a: при bot_added (группа) и user_added(self) проверяет наличие
// read_all_messages через getChatMember и отправляет предупреждение в чат если
// права отсутствуют. Dedup-guard гасит повторные предупреждения для того же чата.
// НИКОГДА не бросает наружу, иначе MAX ретраит 10×
// (admin-права бота — обязательное требование для работы коннектора).

import { DEFAULTS } from '../../shared/config/schema.js';
import { urlHost } from '../../shared/http/urlHost.js';
import { MaxApiError, textTooLongDetails } from './maxApiError.js';
import { MaxMessage } from './models/MaxMessage.js';

// M11.2: потолок задержки между ретраями шага POST /messages.
const UPLOAD_RETRY_CAP_MS = 15_000;

// M21: подсказка тому, кто написал боту в личку: мост работает только в группах.
const DIALOG_HINT_TEXT =
  'Я работаю только в группах: добавьте меня в группу MAX и выдайте права администратора. '
  + 'Личные сообщения в Битрикс24 не передаются.';

// Ссылка на отправленное/изменённое сообщение из ответа MAX POST|PUT /messages.
// Форму ответа MAX знает только фасад — координатор получает уже разобранное.
function toSentRef(resp) {
  return {
    maxMid: resp?.message?.body?.mid ?? null,
    timestampMs: resp?.message?.timestamp ?? null,
  };
}

// M22: лимиты MAX по типу вложения (dev.max.ru/docs-api/methods/POST/uploads, 2026-10-06),
// в десятичных МБ — консервативно. У `file` лимит 4 ГБ — больше MEDIA_MAX_BYTES.
const MAX_TYPE_LIMIT_BYTES = Object.freeze({ image: 50e6, video: 250e6, audio: 256e6 });

// M28: какие картинки MAX принимает как `image` — dev.max.ru POST /uploads (JPG, JPEG, PNG,
// GIF, TIFF, BMP, HEIC) с поправкой на live-пробы 2026-10-08: WEBP принят (в доке его нет),
// HEIC отвергнут (IMAGE_INVALID_FORMAT), как и SVG. Остальные image/* (HEIC/HEIF, SVG, ICO,
// AVIF, PSD…) — сразу `file`, без заведомо отвергнутой заливки до 50 МБ.
const MAX_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/gif',
  'image/tiff', 'image/bmp', 'image/x-ms-bmp', 'image/webp',
]);
// Лимит MAX — 7680 px по КАЖДОЙ стороне, не по площади (live: 7700×300 →
// IMAGE_DIMENSION_CHECK_FAIL).
const MAX_IMAGE_SIDE_PX = 7680;

// width/height из события Б24 (числа или строки); нет размеров — не превышает.
function exceedsImageSide(file) {
  return [file?.width, file?.height].some((side) => Number(side) > MAX_IMAGE_SIDE_PX);
}

// M11.2: маппинг файла Б24 → MAX upload type. Реальный тип — всегда в mime
// (type у Б24 = "image"|"file"). M22: size — фактический размер; файл больше лимита
// своего типа уходит как `file`: без превью, зато доходит.
// M28: `image` — только mime из MAX_IMAGE_MIMES (без mime, но с type 'image' — как раньше)
// и стороны не больше MAX_IMAGE_SIDE_PX; иначе `file`. Что allowlist пропустил, а MAX
// отверг (напр. картинка 1×1), перезаливает файлом uploadAndSend.
export function maxUploadTypeForFile(file, size = null) {
  const mime = (file?.mime || '').split(';')[0].trim().toLowerCase();
  let type = 'file';
  if (mime.startsWith('image/')) type = MAX_IMAGE_MIMES.has(mime) ? 'image' : 'file';
  else if (file?.type === 'image') type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';
  if (type === 'image' && exceedsImageSide(file)) return 'file';
  const limit = MAX_TYPE_LIMIT_BYTES[type];
  return limit && Number.isFinite(size) && size > limit ? 'file' : type;
}

// M22: повтор POST /messages — только пока файл обрабатывается (HTTP 400
// attachment.not.ready, live 2026-10-08) или при 429. Таймаут, сеть, 5xx и прочие 4xx —
// сразу наверх: после таймаута сообщение могло уже уйти (повтор = дубль), а 403
// chat.denied (бот не в чате) повтором не лечится.
function isRetryableSendError(err) {
  return err?.maxCode === 'attachment.not.ready' || err?.httpStatus === 429;
}

// M28: MAX отверг вложение как этот тип, а сообщение в MAX точно не создано → тот же файл
// можно перезалить как `file`. Живая форма (live 2026-10-08): шаг заливки, HTTP 200, тело
// {error_code, error_data:'IMAGE_INVALID_FORMAT'|'IMAGE_DIMENSION_CHECK_FAIL'} без photos →
// stage 'payload', kind 'protocol'. У video/audio токен — из /uploads, поэтому тот же ответ
// заливки с error_data тоже даёт stage 'payload' (форма для видео live не снята). 4xx
// заливки и 400 на POST /messages не наблюдались — страховка (сообщение не создано,
// повтор безопасен).
// Не сюда: таймаут/сеть на любом шаге (на send — сообщение могло дойти, на upload — лишняя
// долгая заливка), 429, 5xx заливки (отказом типа не наблюдался), ошибки создания upload,
// 403 chat.denied на send (бот не в чате), исчерпанное «не готово» (attachment.not.ready)
// и слишком длинная подпись на send (textTooLongDetails): файлом уйдёт тот же текст.
export function isMediaRejectedError(err) {
  if (!(err instanceof MaxApiError)) return false;
  if (err.stage === 'payload') return err.kind === 'protocol';
  if (err.stage === 'upload') {
    return err.kind === 'http' && err.httpStatus !== 429 && err.httpStatus < 500;
  }
  if (err.stage === 'send') {
    return err.kind === 'http' && err.httpStatus === 400 && err.maxCode !== 'attachment.not.ready'
      && !textTooLongDetails(err);
  }
  return false;
}

// M28: пометить ошибку MaxApiError шагом upload-флоу (если ещё не помечена) и вернуть её.
function withStage(err, stage) {
  if (err instanceof MaxApiError && !err.stage) err.stage = stage;
  return err;
}

// M28: PUT/DELETE /messages — не больше 2 правок/удалений в секунду на чат (dev.max.ru); 429
// — в общем списке кодов API. Удаление сообщения из нескольких файлов — несколько DELETE
// подряд, поэтому на 429 — один повтор после паузы.
const RATE_RETRY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// M27: ссылка группы (Chat.link) уходит в BB-разметку системного сообщения OL. Проверка
// формы — защита разметки: только https://, без пробелов и [ ], не длиннее 2048; иначе null.
const GROUP_LINK_MAX_LEN = 2048;
const GROUP_LINK_RE = /^https:\/\/[^\s[\]]+$/;

function groupLink(raw) {
  if (typeof raw !== 'string' || raw.length > GROUP_LINK_MAX_LEN) return null;
  return GROUP_LINK_RE.test(raw) ? raw : null;
}

export class MaxService {
  // uploadRetry — параметры readiness-retry шага POST /messages (MAX готовит вложение не сразу),
  // приходят из config.media (app.js). Дефолты заданы на случай прямого вызова/тестов.
  // rateRetryMs (M28) — пауза перед единственным повтором PUT/DELETE /messages на 429
  // (не env; тесты дают 1).
  constructor({ maxClient, messagingService = null, logger, uploadRetry, rateRetryMs } = {}) {
    if (!maxClient) throw new TypeError('MaxService: maxClient required');
    this.client = maxClient;
    this.messaging = messagingService;
    this.logger = logger;
    this._botId = undefined;
    this._botIdPromise = null;
    this._warnedChats = new Set();
    // M21: кому уже ушла подсказка в личке (по senderId) — за жизнь процесса.
    this._hintedDialogs = new Set();
    this._uploadRetry = {
      maxRetries: uploadRetry?.maxRetries ?? DEFAULTS.maxUploadMaxRetries,
      baseMs: uploadRetry?.baseMs ?? DEFAULTS.maxUploadRetryBaseMs,
      factor: uploadRetry?.factor ?? DEFAULTS.maxUploadRetryFactor,
    };
    this._rateRetryMs = rateRetryMs ?? RATE_RETRY_MS;
  }

  setMessagingService(messagingService) {
    this.messaging = messagingService;
  }

  _requireMessaging() {
    if (!this.messaging) {
      throw new Error('MaxService.messagingService not wired — check app.js composition');
    }
    return this.messaging;
  }

  // Поля апдейта для лога входа в handleIncoming* (тело сообщения — только в DEBUG
  // у координатора: текст не пишем в INFO).
  static _updateLogFields(update) {
    return {
      updateType: update?.updateType ?? null,
      chatId: update?.chatId ?? null,
      mid: update?.mid ?? null,
      senderId: update?.senderId ?? null,
    };
  }

  // Лениво-мемоизированный botId: первый вызов дёргает getMe(), далее кэш.
  // In-flight promise предотвращает параллельные getMe при одновременных событиях.
  // При ошибке или ответе без user_id — warn-лог, возвращает null; _botId остаётся
  // undefined для retry (null в кэше глушил бы user_added до рестарта процесса).
  async _getBotId() {
    if (this._botId !== undefined) {
      this.logger?.debug({ botId: this._botId }, 'botId cache hit');
      return this._botId;
    }
    if (this._botIdPromise) {
      return this._botIdPromise;
    }
    this.logger?.debug('botId cache miss → getMe');
    this._botIdPromise = this.client.getMe().then(
      (me) => {
        this._botIdPromise = null;
        const botId = me?.user_id ?? null;
        if (botId === null) {
          this.logger?.warn('getMe returned no user_id, botId unknown (will retry)');
          return null;
        }
        this._botId = botId;
        this.logger?.info({ botId }, 'botId resolved');
        return botId;
      },
      (err) => {
        this._botIdPromise = null;
        this.logger?.warn({ err: err?.message ?? String(err) }, 'getMe failed, botId unknown');
        return null;
      },
    );
    return this._botIdPromise;
  }

  // logger — опциональный scoped-логгер с requestId (передаёт maxController).
  // Прокидываем его дальше в routeInbound, чтобы requestId дошёл до координатора.
  // Лог входа — debug: maxController уже пишет те же поля на info.
  async handleIncomingUpdate(update, { logger } = {}) {
    const messaging = this._requireMessaging();
    const log = logger ?? this.logger;
    log?.debug(MaxService._updateLogFields(update), 'max update received');
    if (!update.isGroupChat()) return this._skipNotGroupChat(update, log, { hint: true });
    return messaging.routeInbound(update, { logger });
  }

  // INBOUND-правка MAX→OL: webhook message_edited (тот же mid, что у оригинала).
  // Делегирует в координатор routeInboundEdit — отдельный путь от handleIncomingUpdate,
  // т.к. dedup-guard routeInbound отсёк бы правку как duplicate.
  async handleIncomingEdit(update, { logger } = {}) {
    const messaging = this._requireMessaging();
    const log = logger ?? this.logger;
    log?.debug(MaxService._updateLogFields(update), 'max incoming edit received');
    if (!update.isGroupChat()) return this._skipNotGroupChat(update, log, { hint: false });
    return messaging.routeInboundEdit(update, { logger });
  }

  // M21: мост работает только с группами. Личка с ботом и посты канала до M21
  // онбордились как группы (сессия ОЛ из лички, мусорные привязки каналов). Проверка —
  // до координатора: у лички chat_id бывает null, и assertMaxUpdate дал бы 400 и ретраи.
  // Личка (только message_created) → одноразовая подсказка; канал — молча: ответ стал бы
  // постом. 200 skip в любом случае — MAX не ретраит.
  async _skipNotGroupChat(update, log, { hint }) {
    const { chatId, chatType, senderId } = update;
    log?.info({ chatId, chatType, senderId }, 'max update from non-group chat, skipping');
    if (hint && chatType === 'dialog') await this._maybeHintDialog(senderId, log);
    return { skipped: 'not-group-chat', chatType };
  }

  // M21: подсказка в личку — один раз на пользователя за жизнь процесса (дедуп в памяти,
  // как _maybeWarn: после рестарта уйдёт ещё раз). Адресат — user_id: chat_id у лички
  // бывает null. best-effort: сбой → warn, вебхук отвечает 200, следующая попытка — со
  // следующим сообщением. Эха нет: MAX не шлёт боту его собственные сообщения.
  async _maybeHintDialog(senderId, log) {
    if (senderId === null || senderId === undefined || !this.client.hasToken()) return;
    await this._sendOnce(this._hintedDialogs, String(senderId), { userId: senderId, text: DIALOG_HINT_TEXT }, {
      log,
      label: 'dialog hint',
      fields: { senderId },
    });
  }

  // INBOUND-удаление MAX→OL: webhook message_removed (тот же mid, что у оригинала).
  // Делегирует в координатор routeInboundDelete — отдельный путь от handleIncomingUpdate/
  // handleIncomingEdit, т.к. dedup-guard по «голому» mid отсёк бы удаление как duplicate
  // Зеркало handleIncomingEdit.
  async handleIncomingDelete(update, { logger } = {}) {
    const messaging = this._requireMessaging();
    (logger ?? this.logger)?.debug(MaxService._updateLogFields(update), 'max incoming delete received');
    return messaging.routeInboundDelete(update, { logger });
  }

  // M24: chat_title_changed — группу переименовали в MAX. Делегирует в координатор
  // (адаптер max/ не зовёт b24/ напрямую). routeChatTitleChanged сам best-effort по Б24;
  // ошибка БД пробрасывается → 500 → MAX ретраит.
  async handleChatTitleChanged(update, { logger } = {}) {
    const messaging = this._requireMessaging();
    (logger ?? this.logger)?.debug(MaxService._updateLogFields(update), 'max chat title changed received');
    return messaging.routeChatTitleChanged(update, { logger });
  }

  // M6a: проверяет наличие read_all_messages у бота в группе.
  // При сбое getChatMember возвращает { ok: null } — предупреждение не отправляется.
  async _checkBotPermissions(chatId, { trigger, log }) {
    try {
      const member = await this.client.getChatMember(chatId, 'me');
      const isAdmin = member?.is_admin === true;
      const permissions = Array.isArray(member?.permissions) ? member.permissions : [];
      const canReadAll = permissions.includes('read_all_messages');
      if (canReadAll) {
        log?.info({ chatId, isAdmin, permissions, trigger }, 'permissions OK');
      } else {
        log?.warn(
          { chatId, isAdmin, permissions, trigger },
          'missing read_all_messages',
        );
      }
      return { ok: canReadAll, isAdmin, permissions };
    } catch (err) {
      log?.warn(
        { chatId, err: err?.message ?? String(err), trigger },
        'getChatMember failed, permissions unknown',
      );
      return { ok: null };
    }
  }

  // M6a: lifecycle events (bot_added/bot_removed/user_added/user_removed).
  // bot_added (группа) и user_added(self): проверяем права и предупреждаем в чат.
  // Гарантия: метод не бросает наружу, иначе MAX ретраит 10×.
  async handleLifecycleEvent(update, { logger } = {}) {
    const log = logger ?? this.logger;
    const updateType = update?.updateType ?? null;
    const chatId = update?.chatId ?? null;
    const senderId = update?.senderId ?? null;
    const senderName = update?.senderName ?? null;
    const isChannel = update?.isChannel ?? null;
    log?.info(
      { updateType, chatId, senderId, senderName, timestamp: update?.timestamp ?? null, isChannel },
      'max lifecycle event',
    );

    try {
      if (updateType === 'bot_removed') {
        log?.debug({ chatId }, 'bot_removed: clearing dedup guard');
        if (chatId !== null) this._warnedChats.delete(String(chatId));
        return { ok: true, lifecycle: updateType };
      }

      if (isChannel === true) {
        log?.debug({ chatId, isChannel }, `${updateType}: skip-channel`);
      } else if (updateType === 'bot_added') {
        if (chatId !== null && this.client.hasToken()) {
          log?.debug({ chatId, isChannel, trigger: 'bot_added' }, 'bot_added: checking permissions');
          const result = await this._checkBotPermissions(chatId, { trigger: 'bot_added', log });
          await this._maybeWarn(chatId, result, log);
        }
      } else if (updateType === 'user_added') {
        if (chatId !== null && this.client.hasToken()) {
          const botId = await this._getBotId();
          if (botId === null) {
            log?.debug({ chatId, senderId }, 'botId unknown, skip user_added self-check');
          } else if (senderId === botId) {
            log?.debug({ chatId, senderId, botId, trigger: 'user_added-self' }, 'user_added(self): checking permissions');
            const result = await this._checkBotPermissions(chatId, { trigger: 'user_added-self', log });
            await this._maybeWarn(chatId, result, log);
          } else {
            // Чужой user_added → системное уведомление о вступлении в OL-чат.
            return await this._routeLifecycleSafe(update, log);
          }
        }
      } else if (updateType === 'user_removed') {
        // Выход участника → системное уведомление в OL-чат.
        return await this._routeLifecycleSafe(update, log);
      }
    } catch (err) {
      log?.warn({ updateType, chatId, err: err?.message ?? String(err) }, 'lifecycle handler unexpected error');
    }

    return { ok: true, lifecycle: updateType };
  }

  // M-lifecycle: безопасный мост user_added(чужой)/user_removed → координатор.
  // Отправка в Б24 — ТОЛЬКО через messaging (направление зависимостей: адаптер
  // max/ не зовёт b24/ напрямую). routeLifecycle сам best-effort, но дополнительный
  // try/catch гарантирует, что lifecycle НИКОГДА не валит вебхук (иначе MAX ретраит 10×).
  async _routeLifecycleSafe(update, log) {
    log?.debug(
      { type: update?.updateType, chatId: update?.chatId, senderId: update?.senderId },
      'MaxService.handleLifecycleEvent: routing lifecycle to messaging',
    );
    try {
      const result = await this.messaging.routeLifecycle(update, { logger: log });
      log?.debug(
        { type: update?.updateType, result },
        'MaxService.handleLifecycleEvent: lifecycle routed',
      );
      return result;
    } catch (err) {
      log?.error(
        { type: update?.updateType, chatId: update?.chatId, err: err?.message ?? String(err) },
        'MaxService.handleLifecycleEvent: lifecycle routing error (swallowed, returning 200)',
      );
      return { ok: true, lifecycle: update?.updateType, skipped: 'lifecycle-error' };
    }
  }

  // M6a: отправляет предупреждение в чат при ok===false с dedup-guard.
  async _maybeWarn(chatId, { ok }, log) {
    if (ok !== false) return;
    const text =
      'Чтобы я пересылал сообщения этой группы в Битрикс24, выдайте мне права администратора (доступ ко всем сообщениям). Без этого я вижу только упоминания и ответы.';
    await this._sendOnce(this._warnedChats, String(chatId), { chatId, text }, { log, label: 'admin-warning', fields: { chatId } });
  }

  // Сообщение «один раз на ключ за жизнь процесса» (дедуп в памяти sent: после рестарта уйдёт
  // ещё раз). Ключ занимается до отправки — параллельный вызов (bot_added и user_added(self)
  // почти одновременно) не шлёт второе; сбой снимает ключ (повтор со следующим событием) и
  // пишет warn, best-effort. label — начало строк лога («<label> sent» и т.п.).
  async _sendOnce(sent, key, message, { log, label, fields }) {
    if (sent.has(key)) {
      log?.debug(fields, `${label}: already sent, skip (dedup)`);
      return;
    }
    sent.add(key);
    try {
      await this.client.sendMessage(message);
      log?.info(fields, `${label} sent`);
    } catch (err) {
      sent.delete(key);
      log?.warn({ ...fields, err: err?.message ?? String(err) }, `${label} send failed`);
    }
  }

  // M24: название, иконка и тип MAX-чата для интро группы в OL (в webhook их нет).
  // GET /chats/{id} → { title, icon?: { url }, type: 'chat'|'channel'|'dialog', link? }; у
  // группы без иконки ключа icon нет. url иконки — публичный webp на i.oneme.ru, Б24 качает
  // его сам как user.picture. M27: link — invite-ссылка на группу (https://max.ru/join/…,
  // есть и у приватных групп, live 2026-10-08) для системного сообщения в чате OL.
  // best-effort — при ошибке/таймауте возвращает null (мост не роняем; название
  // косметическое). Не логируем title и url — только факт наличия; ссылку тоже (это
  // приглашение в закрытую группу клиента).
  async getChatInfo(chatId) {
    try {
      const chat = await this.client.getChat(chatId);
      const title =
        typeof chat?.title === 'string' && chat.title.trim() ? chat.title.trim() : null;
      const rawIcon = chat?.icon?.url;
      const iconUrl =
        typeof rawIcon === 'string' && rawIcon.startsWith('https://') ? rawIcon : null;
      const type = typeof chat?.type === 'string' ? chat.type : null;
      const link = groupLink(chat?.link);
      this.logger?.debug(
        {
          chatId,
          type,
          hasTitle: Boolean(title),
          titleLen: title ? title.length : 0,
          hasIcon: Boolean(iconUrl),
          hasLink: Boolean(link),
        },
        'maxService.getChatInfo',
      );
      return { title, iconUrl, type, link };
    } catch (err) {
      this.logger?.warn(
        { chatId, err: err?.message ?? String(err) },
        'getChatInfo failed, continuing without group title/icon',
      );
      return null;
    }
  }

  // M10: аватар автора из MAX. Берём участника через список группы с фильтром
  // user_ids (getChatMembers → members[]) и читаем avatar_url ?? full_avatar_url.
  // ВАЖНО: пути /chats/{id}/members/{userId} у MAX нет (404), он работает только
  // для 'me'; поэтому НЕ используем getChatMember для произвольного userId.
  // best-effort — при ошибке/таймауте/пустом ответе возвращает null (аватар
  // косметичен, его отсутствие не должно ронять inbound). Не логируем URL целиком.
  async getMemberAvatar(chatId, userId) {
    try {
      const res = await this.client.getChatMembers(chatId, { userIds: [userId] });
      const members = Array.isArray(res?.members) ? res.members : [];
      const member =
        members.find((m) => String(m?.user_id) === String(userId)) ?? members[0] ?? null;
      const avatar = member?.avatar_url || member?.full_avatar_url || null;
      this.logger?.debug(
        { chatId, userId, hasAvatar: Boolean(avatar) },
        'maxService.getMemberAvatar',
      );
      return avatar;
    } catch (err) {
      this.logger?.warn(
        { chatId, userId, err: err?.message ?? String(err) },
        'getMemberAvatar failed, sending without picture',
      );
      return null;
    }
  }

  // Возвращает { maxMid, timestampMs } (см. toSentRef).
  async sendOutgoingMessage(message) {
    this.logger?.info({ chatId: message.chatId }, 'max outgoing message');
    return toSentRef(await this.client.sendMessage(message));
  }

  // M28: один повтор вызова fn на HTTP 429 (лимит MAX на правки/удаления в чате) после
  // паузы _rateRetryMs. Таймаут, сеть, success:false и прочие коды — без повтора: после
  // таймаута запрос мог дойти, остальное повтором не лечится.
  async _withRateRetry(fn, fields) {
    try {
      return await fn();
    } catch (err) {
      if (err?.httpStatus !== 429) throw err;
      this.logger?.warn({ ...fields, delayMs: this._rateRetryMs }, 'max outgoing: HTTP 429, retrying once');
      await sleep(this._rateRetryMs);
      return fn();
    }
  }

  // OUTBOUND-правка OL → MAX: фасад над maxClient.editMessage (PUT /messages).
  // Координатор НЕ зовёт клиент напрямую (как и для sendOutgoingMessage). Ошибки
  // транспорта пробрасываются (оповещение оператора — в координаторе routeOutboundEdit).
  // M28: PUT /messages отвечает 200 и на неудачу — итог в success (live 2026-10-08: успех
  // {success:true}; удалённое сообщение — success:false «Error on message edit»; несуществующий
  // mid — success:false «Invalid chatId: 0»; некорректный mid — HTTP 400 proto.payload).
  // success:false → MaxApiError kind 'rejected' с message MAX в тексте; на 429 — один повтор.
  // Возвращает { timestampMs } (null, если MAX его не вернул — ответ {success:true} без message).
  async editOutgoing({ messageId, text, format } = {}) {
    this.logger?.info({ messageId }, 'max outgoing edit');
    const resp = await this._withRateRetry(
      () => this.client.editMessage({ messageId, text, format }),
      { op: 'edit', messageId },
    );
    // Только явный false: ответ формы «сообщение» без success остаётся успехом.
    if (resp?.success === false) {
      throw new MaxApiError(
        `PUT /messages: success:false${resp.message ? ` — ${resp.message}` : ''}`,
        { kind: 'rejected', method: 'PUT', path: '/messages' },
      );
    }
    const { timestampMs } = toSentRef(resp);
    return { timestampMs };
  }

  // OUTBOUND-удаление OL → MAX: фасад над maxClient.deleteMessage (DELETE /messages).
  // Координатор НЕ зовёт клиент напрямую (как и для editOutgoing). Ошибки транспорта
  // пробрасываются (оповещение оператора — в координаторе routeOutboundDelete); на 429 —
  // один повтор. Возвращает { deleted, maxMessage }: success:false → MAX не удалил, причина
  // — в message ответа (live 2026-10-08 на несуществующий mid: «Invalid chatId: 0»); лимита
  // по давности в доке MAX нет и live не видно (удалено и через 63 ч). maxMessage — эта
  // причина либо null.
  async deleteOutgoing({ messageId } = {}) {
    this.logger?.info({ messageId }, 'max outgoing delete');
    const resp = await this._withRateRetry(
      () => this.client.deleteMessage({ messageId }),
      { op: 'delete', messageId },
    );
    return {
      deleted: resp?.success !== false,
      maxMessage: typeof resp?.message === 'string' && resp.message ? resp.message : null,
    };
  }

  // M11.2: use-case оркестрация исходящего файла OL → MAX (3-шаговый upload-флоу).
  //   1) createUpload(type) → { url }              (auth, baseUrl)
  //   2) uploadBinary(url, file) ОДИН раз          (абсолютный url, без auth; M22 — поток с диска)
  //   3) sendMessage с attachments + readiness-retry ТОЛЬКО на шаге 3, переиспользуя уже
  //      полученный token/payload. НЕ перезаливаем файл на каждой попытке.
  // Readiness-retry живёт здесь (MAX-специфика), а НЕ в координаторе: координатор
  // зовёт uploadAndSend один раз на файл; idempotency/audit остаются в координаторе.
  // file — { path, filename, contentType } (временный файл координатора).
  //
  // M28: MAX отверг не-`file` тип там, где сообщение ещё не создано (isMediaRejectedError),
  // → тот же временный файл (file.path; координатор удаляет его после возврата) заливается
  // ОДИН раз как `file`, без повторного скачивания. Ошибка фолбэка летит наружу как есть.
  // Возвращает { maxMid, timestampMs, type, fallbackFrom? }: type — фактический тип в MAX,
  // fallbackFrom — исходный тип, если сработал фолбэк.
  async uploadAndSend(
    { chatId, file, type, text = '', format = null },
    { logger } = {},
  ) {
    const log = logger ?? this.logger;
    if (!chatId) throw new TypeError('MaxService.uploadAndSend: chatId required');
    if (!file?.path) throw new TypeError('MaxService.uploadAndSend: file.path required');

    const args = { chatId, file, text, format };
    try {
      return { ...(await this._uploadAndSendAs(type, args, log)), type };
    } catch (err) {
      if (type === 'file' || !isMediaRejectedError(err)) throw err;
      log?.warn(
        {
          chatId,
          type,
          stage: err.stage,
          httpStatus: err.httpStatus ?? null,
          maxCode: err.maxCode ?? null,
          err: err.message,
        },
        'uploadAndSend: MAX rejected attachment type, re-uploading as file',
      );
      const ref = await this._uploadAndSendAs('file', args, log);
      return { ...ref, type: 'file', fallbackFrom: type };
    }
  }

  // Один проход upload-флоу заданным типом. Ошибки MaxApiError помечаются шагом (stage:
  // create | upload | payload | send) — по нему uploadAndSend решает, можно ли перезалить.
  // Возвращает { maxMid, timestampMs } (см. toSentRef).
  async _uploadAndSendAs(type, { chatId, file, text, format }, log) {
    // Шаг 1 — создать upload.
    let uploadsResponse;
    try {
      uploadsResponse = await this.client.createUpload(type);
    } catch (err) {
      throw withStage(err, 'create');
    }
    const uploadUrl = uploadsResponse?.url;
    if (!uploadUrl) {
      throw new MaxApiError('MaxService.uploadAndSend: /uploads returned no url', { kind: 'protocol', stage: 'create' });
    }
    log?.debug({ chatId, type, uploadHost: urlHost(uploadUrl) }, 'uploadAndSend: upload created');

    // Шаг 2 — залить бинарь ОДИН раз.
    let uploadResult;
    try {
      uploadResult = await this.client.uploadBinary(uploadUrl, file);
    } catch (err) {
      throw withStage(err, 'upload');
    }
    // Токен может прийти из ответа /uploads (video/audio) ЛИБО из ответа заливки
    // (file); image — { photos } из заливки. Передаём оба ответа в сборку payload.
    let payload;
    try {
      payload = this.client.buildAttachmentPayload(type, { uploadsResponse, uploadResult });
    } catch (err) {
      throw withStage(err, 'payload');
    }
    log?.debug({ chatId, type }, 'uploadAndSend: binary uploaded, payload built');

    // Шаг 3 — POST /messages с attachments + readiness-retry (НЕ перезаливаем).
    // format (напр. 'markdown') прокидывается, чтобы подпись оператора рендерилась
    // (иначе BB→markdown `**жирный**` уходит звёздочками — M11.2 live-фикс).
    const attachments = [MaxMessage.attachment(type, payload)];
    const { maxRetries, baseMs, factor } = this._uploadRetry;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const resp = await this.client.sendMessage({ chatId, text, format, attachments });
        log?.info(
          { chatId, type, retries: attempt - 1, readyMs: Date.now() - startedAt },
          'uploadAndSend: delivered attachment to MAX',
        );
        return toSentRef(resp);
      } catch (err) {
        if (!isRetryableSendError(err) || attempt >= maxRetries) {
          log?.warn(
            {
              chatId,
              type,
              attempts: attempt,
              httpStatus: err?.httpStatus ?? null,
              maxCode: err?.maxCode ?? null,
              err: err?.message ?? String(err),
            },
            isRetryableSendError(err)
              ? 'uploadAndSend: attachment still not ready, retries exhausted'
              : 'uploadAndSend: POST /messages failed (not retryable)',
          );
          throw withStage(err, 'send');
        }
        const delay = Math.min(baseMs * factor ** (attempt - 1), UPLOAD_RETRY_CAP_MS);
        log?.debug(
          { chatId, type, attempt, delay, maxCode: err?.maxCode ?? null, httpStatus: err?.httpStatus ?? null },
          'uploadAndSend: POST /messages retry (file still processing)',
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
      }
    }
  }
}
