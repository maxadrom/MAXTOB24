// Rich domain model привязки MAX-чата к коннектор-чату OL.
// isReadyForRouting: готовность определяется наличием connector_chat_id.
// needsOlTitleSync (M24): название группы в MAX ещё не поставлено в чат OL.
// needsSessionOpener (M25): сессия OL закрыта — следующее входящее открывает «группа».

import { ValidationError } from '../../../shared/http/domainErrors.js';

export class ChatBinding {
  constructor({
    id = null,
    installationId,
    maxChatId,
    maxChatTitle = null,
    connectorChatId = null,
    b24ChatId = null,
    olChatTitle = null,
    olSessionId = null,
    olClosedSessionId = null,
    createdAt = null,
    updatedAt = null,
  }) {
    if (!installationId) throw new ValidationError('ChatBinding: installationId required');
    if (!maxChatId) throw new ValidationError('ChatBinding: maxChatId required');
    this.id = id;
    this.installationId = installationId;
    this.maxChatId = maxChatId;
    this.maxChatTitle = maxChatTitle;
    this.connectorChatId = connectorChatId;
    // M-lifecycle: адрес чата Open Lines (CHAT_GROUP session.CHAT_ID) для системных
    // уведомлений im.message.add. Заполняется best-effort на inbound (миграция 0007).
    this.b24ChatId = b24ChatId;
    // M24: название, которое мы последним поставили в чат OL (imconnector.chat.name.set).
    this.olChatTitle = olChatTitle;
    // M25: последняя известная сессия OL и сессия, закрытая по OnImConnectorDialogFinish
    // (миграция 0011). Числа (integer) либо null.
    this.olSessionId = olSessionId;
    this.olClosedSessionId = olClosedSessionId;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  isReadyForRouting() {
    return Boolean(this.connectorChatId);
  }

  // M24: название MAX-группы известно и отличается от поставленного в чат OL.
  // chat.name.set работает только при открытой сессии — до успеха название ждёт.
  needsOlTitleSync() {
    return Boolean(this.maxChatTitle) && this.maxChatTitle !== this.olChatTitle;
  }

  // M25: сессия OL закрыта — перед следующим входящим нужен опенер от «группы».
  // M27: 0 — тоже флаг: сессия закрыта, но её номер неизвестен (CHAT_RENAMING_FAILED у
  // привязки без ol_session_id).
  needsSessionOpener() {
    return this.olClosedSessionId != null;
  }

  // M25: Finish про сессию старше известной — входящее уже открыло новую сессию
  // раньше, чем дошло событие; флаг взводить нельзя (опенер встал бы посреди сессии).
  isStaleSessionFinish(sessionId) {
    return this.olSessionId != null && sessionId < this.olSessionId;
  }

  static fromRow(row) {
    if (!row) return null;
    return new ChatBinding({
      id: row.id,
      installationId: row.installation_id,
      maxChatId: row.max_chat_id,
      maxChatTitle: row.max_chat_title,
      connectorChatId: row.connector_chat_id,
      b24ChatId: row.b24_chat_id ?? null,
      // Колонки нет (код поднят раньше миграции 0010) → считаем чат синхронизированным,
      // иначе старые чаты переименовались бы до бэкфилла.
      olChatTitle: row.ol_chat_title === undefined ? row.max_chat_title : row.ol_chat_title,
      // Колонок нет (код раньше миграции 0011) → null: опенера нет, как до M25.
      olSessionId: row.ol_session_id ?? null,
      olClosedSessionId: row.ol_closed_session_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
