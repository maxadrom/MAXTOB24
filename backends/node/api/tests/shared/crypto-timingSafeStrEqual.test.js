import { describe, expect, it } from 'vitest';

import { timingSafeStrEqual } from '../../src/shared/crypto/timingSafeStrEqual.js';

describe('shared/crypto/timingSafeStrEqual', () => {
  it('равные строки → true', () => {
    expect(timingSafeStrEqual('abc123', 'abc123')).toBe(true);
  });

  it('разные строки той же длины → false', () => {
    expect(timingSafeStrEqual('abc123', 'abc124')).toBe(false);
  });

  it('разная длина → false (timingSafeEqual не бросает)', () => {
    expect(timingSafeStrEqual('abc', 'abc123')).toBe(false);
  });

  it.each([
    ['', ''],
    ['', 'x'],
    [null, 'x'],
    ['x', undefined],
    [['x'], 'x'],
    [123, '123'],
  ])('пустое значение или не-строка (%j, %j) → false', (a, b) => {
    expect(timingSafeStrEqual(a, b)).toBe(false);
  });
});
