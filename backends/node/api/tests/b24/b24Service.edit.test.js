// Unit-тесты B24Service.updateConnectorMessage (INBOUND-правка MAX → Open Lines).
// Мокаем b24Client целиком — никаких сетевых вызовов. imconnectorUpdateMessages
// нет в базовом fakeClient (он про send), поэтому передаём его через overrides.

import { describe, expect, it, vi } from 'vitest';

import { B24Service } from '../../src/modules/b24/b24Service.js';
import { OpenLineEvent } from '../../src/modules/b24/models/OpenLineEvent.js';
import { ConnectorMessage } from '../../src/modules/b24/models/ConnectorMessage.js';
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

// Базовый fakeClient НЕ содержит imconnectorUpdateMessages (он про send/register),
// поэтому метод добавляем строго через overrides под каждый кейс.
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

// externalMessageId указывает на УЖЕ доставленное сообщение ('max:mid:<mid>'),
// text несёт обновлённый контент (маркер «Изменено» добавляет координатор).
function buildMessage(overrides = {}) {
  return new ConnectorMessage({
    connectorChatId: 'max:-70000000000954',
    externalMessageId: 'max:mid:mid.ABC',
    text: 'обновлённый текст (изменено)',
    date: 1700000000,
    author: { id: 54321, name: 'Иван', lastName: 'Петров' },
    ...overrides,
  });
}

describe('B24Service.updateConnectorMessage', () => {
  it('1) happy path: client вызван с client-shape, SUCCESS=true → {success:true, raw}', async () => {
    const client = fakeClient({
      imconnectorUpdateMessages: vi.fn(async () => ({
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

    const result = await service.updateConnectorMessage(buildMessage());

    expect(installations.getCurrent).toHaveBeenCalledOnce();
    expect(client.imconnectorUpdateMessages).toHaveBeenCalledWith({
      connectorId: 'max_b24',
      lineId: 42,
      messages: [
        {
          chat: { id: 'max:-70000000000954' },
          user: { id: 54321, name: 'Иван', lastName: 'Петров' },
          message: { id: 'max:mid:mid.ABC', text: 'обновлённый текст (изменено)', date: 1700000000 },
        },
      ],
      installation: expect.objectContaining({ connectorId: 'max_b24' }),
    });
    expect(result).toEqual({ success: true, raw: { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true }] } } });
  });

  // M23: update тоже переписывает имя пользователя коннектора → санитизируем.
  it('1b) имя с эмодзи вне BMP → user.name санитизирован', async () => {
    const client = fakeClient({
      imconnectorUpdateMessages: vi.fn(async () => ({ DATA: { RESULT: [{ SUCCESS: true }] } })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await service.updateConnectorMessage(buildMessage({ author: { id: 54321, name: '🚀 Аня 🌸' } }));
    const [{ messages }] = client.imconnectorUpdateMessages.mock.calls[0];
    expect(messages[0].user).toEqual({ id: 54321, name: 'Аня', lastName: '' });
  });

  it('2) DATA.RESULT[0].SUCCESS=false → B24ApiError CONNECTOR_UPDATE_FAILED', async () => {
    const client = fakeClient({
      imconnectorUpdateMessages: vi.fn(async () => ({
        DATA: { RESULT: [{ SUCCESS: false, ERRORS: [{ code: 'X' }] }] },
      })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.updateConnectorMessage(buildMessage())).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'CONNECTOR_UPDATE_FAILED',
    });
  });

  it('2b) RESULT[0] отсутствует (пустой DATA) → B24ApiError CONNECTOR_UPDATE_FAILED', async () => {
    const client = fakeClient({
      imconnectorUpdateMessages: vi.fn(async () => ({ DATA: { RESULT: [] } })),
    });
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger: silentLogger(),
    });

    await expect(service.updateConnectorMessage(buildMessage())).rejects.toMatchObject({
      name: 'B24ApiError',
      b24Code: 'CONNECTOR_UPDATE_FAILED',
    });
  });

  it('3) installation без connectorId/olLineId → ConfigError, client не вызван', async () => {
    const client = fakeClient({ imconnectorUpdateMessages: vi.fn() });
    const installations = fakeInstallations({ installation: { connectorId: null, olLineId: null } });
    const service = new B24Service({
      b24Client: client,
      installationsService: installations,
      logger: silentLogger(),
    });

    await expect(service.updateConnectorMessage(buildMessage())).rejects.toThrow(ConfigError);
    expect(client.imconnectorUpdateMessages).not.toHaveBeenCalled();
  });

  it('4) client.imconnectorUpdateMessages бросает (WRONG_AUTH_TYPE) → пробрасывает ту же ошибку без своего ERROR-лога', async () => {
    const thrown = new B24ApiError('WRONG_AUTH_TYPE', 'wrong auth type', {
      method: 'imconnector.update.messages',
    });
    const client = fakeClient({
      imconnectorUpdateMessages: vi.fn(async () => {
        throw thrown;
      }),
    });
    const logger = silentLogger();
    const service = new B24Service({
      b24Client: client,
      installationsService: fakeInstallations(),
      logger,
    });

    await expect(service.updateConnectorMessage(buildMessage())).rejects.toBe(thrown);
    // ERROR-лог пишет координатор (routeInboundEdit), не b24Service — без дубля.
    expect(service.logger.error).not.toHaveBeenCalled();
  });
});

describe('B24Service.handleOpenLineMessageEdit (M29)', () => {
  it('делегирует в messaging.routeOutboundQueued с kind edit и логгером', async () => {
    const messaging = { routeOutboundQueued: vi.fn(async () => ({ ok: true, results: [] })) };
    const service = new B24Service({
      b24Client: fakeClient(),
      installationsService: fakeInstallations(),
      messagingService: messaging,
      logger: silentLogger(),
    });
    const event = OpenLineEvent.fromWebhookBody({
      event: 'ONIMCONNECTORMESSAGEUPDATE',
      data: { CONNECTOR: 'max_b24', LINE: '42', MESSAGES: [] },
    });
    const logger = silentLogger();

    await expect(service.handleOpenLineMessageEdit(event, { logger })).resolves.toEqual({ ok: true, results: [] });
    expect(messaging.routeOutboundQueued).toHaveBeenCalledWith('edit', event, { logger });
  });
});
