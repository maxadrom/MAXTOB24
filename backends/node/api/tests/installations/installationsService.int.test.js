// Integration-тесты installationsService: seedSingleTenant / clearConnectorMetadata и
// install-callback (M19) на реальной БД.
// Используем реальный pg-pool (через tests/helpers/db.js). Если Postgres
// недоступен — suite скипается.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallationsRepository } from '../../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../../src/modules/installations/installationsService.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';
import {
  closeTestPool,
  getTestPool,
  shouldSkipDb,
  truncateAll,
} from '../helpers/db.js';

const PORTAL = 'example.bitrix24.ru';

describe.skipIf(shouldSkipDb())('installationsService.seedSingleTenant (integration)', () => {
  let pool;
  let repo;
  let service;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new InstallationsRepository(pool, null);
    service = new InstallationsService(repo, null);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) seedSingleTenant на пустой БД создаёт запись с метаданными', async () => {
    const seeded = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: null,
    });

    expect(seeded.b24Portal).toBe(PORTAL);
    expect(seeded.olLineId).toBe(42);
    expect(seeded.connectorId).toBe('max_b24');
    expect(seeded.maxBotId).toBeNull();
    expect(seeded.b24AccessToken).toBeNull();
  });

  it('2) повторный seedSingleTenant с теми же значениями: id тот же, метаданные те же', async () => {
    const first = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
    });
    const second = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
    });

    expect(second.id).toBe(first.id);
    expect(second.olLineId).toBe(42);
    expect(second.connectorId).toBe('max_b24');
  });

  it('3) seedSingleTenant поверх записи с токенами: токены НЕ затираются', async () => {
    const seeded = await service.seedSingleTenant({ portal: PORTAL });
    await repo.updateTokens(seeded.id, {
      access: 'access-tok',
      refresh: 'refresh-tok',
      applicationToken: 'app-tok',
    });

    const updated = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
    });

    expect(updated.b24AccessToken).toBe('access-tok');
    expect(updated.b24RefreshToken).toBe('refresh-tok');
    expect(updated.b24ApplicationToken).toBe('app-tok');
    expect(updated.connectorId).toBe('max_b24');
    expect(updated.olLineId).toBe(42);
  });

  it('4) seedSingleTenant с maxBotId=null поверх существующего maxBotId — не затирает', async () => {
    await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: '100000001',
    });
    const updated = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: null,
    });

    expect(updated.maxBotId).toBe('100000001');
  });

  it('5) clearConnectorMetadata после seed: ol_line_id/connector_id/max_bot_id = NULL, токены сохранены', async () => {
    const seeded = await service.seedSingleTenant({
      portal: PORTAL,
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: '100000001',
    });
    await repo.updateTokens(seeded.id, {
      access: 'keep-access',
      refresh: 'keep-refresh',
      applicationToken: null,
    });

    const cleared = await service.clearConnectorMetadata();

    expect(cleared.id).toBe(seeded.id);
    expect(cleared.olLineId).toBeNull();
    expect(cleared.connectorId).toBeNull();
    expect(cleared.maxBotId).toBeNull();
    expect(cleared.b24AccessToken).toBe('keep-access');
    expect(cleared.b24RefreshToken).toBe('keep-refresh');
  });

  it('clearConnectorMetadata на пустой БД возвращает null без ошибки', async () => {
    const result = await service.clearConnectorMetadata();
    expect(result).toBeNull();
  });
});

