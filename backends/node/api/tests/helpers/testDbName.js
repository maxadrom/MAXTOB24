// Имя БД, которую тестам разрешено транкейтить. Общий критерий globalSetup и truncateAll.
export function isTestDbName(name) {
  return /test/i.test(String(name ?? ''));
}
