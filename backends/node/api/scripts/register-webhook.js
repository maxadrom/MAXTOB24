#!/usr/bin/env node
// scripts/register-webhook.js — регистрация MAX webhook через POST /subscriptions (M3).
//
// Предусловия:
//   - MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET, MAX_PUBLIC_WEBHOOK_URL заданы в .env
//   - MAX_PUBLIC_WEBHOOK_URL начинается с https:// (MAX отвергает HTTP)
//   - публичный HTTPS (prod-домен или dev-туннель) проксирует /webhook/* в api-node:8000
//
// Запуск:
//   pnpm run register-webhook                  — idempotent: GET → POST если url не подписан;
//                                                url подписан, но update_types расходятся с
//                                                конфигом → warn со списком, без записи
//   pnpm run register-webhook -- --force       — повторный POST поверх существующей подписки
//                                                (обновить update_types, напр. chat_title_changed M24)
//   pnpm run register-webhook -- --list        — вывести подписки на stdout
//   pnpm run register-webhook -- --unregister  — удалить подписку с этим url
//
// Бот общий с продом: register/--force/--unregister запускать только на прод-VPS.
//
// Тестируется через runScript({ argv, deps }) без process.exit (см. tests/scripts/register-webhook.smoke.test.js).

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { maxClientFor, runCli, scriptContext } from './lib/bootstrap.js';

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  const list = argv.includes('--list');
  const unregister = argv.includes('--unregister');
  const force = argv.includes('--force');
  if (list && unregister) {
    throw new Error('register-webhook: --list and --unregister are mutually exclusive');
  }
  if (force && (list || unregister)) {
    throw new Error('register-webhook: --force is only for register mode');
  }

  const ctx = scriptContext('register-webhook', deps);
  const { config, logger } = ctx;

  const { botToken, webhookSecret, publicWebhookUrl, webhookUpdateTypes } = config.max;

  // ── fast-fail предусловия ──────────────────────────────────────────────────
  if (!botToken) {
    throw new Error('MAX_BOT_TOKEN is not set in .env');
  }
  if (!list) {
    if (!publicWebhookUrl) {
      throw new Error(
        'MAX_PUBLIC_WEBHOOK_URL is not set in .env (required for register/unregister)',
      );
    }
    if (!publicWebhookUrl.startsWith('https://')) {
      throw new Error(
        `MAX_PUBLIC_WEBHOOK_URL must start with https:// (got "${publicWebhookUrl}")`,
      );
    }
  }
  if (!unregister && !list) {
    if (!webhookSecret) {
      throw new Error('MAX_WEBHOOK_SECRET is not set in .env (required for register)');
    }
    if (!Array.isArray(webhookUpdateTypes) || webhookUpdateTypes.length === 0) {
      throw new Error(
        'MAX_WEBHOOK_UPDATE_TYPES resolved to empty array — check config defaults',
      );
    }
  }

  const maxClient = maxClientFor(ctx, deps);

  // ── --list ─────────────────────────────────────────────────────────────────
  if (list) {
    logger.info('listing subscriptions');
    const data = await maxClient.listSubscriptions();
    // Печатаем в stdout отдельно от pino-лога — для парсинга и инспекции.
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mode: 'list', data };
  }

  // ── --unregister ───────────────────────────────────────────────────────────
  if (unregister) {
    logger.info({ url: publicWebhookUrl }, 'unregister webhook');
    const data = await maxClient.removeSubscription({ url: publicWebhookUrl });
    logger.info({ data }, 'unregister done');
    return { ok: true, mode: 'unregister', data };
  }

  // ── default: idempotent register ───────────────────────────────────────────
  const current = await maxClient.listSubscriptions();
  const subs = Array.isArray(current?.subscriptions) ? current.subscriptions : [];
  const existing = subs.find((s) => s?.url === publicWebhookUrl) ?? null;
  const alreadySubscribed = existing !== null;
  if (alreadySubscribed && !force) {
    // Повторный POST не делаем без --force: что MAX делает с update_types существующей
    // подписки, дока не описывает. Расхождение — подсказка оператору.
    const subscribedTypes = Array.isArray(existing.update_types) ? existing.update_types : [];
    const missing = webhookUpdateTypes.filter((t) => !subscribedTypes.includes(t));
    const extra = subscribedTypes.filter((t) => !webhookUpdateTypes.includes(t));
    if (missing.length > 0 || extra.length > 0) {
      logger.warn(
        { url: publicWebhookUrl, missing, extra },
        'already subscribed, update_types differ from config — re-run with --force to update',
      );
    } else {
      logger.warn(
        { url: publicWebhookUrl, totalSubs: subs.length },
        'already subscribed — skipping POST /subscriptions',
      );
    }
    return { ok: true, mode: 'register', alreadySubscribed: true, missing, extra };
  }

  logger.info(
    { url: publicWebhookUrl, updateTypes: webhookUpdateTypes, force: alreadySubscribed },
    'POST /subscriptions',
  );
  const data = await maxClient.subscribe({
    url: publicWebhookUrl,
    secret: webhookSecret,
    updateTypes: webhookUpdateTypes,
  });
  logger.info({ data }, 'subscription created');
  return { ok: true, mode: 'register', alreadySubscribed, forced: alreadySubscribed, data };
}

if (isInvokedDirectly(import.meta.url)) runCli('register-webhook', runScript);
