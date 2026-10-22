// Integration-тесты записи токенов в installations (M19): атомарная запись install-callback'а,
// compare-and-swap рефреша и best-effort member_id; пометка удаления приложения (M26).
// Реальный pg-pool; без Postgres — скип.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { InstallationsRepository } from '../../src/modules/installations/installationsRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

const PORTAL = 'example.bitrix24.ru';

describe.skipIf(shouldSkipDb())('installationsRepository: токены и member_id (integration)', () => {
  let pool;
  let repo;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new InstallationsRepository(pool, null);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  async function countRows() {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM installations');
    return rows[0].n;
  }

  it('saveInstallTokens без id на пустой БД — создаёт строку с тремя токенами', async () => {
    const inst = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'a1',
      refresh: 'r1',
      applicationToken: 'app1',
    });
    expect(inst).toMatchObject({
      b24Portal: PORTAL,
      b24AccessToken: 'a1',
      b24RefreshToken: 'r1',
      b24ApplicationToken: 'app1',
      b24MemberId: null,
    });
    expect(await countRows()).toBe(1);
  });

  it('saveInstallTokens по id — заменяет все три токена (без COALESCE), метаданные не трогает', async () => {
    const seeded = await repo.upsertByPortal({ portal: PORTAL });
    await repo.updateConnectorMetadata(seeded.id, { olLineId: 42, connectorId: 'max_b24' });
    await repo.updateTokens(seeded.id, { access: 'old-a', refresh: 'old-r', applicationToken: 'old-app' });

    const inst = await repo.saveInstallTokens({
      id: seeded.id,
      access: 'a2',
      refresh: 'r2',
      applicationToken: 'app2',
    });
    expect(inst).toMatchObject({
      id: seeded.id,
      b24AccessToken: 'a2',
      b24RefreshToken: 'r2',
      b24ApplicationToken: 'app2',
      olLineId: 42,
      connectorId: 'max_b24',
    });
    expect(await countRows()).toBe(1);
  });

  it('saveInstallTokens по несуществующему id → null', async () => {
    const inst = await repo.saveInstallTokens({
      id: 999_999,
      access: 'a',
      refresh: 'r',
      applicationToken: 'app',
    });
    expect(inst).toBeNull();
  });

  it('casRefreshedTokens: старый refresh совпал → пара заменена, application_token не тронут', async () => {
    const seeded = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'a1',
      refresh: 'r1',
      applicationToken: 'app1',
    });
    const inst = await repo.casRefreshedTokens(seeded.id, {
      oldRefresh: 'r1',
      access: 'a2',
      refresh: 'r2',
    });
    expect(inst).toMatchObject({
      b24AccessToken: 'a2',
      b24RefreshToken: 'r2',
      b24ApplicationToken: 'app1',
    });
  });

  it('casRefreshedTokens: refresh уже сменился параллельно → null, свежая пара не затёрта', async () => {
    const seeded = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'fresh-a',
      refresh: 'fresh-r',
      applicationToken: 'app',
    });
    const inst = await repo.casRefreshedTokens(seeded.id, {
      oldRefresh: 'stale-r',
      access: 'late-a',
      refresh: 'late-r',
    });
    expect(inst).toBeNull();
    const current = await repo.getDefaultSingleTenant();
    expect(current.b24AccessToken).toBe('fresh-a');
    expect(current.b24RefreshToken).toBe('fresh-r');
  });

  it('setMemberId: пишет member_id, повтор того же значения — no-op, updated_at не трогает', async () => {
    const seeded = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'a',
      refresh: 'r',
      applicationToken: 'app',
    });
    expect(await repo.setMemberId(seeded.id, 'member-1')).toBe(true);
    expect(await repo.setMemberId(seeded.id, 'member-1')).toBe(false);

    const current = await repo.getDefaultSingleTenant();
    expect(current.b24MemberId).toBe('member-1');
    expect(current.updatedAt).toEqual(seeded.updatedAt);
  });

  // ── M26: удаление приложения (ONAPPUNINSTALL) ─────────────────────────────────
  async function seedInstalled() {
    const seeded = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'a1',
      refresh: 'r1',
      applicationToken: 'app1',
    });
    await repo.setMemberId(seeded.id, 'member-1');
    await repo.updateConnectorMetadata(seeded.id, { olLineId: 42, connectorId: 'max_b24', maxBotId: '100000001' });
    return seeded;
  }

  async function uninstalledAt(id) {
    const { rows } = await pool.query('SELECT uninstalled_at FROM installations WHERE id = $1', [id]);
    return rows[0].uninstalled_at;
  }

  it('markUninstalled: три токена → NULL, uninstalled_at стоит; портал, member_id и метаданные коннектора целы', async () => {
    const seeded = await seedInstalled();
    expect(seeded.isUninstalled()).toBe(false);

    const inst = await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    expect(inst).toMatchObject({
      id: seeded.id,
      b24Portal: PORTAL,
      b24AccessToken: null,
      b24RefreshToken: null,
      b24ApplicationToken: null,
      b24MemberId: 'member-1',
      olLineId: 42,
      connectorId: 'max_b24',
      maxBotId: '100000001',
    });
    expect(inst.uninstalledAt).toBeInstanceOf(Date);
    expect(inst.isUninstalled()).toBe(true);
    expect(await countRows()).toBe(1);
  });

  it('markUninstalled повторно: uninstalled_at не сдвигается', async () => {
    const seeded = await seedInstalled();
    const first = await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });
    await pool.query('SELECT pg_sleep(0.01)');

    const second = await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    expect(second.uninstalledAt).toEqual(first.uninstalledAt);
    expect(await uninstalledAt(seeded.id)).toEqual(first.uninstalledAt);
  });

  it('markUninstalled по несуществующему id → null', async () => {
    await expect(repo.markUninstalled(999_999, { applicationToken: 'app1' })).resolves.toBeNull();
  });

  it('markUninstalled — CAS по application_token: переустановка записала новый токен → null, строка не тронута', async () => {
    const seeded = await seedInstalled();
    // Между проверкой токена события (app1) и UPDATE install-callback нового приложения.
    const reinstalled = await repo.saveInstallTokens({ id: seeded.id, access: 'a2', refresh: 'r2', applicationToken: 'app2' });

    const inst = await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    expect(inst).toBeNull();
    const current = await repo.getDefaultSingleTenant();
    expect(current).toMatchObject({ b24AccessToken: 'a2', b24RefreshToken: 'r2', b24ApplicationToken: 'app2', uninstalledAt: null });
    expect(current.updatedAt).toEqual(reinstalled.updatedAt);
  });

  it('markUninstalled без токена события и с токеном в БД → null (не стирает вслепую)', async () => {
    const seeded = await seedInstalled();

    await expect(repo.markUninstalled(seeded.id)).resolves.toBeNull();
    await expect(repo.markUninstalled(seeded.id, { applicationToken: null })).resolves.toBeNull();
    expect(await repo.getDefaultSingleTenant()).toMatchObject({ b24ApplicationToken: 'app1', uninstalledAt: null });
  });

  it('markUninstalled: токена в БД нет (событие сверено по env-fallback) → помечает', async () => {
    const seeded = await repo.upsertByPortal({ portal: PORTAL });
    expect(seeded.b24ApplicationToken).toBeNull();

    const inst = await repo.markUninstalled(seeded.id, { applicationToken: 'env-token' });

    expect(inst).toMatchObject({ id: seeded.id, b24ApplicationToken: null });
    expect(inst.isUninstalled()).toBe(true);
  });

  it('saveInstallTokens по id после удаления → новые токены, uninstalled_at снят', async () => {
    const seeded = await seedInstalled();
    await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    const inst = await repo.saveInstallTokens({
      id: seeded.id,
      access: 'a2',
      refresh: 'r2',
      applicationToken: 'app2',
    });

    expect(inst).toMatchObject({ b24AccessToken: 'a2', b24ApplicationToken: 'app2', uninstalledAt: null });
    expect(inst.isUninstalled()).toBe(false);
    expect(await uninstalledAt(seeded.id)).toBeNull();
  });

  it('saveInstallTokens без id (INSERT … ON CONFLICT) после удаления → uninstalled_at снят', async () => {
    const seeded = await seedInstalled();
    await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    const inst = await repo.saveInstallTokens({
      portal: PORTAL,
      access: 'a3',
      refresh: 'r3',
      applicationToken: 'app3',
    });

    expect(inst).toMatchObject({ id: seeded.id, b24RefreshToken: 'r3', uninstalledAt: null });
    expect(await countRows()).toBe(1);
  });

  it('casRefreshedTokens после удаления → null: refresh уже NULL, пара не воскресает', async () => {
    const seeded = await seedInstalled();
    await repo.markUninstalled(seeded.id, { applicationToken: 'app1' });

    const inst = await repo.casRefreshedTokens(seeded.id, { oldRefresh: 'r1', access: 'late-a', refresh: 'late-r' });

    expect(inst).toBeNull();
    const current = await repo.getDefaultSingleTenant();
    expect(current).toMatchObject({ b24AccessToken: null, b24RefreshToken: null });
    expect(current.isUninstalled()).toBe(true);
  });
});
