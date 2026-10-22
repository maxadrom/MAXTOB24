// Хелперы для интеграционных тестов.
//   - shouldSkipDb(): пропускаем suite если Postgres не доступен
//   - getTestPool(): кеширует pool на весь прогон (закрывает globalTeardown
//     неявно — пул на 1 коннект, после теста хост закрывает)
//   - truncateAll(pool): чистим все таблицы между тестами (только тестовая БД)

import { buildPool } from '../../src/shared/db/pool.js';
import { loadConfig } from '../../src/shared/config/index.js';
import { isTestDbName } from './testDbName.js';

let cachedPool = null;
const verifiedPools = new WeakSet();

export function shouldSkipDb() {
  return process.env.SKIP_DB_TESTS === '1' || !process.env.DATABASE_URL;
}

export function getTestPool() {
  if (cachedPool) return cachedPool;
  const config = loadConfig();
  cachedPool = buildPool(config, null);
  return cachedPool;
}

export async function closeTestPool() {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
}

// Страховка поверх globalSetup: TRUNCATE только в БД с «test» в имени.
export async function truncateAll(pool) {
  if (!verifiedPools.has(pool)) {
    const { rows } = await pool.query('SELECT current_database() AS name');
    if (!isTestDbName(rows[0]?.name)) {
      throw new Error(`truncateAll: refusing to truncate non-test database "${rows[0]?.name}"`);
    }
    verifiedPools.add(pool);
  }
  await pool.query(
    'TRUNCATE message_log, participant_map, chat_bindings, installations RESTART IDENTITY CASCADE',
  );
}
