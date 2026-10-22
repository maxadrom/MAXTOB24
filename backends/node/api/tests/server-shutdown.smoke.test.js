// M29 smoke: настоящий server.js дочерним процессом на тестовой БД — проводка bootstrap'а.
//   - после listen идёт разбор прерванных: строка job: прошлого процесса, чья операция уже
//     записана, снимается (путь «already done» — без обращений к MAX и Б24);
//   - SIGTERM и SIGINT → дренаж → закрытие порта и пула → exit 0. Обработчики сигналов
//     обязательны: в контейнере node — PID 1, и без них docker stop кончался бы SIGKILL.
//     Здесь процесс не PID 1, но без обработчика он умер бы по сигналу, а не вышел с кодом 0;
//   - БД недоступна на старте (DATABASE_URL на закрытый порт): процесс слушает порт и отвечает
//     /health, поиск прерванных повторяется; БД «поднялась» (на том же порту — TCP-прокси к
//     тестовой БД) → разбор проходит. SIGTERM во время паузы между попытками — выход 0 сразу.
// Логи — JSON (NODE_ENV=production), уровень debug.
//
// DB-gated: describe.skipIf(shouldSkipDb()); DATABASE_URL процесса — та же тестовая БД.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallationsRepository } from '../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../src/modules/installations/installationsService.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../src/modules/bindings/participantMapRepository.js';
import { BindingsService } from '../src/modules/bindings/bindingsService.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from './helpers/db.js';
import { isTestDbName } from './helpers/testDbName.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTAL = 'example.bitrix24.ru';
const CHAT = '-70000000000974';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// node server.js: → { child, logs (разобранные JSON-строки stdout), exited, output() }.
function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: API_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  let raw = '';
  let buf = '';
  child.stdout.on('data', (chunk) => {
    raw += chunk;
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        logs.push(JSON.parse(line));
      } catch {
        logs.push({ msg: line });
      }
      i = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    raw += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, logs, exited, output: () => raw };
}

const msgs = (logs) => logs.map((l) => l.msg);

// TCP-прокси 127.0.0.1:port → target (Postgres): «БД поднялась» на адресе, который до этого
// отвечал ECONNREFUSED. → { close() }.
function startTcpProxy(port, target) {
  const sockets = new Set();
  const srv = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    for (const sock of [client, upstream]) {
      sockets.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => {
        sockets.delete(sock);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve({
      close: () => {
        for (const sock of sockets) sock.destroy();
        return new Promise((r) => srv.close(() => r()));
      },
    }));
  });
}

