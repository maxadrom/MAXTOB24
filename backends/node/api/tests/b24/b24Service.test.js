// Unit-тесты B24Service. Мокаем b24Client целиком — никаких сетевых вызовов.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { B24Service, parseLinesSessionId } from '../../src/modules/b24/b24Service.js';
import { B24_CONNECTOR_DEFAULTS } from '../../src/modules/b24/b24Constants.js';
import { ConnectorMessage } from '../../src/modules/b24/models/ConnectorMessage.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { B24ApiError, ConfigError, ValidationError } from '../../src/shared/http/domainErrors.js';

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child() {
      return silentLogger();
    },
  };
}

function fakeClient(overrides = {}) {
  return {
    imconnectorList: vi.fn(async () => ({})),
    imconnectorRegister: vi.fn(async () => ({ result: true })),
    imconnectorActivate: vi.fn(async () => ({ result: true })),
    imconnectorDeactivate: vi.fn(async () => ({ result: true })),
    imconnectorUnregister: vi.fn(async () => ({ result: true })),
    imconnectorSendMessages: vi.fn(async () => ({
      SUCCESS: true,
      DATA: { RESULT: [{ SUCCESS: true, session: { ID: '15756', CHAT_ID: '21180' } }] },
    })),
    ...overrides,
  };
}

// Мок installationsService.getCurrent — connectorId/olLineId по умолчанию проставлены.
function fakeInstallations(overrides = {}) {
  return {
    getCurrent: vi.fn(async () => ({
      id: 1,
      b24Portal: 'example.bitrix24.ru',
      connectorId: 'max_b24',
      olLineId: 42,
      ...overrides.installation,
    })),
    ...overrides,
  };
}

const PAYLOAD = {
  connectorId: 'max_b24',
  lineId: 42,
  name: 'MAX (group chats)',
  icon: B24_CONNECTOR_DEFAULTS.ICON,
  placementHandlerUrl: 'https://example.test/b24/connector-settings',
};

describe('B24Service.registerConnector', () => {
  let client;
  let service;

  beforeEach(() => {
    client = fakeClient();
    service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });
  });

  it('1) happy path: list empty → register + activate, wasAlreadyRegistered=false', async () => {
    const result = await service.registerConnector(PAYLOAD);

    expect(client.imconnectorList).toHaveBeenCalledTimes(1);
    expect(client.imconnectorRegister).toHaveBeenCalledTimes(1);
    expect(client.imconnectorRegister).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      name: 'MAX (group chats)',
      icon: B24_CONNECTOR_DEFAULTS.ICON,
      placementHandlerUrl: 'https://example.test/b24/connector-settings',
      chatGroup: true,
      needSignature: true,
    });
    expect(client.imconnectorActivate).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      active: true,
    });
    expect(result).toEqual({
      connectorId: 'max_b24',
      lineId: 42,
      activated: true,
      wasAlreadyRegistered: false,
    });
  });

  it('2) уже зарегистрирован: list содержит connectorId → register пропускается, activate вызывается', async () => {
    client.imconnectorList = vi.fn(async () => ({
      livechat: 'Онлайн-чат',
      max_b24: 'MAX (group chats)',
    }));

    const result = await service.registerConnector(PAYLOAD);

    expect(client.imconnectorRegister).not.toHaveBeenCalled();
    expect(client.imconnectorActivate).toHaveBeenCalledTimes(1);
    expect(result.wasAlreadyRegistered).toBe(true);
  });

  it('3) list вернул не-объект (null) → трактуем как «никаких коннекторов нет», register вызывается', async () => {
    client.imconnectorList = vi.fn(async () => null);

    const result = await service.registerConnector(PAYLOAD);

    expect(client.imconnectorRegister).toHaveBeenCalledTimes(1);
    expect(result.wasAlreadyRegistered).toBe(false);
  });

  it('4) activate упал → исключение пробрасывается, никаких installations-операций', async () => {
    client.imconnectorActivate = vi.fn(async () => {
      throw new B24ApiError('ERROR_ARGUMENT', "Argument 'LINE' is null", {
        method: 'imconnector.activate',
        status: 400,
      });
    });

    await expect(service.registerConnector(PAYLOAD)).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'ERROR_ARGUMENT',
    });
  });

  // ── M10 ────────────────────────────────────────────────────────────────────
  it('M10-a) новый коннектор → iconDisabled прокинут в imconnector.register', async () => {
    const result = await service.registerConnector({
      ...PAYLOAD,
      iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED,
    });

    expect(client.imconnectorRegister).toHaveBeenCalledTimes(1);
    expect(client.imconnectorRegister).toHaveBeenCalledWith(
      expect.objectContaining({ iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED }),
    );
    expect(result.wasAlreadyRegistered).toBe(false);
  });

  it('M10-b) уже зарегистрирован + forceReregister=false → register ПРОПУЩЕН (прежнее поведение)', async () => {
    client.imconnectorList = vi.fn(async () => ({ max_b24: 'Старое имя' }));

    const result = await service.registerConnector({ ...PAYLOAD, forceReregister: false });

    expect(client.imconnectorRegister).not.toHaveBeenCalled();
    expect(client.imconnectorActivate).toHaveBeenCalledTimes(1);
    expect(result.wasAlreadyRegistered).toBe(true);
  });

  it('M10-c) уже зарегистрирован + forceReregister=true → register ВЫЗВАН с name/icon/iconDisabled (update)', async () => {
    client.imconnectorList = vi.fn(async () => ({ max_b24: 'Старое имя' }));

    const result = await service.registerConnector({
      ...PAYLOAD,
      iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED,
      forceReregister: true,
    });

    expect(client.imconnectorRegister).toHaveBeenCalledTimes(1);
    expect(client.imconnectorRegister).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      name: 'MAX (group chats)',
      icon: B24_CONNECTOR_DEFAULTS.ICON,
      iconDisabled: B24_CONNECTOR_DEFAULTS.ICON_DISABLED,
      placementHandlerUrl: 'https://example.test/b24/connector-settings',
      chatGroup: true,
      needSignature: true,
    });
    expect(client.imconnectorActivate).toHaveBeenCalledTimes(1);
    expect(result.wasAlreadyRegistered).toBe(true);
  });
});

