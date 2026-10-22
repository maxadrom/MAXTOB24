// Unit-тесты MaxUpdate.fromWebhookBody — нормализация payload MAX + derive senderName (M4) + is_channel (M6a).
// Проверяем: lifecycle (плоский chat_id), message_created (вложенные recipient/body/sender),
// три ветки derive senderName, нормализацию isChannel.

import { describe, expect, it, vi } from 'vitest';

import { MaxUpdate } from '../../src/modules/max/models/MaxUpdate.js';

describe('MaxUpdate.fromWebhookBody', () => {
  it('1) lifecycle bot_added: chat_id плоский, senderId из user.user_id, senderName из user', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'bot_added',
      timestamp: 1700000000001,
      chat_id: -70000000000954,
      user: { user_id: 100000001, first_name: 'Bot', is_bot: true },
    });

    expect(update.updateType).toBe('bot_added');
    expect(update.chatId).toBe(-70000000000954);
    expect(update.senderId).toBe(100000001);
    expect(update.mid).toBeNull();
    // M-lifecycle: имя теперь извлекается для всех lifecycle-типов (first_name).
    expect(update.senderName).toBe('Bot');
    expect(update.timestamp).toBe(1700000000001);
  });

  it('2) message_created: chatId/mid/senderId из вложенного message', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      timestamp: 1700000000000,
      message: {
        recipient: { chat_id: -70000000000954, chat_type: 'chat' },
        sender: { user_id: 54321, name: 'Иван Петров' },
        body: { mid: 'mid.ABC123', text: 'привет' },
      },
    });

    expect(update.chatId).toBe(-70000000000954);
    expect(update.mid).toBe('mid.ABC123');
    expect(update.senderId).toBe(54321);
    expect(update.message).toMatchObject({ body: { text: 'привет' } });
  });

  it('3) senderName: sender.name имеет приоритет', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1, name: 'Иван', first_name: 'Ignored', last_name: 'Ignored' },
        body: { mid: 'm1' },
      },
    });
    expect(update.senderName).toBe('Иван');
  });

  it('4) senderName: first_name + last_name, если name отсутствует', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1, first_name: 'Иван', last_name: 'Петров' },
        body: { mid: 'm1' },
      },
    });
    expect(update.senderName).toBe('Иван Петров');
  });

  it('5) senderName: только first_name (last_name пустой) → без хвостового пробела', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1, first_name: 'Иван', last_name: '' },
        body: { mid: 'm1' },
      },
    });
    expect(update.senderName).toBe('Иван');
  });

  it('6) senderName: fallback "MAX user <id>", если ни name, ни first/last нет', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 999 },
        body: { mid: 'm1' },
      },
    });
    expect(update.senderName).toBe('MAX user 999');
  });

  it('7) senderName=null, если нет ни sender, ни senderId', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        body: { mid: 'm1' },
      },
    });
    expect(update.senderId).toBeNull();
    expect(update.senderName).toBeNull();
  });
});

// M-lifecycle: имя участника + timestamp для уведомлений о вступлении/выходе.
describe('MaxUpdate.fromWebhookBody — lifecycle name (user_added/user_removed)', () => {
  it('L1) user_added: senderName = first_name + last_name, senderId/timestamp извлечены', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      timestamp: 1700000000123,
      chat_id: -70000000000954,
      user: { user_id: 54321, first_name: 'Иван', last_name: 'Петров' },
      inviter_id: 999,
    });
    expect(update.updateType).toBe('user_added');
    expect(update.senderId).toBe(54321);
    expect(update.senderName).toBe('Иван Петров');
    expect(update.timestamp).toBe(1700000000123);
  });

  it('L2) user_removed: senderName = first_name + last_name', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_removed',
      timestamp: 1700000000456,
      chat_id: -1,
      user: { user_id: 222, first_name: 'Пётр', last_name: 'Сидоров' },
      admin_id: 1,
    });
    expect(update.senderId).toBe(222);
    expect(update.senderName).toBe('Пётр Сидоров');
    expect(update.timestamp).toBe(1700000000456);
  });

  it('L3) user_added: только first_name → без хвостового пробела', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      chat_id: -1,
      user: { user_id: 1, first_name: 'Иван', last_name: '' },
    });
    expect(update.senderName).toBe('Иван');
  });

  it('L4) user_added: fallback на user.name (устаревшее), когда нет first/last', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      chat_id: -1,
      user: { user_id: 1, name: 'Старое Имя' },
    });
    expect(update.senderName).toBe('Старое Имя');
  });

  it('L5) user_added: senderName=null, когда у user нет ни имени, ни name → текст-билдер даст "MAX user <id>"', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      chat_id: -1,
      user: { user_id: 777 },
    });
    expect(update.senderId).toBe(777);
    expect(update.senderName).toBeNull();
  });
});

