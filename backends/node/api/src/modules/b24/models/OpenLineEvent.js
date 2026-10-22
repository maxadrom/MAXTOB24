// DTO событий Б24 на POST /webhook/b24: OnImConnectorMessageAdd/Update/Delete,
// OnImConnectorDialogFinish (M25) и ONAPPUNINSTALL (M26).
// M5.2: починены пути data.LINE / data.MESSAGES (M5.1 снял реальный payload);
// добавлены connectorId, isMessageAdd(), normalizedMessages().

export const OPENLINE_MESSAGE_ADD_EVENT = 'ONIMCONNECTORMESSAGEADD';
// Правка сообщения оператором OL → MAX. Б24 шлёт коды событий в ВЕРХНЕМ регистре.
export const OPENLINE_MESSAGE_UPDATE_EVENT = 'ONIMCONNECTORMESSAGEUPDATE';
// Удаление сообщения оператором OL → MAX (OnImConnectorMessageDelete). ВЕРХНИЙ регистр.
export const OPENLINE_MESSAGE_DELETE_EVENT = 'ONIMCONNECTORMESSAGEDELETE';
// M25: закрытие диалога (сессии) OL (OnImConnectorDialogFinish). ВЕРХНИЙ регистр.
export const OPENLINE_DIALOG_FINISH_EVENT = 'ONIMCONNECTORDIALOGFINISH';
// M26: удаление приложения (ONAPPUNINSTALL). Подписка — через event.bind (register-events).
export const APP_UNINSTALL_EVENT = 'ONAPPUNINSTALL';

// M25: id сессии — положительное целое. form-urlencoded приносит строки, JSON — числа.
function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Непустая строка либо null (id чатов приходят строкой или числом).
function toIdString(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

// M11.2: нормализация message.files[] оператора (OnImConnectorMessageAdd).
// Формат (сверен с докой события): files:[{ name, type, mime, link, downloadLink, size, sizef }].
// downloadLink скачивается анонимно. Реальный тип — в mime.
// Отбрасываем записи без скачиваемой ссылки (нечего тянуть).
// M28: у картинки Б24 присылает width/height (px; form-urlencoded — строками) — по ним
// картинка больше лимита стороны MAX уходит сразу файлом. Нет или мусор → null.
function normalizeOperatorFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles
    .filter((f) => f && (f.downloadLink || f.link))
    .map((f) => ({
      name: f.name ?? null,
      mime: f.mime ?? null,
      type: f.type ?? null,
      downloadLink: f.downloadLink ?? f.link ?? null,
      size: f.size ?? null,
      width: toPositiveInt(f.width),
      height: toPositiveInt(f.height),
    }));
}

export class OpenLineEvent {
  constructor({ event, auth = null, data = null }) {
    if (!event) throw new TypeError('OpenLineEvent: event required');
    this.event = event;
    this.auth = auth;
    this.data = data;
  }

  get applicationToken() {
    return this.auth?.application_token ?? null;
  }

