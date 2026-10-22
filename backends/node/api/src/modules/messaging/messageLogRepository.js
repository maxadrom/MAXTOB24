// SQL для message_log — только здесь.

import { MessageLogEntry } from './models/MessageLogEntry.js';

// M21: ключ дедупа обязателен. NULL обходит частичные уникальные индексы
// (WHERE max_mid/b24_msg_id IS NOT NULL) — ретраи писали бы дубли молча.
function assertKey(fn, key) {
  if (key === null || key === undefined || key === '') {
    throw new TypeError(`messageLog.${fn}: dedup key required`);
  }
}

export class MessageLogRepository {
  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger?.child ? logger.child({ layer: 'repository' }) : logger;
  }

  async findInbound(bindingId, maxMid) {
    if (!maxMid) return null;
    this.logger?.debug({ bindingId, maxMid }, 'messageLog.findInbound');
    const { rows } = await this.pool.query(
      `SELECT * FROM message_log
        WHERE binding_id = $1 AND direction = 'inbound' AND max_mid = $2
        LIMIT 1`,
      [bindingId, maxMid],
    );
    return MessageLogEntry.fromRow(rows[0]);
  }

  // M27: есть ли у привязки входящая запись с ключом на этот префикс (семейство ключей с
  // хешем в хвосте, напр. 'group-link:<chatId>:'). Индекс message_log_inbound_dedup_idx
  // (binding_id, direction, …) сужает до строк одной привязки, starts_with — фильтр по ним.
  // Пустой префикс — ошибка вызывающего: совпало бы с любой записью.
  async hasInboundKeyPrefix(bindingId, prefix) {
    if (typeof prefix !== 'string' || prefix === '') {
      throw new TypeError('messageLog.hasInboundKeyPrefix: key prefix required');
    }
    this.logger?.debug({ bindingId, prefix }, 'messageLog.hasInboundKeyPrefix');
    const { rows } = await this.pool.query(
      `SELECT 1 FROM message_log
        WHERE binding_id = $1 AND direction = 'inbound' AND starts_with(max_mid, $2)
        LIMIT 1`,
      [bindingId, prefix],
    );
    return rows.length > 0;
  }

  async findOutbound(bindingId, b24MsgId) {
    if (!b24MsgId) return null;
    this.logger?.debug({ bindingId, b24MsgId }, 'messageLog.findOutbound');
    const { rows } = await this.pool.query(
      `SELECT * FROM message_log
        WHERE binding_id = $1 AND direction = 'outbound' AND b24_msg_id = $2
        LIMIT 1`,
      [bindingId, b24MsgId],
    );
    return MessageLogEntry.fromRow(rows[0]);
  }

  // M21: сводка журнала по привязкам для read-only аудита (scripts/audit-bindings.js).
  // → Map(String(bindingId) → { inbound, outbound, lastAt }); привязки без записей в Map нет.
  async statsByBindings(bindingIds) {
    if (!Array.isArray(bindingIds) || bindingIds.length === 0) return new Map();
    this.logger?.debug({ count: bindingIds.length }, 'messageLog.statsByBindings');
    const { rows } = await this.pool.query(
      `SELECT binding_id,
              count(*) FILTER (WHERE direction = 'inbound')::int  AS inbound,
              count(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
              max(created_at) AS last_at
         FROM message_log
        WHERE binding_id = ANY($1::bigint[])
        GROUP BY binding_id`,
      [bindingIds],
    );
    return new Map(rows.map((r) => [
      String(r.binding_id),
      { inbound: r.inbound, outbound: r.outbound, lastAt: r.last_at },
    ]));
  }

  async recordInbound({ bindingId, maxMid, payloadMeta = null }) {
    assertKey('recordInbound', maxMid);
    this.logger?.info({ bindingId, maxMid }, 'messageLog.recordInbound');
    const { rows } = await this.pool.query(
      `INSERT INTO message_log (binding_id, direction, max_mid, payload_meta)
       VALUES ($1, 'inbound', $2, $3)
       ON CONFLICT (binding_id, direction, max_mid)
         WHERE max_mid IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [bindingId, maxMid, payloadMeta ? JSON.stringify(payloadMeta) : null],
    );
    return MessageLogEntry.fromRow(rows[0]);
  }

  async recordOutbound({ bindingId, b24MsgId, payloadMeta = null }) {
    assertKey('recordOutbound', b24MsgId);
    this.logger?.info({ bindingId, b24MsgId }, 'messageLog.recordOutbound');
    const { rows } = await this.pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, payload_meta)
       VALUES ($1, 'outbound', $2, $3)
       ON CONFLICT (binding_id, direction, b24_msg_id)
         WHERE b24_msg_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [bindingId, b24MsgId, payloadMeta ? JSON.stringify(payloadMeta) : null],
    );
    return MessageLogEntry.fromRow(rows[0]);
  }

  // M29: строка задания очереди исходящих — «в процессе» (status 'in_progress', ключ
  // jobKey = 'job:<ключ операции>' собирает вызывающий). Пишется до отправки в MAX и
  // снимается releaseOutboundJob по завершении: оставшаяся после рестарта строка — признак
  // прерванной передачи (findOutboundJobs на старте). Уникальный индекс
  // message_log_outbound_dedup_idx заодно отсекает параллельный повтор того же события.
  // → entry | null (null — такое задание уже в работе).
  async claimOutboundJob({ bindingId, jobKey, payloadMeta = null }) {
    assertKey('claimOutboundJob', jobKey);
    this.logger?.debug({ bindingId, jobKey }, 'messageLog.claimOutboundJob');
    const { rows } = await this.pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, status, payload_meta)
       VALUES ($1, 'outbound', $2, 'in_progress', $3)
       ON CONFLICT (binding_id, direction, b24_msg_id)
         WHERE b24_msg_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [bindingId, jobKey, payloadMeta ? JSON.stringify(payloadMeta) : null],
    );
    return MessageLogEntry.fromRow(rows[0]);
  }

  // M29: снять строку задания. Только 'in_progress': обычную запись журнала по id не
  // удалить. → число удалённых строк (0 — уже снята или ушла каскадом с привязкой).
  async releaseOutboundJob(id) {
    if (id === null || id === undefined || id === '') {
      throw new TypeError('messageLog.releaseOutboundJob: job id required');
    }
    this.logger?.debug({ id }, 'messageLog.releaseOutboundJob');
    const { rowCount } = await this.pool.query(
      `DELETE FROM message_log WHERE id = $1 AND status = 'in_progress'`,
      [id],
    );
    return rowCount;
  }

  // M29: строки заданий, созданные раньше createdBefore (Date старта процесса): старт
  // разбирает только задания прошлых процессов, свои новые claim не попадают. Порядок —
  // по id (порядок claim). Индекса по status нет: запрос — раз на старт, журнал мал.
  async findOutboundJobs({ createdBefore, limit = 500 } = {}) {
    if (!(createdBefore instanceof Date) || Number.isNaN(createdBefore.getTime())) {
      throw new TypeError('messageLog.findOutboundJobs: createdBefore (Date) required');
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError(`messageLog.findOutboundJobs: limit must be a positive integer (got ${limit})`);
    }
    this.logger?.debug({ createdBefore, limit }, 'messageLog.findOutboundJobs');
    const { rows } = await this.pool.query(
      `SELECT * FROM message_log
        WHERE direction = 'outbound' AND status = 'in_progress' AND created_at < $1
        ORDER BY id
        LIMIT $2`,
      [createdBefore, limit],
    );
    return rows.map((row) => MessageLogEntry.fromRow(row));
  }
}
