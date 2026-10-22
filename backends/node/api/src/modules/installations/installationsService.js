// Use-case layer для installations. Контроллер вызывает только сервис.

import { timingSafeStrEqual } from '../../shared/crypto/timingSafeStrEqual.js';
import {
  ConfigError,
  DomainError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/http/domainErrors.js';

// Install-callback (M19). Б24 шлёт ONAPPINSTALL на URL установки (приложение без UI
// получает его и при обновлении); ONAPPUPDATE — то же, если его забиндили.
const INSTALL_EVENTS = new Set(['ONAPPINSTALL', 'ONAPPUPDATE']);
// Токены и member_id Б24 — hex/alnum. Регэксп — дешёвый отсев мусора до сетевого
// обмена, не проверка подлинности (её делает OAuth-сервер).
const TOKEN_RE = /^[A-Za-z0-9._-]{8,512}$/;
const MAX_DOMAIN_LEN = 253;

// Хост портала для сравнения: trim, lowercase, без конечной точки FQDN.
function normalizePortalHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.+$/, '');
  return host.length > 0 ? host : null;
}

// Хост из client_endpoint ответа OAuth (`https://<портал>/rest/`). Только https:.
function endpointHost(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' ? normalizePortalHost(url.hostname) : null;
  } catch {
    return null;
  }
}

// Строковое поле auth: нет/пусто → null; не строка (qs склеивает дубли ключей в
// массив, вложенные ключи — в объект) или мусор → ValidationError.
function authField(auth, key, re) {
  const value = auth[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !re.test(value)) {
    throw new ValidationError(`install payload: auth.${key} is malformed`);
  }
  return value;
}

function parseInstallPayload(payload) {
  const event = typeof payload?.event === 'string' ? payload.event.toUpperCase() : null;
  if (!INSTALL_EVENTS.has(event)) {
    throw new ValidationError('install payload: event must be ONAPPINSTALL or ONAPPUPDATE');
  }
  const auth = payload.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new ValidationError('install payload: auth object required');
  }
  const domain = auth.domain;
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > MAX_DOMAIN_LEN) {
    throw new ValidationError('install payload: auth.domain is missing or malformed');
  }
  return {
    event,
    domain,
    memberId: authField(auth, 'member_id', TOKEN_RE),
    accessToken: authField(auth, 'access_token', TOKEN_RE),
    refreshToken: authField(auth, 'refresh_token', TOKEN_RE),
    applicationToken: authField(auth, 'application_token', TOKEN_RE),
  };
}

function verifyUnavailable(message) {
  return new DomainError({ code: 'INSTALL_VERIFY_UNAVAILABLE', message, status: 503 });
}

export class InstallationsService {
  // Опции нужны только install-callback'у (их проводит app.js); скрипты (scripts/lib/
  // bootstrap.js) создают сервис без них — install-путь тогда отвечает 503.
  //   portal               — канонический хост портала (B24_PORTAL);
  //   clientId/clientSecret — B24_CLIENT_ID/SECRET для обмена refresh_token;
  //   exchangeRefreshToken — b24OAuth.exchangeRefreshToken (DI: installations не
  //                          импортирует b24/), бросает B24ApiError с b24Code
  //                          OAUTH_REJECTED | OAUTH_INVALID_CLIENT | OAUTH_UNAVAILABLE.
  constructor(
    repository,
    logger,
    { portal = null, clientId = null, clientSecret = null, exchangeRefreshToken = null } = {},
  ) {
    this.repo = repository;
    this.logger = logger;
    this.portal = normalizePortalHost(portal);
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.exchangeRefreshToken =
      typeof exchangeRefreshToken === 'function' ? exchangeRefreshToken : null;
  }

  async getCurrent() {
    const installation = await this.repo.getDefaultSingleTenant();
    if (!installation) {
      throw new NotFoundError('No installation found — call POST /api/install first');
    }
    return installation;
  }

