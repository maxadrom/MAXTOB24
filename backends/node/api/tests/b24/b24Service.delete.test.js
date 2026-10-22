// Unit-тесты B24Service.deleteConnectorMessage (INBOUND-удаление MAX → Open Lines).
// Мокаем b24Client целиком — никаких сетевых вызовов. imconnectorDeleteMessages
// нет в базовом fakeClient (он про send), поэтому передаём его через overrides.
// message — минимальный shape { connectorChatId, externalMessageId, author:{id, name?} }.
// M23: user.name уходит всегда (санитизированный, fallback MAX user <id>).

import { describe, expect, it, vi } from 'vitest';

import { B24Service } from '../../src/modules/b24/b24Service.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { B24ApiError, ConfigError } from '../../src/shared/http/domainErrors.js';

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
    imconnectorSendMessages: vi.fn(async () => ({
      SUCCESS: true,
      DATA: { RESULT: [{ SUCCESS: true }] },
    })),
    ...overrides,
  };
}

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

function buildMessage(overrides = {}) {
  return {
    connectorChatId: 'max:-70000000000954',
    externalMessageId: 'max:mid:mid.ABC',
    author: { id: 54321, name: 'Иван Петров' },
    ...overrides,
  };
}

describe('B24Service.deleteConnectorMessage', () => {
  it('1) happy path: client вызван с тремя id и именем автора, SUCCESS=true → {success:true, raw}', async () => {
    const client = fakeClient({
      imconnectorDeleteMessages: vi.fn(async () => ({
        SUCCESS: true,
        DATA: { RESULT: [{ SUCCESS: true }] },
      })),
    });
    const installations = fakeInstallations();
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    const result = await service.deleteConnectorMessage(buildMessage());

    expect(installations.getCurrent).toHaveBeenCalledOnce();
    expect(client.imconnectorDeleteMessages).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      messages: [
        {
          user: { id: 54321, name: 'Иван Петров', lastName: '' },
          message: { id: 'max:mid:mid.ABC' },
          chat: { id: 'max:-70000000000954' },
        },
      ],
      installation: expect.objectContaining({ connectorId: 'max_b24' }),
    });
    expect(result).toEqual({ success: true, raw: { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true }] } } });
  });

  // M23: без имени Б24 делает автора «Гостем» → имя всегда непустое и санитизированное.
  it.each([
    ['имени нет (participant_map пуст)', null, 'MAX user 54321'],
    ['имя только из эмодзи', '🚀🌸', 'MAX user 54321'],
    ['эмодзи вне BMP в имени', 'Аня 🌸 Петрова', 'Аня Петрова'],
  ])('1b) %s → user.name = %j санитизирован', async (_label, rawName, expected) => {
    const client = fakeClient({
      imconnectorDeleteMessages: vi.fn(async () => ({ DATA: { RESULT: [{ SUCCESS: true }] } })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.deleteConnectorMessage(buildMessage({ author: { id: 54321, name: rawName } }));

    const [{ messages }] = client.imconnectorDeleteMessages.mock.calls[0];
    expect(messages[0].user).toEqual({ id: 54321, name: expected, lastName: '' });
  });

  it('2) DATA.RESULT[0].SUCCESS=false → B24ApiError CONNECTOR_DELETE_FAILED', async () => {
    const client = fakeClient({
      imconnectorDeleteMessages: vi.fn(async () => ({
        DATA: { RESULT: [{ SUCCESS: false, ERRORS: [{ code: 'X' }] }] },
      })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.deleteConnectorMessage(buildMessage())).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'CONNECTOR_DELETE_FAILED',
    });
  });

  it('2b) RESULT[0] отсутствует (пустой DATA) → B24ApiError CONNECTOR_DELETE_FAILED', async () => {
    const client = fakeClient({
      imconnectorDeleteMessages: vi.fn(async () => ({ DATA: { RESULT: [] } })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.deleteConnectorMessage(buildMessage())).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'CONNECTOR_DELETE_FAILED',
    });
  });

  it('3) installation без connectorId/olLineId → ConfigError, client не вызван', async () => {
    const client = fakeClient({ imconnectorDeleteMessages: vi.fn() });
    const installations = fakeInstallations({ installation: { connectorId: null, olLineId: null } });
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    await expect(service.deleteConnectorMessage(buildMessage())).rejects.toThrow(ConfigError);
    expect(client.imconnectorDeleteMessages).not.toHaveBeenCalled();
  });

  it('4) client.imconnectorDeleteMessages бросает (WRONG_AUTH_TYPE) → пробрасывает без своего ERROR-лога', async () => {
    const thrown = new B24ApiError('WRONG_AUTH_TYPE', 'wrong auth type', {
      method: 'imconnector.delete.messages',
    });
    const client = fakeClient({
      imconnectorDeleteMessages: vi.fn(async () => {
        throw thrown;
      }),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.deleteConnectorMessage(buildMessage())).rejects.toBe(thrown);
    // ERROR-лог пишет координатор (routeInboundDelete), не b24Service — без дубля.
    expect(service.logger.error).not.toHaveBeenCalled();
  });
});

describe('B24Service.handleOpenLineMessageDelete (M29)', () => {
  it('делегирует в messaging.routeOutboundQueued с kind delete и логгером', async () => {
    const messaging = { routeOutboundQueued: vi.fn(async () => ({ ok: true, results: [] })) };
    const service = new B24Service({
      b24Client: fakeClient(),
      installationsService: fakeInstallations(),
      messagingService: messaging,
      logger: silentLogger(),
    });
    const event = OpenLineEvent.fromWebhookBody({
      event: 'ONIMCONNECTORMESSAGEDELETE',
      data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: [] },
    });
    const logger = silentLogger();

    await expect(service.handleOpenLineMessageDelete(event, { logger })).resolves.toEqual({ ok: true, results: [] });
    expect(messaging.routeOutboundQueued).toHaveBeenCalledWith('delete', event, { logger });
  });
});
