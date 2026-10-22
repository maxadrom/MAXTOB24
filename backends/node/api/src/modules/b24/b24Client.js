// REST-клиент Битрикс24. Реальные fetch-вызовы под OAuth-токен из installations.
// Авторизация — ТОЛЬКО через b24_access_token из installationsService.getCurrent().
// Inbound webhook portal'а исключён: imconnector.*
// требует application context.
// Auto-refresh токена: при expired_token пробует один раз обновить пару
// access/refresh обменом refresh_token (b24OAuth, если B24_CLIENT_ID/SECRET заданы).
// Без них — бросает B24ApiError с подсказкой про /api/install.

import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { exchangeRefreshToken } from './b24OAuth.js';
import { B24ApiError, ValidationError } from '../../shared/http/domainErrors.js';
import { checkDownloadUrl } from '../../shared/http/ssrfGuard.js';
import { MediaTooLargeError } from '../../shared/media/mediaTooLargeError.js';
import { isAbortLike } from '../../shared/http/isAbortLike.js';
import { urlHost } from '../../shared/http/urlHost.js';

const DEFAULT_TIMEOUT_MS = 20_000;

// Непрочитанное тело держит сокет — отменяем его, когда тело не нужно (редирект, ошибка, лимит).
async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    /* тело уже закрыто */
  }
}
// Максимум хопов редиректа при скачивании файла (каждый хоп — повторная SSRF-проверка).
const MAX_DOWNLOAD_REDIRECTS = 5;

// downloadFile: сбой запроса или потока → B24ApiError DOWNLOAD_TIMEOUT / DOWNLOAD_NETWORK_ERROR.
// Уже нормализованное (SSRF-блок, лимит хопов, MediaTooLargeError) пропускается как есть.
function downloadError(err, timeoutMs, fallback) {
  if (err instanceof B24ApiError || err instanceof MediaTooLargeError) return err;
  if (isAbortLike(err)) {
    return new B24ApiError('DOWNLOAD_TIMEOUT', `file download timed out after ${timeoutMs}ms`, {
      method: '<downloadFile>',
    });
  }
  return new B24ApiError('DOWNLOAD_NETWORK_ERROR', err?.message ?? fallback, { method: '<downloadFile>' });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// PHP-стиль сериализация вложенных параметров для application/x-www-form-urlencoded:
//   {a: {b: 1}}      → [['a[b]', '1']]
//   {arr: [1, 2]}    → [['arr[0]', '1'], ['arr[1]', '2']]
//   {a: true}        → [['a', '1']]   // B24 принимает '1'/'0' и 'Y'/'N'; используем '1'/'0' единообразно
//   {a: null}        → []             // null/undefined-поля пропускаем, иначе ICON=null ломает register
export function flattenParams(value, prefix = '') {
  const out = [];

  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      const key = prefix ? `${prefix}[${idx}]` : String(idx);
      out.push(...flattenParams(item, key));
    });
    return out;
  }

  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      out.push(...flattenParams(v, key));
    }
    return out;
  }

  // primitive
  if (!prefix) {
    // одинокий примитив без ключа — на верхнем уровне быть не должен; молча пропускаем.
    return out;
  }
  out.push([prefix, serializePrimitive(value)]);
  return out;
}