  async findByPortal(portal) {
    if (!portal || typeof portal !== 'string') {
      throw new ValidationError('portal must be non-empty string');
    }
    return this.repo.findByPortal(portal);
  }

  // POST /api/install (M19). Подлинность доказывает OAuth-сервер Б24: обмен refresh_token
  // из payload с нашими client creds удаётся только для пары, выданной нашему приложению,
  // а client_endpoint ответа называет портал. refresh_token одноразовый — повтор payload
  // не срабатывает. Все дешёвые проверки — до сети; токены не логируются.
  async installFromOAuthPayload(payload) {
    this._assertInstallConfigured();
    const auth = parseInstallPayload(payload);

    const incomingPortal = normalizePortalHost(auth.domain);
    if (incomingPortal !== this.portal) {
      this.logger?.warn(
        { portal: incomingPortal, event: auth.event },
        'install rejected: domain is not the configured portal',
      );
      throw new UnauthorizedError('install rejected: domain is not the configured portal');
    }

    // Single-tenant: пишем только в строку getDefaultSingleTenant (её читают webhook и
    // b24Client). Строка другого портала = мисконфиг B24_PORTAL — двойника не создаём.
    // Заодно БД проверена до того, как тратить одноразовый refresh_token.
    const current = await this.repo.getDefaultSingleTenant();
    if (current && normalizePortalHost(current.b24Portal) !== this.portal) {
      this.logger?.error(
        { installationId: current.id, storedPortal: current.b24Portal, portal: this.portal },
        'install rejected: stored installation belongs to another portal — check B24_PORTAL',
      );
      throw new ConfigError('install rejected: stored installation does not match B24_PORTAL');
    }

    this.logger?.info(
      {
        portal: this.portal,
        event: auth.event,
        hasAccess: Boolean(auth.accessToken),
        hasRefresh: Boolean(auth.refreshToken),
        hasApplicationToken: Boolean(auth.applicationToken),
        hasMemberId: Boolean(auth.memberId),
      },
      'install request received',
    );

    if (auth.refreshToken && auth.applicationToken) {
      return this._installWithTokenExchange(current, auth);
    }
    if (auth.applicationToken && !auth.accessToken) {
      return this._confirmStoredApplicationToken(current, auth);
    }
    throw new ValidationError(
      'install payload: expected refresh_token + application_token (or application_token alone)',
    );
  }

  _assertInstallConfigured() {
    if (this.portal && this.clientId && this.clientSecret && this.exchangeRefreshToken) return;
    this.logger?.error(
      {
        hasPortal: Boolean(this.portal),
        hasClientId: Boolean(this.clientId),
        hasClientSecret: Boolean(this.clientSecret),
        hasExchange: Boolean(this.exchangeRefreshToken),
      },
      'install rejected: B24_PORTAL / B24_CLIENT_ID / B24_CLIENT_SECRET not configured',
    );
    throw new ConfigError('install rejected: B24_PORTAL / B24_CLIENT_ID / B24_CLIENT_SECRET required');
  }

