// Use-case service Б24. На M2 — добавляем registerConnector/unregisterConnector
// с idempotency через imconnector.list (объект {connector_id: connector_name}).
// На M4.2 — sendConnectorMessage: обогащает connectorId/lineId из installations,
// маппит ConnectorMessage → client-shape, проверяет SUCCESS, извлекает session.
// Записи в installations делает не сервис, а сам скрипт регистрации, чтобы
// сохранить тонкую границу: b24Service знает только про Б24-сторону.
// M26: исключение — handleAppUninstall: событие Б24 об удалении приложения сбрасывает
// токены через фасад installationsService.markUninstalled.

import { B24ApiError, ConfigError, ValidationError } from '../../shared/http/domainErrors.js';
import { urlHost } from '../../shared/http/urlHost.js';
import { connectorUserName } from './connectorUserName.js';

// ConnectorMessage → client-shape (camelCase). Перевод в B24 wire-форму
// (snake_case, picture → {url}, без chat.type) делает b24Client.toB24MessageShape.
// chat.name не шлём: imopenlines его не читает (M24) — название чата ставит setChatName.
// user.name — через connectorUserName (M23): Б24 переписывает имя пользователя
// коннектора на каждом вызове, поэтому оно всегда непустое и в рамках NAME.
function toClientShape(message) {
  const shape = {
    chat: { id: message.connectorChatId },
    user: {
      id: message.author.id,
      name: connectorUserName(message.author),
      lastName: message.author.lastName ?? '',
    },
    message: { id: message.externalMessageId, text: message.text, date: message.date },
  };
  if (message.author.picture != null) shape.user.picture = message.author.picture;
  return shape;
}

// M27: id текущей сессии из entity_data_1 чата OL (imopenlines.dialog.get) — поле 6
// LINES_SESSION: CRM|CRM_ENTITY_TYPE|CRM_ENTITY_ID|PAUSE|WAIT_ACTION|SESSION_ID|DATE_CREATE|…
// При старте сессии Б24 пишет туда её id, при закрытии — '0' (live 2026-10-08: у открытой
// id сессии, у закрытой 0). → 0 (закрыта) | id > 0 (открыта) | null (поля нет, мусор).
export function parseLinesSessionId(entityData1) {
  if (typeof entityData1 !== 'string') return null;
  const raw = entityData1.split('|')[5];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const sessionId = Number(raw);
  return Number.isSafeInteger(sessionId) ? sessionId : null;
}

// Ответ imconnector.send/update/delete.messages: {SUCCESS, DATA:{RESULT:[...]}}.
// Первый элемент RESULT без SUCCESS → B24ApiError(code). Возвращает этот элемент.
function assertFirstResultOk(raw, method, code) {
  const item = raw?.DATA?.RESULT?.[0];
  if (!item?.SUCCESS) {
    throw new B24ApiError(code, `${method} returned SUCCESS=false`, {
      method,
      body: item?.ERRORS ?? raw,
    });
  }
  return item;
}

// search может вернуть messages как массив (doc) — на всякий случай терпим и keyed-объект
// (Object.values), чтобы редкая форма ответа не уронила резолв reply.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

// Ответ imconnector.chat.name.set / send.status.delivery: {SUCCESS, DATA}. SUCCESS не true →
// B24ApiError(code) с сырым ответом.
function assertSuccess(raw, method, code) {
  if (raw?.SUCCESS !== true) {
    throw new B24ApiError(code, `${method} returned SUCCESS=false`, { method, body: raw });
  }
  return raw;
}

export class B24Service {
  constructor({ b24Client, installationsService, messagingService = null, logger } = {}) {
    if (!b24Client) throw new TypeError('B24Service: b24Client required');
    if (!installationsService) throw new TypeError('B24Service: installationsService required');
    this.client = b24Client;
    this.installations = installationsService;
    this.messaging = messagingService;
    this.logger = logger?.child ? logger.child({ component: 'b24Service' }) : logger;
  }

  setMessagingService(messagingService) {
    this.messaging = messagingService;
  }

  _requireMessaging() {
    if (!this.messaging) {
      throw new Error('B24Service.messagingService not wired — check app.js composition');
    }
    return this.messaging;
  }

