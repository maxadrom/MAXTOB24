// «Модуль запущен как `node <file>`, а не импортирован» — для CLI-обёрток скриптов и
// миграций. Сравниваем абсолютные пути: package.json зовёт `node scripts/<name>.js`,
// argv[1] там относительный.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function isInvokedDirectly(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fileURLToPath(importMetaUrl) === path.resolve(argv1);
  } catch {
    return false;
  }
}