// Reply/цитирование: нормализация message.link → replyContext.
describe('MaxUpdate.fromWebhookBody — replyContext (reply/forward)', () => {
  function withLink(link) {
    return MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1, name: 'Автор' },
        body: { mid: 'child.1', text: 'мой ответ' },
        link,
      },
    });
  }

  it('R1) link.type=reply → replyContext с parentMid/parentText/parentSenderName', () => {
    const u = withLink({
      type: 'reply',
      message: { mid: 'parent.42', text: 'текст родителя', seq: 5 },
      sender: { user_id: 777, first_name: 'Пётр', last_name: 'Сидоров' },
      chat_id: -1,
    });
    expect(u.replyContext).toEqual({
      type: 'reply',
      parentMid: 'parent.42',
      parentText: 'текст родителя',
      parentSenderName: 'Пётр Сидоров',
    });
  });

  it('R2) link.type=forward → replyContext с type=forward', () => {
    const u = withLink({
      type: 'forward',
      message: { mid: 'parent.9', text: 'переслано' },
      sender: { user_id: 5, name: 'Имя Автора' },
    });
    expect(u.replyContext).toMatchObject({ type: 'forward', parentMid: 'parent.9' });
    expect(u.replyContext.parentSenderName).toBe('Имя Автора');
  });

  it('R3) нет link → replyContext === null', () => {
    const u = withLink(undefined);
    expect(u.replyContext).toBeNull();
  });

  it('R4) неизвестный link.type → replyContext === null', () => {
    const u = withLink({ type: 'mention', message: { mid: 'x' } });
    expect(u.replyContext).toBeNull();
  });

  it('R5) битый link (нет message/sender) → не падает, parentText="", parentSenderName=null', () => {
    const u = withLink({ type: 'reply' });
    expect(u.replyContext).toEqual({
      type: 'reply',
      parentMid: null,
      parentText: '',
      parentSenderName: null,
    });
  });

  it('R6) родитель-медиа без текста → parentText="", имя автора сохранено', () => {
    const u = withLink({
      type: 'reply',
      message: { mid: 'parent.media' },
      sender: { user_id: 3, first_name: 'Анна', last_name: '' },
    });
    expect(u.replyContext).toEqual({
      type: 'reply',
      parentMid: 'parent.media',
      parentText: '',
      parentSenderName: 'Анна',
    });
  });

  it('R7) lifecycle-тип (user_added) с link → replyContext не извлекается (только message_*)', () => {
    const u = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      chat_id: -1,
      user: { user_id: 1 },
      link: { type: 'reply', message: { mid: 'p' } },
    });
    expect(u.replyContext).toBeNull();
  });
});