describe('B24Service.unregisterConnector', () => {
  let client;
  let service;

  beforeEach(() => {
    client = fakeClient();
    service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });
  });

  it('5) happy path: deactivate + unregister', async () => {
    const result = await service.unregisterConnector({ connectorId: 'max_b24', lineId: 42 });

    expect(client.imconnectorDeactivate).toHaveBeenCalledWith({ connectorId: 'max_b24', lineId: 42 });
    expect(client.imconnectorUnregister).toHaveBeenCalledWith({ connectorId: 'max_b24' });
    expect(result).toEqual({ connectorId: 'max_b24', unregistered: true });
  });

  it('6) deactivate упал (B24ApiError) → warn, продолжаем к unregister, не падаем', async () => {
    client.imconnectorDeactivate = vi.fn(async () => {
      throw new B24ApiError('CONNECTOR_NOT_FOUND', 'unknown connector', {
        method: 'imconnector.activate',
      });
    });

    await expect(service.unregisterConnector({ connectorId: 'max_b24', lineId: 42 })).resolves.toEqual({
      connectorId: 'max_b24',
      unregistered: true,
    });
    expect(client.imconnectorUnregister).toHaveBeenCalled();
  });

  it('7) unregister упал → warn, метод не бросает наружу', async () => {
    client.imconnectorUnregister = vi.fn(async () => {
      throw new B24ApiError('CONNECTOR_NOT_FOUND', 'unknown connector', {
        method: 'imconnector.unregister',
      });
    });

    await expect(service.unregisterConnector({ connectorId: 'max_b24', lineId: 42 })).resolves.toEqual({
      connectorId: 'max_b24',
      unregistered: true,
    });
  });
});

describe('B24Service constructor', () => {
  it('8) без installationsService → TypeError', () => {
    expect(() => new B24Service({ b24Client: fakeClient(), logger: silentLogger() })).toThrow(
      /installationsService required/,
    );
  });

  it('9) без b24Client → TypeError', () => {
    expect(() => new B24Service({ installationsService: fakeInstallations() })).toThrow(
      /b24Client required/,
    );
  });
});

