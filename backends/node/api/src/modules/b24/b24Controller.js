// POST /webhook/b24. Проверяем auth[application_token].
// Источник ожидаемого токена: b24_application_token из БД (приоритет), а при его
// отсутствии — env-fallback B24_APPLICATION_TOKEN (M9, «Только API»: install-callback
// может прийти с задержкой). Оба пусты → 503; mismatch → 401.
// M19: после токена — auth[member_id] против сохранённого b24_member_id (если он есть):
// другой → 401; в событии нет → warn и пропуск (мост не роняем из-за расхождения с докой).
// M26: строка installations помечена uninstalled_at (ONAPPUNINSTALL) → любое событие
// получает 503 B24_APP_UNINSTALLED ещё до проверки токена: env-fallback не действует,
// вебхук открывает только переустановка (POST /api/install).

import { OpenLineEvent } from './models/OpenLineEvent.js';
import { timingSafeStrEqual } from '../../shared/crypto/timingSafeStrEqual.js';
import { ValidationError } from '../../shared/http/domainErrors.js';
import { sendError } from '../../shared/http/errorResponse.js';
import { routeLogger } from '../../shared/logger/httpLogger.js';

export class B24Controller {
  constructor({ service, installationsService, applicationToken = null, logger }) {
    if (!service) throw new TypeError('B24Controller: service required');
    if (!installationsService) throw new TypeError('B24Controller: installationsService required');
    this.service = service;
    this.installations = installationsService;
    // M9: env-fallback для верификации /webhook/b24, когда b24_application_token
    // в БД ещё NULL (install-callback «Только API» может прийти с задержкой) или
    // installation ещё не создан на свежей БД. Значение из config.b24.applicationToken
    // (env B24_APPLICATION_TOKEN). БД-токен всегда имеет приоритет над env.
    this.applicationToken = applicationToken ?? null;
    this.logger = logger;
  }

