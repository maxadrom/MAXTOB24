// SQL для chat_bindings — только здесь.

import { ChatBinding } from './models/ChatBinding.js';

export class BindingsRepository {
  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger?.child ? logger.child({ layer: 'repository' }) : logger;
  }

  async findByMaxChat(installationId, maxChatId) {
    this.logger?.debug({ installationId, maxChatId }, 'bindings.findByMaxChat');
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_bindings
        WHERE installation_id = $1 AND max_chat_id = $2
        LIMIT 1`,
      [installationId, maxChatId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M21: все привязки установки — для read-only аудита (scripts/audit-bindings.js).
  async listByInstallation(installationId) {
    this.logger?.debug({ installationId }, 'bindings.listByInstallation');
    const { rows } = await this.pool.query(
      'SELECT * FROM chat_bindings WHERE installation_id = $1 ORDER BY id',
      [installationId],
    );
    return rows.map((row) => ChatBinding.fromRow(row));
  }

  async findByConnectorChat(installationId, connectorChatId) {
    this.logger?.debug(
      { installationId, connectorChatId },
      'bindings.findByConnectorChat',
    );
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_bindings
        WHERE installation_id = $1 AND connector_chat_id = $2
        LIMIT 1`,
      [installationId, connectorChatId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M21: онбординг одним запросом — привязка сразу с connector_chat_id = 'max:<chatId>'.
  // Конфликт по (installation_id, max_chat_id) не бросает: гонка первых сообщений получает
  // одну строку, а привязка без connector_chat_id (до M21 INSERT и UPDATE шли отдельно)
  // дозаполняется. max_chat_title при конфликте не трогаем — его ведёт M24.
  // created — строку вставил этот запрос (xmax = 0 у новой версии строки).
  async upsertForMaxChat({ installationId, maxChatId, maxChatTitle = null }) {
    this.logger?.info({ installationId, maxChatId }, 'bindings.upsertForMaxChat');
    const { rows } = await this.pool.query(
      `INSERT INTO chat_bindings
         (installation_id, max_chat_id, max_chat_title, connector_chat_id)
       VALUES ($1, $2::text, $3, 'max:' || $2::text)
       ON CONFLICT (installation_id, max_chat_id) DO UPDATE
         SET connector_chat_id = COALESCE(chat_bindings.connector_chat_id, EXCLUDED.connector_chat_id)
       RETURNING *, (xmax = 0) AS inserted`,
      [installationId, maxChatId, maxChatTitle],
    );
    return { binding: ChatBinding.fromRow(rows[0]), created: rows[0]?.inserted === true };
  }

  async updateB24ChatId(id, b24ChatId) {
    this.logger?.debug({ id, b24ChatId }, 'bindings.updateB24ChatId');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET b24_chat_id = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, b24ChatId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M24: название группы в MAX (онбординг, chat_title_changed).
  async updateMaxChatTitle(id, maxChatTitle) {
    this.logger?.debug({ id }, 'bindings.updateMaxChatTitle');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET max_chat_title = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, maxChatTitle],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M24: название, поставленное в чат OL (после успешного imconnector.chat.name.set).
  async updateOlChatTitle(id, olChatTitle) {
    this.logger?.debug({ id }, 'bindings.updateOlChatTitle');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET ol_chat_title = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, olChatTitle],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M25: сессия из ответа send.messages. ol_session_id только растёт; флаг закрытия
  // снимается, когда сообщение ушло в сессию новее закрытой (строго: при равенстве
  // Finish мог прийти между отправкой и этим UPDATE). Ничего не изменилось → null.
  async updateOlSession(id, sessionId) {
    this.logger?.debug({ id, sessionId }, 'bindings.updateOlSession');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET ol_session_id = GREATEST(ol_session_id, $2::integer),
             ol_closed_session_id = CASE WHEN ol_closed_session_id < $2::integer
                                         THEN NULL ELSE ol_closed_session_id END,
             updated_at = now()
       WHERE id = $1
         AND (ol_session_id IS NULL OR ol_session_id < $2::integer
              OR ol_closed_session_id < $2::integer)
       RETURNING *`,
      [id, sessionId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M25: OnImConnectorDialogFinish — взвести флаг опенера. Guard'ы: событие не старше
  // известной сессии (иначе входящее уже открыло новую) и сессия ещё не помечена.
  // Guard не пустил → null.
  async markOlSessionClosed(id, sessionId) {
    this.logger?.debug({ id, sessionId }, 'bindings.markOlSessionClosed');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET ol_session_id = GREATEST(ol_session_id, $2::integer),
             ol_closed_session_id = $2::integer,
             updated_at = now()
       WHERE id = $1
         AND (ol_session_id IS NULL OR ol_session_id <= $2::integer)
         AND ol_closed_session_id IS DISTINCT FROM $2::integer
       RETURNING *`,
      [id, sessionId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M27: флаг опенера без номера сессии — ol_closed_session_id = 0 («сессия закрыта, номер
  // неизвестен»). Взводит его ответ CHAT_RENAMING_FAILED на переименование группы, когда
  // imopenlines.dialog.get показал закрытую сессию, а привязка своей сессии ещё не знает.
  // updateOlSession снимает его первым же sid > 0, markOlSessionClosed(S) перезаписывает
  // (0 IS DISTINCT FROM S). Guard ol_session_id IS NULL: входящее уже открыло сессию —
  // флаг без номера не нужен. Уже взведён или guard не пустил → null.
  async markOlSessionClosedUnknown(id) {
    this.logger?.debug({ id }, 'bindings.markOlSessionClosedUnknown');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET ol_closed_session_id = 0, updated_at = now()
       WHERE id = $1 AND ol_session_id IS NULL AND ol_closed_session_id IS NULL
       RETURNING *`,
      [id],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M25: опенер отправлен (или не нужен) — снять флаг, если он всё ещё про ту же
  // закрытую сессию (compare-and-clear). sessionId — сессия опенера или null
  // (GREATEST пропускает NULL). Флаг уже другой → null.
  async clearOlClosedSession(id, closedSessionId, sessionId = null) {
    this.logger?.debug({ id, closedSessionId, sessionId }, 'bindings.clearOlClosedSession');
    const { rows } = await this.pool.query(
      `UPDATE chat_bindings
         SET ol_closed_session_id = NULL,
             ol_session_id = GREATEST(ol_session_id, $3::integer),
             updated_at = now()
       WHERE id = $1 AND ol_closed_session_id = $2::integer
       RETURNING *`,
      [id, closedSessionId, sessionId],
    );
    return ChatBinding.fromRow(rows[0]);
  }

  // M26: удаление приложения Б24 с CLEAN=1 — все привязки установки. participant_map и
  // message_log уходят по FK ON DELETE CASCADE (0004, 0005). Это единственное место, где
  // удаление привязок задевает журнал messaging, и только через FK схемы; вызывает его
  // координатор (messagingService.purgeBridgeData). → число удалённых привязок.
  async deleteAllByInstallation(installationId) {
    this.logger?.info({ installationId }, 'bindings.deleteAllByInstallation');
    const { rows } = await this.pool.query(
      `WITH deleted AS (DELETE FROM chat_bindings WHERE installation_id = $1 RETURNING id)
       SELECT count(*)::int AS count FROM deleted`,
      [installationId],
    );
    return rows[0]?.count ?? 0;
  }
}
