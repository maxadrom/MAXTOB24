// Тест scripts/probe-media-memory.js (M26): малый файл через настоящий loopback —
// downloadFile с хопом 302 (redirect:'manual') → диск → uploadBinary. runScript без
// process.exit; вывод перехватывается deps.print, fetch оборачивается deps.fetch. Без БД.

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { runScript } from '../../scripts/probe-media-memory.js';

const argv = (...args) => ['node', 'scripts/probe-media-memory.js', ...args];

describe('probe-media-memory (M26)', () => {
  it('1 МиБ: редирект 302 при redirect:manual, файл туда и обратно, JSON-строка с замером', async () => {
    const print = vi.fn();
    const calls = [];
    const fetchSpy = (url, opts) => {
      calls.push({ url, redirect: opts?.redirect });
      return globalThis.fetch(url, opts);
    };

    const result = await runScript({ argv: argv('--size-mb=1'), deps: { print, fetch: fetchSpy } });

    expect(result).toMatchObject({
      ok: true,
      node: process.version,
      sizeMb: 1,
      warmup: true,
      redirect: '302 manual → ok',
    });
    expect(result.problems).toBeUndefined();
    for (const key of ['baselineRssMb', 'peakRssMb', 'deltaMb', 'downloadMs', 'uploadMs']) {
      expect(typeof result[key]).toBe('number');
    }
    expect(result.peakRssMb).toBeGreaterThanOrEqual(result.baselineRssMb);
    // Прогрев, затем два хопа скачивания — оба на loopback и с redirect:'manual'.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/warmup', '/redirect', '/file.bin']);
    expect(calls.slice(1).every((c) => c.redirect === 'manual')).toBe(true);
    expect(calls.every((c) => new URL(c.url).hostname === '127.0.0.1')).toBe(true);
    expect(print).toHaveBeenCalledTimes(1);
    expect(JSON.parse(print.mock.calls[0][0])).toEqual(result);
  });

  it('--cold: без прогрева; --keep: временный каталог остаётся', async () => {
    const calls = [];
    const fetchSpy = (url, opts) => {
      calls.push(new URL(url).pathname);
      return globalThis.fetch(url, opts);
    };

    const result = await runScript({
      argv: argv('--size-mb=0.5', '--cold', '--keep'),
      deps: { print: () => {}, fetch: fetchSpy },
    });

    try {
      expect(result).toMatchObject({ ok: true, warmup: false, sizeMb: 0.5 });
      expect(calls).toEqual(['/redirect', '/file.bin']);
      expect(existsSync(result.tmpDir)).toBe(true);
    } finally {
      await rm(result.tmpDir, { recursive: true, force: true });
    }
  });

  it('без --keep временный каталог удаляется', async () => {
    const probeDirs = async () => (await readdir(os.tmpdir())).filter((n) => n.startsWith('maxtob24-probe-media-'));
    const before = await probeDirs();

    const result = await runScript({ argv: argv('--size-mb=0.25'), deps: { print: () => {} } });

    expect(result.ok).toBe(true);
    expect(result.tmpDir).toBeUndefined();
    expect(await probeDirs()).toEqual(before);
  });

  it('некорректный --size-mb → ошибка до создания файлов; --help → справка', async () => {
    await expect(runScript({ argv: argv('--size-mb=abc'), deps: { print: () => {} } }))
      .rejects.toThrow(/--size-mb must be a positive number/);
    await expect(runScript({ argv: argv('--size-mb=0'), deps: { print: () => {} } }))
      .rejects.toThrow(/--size-mb/);

    const print = vi.fn();
    await expect(runScript({ argv: argv('--help'), deps: { print } })).resolves.toEqual({ ok: true, mode: 'help' });
    expect(print.mock.calls[0][0]).toMatch(/probe-media-memory/);
  });
});
