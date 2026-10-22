#!/usr/bin/env node
// scripts/probe-media-memory.js — замер памяти потока медиа OL → MAX (M26, смена рантайма).
//
// Назначение: сравнить рантаймы (Node 22 против 24) на пути исходящего файла
// downloadFile → диск → uploadBinary. Риск смены мажора — другой undici (6 → 7) в потоковых
// fetch, поэтому байты идут НАСТОЯЩИМ globalThis.fetch через сокет, а не подменённым
// Response. Заодно проверяется редирект: 302 при redirect:'manual' (на нём держится
// SSRF-guard каждого хопа, b24Client._fetchDownload).
//
// Как устроено (без внешней сети и без .env, config не читается):
//   - случайный файл --size-mb МиБ во временном каталоге os.tmpdir() (уважает TMPDIR);
//   - локальный http-сервер на 127.0.0.1:<случайный порт>:
//       GET  /redirect → 302 Location: https://probe.example.com/file.bin
//       GET  /file.bin → файл потоком с Content-Length
//       POST /upload   → тело вычитывается (счётчик байт), ответ {"token":"probe"};
//   - B24Client.downloadFile('https://probe.example.com/redirect'): SSRF-guard проверяет
//     исходный https-URL (сети он не делает), а fetchImpl переписывает его на loopback
//     и зовёт globalThis.fetch с теми же опциями (redirect:'manual', signal);
//   - MaxClient.uploadBinary на http://127.0.0.1:<port>/upload (postMultipart умеет http:);
//   - RSS (process.memoryUsage.rss) — каждые 25 мс; baseline — после подготовки файла и
//     прогрева: один мелкий fetch загружает undici, как в работающем мосте. --cold — без
//     прогрева (на 250 МиБ разница — единицы МБ, замер M26).
// Сервер живёт в том же процессе: его буферы (поток с диска, вычитка тела) — в той же
// RSS, так что замер — оценка сверху для моста.
//
// Запуск (из backends/node/api, по 3 раза на рантайм; сравнивать медианы трёх прогонов):
//   /path/to/node-22/bin/node scripts/probe-media-memory.js --size-mb=250   — один рантайм
//   /path/to/node-24/bin/node scripts/probe-media-memory.js --size-mb=250   — другой
//   pnpm run probe-media-memory -- --size-mb=250 --keep                — оставить файлы
//   … --cold                                                           — без прогрева fetch
//
// Вывод — одна строка JSON:
//   { node, undici, sizeMb, baselineRssMb, peakRssMb, deltaMb, downloadMs, uploadMs, … }.

import { randomFillSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { B24Client } from '../src/modules/b24/b24Client.js';
import { MaxClient } from '../src/modules/max/maxClient.js';
import { runCli } from './lib/bootstrap.js';

const DEFAULT_SIZE_MB = 250;
const MIB = 2 ** 20;
const SAMPLE_INTERVAL_MS = 25;
const TRANSFER_TIMEOUT_MS = 600_000;
// Хост-«портал»: публичное имя проходит SSRF-guard, в сеть не уходит (fetchImpl → loopback).
const PROBE_ORIGIN = 'https://probe.example.com';

const HELP = `
probe-media-memory — замер RSS потока медиа: downloadFile → диск → uploadBinary через loopback

Использование:
  node scripts/probe-media-memory.js [--size-mb=<n>] [--cold] [--keep]

Опции:
  --size-mb=<n>   Размер файла в МиБ (по умолчанию ${DEFAULT_SIZE_MB}).
  --cold          Без прогрева: baseline до первого fetch процесса (загрузка undici
                  попадает в замер).
  --keep          Не удалять временные файлы (путь — в поле tmpDir вывода).
  --help          Эта справка.

Внешней сети и .env не нужно. Вывод — JSON с baseline/peak RSS и длительностями.
`.trim();

const toMb = (bytes) => Math.round((bytes / MIB) * 10) / 10;

function parseArgs(argv) {
  const sizeArg = argv.find((a) => a.startsWith('--size-mb='));
  const sizeMb = sizeArg ? Number(sizeArg.slice('--size-mb='.length)) : DEFAULT_SIZE_MB;
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
    throw new Error(`--size-mb must be a positive number (got: ${sizeArg})`);
  }
  return { sizeMb, cold: argv.includes('--cold'), keep: argv.includes('--keep') };
}

// Случайное содержимое одним переиспользуемым буфером 1 МиБ: подготовка не раздувает
// RSS до baseline.
async function writeRandomFile(filePath, sizeBytes) {
  const fh = await open(filePath, 'w');
  try {
    const chunk = Buffer.allocUnsafe(MIB);
    for (let left = sizeBytes; left > 0; left -= chunk.length) {
      randomFillSync(chunk);
      // eslint-disable-next-line no-await-in-loop
      await fh.write(chunk, 0, Math.min(chunk.length, left));
    }
  } finally {
    await fh.close();
  }
}

// Loopback-сервер: редирект, файл потоком, приём заливки. Счётчики — для самопроверки.
function startServer(srcPath, sizeBytes) {
  const stats = { redirects: 0, downloads: 0, uploadBytes: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/warmup') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/redirect') {
      stats.redirects += 1;
      res.writeHead(302, { Location: `${PROBE_ORIGIN}/file.bin` });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/file.bin') {
      stats.downloads += 1;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': sizeBytes });
      createReadStream(srcPath).pipe(res);
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      req.on('data', (chunk) => { stats.uploadBytes += chunk.length; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"token":"probe"}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stats }));
  });
}

