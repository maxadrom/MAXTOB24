// Unit-тесты M28: разбор отказа MAX «текст слишком длинный» (textTooLongDetails). Живая
// форма — live 2026-10-09, PUT /messages: HTTP 400 proto.payload
// «Field 'text' size (4321) must be at most 4000».

import { describe, expect, it } from 'vitest';

import { MaxApiError, textTooLongDetails } from '../../src/modules/max/maxApiError.js';

function httpError(maxMessage, extra = {}) {
  return new MaxApiError(`MaxClient PUT /messages: HTTP 400 — ${maxMessage}`, {
    httpStatus: 400, maxCode: 'proto.payload', maxMessage, ...extra,
  });
}

describe('MaxApiError.maxMessage (M28)', () => {
  it('по умолчанию null, задаётся опцией', () => {
    expect(new MaxApiError('x').maxMessage).toBeNull();
    expect(new MaxApiError('x', { maxMessage: 'boom' }).maxMessage).toBe('boom');
  });
});

describe('textTooLongDetails (M28)', () => {
  it('живая форма → { size, limit } из сообщения MAX', () => {
    expect(textTooLongDetails(httpError("Field 'text' size (4321) must be at most 4000")))
      .toEqual({ size: 4321, limit: 4000 });
    expect(textTooLongDetails(httpError("Field 'text' size (4001) must be at most 4000")))
      .toEqual({ size: 4001, limit: 4000 });
  });

  it('про длину текста, но без обоих чисел → { size: null, limit: null }', () => {
    expect(textTooLongDetails(httpError("Field 'text' size is too big"))).toEqual({ size: null, limit: null });
    expect(textTooLongDetails(httpError("Field 'text' size must be at most 4000"))).toEqual({ size: null, limit: null });
  });

  it('не про длину текста → null', () => {
    expect(textTooLongDetails(httpError('Invalid message_id: bogus'))).toBeNull();
    expect(textTooLongDetails(httpError("Field 'link' size (5000) must be at most 4000"))).toBeNull();
    expect(textTooLongDetails(httpError("Field 'text' size (0) must be at least 1"))).toBeNull();
    expect(textTooLongDetails(httpError(null))).toBeNull();
  });

  it('другой код, kind или не MaxApiError → null', () => {
    const message = "Field 'text' size (4321) must be at most 4000";
    expect(textTooLongDetails(httpError(message, { maxCode: 'some.code' }))).toBeNull();
    expect(textTooLongDetails(httpError(message, { maxCode: null }))).toBeNull();
    expect(textTooLongDetails(httpError(message, { kind: 'rejected' }))).toBeNull();
    expect(textTooLongDetails(new Error(message))).toBeNull();
    expect(textTooLongDetails(null)).toBeNull();
  });
});
