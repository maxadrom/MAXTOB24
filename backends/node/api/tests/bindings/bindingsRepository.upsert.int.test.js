// DB-тест M21: атомарный онбординг привязки (BindingsRepository.upsertForMaxChat).
// Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

describe.skipIf(shouldSkipDb())('BindingsRepository.upsertForMaxChat (M21)', () => {
  let pool;
  let repo;
  let installationId;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new BindingsRepository(pool, null);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m21.bitrix24.test') RETURNING id`,
    );
    installationId = inst.id;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('новый чат → created: true, привязка сразу с connector_chat_id и названием', async () => {
    const { binding, created } = await repo.upsertForMaxChat({
      installationId,
      maxChatId: '-1',
      maxChatTitle: 'Группа',
    });

    expect(created).toBe(true);
    expect(binding).toMatchObject({ maxChatId: '-1', connectorChatId: 'max:-1', maxChatTitle: 'Группа' });
    expect(binding.isReadyForRouting()).toBe(true);
  });

  it('повтор → created: false, та же строка; название при конфликте не перетирается', async () => {
    const first = await repo.upsertForMaxChat({ installationId, maxChatId: '-1', maxChatTitle: 'Группа' });
    const second = await repo.upsertForMaxChat({ installationId, maxChatId: '-1', maxChatTitle: 'Другое' });

    expect(second.created).toBe(false);
    expect(second.binding.id).toBe(first.binding.id);
    expect(second.binding).toMatchObject({ connectorChatId: 'max:-1', maxChatTitle: 'Группа' });
  });

  it('привязка без connector_chat_id (сбой онбординга до M21) → дозаполняется, created: false', async () => {
    // Старая схема: до миграции 0012 колонка допускала NULL.
    await pool.query('ALTER TABLE chat_bindings ALTER COLUMN connector_chat_id DROP NOT NULL');
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO chat_bindings (installation_id, max_chat_id) VALUES ($1, '-1') RETURNING id`,
        [installationId],
      );

      const { binding, created } = await repo.upsertForMaxChat({ installationId, maxChatId: '-1' });

      expect(created).toBe(false);
      expect(binding.id).toBe(row.id);
      expect(binding.connectorChatId).toBe('max:-1');
    } finally {
      await pool.query('DELETE FROM chat_bindings');
      await pool.query('ALTER TABLE chat_bindings ALTER COLUMN connector_chat_id SET NOT NULL');
    }
  });

  it('гонка двух первых сообщений → одна строка, обе привязки готовы, created ровно у одной', async () => {
    const results = await Promise.all([
      repo.upsertForMaxChat({ installationId, maxChatId: '-1' }),
      repo.upsertForMaxChat({ installationId, maxChatId: '-1' }),
    ]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0].binding.id).toBe(results[1].binding.id);
    expect(results.every((r) => r.binding.isReadyForRouting())).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chat_bindings');
    expect(rows[0].n).toBe(1);
  });
});
