// M26: advisory lock в runMigrations без БД — порядок запросов и судьба соединения.
// Параллельные прогоны на настоящем Postgres — в db-migrations.integration.test.js.

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIGRATIONS_LOCK_KEY, runMigrations } from '../../src/shared/db/runMigrations.js';

const silentLogger = {
  child: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
};

// Фейковый клиент pg: лок свободен (или занят), 0001 уже применена, unlock может бросить.
function fakePool({ lockFree = true, unlockFails = false, failOn = null } = {}) {
  const calls = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql, params) => {
      calls.push(sql.trim().split('\n')[0]);
      if (failOn && sql.includes(failOn)) throw new Error(`boom: ${failOn}`);
      if (sql.startsWith('SELECT pg_try_advisory_lock')) {
        expect(params).toEqual([MIGRATIONS_LOCK_KEY]);
        return { rows: [{ ok: lockFree }] };
      }
      if (sql.startsWith('SELECT pg_advisory_unlock')) {
        if (unlockFails) throw new Error('connection terminated');
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (sql.startsWith('SELECT id FROM schema_migrations')) {
        return { rows: [{ id: '0001_schema_migrations' }] };
      }
      return { rows: [] };
    }),
  };
  return { pool: { connect: vi.fn(async () => client) }, client, calls };
}

describe('runMigrations: advisory lock (M26)', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'm26-migrate-lock-'));
    await copyFile(
      new URL('../../src/shared/db/migrations/0001_schema_migrations.sql', import.meta.url),
      path.join(dir, '0001_schema_migrations.sql'),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('лок берётся до bootstrap 0001 и чтения schema_migrations, отпускается в конце', async () => {
    const { pool, client, calls } = fakePool();
    await runMigrations({ pool, logger: silentLogger, dir });

    expect(calls[0]).toBe('SELECT pg_try_advisory_lock($1) AS ok');
    expect(calls[1]).toMatch(/^-- Bootstrap-миграция/);
    expect(calls[2]).toBe('SELECT id FROM schema_migrations');
    expect(calls.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('лок занят → пишет «waiting» и ждёт блокирующим pg_advisory_lock', async () => {
    const infos = [];
    const logger = {
      child: () => ({ info: (_obj, msg) => infos.push(msg), debug() {}, warn() {}, error() {} }),
    };
    const { pool, calls } = fakePool({ lockFree: false });
    await runMigrations({ pool, logger, dir });

    expect(calls.slice(0, 2)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS ok',
      'SELECT pg_advisory_lock($1)',
    ]);
    expect(infos).toContain('migrations lock busy — waiting for another run');
  });

  it('unlock не удался → соединение уничтожается (release(true)), лок не уходит в пул', async () => {
    const { pool, client } = fakePool({ unlockFails: true });
    await expect(runMigrations({ pool, logger: silentLogger, dir })).resolves.toMatchObject({
      applied: [],
    });
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('сбой прогона → лок всё равно отпускается, ошибка пробрасывается', async () => {
    const { pool, client, calls } = fakePool({ failOn: 'SELECT id FROM schema_migrations' });
    await expect(runMigrations({ pool, logger: silentLogger, dir })).rejects.toThrow(/boom/);
    expect(calls.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(client.release).toHaveBeenCalledWith(false);
  });
});
