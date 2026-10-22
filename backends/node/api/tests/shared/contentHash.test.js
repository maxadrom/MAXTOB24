import { describe, expect, it } from 'vitest';
import { contentHash } from '../../src/shared/crypto/contentHash.js';

describe('shared/crypto/contentHash', () => {
  it('одинаковый вход → одинаковый хеш (детерминирован)', () => {
    expect(contentHash('правка из Б24')).toBe(contentHash('правка из Б24'));
  });

  it('разный вход → разный хеш', () => {
    expect(contentHash('текст A')).not.toBe(contentHash('текст B'));
  });

  it('пустая строка / null / undefined → стабильный хеш без throw', () => {
    const empty = contentHash('');
    expect(() => contentHash(null)).not.toThrow();
    expect(() => contentHash(undefined)).not.toThrow();
    expect(contentHash(null)).toBe(empty);
    expect(contentHash(undefined)).toBe(empty);
  });

  it('хеш — 16 hex-символов', () => {
    expect(contentHash('что угодно')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('не-строковый вход приводится к строке без throw', () => {
    expect(() => contentHash(12345)).not.toThrow();
    expect(contentHash(12345)).toBe(contentHash('12345'));
  });
});