describe.skipIf(shouldSkipDb())('installationsService.installFromOAuthPayload (integration, M19)', () => {
  const MEMBER = 'memberid000000000000000000000001';
  let pool;
  let repo;
  let exchange;
  let service;

  function onAppInstall(authOverrides = {}) {
    return {
      event: 'ONAPPINSTALL',
      data: { VERSION: '1' },
      auth: {
        domain: PORTAL,
        access_token: 'payloadaccess000',
        refresh_token: 'payloadrefresh00',
        application_token: 'apptoken00000001',
        member_id: MEMBER,
        ...authOverrides,
      },
    };
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new InstallationsRepository(pool, null);
    exchange = vi.fn(async () => ({
      accessToken: 'exchangedaccess1',
      refreshToken: 'exchangedrefresh',
      memberId: MEMBER,
      clientEndpoint: `https://${PORTAL}/rest/`,
    }));
    service = new InstallationsService(repo, null, {
      portal: PORTAL,
      clientId: 'local.app.1',
      clientSecret: 'secret',
      exchangeRefreshToken: exchange,
    });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  async function rows() {
    const res = await pool.query(
      'SELECT b24_portal, b24_access_token, b24_refresh_token, b24_application_token, b24_member_id FROM installations ORDER BY id',
    );
    return res.rows;
  }

  it('первая установка на пустой БД: строка с новой парой из обмена, app_token и member_id', async () => {
    const inst = await service.installFromOAuthPayload(onAppInstall());
    expect(inst.b24Portal).toBe(PORTAL);
    expect(await rows()).toEqual([
      {
        b24_portal: PORTAL,
        b24_access_token: 'exchangedaccess1',
        b24_refresh_token: 'exchangedrefresh',
        b24_application_token: 'apptoken00000001',
        b24_member_id: MEMBER,
      },
    ]);
  });

  it('переустановка поверх строки скриптов (seed): та же строка, метаданные целы, двойника нет', async () => {
    const seeded = await service.seedSingleTenant({ portal: PORTAL, olLineId: 42, connectorId: 'max_b24' });
    const inst = await service.installFromOAuthPayload(onAppInstall({ domain: 'Example.Bitrix24.RU.' }));
    expect(inst.id).toBe(seeded.id);
    expect(inst.olLineId).toBe(42);
    expect(inst.connectorId).toBe('max_b24');
    expect(await rows()).toHaveLength(1);
  });

  it('отказ OAuth (чужая пара) → 401, строка не создана', async () => {
    exchange.mockRejectedValueOnce(
      new B24ApiError('OAUTH_REJECTED', 'bad', { body: { error: 'invalid_grant' } }),
    );
    await expect(service.installFromOAuthPayload(onAppInstall())).rejects.toMatchObject({ status: 401 });
    expect(await rows()).toEqual([]);
  });

  it('payload без пользовательских токенов на свежей БД → 401, строка не создана', async () => {
    await expect(
      service.installFromOAuthPayload(onAppInstall({ access_token: undefined, refresh_token: undefined })),
    ).rejects.toMatchObject({ status: 401 });
    expect(await rows()).toEqual([]);
  });

  it('payload без токенов → 400, строка не создана', async () => {
    await expect(
      service.installFromOAuthPayload(
        onAppInstall({ access_token: undefined, refresh_token: undefined, application_token: undefined }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toEqual([]);
  });

  it('только app_token, совпавший с сохранённым → токены не меняются', async () => {
    await service.installFromOAuthPayload(onAppInstall());
    const before = await rows();
    await service.installFromOAuthPayload(onAppInstall({ access_token: undefined, refresh_token: undefined }));
    expect(await rows()).toEqual(before);
  });

  it('рефреш после установки: CAS по сохранённому refresh проходит, по устаревшему — нет', async () => {
    const inst = await service.installFromOAuthPayload(onAppInstall());
    await expect(
      service.saveRefreshedTokens(inst.id, { oldRefresh: 'stale', access: 'x00000000', refresh: 'y00000000' }),
    ).resolves.toBeNull();
    const saved = await service.saveRefreshedTokens(inst.id, {
      oldRefresh: 'exchangedrefresh',
      access: 'refreshedaccess1',
      refresh: 'refreshedrefresh',
      memberId: MEMBER,
    });
    expect(saved.b24RefreshToken).toBe('refreshedrefresh');
    expect(saved.b24ApplicationToken).toBe('apptoken00000001');
  });
});
