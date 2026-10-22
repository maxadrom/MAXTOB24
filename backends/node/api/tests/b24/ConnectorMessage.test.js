// Unit-тесты ConnectorMessage DTO под Verified schema (M4.1).
// Happy-конструкция + throw на отсутствие каждого обязательного поля.

import { describe, expect, it } from 'vitest';

import { ConnectorMessage } from '../../src/modules/b24/models/ConnectorMessage.js';

function validArgs(overrides = {}) {
  return {
    connectorChatId: 'max:-70000000000954',
    externalMessageId: 'max:mid:mid.ABC123',
    text: 'привет',
    date: 1700000000,
    author: { id: 54321, name: 'Иван', lastName: 'Петров' },
    ...overrides,
  };
}

describe('ConnectorMessage', () => {
  it('1) happy path: все поля проставлены', () => {
    const cm = new ConnectorMessage(validArgs());
    expect(cm.connectorChatId).toBe('max:-70000000000954');
    expect(cm.externalMessageId).toBe('max:mid:mid.ABC123');
    expect(cm.text).toBe('привет');
    expect(cm.date).toBe(1700000000);
    expect(cm.author).toMatchObject({ id: 54321, name: 'Иван', lastName: 'Петров' });
  });

  it('2) M24: chatName не хранится — imopenlines его не читает, название ставит chat.name.set', () => {
    const cm = new ConnectorMessage(validArgs({ chatName: 'Группа Север' }));
    expect(cm).not.toHaveProperty('chatName');
  });

  it('3) пустой text допустим (string)', () => {
    const cm = new ConnectorMessage(validArgs({ text: '' }));
    expect(cm.text).toBe('');
  });

  it('4) без connectorChatId → TypeError', () => {
    expect(() => new ConnectorMessage(validArgs({ connectorChatId: undefined }))).toThrow(
      /connectorChatId required/,
    );
  });

  it('5) без externalMessageId → TypeError', () => {
    expect(() => new ConnectorMessage(validArgs({ externalMessageId: undefined }))).toThrow(
      /externalMessageId required/,
    );
  });

  it('6) без author.id → TypeError', () => {
    expect(() => new ConnectorMessage(validArgs({ author: { name: 'Иван' } }))).toThrow(
      /author\.id required/,
    );
  });

  it('7) text не строка → TypeError', () => {
    expect(() => new ConnectorMessage(validArgs({ text: 123 }))).toThrow(/text must be string/);
  });

  it('8) date не число → TypeError (unix-ts seconds)', () => {
    expect(() => new ConnectorMessage(validArgs({ date: '1700000000' }))).toThrow(
      /date must be number/,
    );
  });

  // ── M11.2: files[] (inbound media) ──────────────────────────────────────────
  it('9) files по умолчанию [] (текст-только)', () => {
    const cm = new ConnectorMessage(validArgs());
    expect(cm.files).toEqual([]);
    expect(cm.hasContent()).toBe(true);
  });

  it('10) files проставлены → доступны, hasContent() true', () => {
    const cm = new ConnectorMessage(
      validArgs({ files: [{ url: 'https://i.oneme.ru/a', name: '1.webp' }] }),
    );
    expect(cm.files).toEqual([{ url: 'https://i.oneme.ru/a', name: '1.webp' }]);
    expect(cm.hasContent()).toBe(true);
  });

  it('11) только файл без текста → hasContent() true', () => {
    const cm = new ConnectorMessage(
      validArgs({ text: '', files: [{ url: 'https://fd.oneme.ru/b', name: 'd.pdf' }] }),
    );
    expect(cm.hasContent()).toBe(true);
  });

  it('12) пустой text + пустой files → hasContent() false (нечего слать)', () => {
    const cm = new ConnectorMessage(validArgs({ text: '', files: [] }));
    expect(cm.hasContent()).toBe(false);
  });

  it('13) files не массив → TypeError', () => {
    expect(() => new ConnectorMessage(validArgs({ files: 'nope' }))).toThrow(/files must be array/);
  });
});