describe('B24Service.sendConnectorMessage', () => {
  function buildMessage(overrides = {}) {
    return new ConnectorMessage({
      connectorChatId: 'max:-70000000000954',
      externalMessageId: 'max:mid:mid.ABC123',
      text: 'привет',
      date: 1700000000,
      author: { id: 54321, name: 'Иван', lastName: 'Петров' },
      ...overrides,
    });
  }

  it('10) happy path: client вызван с client-shape, return {b24MsgId, sessionId, b24ChatId, raw}', async () => {
    const client = fakeClient();
    const installations = fakeInstallations();
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    const result = await service.sendConnectorMessage(buildMessage());

    expect(installations.getCurrent).toHaveBeenCalledOnce();
    expect(client.imconnectorSendMessages).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      messages: [
        {
          chat: { id: 'max:-70000000000954' },
          user: { id: 54321, name: 'Иван', lastName: 'Петров' },
          message: { id: 'max:mid:mid.ABC123', text: 'привет', date: 1700000000 },
        },
      ],
      // M21: прочитанная installation уходит в клиент — callMethod не читает её снова.
      installation: expect.objectContaining({ connectorId: 'max_b24', olLineId: 42 }),
    });
    expect(result.b24MsgId).toBe('max:mid:mid.ABC123');
    expect(result.sessionId).toBe('15756');
    expect(result.b24ChatId).toBe('21180');
    expect(result.raw).toBeDefined();
  });

  it.each([
    ['sendConnectorMessage', 'imconnectorSendMessages'],
    ['updateConnectorMessage', 'imconnectorUpdateMessages'],
    ['deleteConnectorMessage', 'imconnectorDeleteMessages'],
  ])('10b) M21: %s с installation от координатора → getCurrent не вызван, та же installation в клиенте', async (method, clientMethod) => {
    const ok = { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true, session: { ID: '1', CHAT_ID: '2' } }] } };
    const client = fakeClient({ [clientMethod]: vi.fn(async () => ok) });
    const installations = fakeInstallations();
    const service = new B24Service({ b24Client: client, installationsService: installations, logger: silentLogger() });
    const installation = { id: 1, connectorId: 'max_b24', olLineId: 42 };

    await service[method](buildMessage(), { installation });

    expect(installations.getCurrent).not.toHaveBeenCalled();
    expect(client[clientMethod].mock.calls[0][0].installation).toBe(installation);
  });

  it('11) SUCCESS=false в RESULT[0] → B24ApiError CONNECTOR_SEND_FAILED', async () => {
    const client = fakeClient({
      imconnectorSendMessages: vi.fn(async () => ({
        DATA: { RESULT: [{ SUCCESS: false, ERRORS: [{ code: 'X' }] }] },
      })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.sendConnectorMessage(buildMessage())).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'CONNECTOR_SEND_FAILED',
    });
  });

  it('12) installation без connectorId/olLineId → ConfigError, client не вызван', async () => {
    const client = fakeClient();
    const installations = fakeInstallations({ installation: { connectorId: null, olLineId: null } });
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    await expect(service.sendConnectorMessage(buildMessage())).rejects.toThrow(ConfigError);
    expect(client.imconnectorSendMessages).not.toHaveBeenCalled();
  });

  it('13) picture опционален: не попадает в shape, если author.picture отсутствует', async () => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(buildMessage());
    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.user).not.toHaveProperty('picture');
  });

  // M23: Б24 обрывает имя на символе вне BMP → user.name санитизирован, пустое → fallback.
  it.each([
    ['Аня 🌸 Петрова', 'Аня Петрова'],
    ['🚀', 'MAX user 54321'],
  ])('M23) author.name %j → user.name %j', async (rawName, expected) => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(buildMessage({ author: { id: 54321, name: rawName } }));
    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.user).toEqual({ id: 54321, name: expected, lastName: '' });
  });

  // ── M11.2: files (inbound media) ────────────────────────────────────────────
  it('M11.2-a) files передаются в shape.message.files (url+name)', async () => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(
      buildMessage({
        text: '',
        files: [
          { url: 'https://i.oneme.ru/a', name: '1.webp' },
          { url: 'https://fd.oneme.ru/b', name: 'd.pdf' },
        ],
      }),
    );

    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.message.files).toEqual([
      { url: 'https://i.oneme.ru/a', name: '1.webp' },
      { url: 'https://fd.oneme.ru/b', name: 'd.pdf' },
    ]);
  });

  it('M11.2-b) обратная совместимость: текст-только → message.files не выставлен', async () => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(buildMessage());

    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.message).not.toHaveProperty('files');
  });

  // ── M24 ────────────────────────────────────────────────────────────────────
  it('M24) shape без chat.name (imopenlines его не читает — название ставит setChatName)', async () => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(buildMessage());
    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.chat).toEqual({ id: 'max:-70000000000954' });
  });

  it('M24) псевдо-пользователь «группа»: имя из одних эмодзи → fallbackName, picture как есть', async () => {
    const client = fakeClient();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.sendConnectorMessage(buildMessage({
      author: { id: 'group:-1', name: '🚀🚀', fallbackName: 'Группа MAX', picture: 'https://i.oneme.ru/i?r=X' },
    }));
    const sentShape = client.imconnectorSendMessages.mock.calls[0][0].messages[0];
    expect(sentShape.user).toEqual({
      id: 'group:-1',
      name: 'Группа MAX',
      lastName: '',
      picture: 'https://i.oneme.ru/i?r=X',
    });
  });
});