  // connectorId/lineId — из installations (никогда не хардкодим).
  // Нет любого из них → ConfigError с именем операции (коннектор не зарегистрирован).
  // M21: known — installation, уже прочитанная координатором; она же уходит в клиент,
  // чтобы callMethod не читал её ещё раз.
  async _connectorContext(op, known = null) {
    const installation = known ?? await this.installations.getCurrent();
    const connectorId = installation.connectorId;
    const lineId = installation.olLineId;
    if (!connectorId || !lineId) {
      throw new ConfigError(
        `B24Service.${op}: installation has no connectorId/olLineId — run register-connector first`,
        { connectorId: connectorId ?? null, olLineId: lineId ?? null },
      );
    }
    return { connectorId, lineId, installation };
  }

  // Inbound MAX → Open Lines. message — ConnectorMessage DTO (M4.1 Verified schema).
  // connectorId/lineId берём из installations (никогда не хардкодим).
  // Знание формы ответа B24 живёт здесь: routeInbound получает уже разобранный
  // {b24MsgId, sessionId, b24ChatId, raw} и не парсит сырой ответ.
  // installation (M21) — опционально: координатор передаёт прочитанную при резолве привязки.
  async sendConnectorMessage(message, { installation: known = null } = {}) {
    const { connectorId, lineId, installation } = await this._connectorContext('sendConnectorMessage', known);
    this.logger?.debug(
      { connectorChatId: message.connectorChatId, connectorId, lineId },
      'b24.sendConnectorMessage: installation loaded',
    );

    const shape = toClientShape(message);
    // M11.2: медиа inbound — Б24 качает файлы сам по message.files[].url. text
    // остаётся опциональным, если есть файлы. Клиент сериализует as-is.
    const files = Array.isArray(message.files) ? message.files : [];
    if (files.length > 0) {
      shape.message.files = files.map((f) => ({ url: f.url, name: f.name }));
      this.logger?.debug(
        {
          connectorChatId: message.connectorChatId,
          filesCount: files.length,
          hosts: files.map((f) => urlHost(f.url)),
        },
        'b24.sendConnectorMessage: outgoing files',
      );
    }

    // callMethod разворачивает .result → raw = {SUCCESS, DATA:{RESULT:[...]}}.
    const raw = await this.client.imconnectorSendMessages({
      connectorId,
      lineId,
      messages: [shape],
      installation,
    });

    const item = assertFirstResultOk(raw, 'imconnector.send.messages', 'CONNECTOR_SEND_FAILED');

    const result = {
      // Response НЕ возвращает id созданного B24-сообщения (Verified schema, расхождение 5),
      // поэтому b24MsgId = тот externalMessageId, что мы сами сгенерили.
      b24MsgId: message.externalMessageId,
      sessionId: item?.session?.ID ?? null,
      b24ChatId: item?.session?.CHAT_ID ?? null,
      raw,
    };
    this.logger?.info(
      {
        b24MsgId: result.b24MsgId,
        sessionId: result.sessionId,
        b24ChatId: result.b24ChatId,
        connectorChatId: message.connectorChatId,
      },
      'b24.sendConnectorMessage: ok',
    );
    return result;
  }

  // INBOUND-правка MAX → Open Lines. message — тот же ConnectorMessage-shape, что и
  // в sendConnectorMessage, но externalMessageId указывает на УЖЕ доставленное
  // сообщение ('max:mid:<mid>'), а text несёт обновлённый контент + маркер «Изменено»
  // (собирает координатор routeInboundEdit). Вызывает imconnector.update.messages
  // (application-context, НЕ batch — шлём по одному). Возвращает { success, raw }.
  async updateConnectorMessage(message, { installation: known = null } = {}) {
    const { connectorId, lineId, installation } = await this._connectorContext('updateConnectorMessage', known);
    this.logger?.info(
      {
        method: 'imconnector.update.messages',
        externalId: message.externalMessageId,
        connectorChatId: message.connectorChatId,
        connectorId,
        lineId,
      },
      'b24.updateConnectorMessage: start',
    );
    const shape = toClientShape(message);

    // B24Client маппит ошибку в B24ApiError (WRONG_AUTH_TYPE, NOT_ACTIVE_LINE,
    // IMCONNECTOR_NO_CORRECT_PROVIDER) — пробрасываем как есть, ERROR-лог пишет координатор.
    const raw = await this.client.imconnectorUpdateMessages({
      connectorId,
      lineId,
      messages: [shape],
      installation,
    });

    assertFirstResultOk(raw, 'imconnector.update.messages', 'CONNECTOR_UPDATE_FAILED');

    this.logger?.info(
      { method: 'imconnector.update.messages', externalId: message.externalMessageId, success: true },
      'b24.updateConnectorMessage: ok',
    );
    return { success: true, raw };
  }