  // M19: идентификатор портала Б24 (обязателен в auth любого события по доке). Только
  // строка: дубли ключа в form-urlencoded превращаются в массив — такой не принимаем.
  get memberId() {
    const value = this.auth?.member_id;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  // M5.2: data.LINE (не data.CONNECTOR.LINE — баг, подтверждён M5.1)
  get lineId() {
    return this.data?.LINE ?? null;
  }

  // M5.2: data.MESSAGES[] (не data.CONNECTOR.MESSAGES); возвращаем массив, не null
  get messages() {
    return Array.isArray(this.data?.MESSAGES) ? this.data.MESSAGES : [];
  }

  // M5.2: data.CONNECTOR — строка id коннектора (напр. "max_b24")
  get connectorId() {
    return this.data?.CONNECTOR ?? null;
  }

  // M5.2: case-insensitive — Б24 шлёт ВЕРХНИЙ регистр (M5.1)
  isMessageAdd() {
    return String(this.event).toUpperCase() === OPENLINE_MESSAGE_ADD_EVENT;
  }

  // Правка сообщения оператором (OnImConnectorMessageUpdate). case-insensitive.
  isMessageUpdate() {
    return String(this.event).toUpperCase() === OPENLINE_MESSAGE_UPDATE_EVENT;
  }

  // Удаление сообщения оператором (OnImConnectorMessageDelete). case-insensitive.
  isMessageDelete() {
    return String(this.event).toUpperCase() === OPENLINE_MESSAGE_DELETE_EVENT;
  }

  // M25: закрытие диалога OL (OnImConnectorDialogFinish). case-insensitive.
  isDialogFinish() {
    return String(this.event).toUpperCase() === OPENLINE_DIALOG_FINISH_EVENT;
  }

  // M26: удаление приложения (ONAPPUNINSTALL). case-insensitive.
  isAppUninstall() {
    return String(this.event).toUpperCase() === APP_UNINSTALL_EVENT;
  }

  // M26: data.CLEAN события ONAPPUNINSTALL — «Очистить данные приложения». По доке
  // integer 1|0, в примере строка "1": принимаем оба. Не скаляр (дубли ключа в
  // form-urlencoded → массив) — не очистка: данные удаляются только по явному 1.
  // У локального приложения Б24 очистка включена всегда.
  get cleanRequested() {
    const value = this.data?.CLEAN;
    return typeof value !== 'object' && String(value ?? '') === '1';
  }

  // M25: data.DATA[] события диалога. form-urlencoded может превратить массив в объект
  // с ключами 0,1,… — терпим и его (Object.values).
  get dialogs() {
    const raw = this.data?.DATA;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
  }

  // M25: плоские объекты для routeDialogFinish. По доке (b24-dev-mcp, 2026-10-07):
  // DATA[].{connector{connector_id,line_id,chat_id,user_id}, session{id,closed,parent_id,
  // close_term}, chat{id}, user{id}}. Live (прод, 2026-10-08): connector.chat_id и chat.id
  // ОБА — внешний id чата коннектора ('max:<chatId>'), не id чата Б24; chat.id — запасной
  // источник того же значения.
  normalizedDialogs() {
    return this.dialogs.map((d) => ({
      connectorId: d?.connector?.connector_id ?? this.connectorId,
      lineId: toIdString(d?.connector?.line_id ?? this.lineId),
      connectorChatId: toIdString(d?.connector?.chat_id ?? d?.chat?.id),
      sessionId: toPositiveInt(d?.session?.id),
      parentSessionId: toPositiveInt(d?.session?.parent_id),
      closed: d?.session?.closed ?? null,
    }));
  }

  // M5.2: нормализует массив messages[] в плоские объекты для routeOutbound.
  // M11.2: + files[] оператора ({ name, mime, type, downloadLink, size }).
  // Правка (OnImConnectorMessageUpdate): + externalIds (message.id[] = внешние id,
  // напр. maxMid) и editTs (m.message.date).
  // ⚠️ editTs по доке OnImConnectorMessageUpdate НИКОГДА не приходит: поля message.date
  // в спеке события НЕТ вообще (сверено docs MCP 2026-06-17), поэтому editTs тут всегда
  // null. Идемпотентность OUTBOUND-правки НЕ строится на нём — она на контент-токене
  // хеша текста (см. _routeOutboundEditOne, шаг 4). editTs остаётся лишь best-effort
  // входом для delivery-status `date` (где он всегда падает в fallback). Поле editTs
  // в результате СОХРАНЯЕМ для backward-compat сигнатуры — не удалять.
  // ⚠️ Удаление (OnImConnectorMessageDelete): в delete-payload message.id приходит
  // СТРОКОЙ (внешний id, напр. "max:mid:<mid>"), а не массивом, как в update. Поэтому
  // нормализуем оба варианта: массив → как есть; скаляр → [String(id)]; пусто → [].
  // Backward-compatible (update по-прежнему отдаёт массив).
  normalizedMessages() {
    return this.messages.map((m) => {
      const rawId = m?.message?.id;
      const externalIds = Array.isArray(rawId)
        ? rawId
        : (rawId != null ? [String(rawId)] : []);
      return {
        connectorChatId: m?.chat?.id ?? null,
        b24MsgId: m?.im?.message_id ?? null,
        b24ChatId: m?.im?.chat_id ?? null,
        userId: m?.message?.user_id ?? null,
        text: m?.message?.text ?? '',
        externalIds,
        editTs: m?.message?.date ?? null,
        files: normalizeOperatorFiles(m?.message?.files),
      };
    });
  }

  static fromWebhookBody(body) {
    if (!body || typeof body !== 'object') {
      throw new TypeError('OpenLineEvent.fromWebhookBody: body must be object');
    }
    if (!body.event) {
      throw new TypeError('OpenLineEvent.fromWebhookBody: event required');
    }
    return new OpenLineEvent({
      event: body.event,
      auth: body.auth ?? null,
      data: body.data ?? null,
    });
  }
}
