// vitest config. setupFiles: грузим окружение и инициализируем тестовую БД.
// DB-тесты не любят параллель — гоняем файлы последовательно.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setupEach.js'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Vitest 4: poolOptions.singleThread удалён. DB-smoke делят один Postgres —
    // параллельный прогон файлов ломает FK/уникальные индексы и application_token
    // (см. inbound/outbound smoke). Последовательность обеспечивает флаг
    // --no-file-parallelism в package.json scripts (test/test:watch): config-опция
    // fileParallelism здесь в этой связке Vitest 4 не применяется надёжно, а CLI-флаг
    // срабатывает. Держим pool:'threads' для совместимости.
    pool: 'threads',
    // Тесты, которым нужен Postgres, помечаются suffix .integration.test.js или
    // .smoke.test.js и скипаются через shouldSkipDb(), если БД недоступна.
  },
});