// Пик RSS: общий и по фазам — phase() отдаёт пик завершённой фазы и начинает следующую.
function startSampler() {
  const s = { peak: process.memoryUsage.rss(), phasePeak: 0 };
  const sample = () => {
    const rss = process.memoryUsage.rss();
    if (rss > s.peak) s.peak = rss;
    if (rss > s.phasePeak) s.phasePeak = rss;
  };
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  return {
    phase() {
      sample();
      const prev = s.phasePeak;
      s.phasePeak = process.memoryUsage.rss();
      return prev;
    },
    stop() {
      clearInterval(timer);
      sample();
      return s.peak;
    },
  };
}

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  const print = deps.print ?? ((line) => console.log(line)); // eslint-disable-line no-console
  if (argv.includes('--help')) {
    print(HELP);
    return { ok: true, mode: 'help' };
  }
  const { sizeMb, cold, keep } = parseArgs(argv);
  const sizeBytes = Math.round(sizeMb * MIB);
  const realFetch = deps.fetch ?? ((...args) => globalThis.fetch(...args));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maxtob24-probe-media-'));
  const srcPath = path.join(tmpDir, 'source.bin');
  const destPath = path.join(tmpDir, 'download.part');
  let server = null;
  let sampler = null;
  try {
    await writeRandomFile(srcPath, sizeBytes);
    const started = await startServer(srcPath, sizeBytes);
    server = started.server;
    const { port, stats } = started;

    // https://probe.example.com/<путь> → http://127.0.0.1:<port>/<путь>; чужие URL — ошибка,
    // чтобы проба не ушла во внешнюю сеть. redirectModes — самопроверка redirect:'manual'.
    const redirectModes = [];
    const fetchImpl = (url, opts) => {
      const target = new URL(url);
      if (target.origin !== PROBE_ORIGIN) throw new Error(`probe: unexpected fetch ${target.origin}`);
      redirectModes.push(opts?.redirect ?? null);
      return realFetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, opts);
    };
    // downloadFile анонимный (SIGN в ссылке) — installations ему не нужны, стаб для конструктора.
    const installationsService = { getCurrent: async () => { throw new Error('probe: no installation'); } };
    const b24 = new B24Client({ installationsService, fetchImpl });
    const max = new MaxClient({ baseUrl: 'http://127.0.0.1:1', token: 'probe' });

    if (!cold) await (await realFetch(`http://127.0.0.1:${port}/warmup`)).text();
    const baselineRss = process.memoryUsage.rss();
    sampler = startSampler();

    const t0 = Date.now();
    const downloaded = await b24.downloadFile(`${PROBE_ORIGIN}/redirect`, {
      destPath,
      maxBytes: Math.max(300 * MIB, sizeBytes),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const downloadMs = Date.now() - t0;
    const downloadPeak = sampler.phase();

    const t1 = Date.now();
    const uploaded = await max.uploadBinary(
      `http://127.0.0.1:${port}/upload`,
      { path: destPath, filename: 'probe.bin', contentType: 'application/octet-stream' },
      { timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    const uploadMs = Date.now() - t1;
    const uploadPeak = sampler.phase();
    const peakRss = sampler.stop();
    sampler = null;

    // Самопроверка: один хоп 302 при redirect:'manual', файл целиком туда и обратно.
    const problems = [];
    if (stats.redirects !== 1 || stats.downloads !== 1) {
      problems.push(`redirect hops: /redirect=${stats.redirects}, /file.bin=${stats.downloads}`);
    }
    if (redirectModes.length !== 2 || redirectModes.some((m) => m !== 'manual')) {
      problems.push(`fetch redirect modes: ${JSON.stringify(redirectModes)}`);
    }
    if (downloaded.size !== sizeBytes) problems.push(`downloaded ${downloaded.size} of ${sizeBytes} bytes`);
    if (stats.uploadBytes < sizeBytes) problems.push(`uploaded ${stats.uploadBytes} of ${sizeBytes}+ bytes`);
    if (uploaded?.token !== 'probe') problems.push(`upload response: ${JSON.stringify(uploaded)}`);

    const result = {
      ok: problems.length === 0,
      node: process.version,
      undici: process.versions.undici ?? null,
      sizeMb,
      warmup: !cold,
      baselineRssMb: toMb(baselineRss),
      peakRssMb: toMb(peakRss),
      deltaMb: toMb(peakRss - baselineRss),
      downloadDeltaMb: toMb(downloadPeak - baselineRss),
      uploadDeltaMb: toMb(uploadPeak - baselineRss),
      downloadMs,
      uploadMs,
      redirect: problems.length === 0 ? '302 manual → ok' : 'see problems',
      ...(problems.length ? { problems } : {}),
      ...(keep ? { tmpDir } : {}),
    };
    print(JSON.stringify(result));
    return result;
  } finally {
    sampler?.stop();
    if (server) await new Promise((resolve) => { server.close(() => resolve()); });
    if (!keep) await rm(tmpDir, { recursive: true, force: true });
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('probe-media-memory', runScript, { notOkExitCode: 2 });
