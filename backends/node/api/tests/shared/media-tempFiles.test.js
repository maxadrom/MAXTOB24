// M22: временные файлы медиа OL → MAX.

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MediaTempFiles } from '../../src/shared/media/tempFiles.js';

describe('MediaTempFiles', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'm22-temp-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('1) allocate: каталог создаётся лениво, имя <uuid>.part внутри него', async () => {
    const dir = path.join(root, 'media');
    const temp = new MediaTempFiles({ dir });
    const p1 = await temp.allocate();
    const p2 = await temp.allocate();
    expect(path.dirname(p1)).toBe(dir);
    expect(path.basename(p1)).toMatch(/^[0-9a-f-]{36}\.part$/);
    expect(p1).not.toBe(p2);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('2) remove: удаляет файл; отсутствующий файл и пустой путь — без ошибки', async () => {
    const temp = new MediaTempFiles({ dir: root });
    const p = await temp.allocate();
    await writeFile(p, 'x');
    await temp.remove(p);
    await expect(stat(p)).rejects.toMatchObject({ code: 'ENOENT' });
    await temp.remove(p);
    await temp.remove(null);
  });

  it('3) sweep: удаляет только свои *.part, чужие файлы не трогает', async () => {
    const temp = new MediaTempFiles({ dir: root });
    const own = await temp.allocate();
    await writeFile(own, 'x');
    await writeFile(path.join(root, 'foreign.txt'), 'y');
    expect(await temp.sweep()).toBe(1);
    expect(await readdir(root)).toEqual(['foreign.txt']);
  });

  it('4) sweep: каталога нет → 0', async () => {
    const temp = new MediaTempFiles({ dir: path.join(root, 'absent') });
    expect(await temp.sweep()).toBe(0);
  });

  it('5) без dir → TypeError', () => {
    expect(() => new MediaTempFiles({})).toThrow(TypeError);
  });
});
