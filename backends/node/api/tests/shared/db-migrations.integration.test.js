// Интеграционный тест миграций. Скипается, если Postgres недоступен.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MIGRATIONS_LOCK_KEY, runMigrations } from '../../src/shared/db/runMigrations.js';
import { closeTestPool, getTestPool, shouldSkipDb } from '../helpers/db.js';

const SKIP = shouldSkipDb();
const d = SKIP ? describe.skip : describe;

d('shared/db migrations', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('schema_migrations exists and lists all applied ids', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM schema_migrations ORDER BY id`,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        '0001_schema_migrations',
        '0002_installations',
        '0003_chat_bindings',
        '0004_participant_map',
        '0005_message_log',
        '0008_installations_member_id',
        '0009_drop_starter_tables',
        '0010_chat_bindings_ol_chat_title',
        '0011_chat_bindings_ol_session',
        '0012_chat_bindings_connector_not_null',
        '0013_installations_uninstalled_at',
      ]),
    );
  });

  // 0009 на проде встречает таблицы init.sql стартера: воспроизводим их (FK + DEFAULT из
  // uuid-ossp) и прогоняем SQL миграции — порядок DROP должен пройти без CASCADE.
  it('0009: удаляет таблицы PHP-стартера (с FK) и расширение uuid-ossp', async () => {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS bitrix24account (id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS application_installation (
         id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
         bitrix_24_account_id uuid NOT NULL REFERENCES bitrix24account (id) ON DELETE CASCADE
       )`,
    );
    const sql = await readFile(
      new URL('../../src/shared/db/migrations/0009_drop_starter_tables.sql', import.meta.url),
      'utf8',
    );
    await pool.query(sql);

    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('bitrix24account', 'application_installation')`,
    );
    expect(tables).toEqual([]);
    const { rows: ext } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'`);
    expect(ext).toEqual([]);
  });

  // 0010 на проде встречает привязки с названием и без ol_chat_title: бэкфилл помечает их
  // синхронизированными (старые чаты M24 не трогает). Повторный прогон SQL — идемпотентен.
  it('0010: chat_bindings.ol_chat_title — nullable text, бэкфилл = max_chat_title', async () => {
    const { rows: cols } = await pool.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chat_bindings'
         AND column_name = 'ol_chat_title'
    `);
    expect(cols).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);

    const portal = 'migration-0010.bitrix24.test';
    const { rows: [inst] } = await pool.query(
      'INSERT INTO installations (b24_portal) VALUES ($1) RETURNING id',
      [portal],
    );
    try {
      await pool.query(
        `INSERT INTO chat_bindings (installation_id, max_chat_id, max_chat_title, connector_chat_id)
         VALUES ($1, '-1', 'Название группы с онбординга M10', 'max:-1'),
                ($1, '-2', NULL, 'max:-2')`,
        [inst.id],
      );
      const sql = await readFile(
        new URL('../../src/shared/db/migrations/0010_chat_bindings_ol_chat_title.sql', import.meta.url),
        'utf8',
      );
      await pool.query(sql);

      const { rows } = await pool.query(
        'SELECT max_chat_id, ol_chat_title FROM chat_bindings WHERE installation_id = $1 ORDER BY max_chat_id',
        [inst.id],
      );
      expect(rows).toEqual([
        { max_chat_id: '-1', ol_chat_title: 'Название группы с онбординга M10' },
        { max_chat_id: '-2', ol_chat_title: null },
      ]);
    } finally {
      await pool.query('DELETE FROM installations WHERE id = $1', [inst.id]);
    }
  });

  // 0011 (M25): сессии OL на привязке. integer (не bigint — pg отдал бы строку), nullable,
  // без бэкфилла: NULL = сессия неизвестна, опенер не нужен.
  it('0011: chat_bindings.ol_session_id / ol_closed_session_id — nullable integer', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chat_bindings'
         AND column_name IN ('ol_session_id', 'ol_closed_session_id')
       ORDER BY column_name
    `);
    expect(rows).toEqual([
      { column_name: 'ol_closed_session_id', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'ol_session_id', data_type: 'integer', is_nullable: 'YES' },
    ]);
  });

  // 0012 (M21): привязка без connector_chat_id (сбой онбординга до M21) дозаполняется
  // форматом 'max:<chatId>', затем колонка становится NOT NULL. Воспроизводим старую схему
  // (DROP NOT NULL) и прогоняем SQL миграции.
  it('0012: chat_bindings.connector_chat_id — бэкфилл max:<chatId> и NOT NULL', async () => {
    const portal = 'migration-0012.bitrix24.test';
    const { rows: [inst] } = await pool.query(
      'INSERT INTO installations (b24_portal) VALUES ($1) RETURNING id',
      [portal],
    );
    const sql = await readFile(
      new URL('../../src/shared/db/migrations/0012_chat_bindings_connector_not_null.sql', import.meta.url),
      'utf8',
    );
    try {
      await pool.query('ALTER TABLE chat_bindings ALTER COLUMN connector_chat_id DROP NOT NULL');
      await pool.query(
        `INSERT INTO chat_bindings (installation_id, max_chat_id, connector_chat_id)
         VALUES ($1, '-1', NULL), ($1, '-2', 'max:-2')`,
        [inst.id],
      );
      await pool.query(sql);

      const { rows } = await pool.query(
        'SELECT max_chat_id, connector_chat_id FROM chat_bindings WHERE installation_id = $1 ORDER BY max_chat_id',
        [inst.id],
      );
      expect(rows).toEqual([
        { max_chat_id: '-1', connector_chat_id: 'max:-1' },
        { max_chat_id: '-2', connector_chat_id: 'max:-2' },
      ]);
      const { rows: cols } = await pool.query(`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'chat_bindings'
           AND column_name = 'connector_chat_id'
      `);
      expect(cols).toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await pool.query('DELETE FROM installations WHERE id = $1', [inst.id]);
      await pool.query(sql);
    }
  });

  it('0008: installations.b24_member_id — nullable text', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'installations'
         AND column_name = 'b24_member_id'
    `);
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  // 0013 (M26): пометка удаления приложения Б24. Без бэкфилла: NULL = установлено.
  it('0013: installations.uninstalled_at — nullable timestamptz', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'installations'
         AND column_name = 'uninstalled_at'
    `);
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
  });

  // M26: deploy.sh гоняет миграции в one-off `compose run --rm`. После обрыва SSH one-off
  // дорабатывает без клиента, и повторный FROM=migrate (или ручной prod-migrate) идёт
  // параллельно ему. Advisory lock сериализует прогоны: второй ждёт и видит миграцию
  // применённой. pg_sleep гарантирует перекрытие: без него второй прогон мог бы начаться
  // после конца первого, и тест был бы зелёным и без лока.
  describe('runMigrations под advisory lock (M26)', () => {
    const PROBE_ID = '0002_m26_lock_probe';
    // Тихий логгер, который запоминает info: по 'migrations lock busy' видно, что прогоны
    // действительно перекрылись и второй ждал лок.
    const infos = [];
    const logger = {
      child: () => ({
        info: (objOrMsg, msg) => infos.push(typeof objOrMsg === 'string' ? objOrMsg : msg),
        debug() {},
        warn() {},
        error() {},
      }),
    };
    let dir;

    async function cleanup() {
      await pool.query('DROP TABLE IF EXISTS m26_lock_probe');
      await pool.query('DELETE FROM schema_migrations WHERE id = $1', [PROBE_ID]);
    }

    beforeAll(async () => {
      await cleanup();
      dir = await mkdtemp(path.join(os.tmpdir(), 'm26-migrations-lock-'));
      await copyFile(
        new URL('../../src/shared/db/migrations/0001_schema_migrations.sql', import.meta.url),
        path.join(dir, '0001_schema_migrations.sql'),
      );
      // Неидемпотентная: повторный CREATE TABLE падает.
      await writeFile(
        path.join(dir, `${PROBE_ID}.sql`),
        'SELECT pg_sleep(0.5);\nCREATE TABLE m26_lock_probe (id int);\n',
      );
    });

    afterAll(async () => {
      await cleanup();
      await rm(dir, { recursive: true, force: true });
    });

    it('два параллельных прогона применяют неидемпотентную миграцию один раз', async () => {
      const results = await Promise.all([
        runMigrations({ pool, logger, dir }),
        runMigrations({ pool, logger, dir }),
      ]);

      const applied = results.flatMap((r) => r.applied);
      expect(applied).toEqual([PROBE_ID]);
      expect(infos).toContain('migrations lock busy — waiting for another run');
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'm26_lock_probe'`,
      );
      expect(rows[0].n).toBe(1);
      const { rows: logged } = await pool.query('SELECT id FROM schema_migrations WHERE id = $1', [PROBE_ID]);
      expect(logged).toEqual([{ id: PROBE_ID }]);
    });

    it('после прогонов лок отпущен: ни одно соединение пула его не держит', async () => {
      // Сессионный лок реентерабелен — pg_try_advisory_lock на «том же» соединении пула
      // утечку не поймал бы. Смотрим pg_locks: ключ bigint → classid (старшие 32 бита),
      // objid (младшие), objsubid = 1.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1`,
        [MIGRATIONS_LOCK_KEY],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it('creates all 4 domain tables', async () => {
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('installations','chat_bindings','participant_map','message_log')
    `);
    const names = rows.map((r) => r.tablename).sort();
    expect(names).toEqual(['chat_bindings', 'installations', 'message_log', 'participant_map']);
  });

  it('creates partial-unique indexes on message_log', async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('message_log_inbound_dedup_idx', 'message_log_outbound_dedup_idx')
    `);
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'message_log_inbound_dedup_idx',
      'message_log_outbound_dedup_idx',
    ]);
  });
});
