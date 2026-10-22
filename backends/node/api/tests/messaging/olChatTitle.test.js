// Unit-тесты M27: sameOlTitle повторяет правило CIMChat::Rename Б24 (PHP trim, 255 кодпоинтов,
// строгое сравнение) — по нему координатор отличает «имя уже стоит» от закрытой сессии.

import { describe, expect, it } from 'vitest';

import { sameOlTitle } from '../../src/modules/messaging/olChatTitle.js';

describe('sameOlTitle (M27)', () => {
  it('одинаковые названия → true; разные → false', () => {
    expect(sameOlTitle('Группа Альфа и Бета', 'Группа Альфа и Бета')).toBe(true);
    expect(sameOlTitle('Группа Альфа и Ёлка', 'Группа Альфа и Елка')).toBe(false);
    expect(sameOlTitle('Тестовая ГРУППА', 'Тестовая группа')).toBe(false);
  });

  it('ASCII-пробелы по краям (как хвостовой пробел в пробе) → равны', () => {
    expect(sameOlTitle('Группа', 'Группа ')).toBe(true);
    expect(sameOlTitle(' \t\nГруппа\r\0\x0B', 'Группа')).toBe(true);
  });

  it('NBSP и прочие Unicode-пробелы по краям PHP trim не срезает → не равны', () => {
    expect(sameOlTitle('Группа', 'Группа ')).toBe(false);
    expect(sameOlTitle(' Группа', 'Группа')).toBe(false);
  });

  it('пробелы внутри названия значимы', () => {
    expect(sameOlTitle('Группа 1', 'Группа  1')).toBe(false);
  });

  it('больше 255 кодпоинтов → сравниваются первые 255', () => {
    const base = 'а'.repeat(255);
    expect(sameOlTitle(base, `${base}хвост`)).toBe(true);
    expect(sameOlTitle(`${base.slice(1)}б`, `${base}хвост`)).toBe(false);
  });

  it('эмодзи на границе 255 не режутся пополам (считаются кодпоинтами)', () => {
    const head = 'а'.repeat(254);
    // 254 + 🚀 = 255 кодпоинтов (256 UTF-16 code units) — эмодзи целиком входит.
    expect(sameOlTitle(`${head}🚀`, `${head}🚀лишнее`)).toBe(true);
    expect(sameOlTitle(`${head}🚀`, `${head}🎉`)).toBe(false);
    // 255 «а» + эмодзи: эмодзи за границей — отрезается целиком, без половины суррогатной пары.
    expect(sameOlTitle('а'.repeat(255), `${'а'.repeat(255)}🚀`)).toBe(true);
  });

  it('не-строки → false', () => {
    expect(sameOlTitle(null, 'Группа')).toBe(false);
    expect(sameOlTitle('Группа', undefined)).toBe(false);
    expect(sameOlTitle(null, null)).toBe(false);
    expect(sameOlTitle(1000, '1000')).toBe(false);
  });
});
