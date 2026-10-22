#!/usr/bin/env node
// scripts/probe-max-send.js — ad-hoc эмпирическая проверка MAX POST /messages
// на живом MAX Bot API (M5.1: снять контракт метода).
//
// Назначение: снять живую request/response-форму POST /messages (изначально — до
// реализации routeOutbound; сейчас — для диагностики формата/markdown).
// Probe зовёт публичный maxClient.sendMessage — тот же путь, что production.
//
// Bootstrap БЕЗ DB (MAX stateless, зеркало register-webhook): scripts/lib/bootstrap.js.
//
// Предусловия:
//   - MAX_BOT_TOKEN задан в .env;
//   - <chatId> передан позиционным аргументом (обязательно).
//
// Запуск:
//   pnpm run probe-max-send -- <chatId>     — реальный POST /messages, тестовое сообщение
//   pnpm run probe-max-send -- <chatId> --dry-run  — только напечатать payload
//   pnpm run probe-max-send -- --help
//   make probe-max-send ARGS="<chatId>"     — внутри docker-compose
//
// Side-effect: при удачном вызове в MAX-группу <chatId> прилетит одно
// тестовое сообщение «M5 probe — please ignore».

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { maxClientFor, runCli, scriptContext } from './lib/bootstrap.js';

const PROBE_TEXT = 'M5 probe — please ignore';
const PROBE_FORMAT_TEXT = '**Жирный** _курсив_\nперенос';
const PROBE_LITERAL_TEXT = 'цена 2 * 2, файл my_file_name.txt, путь C:\\dir';

const HELP = `
probe-max-send — пробует MAX POST /messages?chat_id=<id> на живом MAX Bot API

Использование:
  pnpm run probe-max-send -- <chatId> [опции]

Аргументы:
  <chatId>        Обязательный: chat_id из MAX (для группы обычно отрицательное число).

Опции:
  --dry-run       Печатает payload, но не отправляет в MAX.
  --format        M5.3: тест format:markdown (bold/italic rendering).
  --literal       M5.3: тест literal-маркеров (*/_/**) под format:markdown (probe 1b, регресс M5.2).
  --help          Эта справка.

Side-effect: на успешном вызове в MAX-группу будет отправлено тестовое сообщение.
`.trim();

function printSection(title) {
  // eslint-disable-next-line no-console
  console.log(`\n========== ${title} ==========`);
}

function printVerified({ request, response }) {
  // eslint-disable-next-line no-console
  console.log('\n=====================================');
  // eslint-disable-next-line no-console
  console.log('=== VERIFIED MAX sendMessage ===');
  // eslint-disable-next-line no-console
  console.log('=====================================');
  // eslint-disable-next-line no-console
  console.log('\nRequest (сравнить с ответом и реализацией):');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(request, null, 2));
  // eslint-disable-next-line no-console
  console.log('\nResponse (full quote — особое внимание message.body.mid / timestamp для дедупа):');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(response, null, 2));
  // eslint-disable-next-line no-console
  console.log('\nNext step (format-probe): сверь рендер с контрактом в docs/backend/formatting-delivery.md.');
}

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return { ok: true, mode: 'help' };
  }
  const dryRun = argv.includes('--dry-run');
  const formatProbe = argv.includes('--format');
  const literalProbe = argv.includes('--literal');
  // Первый не-флаговый аргумент после `node script` — override chat_id.
  const positional = argv.slice(2).filter((a) => !a.startsWith('--'));
  const chatIdOverride = positional[0] ?? null;

  const ctx = scriptContext('probe-max-send', deps);
  const { botToken } = ctx.config.max;
  const chatId = chatIdOverride ?? null;

  // ── fast-fail предусловия ────────────────────────────────────────────────
  if (!botToken) {
    throw new Error('MAX_BOT_TOKEN is not set in .env');
  }
  if (chatId === null || chatId === undefined || String(chatId).trim() === '') {
    throw new Error(
      'chat_id is required — pass it as a positional argument: pnpm run probe-max-send -- <chatId>',
    );
  }

  const maxClient = maxClientFor(ctx, deps);

  // Выбор тела запроса по режиму (M5.3 probe 1 / 1b / plain).
  let probeBody;
  let probeMode;
  if (literalProbe) {
    probeBody = { text: PROBE_LITERAL_TEXT, format: 'markdown' };
    probeMode = 'literal-markers (probe 1b)';
  } else if (formatProbe) {
    probeBody = { text: PROBE_FORMAT_TEXT, format: 'markdown' };
    probeMode = 'format:markdown';
  } else {
    probeBody = { text: PROBE_TEXT };
    probeMode = 'plain';
  }

  const request = { path: '/messages', query: { chat_id: chatId }, body: probeBody };

  printSection(`Candidate request [${probeMode}]`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(request, null, 2));

  if (dryRun) {
    printSection('--dry-run: skipping live call');
    return { ok: true, mode: 'dry-run', request };
  }

  printSection(`POST /messages (live) [${probeMode}]`);
  try {
    const response = await maxClient.sendMessage({ chatId, ...probeBody });
    printVerified({ request, response });
    return { ok: true, mode: probeMode, request, response };
  } catch (err) {
    printSection(`BLOCKED — MAX POST /messages failed [${probeMode}]`);
    // eslint-disable-next-line no-console
    console.error(`message: ${err?.message ?? String(err)}`);
    // eslint-disable-next-line no-console
    console.error(
      '\nProbe провалился. Заполни раздел «## Verified formatting contracts (M5.3)» как BLOCKED.',
    );
    return { ok: false, mode: probeMode, request, error: err?.message ?? String(err) };
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('probe-max-send', runScript, { notOkExitCode: 2 });