  // INBOUND-удаление MAX → Open Lines. message — минимальный shape:
  //   { author:{id, name?}, externalMessageId:'max:mid:<mid>', connectorChatId }.
  // externalMessageId указывает на УЖЕ доставленное сообщение, author — автор
  // оригинала (резолвит координатор routeInboundDelete). M23: user.name обязателен —
  // Б24 переписывает имя пользователя коннектора и на delete, без имени автор
  // становится «Гостем» (live P4 2026-10-07); name=null → fallback connectorUserName. Вызывает
  // imconnector.delete.messages (application-context, НЕ batch — шлём по одному).
  // Возвращает { success, raw }. Ошибка/SUCCESS=false → бросок (координатор пробросит → 500 → ретрай MAX).
  async deleteConnectorMessage(message, { installation: known = null } = {}) {
    const { connectorId, lineId, installation } = await this._connectorContext('deleteConnectorMessage', known);
    this.logger?.info(
      {
        method: 'imconnector.delete.messages',
        externalId: message.externalMessageId,
        connectorChatId: message.connectorChatId,
        connectorId,
        lineId,
      },
      'b24.deleteConnectorMessage: start',
    );

    // B24Client маппит ошибку в B24ApiError (WRONG_AUTH_TYPE, NOT_ACTIVE_LINE) —
    // пробрасываем как есть, ERROR-лог пишет координатор.
    const raw = await this.client.imconnectorDeleteMessages({
      connectorId,
      lineId,
      messages: [
        {
          user: { id: message.author.id, name: connectorUserName(message.author), lastName: '' },
          message: { id: message.externalMessageId },
          chat: { id: message.connectorChatId },
        },
      ],
      installation,
    });

    assertFirstResultOk(raw, 'imconnector.delete.messages', 'CONNECTOR_DELETE_FAILED');

    this.logger?.info(
      { method: 'imconnector.delete.messages', externalId: message.externalMessageId, success: true },
      'b24.deleteConnectorMessage: ok',
    );
    return { success: true, raw };
  }

  // M24: точное название чата OL (Б24 ставит при создании «<клиент> - <линия>»).
  // imconnector.chat.name.set работает только при открытой сессии: на закрытой Б24
  // отвечает 400 CHAT_RENAMING_FAILED — B24ApiError с этим b24Code пробрасываем,
  // решение (отложить до следующего входящего) принимает координатор. M27: на то же имя
  // (и с хвостовым пробелом) при открытой сессии Б24 тоже отвечает CHAT_RENAMING_FAILED
  // (live 2026-10-08) — координатор различает случаи через getOlChat.
  async setChatName({ connectorChatId, name }) {
    const { connectorId, lineId, installation } = await this._connectorContext('setChatName');
    const raw = await this.client.imconnectorChatNameSet({
      connectorId,
      lineId,
      chatId: connectorChatId,
      name,
      installation,
    });
    assertSuccess(raw, 'imconnector.chat.name.set', 'CHAT_RENAME_FAILED');
    this.logger?.info({ connectorChatId, nameLen: name.length }, 'b24.setChatName: ok');
    return { success: true };
  }

  // M-lifecycle: системное уведомление в OL-чат (вступление/выход участника группы).
  // Фасад над im.message.add: формирует DIALOG_ID='chat'+<b24ChatId> и шлёт SYSTEM='Y'.
  // Ошибки НЕ заворачиваем повторно — imMessageAdd уже бросает B24ApiError (маппинг в
  // callMethod) и ValidationError (на пустые входы), как sendConnectorMessage пробрасывает
  // B24ApiError. У im.message.add нет SUCCESS-конверта (метод возвращает result напрямую),
  // поэтому бизнес-проверки SUCCESS=false тут нет. Best-effort-отлов — у вызывающего
  // (routeLifecycle, notifyOperator). M28: installation — уже прочитанная вызывающим (снимок
  // из резолва привязки исходящего маршрута), чтобы не читать БД ещё раз; без неё
  // imMessageAdd читает БД сам.
  async sendSystemMessage({ b24ChatId, text }, { installation = null } = {}) {
    if (!b24ChatId) {
      throw new ValidationError('B24Service.sendSystemMessage: b24ChatId required');
    }
    if (!text || typeof text !== 'string') {
      throw new ValidationError('B24Service.sendSystemMessage: text required (non-empty)');
    }
    const dialogId = `chat${b24ChatId}`;
    this.logger?.debug({ b24ChatId, dialogId }, 'b24.sendSystemMessage: start');
    const msgId = await this.client.imMessageAdd({
      dialogId,
      message: text,
      system: true,
      ...(installation ? { installation } : {}),
    });
    this.logger?.info(
      { dialogId, b24MsgId: msgId },
      'b24.sendSystemMessage: system message delivered',
    );
    return { b24MsgId: msgId, dialogId };
  }

