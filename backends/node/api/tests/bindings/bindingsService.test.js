// Unit-тесты BindingsService.ensureForMaxChat (M7: авто-онбординг, M21: атомарный upsert,
// M26: не после удаления приложения), findParticipantName (M23: имя автора для delete),
// purgeAll (M26: очистка при удалении приложения) и фасадов сессии OL (M25, M27).
import { describe, expect, it, vi } from 'vitest';

import { BindingsService } from '../../src/modules/bindings/bindingsService.js';
import { ChatBinding } from '../../src/modules/bindings/models/ChatBinding.js';
import { Installation } from '../../src/modules/installations/models/Installation.js';
import { ConfigError } from '../../src/shared/http/domainErrors.js';

function makeExistingBinding(overrides = {}) {
  return new ChatBinding({
    id: 99,
    installationId: 1,
    maxChatId: '-70000000000954',
    connectorChatId: 'max:-70000000000954',
    ...overrides,
  });
}

function fakeInstallations() {
  return { getCurrent: vi.fn(async () => ({ id: 1 })) };
}

// upsertForMaxChat отдаёт то же, что SQL: привязка всегда с connector_chat_id = 'max:<chatId>'.
function fakeRepo(overrides = {}, { created = true } = {}) {
  return {
    findByMaxChat: vi.fn(async () => null),
    upsertForMaxChat: vi.fn(async ({ installationId, maxChatId }) => ({
      binding: new ChatBinding({ id: 99, installationId, maxChatId, connectorChatId: `max:${maxChatId}` }),
      created,
    })),
    ...overrides,
  };
}

function buildSvc(repo, installations, participants = {}) {
  return new BindingsService({
    bindingsRepository: repo,
    participantMapRepository: participants,
    installationsService: installations ?? fakeInstallations(),
    logger: null,
  });
}

describe('BindingsService.ensureForMaxChat', () => {
  it('1) один upsert без предварительного SELECT → { binding, created: true }, привязка готова', async () => {
    const repo = fakeRepo();
    const svc = buildSvc(repo);

    const { binding, created } = await svc.ensureForMaxChat('-70000000000954');

    expect(repo.findByMaxChat).not.toHaveBeenCalled();
    expect(repo.upsertForMaxChat).toHaveBeenCalledOnce();
    expect(repo.upsertForMaxChat.mock.calls[0][0]).toEqual({
      installationId: 1,
      maxChatId: '-70000000000954',
      maxChatTitle: null,
    });
    expect(created).toBe(true);
    expect(binding.connectorChatId).toBe('max:-70000000000954');
    expect(binding.isReadyForRouting()).toBe(true);
  });

  it('2) привязка уже есть (конкурентный первый запрос / самовосстановление) → created: false', async () => {
    const repo = fakeRepo({}, { created: false });
    const svc = buildSvc(repo);

    const { binding, created } = await svc.ensureForMaxChat('-70000000000954');

    expect(created).toBe(false);
    expect(binding.isReadyForRouting()).toBe(true);
  });

  it('3) maxChatId числом → хранится как строка (MAX webhook шлёт числом)', async () => {
    const repo = fakeRepo();
    const svc = buildSvc(repo);

    await svc.ensureForMaxChat(-70000000000954);

    expect(repo.upsertForMaxChat.mock.calls[0][0].maxChatId).toBe('-70000000000954');
  });

  it('4) installation передана вызывающим → getCurrent не вызывается', async () => {
    const repo = fakeRepo();
    const installations = fakeInstallations();
    const svc = buildSvc(repo, installations);

    await svc.ensureForMaxChat('-1', { installation: { id: 7 }, maxChatTitle: 'Группа' });

    expect(installations.getCurrent).not.toHaveBeenCalled();
    expect(repo.upsertForMaxChat.mock.calls[0][0]).toEqual({
      installationId: 7,
      maxChatId: '-1',
      maxChatTitle: 'Группа',
    });
  });

  it.each([null, undefined, ''])('5) maxChatId=%j → ValidationError, upsert не вызван', async (maxChatId) => {
    const repo = fakeRepo();
    const svc = buildSvc(repo);

    await expect(svc.ensureForMaxChat(maxChatId)).rejects.toThrow('ensureForMaxChat');
    expect(repo.upsertForMaxChat).not.toHaveBeenCalled();
  });

  // M26: после ONAPPUNINSTALL строка installations помечена uninstalled_at. Онбординг
  // закрыт: 503 → MAX ретраит, привязка без приложения не появляется.
  const uninstalled = () => new Installation({
    id: 7,
    b24Portal: 'example.bitrix24.ru',
    uninstalledAt: new Date('2026-10-08T10:00:00Z'),
  });

  it('6) приложение удалено (installation от вызывающего) → ConfigError 503, upsert не вызван', async () => {
    const repo = fakeRepo();
    const svc = buildSvc(repo);

    const err = await svc.ensureForMaxChat('-1', { installation: uninstalled() }).catch((e) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ status: 503, code: 'CONFIG_ERROR' });
    expect(err.message).toContain('uninstalled');
    expect(repo.upsertForMaxChat).not.toHaveBeenCalled();
  });

  it('7) приложение удалено (installation из getCurrent) → ConfigError, upsert не вызван', async () => {
    const repo = fakeRepo();
    const svc = buildSvc(repo, { getCurrent: vi.fn(async () => uninstalled()) });

    await expect(svc.ensureForMaxChat('-1')).rejects.toBeInstanceOf(ConfigError);
    expect(repo.upsertForMaxChat).not.toHaveBeenCalled();
  });

  it('8) установленное приложение (Installation без uninstalledAt) → онбординг идёт', async () => {
    const repo = fakeRepo();
    const svc = buildSvc(repo);

    const installation = new Installation({ id: 7, b24Portal: 'example.bitrix24.ru' });
    const { created } = await svc.ensureForMaxChat('-1', { installation });

    expect(created).toBe(true);
    expect(repo.upsertForMaxChat).toHaveBeenCalledOnce();
  });
});