  async _installWithTokenExchange(current, auth) {
    if (current?.b24MemberId && auth.memberId && auth.memberId !== current.b24MemberId) {
      this.logger?.warn(
        { installationId: current.id },
        'install rejected: member_id differs from stored',
      );
      throw new UnauthorizedError('install rejected: member_id mismatch');
    }

    let exchanged;
    try {
      exchanged = await this.exchangeRefreshToken({
        refreshToken: auth.refreshToken,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });
    } catch (err) {
      throw this._exchangeFailure(err);
    }

    // Старый refresh из payload уже потрачен — подставлять его нельзя.
    if (!exchanged?.accessToken || !exchanged.refreshToken || !exchanged.memberId || !exchanged.clientEndpoint) {
      this.logger?.error('install: token exchange response incomplete — cannot verify');
      throw verifyUnavailable('install rejected: token exchange response incomplete');
    }
    const exchangedPortal = endpointHost(exchanged.clientEndpoint);
    if (exchangedPortal !== this.portal) {
      this.logger?.warn(
        { portal: exchangedPortal },
        'install rejected: tokens belong to another portal (client_endpoint)',
      );
      throw new UnauthorizedError('install rejected: tokens issued for another portal');
    }
    if (auth.memberId && auth.memberId !== exchanged.memberId) {
      this.logger?.warn('install rejected: payload member_id differs from OAuth server');
      throw new UnauthorizedError('install rejected: member_id mismatch');
    }

    let installation;
    try {
      installation = await this.repo.saveInstallTokens({
        id: current?.id ?? null,
        portal: this.portal,
        access: exchanged.accessToken,
        refresh: exchanged.refreshToken,
        applicationToken: auth.applicationToken,
      });
    } catch (err) {
      this.logger?.error(
        { err: { message: err?.message, code: err?.code ?? null } },
        'install: tokens exchanged but NOT saved — refresh_token is spent, re-save the app form in Bitrix24',
      );
      throw err;
    }
    if (!installation) {
      this.logger?.error(
        { installationId: current?.id ?? null },
        'install: installation row vanished before save — re-save the app form in Bitrix24',
      );
      throw new DomainError({ code: 'INSTALL_SAVE_FAILED', message: 'installation not saved', status: 500 });
    }
    await this._saveMemberId(installation.id, exchanged.memberId);

    this.logger?.info(
      {
        portal: this.portal,
        installationId: installation.id,
        event: auth.event,
        firstInstall: !current,
        // M26: установка после удаления приложения — saveInstallTokens снял uninstalled_at.
        reinstalled: Boolean(current?.isUninstalled?.()),
        applicationTokenChanged:
          !current?.b24ApplicationToken ||
          !timingSafeStrEqual(current.b24ApplicationToken, auth.applicationToken),
      },
      'install verified: tokens saved',
    );
    return installation;
  }

  // Событие без пользовательских токенов (Б24 не привязал его к пользователю): доказать
  // новый application_token нечем — принимаем только совпадающий с сохранённым.
  async _confirmStoredApplicationToken(current, auth) {
    if (current?.b24ApplicationToken &&
        timingSafeStrEqual(auth.applicationToken, current.b24ApplicationToken)) {
      this.logger?.info(
        { installationId: current.id, event: auth.event },
        'install: application_token matches stored, OAuth tokens absent — nothing to update',
      );
      return current;
    }
    this.logger?.warn(
      { installationId: current?.id ?? null, event: auth.event, hasStored: Boolean(current?.b24ApplicationToken) },
      'install rejected: application_token without OAuth tokens does not match stored',
    );
    throw new UnauthorizedError('install rejected: application_token cannot be verified');
  }

  _exchangeFailure(err) {
    const oauthError = err?.body?.error ?? null;
    switch (err?.b24Code) {
      case 'OAUTH_REJECTED':
        this.logger?.warn(
          { oauthError, httpStatus: err.httpStatus ?? null },
          'install rejected: OAuth server refused refresh_token (foreign pair or repeated delivery)',
        );
        return new UnauthorizedError('install rejected: refresh_token not accepted by Bitrix24 OAuth');
      case 'OAUTH_INVALID_CLIENT':
        this.logger?.error(
          { oauthError },
          'install: OAuth server rejected our client credentials — check B24_CLIENT_ID / B24_CLIENT_SECRET',
        );
        return new ConfigError('install rejected: B24 client credentials not accepted');
      default:
        this.logger?.error(
          { b24Code: err?.b24Code ?? null, oauthError, httpStatus: err?.httpStatus ?? null, message: err?.message },
          'install: cannot verify tokens — Bitrix24 OAuth unavailable',
        );
        return verifyUnavailable('install rejected: Bitrix24 OAuth unavailable');
    }
  }