describe('MaxUpdate.fromWebhookBody — is_channel (M6a)', () => {
  it('8) bot_added с is_channel:false → isChannel === false', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'bot_added',
      chat_id: -1,
      is_channel: false,
      user: { user_id: 1 },
    });
    expect(update.isChannel).toBe(false);
  });

  it('9) bot_added с is_channel:true → isChannel === true', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'bot_added',
      chat_id: -1,
      is_channel: true,
      user: { user_id: 1 },
    });
    expect(update.isChannel).toBe(true);
  });

  it('10) message_created без is_channel → isChannel === null', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1 },
        body: { mid: 'm1' },
      },
    });
    expect(update.isChannel).toBeNull();
  });

  it('11) user_added с is_channel:false → isChannel === false', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'user_added',
      chat_id: -1,
      is_channel: false,
      user: { user_id: 2 },
      inviter_id: 1,
    });
    expect(update.isChannel).toBe(false);
  });

  it('12) регрессия: chatId и senderId не сломаны при наличии is_channel', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'bot_added',
      chat_id: -70000000000954,
      is_channel: false,
      user: { user_id: 100000001 },
    });
    expect(update.chatId).toBe(-70000000000954);
    expect(update.senderId).toBe(100000001);
    expect(update.isChannel).toBe(false);
  });
});

// M11.2: парсинг вложений message.body.attachments[] (формат снят live в M11.1).
describe('MaxUpdate.attachments() — inbound media (M11.2)', () => {
  function withAttachments(attachments) {
    return MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1 },
        sender: { user_id: 1, name: 'Иван' },
        body: { mid: 'm1', text: '', attachments },
      },
    });
  }

  it('1) image: url из payload.url, name из payload.photo_id + .webp', () => {
    const u = withAttachments([
      {
        type: 'image',
        payload: { url: 'https://i.oneme.ru/i?123', photo_id: 987654, token: 'tok' },
      },
    ]);
    expect(u.attachments()).toEqual([
      { kind: 'image', url: 'https://i.oneme.ru/i?123', name: '987654.webp' },
    ]);
  });

  it('2) file: name = attachment.filename (с уровня attachment, НЕ из payload)', () => {
    const u = withAttachments([
      {
        type: 'file',
        filename: 'отчёт.pdf',
        size: 102400,
        payload: { url: 'https://fd.oneme.ru/getfile?x', token: 'tok', fileId: 42 },
      },
    ]);
    expect(u.attachments()).toEqual([
      { kind: 'file', url: 'https://fd.oneme.ru/getfile?x', name: 'отчёт.pdf' },
    ]);
  });

  it('3) video: name из payload.id + .mp4 (duration/thumbnail на уровне attachment)', () => {
    const u = withAttachments([
      {
        type: 'video',
        duration: 12,
        thumbnail: { url: 'https://i.oneme.ru/thumb' },
        payload: { url: 'https://vd123.okcdn.ru/v?y', token: 'tok', id: 555 },
      },
    ]);
    expect(u.attachments()).toEqual([
      { kind: 'video', url: 'https://vd123.okcdn.ru/v?y', name: '555.mp4' },
    ]);
  });

  it('4) sticker: name из payload.code + .png', () => {
    const u = withAttachments([
      {
        type: 'sticker',
        width: 128,
        height: 128,
        payload: { url: 'https://st.mycdn.me/s.png', code: 'SMILE42' },
      },
    ]);
    expect(u.attachments()).toEqual([
      { kind: 'sticker', url: 'https://st.mycdn.me/s.png', name: 'SMILE42.png' },
    ]);
  });

  it('4a) audio (M11.3): name из payload.id + .ogg (host a.oneme.ru/audio)', () => {
    const u = withAttachments([
      {
        type: 'audio',
        payload: {
          url: 'https://a.oneme.ru/audio?expires=1&signatureToken=tok',
          token: 'tok',
          id: 777,
        },
      },
    ]);
    expect(u.attachments()).toEqual([
      {
        kind: 'audio',
        url: 'https://a.oneme.ru/audio?expires=1&signatureToken=tok',
        name: '777.ogg',
      },
    ]);
  });

  it('4b) audio без payload.id → fallback name "audio.ogg" (ветка hasId=false)', () => {
    const u = withAttachments([
      { type: 'audio', payload: { url: 'https://a.oneme.ru/audio?x', token: 'tok' } },
    ]);
    expect(u.attachments()).toEqual([
      { kind: 'audio', url: 'https://a.oneme.ru/audio?x', name: 'audio.ogg' },
    ]);
  });

  it('5) несколько вложений → массив в порядке прихода', () => {
    const u = withAttachments([
      { type: 'image', payload: { url: 'https://i.oneme.ru/a', photo_id: 1 } },
      { type: 'file', filename: 'a.txt', payload: { url: 'https://fd.oneme.ru/b' } },
    ]);
    const res = u.attachments();
    expect(res).toHaveLength(2);
    expect(res.map((a) => a.kind)).toEqual(['image', 'file']);
  });

  it('6) неизвестный type → skip + WARN (не падает)', () => {
    const warn = vi.fn();
    const u = withAttachments([
      { type: 'contact', payload: { url: 'https://x' } },
      { type: 'image', payload: { url: 'https://i.oneme.ru/a', photo_id: 1 } },
    ]);
    const res = u.attachments({ logger: { warn, debug: vi.fn() } });
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe('image');
    expect(warn).toHaveBeenCalled();
  });

  it('7) вложение без url → skip + WARN', () => {
    const warn = vi.fn();
    const u = withAttachments([{ type: 'image', payload: { photo_id: 1 } }]);
    const res = u.attachments({ logger: { warn, debug: vi.fn() } });
    expect(res).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('8) нет attachments → пустой массив', () => {
    const u = MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: { recipient: { chat_id: -1 }, sender: { user_id: 1 }, body: { mid: 'm', text: 'hi' } },
    });
    expect(u.attachments()).toEqual([]);
  });
});