describe('BindingsService.purgeAll (M26)', () => {
  it('1) делегирует в deleteAllByInstallation → { bindings }', async () => {
    const repo = fakeRepo({ deleteAllByInstallation: vi.fn(async () => 2) });
    const svc = buildSvc(repo);

    await expect(svc.purgeAll(1)).resolves.toEqual({ bindings: 2 });
    expect(repo.deleteAllByInstallation).toHaveBeenCalledWith(1);
  });

  it.each([null, undefined, 0, ''])('2) installationId=%j → ValidationError, репозиторий не вызван', async (id) => {
    const repo = fakeRepo({ deleteAllByInstallation: vi.fn() });
    const svc = buildSvc(repo);

    await expect(svc.purgeAll(id)).rejects.toThrow('purgeAll');
    expect(repo.deleteAllByInstallation).not.toHaveBeenCalled();
  });

  it('3) ошибка БД пробрасывается', async () => {
    const repo = fakeRepo({ deleteAllByInstallation: vi.fn(async () => { throw new Error('deadlock'); }) });
    const svc = buildSvc(repo);

    await expect(svc.purgeAll(1)).rejects.toThrow('deadlock');
  });
});

describe('BindingsService.findParticipantName', () => {
  it('1) делегирует в participantMapRepository.findDisplayName и возвращает имя', async () => {
    const participants = { findDisplayName: vi.fn(async () => 'Иван Петров') };
    const svc = buildSvc(fakeRepo(), undefined, participants);

    await expect(svc.findParticipantName(99, 54321)).resolves.toBe('Иван Петров');
    expect(participants.findDisplayName).toHaveBeenCalledWith(99, 54321);
  });

  it('2) участника нет → null', async () => {
    const participants = { findDisplayName: vi.fn(async () => null) };
    const svc = buildSvc(fakeRepo(), undefined, participants);

    await expect(svc.findParticipantName(99, 54321)).resolves.toBeNull();
  });

  it.each([
    ['bindingId', null, 54321],
    ['maxUserId', 99, null],
    ['maxUserId пустой', 99, ''],
  ])('3) нет %s → ValidationError, репозиторий не вызван', async (_label, bindingId, maxUserId) => {
    const participants = { findDisplayName: vi.fn() };
    const svc = buildSvc(fakeRepo(), undefined, participants);

    await expect(svc.findParticipantName(bindingId, maxUserId)).rejects.toThrow('findParticipantName');
    expect(participants.findDisplayName).not.toHaveBeenCalled();
  });
});

describe('BindingsService.updateMaxChatTitle / markOlChatTitle (M24)', () => {
  it('1) делегируют в репозиторий (max_chat_title / ol_chat_title)', async () => {
    const updated = makeExistingBinding({ maxChatTitle: 'Новое' });
    const repo = fakeRepo({
      updateMaxChatTitle: vi.fn(async () => updated),
      updateOlChatTitle: vi.fn(async () => updated),
    });
    const svc = buildSvc(repo);

    await expect(svc.updateMaxChatTitle(99, 'Новое')).resolves.toBe(updated);
    expect(repo.updateMaxChatTitle).toHaveBeenCalledWith(99, 'Новое');
    await expect(svc.markOlChatTitle(99, 'Новое')).resolves.toBe(updated);
    expect(repo.updateOlChatTitle).toHaveBeenCalledWith(99, 'Новое');
  });

  it.each([
    ['updateMaxChatTitle', null, 'X'],
    ['updateMaxChatTitle', 99, '   '],
    ['markOlChatTitle', 99, null],
    ['markOlChatTitle', null, 'X'],
  ])('2) %s(%s, %s) → ValidationError, репозиторий не вызван', async (method, bindingId, title) => {
    const repo = fakeRepo({ updateMaxChatTitle: vi.fn(), updateOlChatTitle: vi.fn() });
    const svc = buildSvc(repo);

    await expect(svc[method](bindingId, title)).rejects.toThrow(method);
    expect(repo.updateMaxChatTitle).not.toHaveBeenCalled();
    expect(repo.updateOlChatTitle).not.toHaveBeenCalled();
  });
});

