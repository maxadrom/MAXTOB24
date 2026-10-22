// Единственное место, где живёт SQL для таблицы installations.
// Никаких сырых SQL вне этого репозитория (правило base.md).

import { Installation } from './models/Installation.js';

export class InstallationsRepository {
  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger?.child ? logger.child({ layer: 'repository' }) : logger;
  }

  async findByPortal(portal) {
    this.logger?.debug({ portal }, 'installations.findByPortal');
    const { rows } = await this.pool.query(
      'SELECT * FROM installations WHERE b24_portal = $1 LIMIT 1',
      [portal],
    );
    return Installation.fromRow(rows[0]);
  }

  async getDefaultSingleTenant() {
    this.logger?.debug('installations.getDefaultSingleTenant');
    const { rows } = await this.pool.query(
      'SELECT * FROM installations ORDER BY id ASC LIMIT 1',
    );
    return Installation.fromRow(rows[0]);
  }

  async upsertByPortal({ portal }) {
    this.logger?.info({ portal }, 'installations.upsertByPortal');
    const { rows } = await this.pool.query(
      `INSERT INTO installations (b24_portal)
       VALUES ($1)
       ON CONFLICT (b24_portal) DO UPDATE
         SET updated_at = now()
       RETURNING *`,
      [portal],
    );
    return Installation.fromRow(rows[0]);
  }

  async updateTokens(id, { access, refresh, applicationToken }) {
    this.logger?.debug({ id }, 'installations.updateTokens');
    const { rows } = await this.pool.query(
      `UPDATE installations
         SET b24_access_token = COALESCE($2, b24_access_token),
             b24_refresh_token = COALESCE($3, b24_refresh_token),
             b24_application_token = COALESCE($4, b24_application_token),
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, access ?? null, refresh ?? null, applicationToken ?? null],
    );
    return Installation.fromRow(rows[0]);
  }

  // Install-callback (M19): одна атомарная запись трёх токенов после успешного обмена
  // refresh_token. Без COALESCE — все значения обязательны и заменяют прежние.
  // id есть → UPDATE этой строки (single-tenant: строка из getDefaultSingleTenant);
  // id нет → первая установка: INSERT с каноническим порталом. Колонку b24_member_id
  // НЕ трогаем: деплой поднимает код раньше миграции 0008 (см. setMemberId).
  // M26: установка после удаления приложения (переустановка) снимает пометку
  // uninstalled_at — вебхук Б24 и онбординг снова открыты. Эту колонку (0013) пишем в том
  // же запросе: с M26 deploy.sh применяет миграции до старта нового кода.
  async saveInstallTokens({ id = null, portal, access, refresh, applicationToken }) {
    this.logger?.debug({ id, portal }, 'installations.saveInstallTokens');
    const tokens = [access, refresh, applicationToken];
    const { rows } =
      id != null
        ? await this.pool.query(
            `UPDATE installations
               SET b24_access_token = $2,
                   b24_refresh_token = $3,
                   b24_application_token = $4,
                   uninstalled_at = NULL,
                   updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, ...tokens],
          )
        : await this.pool.query(
            `INSERT INTO installations
               (b24_portal, b24_access_token, b24_refresh_token, b24_application_token)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (b24_portal) DO UPDATE
               SET b24_access_token = EXCLUDED.b24_access_token,
                   b24_refresh_token = EXCLUDED.b24_refresh_token,
                   b24_application_token = EXCLUDED.b24_application_token,
                   uninstalled_at = NULL,
                   updated_at = now()
             RETURNING *`,
            [portal, ...tokens],
          );
    return Installation.fromRow(rows[0]);
  }

  // OAuth-рефреш (M19): compare-and-swap по старому refresh_token. Install-callback или
  // скрипт в другом процессе мог записать более свежую пару между чтением и записью —
  // тогда 0 строк и null, чужую пару не затираем.
  async casRefreshedTokens(id, { oldRefresh, access, refresh }) {
    this.logger?.debug({ id }, 'installations.casRefreshedTokens');
    const { rows } = await this.pool.query(
      `UPDATE installations
         SET b24_access_token = $3,
             b24_refresh_token = $4,
             updated_at = now()
       WHERE id = $1 AND b24_refresh_token = $2
       RETURNING *`,
      [id, oldRefresh, access, refresh],
    );
    return Installation.fromRow(rows[0]);
  }

  // M26: удаление приложения Б24 (ONAPPUNINSTALL). Три токена → NULL: после удаления Б24
  // отвечает на них APPLICATION_NOT_FOUND, а мёртвый application_token не должен открывать
  // /webhook/b24. b24_portal, b24_member_id и метаданные коннектора остаются. uninstalled_at
  // ставится один раз — повтор события его не двигает.
  // Compare-and-swap по application_token события (как casRefreshedTokens по refresh): между
  // проверкой токена в контроллере и этим UPDATE install-callback нового приложения мог
  // записать свою тройку — тогда 0 строк и null, чужую установку не стираем. Ветка IS NULL —
  // токена в БД нет: событие сверено по env-fallback или параллельный дубль уже обнулил токены.
  // Строки нет → тоже null.
  async markUninstalled(id, { applicationToken } = {}) {
    this.logger?.info({ id }, 'installations.markUninstalled');
    const { rows } = await this.pool.query(
      `UPDATE installations
         SET b24_access_token = NULL,
             b24_refresh_token = NULL,
             b24_application_token = NULL,
             uninstalled_at = COALESCE(uninstalled_at, now()),
             updated_at = now()
       WHERE id = $1
         AND (b24_application_token = $2 OR b24_application_token IS NULL)
       RETURNING *`,
      [id, applicationToken ?? null],
    );
    return Installation.fromRow(rows[0]);
  }

  // member_id портала — отдельным запросом: колонка из миграции 0008 может ещё не
  // существовать (деплой поднимает код раньше миграции). Вызывающий глушит ошибку.
  // updated_at не трогаем: он отражает смену токенов.
  async setMemberId(id, memberId) {
    this.logger?.debug({ id }, 'installations.setMemberId');
    const { rowCount } = await this.pool.query(
      `UPDATE installations
         SET b24_member_id = $2
       WHERE id = $1 AND b24_member_id IS DISTINCT FROM $2`,
      [id, memberId],
    );
    return rowCount > 0;
  }

  async updateConnectorMetadata(id, { olLineId, connectorId, maxBotId }) {
    this.logger?.debug({ id, olLineId, connectorId }, 'installations.updateConnectorMetadata');
    const { rows } = await this.pool.query(
      `UPDATE installations
         SET ol_line_id = COALESCE($2, ol_line_id),
             connector_id = COALESCE($3, connector_id),
             max_bot_id = COALESCE($4, max_bot_id),
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, olLineId ?? null, connectorId ?? null, maxBotId ?? null],
    );
    return Installation.fromRow(rows[0]);
  }

  // Сброс M2-метаданных коннектора в NULL — нужен для отката (--unregister).
  // Токены НЕ трогаем (они под updateTokens).
  async clearConnectorMetadata(id) {
    this.logger?.info({ id }, 'installations.clearConnectorMetadata');
    const { rows } = await this.pool.query(
      `UPDATE installations
         SET ol_line_id = NULL,
             connector_id = NULL,
             max_bot_id = NULL,
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return Installation.fromRow(rows[0]);
  }
}