describe('MaxUpdate.fromWebhookBody — message_removed (INBOUND-удаление)', () => {
  it('плоский payload chat_id/message_id/user_id → chatId/mid/senderId', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'message_removed',
      timestamp: 1700000000123,
      chat_id: -70000000000954,
      message_id: 'mid.DEL123',
      user_id: 54321,
    });

    expect(update.updateType).toBe('message_removed');
    expect(update.chatId).toBe(-70000000000954);
    expect(update.mid).toBe('mid.DEL123');
    expect(update.senderId).toBe(54321);
    expect(update.timestamp).toBe(1700000000123);
    // message_removed — плоский payload, вложенного message нет.
    expect(update.message).toBeNull();
  });

  it('отсутствующие поля → null (graceful, контроллер всё равно отдаст 200/skip)', () => {
    const update = MaxUpdate.fromWebhookBody({ update_type: 'message_removed' });
    expect(update.chatId).toBeNull();
    expect(update.mid).toBeNull();
    expect(update.senderId).toBeNull();
  });
});

describe('MaxUpdate.fromWebhookBody — chat_title_changed (M24)', () => {
  it('плоский payload chat_id/user/title → chatId/senderId/senderName/chatTitle (trim)', () => {
    const update = MaxUpdate.fromWebhookBody({
      update_type: 'chat_title_changed',
      timestamp: 1700000000456,
      chat_id: -70000000000218,
      user: { user_id: 1000001, first_name: 'Олег', last_name: 'Смирнов' },
      title: '  Тестовая группа 🚀  ',
    });

    expect(update.updateType).toBe('chat_title_changed');
    expect(update.chatId).toBe(-70000000000218);
    expect(update.senderId).toBe(1000001);
    expect(update.senderName).toBe('Олег Смирнов');
    expect(update.chatTitle).toBe('Тестовая группа 🚀');
    expect(update.timestamp).toBe(1700000000456);
    expect(update.mid).toBeNull();
    expect(update.message).toBeNull();
  });

  it('пустой/отсутствующий title → chatTitle null; у остальных типов chatTitle null', () => {
    expect(MaxUpdate.fromWebhookBody({ update_type: 'chat_title_changed', chat_id: -1, title: '   ' }).chatTitle)
      .toBeNull();
    expect(MaxUpdate.fromWebhookBody({ update_type: 'chat_title_changed', chat_id: -1 }).chatTitle).toBeNull();
    expect(MaxUpdate.fromWebhookBody({ update_type: 'message_removed', chat_id: -1, title: 'X' }).chatTitle)
      .toBeNull();
  });
});

