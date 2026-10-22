// Маппинг участника MAX-чата на external user в imconnector.

import { ValidationError } from '../../../shared/http/domainErrors.js';

export class ParticipantMap {
  constructor({
    id = null,
    bindingId,
    maxUserId,
    maxDisplayName = null,
    connectorUserId = null,
    createdAt = null,
  }) {
    if (!bindingId) throw new ValidationError('ParticipantMap: bindingId required');
    if (!maxUserId) throw new ValidationError('ParticipantMap: maxUserId required');
    this.id = id;
    this.bindingId = bindingId;
    this.maxUserId = maxUserId;
    this.maxDisplayName = maxDisplayName;
    this.connectorUserId = connectorUserId;
    this.createdAt = createdAt;
  }

  static fromRow(row) {
    if (!row) return null;
    return new ParticipantMap({
      id: row.id,
      bindingId: row.binding_id,
      maxUserId: row.max_user_id,
      maxDisplayName: row.max_display_name,
      connectorUserId: row.connector_user_id,
      createdAt: row.created_at,
    });
  }
}