  // GET /b24/connector-settings — заглушка для PLACEMENT_HANDLER. Б24 открывает
  // её в слайдере при клике «настройки коннектора» в OL. На M2 без неё
  // imconnector.register падает с NO_PLACEMENT_HANDLER. Реальный UI — post-MVP.
  getConnectorSettingsPlaceholder = (req, res) => {
    const log = req.log ?? this.logger;
    log?.info(
      { ua: req.get?.('user-agent') ?? null, referer: req.get?.('referer') ?? null },
      'b24 connector settings placeholder opened',
    );
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>MAX connector settings</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h2>MAX коннектор</h2>
  <p>Настройки коннектора будут добавлены в post-MVP.</p>
  <p>Подключение группового чата MAX к Open Line управляется через бэкенд (см. README).</p>
</body></html>`,
      );
  };

  handleWebhook = async (req, res, next) => {
    const log = req.log ?? this.logger;
    // M5.2: auth.application_token редактирован — секрет не утекает в лог.
    if (log?.isLevelEnabled?.('debug') ?? true) {
      log?.debug(
        { rawBody: { ...req.body, auth: req.body?.auth ? '[redacted]' : undefined } },
        'b24 webhook raw payload',
      );
    }
    try {
      let event;
      try {
        event = OpenLineEvent.fromWebhookBody(req.body);
      } catch (err) {
        throw new ValidationError(`B24 webhook payload invalid: ${err.message}`);
      }

      log?.info({ event: event.event, lineId: event.lineId }, 'b24 webhook received');

      // M9: стартуем с env-fallback (this.applicationToken). getCurrent() БРОСАЕТ
      // NotFoundError на свежей БД — env-значение, выставленное ДО try, тогда не
      // теряется. БД-токен (если есть) переопределяет env: db > env > none.
      let expectedToken = this.applicationToken ?? null;
      let tokenSource = expectedToken ? 'env' : 'none';
      let installation = null;
      try {
        installation = await this.installations.getCurrent();
        if (installation?.b24ApplicationToken) {
          expectedToken = installation.b24ApplicationToken;
          tokenSource = 'db';
        }
        // installation есть, но токена нет → остаёмся на env-fallback (если задан).
      } catch {
        // installation отсутствует на свежей БД → остаёмся на env-fallback (если задан).
      }

      // M26: приложение удалено — токен в БД обнулён, и env-fallback не должен снова
      // открыть вебхук. Раскрытие то же, что у 503 B24_WEBHOOK_DISABLED; Б24 после
      // удаления сюда событий не шлёт (подписки сняты).
      if (installation?.isUninstalled?.()) {
        log?.warn({ event: event.event }, 'b24 webhook rejected: app uninstalled — reinstall the Bitrix24 app');
        sendError(req, res, 503, 'B24_APP_UNINSTALLED', 'app uninstalled — reinstall required');
        return;
      }

      // verbose: источник и last-4/длина ожидаемого токена — НЕ полное значение (секрет).
      log?.debug(
        {
          tokenSource,
          expectedTokenLen: expectedToken ? expectedToken.length : 0,
          expectedTokenLast4: expectedToken ? expectedToken.slice(-4) : null,
        },
        'b24 webhook expected token resolved',
      );

      if (!expectedToken) {
        log?.warn({ tokenSource: 'none' }, 'b24 application_token missing (db+env) — webhook disabled');
        sendError(req, res, 503, 'B24_WEBHOOK_DISABLED', 'b24 application_token missing (db and env) — webhook disabled');
        return;
      }

      if (!timingSafeStrEqual(event.applicationToken, expectedToken)) {
        log?.warn(
          { requestId: req.id, tokenSource },
          'b24 webhook rejected: application_token mismatch',
        );
        sendError(req, res, 401, 'B24_AUTH_INVALID', 'application_token mismatch');
        return;
      }

      if (!this._memberIdMatches(event, installation, log, req)) {
        sendError(req, res, 401, 'B24_MEMBER_MISMATCH', 'member_id mismatch');
        return;
      }

      // Удаление приложения (ONAPPUNINSTALL, M26), правка/удаление оператора
      // (OnImConnectorMessageUpdate/Delete) и закрытие диалога (OnImConnectorDialogFinish,
      // M25) — отдельные пути; всё остальное — в общий диспатч (routeOutbound сам отсеет
      // не-Add события). Тот же auth-конверт; маршрут расходится только в сервисе.
      let result;
      if (event.isAppUninstall()) {
        result = await this.service.handleAppUninstall(event, {
          logger: routeLogger(req, this.logger, 'b24.appUninstall'),
        });
      } else if (event.isDialogFinish()) {
        result = await this.service.handleOpenLineDialogFinish(event, {
          logger: routeLogger(req, this.logger, 'messaging.routeDialogFinish'),
        });
      } else if (event.isMessageUpdate()) {
        result = await this.service.handleOpenLineMessageEdit(event, {
          logger: routeLogger(req, this.logger, 'messaging.routeOutboundEdit'),
        });
      } else if (event.isMessageDelete()) {
        result = await this.service.handleOpenLineMessageDelete(event, {
          logger: routeLogger(req, this.logger, 'messaging.routeOutboundDelete'),
        });
      } else {
        result = await this.service.handleOpenLineMessageAdd(event, {
          logger: routeLogger(req, this.logger, 'messaging.routeOutbound'),
        });
      }
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  };

  // Сверка member_id (M19). Сохранённого нет (до первого рефреша/переустановки после
  // миграции 0008, env-fallback без строки) → пропуск. В событии нет → warn и пропуск.
  _memberIdMatches(event, installation, log, req) {
    const stored = installation?.b24MemberId ?? null;
    if (!stored) return true;
    const incoming = event.memberId;
    if (!incoming) {
      log?.warn({ requestId: req.id, event: event.event }, 'b24 webhook: auth.member_id absent — check skipped');
      return true;
    }
    if (incoming === stored) return true;
    log?.warn({ requestId: req.id, event: event.event }, 'b24 webhook rejected: member_id mismatch');
    return false;
  }
}