function serializePrimitive(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

// Маппинг client-shape (camelCase) → B24-shape по Verified schema (M4.1):
//   chat:    {id, url?}                       — поле type НЕ шлём (его нет в схеме);
//            name не шлём: imopenlines его не читает (M24), название ставит chat.name.set
//   user:    {id, name, last_name, picture?, gender?}  — picture как {url}
//   message: {id, text, date}                 — date в секундах (unix-ts)
// id-поля приводим к String (B24 ждёт строковые id). Опциональные null/undefined
// опускаем — flattenParams их всё равно срежет, но чистим shape явно.
// M11.2: message.files[] — медиа inbound. Б24 качает файл сам по url (Verified
// Contracts), поэтому шлём только { url, name }. Клиент лишь сериализует — выбор
// «что слать» делают координатор/сервис. files опускаем, когда массив пуст.
function toB24MessageShape(m) {
  const chat = { id: String(m.chat.id) };
  if (m.chat.url != null) chat.url = m.chat.url;

  const user = {
    id: String(m.user.id),
    name: m.user.name,
    last_name: m.user.lastName ?? '',
  };
  if (m.user.picture != null) user.picture = { url: m.user.picture };
  if (m.user.gender != null) user.gender = m.user.gender;

  const message = { id: String(m.message.id), text: m.message.text, date: m.message.date };
  if (Array.isArray(m.message.files) && m.message.files.length > 0) {
    message.files = m.message.files.map((f) => ({ url: f.url, name: f.name }));
  }

  return { chat, user, message };
}

// Delete-shape для imconnector.delete.messages. Метод удаляет сообщение по внешнему id;
// дока перечисляет только идентификаторы { user:{id}, message:{id}, chat:{id} }, но
// user.name/last_name Б24 применяет к профилю пользователя коннектора: без имени автор
// становится «Гостем» (live P4 2026-10-07, M23). Поэтому имя шлём, а text/date — нет:
// НЕ переиспользуем toB24MessageShape. Все id → String.
function toB24DeleteShape(m) {
  const user = { id: String(m.user.id) };
  if (m.user.name != null) {
    user.name = m.user.name;
    user.last_name = m.user.lastName ?? '';
  }
  return {
    user,
    message: { id: String(m.message.id) },
    chat: { id: String(m.chat.id) },
  };
}

// Wire-форма статуса доставки для imconnector.send.status.delivery (Verified schema M5.3).
function toStatusDeliveryShape(s) {
  return {
    im: { chat_id: s.imChatId, message_id: s.imMessageId },
    message: { id: s.externalIds, date: s.date },
    chat: { id: s.chatId },
  };
}

export class B24Client {
  constructor({ installationsService, config, logger, fetchImpl, timeoutMs } = {}) {
    if (!installationsService) throw new TypeError('B24Client: installationsService required');
    this.installations = installationsService;
    this.config = config ?? {};
    this.logger = logger?.child ? logger.child({ component: 'b24Client' }) : logger;
    // fetch — параметр для тестов; в проде используется globalThis.fetch.
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Защита от параллельных refresh-запросов (single-tenant MVP).
    this._refreshing = null;
  }

  // M21: installation — уже прочитанная вызывающим (одно чтение на входящее); иначе из БД.
  async _resolveAuth(known = null) {
    const installation = known ?? await this.installations.getCurrent();
    if (!installation.b24Portal) {
      throw new B24ApiError('NO_AUTH', 'installation has no b24_portal', { method: '<resolveAuth>' });
    }
    if (!installation.b24AccessToken) {
      throw new B24ApiError(
        'NO_AUTH',
        'installation has no b24_access_token — run POST /api/install first',
        { method: '<resolveAuth>' },
      );
    }
    return {
      baseUrl: `https://${installation.b24Portal}/rest/`,
      accessToken: installation.b24AccessToken,
    };
  }

  async _refreshAccessToken() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    const installation = await this.installations.getCurrent();
    const oldRefresh = installation.b24RefreshToken;

    this.logger?.warn(
      { portal: installation.b24Portal },
      'b24 access_token expired — attempting OAuth refresh',
    );

    const exchanged = await exchangeRefreshToken({
      refreshToken: oldRefresh,
      clientId: this.config?.clientId,
      clientSecret: this.config?.clientSecret,
      fetchImpl: this.fetch,
      timeoutMs: this.timeoutMs,
    });

    this.logger?.info({ portal: installation.b24Portal }, 'b24 token refreshed successfully');

    // CAS по старому refresh_token: install-callback или скрипт в другом процессе мог
    // записать более свежую пару — тогда не затираем её (ретрай перечитает БД).
    await this.installations.saveRefreshedTokens(installation.id, {
      oldRefresh,
      access: exchanged.accessToken,
      refresh: exchanged.refreshToken ?? oldRefresh,
      memberId: exchanged.memberId,
    });
  }

  // installation (M21) — опционально, чтобы не читать её из БД повторно. Ретрай после
  // refresh идёт без неё: новая пара токенов — только в БД.
  async callMethod(method, params = {}, { installation = null, _isRetry = false } = {}) {
    if (!method || typeof method !== 'string') {
      throw new ValidationError('B24Client.callMethod: method must be non-empty string');
    }

    const startedAt = Date.now();
    const paramsKeys = isPlainObject(params) ? Object.keys(params) : [];
    this.logger?.debug({ method, paramsKeys }, 'b24.callMethod: start');

    const { baseUrl, accessToken } = await this._resolveAuth(installation);
    const url = `${baseUrl}${method}.json?auth=${encodeURIComponent(accessToken)}`;

    const flat = flattenParams(params);
    const body = new URLSearchParams(flat).toString();

    // M22: один дедлайн на запрос И чтение тела (раньше таймер снимался до json()).
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch (err) {
      if (isAbortLike(err)) throw this._timeoutError(method, startedAt, err);
      this.logger?.error(
        { method, durationMs: Date.now() - startedAt, err: { name: err?.name, code: err?.code, message: err?.message } },
        'b24.callMethod: network error',
      );
      throw new B24ApiError('NETWORK_ERROR', err?.message ?? 'network error', { method });
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      if (isAbortLike(err)) throw this._timeoutError(method, startedAt, err);
      this.logger?.error(
        { method, status: response.status, durationMs: Date.now() - startedAt, err: { message: err?.message } },
        'b24.callMethod: failed to parse JSON',
      );
      throw new B24ApiError('HTTP_ERROR', `HTTP ${response.status} — response not parseable as JSON`, {
        method,
        httpStatus: response.status,
      });
    }
    const durationMs = Date.now() - startedAt;

    if (data && typeof data === 'object' && data.error) {
      const b24Code = String(data.error);
      const b24Description = data.error_description ?? '';
      this.logger?.warn(
        { method, b24Code, httpStatus: response.status, durationMs },
        'b24.callMethod: b24 returned error',
      );

      if (b24Code === 'expired_token' && !_isRetry) {
        const canRefresh = Boolean(this.config?.clientId && this.config?.clientSecret);
        if (canRefresh) {
          try {
            await this._refreshAccessToken();
            return this.callMethod(method, params, { _isRetry: true });
          } catch (refreshErr) {
            this.logger?.error(
              { method, refreshErr: refreshErr.message },
              'b24 token refresh failed — cannot retry',
            );
          }
        }
      }

      // B24 возвращает `error` в теле (часто при HTTP 200); B24ApiError → внешний 502.
      throw new B24ApiError(b24Code, b24Description, {
        method,
        httpStatus: response.status,
        body: data,
      });
    }

    if (!response.ok) {
      this.logger?.warn(
        { method, status: response.status, durationMs },
        'b24.callMethod: non-2xx without b24 error envelope',
      );
      throw new B24ApiError('HTTP_ERROR', `HTTP ${response.status}`, {
        method,
        httpStatus: response.status,
        body: data,
      });
    }

    this.logger?.info({ method, durationMs, ok: true }, 'b24.callMethod: ok');
    // B24 всегда оборачивает успех в {result, time}; на всякий случай возвращаем data.result ?? data
    // (некоторые методы — в редких случаях — могут вернуть пустой result; не теряем структуру).
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : data;
  }

  _timeoutError(method, startedAt, err) {
    this.logger?.error(
      { method, durationMs: Date.now() - startedAt, err: { name: err?.name } },
      'b24.callMethod: timeout',
    );
    return new B24ApiError('TIMEOUT', `B24 request timed out after ${this.timeoutMs}ms`, { method });
  }

  // ── imconnector.* ────────────────────────────────────────────────────────────
  // Грабли B24 (verified MCP-доку 2026-05-26):
  //   • register/unregister используют поле ID
  //   • activate/list/send.*/status — поле CONNECTOR
  //   • register требует PLACEMENT_HANDLER (HTTPS-URL)
  //   • точка `.` в ID запрещена (APPLICATION_REGISTRATION_ERROR_POINT)
  //   • list возвращает объект {connector_id: connector_name}, НЕ массив

  async imconnectorRegister({
    connectorId,
    name,
    icon,
    iconDisabled,
    placementHandlerUrl,
    chatGroup = true,
    needSignature = true,
  }) {
    if (!connectorId) {
      throw new ValidationError('imconnectorRegister: connectorId required');
    }
    if (!name) {
      throw new ValidationError('imconnectorRegister: name required');
    }
    if (!icon) {
      throw new ValidationError('imconnectorRegister: icon required');
    }
    if (!placementHandlerUrl) {
      throw new ValidationError(
        'imconnectorRegister: placementHandlerUrl required (B24 returns NO_PLACEMENT_HANDLER without it)',
      );
    }
    const payload = {
      ID: connectorId,
      NAME: name,
      ICON: icon,
      PLACEMENT_HANDLER: placementHandlerUrl,
      CHAT_GROUP: chatGroup,
      NEED_SIGNATURE: needSignature,
    };
    if (iconDisabled) payload.ICON_DISABLED = iconDisabled;
    this.logger?.info({ method: 'imconnector.register', connectorId }, 'b24 imconnector.register');
    return this.callMethod('imconnector.register', payload);
  }

  async imconnectorActivate({ connectorId, lineId, active = true }) {
    if (!connectorId) throw new ValidationError('imconnectorActivate: connectorId required');
    if (!lineId) throw new ValidationError('imconnectorActivate: lineId required');
    this.logger?.info(
      { method: 'imconnector.activate', connectorId, lineId, active },
      'b24 imconnector.activate',
    );
    return this.callMethod('imconnector.activate', {
      CONNECTOR: connectorId,
      LINE: lineId,
      ACTIVE: active ? '1' : '0',
    });
  }

  async imconnectorDeactivate({ connectorId, lineId }) {
    return this.imconnectorActivate({ connectorId, lineId, active: false });
  }

  async imconnectorUnregister({ connectorId }) {
    if (!connectorId) throw new ValidationError('imconnectorUnregister: connectorId required');
    this.logger?.info(
      { method: 'imconnector.unregister', connectorId },
      'b24 imconnector.unregister',
    );
    return this.callMethod('imconnector.unregister', { ID: connectorId });
  }

  // Guard CONNECTOR/LINE для методов imconnector.* с привязкой к линии.
  _assertConnector(op, connectorId, lineId) {
    if (!connectorId) throw new ValidationError(`${op}: connectorId required`);
    if (!lineId) throw new ValidationError(`${op}: lineId required`);
  }

  // Общий путь batch-методов imconnector.* (send/update/delete/status): единые guard'ы
  // CONNECTOR/LINE/непустого массива и сериализация items в B24 wire-форму через toWire.
  async _callConnectorBatch(op, method, { connectorId, lineId, items, itemsName, installation = null }, toWire) {
    this._assertConnector(op, connectorId, lineId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError(`${op}: ${itemsName} must be a non-empty array`);
    }
    this.logger?.info({ method, connectorId, lineId, count: items.length }, `b24 ${method}`);
    return this.callMethod(method, {
      CONNECTOR: connectorId,
      LINE: lineId,
      MESSAGES: items.map(toWire),
    }, { installation });
  }

  async imconnectorList() {
    this.logger?.debug({ method: 'imconnector.list' }, 'b24 imconnector.list');
    return this.callMethod('imconnector.list', {});
  }

  // imconnector.send.messages (Verified schema M4.1). Принимает структурированный
  // контракт {connectorId, lineId, messages} (client-shape, camelCase), а НЕ raw
  // payload — знание B24 wire-формы инкапсулировано в toB24MessageShape.
  // Сериализация в PHP-форму (MESSAGES[0][chat][id]=...) — через flattenParams в callMethod.
  async imconnectorSendMessages({ connectorId, lineId, messages, installation } = {}) {
    return this._callConnectorBatch(
      'imconnectorSendMessages',
      'imconnector.send.messages',
      { connectorId, lineId, items: messages, itemsName: 'messages', installation },
      toB24MessageShape,
    );
  }

  // imconnector.update.messages (Verified docs MCP). Правка ранее доставленного
  // сообщения OL по внешнему id (message.id = наш external id, напр. 'max:mid:<mid>').
  // Контракт зеркалит imconnectorSendMessages (тот же toB24MessageShape).
  // ВАЖНО (дока): метод application-context-only (иначе WRONG_AUTH_TYPE) и НЕ batch
  // (ERROR_BATCH_METHOD_NOT_ALLOWED) — координатор шлёт по одному сообщению.
  async imconnectorUpdateMessages({ connectorId, lineId, messages, installation } = {}) {
    return this._callConnectorBatch(
      'imconnectorUpdateMessages',
      'imconnector.update.messages',
      { connectorId, lineId, items: messages, itemsName: 'messages', installation },
      toB24MessageShape,
    );
  }

  // imconnector.delete.messages (Verified docs MCP). Удаление ранее доставленного
  // сообщения OL по внешнему id (message.id = наш external id, напр. 'max:mid:<mid>').
  // Shape минимальный — toB24DeleteShape ({user,message,chat}, без text/date).
  // ВАЖНО (дока): метод application-context-only (иначе WRONG_AUTH_TYPE) и НЕ batch
  // (ERROR_BATCH_METHOD_NOT_ALLOWED) — координатор шлёт по одному сообщению.
  async imconnectorDeleteMessages({ connectorId, lineId, messages, installation } = {}) {
    return this._callConnectorBatch(
      'imconnectorDeleteMessages',
      'imconnector.delete.messages',
      { connectorId, lineId, items: messages, itemsName: 'messages', installation },
      toB24DeleteShape,
    );
  }

  // imconnector.send.status.delivery (Verified schema M5.3). Принимает client-shape
  // {connectorId, lineId, statuses[]} и шлёт B24 wire-форму MESSAGES[].
  // Ответ: {SUCCESS: bool, DATA: [], time} (NOT DATA.RESULT[] — отличие от send.messages!).
  // Auth: Application context (access_token из installations — подходит).
  async imconnectorSendStatusDelivery({ connectorId, lineId, statuses, installation } = {}) {
    return this._callConnectorBatch(
      'imconnectorSendStatusDelivery',
      'imconnector.send.status.delivery',
      { connectorId, lineId, items: statuses, itemsName: 'statuses', installation },
      toStatusDeliveryShape,
    );
  }

  // imconnector.chat.name.set (M24, verified docs MCP 2026-10-07): переименовать чат OL.
  // CHAT_ID — внешний id чата коннектора ('max:<chatId>'); USER_ID при CHAT_GROUP=true не
  // нужен. Только контекст приложения. Работает лишь при ОТКРЫТОЙ сессии, иначе HTTP 400
  // CHAT_RENAMING_FAILED (live P6) — callMethod бросает B24ApiError с этим кодом. Тот же
  // код и при открытой сессии, если имя не меняется (в том числе с хвостовым пробелом,
  // live 2026-10-08) — различает координатор по imopenlines.dialog.get.
  // Ответ: {SUCCESS, DATA:{RESULT:{}}} (проверка SUCCESS — в b24Service).
  async imconnectorChatNameSet({ connectorId, lineId, chatId, name, installation = null } = {}) {
    this._assertConnector('imconnectorChatNameSet', connectorId, lineId);
    if (!chatId) throw new ValidationError('imconnectorChatNameSet: chatId required');
    if (typeof name !== 'string' || !name) {
      throw new ValidationError('imconnectorChatNameSet: name required (non-empty)');
    }
    this.logger?.info(
      { method: 'imconnector.chat.name.set', connectorId, lineId, chatId, nameLen: name.length },
      'b24 imconnector.chat.name.set',
    );
    return this.callMethod('imconnector.chat.name.set', {
      CONNECTOR: connectorId,
      LINE: lineId,
      CHAT_ID: String(chatId),
      NAME: name,
    }, { installation });
  }

  // ── im.message.add: системное сообщение в OL-чат ───────────────────────────
  // M-lifecycle: «скрытое» (SYSTEM='Y') уведомление о вступлении/выходе участника
  // MAX-группы. Рендерится как пузырь со стороны портала, НЕ открывает/реанимирует
  // OL-сессию и НЕ уходит клиентам в MAX (verified docs MCP, scope `im`, 2026-06-10).
  //   DIALOG_ID = 'chat'+<CHAT_ID>; SYSTEM='Y'; URL_PREVIEW='N' (не разворачиваем
  //   ссылки в косметике). callMethod сам клеит auth, сериализует params и маппит
  //   ошибки B24 в B24ApiError (включая auto-refresh expired_token).
  // M28: оповещения оператора о неудаче OL → MAX — тем же методом (live 2026-10-08: в
  // коннектор не возвращается, Б24 ставит над текстом [b]<имя приложения>[/b]; REPLY_ID у
  // SYSTEM=Y не сохраняется, поэтому не передаём). installation (M21) — опционально, чтобы
  // не читать её из БД повторно.
  // Возвращает result — id созданного сообщения.
  async imMessageAdd({ dialogId, message, system = true, installation = null }) {
    if (!dialogId || typeof dialogId !== 'string') {
      throw new ValidationError('imMessageAdd: dialogId required');
    }
    if (!message || typeof message !== 'string') {
      throw new ValidationError('imMessageAdd: message required (non-empty)');
    }
    this.logger?.info(
      { method: 'im.message.add', dialogId, system },
      'b24 im.message.add',
    );
    this.logger?.debug(
      { method: 'im.message.add', dialogId, messageLen: message.length },
      'b24 im.message.add: payload',
    );
    const result = await this.callMethod('im.message.add', {
      DIALOG_ID: String(dialogId),
      MESSAGE: message,
      SYSTEM: system ? 'Y' : 'N',
      URL_PREVIEW: 'N',
    }, { installation });
    this.logger?.debug({ method: 'im.message.add', msgId: result }, 'b24 im.message.add: ok');
    return result;
  }

  // ── imopenlines.dialog.get: резолвинг CHAT_ID OL-чата по USER_CODE ──────────
  // M-lifecycle: добывает адрес чата открытой линии БЕЗ отправки сообщения и БЕЗ
  // открытия сессии (scope `imopenlines`, verified docs MCP + live 2026-06-10).
  // USER_CODE коннектор-чата: `<connectorId>|<lineId>|<connectorChatId>|0`
  //   (groupChat → последний компонент 0; connectorChatId = `max:<maxChatId>`).
  // Чат существует только если в группе уже была переписка (OL-сессия создавалась);
  // для группы без единого сообщения B24 вернёт ACCESS_ERROR — пробрасываем как
  // B24ApiError (вызывающий b24Service.resolveB24ChatId ловит и даёт null).
  // M27: либо CHAT_ID — состояние уже известного чата OL (имя, entity_data_1 с id текущей
  // сессии; b24Service.getOlChat). Ровно один из параметров.
  // callMethod возвращает распакованный result — объект чата (поле id = CHAT_ID).
  async imDialogGet({ userCode = null, chatId = null } = {}) {
    if ((userCode !== null) === (chatId !== null)) {
      throw new ValidationError('imDialogGet: exactly one of userCode / chatId required');
    }
    let params;
    if (chatId !== null) {
      if (!/^[1-9]\d*$/.test(String(chatId)) || !Number.isSafeInteger(Number(chatId))) {
        throw new ValidationError(`imDialogGet: chatId must be positive integer (got "${chatId}")`);
      }
      params = { CHAT_ID: Number(chatId) };
    } else {
      if (!userCode || typeof userCode !== 'string') {
        throw new ValidationError('imDialogGet: userCode required (non-empty)');
      }
      params = { USER_CODE: userCode };
    }
    this.logger?.debug(
      { method: 'imopenlines.dialog.get', ...(chatId !== null ? { chatId } : { userCode }) },
      'b24 imopenlines.dialog.get',
    );
    const result = await this.callMethod('imopenlines.dialog.get', params);
    this.logger?.debug(
      { method: 'imopenlines.dialog.get', chatId: result?.id ?? null },
      'b24 imopenlines.dialog.get: ok',
    );
    return result;
  }

  // ── im.dialog.messages.search: листинг последних сообщений OL-чата ──────────
  // Reply/цитирование (OL→MAX): добор связи «ответ» для исходящего. Событие
  // OnImConnectorMessageAdd НЕ несёт REPLY_ID — добираем его листингом последних
  // сообщений чата (scope `im`, verified docs MCP 2026-06-10). ORDER {ID:DESC}
  // ставит свежие сообщения у вершины окна LIMIT; LAST_ID — для пагинации (резерв).
  // SEARCH_MESSAGE НЕ шлём — нужен листинг, а не текстовый поиск (снято live).
  // Возвращает сырой result: { messages[], additionalMessages[], ... }, где
  // params.REPLY_ID/CONNECTOR_MID несут связь и мост id (разбор — в b24Service).
  // НЕЛЬЗЯ в batch (ERROR_BATCH_METHOD_NOT_ALLOWED). LIMIT max 200 (clamp — выше в config).
  // M28: installation — уже прочитанная вызывающим (снимок из резолва привязки), чтобы
  // callMethod не читал БД ещё раз; без неё читает сам.
  async imDialogMessagesSearch({ chatId, limit = 50, lastId = null, installation = null } = {}) {
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new ValidationError('imDialogMessagesSearch: chatId required');
    }
    const numericChatId = Number(chatId);
    if (!Number.isFinite(numericChatId)) {
      throw new ValidationError(`imDialogMessagesSearch: chatId must be numeric (got "${chatId}")`);
    }
    const params = {
      CHAT_ID: numericChatId,
      ORDER: { ID: 'DESC' },
      LIMIT: limit,
    };
    if (lastId !== null && lastId !== undefined) params.LAST_ID = lastId;
    this.logger?.info(
      { method: 'im.dialog.messages.search', chatId: numericChatId, limit },
      'b24 im.dialog.messages.search',
    );
    const result = await this.callMethod('im.dialog.messages.search', params, { installation });
    this.logger?.debug(
      {
        method: 'im.dialog.messages.search',
        messagesCount: Array.isArray(result?.messages) ? result.messages.length : 0,
        additionalCount: Array.isArray(result?.additionalMessages)
          ? result.additionalMessages.length
          : 0,
      },
      'b24 im.dialog.messages.search: ok',
    );
    return result;
  }

  // ── M11.2: скачивание файла оператора по downloadLink ──────────────────────
  // downloadLink (https://<portal>/pub/im.file.php?FILE_ID=…&SIGN=…) скачивается
  // АНОНИМНО — SIGN в самом url несёт авторизацию, портальный токен НЕ нужен.
  // Поэтому идём raw-fetch'ем (НЕ через callMethod, который клеит auth). Не-2xx → B24ApiError.
  //
  // Security M13: SSRF-guard. Валидируем исходную ссылку И КАЖДЫЙ хоп редиректа
  // (redirect:'manual') инвариантом checkDownloadUrl — иначе guard обходится ответом
  // 30x → 169.254.169.254/приватный IP. fetch БОЛЬШЕ не следует за редиректами сам.
  //
  // M22: тело пишется ПОТОКОМ в destPath (файл создаёт и удаляет вызывающий), память
  // константная. Content-Length больше maxBytes → тело не читаем; без Content-Length поток
  // обрывает счётчик байт — оба случая MediaTooLargeError. Один дедлайн timeoutMs на
  // редиректы и всё тело → DOWNLOAD_TIMEOUT. Возвращает { size, contentType }.
  async downloadFile(downloadLink, { destPath, maxBytes = Number.POSITIVE_INFINITY, timeoutMs = this.timeoutMs } = {}) {
    if (!downloadLink || typeof downloadLink !== 'string') {
      throw new ValidationError('B24Client.downloadFile: downloadLink required');
    }
    if (!destPath) {
      throw new ValidationError('B24Client.downloadFile: destPath required');
    }

    const signal = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();
    const host = urlHost(downloadLink);
    this.logger?.debug({ host }, 'b24.downloadFile: start');

    const response = await this._fetchDownload(downloadLink, signal, timeoutMs);

    if (!response.ok || !response.body) {
      await cancelBody(response);
      this.logger?.warn({ host, status: response.status }, 'b24.downloadFile: non-2xx');
      throw new B24ApiError('DOWNLOAD_FAILED', `file download HTTP ${response.status}`, {
        method: '<downloadFile>',
        httpStatus: response.status,
      });
    }

    const contentType = response.headers?.get?.('content-type') ?? null;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelBody(response);
      throw new MediaTooLargeError(`file is ${declared} bytes (limit ${maxBytes})`, { size: declared, limit: maxBytes });
    }

    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new MediaTooLargeError(`file exceeds ${maxBytes} bytes`, { size, limit: maxBytes }));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(destPath), { signal });
    } catch (err) {
      throw downloadError(err, timeoutMs, 'stream error');
    }

    this.logger?.info(
      { host, contentType, size, durationMs: Date.now() - startedAt },
      'b24.downloadFile: ok',
    );
    return { size, contentType };
  }

  // Цикл редиректов downloadFile: SSRF-проверка каждого хопа, тела 30x отменяются.
  async _fetchDownload(downloadLink, signal, timeoutMs) {
    try {
      let currentUrl = downloadLink;
      for (let hop = 0; ; hop += 1) {
        const check = checkDownloadUrl(currentUrl);
        if (!check.ok) {
          this.logger?.warn(
            { host: check.host ?? urlHost(currentUrl), reason: check.reason, hop },
            `[FIX][ssrf] blocked download host=${check.host ?? '<unknown>'} reason=${check.reason}`,
          );
          throw new B24ApiError(
            'DOWNLOAD_BLOCKED',
            `download URL rejected by SSRF guard: ${check.reason}`,
            { method: '<downloadFile>' },
          );
        }
        // eslint-disable-next-line no-await-in-loop
        const response = await this.fetch(currentUrl, { method: 'GET', redirect: 'manual', signal });
        // 30x с Location — валидируем следующий хоп перед переходом.
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers?.get?.('location');
        if (!location) return response; // редирект без Location — не-2xx словится выше
        // eslint-disable-next-line no-await-in-loop
        await cancelBody(response);
        if (hop >= MAX_DOWNLOAD_REDIRECTS) {
          throw new B24ApiError(
            'DOWNLOAD_TOO_MANY_REDIRECTS',
            `file download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`,
            { method: '<downloadFile>' },
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
      }
    } catch (err) {
      throw downloadError(err, timeoutMs, 'network error');
    }
  }
}
