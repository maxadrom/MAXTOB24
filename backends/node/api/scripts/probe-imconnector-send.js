#!/usr/bin/env node
// scripts/probe-imconnector-send.js — ad-hoc эмпирическая проверка метода
// imconnector.send.messages на живом B24 портале (M4: снять контракт метода).
//
// Назначение: MCP-индекс b24-dev-mcp пропускает этот метод, поэтому точное
// имя и payload-схему нужно подтвердить на тестовом портале до того, как
// мы начнём писать b24Client/b24Service/messagingService под него.
//
// Скрипт пробует кандидатов имени метода (в порядке убывания вероятности),
// и на первом 200 OK с непустым result печатает блок === VERIFIED === —
// по нему сверяется payload-схема в b24Client/b24Service.
//
// Предусловия:
//   - на портале $B24_PORTAL пройден POST /api/install (installations.b24_access_token не null);
//   - $B24_CONNECTOR_ID зарегистрирован (make register-connector);
//   - $OL_LINE_ID задан и активен.
//
// Запуск:
//   pnpm run probe-imconnector-send                — реальный вызов, тестовое сообщение
//   pnpm run probe-imconnector-send -- --dry-run   — только напечатать payload
//   pnpm run probe-imconnector-send -- --help
//   make probe-imconnector                         — внутри docker-compose
//
// Side-effect: при удачном PRIMARY-вызове в Open Line $OL_LINE_ID появится
// тестовое сообщение от фейкового user'a «Probe» в фейковом chat'е
// "max:test-probe". Оператор Open Line может удалить — это допустимая цена
// эксперимента.

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { b24Graph, requireInstallation, runCli, scriptContext } from './lib/bootstrap.js';

const HELP = `
probe-imconnector-send — пробует imconnector.send.messages на живом B24 портале

Опции:
  --dry-run     Печатает payload каждой попытки, но не отправляет в B24.
  --help        Эта справка.

Side-effect: на успешном вызове создаст тестовое сообщение в Open Line $OL_LINE_ID
от фейкового user'a (chat.id = "max:test-probe", text = "M4 probe — please ignore").
Оператор может удалить.
`.trim();

// Кандидаты в порядке убывания вероятности. Источник:
//   - практика партнёрских коннекторов: стабильно используется imconnector.send.messages
//   - b24-dev-mcp: индекс пропускает метод, но шаблон call-сайтов в PHP-партнёрских коннекторах
//     указывает на множественную форму (MESSAGES — array).
//   - Fallback'и на случай, если метод переименован в новых версиях B24.
const METHOD_CANDIDATES = Object.freeze([
  'imconnector.send.messages',
  'imconnector.send.message',
  'imconnector.messages.send',
]);

function buildProbePayload({ connectorId, lineId }) {
  // Source of truth: https://apidocs.bitrix24.ru/api-reference/imopenlines/imconnector/imconnector-send-messages.html
  // Верхний уровень — UPPER (CONNECTOR/LINE/MESSAGES), вложенные объекты — lower snake_case.
  // chat: {id*, name, url}  — поля type в доке нет (поэтому не шлём).
  // user: {id*, name, last_name, gender?, picture?, url?}  — пол называется gender, не sex.
  // message: {id, date (unix-ts sec), text}.
  return {
    CONNECTOR: connectorId,
    LINE: lineId,
    MESSAGES: [
      {
        chat: {
          id: 'max:test-probe',
          name: 'M4 probe chat',
        },
        user: {
          id: 'probe-user',
          name: 'Probe',
          last_name: '',
        },
        message: {
          id: `probe-mid-${Date.now()}`,
          text: 'M4 probe — please ignore',
          date: Math.floor(Date.now() / 1000),
        },
      },
    ],
  };
}

function isMethodNotFound(err) {
  if (!err || typeof err !== 'object') return false;
  const code = String(err.b24Code ?? '').toUpperCase();
  return code === 'ERROR_METHOD_NOT_FOUND' || code === 'METHOD_NOT_FOUND';
}

function isResultEmpty(result) {
  if (result === null || result === undefined) return true;
  if (typeof result === 'object' && !Array.isArray(result)) {
    return Object.keys(result).length === 0;
  }
  if (Array.isArray(result)) return result.length === 0;
  return false;
}

function printSection(title) {
  // eslint-disable-next-line no-console
  console.log(`\n========== ${title} ==========`);
}