// M21: тип чата получателя — мост работает только с группами.
describe('MaxUpdate.chatType / isGroupChat (M21)', () => {
  function created(recipient) {
    return MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      timestamp: 1700000000000,
      message: { recipient, sender: { user_id: 1 }, body: { mid: 'm1', text: 'x' } },
    });
  }

  it.each([
    ['chat', true],
    ['dialog', false],
    ['channel', false],
    ['что-то новое', false],
  ])('chat_type=%s → chatType, isGroupChat()=%s', (chatType, isGroup) => {
    const update = created({ chat_id: -1, chat_type: chatType });
    expect(update.chatType).toBe(chatType);
    expect(update.isGroupChat()).toBe(isGroup);
  });

  it('нет chat_type → null, fail-open: считаем группой (как до M21)', () => {
    const update = created({ chat_id: -1 });
    expect(update.chatType).toBeNull();
    expect(update.isGroupChat()).toBe(true);
  });

  it('личка с chat_id=null → chatType=dialog, chatId=null', () => {
    const update = created({ chat_id: null, chat_type: 'dialog', user_id: 100000001 });
    expect(update.chatId).toBeNull();
    expect(update.isGroupChat()).toBe(false);
  });

  it('message_edited тоже несёт chatType; lifecycle — null', () => {
    const edited = MaxUpdate.fromWebhookBody({
      update_type: 'message_edited',
      message: { recipient: { chat_id: 5, chat_type: 'dialog' }, sender: { user_id: 1 }, body: { mid: 'm1' } },
    });
    expect(edited.chatType).toBe('dialog');
    const lifecycle = MaxUpdate.fromWebhookBody({ update_type: 'bot_added', chat_id: -1, is_channel: true });
    expect(lifecycle.chatType).toBeNull();
  });
});

// M21 (live 2026-10-08): пересылка картинки с подписью дошла без картинки — пересланное
// лежит в message.link.message, своё тело у пересылки пустое.
describe('MaxUpdate.attachments() — вложения пересылки (M21)', () => {
  const IMG = { type: 'image', payload: { url: 'https://i.oneme.ru/i?fwd', photo_id: 42 } };

  function withLink(link, ownAttachments) {
    return MaxUpdate.fromWebhookBody({
      update_type: 'message_created',
      message: {
        recipient: { chat_id: -1, chat_type: 'chat' },
        sender: { user_id: 1, name: 'Иван' },
        body: { mid: 'm1', text: '', ...(ownAttachments ? { attachments: ownAttachments } : {}) },
        link,
      },
    });
  }

  it('forward: вложения из link.message.attachments', () => {
    const u = withLink({ type: 'forward', message: { mid: 'orig', text: 'подпись', attachments: [IMG] } });
    expect(u.attachments()).toEqual([{ kind: 'image', url: 'https://i.oneme.ru/i?fwd', name: '42.webp' }]);
  });

  it('reply: медиа родителя к ответу не относится → не берём', () => {
    const u = withLink({ type: 'reply', message: { mid: 'parent', text: '', attachments: [IMG] } });
    expect(u.attachments()).toEqual([]);
  });

  it('forward + свои вложения → свои первыми, тот же url не дублируется', () => {
    const own = { type: 'file', filename: 'a.pdf', payload: { url: 'https://fd.oneme.ru/a' } };
    const u = withLink({ type: 'forward', message: { attachments: [IMG, own] } }, [own]);
    expect(u.attachments().map((a) => a.url)).toEqual(['https://fd.oneme.ru/a', 'https://i.oneme.ru/i?fwd']);
  });

  it('forward без вложений / битый link → []', () => {
    expect(withLink({ type: 'forward', message: { text: 'только текст' } }).attachments()).toEqual([]);
    expect(withLink({ type: 'forward' }).attachments()).toEqual([]);
  });
});