describe('B24Service.setChatName (M24)', () => {
  function serviceWith(imconnectorChatNameSet) {
    const client = fakeClient({ imconnectorChatNameSet });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });
    return { client, service };
  }

  it('1) client вызван с connectorId/lineId из installations и внешним chat id; SUCCESS → {success:true}', async () => {
    const { client, service } = serviceWith(vi.fn(async () => ({ SUCCESS: true, DATA: { RESULT: {} } })));

    await expect(
      service.setChatName({ connectorChatId: 'max:-70000000000954', name: 'Отдел продаж 🚀' }),
    ).resolves.toEqual({ success: true });
    expect(client.imconnectorChatNameSet).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      chatId: 'max:-70000000000954',
      name: 'Отдел продаж 🚀',
      installation: expect.objectContaining({ connectorId: 'max_b24', olLineId: 42 }),
    });
  });

  it('2) SUCCESS=false → B24ApiError CHAT_RENAME_FAILED', async () => {
    const { service } = serviceWith(vi.fn(async () => ({ SUCCESS: false })));
    await expect(
      service.setChatName({ connectorChatId: 'max:-1', name: 'X' }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'CHAT_RENAME_FAILED' });
  });

  it('3) CHAT_RENAMING_FAILED (сессия закрыта) пробрасывается как есть — решение за координатором', async () => {
    const { service } = serviceWith(vi.fn(async () => {
      throw new B24ApiError('CHAT_RENAMING_FAILED', 'chat renaming failed', {
        method: 'imconnector.chat.name.set',
        httpStatus: 400,
      });
    }));
    await expect(
      service.setChatName({ connectorChatId: 'max:-1', name: 'X' }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'CHAT_RENAMING_FAILED' });
  });
});

describe('B24Service.handleOpenLineDialogFinish (M25)', () => {
  function build(connectorId) {
    const messaging = { routeDialogFinish: vi.fn(async () => ({ ok: true, results: [] })) };
    const service = new B24Service({
      b24Client: fakeClient(),
      installationsService: fakeInstallations(),
      messagingService: messaging,
      logger: silentLogger(),
    });
    const event = OpenLineEvent.fromWebhookBody({
      event: 'ONIMCONNECTORDIALOGFINISH',
      data: { CONNECTOR: connectorId, LINE: '42', DATA: [] },
    });
    return { service, messaging, event };
  }

  it('наш коннектор → делегирует в messaging.routeDialogFinish с логгером', async () => {
    const { service, messaging, event } = build('max_b24');
    const logger = silentLogger();

    await expect(service.handleOpenLineDialogFinish(event, { logger })).resolves.toEqual({ ok: true, results: [] });
    expect(messaging.routeDialogFinish).toHaveBeenCalledWith(event, { logger });
  });

  it('чужой коннектор портала → foreign-connector, координатор не вызван', async () => {
    const { service, messaging, event } = build('telegrambot');

    await expect(service.handleOpenLineDialogFinish(event)).resolves.toEqual({ skipped: 'foreign-connector' });
    expect(messaging.routeDialogFinish).not.toHaveBeenCalled();
  });
});

