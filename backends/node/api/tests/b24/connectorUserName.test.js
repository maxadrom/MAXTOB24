// Unit-тесты connectorUserName (M23): санитизация имени пользователя коннектора под
// ограничения Б24 (live P9 2026-10-07) и непустой fallback (пустое имя → «Гость», P4).

import { describe, expect, it } from 'vitest';

import { B24_USER_NAME_MAX, connectorUserName } from '../../src/modules/b24/connectorUserName.js';

const name = (n) => connectorUserName({ id: 54321, name: n });

describe('connectorUserName', () => {
  it('обычное имя — без изменений', () => {
    expect(name('Иван Петров')).toBe('Иван Петров');
  });

  it('символ вне BMP в середине вырезается, пробелы схлопываются', () => {
    expect(name('Аня 🌸 Петрова')).toBe('Аня Петрова');
  });

  it('имя, начинающееся с эмодзи вне BMP, не становится пустым', () => {
    expect(name('🚀 Команда')).toBe('Команда');
  });

  it('ZWJ-последовательность и флаг вырезаются целиком, без невидимых склеек', () => {
    expect(name('Семья 👨‍👩‍👧 Ивановых 🇷🇺')).toBe('Семья Ивановых');
    expect(name('❤️‍🔥 Огонь')).toBe('❤️ Огонь');
  });

  it('BMP-символы, кавычки и HTML хранятся как есть', () => {
    expect(name('Кофе ☕ и ❤️ «Ромашка» & <b>Co</b>')).toBe('Кофе ☕ и ❤️ «Ромашка» & <b>Co</b>');
  });

  it('одиночный суррогат вырезается', () => {
    expect(name('Битый \uD83D суррогат')).toBe('Битый суррогат');
  });

  it.each([
    ['только эмодзи', '🚀🌸'],
    ['ZWJ-последовательность', '👨‍👩‍👧'],
    ['одни склейки', '\u200D\uFE0F'],
    ['пробелы', '   '],
    ['пустая строка', ''],
    ['null', null],
    ['undefined', undefined],
  ])('пусто после чистки (%s) → MAX user <id>', (_label, raw) => {
    expect(name(raw)).toBe('MAX user 54321');
  });

  it(`ровно ${B24_USER_NAME_MAX} символов — как есть`, () => {
    const exact = 'Я'.repeat(B24_USER_NAME_MAX);
    expect(name(exact)).toBe(exact);
  });

  it(`длиннее ${B24_USER_NAME_MAX} → ${B24_USER_NAME_MAX - 1} символов + «…»`, () => {
    const result = name('Я'.repeat(B24_USER_NAME_MAX + 10));
    expect(result).toBe(`${'Я'.repeat(B24_USER_NAME_MAX - 1)}…`);
    expect(result).toHaveLength(B24_USER_NAME_MAX);
  });

  it('лимит считается после чистки: эмодзи не съедают длину', () => {
    const body = 'Я'.repeat(B24_USER_NAME_MAX);
    expect(name(`🚀${body}🚀`)).toBe(body);
  });

  it('при обрезке хвостовой пробел перед «…» убирается', () => {
    const result = name(`${'Я'.repeat(B24_USER_NAME_MAX - 2)} Петров`);
    expect(result).toBe(`${'Я'.repeat(B24_USER_NAME_MAX - 2)}…`);
  });
});
