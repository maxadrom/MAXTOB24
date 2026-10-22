// CLI / programmatic runner для SQL-миграций.
// 1. Создаёт schema_migrations через 0001_*.sql (он сам идемпотентный).
// 2. Идёт по migrations/*.sql в алфавитном порядке, применяет неприменённые
//    в одной транзакции на файл, фиксирует в schema_migrations.
// Весь прогон — под сессионным advisory lock (M26): параллельные прогоны идут по очереди.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/index.js';
import { buildLogger } from '../logger/index.js';
import { buildPool } from './pool.js';
import { isInvokedDirectly } from '../cli/isInvokedDirectly.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// M26: ключ pg_advisory_lock прогона миграций — произвольная константа проекта.
export const MIGRATIONS_LOCK_KEY = 7262601;

export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function loadMigration(name, dir) {
  const full = path.join(dir, name);
  const sql = await fs.readFile(full, 'utf8');
  return { id: name.replace(/\.sql$/, ''), name, sql };
}

// Ждём лок; если занят — пишем об этом, иначе ожидание в выводе deploy.sh выглядит как зависание.
async function acquireMigrationsLock(client, log) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATIONS_LOCK_KEY]);
  if (rows[0]?.ok) return;
  log.info?.({ lockKey: MIGRATIONS_LOCK_KEY }, 'migrations lock busy — waiting for another run');
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_KEY]);
}

async function getAppliedIds(client) {
  const { rows } = await client.query('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => r.id));
}

export async function runMigrations({ pool, logger, dir = MIGRATIONS_DIR } = {}) {
  const log = logger?.child ? logger.child({ module: 'db', cmd: 'migrate' }) : console;

  const files = await listMigrationFiles(dir);
  if (files.length === 0) {
    log.info?.('no migration files found');
    return { applied: [], total: 0 };
  }

  // Гарантируем существование schema_migrations: запускаем 0001 первым,
  // он CREATE TABLE IF NOT EXISTS.
  const bootstrap = files[0];
  if (!bootstrap.startsWith('0001_')) {
    throw new Error(
      `runMigrations: expected first migration to start with 0001_, got "${bootstrap}"`,
    );
  }
  const client = await pool.connect();
  const applied = [];
  try {
    // Лок — до bootstrap-SQL 0001 и чтения schema_migrations: второй прогон читает список
    // применённых уже после первого. Конкурентный `compose run --rm` после обрыва SSH (one-off
    // дорабатывает без клиента) и ручной prod-migrate ждут здесь, а не применяют миграцию дважды.
    await acquireMigrationsLock(client, log);

    const bootstrapSql = await fs.readFile(path.join(dir, bootstrap), 'utf8');
    await client.query(bootstrapSql);

    const appliedIds = await getAppliedIds(client);

    for (const file of files) {
      const mig = await loadMigration(file, dir);
      if (appliedIds.has(mig.id)) {
        log.debug?.({ id: mig.id }, 'migration already applied');
        continue;
      }
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(mig.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, applied_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING',
          [mig.id],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log.error?.(
          { id: mig.id, err: { message: err.message, code: err.code } },
          'migration failed — rolled back',
        );
        throw err;
      }
      const durationMs = Date.now() - started;
      applied.push(mig.id);
      log.info?.({ id: mig.id, durationMs }, 'migration applied');
    }

    if (applied.length === 0) {
      log.info?.('no migrations to apply');
    } else {
      log.info?.({ count: applied.length }, 'migrations done');
    }
    return { applied, total: files.length };
  } finally {
    // Сессионный лок живёт, пока живо соединение, а соединение уходит обратно в пул. Не
    // удалось отпустить — уничтожаем соединение (release(true)): лок снимется вместе с ним.
    let unlocked = false;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
      unlocked = true;
    } catch {
      // глушим: соединение всё равно не вернётся в пул
    }
    client.release(!unlocked);
  }
}

// CLI entrypoint: запускается из package.json (db:migrate).
async function main() {
  const config = loadConfig();
  const logger = buildLogger(config);
  const pool = buildPool(config, logger);
  try {
    await runMigrations({ pool, logger });
  } catch (err) {
    logger.error(
      { err: { message: err.message, code: err.code, stack: err.stack } },
      'runMigrations failed',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}
