// DTO для входящего payload от MAX Bot API.
//
// Для message_* типов поля chat/sender вложены в update.message
// (recipient.chat_id, sender.user_id, body.mid), для lifecycle-типов
// (bot_added/bot_removed/user_added/user_removed/bot_started) chat_id лежит
// прямо в update (плоский). DTO нормализует оба варианта, чтобы читатели не
// знали про shape-различия и не писали null в диагностические поля.
//
// После нормализации все читатели (controller, service, messagingService)
// работают с унифицированными полями update.chatId / update.mid / update.senderId,
// а `raw` хранит исходный payload для будущего routing-кода в M4.

import { urlHost } from '../../../shared/http/urlHost.js';

const MESSAGE_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_callback',
  'message_chat_created',
]);

// "first_name last_name" (пустые части отфильтрованы) либо null.
function joinFirstLast(person) {
  const parts = [person.first_name, person.last_name]
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  return parts.length > 0 ? parts.join(' ') : null;
}

// Строковое person.name без пробелов по краям либо null.
function trimmedName(person) {
  const name = typeof person.name === 'string' ? person.name.trim() : '';
  return name || null;
}

// Человекочитаемое имя автора для inbound-routing (M4): приоритет
//   1) sender.name (готовая строка от MAX)
//   2) "first_name last_name" (пустые части отфильтрованы)
//   3) "MAX user <senderId>" — fallback, чтобы B24 user.name никогда не был пустым
//   4) null — нет ни имени, ни senderId (например, системное message_* без sender)
function deriveSenderName(sender, senderId) {
  const name = deriveParentSenderName(sender);
  if (name) return name;
  if (senderId !== null && senderId !== undefined) return `MAX user ${senderId}`;
  return null;
}
// Reply/цитирование: типы связи message.link, которые пробрасываем как replyContext.
// 'reply' — ответ на сообщение; 'forward' — пересланное (оформляем помеченной цитатой).
const REPLY_LINK_TYPES = new Set(['reply', 'forward']);

// Имя автора РОДИТЕЛЬСКОГО сообщения для цитаты (MAX→OL). Приоритет как у
// deriveSenderName, НО без хвостового fallback "MAX user <id>": для цитаты нам
// важно реальное имя, а при его отсутствии цитируем без имени (null).
//   1) sender.name → 2) "first_name last_name" → 3) null
function deriveParentSenderName(sender) {
  if (!sender || typeof sender !== 'object') return null;
  return trimmedName(sender) ?? joinFirstLast(sender);
}

// Reply/цитирование: нормализация message.link → replyContext.
//   link = { type:'reply'|'forward', message:{ mid, text, seq, markup }, sender:{…}, chat_id }
// Нет link / неизвестный type / битая форма → null (не падаем; routeInbound шлёт без цитаты).
// parentText='' допустим (родитель — медиа без текста): цитируем только имя автора.
function parseReplyContext(link) {
  if (!link || typeof link !== 'object') return null;
  const type = link.type ?? null;
  if (!REPLY_LINK_TYPES.has(type)) return null;
  const parentMsg = link.message && typeof link.message === 'object' ? link.message : {};
  const parentMid = parentMsg.mid ?? null;
  const parentText = typeof parentMsg.text === 'string' ? parentMsg.text : '';
  const parentSenderName = deriveParentSenderName(link.sender);
  return { type, parentMid, parentText, parentSenderName };
}

// M21: тип чата получателя (message.recipient.chat_type): 'chat' — группа, 'dialog' —
// личка с ботом, 'channel' — канал. Мост работает только с группами.
const GROUP_CHAT_TYPE = 'chat';

const LIFECYCLE_UPDATE_TYPES = new Set([
  'bot_added',
  'bot_removed',
  'user_added',
  'user_removed',
  'bot_started',
]);

