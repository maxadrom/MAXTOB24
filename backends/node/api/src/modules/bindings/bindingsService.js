// Сервис-фасад модуля bindings. Других модулям видна только сервис-API.
// Доступ к участникам — тоже через сервис, не через прямой репозиторий.

import { ConfigError, ValidationError } from '../../shared/http/domainErrors.js';

// M25: id сессии OL — положительное целое (колонки integer).
function assertSessionId(fn, name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${fn}: ${name} must be positive integer`);
  }
}

// M27: закрытая сессия во флаге опенера — id сессии либо 0 («закрыта, номер неизвестен»).
function assertClosedSessionId(fn, name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${fn}: ${name} must be non-negative integer`);
  }
}

// M24: название группы — непустая строка (не из одних пробелов).
function assertTitle(fn, title) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new ValidationError(`${fn}: title must be non-empty string`);
  }
}

export class BindingsService {
  constructor({ bindingsRepository, participantMapRepository, installationsService, logger }) {
    this.bindings = bindingsRepository;
    this.participants = participantMapRepository;
    this.installations = installationsService;
    this.logger = logger;
  }

  async resolveByMaxChat(maxChatId) {
    if (!maxChatId) throw new ValidationError('maxChatId required');
    const installation = await this.installations.getCurrent();
    const binding = await this.bindings.findByMaxChat(installation.id, maxChatId);
    const ready = Boolean(binding?.isReadyForRouting?.());
    this.logger?.info({ maxChatId, bindingId: binding?.id ?? null, ready }, 'binding resolved');
    return { binding, isReady: ready, installation };
  }

  async resolveByConnectorChat(connectorChatId) {
    if (!connectorChatId) throw new ValidationError('connectorChatId required');
    const installation = await this.installations.getCurrent();
    const binding = await this.bindings.findByConnectorChat(
      installation.id,
      connectorChatId,
    );
    const ready = Boolean(binding?.isReadyForRouting?.());
    this.logger?.info(
      { connectorChatId, bindingId: binding?.id ?? null, ready },
      'binding resolved (by connector chat)',
    );
    return { binding, isReady: ready, installation };
  }

  // M-lifecycle: персист адреса OL-чата (session.CHAT_ID) на binding'е. Значение
  // стабильно между сессиями (проверено live), но может прийти впервые — координатор
  // зовёт это best-effort после первого inbound. Возвращает обновлённый ChatBinding.
  async attachB24ChatId(bindingId, b24ChatId) {
    if (!bindingId) throw new ValidationError('attachB24ChatId: bindingId required');
    if (typeof b24ChatId !== 'string' || b24ChatId.length === 0) {
      throw new ValidationError('attachB24ChatId: b24ChatId must be non-empty string');
    }
    this.logger?.debug({ bindingId, b24ChatId }, 'BindingsService.attachB24ChatId: persisting b24ChatId');
    const binding = await this.bindings.updateB24ChatId(bindingId, b24ChatId);
    this.logger?.debug({ bindingId, b24ChatId }, 'BindingsService.attachB24ChatId: persisted');
    return binding;
  }

  // Запоминает участника и его последнее имя (источник имени для delete, M23). Запись —
  // только при новом участнике или смене имени (M21). → ParticipantMap либо null (не менялось).
  async ensureParticipant(bindingId, { maxUserId, displayName = null }) {
    if (!bindingId || !maxUserId) {
      throw new ValidationError('ensureParticipant: bindingId & maxUserId required');
    }
    return this.participants.upsert({
      bindingId,
      maxUserId,
      maxDisplayName: displayName,
    });
  }

  // M23: имя автора для imconnector.delete.messages (Б24 без имени делает его «Гостем»).
  // null — участника нет; непустой fallback подставляет b24Service.
  async findParticipantName(bindingId, maxUserId) {
    if (!bindingId || maxUserId === null || maxUserId === undefined || maxUserId === '') {
      throw new ValidationError('findParticipantName: bindingId & maxUserId required');
    }
    return this.participants.findDisplayName(bindingId, maxUserId);
  }

  // M24: актуальное название группы в MAX (интро при онбординге, chat_title_changed).
  // Чат OL переименовывает координатор: needsOlTitleSync() после этого вернёт true.
  async updateMaxChatTitle(bindingId, title) {
    if (!bindingId) throw new ValidationError('updateMaxChatTitle: bindingId required');
    assertTitle('updateMaxChatTitle', title);
    return this.bindings.updateMaxChatTitle(bindingId, title);
  }

  // M24: название поставлено в чат OL (imconnector.chat.name.set прошёл).
  async markOlChatTitle(bindingId, title) {
    if (!bindingId) throw new ValidationError('markOlChatTitle: bindingId required');
    assertTitle('markOlChatTitle', title);
    return this.bindings.updateOlChatTitle(bindingId, title);
  }

