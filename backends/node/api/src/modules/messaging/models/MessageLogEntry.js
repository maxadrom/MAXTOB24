// Модель записи журнала message_log. Инварианты direction/status — в конструкторе.
// Дубль = найденная запись: find* репозитория возвращает entry либо null.

import { ValidationError } from '../../../shared/http/domainErrors.js';

const VALID_DIRECTIONS = ['inbound', 'outbound'];
// 'in_progress' (M29) — строка задания очереди исходящих (ключ job:<ключ операции>): живёт,
// пока задание выполняется, см. MessageLogRepository.claimOutboundJob.
const VALID_STATUSES = ['received', 'delivered', 'failed', 'in_progress'];

export class MessageLogEntry {
  constructor({
    id = null,
    bindingId,
    direction,
    maxMid = null,
    b24MsgId = null,
    status = 'received',
    error = null,
    payloadMeta = null,
    createdAt = null,
  }) {
    if (!bindingId) throw new ValidationError('MessageLogEntry: bindingId required');
    if (!VALID_DIRECTIONS.includes(direction)) {
      throw new ValidationError(`direction must be one of ${VALID_DIRECTIONS.join('|')}`);
    }
    if (!VALID_STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of ${VALID_STATUSES.join('|')}`);
    }
    this.id = id;
    this.bindingId = bindingId;
    this.direction = direction;
    this.maxMid = maxMid;
    this.b24MsgId = b24MsgId;
    this.status = status;
    this.error = error;
    this.payloadMeta = payloadMeta;
    this.createdAt = createdAt;
  }

  static fromRow(row) {
    if (!row) return null;
    return new MessageLogEntry({
      id: row.id,
      bindingId: row.binding_id,
      direction: row.direction,
      maxMid: row.max_mid,
      b24MsgId: row.b24_msg_id,
      status: row.status,
      error: row.error,
      payloadMeta: row.payload_meta,
      createdAt: row.created_at,
    });
  }
}