  // OAuth-рефреш (b24Client._doRefresh): новая пара пишется compare-and-swap по старому
  // refresh_token. 0 строк = install-callback или процесс скрипта уже записал более
  // свежую пару — её не затираем (ретрай callMethod перечитает БД). application_token
  // рефреш не меняет. member_id из ответа обмена — best-effort (см. _saveMemberId).
  async saveRefreshedTokens(installationId, { oldRefresh, access, refresh, memberId = null }) {
    const saved = await this.repo.casRefreshedTokens(installationId, { oldRefresh, access, refresh });
    if (!saved) {
      this.logger?.warn(
        { installationId },
        'refreshed tokens not saved: refresh_token changed concurrently (install or another process)',
      );
    }
    if (memberId) await this._saveMemberId(installationId, memberId);
    return saved;
  }

  // M26: удаление приложения Б24 (ONAPPUNINSTALL, зовёт b24Service.handleAppUninstall).
  // Токены портала → NULL, uninstalled_at ставится один раз (повтор его не двигает).
  // b24_portal и member_id остаются: member_id сверяет переустановку, а строку держат
  // привязки. Данные моста (CLEAN=1) чистит координатор — не этот модуль.
  // applicationToken — токен события, сверенный контроллером: запись условная (CAS в
  // repo.markUninstalled). Если за это время install-callback записал новую тройку
  // (переустановка) или строка исчезла — ничего не меняем и отвечаем stale.
  // → { installation, alreadyUninstalled } | { stale: true, installationId } | null (строки
  // нет). Токены не логируются.
  async markUninstalled({ applicationToken } = {}) {
    const current = await this.repo.getDefaultSingleTenant();
    if (!current) {
      this.logger?.warn('app uninstall: no installation row — nothing to clear');
      return null;
    }
    const alreadyUninstalled = current.isUninstalled();
    const installation = await this.repo.markUninstalled(current.id, { applicationToken });
    if (!installation) {
      this.logger?.warn(
        { installationId: current.id },
        'app uninstall not applied: installation changed concurrently (reinstalled or removed) — tokens kept',
      );
      return { stale: true, installationId: current.id };
    }
    this.logger?.info({ installationId: installation.id, alreadyUninstalled }, 'app uninstalled: tokens cleared');
    return { installation, alreadyUninstalled };
  }

  // member_id — отдельным запросом и без проброса ошибки: деплой поднимает новый код
  // раньше миграции 0008, а потеря member_id не должна стоить токенов.
  async _saveMemberId(installationId, memberId) {
    try {
      await this.repo.setMemberId(installationId, memberId);
    } catch (err) {
      this.logger?.warn(
        { installationId, err: { message: err?.message, code: err?.code ?? null } },
        'b24 member_id not saved (migration 0008 not applied?)',
      );
    }
  }

  // M2: апсерт installation по portal + обновление connector metadata.
  // Существующие токены (b24_access_token/refresh) НЕ затираются (COALESCE в
  // updateConnectorMetadata). Нужно для scripts/register-connector.js.
  async seedSingleTenant({ portal, olLineId, connectorId, maxBotId } = {}) {
    if (!portal || typeof portal !== 'string') {
      throw new ValidationError('seedSingleTenant: portal required');
    }
    this.logger?.info(
      { portal, olLineId, connectorId, maxBotId },
      'installations.seedSingleTenant',
    );
    const installation = await this.repo.upsertByPortal({ portal });
    return this.repo.updateConnectorMetadata(installation.id, {
      olLineId: olLineId ?? null,
      connectorId: connectorId ?? null,
      maxBotId: maxBotId ?? null,
    });
  }

  // M2: сбрасывает ol_line_id/connector_id/max_bot_id в NULL у дефолтной
  // (single-tenant) installation. Токены не трогаем. Возвращает null,
  // если installations пустая.
  async clearConnectorMetadata() {
    const installation = await this.repo.getDefaultSingleTenant();
    if (!installation) {
      this.logger?.warn('installations.clearConnectorMetadata: no installation found, skipping');
      return null;
    }
    this.logger?.info({ id: installation.id }, 'installations.clearConnectorMetadata');
    return this.repo.clearConnectorMetadata(installation.id);
  }
}