  // M25: сессия OL из ответа send.messages. Возвращает обновлённый ChatBinding либо
  // null, если запись не понадобилась (сессия та же, флаг закрытия не снят).
  async rememberOlSession(bindingId, sessionId) {
    if (!bindingId) throw new ValidationError('rememberOlSession: bindingId required');
    assertSessionId('rememberOlSession', 'sessionId', sessionId);
    return this.bindings.updateOlSession(bindingId, sessionId);
  }

  // M25: сессия OL закрыта (OnImConnectorDialogFinish) — следующее входящее открывает
  // «группа». null — событие устарело или сессия уже помечена.
  async markOlSessionClosed(bindingId, sessionId) {
    if (!bindingId) throw new ValidationError('markOlSessionClosed: bindingId required');
    assertSessionId('markOlSessionClosed', 'sessionId', sessionId);
    return this.bindings.markOlSessionClosed(bindingId, sessionId);
  }

  // M27: сессия OL закрыта — второй сигнал, CHAT_RENAMING_FAILED на переименование группы
  // при закрытой сессии (imopenlines.dialog.get). knownSessionId — последняя известная
  // сессия привязки: число → флаг этой сессии (как от Finish); null (старая привязка ещё
  // не знает сессию) → флаг 0 «закрыта, номер неизвестен». null в ответе — флаг уже
  // взведён или устарел (входящее успело открыть сессию).
  async markOlSessionClosedByRename(bindingId, knownSessionId) {
    if (!bindingId) throw new ValidationError('markOlSessionClosedByRename: bindingId required');
    if (knownSessionId === null) return this.bindings.markOlSessionClosedUnknown(bindingId);
    assertSessionId('markOlSessionClosedByRename', 'knownSessionId', knownSessionId);
    return this.bindings.markOlSessionClosed(bindingId, knownSessionId);
  }

  // M25: опенер отправлен (sessionId — его сессия) или не нужен (null) — снять флаг,
  // если он всё ещё про closedSessionId. null — флаг уже другой. M27: closedSessionId = 0 —
  // флаг без номера сессии (markOlSessionClosedByRename).
  async completeSessionOpener(bindingId, closedSessionId, sessionId = null) {
    if (!bindingId) throw new ValidationError('completeSessionOpener: bindingId required');
    assertClosedSessionId('completeSessionOpener', 'closedSessionId', closedSessionId);
    if (sessionId !== null) assertSessionId('completeSessionOpener', 'sessionId', sessionId);
    return this.bindings.clearOlClosedSession(bindingId, closedSessionId, sessionId);
  }

  // M7: авто-онбординг при первом входящем сообщении из нового MAX-чата.
  // M21: один атомарный upsert — повторный и конкурентный вызов возвращают ту же привязку,
  // привязка без connector_chat_id (сбой онбординга до M21) дозаполняется. Всегда
  // возвращает ChatBinding с connector_chat_id → isReadyForRouting() === true.
  // installation — уже прочитанная вызывающим (resolveByMaxChat), чтобы не читать её снова.
  // M26: приложение Б24 удалено → ConfigError (503), привязка не создаётся: MAX ретраит
  // входящее, и после переустановки в пределах окна ретраев оно дойдёт.
  // → { binding, created }: created — привязку создал этот вызов.
  async ensureForMaxChat(maxChatId, { maxChatTitle = null, installation = null } = {}) {
    if (maxChatId === null || maxChatId === undefined || maxChatId === '') {
      throw new ValidationError('ensureForMaxChat: maxChatId required');
    }
    const chatIdStr = String(maxChatId);
    const inst = installation ?? await this.installations.getCurrent();
    if (inst.isUninstalled?.()) {
      throw new ConfigError('ensureForMaxChat: Bitrix24 app is uninstalled — reinstall it (POST /api/install)');
    }
    const { binding, created } = await this.bindings.upsertForMaxChat({
      installationId: inst.id,
      maxChatId: chatIdStr,
      maxChatTitle,
    });
    if (created) {
      this.logger?.info(
        { bindingId: binding.id, connectorChatId: binding.connectorChatId },
        `auto-onboarded binding ${binding.id} connector_chat_id=${binding.connectorChatId}`,
      );
    } else {
      this.logger?.debug({ bindingId: binding.id, maxChatId: chatIdStr }, 'binding already exists');
    }
    return { binding, created };
  }

  // M26: удаление приложения Б24 с CLEAN=1 (зовёт координатор, messagingService.
  // purgeBridgeData). Привязки установки удаляются, участники и журнал — каскадом (FK).
  // Повтор удалит 0. → { bindings } — число удалённых привязок.
  async purgeAll(installationId) {
    if (!installationId) throw new ValidationError('purgeAll: installationId required');
    const bindings = await this.bindings.deleteAllByInstallation(installationId);
    this.logger?.info({ installationId, bindings }, 'bindings purged (app uninstall)');
    return { bindings };
  }
}