describe('B24Service.handleOpenLineMessageAdd (M29)', () => {
  it('делегирует в messaging.routeOutboundQueued с kind add и логгером', async () => {
    const messaging = { routeOutboundQueued: vi.fn(async () => ({ ok: true, results: [] })) };
    const service = new B24Service({
      b24Client: fakeClient(),
      installationsService: fakeInstallations(),
      messagingService: messaging,
      logger: silentLogger(),
    });
    const event = OpenLineEvent.fromWebhookBody({
      event: 'ONIMCONNECTORMESSAGEADD',
      data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: [] },
    });
    const logger = silentLogger();

    await expect(service.handleOpenLineMessageAdd(event, { logger })).resolves.toEqual({ ok: true, results: [] });
    expect(messaging.routeOutboundQueued).toHaveBeenCalledWith('add', event, { logger });
  });

  it('ошибка координатора (500) пробрасывается как есть', async () => {
    const err = new Error('db down');
    const messaging = { routeOutboundQueued: vi.fn(async () => { throw err; }) };
    const service = new B24Service({
      b24Client: fakeClient(),
      installationsService: fakeInstallations(),
      messagingService: messaging,
      logger: silentLogger(),
    });
    const event = OpenLineEvent.fromWebhookBody({ event: 'ONIMCONNECTORMESSAGEADD', data: {} });

    await expect(service.handleOpenLineMessageAdd(event)).rejects.toBe(err);
  });
});

describe('B24Service.sendDeliveryStatus (M5.3)', () => {
  function fakeClientWithDelivery(overrides = {}) {
    return {
      ...fakeClient(),
      imconnectorSendStatusDelivery: vi.fn(async () => ({ SUCCESS: true, DATA: [], time: {} })),
      ...overrides,
    };
  }

  it('14) happy path: обогащает CONNECTOR/LINE из installation, вызывает client, SUCCESS:true → ok', async () => {
    const client = fakeClientWithDelivery();
    const installations = fakeInstallations();
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    const result = await service.sendDeliveryStatus({
      b24ChatId: '21186',
      b24MsgId: '1459190',
      externalIds: ['mid.ext-007'],
      date: 1748432100,
      connectorChatId: 'max:-70000000000954',
    });

    expect(installations.getCurrent).toHaveBeenCalledOnce();
    expect(client.imconnectorSendStatusDelivery).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      statuses: [
        {
          imChatId: '21186',
          imMessageId: '1459190',
          externalIds: ['mid.ext-007'],
          date: 1748432100,
          chatId: 'max:-70000000000954',
        },
      ],
      installation: expect.objectContaining({ connectorId: 'max_b24' }),
    });
    expect(result.SUCCESS).toBe(true);
  });

  it('15) SUCCESS:false → B24ApiError DELIVERY_STATUS_FAILED', async () => {
    const client = fakeClientWithDelivery({
      imconnectorSendStatusDelivery: vi.fn(async () => ({ SUCCESS: false, DATA: [], time: {} })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(
      service.sendDeliveryStatus({
        b24ChatId: '21186',
        b24MsgId: '1459190',
        externalIds: ['mid.x'],
        date: 1748432100,
        connectorChatId: 'max:-1',
      }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'DELIVERY_STATUS_FAILED' });
  });

  it('16) installation без connectorId/olLineId → ConfigError, client не вызван', async () => {
    const client = fakeClientWithDelivery();
    const installations = fakeInstallations({ installation: { connectorId: null, olLineId: null } });
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    await expect(
      service.sendDeliveryStatus({
        b24ChatId: '21186',
        b24MsgId: '1459190',
        externalIds: ['mid.x'],
        date: 1748432100,
        connectorChatId: 'max:-1',
      }),
    ).rejects.toThrow(ConfigError);
    expect(client.imconnectorSendStatusDelivery).not.toHaveBeenCalled();
  });

  it('17) M28: installation от координатора → getCurrent не вызван, та же installation в клиенте', async () => {
    const client = fakeClientWithDelivery();
    const installations = fakeInstallations();
    const service = new B24Service({ b24Client: client, installationsService: installations, logger: silentLogger() });
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };

    await service.sendDeliveryStatus({
      b24ChatId: '21186',
      b24MsgId: '1459190',
      externalIds: ['mid.x'],
      date: 1748432100,
      connectorChatId: 'max:-1',
      installation,
    });

    expect(installations.getCurrent).not.toHaveBeenCalled();
    const arg = client.imconnectorSendStatusDelivery.mock.calls[0][0];
    expect(arg.installation).toBe(installation);
    expect(arg).toMatchObject({ connectorId: 'max_b24', lineId: 42 });
  });
});

