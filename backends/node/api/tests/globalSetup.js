// Глобальный setup: загружает .env.test (если есть), для интеграционных тестов
// создаёт appdb_test и прогоняет миграции. Если Postgres недоступен — выставляет
// флаг SKIP_DB_TESTS, чтобы тесты-интеграционники могли скипнуться через
// helper'ы в setupEach.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { isTestDbName } from './helpers/testDbName.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, '..');

export default async function setup() {
  // Сначала .env.test, потом .env как фолбэк. quiet — без «injected env …» dotenv 17 в выводе.
  dotenv.config({ path: path.join(apiRoot, '.env.test'), override: false, quiet: true });
  dotenv.config({ path: path.resolve(apiRoot, '../../../.env'), override: false, quiet: true });

  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

  // Готовим тестовую БД, только если есть DATABASE_URL.
  if (!process.env.DATABASE_URL) {
    process.env.SKIP_DB_TESTS = '1';
    return async () => {};
  }

  const targetUrl = new URL(process.env.DATABASE_URL);
  const targetDbName = targetUrl.pathname.replace(/^\//, '');
  if (!targetDbName) {
    process.env.SKIP_DB_TESTS = '1';
    return async () => {};
  }
  // Тесты транкейтят таблицы. dotenv с override:false не перебивает уже заданный
  // DATABASE_URL (напр. env_file контейнера → рабочая appdb), поэтому имя БД — последний
  // рубеж: без «test» в имени DB-тесты скипаются, а не стирают рабочие данные.
  if (!isTestDbName(targetDbName)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[globalSetup] DATABASE_URL points to "${targetDbName}" (no "test" in name). DB tests will be skipped.`,
    );
    process.env.SKIP_DB_TESTS = '1';
    return async () => {};
  }

  // CREATE DATABASE требует подключения к другой БД. Подключаемся к 'postgres'.
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';

  let adminPool;
  try {
    adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${targetDbName}"`);
    } catch (err) {
      // 42P04 = database already exists. Игнорируем — переиспользуем.
      if (err.code !== '42P04') {
        // eslint-disable-next-line no-console
        console.error('[globalSetup] failed to create test database:', err.message);
        process.env.SKIP_DB_TESTS = '1';
        await adminPool.end();
        return async () => {};
      }
    }
    await adminPool.end();
  } catch (connErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[globalSetup] cannot connect to Postgres (${connErr.message}). Integration tests will be skipped.`,
    );
    process.env.SKIP_DB_TESTS = '1';
    if (adminPool) await adminPool.end().catch(() => {});
    return async () => {};
  }

  // Применяем миграции в тестовую БД.
  const { buildPool } = await import('../src/shared/db/pool.js');
  const { runMigrations } = await import('../src/shared/db/runMigrations.js');
  const { loadConfig } = await import('../src/shared/config/index.js');

  const config = loadConfig();
  const pool = buildPool(config, /* logger */ null);
  try {
    await runMigrations({ pool, logger: null });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[globalSetup] migrations failed:', err.message);
    process.env.SKIP_DB_TESTS = '1';
  } finally {
    await pool.end();
  }

  // Teardown: ничего не дропаем — переиспользуем БД между прогонами.
  return async () => {};
}
