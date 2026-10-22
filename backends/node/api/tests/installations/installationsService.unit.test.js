// Unit-тесты installationsService: install-callback (M19) и запись рефреша.
// Репозиторий и обмен refresh_token мокаем — тесты гоняются без pg и сети.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallationsService } from '../../src/modules/installations/installationsService.js';
import { Installation } from '../../src/modules/installations/models/Installation.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';

const PORTAL = 'example.bitrix24.ru';
const APP_TOKEN = 'apptoken000000000000000000000001';
const REFRESH = 'refreshtoken00000000000000000002';
const ACCESS = 'accesstoken000000000000000000002';
const MEMBER = 'memberid000000000000000000000001';

// Реалистичный ответ обмена: портал — в client_endpoint.
const EXCHANGED = Object.freeze({
  accessToken: 'newaccess000000000000000000000001',
  refreshToken: 'newrefresh00000000000000000000001',
  memberId: MEMBER,
  clientEndpoint: `https://${PORTAL}/rest/`,
});

function onAppInstall(authOverrides = {}, { event = 'ONAPPINSTALL' } = {}) {
  return {
    event,
    event_handler_id: '11',
    data: { VERSION: '1', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
    ts: '1696527000',
    auth: {
      domain: PORTAL,
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: '3600',
      server_endpoint: 'https://oauth.bitrix.info/rest/',
      client_endpoint: `https://${PORTAL}/rest/`,
      member_id: MEMBER,
      application_token: APP_TOKEN,
      status: 'L',
      scope: 'imopenlines,imconnector,im',
      ...authOverrides,
    },
  };
}

function storedRow(overrides = {}) {
  return {
    id: 1,
    b24Portal: PORTAL,
    b24AccessToken: 'storedaccess0000',
    b24RefreshToken: 'storedrefresh000',
    b24ApplicationToken: APP_TOKEN,
    b24MemberId: null,
    ...overrides,
  };
}

// M26: строка после ONAPPUNINSTALL — токены обнулены, member_id и портал сохранены.
function uninstalledRow(overrides = {}) {
  return new Installation({
    id: 1,
    b24Portal: PORTAL,
    b24MemberId: MEMBER,
    connectorId: 'max_b24',
    olLineId: 42,
    uninstalledAt: new Date('2026-10-08T10:00:00Z'),
    ...overrides,
  });
}

function buildRepo({ current = null } = {}) {
  return {
    getDefaultSingleTenant: vi.fn(async () => current),
    saveInstallTokens: vi.fn(async ({ id, portal, access, refresh, applicationToken }) => ({
      id: id ?? 1,
      b24Portal: current?.b24Portal ?? portal,
      b24AccessToken: access,
      b24RefreshToken: refresh,
      b24ApplicationToken: applicationToken,
    })),
    setMemberId: vi.fn(async () => true),
    upsertByPortal: vi.fn(),
    updateTokens: vi.fn(),
  };
}

function oauthError(code, { oauth = null, httpStatus = null } = {}) {
  return new B24ApiError(code, 'oauth failed', {
    method: '<refreshToken>',
    httpStatus,
    body: oauth ? { error: oauth, error_description: 'x' } : null,
  });
}

describe('installationsService.installFromOAuthPayload (unit, M19)', () => {
  let logger;
  let exchange;

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    exchange = vi.fn(async () => ({ ...EXCHANGED }));
  });

  function build({ current = null, options = {} } = {}) {
    const repo = buildRepo({ current });
    const service = new InstallationsService(repo, logger, {
      portal: PORTAL,
      clientId: 'local.app.1',
      clientSecret: 'secret',
      exchangeRefreshToken: exchange,
      ...options,
    });
    return { repo, service };
  }

  function expectNothingWritten(repo) {
    expect(repo.saveInstallTokens).not.toHaveBeenCalled();
    expect(repo.setMemberId).not.toHaveBeenCalled();
    expect(repo.upsertByPortal).not.toHaveBeenCalled();
    expect(repo.updateTokens).not.toHaveBeenCalled();
  }

  // ── позитив ─────────────────────────────────────────────────────────────────
  it('первая установка: обмен refresh_token → INSERT новой пары + app_token, member_id отдельно', async () => {
    const { repo, service } = build();
    const inst = await service.installFromOAuthPayload(onAppInstall());

    expect(exchange).toHaveBeenCalledWith({
      refreshToken: REFRESH,
      clientId: 'local.app.1',
      clientSecret: 'secret',
    });
    // Пишется НОВАЯ пара из ответа обмена (refresh из payload уже потрачен), не payload.
    expect(repo.saveInstallTokens).toHaveBeenCalledWith({
      id: null,
      portal: PORTAL,
      access: EXCHANGED.accessToken,
      refresh: EXCHANGED.refreshToken,
      applicationToken: APP_TOKEN,
    });
    expect(repo.setMemberId).toHaveBeenCalledWith(1, MEMBER);
    expect(inst.b24ApplicationToken).toBe(APP_TOKEN);
  });

  it('переустановка: UPDATE существующей строки по id', async () => {
    const { repo, service } = build({ current: storedRow({ id: 5, b24ApplicationToken: 'oldapptoken00000' }) });
    await service.installFromOAuthPayload(onAppInstall());
    expect(repo.saveInstallTokens).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
    const verified = logger.info.mock.calls.find(([, msg]) => msg === 'install verified: tokens saved');
    expect(verified[0]).toMatchObject({
      installationId: 5,
      firstInstall: false,
      reinstalled: false,
      applicationTokenChanged: true,
    });
  });

  // M26: после ONAPPUNINSTALL строка осталась (токены NULL, member_id тот же). Новое
  // локальное приложение проходит обычный обмен; saveInstallTokens снимает uninstalled_at.
  it('установка после удаления (M26) → обмен, запись в ту же строку, лог reinstalled:true', async () => {
    const { repo, service } = build({ current: uninstalledRow() });
    await service.installFromOAuthPayload(onAppInstall());

    expect(exchange).toHaveBeenCalledOnce();
    expect(repo.saveInstallTokens).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    const verified = logger.info.mock.calls.find(([, msg]) => msg === 'install verified: tokens saved');
    expect(verified[0]).toMatchObject({ installationId: 1, firstInstall: false, reinstalled: true });
  });

  it('ONAPPUPDATE и event в нижнем регистре принимаются', async () => {
    const { repo, service } = build();
    await service.installFromOAuthPayload(onAppInstall({}, { event: 'onappupdate' }));
    expect(repo.saveInstallTokens).toHaveBeenCalledOnce();
  });

  it('access_token в payload не обязателен: хватает refresh + app_token', async () => {
    const { repo, service } = build();
    await service.installFromOAuthPayload(onAppInstall({ access_token: undefined }));
    expect(repo.saveInstallTokens).toHaveBeenCalledOnce();
  });

  it('домен в другом регистре, с пробелами и конечной точкой → запись в канонический портал', async () => {
    const { repo, service } = build();
    await service.installFromOAuthPayload(onAppInstall({ domain: '  EXAMPLE.Bitrix24.ru. ' }));
    expect(repo.saveInstallTokens).toHaveBeenCalledWith(expect.objectContaining({ portal: PORTAL }));
  });

  it('сохранённый member_id совпал с payload → обмен идёт', async () => {
    const { repo, service } = build({ current: storedRow({ b24MemberId: MEMBER }) });
    await service.installFromOAuthPayload(onAppInstall());
    expect(repo.saveInstallTokens).toHaveBeenCalledOnce();
  });

  it('только application_token, совпал с сохранённым → 200 без записи и без обмена', async () => {
    const current = storedRow();
    const { repo, service } = build({ current });
    const inst = await service.installFromOAuthPayload(
      onAppInstall({ access_token: undefined, refresh_token: undefined }),
    );
    expect(inst).toBe(current);
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it('member_id не записался (миграция не применена) → токены сохранены, warn', async () => {
    const { repo, service } = build();
    repo.setMemberId.mockRejectedValueOnce(Object.assign(new Error('no column'), { code: '42703' }));
    await expect(service.installFromOAuthPayload(onAppInstall())).resolves.toMatchObject({ id: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 1 }),
      expect.stringContaining('member_id not saved'),
    );
  });

  it('логи: только флаги и метаданные, значения токенов не попадают', async () => {
    const { service } = build();
    await service.installFromOAuthPayload(onAppInstall());
    const received = logger.info.mock.calls.find(([, msg]) => msg === 'install request received');
    expect(received[0]).toEqual({
      portal: PORTAL,
      event: 'ONAPPINSTALL',
      hasAccess: true,
      hasRefresh: true,
      hasApplicationToken: true,
      hasMemberId: true,
    });
    const allLogs = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.debug.mock.calls]);
    for (const secret of [APP_TOKEN, REFRESH, ACCESS, EXCHANGED.accessToken, EXCHANGED.refreshToken]) {
      expect(allLogs).not.toContain(secret);
    }
  });

  // ── конфиг (fail-closed 503) ────────────────────────────────────────────────
  it.each([
    ['portal', { portal: null }],
    ['clientId', { clientId: null }],
    ['clientSecret', { clientSecret: '' }],
    ['exchangeRefreshToken', { exchangeRefreshToken: null }],
  ])('не задан %s → ConfigError 503, без чтения БД', async (_label, options) => {
    const { repo, service } = build({ options });
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 503 });
    expect(repo.getDefaultSingleTenant).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it('сервис без опций (как в scripts/lib/bootstrap.js) создаётся, install → 503', async () => {
    const repo = buildRepo();
    const service = new InstallationsService(repo, logger);
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 503 });
  });

  // ── форма payload (400) ─────────────────────────────────────────────────────
  it.each([
    ['пустой payload', {}],
    ['неизвестное событие', { ...onAppInstall(), event: 'ONAPPUNINSTALL' }],
    ['event-массив (дубли ключа)', { ...onAppInstall(), event: ['ONAPPINSTALL'] }],
    ['form-style DOMAIN/AUTH_ID (мастер снят)', { DOMAIN: PORTAL, AUTH_ID: ACCESS, REFRESH_ID: REFRESH }],
    ['auth не объект', { event: 'ONAPPINSTALL', auth: 'x' }],
    ['auth-массив', { event: 'ONAPPINSTALL', auth: [PORTAL] }],
    ['без auth.domain', onAppInstall({ domain: undefined })],
    ['auth.domain-массив', onAppInstall({ domain: [PORTAL, 'evil.example'] })],
    ['refresh_token-массив', onAppInstall({ refresh_token: [REFRESH, REFRESH] })],
    ['application_token-объект', onAppInstall({ application_token: { x: '1' } })],
    ['токен с мусором', onAppInstall({ application_token: 'abc def\n0000' })],
    ['токен слишком короткий', onAppInstall({ refresh_token: 'abc' })],
    ['токенов нет', onAppInstall({ access_token: undefined, refresh_token: undefined, application_token: undefined })],
    ['refresh без application_token', onAppInstall({ application_token: undefined })],
    ['access + app без refresh', onAppInstall({ refresh_token: undefined })],
  ])('%s → 400, ничего не пишется, обмена нет', async (_label, payload) => {
    const { repo, service } = build({ current: storedRow() });
    await expect(service.installFromOAuthPayload(payload)).rejects.toMatchObject({ status: 400 });
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  // ── подлинность (401) ───────────────────────────────────────────────────────
  it('чужой домен → 401 до чтения БД и обмена', async () => {
    const { repo, service } = build();
    await expect(
      service.installFromOAuthPayload(onAppInstall({ domain: 'evil.bitrix24.ru' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(repo.getDefaultSingleTenant).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it.each([
    ['чужой токен', storedRow({ b24ApplicationToken: 'anotherapptoken000' })],
    ['токена в БД нет', storedRow({ b24ApplicationToken: null })],
    ['строки нет (свежая БД)', null],
  ])('только application_token: %s → 401, без записи', async (_label, current) => {
    const { repo, service } = build({ current });
    await expect(
      service.installFromOAuthPayload(onAppInstall({ access_token: undefined, refresh_token: undefined })),
    ).rejects.toMatchObject({ status: 401 });
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it('только application_token после удаления приложения (M26) → 401: токен в БД обнулён', async () => {
    const { repo, service } = build({ current: uninstalledRow() });
    await expect(
      service.installFromOAuthPayload(onAppInstall({ access_token: undefined, refresh_token: undefined })),
    ).rejects.toMatchObject({ status: 401 });
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it('member_id ≠ сохранённому → 401 до обмена (refresh не тратим)', async () => {
    const { repo, service } = build({ current: storedRow({ b24MemberId: 'othermember00000' }) });
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 401 });
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it.each([
    ['client_endpoint чужого портала', { clientEndpoint: 'https://evil.bitrix24.ru/rest/' }],
    ['client_endpoint по http', { clientEndpoint: `http://${PORTAL}/rest/` }],
    ['client_endpoint не URL', { clientEndpoint: 'not a url' }],
    ['member_id ответа ≠ payload', { memberId: 'othermember00000' }],
  ])('ответ обмена: %s → 401, без записи', async (_label, override) => {
    exchange.mockResolvedValueOnce({ ...EXCHANGED, ...override });
    const { repo, service } = build();
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 401 });
    expectNothingWritten(repo);
  });

  // ── классификация отказов обмена ────────────────────────────────────────────
  it.each([
    ['OAUTH_REJECTED (invalid_grant)', oauthError('OAUTH_REJECTED', { oauth: 'invalid_grant', httpStatus: 400 }), 401],
    ['OAUTH_INVALID_CLIENT', oauthError('OAUTH_INVALID_CLIENT', { oauth: 'invalid_client', httpStatus: 401 }), 503],
    ['OAUTH_UNAVAILABLE', oauthError('OAUTH_UNAVAILABLE', { httpStatus: 502 }), 503],
    ['непредвиденная ошибка', new TypeError('boom'), 503],
  ])('%s → %i, без записи', async (_label, err, status) => {
    exchange.mockRejectedValueOnce(err);
    const { repo, service } = build();
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status });
    expectNothingWritten(repo);
  });

  it('invalid_client → error-лог с подсказкой сверить client creds', async () => {
    exchange.mockRejectedValueOnce(oauthError('OAUTH_INVALID_CLIENT', { oauth: 'invalid_client' }));
    const { service } = build();
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('B24_CLIENT_ID / B24_CLIENT_SECRET'),
    );
  });

  it.each([
    ['refreshToken', { refreshToken: null }],
    ['memberId', { memberId: null }],
    ['clientEndpoint', { clientEndpoint: null }],
  ])('ответ обмена без %s → 503 (старый refresh потрачен, не подставляем)', async (_label, override) => {
    exchange.mockResolvedValueOnce({ ...EXCHANGED, ...override });
    const { repo, service } = build();
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 503 });
    expectNothingWritten(repo);
  });

  // ── мисконфиг и сбои записи ─────────────────────────────────────────────────
  it('строка в БД другого портала → 503, без обмена и без двойника', async () => {
    const { repo, service } = build({ current: storedRow({ b24Portal: 'old.bitrix24.ru' }) });
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 503 });
    expect(exchange).not.toHaveBeenCalled();
    expectNothingWritten(repo);
  });

  it('строка с тем же порталом в другом регистре — не мисконфиг', async () => {
    const { repo, service } = build({ current: storedRow({ b24Portal: 'Example.Bitrix24.ru' }) });
    await service.installFromOAuthPayload(onAppInstall());
    expect(repo.saveInstallTokens).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('БД недоступна до обмена → ошибка, refresh не потрачен', async () => {
    const { repo, service } = build();
    repo.getDefaultSingleTenant.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toThrow('ECONNREFUSED');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('запись после обмена упала → error-лог «пересохраните форму», ошибка наверх', async () => {
    const { repo, service } = build();
    repo.saveInstallTokens.mockRejectedValueOnce(new Error('deadlock'));
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toThrow('deadlock');
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('re-save the app form'),
    );
  });

  it('строка исчезла между чтением и записью → 500 INSTALL_SAVE_FAILED', async () => {
    const { repo, service } = build({ current: storedRow() });
    repo.saveInstallTokens.mockResolvedValueOnce(null);
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({
      code: 'INSTALL_SAVE_FAILED',
      status: 500,
    });
  });
});

describe('installationsService.saveRefreshedTokens (unit)', () => {
  function build(repoOverrides = {}) {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const repo = {
      casRefreshedTokens: vi.fn(async (id) => ({ id })),
      setMemberId: vi.fn(async () => true),
      ...repoOverrides,
    };
    return { repo, logger, service: new InstallationsService(repo, logger) };
  }

  it('CAS по старому refresh + member_id отдельным вызовом', async () => {
    const { repo, service } = build();
    const saved = await service.saveRefreshedTokens(7, {
      oldRefresh: 'r0',
      access: 'a1',
      refresh: 'r1',
      memberId: 'm1',
    });
    expect(saved).toEqual({ id: 7 });
    expect(repo.casRefreshedTokens).toHaveBeenCalledWith(7, { oldRefresh: 'r0', access: 'a1', refresh: 'r1' });
    expect(repo.setMemberId).toHaveBeenCalledWith(7, 'm1');
  });

  it('CAS не сработал (refresh сменился параллельно) → warn, null, без исключения', async () => {
    const { logger, service } = build({ casRefreshedTokens: vi.fn(async () => null) });
    await expect(
      service.saveRefreshedTokens(7, { oldRefresh: 'stale', access: 'a', refresh: 'r' }),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { installationId: 7 },
      expect.stringContaining('changed concurrently'),
    );
  });

  it('member_id не записался (миграция 0008 не применена) → warn, токены сохранены', async () => {
    const err = Object.assign(new Error('column "b24_member_id" does not exist'), { code: '42703' });
    const { logger, service } = build({ setMemberId: vi.fn(async () => { throw err; }) });
    await expect(
      service.saveRefreshedTokens(7, { oldRefresh: 'r0', access: 'a', refresh: 'r', memberId: 'm' }),
    ).resolves.toEqual({ id: 7 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 7, err: expect.objectContaining({ code: '42703' }) }),
      expect.stringContaining('member_id not saved'),
    );
  });

  it('без member_id в ответе обмена → setMemberId не вызывается', async () => {
    const { repo, service } = build();
    await service.saveRefreshedTokens(7, { oldRefresh: 'r0', access: 'a', refresh: 'r' });
    expect(repo.setMemberId).not.toHaveBeenCalled();
  });
});

describe('installationsService.markUninstalled (unit, M26)', () => {
  function build(current, { marked } = {}) {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const repo = {
      getDefaultSingleTenant: vi.fn(async () => current),
      // Как SQL: токены → NULL, uninstalled_at — COALESCE(прежний, now()).
      markUninstalled: vi.fn(async (id) => (marked !== undefined ? marked : new Installation({
        ...current,
        id,
        b24AccessToken: null,
        b24RefreshToken: null,
        b24ApplicationToken: null,
        uninstalledAt: current.uninstalledAt ?? new Date(),
      }))),
    };
    return { repo, logger, service: new InstallationsService(repo, logger) };
  }

  function installed() {
    return new Installation({
      id: 7,
      b24Portal: PORTAL,
      b24AccessToken: ACCESS,
      b24RefreshToken: REFRESH,
      b24ApplicationToken: APP_TOKEN,
      b24MemberId: MEMBER,
    });
  }

  it('делегирует в репозиторий по id строки и токену события → { installation, alreadyUninstalled:false }, токены не в логах', async () => {
    const { repo, logger, service } = build(installed());

    const result = await service.markUninstalled({ applicationToken: APP_TOKEN });

    expect(repo.markUninstalled).toHaveBeenCalledWith(7, { applicationToken: APP_TOKEN });
    expect(result.alreadyUninstalled).toBe(false);
    expect(result.installation).toMatchObject({ id: 7, b24ApplicationToken: null, b24MemberId: MEMBER });
    expect(result.installation.isUninstalled()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { installationId: 7, alreadyUninstalled: false },
      'app uninstalled: tokens cleared',
    );
    const allLogs = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.debug.mock.calls]);
    for (const secret of [APP_TOKEN, REFRESH, ACCESS]) expect(allLogs).not.toContain(secret);
  });

  it('повтор (строка уже помечена) → alreadyUninstalled:true, запрос идемпотентен', async () => {
    const { repo, service } = build(uninstalledRow({ id: 7 }));

    const result = await service.markUninstalled({ applicationToken: APP_TOKEN });

    expect(repo.markUninstalled).toHaveBeenCalledWith(7, { applicationToken: APP_TOKEN });
    expect(result.alreadyUninstalled).toBe(true);
  });

  it('строки installations нет → null и warn, репозиторий не пишет', async () => {
    const { repo, logger, service } = build(null);

    await expect(service.markUninstalled({ applicationToken: APP_TOKEN })).resolves.toBeNull();
    expect(repo.markUninstalled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('app uninstall: no installation row — nothing to clear');
  });

  it('CAS не прошёл (переустановка сменила токен или строка исчезла) → { stale, installationId } и warn, info не пишется', async () => {
    const { logger, service } = build(installed(), { marked: null });

    await expect(service.markUninstalled({ applicationToken: APP_TOKEN })).resolves.toEqual({
      stale: true,
      installationId: 7,
    });
    expect(logger.warn).toHaveBeenCalledWith({ installationId: 7 }, expect.stringContaining('changed concurrently'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'app uninstalled: tokens cleared');
  });
});
