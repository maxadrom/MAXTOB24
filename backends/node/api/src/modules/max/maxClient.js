// Тонкий клиент MAX Bot API. Реализует:
//   - GET /me (max_bot_id для installations);
//   - subscribe/listSubscriptions/removeSubscription/getChatMember;
//   - sendMessage и upload-флоу (createUpload/uploadBinary/buildAttachmentPayload).
//
// Поведение запросов:
//   - Базовые URL и таймауты приходят через конструктор/config.max (single source of truth).
//   - Все запросы идут через приватный _fetchJson({method, path, body, query, timeoutMs}).
//   - Заголовки: Authorization: <token>, Content-Type: application/json только если есть body.
//   - На non-2xx — MaxApiError (httpStatus, maxCode, maxMessage) + первые 200 символов body в message.
//   - Логирование: debug на старте, info на успехе, warn на non-2xx.
//     Значение токена и поле `secret` в body НИКОГДА не пишутся в лог.

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DEFAULTS } from '../../shared/config/schema.js';
import { isAbortLike } from '../../shared/http/isAbortLike.js';
import { MaxApiError } from './maxApiError.js';

const DEFAULT_GETME_TIMEOUT_MS = 5_000;
const DEFAULT_API_TIMEOUT_MS = 10_000;
// M22: ответ заливки — {fileId,token} / {photos} / <retval>1</retval>; больше не читаем.
const UPLOAD_RESPONSE_MAX_BYTES = 1024 * 1024;
// M11.2: допустимые типы вложений MAX upload-флоу.
const UPLOAD_TYPES = new Set(['image', 'video', 'audio', 'file']);

// Поля body, которые НЕ должны попадать в лог при ошибках.
// На M3 это только 'secret' (в POST /subscriptions). Расширяем при необходимости.
const REDACTED_BODY_FIELDS = new Set(['secret', 'token', 'password']);

// Тело ответа: JSON, если разбирается; иначе data=null и сырой text для диагностики.
// errorText — сообщение для non-2xx (message/error из JSON либо первые 200 символов;
// оно же MaxApiError.maxMessage); errorCode — строковое поле `code` из JSON (для
// MaxApiError.maxCode), иначе null.
async function readBody(response) {
  return parseBodyText(await response.text());
}

function parseBodyText(text) {
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep as text */
    }
  }
  const errorText = (data && (data.message || data.error)) ?? (text ? text.slice(0, 200) : '');
  const errorCode = typeof data?.code === 'string' ? data.code : null;
  return { data, text, errorText, errorCode };
}

// M22: ответа нет — таймаут (AbortSignal) или сеть → MaxApiError kind timeout|network.
// label — префикс сообщения («MaxClient GET /me»), ctx — method/path для полей ошибки.
function transportError(label, err, timeoutMs, ctx, aborted = false) {
  return aborted || isAbortLike(err)
    ? new MaxApiError(`${label}: timed out after ${timeoutMs}ms`, { ...ctx, kind: 'timeout' })
    : new MaxApiError(`${label}: network error — ${err?.message ?? 'unknown'}`, { ...ctx, kind: 'network' });
}

// Ответ не-2xx → MaxApiError kind http; maxMessage (M28) — текст ошибки из тела.
function httpError(label, status, { errorText, errorCode }, ctx) {
  return new MaxApiError(`${label}: HTTP ${status} — ${errorText}`, {
    ...ctx, httpStatus: status, maxCode: errorCode, maxMessage: errorText || null,
  });
}

// M28: код отказа MAX из 2xx-ответа заливки — непустая строка error_data, иначе null.
function uploadErrorData(uploadResult) {
  const errorData = uploadResult?.error_data;
  return typeof errorData === 'string' && errorData ? errorData : null;
}