// Имя участника для lifecycle-уведомлений (user_added/user_removed). Отличается от
// deriveSenderName приоритетом: для lifecycle payload.user даёт first_name/last_name
// напрямую, а строковый name — устаревший fallback. Возвращает:
//   1) "first_name last_name" (пустые части отфильтрованы)
//   2) user.name (устаревшее, но иногда приходит)
//   3) null — текст-билдер координатора подставит финальный "MAX user <id>"
function deriveLifecycleName(user) {
  if (!user || typeof user !== 'object') return null;
  return joinFirstLast(user) ?? trimmedName(user);
}

// M11.2: поддерживаемые типы вложений MAX (сняты live в M11.1).
// M11.3: + 'audio' — inbound голосовые (host a.oneme.ru/audio, mime audio/ogg).
// Б24 качает файл по url сам и рендерит встроенным аудио-плеером (по mime/расширению).
const ATTACHMENT_KINDS = new Set(['image', 'file', 'video', 'sticker', 'audio']);

// Имя файла из id вложения + расширение; fallback на kind, если id пуст.
function deriveAttachmentName(id, kind, ext) {
  const hasId = id !== null && id !== undefined && String(id).trim() !== '';
  const base = hasId ? String(id).trim() : kind;
  return `${base}.${ext}`;
}

export class MaxUpdate {
  constructor({
    updateType,
    timestamp = null,
    chatId = null,
    chatType = null,
    mid = null,
    senderId = null,
    senderName = null,
    message = null,
    isChannel = null,
    replyContext = null,
    chatTitle = null,
    raw = null,
  }) {
    if (!updateType) throw new TypeError('MaxUpdate: updateType required');
    this.updateType = updateType;
    this.timestamp = timestamp;
    this.chatId = chatId;
    // M21: 'chat' | 'dialog' | 'channel' для message_*-типов, иначе null.
    this.chatType = chatType;
    this.mid = mid;
    this.senderId = senderId;
    this.senderName = senderName;
    this.message = message;
    this.isChannel = isChannel;
    // Reply/цитирование: { type:'reply'|'forward', parentMid, parentText, parentSenderName }
    // или null. Заполняется из message.link для message_* типов (см. fromWebhookBody).
    this.replyContext = replyContext;
    // M24: новое название группы из chat_title_changed (trim) или null.
    this.chatTitle = chatTitle;
    this.raw = raw;
  }

  // M21: сообщение из группы. Нет chat_type → fail-open (как до M21): поле есть у живых
  // сообщений групп, а пропажа поля не должна остановить мост. Любое другое явное
  // значение (личка, канал, новый тип) — не группа.
  isGroupChat() {
    return this.chatType === null || this.chatType === undefined || this.chatType === GROUP_CHAT_TYPE;
  }

