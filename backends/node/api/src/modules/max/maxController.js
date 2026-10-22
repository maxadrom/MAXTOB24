// POST /webhook/max. Secret-проверка живёт в shared/http/maxSecretMiddleware
// (вешается в app.js перед этим обработчиком; MAX подписывает webhook
//  plain-secret'ом, не HMAC).
//
// Контроллер:
//   - парсит payload через MaxUpdate.fromWebhookBody (нормализованная DTO);
//   - message_created → delegate в service.handleIncomingUpdate (inbound routing);
//   - message_edited → service.handleIncomingEdit (inbound-правка);
//   - message_removed → service.handleIncomingDelete (inbound-удаление);
//   - chat_title_changed → service.handleChatTitleChanged (название чата OL, M24);
//   - bot_added/bot_removed/user_added/user_removed → service.handleLifecycleEvent
//     (только лог + опциональный getChatMember для bot_added);
//   - остальные типы → 200 status:"ignored" + warn-лог (никогда 4xx/5xx,
//     иначе MAX ретраит до 10×).

import { MaxUpdate } from './models/MaxUpdate.js';
import { ValidationError } from '../../shared/http/domainErrors.js';
import { routeLogger } from '../../shared/logger/httpLogger.js';

// update_type → [метод сервиса, module scoped-логгера].
// message_edited/message_removed — отдельные пути от message_created (тот же mid, что
// у оригинала): dedup-guard координатора по «голому» mid отсёк бы их как duplicate.
const LIFECYCLE_ROUTE = ['handleLifecycleEvent', 'max.lifecycle'];
const ROUTES = {
  message_created: ['handleIncomingUpdate', 'messaging.routeInbound'],
  message_edited: ['handleIncomingEdit', 'messaging.routeInboundEdit'],
  message_removed: ['handleIncomingDelete', 'messaging.routeInboundDelete'],
  chat_title_changed: ['handleChatTitleChanged', 'messaging.routeChatTitleChanged'],
  bot_added: LIFECYCLE_ROUTE,
  bot_removed: LIFECYCLE_ROUTE,
  user_added: LIFECYCLE_ROUTE,
  user_removed: LIFECYCLE_ROUTE,
};

export class MaxController {
  constructor(service, logger) {
    this.service = service;
    this.logger = logger;
  }

  handleWebhook = async (req, res, next) => {
    const log = req.log ?? this.logger;
    try {
      let update;
      try {
        update = MaxUpdate.fromWebhookBody(req.body);
      } catch (err) {
        throw new ValidationError(`MAX webhook payload invalid: ${err.message}`);
      }

      log?.info(
        {
          updateType: update.updateType,
          chatId: update.chatId,
          mid: update.mid,
          senderId: update.senderId,
        },
        'max webhook received',
      );
      log?.debug({ rawBody: update.raw }, 'max webhook raw payload');

      const route = Object.hasOwn(ROUTES, update.updateType) ? ROUTES[update.updateType] : null;
      if (route) {
        const [method, module] = route;
        const result = await this.service[method](update, {
          logger: routeLogger(req, this.logger, module),
        });
        res.json({ ok: true, result });
        return;
      }

      // Любые другие типы — принимаем 200, чтобы MAX не ретраил.
      log?.warn({ updateType: update.updateType }, 'max webhook unhandled update_type');
      res.json({ ok: true, status: 'ignored', updateType: update.updateType });
    } catch (err) {
      next(err);
    }
  };
}