// DATABASE_URL тестовой БД на 127.0.0.1:port (тот же пользователь и база).
function dbUrlOnPort(port) {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

describe.skipIf(shouldSkipDb())('server.js smoke (разбор прерванных после listen, остановка по сигналу)', () => {
  let pool;
  let tmpDir;
  let env;
  let server;

  beforeEach(async () => {
    // Процесс транкейтить не будет, но пишет в БД: только тестовая.
    expect(isTestDbName(new URL(process.env.DATABASE_URL).pathname.slice(1))).toBe(true);
    pool = getTestPool();
    await truncateAll(pool);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm29-server-smoke-'));
    const port = await freePort();
    env = {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      API_PORT: String(port),
      PORT: String(port),
      MEDIA_TMP_DIR: tmpDir,
    };
  });

  afterEach(async () => {
    if (server && server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill('SIGKILL');
      await server.exited;
    }
    server = null;
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('1) после listen снимает строку job: прошлого процесса; SIGTERM → дренаж → exit 0', async () => {
    const installationsRepo = new InstallationsRepository(pool, null);
    const installations = new InstallationsService(installationsRepo, null);
    await installationsRepo.upsertByPortal({ portal: PORTAL });
    await installations.seedSingleTenant({ portal: PORTAL, olLineId: 42, connectorId: 'max_b24', maxBotId: '1' });
    const bindings = new BindingsService({
      bindingsRepository: new BindingsRepository(pool, null),
      participantMapRepository: new ParticipantMapRepository(pool, null),
      installationsService: installations,
      logger: null,
    });
    const { binding } = await bindings.ensureForMaxChat(CHAT, { maxChatTitle: 'Группа' });
    // Прошлый процесс упал между записью операции и снятием строки задания.
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, status, payload_meta, created_at)
       VALUES ($1, 'outbound', 'job:1800001', 'in_progress', $2, now() - interval '1 minute')`,
      [binding.id, JSON.stringify({
        kind: 'job', op: 'add', opKey: '1800001', connectorChatId: binding.connectorChatId, b24MsgId: '1800001',
      })],
    );
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, payload_meta)
       VALUES ($1, 'outbound', '1800001', '{}')`,
      [binding.id],
    );

    server = startServer(env);
    await vi.waitFor(() => {
      expect(msgs(server.logs)).toContain('interrupted outbound recovered');
    }, { timeout: 10_000, interval: 50 });

    const order = msgs(server.logs);
    expect(order.indexOf('server listening')).toBeGreaterThan(-1);
    expect(order.indexOf('server listening')).toBeLessThan(order.indexOf('interrupted outbound jobs found'));
    expect(order).toContain('interrupted outbound job: already done');
    expect(server.logs.find((l) => l.msg === 'interrupted outbound recovered')).toMatchObject({ total: 1, completed: 1 });
    const { rows } = await pool.query(`SELECT b24_msg_id FROM message_log WHERE b24_msg_id LIKE 'job:%'`);
    expect(rows).toEqual([]);

    const health = await fetch(`http://127.0.0.1:${env.API_PORT}/health`);
    expect(health.status).toBe(200);

    server.child.kill('SIGTERM');
    const { code, signal } = await server.exited;
    expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
    expect(msgs(server.logs)).toEqual(expect.arrayContaining([
      'shutdown requested: draining outbound queue (still listening)',
      'outbound queue drained',
      'http server closed',
      'pg pool closed',
      'shutdown complete',
    ]));
    expect(server.logs.find((l) => l.msg === 'shutdown complete')).toMatchObject({ signal: 'SIGTERM', code: 0 });
  });

  // Прошлый процесс упал между записью операции и снятием строки задания.
  async function seedDoneJob(b24MsgId) {
    const installationsRepo = new InstallationsRepository(pool, null);
    const installations = new InstallationsService(installationsRepo, null);
    await installationsRepo.upsertByPortal({ portal: PORTAL });
    await installations.seedSingleTenant({ portal: PORTAL, olLineId: 42, connectorId: 'max_b24', maxBotId: '1' });
    const bindings = new BindingsService({
      bindingsRepository: new BindingsRepository(pool, null),
      participantMapRepository: new ParticipantMapRepository(pool, null),
      installationsService: installations,
      logger: null,
    });
    const { binding } = await bindings.ensureForMaxChat(CHAT, { maxChatTitle: 'Группа' });
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, status, payload_meta, created_at)
       VALUES ($1, 'outbound', $2, 'in_progress', $3, now() - interval '1 minute')`,
      [binding.id, `job:${b24MsgId}`, JSON.stringify({
        kind: 'job', op: 'add', opKey: b24MsgId, connectorChatId: binding.connectorChatId, b24MsgId,
      })],
    );
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, b24_msg_id, payload_meta)
       VALUES ($1, 'outbound', $2, '{}')`,
      [binding.id, b24MsgId],
    );
  }

  it('3) БД недоступна на старте: порт открыт, /health 200, поиск повторяется; БД поднялась → разбор прошёл', async () => {
    await seedDoneJob('1800003');
    const dbPort = await freePort();
    const target = new URL(process.env.DATABASE_URL);
    let proxy = null;
    try {
      server = startServer({ ...env, DATABASE_URL: dbUrlOnPort(dbPort) });
      await vi.waitFor(() => {
        expect(msgs(server.logs)).toContain('interrupted outbound lookup failed, retrying');
      }, { timeout: 10_000, interval: 50 });

      const order = msgs(server.logs);
      expect(order.indexOf('server listening')).toBeGreaterThan(-1);
      expect(order.indexOf('server listening')).toBeLessThan(order.indexOf('interrupted outbound lookup failed, retrying'));
      const health = await fetch(`http://127.0.0.1:${env.API_PORT}/health`);
      expect(health.status).toBe(200);

      // БД поднялась: следующая попытка поиска (через retryMs 5 с) проходит
      proxy = await startTcpProxy(dbPort, { host: target.hostname, port: Number(target.port) });
      await vi.waitFor(() => {
        expect(msgs(server.logs)).toContain('interrupted outbound recovered');
      }, { timeout: 10_000, interval: 100 });
      expect(server.logs.find((l) => l.msg === 'interrupted outbound recovered')).toMatchObject({ total: 1, completed: 1 });
      const { rows } = await pool.query(`SELECT b24_msg_id FROM message_log WHERE b24_msg_id LIKE 'job:%'`);
      expect(rows).toEqual([]);

      server.child.kill('SIGTERM');
      const { code, signal } = await server.exited;
      expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
    } finally {
      if (server?.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGKILL');
        await server.exited;
      }
      await proxy?.close();
    }
  }, 30_000);

  it('4) БД недоступна: SIGTERM во время паузы между попытками поиска → выход 0 без ожидания паузы', async () => {
    server = startServer({ ...env, DATABASE_URL: dbUrlOnPort(await freePort()) });
    await vi.waitFor(() => {
      expect(msgs(server.logs)).toContain('interrupted outbound lookup failed, retrying');
    }, { timeout: 10_000, interval: 50 });

    const signalAt = Date.now();
    server.child.kill('SIGTERM');
    const { code, signal } = await server.exited;
    expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
    // пауза между попытками — 5 с; сигнал её прерывает
    expect(Date.now() - signalAt).toBeLessThan(3_000);
    expect(msgs(server.logs)).toContain('interrupted outbound recovery stopped by shutdown');
    expect(server.logs.find((l) => l.msg === 'shutdown complete')).toMatchObject({ signal: 'SIGTERM', code: 0 });
  });

  it('2) SIGINT — тот же путь остановки, exit 0', async () => {
    server = startServer(env);
    await vi.waitFor(() => {
      expect(msgs(server.logs)).toContain('server listening');
    }, { timeout: 10_000, interval: 50 });

    server.child.kill('SIGINT');
    const { code, signal } = await server.exited;
    expect({ code, signal }, server.output()).toEqual({ code: 0, signal: null });
    expect(server.logs.find((l) => l.msg === 'shutdown complete')).toMatchObject({ signal: 'SIGINT', code: 0 });
  });
});
