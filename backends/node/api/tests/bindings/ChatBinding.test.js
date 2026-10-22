// Unit-тесты ChatBinding.isReadyForRouting: готовность определяется
// исключительно наличием connector_chat_id.
import { describe, expect, it } from 'vitest';

import { ChatBinding } from '../../src/modules/bindings/models/ChatBinding.js';

describe('ChatBinding.isReadyForRouting', () => {
  it('connectorChatId задан → true', () => {
    const b = new ChatBinding({
      installationId: 1,
      maxChatId: '-1',
      connectorChatId: 'max:-1',
    });
    expect(b.isReadyForRouting()).toBe(true);
  });

  it('connectorChatId null → false', () => {
    const b = new ChatBinding({
      installationId: 1,
      maxChatId: '-1',
      connectorChatId: null,
    });
    expect(b.isReadyForRouting()).toBe(false);
  });

  it('инвариант: isReadyForRouting === Boolean(connectorChatId)', () => {
    const ready = new ChatBinding({ installationId: 1, maxChatId: '-1', connectorChatId: 'max:-1' });
    const notReady = new ChatBinding({ installationId: 1, maxChatId: '-1' });
    expect(ready.isReadyForRouting()).toBe(Boolean(ready.connectorChatId));
    expect(notReady.isReadyForRouting()).toBe(Boolean(notReady.connectorChatId));
  });
});

describe('ChatBinding.needsOlTitleSync (M24)', () => {
  const base = { installationId: 1, maxChatId: '-1', connectorChatId: 'max:-1' };

  it('название в MAX есть, в OL ещё не ставили → true', () => {
    expect(new ChatBinding({ ...base, maxChatTitle: 'Группа', olChatTitle: null }).needsOlTitleSync()).toBe(true);
  });

  it('названия разошлись (переименование в MAX) → true; совпадают → false', () => {
    expect(new ChatBinding({ ...base, maxChatTitle: 'Новое', olChatTitle: 'Старое' }).needsOlTitleSync()).toBe(true);
    expect(new ChatBinding({ ...base, maxChatTitle: 'Группа', olChatTitle: 'Группа' }).needsOlTitleSync()).toBe(false);
  });

  it('названия в MAX нет → false (переименовывать нечем)', () => {
    expect(new ChatBinding({ ...base, maxChatTitle: null, olChatTitle: null }).needsOlTitleSync()).toBe(false);
    expect(new ChatBinding({ ...base, maxChatTitle: '', olChatTitle: 'X' }).needsOlTitleSync()).toBe(false);
  });
});

describe('ChatBinding.fromRow — ol_chat_title (M24)', () => {
  const row = {
    id: 5,
    installation_id: 1,
    max_chat_id: '-1',
    max_chat_title: 'Группа',
    connector_chat_id: 'max:-1',
    b24_chat_id: '21180',
  };

  it('колонка есть → olChatTitle из неё (null — ещё не ставили)', () => {
    expect(ChatBinding.fromRow({ ...row, ol_chat_title: 'Старое' }).olChatTitle).toBe('Старое');
    const fresh = ChatBinding.fromRow({ ...row, ol_chat_title: null });
    expect(fresh.olChatTitle).toBeNull();
    expect(fresh.needsOlTitleSync()).toBe(true);
  });

  it('колонки нет (код поднят раньше миграции 0010) → считаем синхронизированным', () => {
    const b = ChatBinding.fromRow(row);
    expect(b.olChatTitle).toBe('Группа');
    expect(b.needsOlTitleSync()).toBe(false);
  });
});

describe('ChatBinding — сессия OL (M25)', () => {
  const base = { installationId: 1, maxChatId: '-1', connectorChatId: 'max:-1' };

  it('needsSessionOpener: только при взведённом ol_closed_session_id', () => {
    expect(new ChatBinding(base).needsSessionOpener()).toBe(false);
    expect(new ChatBinding({ ...base, olClosedSessionId: 16340 }).needsSessionOpener()).toBe(true);
  });

  it('isStaleSessionFinish: событие старше известной сессии; сессия неизвестна → не устарело', () => {
    const b = new ChatBinding({ ...base, olSessionId: 16342 });
    expect(b.isStaleSessionFinish(16340)).toBe(true);
    expect(b.isStaleSessionFinish(16342)).toBe(false);
    expect(b.isStaleSessionFinish(16344)).toBe(false);
    expect(new ChatBinding(base).isStaleSessionFinish(1)).toBe(false);
  });

  it('fromRow: колонки есть → числа; нет (код раньше миграции 0011) → null, опенера нет', () => {
    const row = { id: 5, installation_id: 1, max_chat_id: '-1', connector_chat_id: 'max:-1' };
    const withCols = ChatBinding.fromRow({ ...row, ol_session_id: 16342, ol_closed_session_id: 16340 });
    expect(withCols).toMatchObject({ olSessionId: 16342, olClosedSessionId: 16340 });
    const legacy = ChatBinding.fromRow(row);
    expect(legacy).toMatchObject({ olSessionId: null, olClosedSessionId: null });
    expect(legacy.needsSessionOpener()).toBe(false);
  });
});