function printVerified({ method, payload, result }) {
  // eslint-disable-next-line no-console
  console.log('\n=========================================');
  // eslint-disable-next-line no-console
  console.log('=== VERIFIED imconnector.send.messages ===');
  // eslint-disable-next-line no-console
  console.log('=========================================');
  // eslint-disable-next-line no-console
  console.log(`Method:        ${method}`);
  // eslint-disable-next-line no-console
  console.log('\nPayload:');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
  // eslint-disable-next-line no-console
  console.log('\nResult:');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log('\nNext step: сверь payload/result с B24Client.imconnectorSendMessages и docs/backend/inbound-routing.md.');
}

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return { ok: true, mode: 'help' };
  }
  const dryRun = argv.includes('--dry-run');

  const ctx = scriptContext('probe-imconnector-send', deps);
  const { config } = ctx;

  const { portal, olLineId, connectorId } = config.b24;

  // ── fast-fail предусловия ────────────────────────────────────────────────
  if (!portal) throw new Error('B24_PORTAL is not set in .env');
  if (!olLineId) throw new Error('OL_LINE_ID is not set in .env');
  if (!connectorId) throw new Error('B24_CONNECTOR_ID is not set in .env');

  const { installations, b24Client, close } = b24Graph(ctx, deps);

  try {
    await requireInstallation(installations, portal, 'probe-imconnector-send');

    // Предварительная проверка: коннектор реально зарегистрирован.
    printSection('Step 1 — imconnector.list (sanity check)');
    const list = await b24Client.imconnectorList();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(list, null, 2));
    const knownKeys =
      list && typeof list === 'object' && !Array.isArray(list) ? Object.keys(list) : [];
    if (!knownKeys.includes(connectorId)) {
      // eslint-disable-next-line no-console
      console.warn(
        `WARNING: connector "${connectorId}" not present in imconnector.list. ` +
          'Run `make register-connector` first.',
      );
    }

    const payload = buildProbePayload({ connectorId, lineId: olLineId });
    printSection('Step 2 — Candidate payload');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));

    if (dryRun) {
      printSection('--dry-run: skipping live call');
      return { ok: true, mode: 'dry-run', payload, candidates: METHOD_CANDIDATES };
    }

    const attempts = [];
    for (const method of METHOD_CANDIDATES) {
      printSection(`Step 3 — Trying ${method}`);
      try {
        const result = await b24Client.callMethod(method, payload);
        const empty = isResultEmpty(result);
        attempts.push({ method, ok: true, empty, result });
        // eslint-disable-next-line no-console
        console.log(`SUCCESS (${method}). Result:`);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        if (empty) {
          // eslint-disable-next-line no-console
          console.warn(
            `WARNING: method "${method}" returned 200 OK but empty result. ` +
              'Treating as success, but verify message actually arrived in Open Line.',
          );
        }
        printVerified({ method, payload, result });
        return { ok: true, mode: 'verified', method, payload, result, attempts };
      } catch (err) {
        attempts.push({
          method,
          ok: false,
          b24Code: err?.b24Code ?? null,
          b24Description: err?.b24Description ?? null,
          message: err?.message ?? String(err),
        });
        if (isMethodNotFound(err)) {
          // eslint-disable-next-line no-console
          console.log(`SKIP ${method}: ERROR_METHOD_NOT_FOUND, trying next candidate`);
          continue;
        }
        // Любая другая B24-ошибка — диагностически интересна.
        // Печатаем и пробуем следующий кандидат — payload может быть неверным,
        // и следующее имя метода всё равно стоит пощупать.
        // eslint-disable-next-line no-console
        console.warn(
          `FAIL ${method}: b24Code=${err?.b24Code ?? '<none>'} ` +
            `desc=${err?.b24Description ?? ''} message=${err?.message ?? ''}`,
        );
      }
    }

    printSection('BLOCKED — no candidate returned 200 OK');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(attempts, null, 2));
    // eslint-disable-next-line no-console
    console.error(
      '\nВсе кандидаты провалились: сверьте имя метода и payload-схему с документацией ' +
        'imconnector.send.messages и scope приложения (imconnector).',
    );
    return { ok: false, mode: 'blocked', attempts };
  } finally {
    await close();
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('probe-imconnector-send', runScript, { notOkExitCode: 2 });
