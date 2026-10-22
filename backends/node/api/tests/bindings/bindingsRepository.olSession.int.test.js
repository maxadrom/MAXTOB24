// DB-тест M25: guard'ы SQL сессии OL в BindingsRepository (updateOlSession,
// markOlSessionClosed, clearOlClosedSession); M27 — флаг 0 без номера сессии
// (markOlSessionClosedUnknown). Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

describe.skipIf(shouldSkipDb())('BindingsRepository — сессия OL (M25)', () => {
  let pool;
  let repo;
  let id;

  async function cols() {
    const { rows } = await pool.query(
      'SELECT ol_session_id, ol_closed_session_id FROM chat_bindings WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function setCols(olSessionId, olClosedSessionId) {
    await pool.query(
      'UPDATE chat_bindings SET ol_session_id = $2, ol_closed_session_id = $3 WHERE id = $1',
      [id, olSessionId, olClosedSessionId],
    );
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new BindingsRepository(pool, null);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m25.bitrix24.test') RETURNING id`,
    );
    const { binding } = await repo.upsertForMaxChat({ installationId: inst.id, maxChatId: '-1' });
    await repo.updateB24ChatId(binding.id, '21180');
    id = binding.id;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('updateOlSession: NULL → запомнена (числом); та же сессия → null; растёт только вверх', async () => {
    const first = await repo.updateOlSession(id, 16340);
    expect(first).toMatchObject({ olSessionId: 16340, olClosedSessionId: null });

    expect(await repo.updateOlSession(id, 16340)).toBeNull();
    expect(await repo.updateOlSession(id, 16338)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: 16340, ol_closed_session_id: null });

    await repo.updateOlSession(id, 16342);
    expect(await cols()).toEqual({ ol_session_id: 16342, ol_closed_session_id: null });
  });

  it('updateOlSession: флаг снимается только сессией новее закрытой (строго)', async () => {
    await setCols(16340, 16340);

    expect(await repo.updateOlSession(id, 16340)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: 16340, ol_closed_session_id: 16340 });

    const updated = await repo.updateOlSession(id, 16342);
    expect(updated).toMatchObject({ olSessionId: 16342, olClosedSessionId: null });
  });

  it('markOlSessionClosed: NULL-сессия и текущая → флаг; дубль и устаревший → null', async () => {
    const marked = await repo.markOlSessionClosed(id, 16340);
    expect(marked).toMatchObject({ olSessionId: 16340, olClosedSessionId: 16340 });

    expect(await repo.markOlSessionClosed(id, 16340)).toBeNull();

    await setCols(16342, null);
    expect(await repo.markOlSessionClosed(id, 16340)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: 16342, ol_closed_session_id: null });

    expect(await repo.markOlSessionClosed(id, 16344)).toMatchObject({ olSessionId: 16344, olClosedSessionId: 16344 });
  });

  it('clearOlClosedSession: compare-and-clear; GREATEST пропускает NULL', async () => {
    await setCols(16340, 16340);

    expect(await repo.clearOlClosedSession(id, 16338, 16342)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: 16340, ol_closed_session_id: 16340 });

    const cleared = await repo.clearOlClosedSession(id, 16340, null);
    expect(cleared).toMatchObject({ olSessionId: 16340, olClosedSessionId: null });

    await setCols(null, 16340);
    await repo.clearOlClosedSession(id, 16340, 16342);
    expect(await cols()).toEqual({ ol_session_id: 16342, ol_closed_session_id: null });
  });

  // ─── M27: флаг 0 — сессия закрыта, номер неизвестен ────────────────────────

  it('M27 markOlSessionClosedUnknown: ol_session_id NULL → флаг 0; уже взведён → null', async () => {
    const marked = await repo.markOlSessionClosedUnknown(id);
    expect(marked).toMatchObject({ olSessionId: null, olClosedSessionId: 0 });
    expect(marked.needsSessionOpener()).toBe(true);
    expect(await cols()).toEqual({ ol_session_id: null, ol_closed_session_id: 0 });

    expect(await repo.markOlSessionClosedUnknown(id)).toBeNull();

    await setCols(null, 16340);
    expect(await repo.markOlSessionClosedUnknown(id)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: null, ol_closed_session_id: 16340 });
  });

  it('M27 markOlSessionClosedUnknown: сессия известна (входящее её уже открыло) → null, флага нет', async () => {
    await setCols(16340, null);

    expect(await repo.markOlSessionClosedUnknown(id)).toBeNull();
    expect(await cols()).toEqual({ ol_session_id: 16340, ol_closed_session_id: null });
  });

  it('M27 флаг 0: clearOlClosedSession(0, sid) снимает и запоминает сессию', async () => {
    await setCols(null, 0);

    expect(await repo.clearOlClosedSession(id, 16340, 77)).toBeNull();
    const cleared = await repo.clearOlClosedSession(id, 0, 77);
    expect(cleared).toMatchObject({ olSessionId: 77, olClosedSessionId: null });
  });

  it('M27 флаг 0: updateOlSession(sid > 0) снимает; markOlSessionClosed(S) перезаписывает номером', async () => {
    await setCols(null, 0);
    expect(await repo.updateOlSession(id, 5)).toMatchObject({ olSessionId: 5, olClosedSessionId: null });

    await setCols(null, 0);
    expect(await repo.markOlSessionClosed(id, 9)).toMatchObject({ olSessionId: 9, olClosedSessionId: 9 });
    expect(await cols()).toEqual({ ol_session_id: 9, ol_closed_session_id: 9 });
  });
});