// M28: 2xx-ответ заливки без photos/токена (или с отказом в error_data) → MaxApiError kind
// 'protocol'. Если MAX указал причину в error_data — она в maxCode и хвостом в тексте ошибки.
function uploadRejectedError(message, uploadResult) {
  const maxCode = uploadErrorData(uploadResult);
  return new MaxApiError(maxCode ? `${message} — MAX rejected upload: ${maxCode}` : message, {
    kind: 'protocol',
    maxCode,
  });
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = REDACTED_BODY_FIELDS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

// M22: multipart/form-data с одним полем `data`. Имя файла экранируется как в undici
// FormData (кавычка и CR/LF — percent-encoding), не-ASCII уходит как UTF-8.
function multipartEnvelope({ filename, contentType }) {
  const boundary = `----maxtob24-${randomBytes(12).toString('hex')}`;
  const safeName = String(filename || 'upload.bin')
    .replace(/"/g, '%22')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  const safeType = String(contentType || 'application/octet-stream').replace(/[\r\n]/g, '');
  return {
    boundary,
    head: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${safeName}"\r\n`
        + `Content-Type: ${safeType}\r\n\r\n`,
      'utf8',
    ),
    tail: Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  };
}

async function* multipartBody(filePath, { head, tail }) {
  yield head;
  yield* createReadStream(filePath);
  yield tail;
}

// POST multipart потоком: файл → сокет через pipeline (backpressure), ответ — до
// UPLOAD_RESPONSE_MAX_BYTES. Резолвится ответом сервера (даже если он пришёл раньше,
// чем ушло тело), реджектится на сеть/abort.
function postMultipart(url, filePath, envelope, size, signal) {
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${envelope.boundary}`,
        'Content-Length': envelope.head.length + size + envelope.tail.length,
      },
    });
    req.on('response', (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= UPLOAD_RESPONSE_MAX_BYTES) chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    pipeline(Readable.from(multipartBody(filePath, envelope)), req).catch(reject);
  });
}

export class MaxClient {
  // uploadTimeoutMs (M22) — дедлайн заливки бинаря целиком (config.media.transferTimeoutMs).
  constructor({ baseUrl, token, logger, fetchImpl, timeoutMs, uploadTimeoutMs } = {}) {
    if (!baseUrl) throw new TypeError('MaxClient: baseUrl required');
    this.baseUrl = baseUrl;
    this.token = token ?? null;
    this.logger = logger?.child ? logger.child({ component: 'maxClient' }) : logger;
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    // Таймаут getMe. Остальные методы используют DEFAULT_API_TIMEOUT_MS через _fetchJson.
    this.timeoutMs = timeoutMs ?? DEFAULT_GETME_TIMEOUT_MS;
    this.uploadTimeoutMs = uploadTimeoutMs ?? DEFAULTS.mediaTransferTimeoutMs;
  }

  hasToken() {
    return Boolean(this.token);
  }

  // ── M3: общий transport-хелпер ─────────────────────────────────────────────
  // Бросает Error на отсутствующий токен; MaxApiError — на сеть / timeout / non-2xx (M22).
  async _fetchJson({
    method,
    path,
    body = undefined,
    query = undefined,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
  }) {
    if (!this.token) {
      throw new Error(`MaxClient: token is not configured (${method} ${path})`);
    }

    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const startedAt = Date.now();
    this.logger?.debug(
      { method, path, hasBody: Boolean(body), hasQuery: Boolean(query) },
      'maxClient: request start',
    );

    // M22: один дедлайн на запрос И чтение тела — снятый до readBody таймер оставлял
    // зависшее тело без ограничения. Таймаут и сеть → MaxApiError (kind timeout/network).
    let response;
    let parsed;
    try {
      response = await this.fetch(url.toString(), {
        method,
        headers: {
          Authorization: this.token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      parsed = await readBody(response);
    } catch (err) {
      throw transportError(`MaxClient ${method} ${path}`, err, timeoutMs, { method, path });
    }

    const durationMs = Date.now() - startedAt;
    const { data, text } = parsed;

    if (!response.ok) {
      const snippet = data ?? (text ? text.slice(0, 200) : null);
      this.logger?.warn(
        { method, path, status: response.status, durationMs, body: snippet },
        'maxClient: non-2xx',
      );
      throw httpError(`MaxClient ${method} ${path}`, response.status, parsed, { method, path });
    }

    this.logger?.info(
      { method, path, status: response.status, durationMs },
      'maxClient: ok',
    );
    return data;
  }

  // ── M2: GET /me ────────────────────────────────────────────────────────────
  // Получить идентификатор бота (botId для lifecycle self-check). Короткий таймаут
  // this.timeoutMs (по умолчанию 5s) вместо API-дефолта.
  async getMe() {
    return this._fetchJson({ method: 'GET', path: '/me', timeoutMs: this.timeoutMs });
  }

  // ── M3: POST /subscriptions — регистрация webhook ──────────────────────────
  async subscribe({ url, secret, updateTypes } = {}) {
    if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('MaxClient.subscribe: url must start with https://');
    }
    if (!Array.isArray(updateTypes) || updateTypes.length === 0) {
      throw new Error('MaxClient.subscribe: updateTypes must be non-empty array');
    }
    if (!secret) {
      throw new Error('MaxClient.subscribe: secret is required');
    }
    this.logger?.debug(
      { url, updateTypes, body: redactBody({ url, secret, update_types: updateTypes }) },
      'maxClient.subscribe: start',
    );
    return this._fetchJson({
      method: 'POST',
      path: '/subscriptions',
      body: { url, secret, update_types: updateTypes },
    });
  }

  // ── M3: GET /subscriptions ─────────────────────────────────────────────────
  async listSubscriptions() {
    return this._fetchJson({ method: 'GET', path: '/subscriptions' });
  }

  // ── M3: DELETE /subscriptions?url=... ──────────────────────────────────────
  async removeSubscription({ url } = {}) {
    if (!url) throw new Error('MaxClient.removeSubscription: url required');
    return this._fetchJson({
      method: 'DELETE',
      path: '/subscriptions',
      query: { url },
    });
  }

  // ── M3: GET /chats/{chatId}/members/{userId} ───────────────────────────────
  // Возвращает ChatMember (permissions: ChatAdminPermission[]|null, is_admin, ...).
  // Используется в maxService.handleLifecycleEvent для лога admin-прав бота.
  async getChatMember(chatId, userId = 'me') {
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('MaxClient.getChatMember: chatId required');
    }
    return this._fetchJson({
      method: 'GET',
      path: `/chats/${encodeURIComponent(String(chatId))}/members/${encodeURIComponent(String(userId))}`,
    });
  }

  // ── M10 (fix): GET /chats/{chatId}/members?user_ids=… ──────────────────────
  // У MAX Bot API НЕТ пути /members/{userId} (404 "Path is not recognized") —
  // он валиден только для 'me'. Конкретного участника группы берём из списка
  // участников с фильтром user_ids. Ответ — { members: [ChatMember...] },
  // где ChatMember содержит user_id, name, avatar_url, full_avatar_url.
  // Используется maxService.getMemberAvatar для аватара автора.
  async getChatMembers(chatId, { userIds } = {}) {
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('MaxClient.getChatMembers: chatId required');
    }
    const query = {};
    if (Array.isArray(userIds) && userIds.length > 0) {
      query.user_ids = userIds.map((id) => String(id)).join(',');
    }
    return this._fetchJson({
      method: 'GET',
      path: `/chats/${encodeURIComponent(String(chatId))}/members`,
      query,
    });
  }

  // ── M10: GET /chats/{chatId} ───────────────────────────────────────────────
  // Возвращает Chat-объект (title, icon?, type, participants_count, ...). В webhook
  // message_created названия и иконки группы НЕТ (только chat_id) — берём через API
  // (header-auth, тот же транспорт, что getChatMember). Зовётся для интро группы
  // в OL (maxService.getChatInfo, M24).
  async getChat(chatId) {
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('MaxClient.getChat: chatId required');
    }
    return this._fetchJson({
      method: 'GET',
      path: `/chats/${encodeURIComponent(String(chatId))}`,
    });
  }

  // ── M5.2/M5.3: POST /messages?chat_id=… — отправка текста в MAX-группу ──────
  // message — MaxMessage-подобный { chatId, text, format?, attachments?, link? }. Verified-контракт M5.1.
  // format (M5.3): если задан (напр. 'markdown') — добавляется в body для рендера форматирования.
  // M11.2: attachments:[{ type, payload }] — медиа OL → MAX (text при этом опционален).
  // Reply: link:{ type:'reply', mid } — нативный кликабельный reply OL→MAX (снят live 2026-06-10).
  // M21: userId вместо chatId — сообщение пользователю в личку с ботом (POST /messages?user_id=,
  // dev.max.ru); нужен для подсказки «работаю только в группах». Ровно один адресат.
  async sendMessage(message) {
    const { chatId, userId, text, format, attachments, link } = message ?? {};
    if (!chatId === !userId) throw new TypeError('MaxClient.sendMessage: exactly one of chatId/userId required');
    if (typeof text !== 'string') throw new TypeError('MaxClient.sendMessage: text must be string');
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    this.logger?.debug(
      {
        chatId: chatId ?? null,
        userId: userId ?? null,
        textPrefix: String(text).slice(0, 32),
        format: format ?? null,
        attachmentsCount: hasAttachments ? attachments.length : 0,
        replyMidPresent: Boolean(link),
      },
      'maxClient.sendMessage: start',
    );

    const body = {};
    if (hasAttachments) {
      body.attachments = attachments;
      if (text) body.text = text; // подпись вместе с вложением, если есть
    } else {
      body.text = text; // текст-только (как раньше, даже пустой)
    }
    if (format) body.format = format;
    // Reply: нативная связь «ответ» — кладём link в тело POST /messages.
    if (link) body.link = link;

    return this._fetchJson({
      method: 'POST',
      path: '/messages',
      query: chatId ? { chat_id: chatId } : { user_id: userId },
      body,
    });
  }

  // ── OUTBOUND-правка: PUT /messages?message_id=… — правка текста в MAX-группе ──
  // Правка ранее доставленного сообщения по его maxMid (message_id). Тело для текста
  // простое { text, format? } (подтверждено live-приёмкой M14).
  // _fetchJson уже поддерживает любой HTTP-метод (в т.ч. PUT) и query.
  // Ответ — { success, message? } и 200 на неудачу тоже (live 2026-10-08): итог разбирает
  // фасад maxService.editOutgoing.
  async editMessage({ messageId, text, format } = {}) {
    if (!messageId) throw new TypeError('MaxClient.editMessage: messageId required');
    if (typeof text !== 'string') throw new TypeError('MaxClient.editMessage: text must be string');
    this.logger?.debug(
      { method: 'PUT /messages', messageId, textPrefix: String(text).slice(0, 32), format: format ?? null },
      'maxClient.editMessage: start',
    );
    return this._fetchJson({
      method: 'PUT',
      path: '/messages',
      query: { message_id: messageId },
      body: { text, ...(format ? { format } : {}) },
    });
  }

  // ── OUTBOUND-удаление: DELETE /messages?message_id=… — удаление в MAX-группе ──
  // Удаление ранее доставленного сообщения по его maxMid (message_id). Идемпотентно
  // (повтор того же mid → снова { success:true } — live 2026-06-17, 2026-10-08); MAX не
  // удалил → 200 { success:false, message } (причина в message; лимита по давности в доке нет,
  // live удалено и через 63 ч). Образцы: editMessage (PUT) и removeSubscription
  // (DELETE /subscriptions с query).
  async deleteMessage({ messageId } = {}) {
    if (!messageId) throw new TypeError('MaxClient.deleteMessage: messageId required');
    this.logger?.debug(
      { method: 'DELETE /messages', messageId },
      'maxClient.deleteMessage: start',
    );
    return this._fetchJson({
      method: 'DELETE',
      path: '/messages',
      query: { message_id: messageId },
    });
  }

  // ── M11.2: MAX upload-флоу (исходящий файл OL → MAX), транспорт ─────────────
  // Шаг 1: POST /uploads?type=<...> → { url } (подписанный, токен в самом url).
  // Идёт через обычный авторизованный транспорт (_fetchJson, заголовок Authorization).
  async createUpload(type) {
    if (!UPLOAD_TYPES.has(type)) {
      throw new TypeError(`MaxClient.createUpload: type must be image|video|audio|file (got ${type})`);
    }
    this.logger?.debug({ type }, 'maxClient.createUpload: start');
    return this._fetchJson({ method: 'POST', path: '/uploads', query: { type } });
  }

  // Шаг 2: залить бинарь на ВЫДАННЫЙ uploadUrl (multipart, поле формы `data`).
  // ⚠️ КРИТИЧНО: uploadUrl — абсолютный URL на ЧУЖОЙ хост (fu.oneme.ru/*.okcdn.ru).
  // НЕЛЬЗЯ слать через _fetchJson (тот клеит baseUrl и Authorization): абсолютный URL
  // как есть, БЕЗ auth-заголовка (url сам несёт авторизацию — см. scripts/probe-max-upload.js).
  // Возвращает сырой ответ заливки ({ fileId, token } для file / { photos } для image /
  // null для video-audio, где тело — <retval>1</retval>).
  //
  // M22: файл идёт ПОТОКОМ с диска (file.path), память константная. Встроенный fetch
  // буферизует тело целиком (и FormData+Blob, и stream с duplex:'half' — замер: пик ≈
  // размер файла), поэтому node:https.request + pipeline и multipart вручную с явной
  // Content-Length. Протокол — по url (http: — локальный сервер в тестах). Один дедлайн
  // timeoutMs на всю заливку и ответ; таймаут/сеть → MaxApiError (kind timeout|network).
  async uploadBinary(uploadUrl, file, { timeoutMs = this.uploadTimeoutMs } = {}) {
    if (!uploadUrl || typeof uploadUrl !== 'string') {
      throw new TypeError('MaxClient.uploadBinary: uploadUrl required');
    }
    if (!file?.path) throw new TypeError('MaxClient.uploadBinary: file.path required');

    const url = new URL(uploadUrl);
    const host = url.host;
    const { size } = await stat(file.path);
    const envelope = multipartEnvelope(file);
    const signal = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();
    this.logger?.debug(
      { host, size, contentType: file.contentType ?? null },
      'maxClient.uploadBinary: start',
    );

    let res;
    try {
      res = await postMultipart(url, file.path, envelope, size, signal);
    } catch (err) {
      throw transportError('MaxClient.uploadBinary', err, timeoutMs, { method: 'POST' }, signal.aborted);
    }

    const parsed = parseBodyText(res.text);
    if (res.status < 200 || res.status >= 300) {
      this.logger?.warn({ host, status: res.status, size }, 'maxClient.uploadBinary: non-2xx');
      throw httpError('MaxClient.uploadBinary', res.status, parsed, { method: 'POST' });
    }
    const { data } = parsed;

    this.logger?.info(
      { host, size, durationMs: Date.now() - startedAt },
      'maxClient.uploadBinary: ok',
    );
    return data;
  }

  // M11.2: собрать attachments[].payload из ответов upload-флоу.
  // Источник токена зависит от типа (снято live 2026-05-31, эталон —
  // extractAttachmentPayload в scripts/probe-max-upload.js):
  //   • image           — заливка бинаря отдаёт { photos:{…} } → payload { photos };
  //   • file            — токен в ответе ЗАЛИВКИ ({ fileId, token });
  //   • video / audio   — заливка отдаёт <retval>1</retval> (не JSON, без токена);
  //                       токен лежит в ответе createUpload (/uploads → { url, token }).
  // Поэтому принимаем ОБА ответа и берём первый доступный token
  // (uploads.token → put.token). Для image — всегда { photos } из заливки.
  //
  // M28: отказ MAX принять файл как этот тип приходит ответом ЗАЛИВКИ с HTTP 200 —
  // {error_code, error_data} без photos/токена (live 2026-10-08: картинка 1×1, HEIC, SVG →
  // error_data IMAGE_INVALID_FORMAT; сторона больше 7680 px → IMAGE_DIMENSION_CHECK_FAIL).
  // error_data → maxCode ошибки kind 'protocol' (по нему maxService перезаливает файлом).
  // error_code («503», «1») — внутренний код MAX, а не HTTP-статус: не читаем.
  // У video/audio токен выдаёт /uploads ещё ДО заливки, и принятие бинаря он не доказывает:
  // ответ заливки без своего токена, но с error_data — тоже отказ (форма для видео live не
  // снята; на успехе заливка видео/аудио отдаёт <retval>1</retval> → uploadResult null).
  buildAttachmentPayload(type, { uploadsResponse = null, uploadResult = null } = {}) {
    if (type === 'image') {
      if (uploadResult && uploadResult.photos && typeof uploadResult.photos === 'object') {
        return { photos: uploadResult.photos };
      }
      throw uploadRejectedError('MaxClient.buildAttachmentPayload: image upload result has no photos', uploadResult);
    }
    const uploadToken = (uploadResult && typeof uploadResult.token === 'string' && uploadResult.token) || null;
    const token =
      (uploadsResponse && typeof uploadsResponse.token === 'string' && uploadsResponse.token) ||
      uploadToken ||
      null;
    if (token && !uploadToken && uploadErrorData(uploadResult)) {
      throw uploadRejectedError(
        `MaxClient.buildAttachmentPayload: binary upload for type=${type} rejected (token from /uploads only)`,
        uploadResult,
      );
    }
    if (token) {
      return { token };
    }
    throw uploadRejectedError(
      `MaxClient.buildAttachmentPayload: cannot resolve token for type=${type} (empty /uploads and binary-upload result)`,
      uploadResult,
    );
  }
}
