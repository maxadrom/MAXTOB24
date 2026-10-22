#!/usr/bin/env node
// scripts/register-events.js — idempotent привязка пяти B24-событий к нашему handler'у
// POST /webhook/b24 через event.bind: OnImConnectorMessageAdd/Update/Delete (M5.1 + правка/
// удаление сообщений), OnImConnectorDialogFinish (закрытие диалога, M25) и OnAppUninstall
// (удаление приложения, M26). Режим по умолчанию доподпишет только недостающие.
//
// В B24Client нет именованных обёрток event.* — для verify-milestone зовём
// b24Client.callMethod('event.bind' | 'event.get' | 'event.unbind', …) напрямую
// (обёртки ради одного скрипта не заводим). Bootstrap (pool + installations ради b24_access_token) —
// зеркало register-connector.js; структура команд — зеркало register-webhook.js.
//
// Предусловие: на портале $B24_PORTAL пройден POST /api/install
// (в installations есть свежий b24_access_token), $B24_EVENT_HANDLER_URL задан.
//
// Запуск:
//   pnpm run register-events                  — idempotent: event.get → event.bind если не привязан
//   pnpm run register-events -- --list        — вывести привязанные события (event.get)
//   pnpm run register-events -- --unregister  — отвязать наш handler (event.unbind)
//   pnpm run register-events -- --help
//
// Тестируется через runScript({ argv, deps }) без process.exit
// (см. tests/scripts/register-events.smoke.test.js).

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { b24Graph, requireInstallation, runCli, scriptContext } from './lib/bootstrap.js';

// Коды событий, которые слушает наш контроллер (POST /webhook/b24):
//   OnImConnectorMessageAdd    → routeOutbound       (создание сообщения оператором OL→MAX)
//   OnImConnectorMessageUpdate → routeOutboundEdit   (правка сообщения оператором OL→MAX)
//   OnImConnectorMessageDelete → routeOutboundDelete (удаление сообщения оператором OL→MAX)
//   OnImConnectorDialogFinish  → routeDialogFinish   (сессия OL закрыта → опенер «группы», M25)
//   OnAppUninstall             → b24Service.handleAppUninstall (удаление приложения: сброс
//                                токенов, при CLEAN=1 — очистка данных моста, M26). На URL
//                                установки Б24 сам его не регистрирует — только event.bind.
// B24 хранит/возвращает коды событий в ВЕРХНЕМ регистре (event.get → ONIMCONNECTORMESSAGEADD),
// поэтому idempotency-сравнение — регистронезависимое.
const EVENT_CODES = [
  'OnImConnectorMessageAdd',
  'OnImConnectorMessageUpdate',
  'OnImConnectorMessageDelete',
  'OnImConnectorDialogFinish',
  'OnAppUninstall',
];

const HELP = `
register-events — idempotent привязка пяти B24-событий (${EVENT_CODES.join(', ')}) → $B24_EVENT_HANDLER_URL

Опции:
  (без опций)    Idempotent bind: event.get → event.bind для каждого события, если handler ещё не привязан.
  --list         Печатает привязанные события (event.get) на stdout.
  --unregister   Отвязывает наш handler от всех событий (event.unbind).
  --help         Эта справка.

Предусловия: POST /api/install пройден (installations.b24_access_token != null),
$B24_EVENT_HANDLER_URL = https://<your-domain>/webhook/b24 (HTTPS-доступный).
`.trim();

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return { ok: true, mode: 'help' };
  }

  const list = argv.includes('--list');
  const unregister = argv.includes('--unregister');
  if (list && unregister) {
    throw new Error('register-events: --list and --unregister are mutually exclusive');
  }

  const ctx = scriptContext('register-events', deps);
  const { config, logger } = ctx;
  const { installations, b24Client, close } = b24Graph(ctx, deps);

  const { portal, eventHandlerUrl } = config.b24;

  try {
    // ── fast-fail предусловия ──────────────────────────────────────────────────
    if (!portal) {
      throw new Error('B24_PORTAL is not set in .env');
    }
    // eventHandlerUrl нужен для bind/unbind (event.get его не требует).
    if (!list && !eventHandlerUrl) {
      throw new Error(
        'B24_EVENT_HANDLER_URL is not set in .env — required for event.bind/unbind ' +
          '(configure a public HTTPS URL pointing to POST /webhook/b24).',
      );
    }

    await requireInstallation(installations, portal, 'register-events');

    // ── --list ─────────────────────────────────────────────────────────────────
    if (list) {
      logger.info('listing bound events (event.get)');
      const data = await b24Client.callMethod('event.get', {});
      // stdout отдельно от pino-лога — для парсинга и инспекции.
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return { ok: true, mode: 'list', data };
    }

    // ── --unregister ─────────────────────────────────────────────────────────
    if (unregister) {
      const events = [];
      for (const eventCode of EVENT_CODES) {
        logger.info({ event: eventCode, handler: eventHandlerUrl }, 'event.unbind');
        const data = await b24Client.callMethod('event.unbind', {
          event: eventCode,
          handler: eventHandlerUrl,
        });
        events.push({ event: eventCode, data });
      }
      logger.info({ count: events.length }, 'unbind done');
      return { ok: true, mode: 'unregister', events };
    }

    // ── default: idempotent bind (по каждому событию из списка) ─────────────────
    // event.get зовём один раз; idempotency-check — регистронезависимый, по event+handler.
    const bound = await b24Client.callMethod('event.get', {});
    const records = Array.isArray(bound) ? bound : [];
    logger.debug({ count: records.length }, 'event.get returned');

    const events = [];
    for (const eventCode of EVENT_CODES) {
      const eventUpper = eventCode.toUpperCase();
      const alreadyBound = records.some(
        (rec) =>
          String(rec?.event ?? '').toUpperCase() === eventUpper &&
          rec?.handler === eventHandlerUrl,
      );

      if (alreadyBound) {
        logger.info(
          { event: eventCode, handler: eventHandlerUrl },
          'event already bound (skip)',
        );
        events.push({ event: eventCode, alreadyBound: true });
        continue;
      }

      logger.info({ event: eventCode, handler: eventHandlerUrl }, 'event.bind');
      const data = await b24Client.callMethod('event.bind', {
        event: eventCode,
        handler: eventHandlerUrl,
      });
      logger.info({ event: eventCode, data }, 'event bound');
      events.push({ event: eventCode, alreadyBound: false, data });
    }

    // Агрегат для обратной совместимости: alreadyBound=true только если ВСЕ события уже привязаны.
    const alreadyBound = events.every((e) => e.alreadyBound);
    return { ok: true, mode: 'bind', alreadyBound, events };
  } finally {
    await close();
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('register-events', runScript);