  // M11.2: нормализованный доступ к message.body.attachments[].
  // Возвращает массив нейтральных DTO { kind, url, name } для inbound-медиа
  // (MAX → Open Lines). url берём из payload.url; filename (для file) — с уровня
  // attachment, НЕ из payload. Неизвестный type или отсутствие url → skip + WARN
  // (не падаем). logger — опциональный scoped-логгер (протащен из routeInbound).
  // M21: у пересылки своё тело пустое, а пересланное — в message.link.message (текст
  // уходит цитатой, live 2026-10-08: картинка с подписью дошла без картинки). Поэтому
  // берём и link.message.attachments, но только для forward: у reply там родитель, его
  // медиа к ответу не относится. Повтор того же url не дублируем.
  attachments({ logger } = {}) {
    const own = this.message?.body?.attachments;
    const link = this.message?.link;
    const forwarded = link?.type === 'forward' ? link?.message?.attachments : null;
    const raw = [
      ...(Array.isArray(own) ? own : []),
      ...(Array.isArray(forwarded) ? forwarded : []),
    ];
    if (raw.length === 0) return [];

    const out = [];
    const seen = new Set();
    for (const att of raw) {
      const type = att?.type ?? null;
      const payload = att?.payload ?? {};
      const url = payload?.url ?? null;

      if (!ATTACHMENT_KINDS.has(type)) {
        logger?.warn({ type }, 'maxUpdate.attachments: unknown attachment type, skipping');
        continue;
      }
      if (!url || typeof url !== 'string') {
        logger?.warn({ type }, 'maxUpdate.attachments: attachment without url, skipping');
        continue;
      }

      let name;
      if (type === 'image') {
        name = deriveAttachmentName(payload.photo_id, 'image', 'webp');
      } else if (type === 'file') {
        // filename живёт на уровне attachment (НЕ в payload).
        name = typeof att.filename === 'string' && att.filename.trim()
          ? att.filename.trim()
          : deriveAttachmentName(payload.fileId, 'file', 'bin');
      } else if (type === 'video') {
        name = deriveAttachmentName(payload.id, 'video', 'mp4');
      } else if (type === 'audio') {
        // M11.3: голосовое — та же форма payload.id, что у video; имя <id>.ogg.
        name = deriveAttachmentName(payload.id, 'audio', 'ogg');
      } else {
        // sticker — пересылаем как картинку.
        name = deriveAttachmentName(payload.code, 'sticker', 'png');
      }

      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ kind: type, url, name });
      logger?.debug(
        { kind: type, host: urlHost(url), hasName: Boolean(name) },
        'maxUpdate.attachments: parsed attachment',
      );
    }
    return out;
  }

  static fromWebhookBody(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('MaxUpdate.fromWebhookBody: payload must be object');
    }
    const updateType = payload.update_type ?? payload.updateType;
    if (!updateType) {
      throw new TypeError('MaxUpdate.fromWebhookBody: update_type required');
    }

    let chatId = null;
    let chatType = null;
    let mid = null;
    let senderId = null;
    let senderName = null;
    let message = null;
    let replyContext = null;
    let chatTitle = null;
    const isChannel = typeof payload.is_channel === 'boolean' ? payload.is_channel : null;

    if (
      MESSAGE_UPDATE_TYPES.has(updateType)
      && payload.message
      && typeof payload.message === 'object'
    ) {
      message = payload.message;
      chatId = message?.recipient?.chat_id ?? null;
      chatType = typeof message?.recipient?.chat_type === 'string' ? message.recipient.chat_type : null;
      mid = message?.body?.mid ?? null;
      senderId = message?.sender?.user_id ?? null;
      senderName = deriveSenderName(message?.sender, senderId);
      // Reply/цитирование: связь «ответ/пересылка» приходит в message.link.
      replyContext = parseReplyContext(message?.link);
    } else if (LIFECYCLE_UPDATE_TYPES.has(updateType)) {
      chatId = payload.chat_id ?? null;
      // Для bot_added/bot_started — payload.user.user_id (сам бот).
      // Для user_added — payload.user.user_id (тот, кого добавили),
      // payload.inviter_id — кто пригласил (вторичен).
      // Для user_removed — payload.user.user_id (тот, кого удалили),
      // payload.admin_id — кто удалил (вторичен).
      senderId =
        payload.user?.user_id
        ?? payload.inviter_id
        ?? payload.admin_id
        ?? null;
      // Имя участника для user_added/user_removed уведомлений (best-effort);
      // bot_*-события имя не используют, но извлечение безопасно (null при отсутствии).
      senderName = deriveLifecycleName(payload.user);
    } else if (updateType === 'message_removed') {
      chatId = payload.chat_id ?? null;
      mid = payload.message_id ?? null;
      senderId = payload.user_id ?? null;
    } else if (updateType === 'chat_title_changed') {
      // M24: { chat_id, user (кто переименовал), title } — плоский, как lifecycle.
      chatId = payload.chat_id ?? null;
      senderId = payload.user?.user_id ?? null;
      senderName = deriveLifecycleName(payload.user);
      chatTitle = typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : null;
    }
    // Остальные типы (dialog_* и пр.) — оставляем все null;
    // контроллер всё равно отдаёт 200 с status: 'ignored'.

    return new MaxUpdate({
      updateType,
      timestamp: payload.timestamp ?? null,
      chatId,
      chatType,
      mid,
      senderId,
      senderName,
      message,
      isChannel,
      replyContext,
      chatTitle,
      raw: payload,
    });
  }
}
