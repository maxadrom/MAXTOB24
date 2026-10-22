#!/usr/bin/env node
// scripts/audit-bindings.js — read-only аудит привязок MAX-чат ↔ чат ОЛ (M21).
//
// До M21 мост онбордил любой чат, откуда пришло message_created: личку с ботом (сессия ОЛ
// у операторов) и канал (привязка-мусор). Тип чата знает только MAX API, поэтому миграцией
// такие привязки не вычистить: скрипт по каждой привязке зовёт GET /chats/{id} и печатает
// тип, счётчики message_log и вердикт. Ничего не меняет и не удаляет — для кандидатов
// печатает SQL, который выполняют вручную и только с согласия владельца прода.
//
// Предусловия: в БД есть installation (POST /api/install пройден), MAX_BOT_TOKEN задан.
//
// Запуск:
//   pnpm run audit-bindings                — таблица на stdout
//   pnpm run audit-bindings -- --json      — JSON на stdout
//   pnpm run audit-bindings -- --help
//   make audit-bindings ARGS="--json"      — внутри docker-compose
//
// Тестируется через runScript({ argv, deps }) без process.exit
// (см. tests/scripts/audit-bindings.smoke.test.js).

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { BindingsRepository } from '../src/modules/bindings/bindingsRepository.js';
import { MessageLogRepository } from '../src/modules/messaging/messageLogRepository.js';
import { b24Graph, maxClientFor, runCli, scriptContext } from './lib/bootstrap.js';

const HELP = `
audit-bindings — read-only аудит привязок: тип каждого MAX-чата (GET /chats/{id}) и активность

Опции:
  (без опций)  Таблица на stdout + SQL-подсказка для кандидатов на удаление.
  --json       То же JSON-ом.
  --help       Эта справка.

Вердикт: group — группа (норма); not-group — личка или канал, онбордились до M21
(кандидат на удаление); unknown — MAX не ответил (бот удалён из чата, чат удалён) —
проверить вручную. Скрипт ничего не удаляет.
`.trim();

const NOT_GROUP_TYPES = new Set(['dialog', 'channel']);

// Тип чата из MAX. Ошибка (403/404 — бот удалён, чат удалён) — не падение аудита.
async function probeChat(maxClient, maxChatId) {
  try {
    const chat = await maxClient.getChat(maxChatId);
    return {
      type: typeof chat?.type === 'string' ? chat.type : null,
      hasTitle: typeof chat?.title === 'string' && chat.title.trim().length > 0,
      error: null,
    };
  } catch (err) {
    const code = [err?.httpStatus, err?.maxCode].filter(Boolean).join(' ');
    return { type: null, hasTitle: false, error: code || err?.message || String(err) };
  }
}

function verdictOf(type) {
  if (type === 'chat') return 'group';
  if (NOT_GROUP_TYPES.has(type)) return 'not-group';
  return 'unknown';
}

function formatTable(rows) {
  const header = ['id', 'max_chat_id', 'type', 'verdict', 'title', 'b24_chat', 'in', 'out', 'last_message'];
  const lines = rows.map((r) => [
    r.id,
    r.maxChatId,
    r.type ?? `error: ${r.error}`,
    r.verdict,
    r.hasTitle ? 'yes' : '-',
    r.b24ChatId ?? '-',
    r.inbound,
    r.outbound,
    r.lastAt ?? '-',
  ].map(String));
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(header), ...lines.map(fmt)].join('\n');
}

function cleanupHint(candidates, unknown) {
  const out = [];
  if (candidates.length > 0) {
    const ids = candidates.map((r) => r.id).join(', ');
    out.push(
      `Кандидаты на удаление (личка/канал): ${ids}`,
      'Удаление — только вручную и с согласия владельца прода:',
      `  DELETE FROM chat_bindings WHERE id IN (${ids});`,
      '  (каскадом удаляет message_log и participant_map; открытые сессии ОЛ закрыть в Б24 руками)',
    );
  } else {
    out.push('Кандидатов на удаление нет.');
  }
  if (unknown.length > 0) {
    out.push(`Тип не определён (проверить вручную): ${unknown.map((r) => r.id).join(', ')}`);
  }
  return out.join('\n');
}

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return { ok: true, mode: 'help' };
  }
  const asJson = argv.includes('--json');

  const ctx = scriptContext('audit-bindings', deps);
  const { logger } = ctx;
  const { pool, installations, close } = b24Graph(ctx, deps);
  const maxClient = maxClientFor(ctx, deps);
  const bindingsRepo = deps.bindingsRepo ?? new BindingsRepository(pool, logger);
  const messageLogRepo = deps.messageLogRepo ?? new MessageLogRepository(pool, logger);

  try {
    if (!maxClient.hasToken()) {
      throw new Error('MAX_BOT_TOKEN is not set in .env — audit needs GET /chats/{id}');
    }
    const installation = await installations.getCurrent();
    const bindings = await bindingsRepo.listByInstallation(installation.id);
    const stats = await messageLogRepo.statsByBindings(bindings.map((b) => b.id));
    logger.info({ count: bindings.length }, 'auditing bindings');

    const rows = [];
    // Последовательно: лимит MAX — 30 rps, привязок единицы-десятки.
    for (const b of bindings) {
      // eslint-disable-next-line no-await-in-loop
      const chat = await probeChat(maxClient, b.maxChatId);
      const s = stats.get(String(b.id)) ?? { inbound: 0, outbound: 0, lastAt: null };
      rows.push({
        id: b.id,
        maxChatId: b.maxChatId,
        type: chat.type,
        error: chat.error,
        verdict: verdictOf(chat.type),
        hasTitle: chat.hasTitle,
        b24ChatId: b.b24ChatId,
        inbound: s.inbound,
        outbound: s.outbound,
        lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null,
      });
    }
    const candidates = rows.filter((r) => r.verdict === 'not-group');
    const unknown = rows.filter((r) => r.verdict === 'unknown');

    // stdout отдельно от pino-лога — для чтения и парсинга.
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ rows, candidates: candidates.map((r) => r.id) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatTable(rows)}\n\n${cleanupHint(candidates, unknown)}\n`);
    }
    return { ok: true, mode: 'audit', rows, candidates: candidates.map((r) => r.id) };
  } finally {
    await close();
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('audit-bindings', runScript);