  // M-lifecycle: резолвинг адреса OL-чата (CHAT_ID) по connectorChatId — БЕЗ отправки
  // сообщения и БЕЗ открытия сессии (imopenlines.dialog.get по USER_CODE). Нужен,
  // чтобы lifecycle-уведомления работали, не дожидаясь, пока b24_chat_id заполнится
  // побочно на первом inbound (а также для backfill уже существующих групп).
  // connectorId/lineId — из installations (единый источник истины, как в остальных
  // методах). USER_CODE: `<connectorId>|<lineId>|<connectorChatId>|0` (groupChat → 0).
  // Возвращает строковый CHAT_ID или null: чата ещё нет (нет сессии → ACCESS_ERROR)
  // либо вызов Б24 не удался (best-effort). Сбой чтения установки (БД) и установка без
  // connectorId/olLineId (ConfigError) — бросает: оба вызывающих ловят сами (интро → без
  // интро, а не лишнее интро в существующий чат; lifecycle → _routeLifecycleSafe).
  async resolveB24ChatId({ connectorChatId }) {
    if (!connectorChatId || typeof connectorChatId !== 'string') return null;
    const { connectorId, lineId } = await this._connectorContext('resolveB24ChatId');
    const userCode = `${connectorId}|${lineId}|${connectorChatId}|0`;
    return this._bestEffort('resolveB24ChatId', { connectorChatId }, async () => {
      const chat = await this.client.imDialogGet({ userCode });
      const chatId = chat?.id != null ? String(chat.id) : null;
      this.logger?.debug({ connectorChatId, chatId }, 'b24.resolveB24ChatId: ok');
      return chatId;
    });
  }

  // M27: состояние известного чата OL (imopenlines.dialog.get по CHAT_ID) — имя чата и
  // id текущей сессии из entity_data_1 (parseLinesSessionId: 0 — сессия закрыта, > 0 —
  // открыта, null — не разобрать). Нужен координатору на ответ CHAT_RENAMING_FAILED:
  // закрытая сессия или то же имя. → { b24ChatId, name, sessionId } либо null (b24ChatId
  // пуст или вызов не удался). Best-effort — НЕ бросает. Имя чата не логируем (название
  // клиента) — только длину.
  async getOlChat({ b24ChatId } = {}) {
    if (b24ChatId === null || b24ChatId === undefined || b24ChatId === '') return null;
    return this._bestEffort('getOlChat', { b24ChatId: String(b24ChatId) }, async () => {
      const chat = await this.client.imDialogGet({ chatId: b24ChatId });
      const name = typeof chat?.name === 'string' ? chat.name : null;
      const sessionId = parseLinesSessionId(chat?.entity_data_1);
      this.logger?.info(
        { b24ChatId: String(b24ChatId), nameLen: name?.length ?? null, sessionId },
        'b24.getOlChat: ok',
      );
      return { b24ChatId: String(b24ChatId), name, sessionId };
    });
  }

