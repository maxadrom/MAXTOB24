// M22: временные файлы медиа OL → MAX. Файл оператора идёт потоком через диск
// (скачал → залил → удалил), а не целиком через память: 200 МБ в Buffer+Blob давали
// +1,2 ГБ RSS. Владелец жизненного цикла — координатор (remove в finally).
//
// Имена — <uuid>.part в своём каталоге (MEDIA_TMP_DIR). sweep() удаляет только такие
// файлы: каталог, указанный по ошибке на общий /tmp, не будет вычищен целиком.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const TEMP_NAME_RE = /^[0-9a-f-]{36}\.part$/;

export class MediaTempFiles {
  constructor({ dir, logger } = {}) {
    if (!dir) throw new TypeError('MediaTempFiles: dir required');
    this.dir = dir;
    this.logger = logger;
    this._dirReady = null;
  }

  // Каталог создаётся лениво — на первом файле (тестам и скриптам sweep не нужен).
  async _ensureDir() {
    this._dirReady ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).catch((err) => {
      this._dirReady = null;
      throw err;
    });
    return this._dirReady;
  }

  async allocate() {
    await this._ensureDir();
    return path.join(this.dir, `${randomUUID()}.part`);
  }

  // Тихо: файла может не быть (скачивание упало до первого байта).
  async remove(filePath) {
    if (!filePath) return;
    try {
      await rm(filePath, { force: true });
    } catch (err) {
      this.logger?.warn({ err: { message: err?.message } }, 'media temp: remove failed');
    }
  }

  // Остатки прошлого процесса (рестарт посреди передачи). Зовётся в server.js до listen.
  async sweep() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      throw err;
    }
    const stale = names.filter((n) => TEMP_NAME_RE.test(n));
    await Promise.all(stale.map((n) => rm(path.join(this.dir, n), { force: true })));
    if (stale.length > 0) {
      this.logger?.warn({ dir: this.dir, count: stale.length }, 'media temp: leftovers removed');
    }
    return stale.length;
  }
}
