// Обмен refresh_token на новую пару OAuth-токенов Б24 (grant_type=refresh_token).
// Два потребителя:
//   - b24Client._doRefresh — продление access_token на expired_token;
//   - install-callback (installationsService, через DI-шов в app.js) — доказательство
//     подлинности ONAPPINSTALL: обмен удаётся только для пары, выданной нашему
//     client_id, а client_endpoint ответа называет портал (M19).
//
// Контракт (дока «Автоматическое продление токенов OAuth 2.0», 2026-10-06):
//   POST <oauth>/oauth/token/  grant_type, client_id, client_secret, refresh_token
//   успех → { access_token, refresh_token, client_endpoint, member_id,
//             domain (= сервер OAuth, не портал), server_endpoint, status, expires_in, scope }
//   отказ → { error: 'invalid_grant' | 'invalid_client' | …, error_description }
//
// Хост OAuth — константа: server_endpoint из payload события не используем (SSRF/подмена).
// В доке — oauth.bitrix24.tech, рабочий прод ходит на oauth.bitrix.info.
//
// Ошибки — B24ApiError с кодом-классом (installations классифицирует по нему, не
// импортируя этот модуль):
//   OAUTH_REJECTED       — сервер отверг пару (invalid_grant, expired_token, прочие 4xx):
//                          токен чужой, потрачен или протух; либо refresh_token пуст;
//   OAUTH_INVALID_CLIENT — наши B24_CLIENT_ID/SECRET не приняты (мисконфиг);
//   OAUTH_UNAVAILABLE    — проверить нельзя: сеть, таймаут, не-JSON, 5xx, 429,
//                          QUERY_LIMIT_EXCEEDED, 2xx без access_token.

import { B24ApiError } from '../../shared/http/domainErrors.js';

export const B24_OAUTH_TOKEN_URL = 'https://oauth.bitrix.info/oauth/token/';

const DEFAULT_TIMEOUT_MS = 20_000;
const METHOD = '<refreshToken>';

function fail(code, description, { httpStatus, oauthError, oauthDescription } = {}) {
  // В body — только код и описание ошибки OAuth: тело успешного ответа содержит токены.
  const body = oauthError ? { error: oauthError, error_description: oauthDescription ?? null } : null;
  return new B24ApiError(code, description, { method: METHOD, httpStatus, body });
}

function classifyFailure(status, oauthError) {
  if (oauthError === 'invalid_client') return 'OAUTH_INVALID_CLIENT';
  if (oauthError === 'QUERY_LIMIT_EXCEEDED' || status === 429 || status >= 500) {
    return 'OAUTH_UNAVAILABLE';
  }
  if (oauthError || (status >= 400 && status < 500)) return 'OAUTH_REJECTED';
  return 'OAUTH_UNAVAILABLE';
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @returns {Promise<{accessToken: string, refreshToken: string|null, memberId: string|null,
 *   clientEndpoint: string|null}>} — access_token гарантирован; остальные поля вызывающий
 *   проверяет сам (install требует все, рефреш терпит отсутствие refresh_token).
 * @throws {B24ApiError} OAUTH_REJECTED | OAUTH_INVALID_CLIENT | OAUTH_UNAVAILABLE
 */
export async function exchangeRefreshToken({
  refreshToken,
  clientId,
  clientSecret,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // До сети: иначе в тело ушла бы строка "null"/"undefined".
  if (!clientId || !clientSecret) {
    throw fail('OAUTH_INVALID_CLIENT', 'client_id and client_secret are required');
  }
  if (!refreshToken) {
    throw fail('OAUTH_REJECTED', 'no refresh_token to exchange');
  }

  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const ac = new AbortController();
  const timeoutHandle = setTimeout(() => ac.abort(), timeoutMs);

  let response;
  let data;
  try {
    try {
      response = await doFetch(B24_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      throw fail('OAUTH_UNAVAILABLE', `token exchange network error: ${err?.message ?? 'unknown'}`);
    }
    try {
      data = await response.json();
    } catch {
      throw fail('OAUTH_UNAVAILABLE', 'token exchange response not parseable as JSON', {
        httpStatus: response.status,
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  const oauthError = stringOrNull(data?.error);
  if (!response.ok || oauthError) {
    const code = classifyFailure(response.status, oauthError);
    throw fail(code, data?.error_description ?? `token exchange failed: ${oauthError ?? `HTTP ${response.status}`}`, {
      httpStatus: response.status,
      oauthError,
      oauthDescription: stringOrNull(data?.error_description),
    });
  }

  const accessToken = stringOrNull(data?.access_token);
  if (!accessToken) {
    throw fail('OAUTH_UNAVAILABLE', 'token exchange response missing access_token', {
      httpStatus: response.status,
    });
  }

  return {
    accessToken,
    refreshToken: stringOrNull(data.refresh_token),
    memberId: stringOrNull(data.member_id),
    clientEndpoint: stringOrNull(data.client_endpoint),
  };
}
