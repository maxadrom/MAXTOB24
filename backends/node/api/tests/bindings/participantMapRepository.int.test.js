// DB-тест M21: participant_map пишется только для нового участника или при смене имени
// (до M21 — UPDATE на каждое входящее). findDisplayName (M23) видит последнее имя.
// Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../../src/modules/bindings/participantMapRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

describe.skipIf(shouldSkipDb())('ParticipantMapRepository.upsert (M21)', () => {
  let pool;
  let repo;
  let bindingId;

  async function xmin() {
    const { rows } = await pool.query(
      'SELECT xmin::text AS v FROM participant_map WHERE binding_id = $1 AND max_user_id = $2',
      [bindingId, '1000001'],
    );
    return rows[0]?.v ?? null;
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new ParticipantMapRepository(pool, null);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m21-pm.bitrix24.test') RETURNING id`,
    );
    const { binding } = await new BindingsRepository(pool, null)
      .upsertForMaxChat({ installationId: inst.id, maxChatId: '-1' });
    bindingId = binding.id;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('новый участник → строка; то же имя → null и строка не переписана', async () => {
    const created = await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег' });
    expect(created).toMatchObject({ maxUserId: '1000001', maxDisplayName: 'Олег' });
    const version = await xmin();

    await expect(repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег' })).resolves.toBeNull();
    expect(await xmin()).toBe(version);
  });

  it('смена имени → строка с новым именем, findDisplayName видит его', async () => {
    await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег' });

    const renamed = await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег С.' });

    expect(renamed).toMatchObject({ maxDisplayName: 'Олег С.' });
    await expect(repo.findDisplayName(bindingId, 1000001)).resolves.toBe('Олег С.');
  });

  it('null-имя → старое имя сохраняется, записи нет', async () => {
    await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег' });

    await expect(repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: null })).resolves.toBeNull();
    await expect(repo.findDisplayName(bindingId, 1000001)).resolves.toBe('Олег');
  });

  it('участник без имени → имя появляется со следующего сообщения', async () => {
    await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: null });

    const named = await repo.upsert({ bindingId, maxUserId: 1000001, maxDisplayName: 'Олег' });

    expect(named).toMatchObject({ maxDisplayName: 'Олег' });
  });
});
