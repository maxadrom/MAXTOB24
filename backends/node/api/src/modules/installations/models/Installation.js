// Модель установки портала: OAuth-токены, application_token, connector metadata и
// пометка удаления приложения (M26).
// Запись — только через installationsService/репозиторий (upsert по порталу).

export class Installation {
  constructor({
    id = null,
    b24Portal,
    b24AccessToken = null,
    b24RefreshToken = null,
    b24ApplicationToken = null,
    b24MemberId = null,
    olLineId = null,
    connectorId = null,
    maxBotId = null,
    uninstalledAt = null,
    createdAt = null,
    updatedAt = null,
  }) {
    if (!b24Portal || typeof b24Portal !== 'string') {
      throw new TypeError('Installation: b24Portal is required');
    }
    this.id = id;
    this.b24Portal = b24Portal;
    this.b24AccessToken = b24AccessToken;
    this.b24RefreshToken = b24RefreshToken;
    this.b24ApplicationToken = b24ApplicationToken;
    // member_id портала (миграция 0008): NULL до первого обмена refresh_token после M19.
    this.b24MemberId = b24MemberId;
    this.olLineId = olLineId;
    this.connectorId = connectorId;
    this.maxBotId = maxBotId;
    // Приложение Б24 удалено (ONAPPUNINSTALL, миграция 0013): токены обнулены, вебхук Б24
    // и онбординг закрыты до переустановки. NULL — приложение установлено.
    this.uninstalledAt = uninstalledAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  isUninstalled() {
    return this.uninstalledAt != null;
  }

  static fromRow(row) {
    if (!row) return null;
    return new Installation({
      id: row.id,
      b24Portal: row.b24_portal,
      b24AccessToken: row.b24_access_token,
      b24RefreshToken: row.b24_refresh_token,
      b24ApplicationToken: row.b24_application_token,
      b24MemberId: row.b24_member_id ?? null,
      olLineId: row.ol_line_id,
      connectorId: row.connector_id,
      maxBotId: row.max_bot_id,
      uninstalledAt: row.uninstalled_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
