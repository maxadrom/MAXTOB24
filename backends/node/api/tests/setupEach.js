// setupFiles: вешает beforeEach-truncate для интеграционных тестов через
// глобальный helper. Хелперы экспортируются из tests/helpers/db.js — тесты
// сами решают, нужен ли им TRUNCATE.

import { beforeEach } from 'vitest';

beforeEach(() => {
  // Пусто по умолчанию. Интеграционные тесты сами вызывают truncateAll() из
  // tests/helpers/db.js, чтобы TRUNCATE не бил по unit-тестам (которые БД не
  // используют).
});
