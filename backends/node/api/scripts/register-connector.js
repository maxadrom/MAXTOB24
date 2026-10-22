#!/usr/bin/env node
// scripts/register-connector.js — one-time регистрация коннектора MAX в Б24
// (М2-скоуп). Использует тот же DI-граф, что и app.js, но без app.listen.
//
// Предусловие: на портале $B24_PORTAL пройден POST /api/install
// (в installations есть свежий b24_access_token).
//
// Запуск:
//   pnpm run register-connector            — register + activate + seed
//   pnpm run register-connector -- --update      — re-register (force update icon/name) + activate, БЕЗ seed (прод: не трогает maxBotId)
//   pnpm run register-connector -- --unregister  — deactivate + unregister + clear

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { B24Service } from '../src/modules/b24/b24Service.js';
import { B24_CONNECTOR_DEFAULTS } from '../src/modules/b24/b24Constants.js';
import { b24Graph, maxClientFor, requireInstallation, runCli, scriptContext } from './lib/bootstrap.js';

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  const unregister = argv.includes('--unregister');
  // M10: --update — повторно зарегистрировать существующий коннектор (обновить
  // иконку/имя на проде) через forceReregister, пропустив seed installations.
  const update = argv.includes('--update');

  const ctx = scriptContext('register-connector', deps);
  const { config, logger } = ctx;
  const { installations, b24Client, close } = b24Graph(ctx, deps);
  const b24 = deps.b24 ?? new B24Service({ b24Client, installationsService: installations, logger });

  const { portal, olLineId, connectorId, connectorName, placementHandlerUrl } = config.b24;

  try {
    // ── fast-fail предусловия (внутри try: пул закрывается и при отказе) ───────
    if (!portal) {
      throw new Error('B24_PORTAL is not set in .env');
    }
    if (!olLineId) {
      throw new Error('OL_LINE_ID is not set in .env');
    }
    if (!unregister && !placementHandlerUrl) {
      throw new Error(
        'B24_PLACEMENT_HANDLER_URL is not set — required for imconnector.register ' +
          '(NO_PLACEMENT_HANDLER otherwise). Configure a public HTTPS URL pointing to GET /b24/connector-settings.',
      );
    }
    await requireInstallation(installations, portal, 'register-connector');

    if (unregister) {
      logger.info({ portal, connectorId, olLineId }, 'unregister mode');
      await b24.unregisterConnector({ connectorId, lineId: olLineId });
      await installations.clearConnectorMetadata();
      logger.info('unregister done');
      return { ok: true, mode: 'unregister' };
    }

    logger.info({ portal, connectorId, olLineId, update }, 'register+activate mode');
    const result = await b24.registerConnector({
      connectorId,
      lineId: olLineId,
      name: connectorName,
      icon: B24_CONNECTOR_DEFAULTS.ICON,
      iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED,
      placementHandlerUrl,
      forceReregister: update,
    });

    // M10: в режиме --update НЕ трогаем installation-метаданные. seedSingleTenant
    // пишет maxBotId ?? null, и если getMe упадёт (таймаут/токен) — боевой maxBotId
    // обнулится → outbound-фильтрация по боту сломается. Косметика (иконка/имя)
    // метаданные не меняет, поэтому getMe+seed пропускаем целиком.
    if (update) {
      logger.info(
        { connectorId, wasAlreadyRegistered: result.wasAlreadyRegistered },
        'update mode: skipping getMe + seedSingleTenant (installation metadata untouched)',
      );
      return {
        ok: true,
        mode: 'update',
        wasAlreadyRegistered: result.wasAlreadyRegistered,
      };
    }

    // Опционально получаем max_bot_id через GET /me MAX API.
    // Падение здесь не блокирует регистрацию — записываем maxBotId=null.
    let maxBotId = null;
    if (config.max.botToken) {
      try {
        const me = await maxClientFor(ctx, deps).getMe();
        maxBotId = me?.user_id != null ? String(me.user_id) : null;
      } catch (err) {
        logger.warn(
          { err: { message: err?.message } },
          'failed to fetch MAX bot id, continuing without it',
        );
      }
    }

    const seeded = await installations.seedSingleTenant({
      portal,
      olLineId,
      connectorId: result.connectorId,
      maxBotId,
    });
    logger.info(
      {
        installationId: seeded.id,
        connectorId: seeded.connectorId,
        olLineId: seeded.olLineId,
        maxBotId: seeded.maxBotId,
      },
      'connector registered & installation seeded',
    );
    return {
      ok: true,
      mode: 'register',
      installation: seeded,
      wasAlreadyRegistered: result.wasAlreadyRegistered,
    };
  } finally {
    await close();
  }
}

if (isInvokedDirectly(import.meta.url)) runCli('register-connector', runScript);