describe('BindingsService — сессия OL (M25)', () => {
  it('1) фасады делегируют в репозиторий', async () => {
    const updated = makeExistingBinding({ olSessionId: 16342 });
    const repo = fakeRepo({
      updateOlSession: vi.fn(async () => updated),
      markOlSessionClosed: vi.fn(async () => updated),
      clearOlClosedSession: vi.fn(async () => null),
    });
    const svc = buildSvc(repo);

    await expect(svc.rememberOlSession(99, 16342)).resolves.toBe(updated);
    expect(repo.updateOlSession).toHaveBeenCalledWith(99, 16342);
    await expect(svc.markOlSessionClosed(99, 16342)).resolves.toBe(updated);
    expect(repo.markOlSessionClosed).toHaveBeenCalledWith(99, 16342);
    await expect(svc.completeSessionOpener(99, 16340, 16342)).resolves.toBeNull();
    expect(repo.clearOlClosedSession).toHaveBeenCalledWith(99, 16340, 16342);
    await svc.completeSessionOpener(99, 16340);
    expect(repo.clearOlClosedSession).toHaveBeenLastCalledWith(99, 16340, null);
  });

  it.each([
    ['rememberOlSession', [null, 1]],
    ['rememberOlSession', [99, '16342']],
    ['markOlSessionClosed', [99, 0]],
    ['markOlSessionClosed', [99, 1.5]],
    ['completeSessionOpener', [99, null]],
    ['completeSessionOpener', [99, -1]],
    ['completeSessionOpener', [99, 0.5]],
    ['completeSessionOpener', [99, 16340, -1]],
    ['completeSessionOpener', [99, 0, 0]],
    ['markOlSessionClosedByRename', [null, 16340]],
    ['markOlSessionClosedByRename', [99, 0]],
    ['markOlSessionClosedByRename', [99, -1]],
    ['markOlSessionClosedByRename', [99, '5']],
    ['markOlSessionClosedByRename', [99, undefined]],
  ])('2) %s(%j) → ValidationError, репозиторий не вызван', async (method, args) => {
    const repo = fakeRepo({
      updateOlSession: vi.fn(),
      markOlSessionClosed: vi.fn(),
      markOlSessionClosedUnknown: vi.fn(),
      clearOlClosedSession: vi.fn(),
    });
    const svc = buildSvc(repo);

    await expect(svc[method](...args)).rejects.toThrow(method);
    expect(repo.updateOlSession).not.toHaveBeenCalled();
    expect(repo.markOlSessionClosed).not.toHaveBeenCalled();
    expect(repo.markOlSessionClosedUnknown).not.toHaveBeenCalled();
    expect(repo.clearOlClosedSession).not.toHaveBeenCalled();
  });

  it('3) M27: markOlSessionClosedByRename — число → флаг этой сессии; null → флаг 0 (номер неизвестен)', async () => {
    const updated = makeExistingBinding({ olClosedSessionId: 16340 });
    const repo = fakeRepo({
      markOlSessionClosed: vi.fn(async () => updated),
      markOlSessionClosedUnknown: vi.fn(async () => null),
    });
    const svc = buildSvc(repo);

    await expect(svc.markOlSessionClosedByRename(99, 16340)).resolves.toBe(updated);
    expect(repo.markOlSessionClosed).toHaveBeenCalledWith(99, 16340);
    expect(repo.markOlSessionClosedUnknown).not.toHaveBeenCalled();

    await expect(svc.markOlSessionClosedByRename(99, null)).resolves.toBeNull();
    expect(repo.markOlSessionClosedUnknown).toHaveBeenCalledWith(99);
    expect(repo.markOlSessionClosed).toHaveBeenCalledOnce();
  });

  it('4) M27: completeSessionOpener принимает флаг 0 (сессия без номера)', async () => {
    const repo = fakeRepo({ clearOlClosedSession: vi.fn(async () => null) });
    const svc = buildSvc(repo);

    await svc.completeSessionOpener(99, 0, 16342);
    expect(repo.clearOlClosedSession).toHaveBeenCalledWith(99, 0, 16342);
    await svc.completeSessionOpener(99, 0);
    expect(repo.clearOlClosedSession).toHaveBeenLastCalledWith(99, 0, null);
  });
});