  // Reply/цитирование (OL→MAX): добыть сырой REPLY_ID + CONNECTOR_MID родителя для
  // исходящего сообщения Y. Best-effort — НИКОГДА не бросает (возвращает null при любой
  // ошибке/отсутствии): reply — косметика, мост важнее. `limit` приходит АРГУМЕНТОМ от
  // координатора (владельца config.reply.searchLimit), а НЕ из env внутри сервиса —
  // B24Service не получает config, чтение env здесь нарушило бы чистую границу.
  //   1) листинг последних сообщений чата (im.dialog.messages.search, ORDER DESC).
  //   2) найти Y: String(id) === String(b24MsgId) (событие даёт строку, search — число).
  //   3) replyId = params.REPLY_ID цели; нет → null (обычное сообщение, не reply).
  //   4) найти родителя P (id === replyId) среди messages ∪ additionalMessages,
  //      прочитать params.CONNECTOR_MID (массив → берём [0]).
  // Возвращает { replyId, parentConnectorMid, forward } либо null.
  // M28: installation — уже прочитанная координатором (снимок из резолва привязки
  // исходящего маршрута), уходит в клиент, чтобы не читать БД ещё раз.
  async resolveReplyContext({ b24ChatId, b24MsgId, limit = 50, installation = null }) {
    if (!b24ChatId || b24MsgId === undefined || b24MsgId === null || b24MsgId === '') {
      return null;
    }
    return this._bestEffort('resolveReplyContext', { b24ChatId, b24MsgId }, async () => {
      const result = await this.client.imDialogMessagesSearch({
        chatId: b24ChatId,
        limit,
        ...(installation ? { installation } : {}),
      });
      const messages = asArray(result?.messages);
      const additional = asArray(result?.additionalMessages);

      const target = messages.find((m) => String(m?.id) === String(b24MsgId));
      if (!target) {
        this.logger?.debug(
          { b24ChatId, b24MsgId, replyId: null, hasParentInPayload: false, connectorMidPresent: false },
          'b24.resolveReplyContext: target Y not in search window',
        );
        return null;
      }

      const replyId = target?.params?.REPLY_ID ?? null;
      if (replyId === null || replyId === undefined || replyId === '') {
        this.logger?.debug(
          { b24ChatId, b24MsgId, replyId: null, hasParentInPayload: false, connectorMidPresent: false },
          'b24.resolveReplyContext: not a reply (no REPLY_ID)',
        );
        return null;
      }

      const parent = messages
        .concat(additional)
        .find((m) => String(m?.id) === String(replyId));
      const rawConnectorMid = parent?.params?.CONNECTOR_MID;
      const parentConnectorMid = Array.isArray(rawConnectorMid)
        ? (rawConnectorMid[0] ?? null)
        : (rawConnectorMid ?? null);
      const fwd = target?.forward;
      const forward = Boolean(
        fwd && (typeof fwd === 'object' ? Object.keys(fwd).length > 0 : fwd),
      );

      this.logger?.debug(
        {
          b24ChatId,
          b24MsgId,
          replyId,
          hasParentInPayload: Boolean(parent),
          connectorMidPresent: Boolean(parentConnectorMid),
        },
        'b24.resolveReplyContext: resolved',
      );
      return { replyId, parentConnectorMid, forward };
    });
  }

  // Best-effort шаг: любая ошибка → WARN «b24.<op>: failed (best-effort, returning null)» и null.
  async _bestEffort(op, fields, fn) {
    try {
      return await fn();
    } catch (err) {
      this.logger?.warn(
        { ...fields, b24Code: err?.b24Code ?? null, err: { message: err?.message } },
        `b24.${op}: failed (best-effort, returning null)`,
      );
      return null;
    }
  }

  // Outbound delivery receipt. b24ChatId/b24MsgId — из event (im.chat_id/im.message_id).
  // externalIds — массив внешних id (= [maxMid]). connectorChatId — «max:<chatId>».
  // connectorId/lineId — из installations (единый источник истины, зеркало sendConnectorMessage).
  // Ответ B24: {SUCCESS: bool, DATA: [], time} (не DATA.RESULT[] — Verified schema M5.3).
  // M28: installation — уже прочитанная координатором (снимок из резолва привязки), без
  // неё читается из БД.
  async sendDeliveryStatus({ b24ChatId, b24MsgId, externalIds, date, connectorChatId, installation: known = null }) {
    const { connectorId, lineId, installation } = await this._connectorContext('sendDeliveryStatus', known);
    this.logger?.debug(
      { b24MsgId, connectorChatId, connectorId, lineId },
      'b24.sendDeliveryStatus: calling imconnector.send.status.delivery',
    );
    const raw = await this.client.imconnectorSendStatusDelivery({
      connectorId,
      lineId,
      statuses: [
        {
          imChatId: b24ChatId,
          imMessageId: b24MsgId,
          externalIds,
          date,
          chatId: connectorChatId,
        },
      ],
      installation,
    });
    assertSuccess(raw, 'imconnector.send.status.delivery', 'DELIVERY_STATUS_FAILED');
    this.logger?.info(
      { b24MsgId, connectorChatId },
      'b24.sendDeliveryStatus: ok',
    );
    return raw;
  }

