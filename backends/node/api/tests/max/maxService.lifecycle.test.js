// Unit-тесты handleLifecycleEvent (M6a): проверка прав бота + warning + dedup-guard.
// Мокаем maxClient через vi.fn(). Логгер — заглушка.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxService } from '../../src/modules/max/maxService.js';
import { MaxUpdate } from '../../src/modules/max/models/MaxUpdate.js';

const WARNING_TEXT =
  'Чтобы я пересылал сообщения этой группы в Битрикс24, выдайте мне права администратора (доступ ко всем сообщениям). Без этого я вижу только упоминания и ответы.';

function makeClient(overrides = {}) {
  return {
    hasToken: vi.fn().mockReturnValue(true),
    getChatMember: vi.fn(),
    getChatMembers: vi.fn(),
    getChat: vi.fn(),
    getMe: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeUpdate(overrides = {}) {
  return {
    updateType: 'bot_added',
    chatId: -100,
    senderId: 1,
    isChannel: false,
    ...overrides,
  };
}

describe('MaxService.handleLifecycleEvent (M6a)', () => {
  let client;
  let logger;
  let service;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
    service = new MaxService({ maxClient: client, logger });
  });

  it('1) bot_added группа без read_all_messages → sendMessage вызван ровно раз с текстом предупреждения; метод не бросил', async () => {
    client.getChatMember.mockResolvedValue({ is_admin: true, permissions: ['write'] });

    const result = await service.handleLifecycleEvent(makeUpdate());

    expect(result).toEqual({ ok: true, lifecycle: 'bot_added' });
    expect(client.getChatMember).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledWith({ chatId: -100, text: WARNING_TEXT });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('2) bot_added, permissions содержит read_all_messages → sendMessage НЕ вызван; info-лог', async () => {
    client.getChatMember.mockResolvedValue({
      is_admin: true,
      permissions: ['write', 'read_all_messages'],
    });

    await service.handleLifecycleEvent(makeUpdate());

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('3) bot_added канал (is_channel:true) → getChatMember НЕ вызван, sendMessage НЕ вызван', async () => {
    await service.handleLifecycleEvent(makeUpdate({ isChannel: true }));

    expect(client.getChatMember).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('4) user_added(self): getMe раз (мемо), нет прав → sendMessage вызван раз', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });

    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false }),
    );
    // Второй вызов — getMe должен взяться из кэша
    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false, chatId: -200 }),
    );

    expect(client.getMe).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('5) user_added чужой (user.user_id !== botId) → getChatMember/sendMessage НЕ вызваны', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });

    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 999999, isChannel: false }),
    );

    expect(client.getChatMember).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('6) dedup: bot_added без прав + user_added(self) без прав того же chatId → sendMessage ровно раз', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });
    const chatId = -100;

    await service.handleLifecycleEvent(makeUpdate({ chatId }));
    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 100000001, chatId, isChannel: false }),
    );

    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it('6a) bot_added и user_added(self) параллельно (отправка ещё идёт) → sendMessage ровно раз', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });
    let release;
    client.sendMessage.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const chatId = -100;

    const both = Promise.all([
      service.handleLifecycleEvent(makeUpdate({ chatId })),
      service.handleLifecycleEvent(
        makeUpdate({ updateType: 'user_added', senderId: 100000001, chatId, isChannel: false }),
      ),
    ]);
    // Моки отвечают микрозадачами — к setImmediate оба обработчика дошли до отправки.
    await new Promise((resolve) => setImmediate(resolve));
    release({});
    await both;

    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it('7) bot_removed чистит guard, повторный bot_added без прав → sendMessage второй раз', async () => {
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });
    const chatId = -100;

    await service.handleLifecycleEvent(makeUpdate({ chatId }));
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    await service.handleLifecycleEvent(makeUpdate({ updateType: 'bot_removed', chatId }));
    await service.handleLifecycleEvent(makeUpdate({ chatId }));

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('8) getChatMember бросает → метод не бросает, sendMessage НЕ вызван, warn-лог', async () => {
    client.getChatMember.mockRejectedValue(new Error('network error'));

    await expect(service.handleLifecycleEvent(makeUpdate())).resolves.toEqual({
      ok: true,
      lifecycle: 'bot_added',
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('9) sendMessage бросает → метод не бросает, chatId НЕ попал в guard (retry возможен)', async () => {
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });
    client.sendMessage.mockRejectedValue(new Error('forbidden'));

    await service.handleLifecycleEvent(makeUpdate());

    // Guard не добавил chatId, поэтому второй вызов тоже пытается слать
    client.sendMessage.mockResolvedValue({});
    await service.handleLifecycleEvent(makeUpdate());

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('10) getMe бросает (botId=null) → user_added(self) без падения, getChatMember не вызван', async () => {
    client.getMe.mockRejectedValue(new Error('timeout'));

    await expect(
      service.handleLifecycleEvent(
        makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false }),
      ),
    ).resolves.toEqual({ ok: true, lifecycle: 'user_added' });

    expect(client.getChatMember).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('11) retry botId: getMe бросает на первом user_added, на втором вызывается снова (сбой не кэшируется)', async () => {
    client.getMe
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });

    const upd = makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false });

    await service.handleLifecycleEvent(upd);
    await service.handleLifecycleEvent(upd);

    expect(client.getMe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('11a) getMe без user_id (200 без тела) → null НЕ кэшируется, следующий user_added снова зовёт getMe', async () => {
    client.getMe
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });

    const upd = makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false });

    await service.handleLifecycleEvent(upd);
    expect(client.getChatMember).not.toHaveBeenCalled();

    await service.handleLifecycleEvent(upd);
    expect(client.getMe).toHaveBeenCalledTimes(2);
    expect(client.getChatMember).toHaveBeenCalledOnce();
  });

  it('12) read_all_messages решающий признак: is_admin:false, но permissions содержит read_all_messages → sendMessage НЕ вызван', async () => {
    client.getChatMember.mockResolvedValue({
      is_admin: false,
      permissions: ['read_all_messages'],
    });

    await service.handleLifecycleEvent(makeUpdate());

    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── M24: getChatInfo (название/иконка/тип группы) + M10: getMemberAvatar ─────
describe('MaxService.getChatInfo (M24) / getMemberAvatar (M10)', () => {
  let client;
  let logger;
  let service;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
    service = new MaxService({ maxClient: client, logger });
  });

  it('getChatInfo: getChat → { title (trimmed), iconUrl из icon.url, type, link }', async () => {
    client.getChat.mockResolvedValue({
      chat_id: -100,
      type: 'chat',
      title: '  Отдел продаж  ',
      icon: { url: 'https://i.oneme.ru/i?r=ABC' },
      link: 'https://max.ru/join/AbC-123_x',
    });

    await expect(service.getChatInfo(-100)).resolves.toEqual({
      title: 'Отдел продаж',
      iconUrl: 'https://i.oneme.ru/i?r=ABC',
      type: 'chat',
      link: 'https://max.ru/join/AbC-123_x',
    });
    expect(client.getChat).toHaveBeenCalledWith(-100);
  });

  it('getChatInfo: группа без иконки (ключа icon нет) → iconUrl null', async () => {
    client.getChat.mockResolvedValue({ chat_id: -100, type: 'chat', title: 'Группа' });
    await expect(service.getChatInfo(-100)).resolves.toEqual({ title: 'Группа', iconUrl: null, type: 'chat', link: null });
  });

  it('getChatInfo: пустой title → null; не-https url иконки → null', async () => {
    client.getChat.mockResolvedValueOnce({ chat_id: -100, type: 'chat', title: '   ', icon: { url: 'http://x/i.png' } });
    await expect(service.getChatInfo(-100)).resolves.toEqual({ title: null, iconUrl: null, type: 'chat', link: null });

    client.getChat.mockResolvedValueOnce({ chat_id: -100 });
    await expect(service.getChatInfo(-100)).resolves.toEqual({ title: null, iconUrl: null, type: null, link: null });
  });

  // M27: ссылка уходит в BB-разметку системного сообщения OL — пропускаем только безопасную форму.
  it.each([
    ['нет ключа', undefined],
    ['null', null],
    ['не строка', 42],
    ['http://', 'http://max.ru/join/abc'],
    ['с пробелом', 'https://max.ru/join/a b'],
    ['с переводом строки', 'https://max.ru/join/a\nb'],
    ['с [', 'https://max.ru/join/a[url=x'],
    ['с ]', 'https://max.ru/join/a]b'],
    ['пустая', ''],
    ['только схема', 'https://'],
    ['длиннее 2048', `https://max.ru/join/${'a'.repeat(2049 - 'https://max.ru/join/'.length)}`],
  ])('getChatInfo: link %s → null', async (_label, link) => {
    client.getChat.mockResolvedValue({ chat_id: -100, type: 'chat', title: 'Группа', link });
    await expect(service.getChatInfo(-100)).resolves.toMatchObject({ title: 'Группа', link: null });
  });

  it('getChatInfo: link ровно 2048 символов проходит; сама ссылка в лог не попадает', async () => {
    const link = `https://max.ru/join/${'a'.repeat(2048 - 'https://max.ru/join/'.length)}`;
    client.getChat.mockResolvedValue({ chat_id: -100, type: 'chat', title: 'Группа', link });

    await expect(service.getChatInfo(-100)).resolves.toMatchObject({ link });
    const logged = JSON.stringify(service.logger.debug.mock.calls);
    expect(logged).toContain('"hasLink":true');
    expect(logged).not.toContain('max.ru/join');
  });

  it('getChatInfo: getChat бросает → null (best-effort), warn-лог', async () => {
    client.getChat.mockRejectedValue(new Error('timeout'));

    await expect(service.getChatInfo(-100)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('getMemberAvatar: avatar_url приоритетнее full_avatar_url; нужного участника берём по user_id', async () => {
    client.getChatMembers.mockResolvedValue({
      members: [
        { user_id: 999, avatar_url: 'https://i.oneme.ru/other.png' },
        {
          user_id: 1,
          avatar_url: 'https://i.oneme.ru/a.png',
          full_avatar_url: 'https://i.oneme.ru/full.png',
        },
      ],
    });

    await expect(service.getMemberAvatar(-100, 1)).resolves.toBe('https://i.oneme.ru/a.png');
    // Правильный путь: список участников группы с фильтром user_ids (НЕ /members/{id}).
    expect(client.getChatMembers).toHaveBeenCalledWith(-100, { userIds: [1] });
  });

  it('getMemberAvatar: avatar_url пуст → fallback на full_avatar_url', async () => {
    client.getChatMembers.mockResolvedValue({
      members: [{ user_id: 1, avatar_url: '', full_avatar_url: 'https://i.oneme.ru/full.png' }],
    });

    await expect(service.getMemberAvatar(-100, 1)).resolves.toBe('https://i.oneme.ru/full.png');
  });

  it('getMemberAvatar: участник найден, но без аватара → null', async () => {
    client.getChatMembers.mockResolvedValue({ members: [{ user_id: 1 }] });

    await expect(service.getMemberAvatar(-100, 1)).resolves.toBeNull();
  });

  it('getMemberAvatar: пустой список участников → null', async () => {
    client.getChatMembers.mockResolvedValue({ members: [] });

    await expect(service.getMemberAvatar(-100, 1)).resolves.toBeNull();
  });

  it('getMemberAvatar: getChatMembers бросает → null (best-effort), warn-лог', async () => {
    client.getChatMembers.mockRejectedValue(new Error('network'));

    await expect(service.getMemberAvatar(-100, 1)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ─── M-lifecycle: маршрутизация user_added(чужой)/user_removed в координатор ────
describe('MaxService.handleLifecycleEvent — lifecycle notifications routing', () => {
  let client;
  let logger;
  let messaging;
  let service;

  beforeEach(() => {
    client = makeClient();
    logger = makeLogger();
    messaging = { routeLifecycle: vi.fn(async () => ({ ok: true, event: 'user_added', b24MsgId: 1 })) };
    service = new MaxService({ maxClient: client, messagingService: messaging, logger });
  });

  it('1) user_added чужой (senderId !== botId) → routeLifecycle вызван, permissions НЕ проверяются', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });

    const result = await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 999, isChannel: false }),
    );

    expect(messaging.routeLifecycle).toHaveBeenCalledOnce();
    expect(messaging.routeLifecycle.mock.calls[0][0]).toMatchObject({ updateType: 'user_added', senderId: 999 });
    expect(client.getChatMember).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it('2) user_removed → routeLifecycle вызван', async () => {
    const result = await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_removed', senderId: 555, isChannel: false }),
    );

    expect(messaging.routeLifecycle).toHaveBeenCalledOnce();
    expect(messaging.routeLifecycle.mock.calls[0][0]).toMatchObject({ updateType: 'user_removed', senderId: 555 });
    expect(result).toMatchObject({ ok: true });
  });

  it('3) user_added(self) по-прежнему проверяет права, routeLifecycle НЕ вызван', async () => {
    client.getMe.mockResolvedValue({ user_id: 100000001 });
    client.getChatMember.mockResolvedValue({ is_admin: false, permissions: [] });

    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_added', senderId: 100000001, isChannel: false }),
    );

    expect(client.getChatMember).toHaveBeenCalledOnce();
    expect(messaging.routeLifecycle).not.toHaveBeenCalled();
  });

  it('4) user_removed в канале (isChannel:true) → skip-channel, routeLifecycle НЕ вызван', async () => {
    await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_removed', senderId: 555, isChannel: true }),
    );
    expect(messaging.routeLifecycle).not.toHaveBeenCalled();
  });

  it('5) ошибка координатора НЕ бросается наружу (вебхук остаётся 200), error-лог', async () => {
    messaging.routeLifecycle.mockRejectedValue(new Error('coordinator boom'));

    const result = await service.handleLifecycleEvent(
      makeUpdate({ updateType: 'user_removed', senderId: 555, isChannel: false }),
    );

    expect(result).toEqual({ ok: true, lifecycle: 'user_removed', skipped: 'lifecycle-error' });
    expect(logger.error).toHaveBeenCalled();
  });
});