// M-lifecycle: системное уведомление в OL-чат.
describe('B24Service.sendSystemMessage', () => {
  it('1) формирует dialogId="chat"+b24ChatId, зовёт imMessageAdd system, возвращает {b24MsgId,dialogId}', async () => {
    const client = fakeClient({ imMessageAdd: vi.fn(async () => 9876) });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    const result = await service.sendSystemMessage({ b24ChatId: '21180', text: '👋 Привет [b]Иван[/b]' });

    expect(client.imMessageAdd).toHaveBeenCalledWith({
      dialogId: 'chat21180',
      message: '👋 Привет [b]Иван[/b]',
      system: true,
    });
    expect(result).toEqual({ b24MsgId: 9876, dialogId: 'chat21180' });
  });

  it('2) ошибка imMessageAdd (B24ApiError) пробрасывается без повторного оборачивания', async () => {
    const client = fakeClient({
      imMessageAdd: vi.fn(async () => {
        throw new B24ApiError('ACCESS_ERROR', 'no access', { method: 'im.message.add' });
      }),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(
      service.sendSystemMessage({ b24ChatId: '21180', text: 'x' }),
    ).rejects.toMatchObject({ name: 'B24ApiError', b24Code: 'ACCESS_ERROR' });
  });

  it('3) пустой b24ChatId/text → ValidationError, imMessageAdd не вызван', async () => {
    const client = fakeClient({ imMessageAdd: vi.fn() });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.sendSystemMessage({ b24ChatId: '', text: 'x' })).rejects.toThrow(ValidationError);
    await expect(service.sendSystemMessage({ b24ChatId: '21180', text: '' })).rejects.toThrow(ValidationError);
    expect(client.imMessageAdd).not.toHaveBeenCalled();
  });

  // M28: оповещение исходящего пути передаёт снимок installation из резолва привязки.
  it('4) installation → передаётся в imMessageAdd, installations.getCurrent не зовётся', async () => {
    const client = fakeClient({ imMessageAdd: vi.fn(async () => 555) });
    const installations = fakeInstallations();
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });
    const installation = { id: 1, b24Portal: 'example.bitrix24.ru', b24AccessToken: 'tok' };

    const result = await service.sendSystemMessage({ b24ChatId: '21564', text: '⚠️ x' }, { installation });

    expect(client.imMessageAdd).toHaveBeenCalledWith({
      dialogId: 'chat21564',
      message: '⚠️ x',
      system: true,
      installation,
    });
    expect(installations.getCurrent).not.toHaveBeenCalled();
    expect(result).toEqual({ b24MsgId: 555, dialogId: 'chat21564' });
  });
});

describe('B24Service.resolveB24ChatId (M-lifecycle)', () => {
  it('1) строит USER_CODE из installations + connectorChatId, возвращает строковый CHAT_ID', async () => {
    const client = fakeClient({ imDialogGet: vi.fn(async () => ({ id: 21564, dialog_id: 'chat21564' })) });
    const installations = fakeInstallations();
    const service = new B24Service({ b24Client: client, installationsService: installations, logger: silentLogger() });

    const chatId = await service.resolveB24ChatId({ connectorChatId: 'max:-70000000000218' });

    expect(client.imDialogGet).toHaveBeenCalledWith({
      userCode: 'max_b24|42|max:-70000000000218|0',
    });
    expect(chatId).toBe('21564'); // строка, не число
  });

  it('2) нет OL-чата (imDialogGet бросает ACCESS_ERROR) → null, без throw', async () => {
    const client = fakeClient({
      imDialogGet: vi.fn(async () => {
        throw new B24ApiError('ACCESS_ERROR', 'no access', { method: 'imopenlines.dialog.get' });
      }),
    });
    const service = new B24Service({ b24Client: client, installationsService: fakeInstallations(), logger: silentLogger() });

    await expect(service.resolveB24ChatId({ connectorChatId: 'max:-1' })).resolves.toBeNull();
  });

  it('3) пустой connectorChatId → null, imDialogGet не вызван', async () => {
    const client = fakeClient({ imDialogGet: vi.fn() });
    const service = new B24Service({ b24Client: client, installationsService: fakeInstallations(), logger: silentLogger() });

    await expect(service.resolveB24ChatId({ connectorChatId: '' })).resolves.toBeNull();
    await expect(service.resolveB24ChatId({})).resolves.toBeNull();
    expect(client.imDialogGet).not.toHaveBeenCalled();
  });

  it('4) chat без id (пустой result) → null', async () => {
    const client = fakeClient({ imDialogGet: vi.fn(async () => ({})) });
    const service = new B24Service({ b24Client: client, installationsService: fakeInstallations(), logger: silentLogger() });

    await expect(service.resolveB24ChatId({ connectorChatId: 'max:-1' })).resolves.toBeNull();
  });

  it('5) installation без connectorId/olLineId → ConfigError, imDialogGet не вызван (не USER_CODE «null|null|…»)', async () => {
    const client = fakeClient({ imDialogGet: vi.fn() });
    const installations = fakeInstallations({ installation: { connectorId: null, olLineId: null } });
    const service = new B24Service({ b24Client: client, installationsService: installations, logger: silentLogger() });

    await expect(service.resolveB24ChatId({ connectorChatId: 'max:-1' })).rejects.toThrow(ConfigError);
    expect(client.imDialogGet).not.toHaveBeenCalled();
  });
});