  // OUTBOUND-отправка OL → MAX (OnImConnectorMessageAdd; прочие события координатор отсеет
  // как ignored-event). M29: отправка, правка и удаление идут через очередь чата
  // координатора (routeOutboundQueued): исходящие одного чата не обгоняют друг друга,
  // промис — после доставки.
  async handleOpenLineMessageAdd(event, { logger } = {}) {
    const messaging = this._requireMessaging();
    // Фикс: логируем фактический код события (раньше был хардкод 'OnImConnectorMessageAdd'
    // для любого события — ложный лог при update).
    this.logger?.info({ event: event.event, lineId: event.lineId }, 'b24 open line message add');
    return messaging.routeOutboundQueued('add', event, { logger });
  }

  // OUTBOUND-правка OL → MAX (OnImConnectorMessageUpdate). Фасад над координатором —
  // адаптер b24/ не зовёт max/ напрямую (направление зависимостей). Правка best-effort
  // внутри (петель нет: эхо-защита B24 не триггерит на правки из внешнего канала); M29 —
  // через очередь чата, после отправки того же чата.
  async handleOpenLineMessageEdit(event, { logger } = {}) {
    const messaging = this._requireMessaging();
    this.logger?.info({ event: event.event, lineId: event.lineId }, 'b24 open line message edit');
    return messaging.routeOutboundQueued('edit', event, { logger });
  }

  // OUTBOUND-удаление OL → MAX (OnImConnectorMessageDelete). Фасад над координатором —
  // адаптер b24/ не зовёт max/ напрямую (направление зависимостей). Удаление best-effort
  // внутри (петель нет: эхо-защита B24 не триггерит delete на удаление из внешнего канала);
  // M29 — через очередь чата: удаление во время заливки файла ждёт её и находит maxMid.
  async handleOpenLineMessageDelete(event, { logger } = {}) {
    const messaging = this._requireMessaging();
    this.logger?.info({ event: event.event, lineId: event.lineId }, 'b24 open line message delete');
    return messaging.routeOutboundQueued('delete', event, { logger });
  }

  // M25: закрытие диалога OL (OnImConnectorDialogFinish) → координатор взводит опенер
  // «группы» для следующей сессии. Подписаться на событие может любой пользователь, а
  // на портале есть чужие каналы: событие не нашего коннектора отсекаем здесь — знание
  // о коннекторе живёт в адаптере.
  async handleOpenLineDialogFinish(event, { logger } = {}) {
    const messaging = this._requireMessaging();
    const installation = await this.installations.getCurrent();
    this.logger?.info(
      { event: event.event, lineId: event.lineId, connector: event.connectorId },
      'b24 open line dialog finish',
    );
    if (installation.connectorId && event.connectorId && event.connectorId !== installation.connectorId) {
      (logger ?? this.logger)?.info(
        { connector: event.connectorId },
        'routeDialogFinish: foreign connector, skipping',
      );
      return { skipped: 'foreign-connector' };
    }
    return messaging.routeDialogFinish(event, { logger });
  }

  // M26: удаление приложения Б24 (ONAPPUNINSTALL; токен и member_id сверил контроллер).
  // Токены портала сбрасывает installations (Б24-сторона, связь уже есть) — всегда.
  // Данные моста при CLEAN=1 чистит координатор (владелец журнала), как routeDialogFinish
  // (M25): messaging.purgeBridgeData → bindings.purgeAll. В message_log не пишется:
  // внешнего эффекта нет, повтор идемпотентен (а до него сюда и не дойдёт: гейт
  // uninstalled_at в контроллере). Вызвать API Б24 отсюда нельзя — права уже сняты.
  async handleAppUninstall(event, { logger } = {}) {
    const log = logger ?? this.logger;
    const clean = event.cleanRequested;
    log?.info(
      { event: event.event, clean, languageId: event.data?.LANGUAGE_ID ?? null },
      'b24 app uninstall received',
    );
    // Проводку проверяем ДО сброса токенов: иначе токены сброшены, а очистка не начата.
    const messaging = clean ? this._requireMessaging() : null;
    // Токен события — для CAS: переустановка, успевшая между проверкой токена в контроллере
    // и записью, не стирается событием старого приложения (stale → без очистки).
    const marked = await this.installations.markUninstalled({ applicationToken: event.applicationToken });
    if (!marked) return { skipped: 'no-installation' };
    if (marked.stale) return { skipped: 'stale-uninstall', installationId: marked.installationId };
    const installationId = marked.installation.id;
    if (!clean) {
      log?.info({ installationId }, 'app uninstalled: CLEAN=0, bridge data kept');
      return { ok: true, clean: false, installationId };
    }
    try {
      const purged = await messaging.purgeBridgeData(installationId, { logger: log });
      return { ok: true, clean: true, installationId, purged };
    } catch (err) {
      // Б24 событие не повторит, а токены уже сброшены — лечится SQL из runbook.
      log?.error(
        { installationId, err: { message: err?.message, code: err?.code ?? null } },
        'app uninstall: tokens cleared, bridge data NOT purged — see app-installation.md',
      );
      throw err;
    }
  }

  // M11.2: публичный фасад скачивания файла оператора (OL → MAX). Владелец
  // B24-HTTP — модуль b24/, поэтому download живёт в b24Client, а сервис — фасад.
  // downloadLink скачивается анонимно. M22: потоком в destPath (временный файл
  // координатора) с лимитом maxBytes и дедлайном timeoutMs. Возвращает { size, contentType }.
  async downloadOperatorFile(downloadLink, { destPath, maxBytes, timeoutMs } = {}) {
    return this.client.downloadFile(downloadLink, { destPath, maxBytes, timeoutMs });
  }

  // M2: регистрация коннектора. Идемпотентна — imconnector.list проверяет,
  // не зарегистрирован ли уже connectorId.
  // M10: forceReregister — повторно вызвать imconnector.register для УЖЕ
  // зарегистрированного коннектора (upsert имени/иконки на проде). Без флага —
  // прежнее поведение (skip + warn), чтобы случайный повторный запуск не трогал
  // активный коннектор и его сессии. iconDisabled — иконка неактивной плитки (M10).
  async registerConnector({
    connectorId,
    lineId,
    name,
    icon,
    iconDisabled,
    placementHandlerUrl,
    forceReregister = false,
  }) {
    this.logger?.info(
      { connectorId, lineId, hasIconDisabled: Boolean(iconDisabled), forceReregister },
      'b24.registerConnector: start',
    );

    const existing = await this.client.imconnectorList();
    const existingKeys =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? Object.keys(existing)
        : [];
    const wasAlreadyRegistered = existingKeys.includes(connectorId);

    if (wasAlreadyRegistered && !forceReregister) {
      this.logger?.warn(
        { connectorId, existingName: existing[connectorId], mode: 'skip' },
        'b24.registerConnector: already registered, skipping imconnector.register',
      );
    } else {
      await this.client.imconnectorRegister({
        connectorId,
        name,
        icon,
        iconDisabled,
        placementHandlerUrl,
        chatGroup: true,
        needSignature: true,
      });
      this.logger?.info(
        {
          connectorId,
          mode: wasAlreadyRegistered ? 'update' : 'register',
          hasIconDisabled: Boolean(iconDisabled),
        },
        wasAlreadyRegistered
          ? 'b24.registerConnector: re-registered (force update of name/icon)'
          : 'b24.registerConnector: registered',
      );
    }

    const activateResult = await this.client.imconnectorActivate({
      connectorId,
      lineId,
      active: true,
    });
    this.logger?.info(
      { connectorId, lineId, activateResult },
      'b24.registerConnector: activated',
    );

    return { connectorId, lineId, activated: true, wasAlreadyRegistered };
  }

  // M2: откат. Обе операции в try/catch — допускаем «не было активации/регистрации»
  // (актуально, если скрипт упал после register и теперь чистим вручную).
  async unregisterConnector({ connectorId, lineId }) {
    this.logger?.info({ connectorId, lineId }, 'b24.unregisterConnector: start');

    try {
      await this.client.imconnectorDeactivate({ connectorId, lineId });
    } catch (err) {
      this.logger?.warn(
        { connectorId, lineId, b24Code: err?.b24Code, err: { message: err?.message } },
        'b24.unregisterConnector: deactivate failed, continuing',
      );
    }

    try {
      await this.client.imconnectorUnregister({ connectorId });
    } catch (err) {
      this.logger?.warn(
        { connectorId, b24Code: err?.b24Code, err: { message: err?.message } },
        'b24.unregisterConnector: unregister failed (likely connector was not registered), continuing',
      );
    }

    this.logger?.info({ connectorId }, 'b24.unregisterConnector: done');
    return { connectorId, unregistered: true };
  }
}