// ── M27: состояние чата OL по CHAT_ID (имя + сессия из entity_data_1) ─────────
describe('parseLinesSessionId (M27)', () => {
  it.each([
    ['N|NONE|0|N|N|16338|1791370000|0|0|0', 16338], // live-формат, открытая сессия
    ['N|NONE|0|N|N|0|1791370000|0|0|0', 0], // закрытая
    ['Y|LEAD|1209|N|N|343|1773682918|0|0|0', 343], // пример из доки
    ['N|NONE|0|N|N|0', 0],
  ])('%j → %j', (input, expected) => {
    expect(parseLinesSessionId(input)).toBe(expected);
  });

  it.each([
    [''],
    [null],
    [undefined],
    [42],
    ['a|b'],
    ['N|NONE|0|N|N||1791370000'],
    ['N|NONE|0|N|N|-5|1791370000'],
    ['N|NONE|0|N|N|1.5|1791370000'],
    ['N|NONE|0|N|N|abc|1791370000'],
    ['N|NONE|0|N|N|99999999999999999999|0'],
  ])('%j → null (не разобрать)', (input) => {
    expect(parseLinesSessionId(input)).toBeNull();
  });
});

describe('B24Service.getOlChat (M27)', () => {
  function build(imDialogGet) {
    const client = fakeClient({ imDialogGet });
    const service = new B24Service({ b24Client: client, installationsService: fakeInstallations(), logger: silentLogger() });
    // Сервис пишет в child-логгер.
    return { client, service, logger: service.logger };
  }

  it('1) dialog.get по CHAT_ID → { b24ChatId, name, sessionId }; имя в лог не попадает', async () => {
    const name = 'Группа Альфа и Бета';
    const { client, service, logger } = build(vi.fn(async () => ({
      id: 21564,
      name,
      entity_data_1: 'N|NONE|0|N|N|16338|1791370000|0|0|0',
    })));

    await expect(service.getOlChat({ b24ChatId: '21564' }))
      .resolves.toEqual({ b24ChatId: '21564', name, sessionId: 16338 });
    expect(client.imDialogGet).toHaveBeenCalledWith({ chatId: '21564' });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.debug.mock.calls]);
    expect(logged).not.toContain(name);
    expect(logged).toContain('"nameLen":19');
  });

  it('2) закрытая сессия → sessionId 0; нет entity_data_1 и имени → null-поля', async () => {
    const { service } = build(vi.fn()
      .mockResolvedValueOnce({ id: 23880, name: 'X', entity_data_1: 'N|NONE|0|N|N|0|0|42|0|0' })
      .mockResolvedValueOnce({ id: 23880 }));

    await expect(service.getOlChat({ b24ChatId: 23880 })).resolves.toEqual({ b24ChatId: '23880', name: 'X', sessionId: 0 });
    await expect(service.getOlChat({ b24ChatId: 23880 })).resolves.toEqual({ b24ChatId: '23880', name: null, sessionId: null });
  });

  it('3) ACCESS_ERROR / таймаут → null + warn, без throw', async () => {
    const { service, logger } = build(vi.fn(async () => {
      throw new B24ApiError('ACCESS_ERROR', 'no access', { method: 'imopenlines.dialog.get' });
    }));

    await expect(service.getOlChat({ b24ChatId: '21564' })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('4) b24ChatId пуст → null, dialog.get не вызван', async () => {
    const { client, service } = build(vi.fn());

    await expect(service.getOlChat({ b24ChatId: null })).resolves.toBeNull();
    await expect(service.getOlChat({ b24ChatId: '' })).resolves.toBeNull();
    await expect(service.getOlChat({})).resolves.toBeNull();
    await expect(service.getOlChat()).resolves.toBeNull();
    expect(client.imDialogGet).not.toHaveBeenCalled();
  });
});

// ── Reply/цитирование: resolveReplyContext (добор REPLY_ID + CONNECTOR_MID) ────
describe('B24Service.resolveReplyContext', () => {
  function buildService(searchImpl) {
    const client = fakeClient({ imDialogMessagesSearch: searchImpl });
    return {
      client,
      service: new B24Service({
        b24Client: client,
        installationsService: fakeInstallations(),
        logger: silentLogger(),
      }),
    };
  }

  it('a) reply на клиента: CONNECTOR_MID max:mid:* в additionalMessages', async () => {
    const search = vi.fn(async () => ({
      messages: [{ id: 1002, params: { REPLY_ID: 900 } }],
      additionalMessages: [{ id: 900, params: { CONNECTOR_MID: ['max:mid:abc123'] } }],
    }));
    const { service, client } = buildService(search);

    const rc = await service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: '1002', limit: 50 });

    expect(client.imDialogMessagesSearch).toHaveBeenCalledWith({ chatId: '21564', limit: 50 });
    expect(rc).toEqual({ replyId: 900, parentConnectorMid: 'max:mid:abc123', forward: false });
  });

  it('b) reply на оператора: CONNECTOR_MID = <maxMid> (без префикса)', async () => {
    const search = vi.fn(async () => ({
      messages: [
        { id: 1003, params: { REPLY_ID: 901 } },
        { id: 901, params: { CONNECTOR_MID: ['77.123'] } },
      ],
      additionalMessages: [],
    }));
    const { service } = buildService(search);

    const rc = await service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: 1003 });
    expect(rc).toEqual({ replyId: 901, parentConnectorMid: '77.123', forward: false });
  });

  it('c) не-reply (нет REPLY_ID) → null', async () => {
    const search = vi.fn(async () => ({ messages: [{ id: 1004, params: {} }], additionalMessages: [] }));
    const { service } = buildService(search);

    await expect(
      service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: 1004 }),
    ).resolves.toBeNull();
  });

  it('d) Y вне окна search → null', async () => {
    const search = vi.fn(async () => ({ messages: [{ id: 1, params: { REPLY_ID: 2 } }], additionalMessages: [] }));
    const { service } = buildService(search);

    await expect(
      service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: 99999 }),
    ).resolves.toBeNull();
  });

  it('e) родитель отсутствует в payload (только replyId) → parentConnectorMid=null', async () => {
    const search = vi.fn(async () => ({
      messages: [{ id: 1005, params: { REPLY_ID: 902 } }],
      additionalMessages: [],
    }));
    const { service } = buildService(search);

    const rc = await service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: 1005 });
    expect(rc).toEqual({ replyId: 902, parentConnectorMid: null, forward: false });
  });

  it('f) search бросает → null (best-effort, не пробрасывает)', async () => {
    const search = vi.fn(async () => {
      throw new B24ApiError('QUERY_LIMIT_EXCEEDED', 'too many', { method: 'im.dialog.messages.search' });
    });
    const { service } = buildService(search);

    await expect(
      service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: 1006 }),
    ).resolves.toBeNull();
  });

  it('a2) M28: installation от координатора → уходит в imDialogMessagesSearch, getCurrent не вызван', async () => {
    const search = vi.fn(async () => ({ messages: [], additionalMessages: [] }));
    const client = fakeClient({ imDialogMessagesSearch: search });
    const installations = fakeInstallations();
    const service = new B24Service({ b24Client: client, installationsService: installations, logger: silentLogger() });
    const installation = { id: 7, connectorId: 'max_b24', olLineId: 42 };

    await service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: '1002', limit: 50, installation });

    expect(search).toHaveBeenCalledWith({ chatId: '21564', limit: 50, installation });
    expect(search.mock.calls[0][0].installation).toBe(installation);
    expect(installations.getCurrent).not.toHaveBeenCalled();
  });

  it('g) пустые b24ChatId/b24MsgId → null, search не зван', async () => {
    const search = vi.fn();
    const { service, client } = buildService(search);

    await expect(service.resolveReplyContext({ b24ChatId: '', b24MsgId: 1 })).resolves.toBeNull();
    await expect(service.resolveReplyContext({ b24ChatId: '21564', b24MsgId: null })).resolves.toBeNull();
    expect(client.imDialogMessagesSearch).not.toHaveBeenCalled();
  });
});
