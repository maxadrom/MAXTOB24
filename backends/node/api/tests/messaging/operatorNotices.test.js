// Unit-тесты M28 (+ M29: причина «мост перезапускался»): тексты системных сообщений оператору о неудаче OL → MAX (отправка M22,
// правка и удаление M28) и классификация причин. Чистые функции, без I/O.

import { describe, expect, it } from 'vitest';

import { escapeBbcode } from '../../src/modules/b24/bbcode.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import {
  deleteFailureNotice,
  deleteWindowNotice,
  deliveryFailureReason,
  editFailureNotice,
  INTERNAL_FAILURE_REASON,
  isTextTooLongFailure,
  isUncertainFailure,
  RESTART_FAILURE_REASON,
  sendFailureNotice,
  sendUncertainNotice,
} from '../../src/modules/messaging/operatorNotices.js';
import { B24ApiError } from '../../src/shared/http/domainErrors.js';
import { MediaTooLargeError } from '../../src/shared/media/mediaTooLargeError.js';

const EVIL = '[url=http://evil]x[/url]';

// M28: отказ MAX на длинный текст — живая форма (live 2026-10-09, PUT /messages, 4321 =
// текст 4300 + подпись оператора).
function textTooLongError(maxMessage = "Field 'text' size (4321) must be at most 4000", extra = {}) {
  return new MaxApiError(`MaxClient PUT /messages: HTTP 400 — ${maxMessage}`, {
    httpStatus: 400, maxCode: 'proto.payload', maxMessage, method: 'PUT', path: '/messages', ...extra,
  });
}
const TOO_LONG_REASON = 'текст слишком длинный (4321 символ при лимите MAX 4000)';

describe('deliveryFailureReason (M22 + M28)', () => {
  it('M22: таймаут, сеть, HTTP с кодом и без, размер, скачивание из Б24 — прежние тексты', () => {
    expect(deliveryFailureReason(new MaxApiError('t', { kind: 'timeout' }))).toBe('MAX не ответил вовремя');
    expect(deliveryFailureReason(new MaxApiError('n', { kind: 'network' }))).toBe('MAX недоступен');
    expect(deliveryFailureReason(new MaxApiError('h', { httpStatus: 403, maxCode: 'chat.denied' })))
      .toBe('MAX не принял (chat.denied)');
    expect(deliveryFailureReason(new MaxApiError('h', { httpStatus: 500 }))).toBe('MAX не принял (HTTP 500)');
    expect(deliveryFailureReason(new MediaTooLargeError('big', { size: 2, limit: 256 * 1024 * 1024 })))
      .toBe('больше 256 МиБ');
    expect(deliveryFailureReason(new MediaTooLargeError('big', { size: 2, limit: 1536 * 1024 })))
      .toBe('больше 1.5 МиБ');
    expect(deliveryFailureReason(new MediaTooLargeError('big', { size: 2, limit: 1024 }))).toBe('больше 1 КиБ');
    expect(deliveryFailureReason(new B24ApiError('DOWNLOAD_TIMEOUT', 'x'))).toBe('не скачался из Битрикс24 вовремя');
    expect(deliveryFailureReason(new B24ApiError('DOWNLOAD_FAILED', 'x'))).toBe('не удалось скачать из Битрикс24');
  });

  it('не про доставку (БД, баг) → null', () => {
    expect(deliveryFailureReason(new Error('db down'))).toBeNull();
    expect(deliveryFailureReason(new TypeError('bug'))).toBeNull();
  });

  it("M28: kind 'rejected' (200 + success:false) → «MAX отказал», а не «HTTP null»", () => {
    expect(deliveryFailureReason(new MaxApiError('PUT /messages: success:false', { kind: 'rejected' })))
      .toBe('MAX отказал');
  });

  it("M28: kind 'protocol' с maxCode (error_data заливки) → «MAX не принял (<код>)»", () => {
    const err = new MaxApiError('rejected upload', { kind: 'protocol', maxCode: 'IMAGE_INVALID_FORMAT' });
    expect(deliveryFailureReason(err)).toBe('MAX не принял (IMAGE_INVALID_FORMAT)');
  });

  it("kind 'protocol' без maxCode — прежнее «MAX вернул неожиданный ответ»", () => {
    expect(deliveryFailureReason(new MaxApiError('no url', { kind: 'protocol' })))
      .toBe('MAX вернул неожиданный ответ');
  });

  it("M28: 400 proto.payload «Field 'text' size (N) must be at most M» → «текст слишком длинный (N символ… при лимите MAX M)»", () => {
    expect(deliveryFailureReason(textTooLongError())).toBe(TOO_LONG_REASON);
  });

  it.each([
    [4001, 'символ'],
    [4021, 'символ'],
    [4002, 'символа'],
    [4003, 'символа'],
    [4024, 'символа'],
    [4005, 'символов'],
    [4010, 'символов'],
    [4011, 'символов'],
    [4012, 'символов'],
    [4014, 'символов'],
    [4111, 'символов'],
    [4114, 'символов'],
    [4100, 'символов'],
  ])('M28: склонение по N: %i → «%s»', (size, word) => {
    const err = textTooLongError(`Field 'text' size (${size}) must be at most 4000`);
    expect(deliveryFailureReason(err)).toBe(`текст слишком длинный (${size} ${word} при лимите MAX 4000)`);
  });

  it('M28: сообщение MAX про длину текста без чисел → «текст слишком длинный для MAX»', () => {
    expect(deliveryFailureReason(textTooLongError("Field 'text' size is too big")))
      .toBe('текст слишком длинный для MAX');
    expect(deliveryFailureReason(textTooLongError("Field 'text' size must be at most 4000")))
      .toBe('текст слишком длинный для MAX');
  });

  it('M28: другой proto.payload (и proto.payload без сообщения) — прежнее «MAX не принял (proto.payload)»', () => {
    expect(deliveryFailureReason(textTooLongError('Invalid message_id: bogus'))).toBe('MAX не принял (proto.payload)');
    expect(deliveryFailureReason(textTooLongError(null))).toBe('MAX не принял (proto.payload)');
    expect(deliveryFailureReason(new MaxApiError('h', { httpStatus: 400, maxCode: 'proto.payload' })))
      .toBe('MAX не принял (proto.payload)');
  });

  it('M28: то же сообщение под другим кодом — не «слишком длинный»', () => {
    expect(deliveryFailureReason(textTooLongError(undefined, { maxCode: 'some.code' }))).toBe('MAX не принял (some.code)');
  });
});

describe('isTextTooLongFailure (M28)', () => {
  it('отказ MAX на длину текста → true', () => {
    expect(isTextTooLongFailure(textTooLongError())).toBe(true);
    expect(isTextTooLongFailure(textTooLongError("Field 'text' size is too big"))).toBe(true);
  });

  it('прочие сбои → false', () => {
    expect(isTextTooLongFailure(textTooLongError('Invalid message_id: bogus'))).toBe(false);
    expect(isTextTooLongFailure(new MaxApiError('t', { kind: 'timeout' }))).toBe(false);
    expect(isTextTooLongFailure(new MediaTooLargeError('big', { size: 2, limit: 1024 }))).toBe(false);
    expect(isTextTooLongFailure(new Error("Field 'text' size (4321) must be at most 4000"))).toBe(false);
    expect(isTextTooLongFailure(null)).toBe(false);
  });
});

describe('isUncertainFailure (M28)', () => {
  it('http / rejected / protocol — MAX точно не применил → false', () => {
    expect(isUncertainFailure(new MaxApiError('h', { httpStatus: 400, maxCode: 'proto.payload' }))).toBe(false);
    expect(isUncertainFailure(new MaxApiError('r', { kind: 'rejected' }))).toBe(false);
    expect(isUncertainFailure(new MaxApiError('p', { kind: 'protocol' }))).toBe(false);
  });

  it('timeout / network / не MaxApiError — исход неизвестен → true', () => {
    expect(isUncertainFailure(new MaxApiError('t', { kind: 'timeout' }))).toBe(true);
    expect(isUncertainFailure(new MaxApiError('n', { kind: 'network' }))).toBe(true);
    expect(isUncertainFailure(new Error('db down'))).toBe(true);
    expect(isUncertainFailure(new B24ApiError('X', 'y'))).toBe(true);
  });
});

describe('sendFailureNotice (M22; свёртка длинной подписи — M30)', () => {
  const tooLong = (name, reason = TOO_LONG_REASON) => ({ name, reason, tooLarge: false, textTooLong: true });
  const big = { name: 'big.mp4', reason: 'больше 1 МиБ', tooLarge: true };
  const other = { name: 'small.jpg', reason: 'MAX не принял (HTTP 500)', tooLarge: false };

  it('один текст, один файл, подсказки по размеру', () => {
    expect(sendFailureNotice([{ name: null, reason: 'MAX не принял (chat.denied)' }]))
      .toBe('⚠️ Не доставлено в MAX: текст сообщения — MAX не принял (chat.denied). Отправьте ещё раз.');
    expect(sendFailureNotice([{ name: 'photo.jpg', reason: 'больше 1 МиБ', tooLarge: true }]))
      .toBe('⚠️ Не доставлено в MAX: файл «photo.jpg» — больше 1 МиБ. Загрузите на диск и отправьте как ссылку.');
    expect(sendFailureNotice([big, other])).toBe(
      '⚠️ Не доставлено в MAX: файл «big.mp4» — больше 1 МиБ; файл «small.jpg» — MAX не принял (HTTP 500). '
      + 'Большие файлы загрузите на диск и отправьте как ссылку, остальное отправьте ещё раз.',
    );
  });

  it('M28: слишком длинный текст → причина без префикса «текст сообщения —», подсказка «сократите или разбейте»', () => {
    const err = textTooLongError();
    expect(sendFailureNotice([
      { name: null, reason: deliveryFailureReason(err), textTooLong: isTextTooLongFailure(err) },
    ])).toBe(
      `⚠️ Не доставлено в MAX: ${TOO_LONG_REASON}. Сократите текст или разбейте его на несколько сообщений.`,
    );
    expect(sendFailureNotice([{ name: null, reason: 'текст слишком длинный для MAX', textTooLong: true }])).toBe(
      '⚠️ Не доставлено в MAX: текст слишком длинный для MAX. Сократите текст или разбейте его на несколько сообщений.',
    );
  });

  it('M28/M30: длинная подпись к файлу (файл и подпись текстом) → одна строка, та же подсказка', () => {
    expect(sendFailureNotice([tooLong('photo.jpg'), tooLong(null)])).toBe(
      `⚠️ Не доставлено в MAX: ${TOO_LONG_REASON} — файл «photo.jpg» и подпись. `
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
  });

  it('M30: длинная подпись к нескольким файлам → причина один раз, файлы списком', () => {
    expect(sendFailureNotice([tooLong('a.jpg'), tooLong('b.jpg'), tooLong('c.pdf'), tooLong(null)])).toBe(
      `⚠️ Не доставлено в MAX: ${TOO_LONG_REASON} — файлы «a.jpg», «b.jpg», «c.pdf» и подпись. `
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
    // подпись текстом упала по другой причине — в свёртку не входит.
    expect(sendFailureNotice([tooLong('a.jpg'), tooLong('b.jpg'), { name: null, reason: 'MAX недоступен' }])).toBe(
      `⚠️ Не доставлено в MAX: ${TOO_LONG_REASON} — файлы «a.jpg», «b.jpg»; текст сообщения — MAX недоступен. `
      + 'Сократите текст или разбейте его на несколько сообщений, остальное отправьте ещё раз.',
    );
  });

  it('M30: свёртка — на месте первого пункта, прочие пункты и порядок не меняются', () => {
    expect(sendFailureNotice([tooLong('a.jpg'), big, tooLong('b.jpg'), other, tooLong(null)])).toBe(
      `⚠️ Не доставлено в MAX: ${TOO_LONG_REASON} — файлы «a.jpg», «b.jpg» и подпись; файл «big.mp4» — больше 1 МиБ; `
      + 'файл «small.jpg» — MAX не принял (HTTP 500). Большие файлы загрузите на диск и отправьте как ссылку, '
      + 'текст сократите или разбейте на несколько сообщений, остальное отправьте ещё раз.',
    );
  });

  it('M30: тот же объект пункта в списке дважды → свёрнутая строка одна', () => {
    const a = tooLong('a.jpg');
    const text = sendFailureNotice([a, tooLong(null), a]);
    expect(text.split(TOO_LONG_REASON)).toHaveLength(2);
  });

  it('M30: разные причины «слишком длинный» не сворачиваются друг с другом', () => {
    expect(sendFailureNotice([tooLong('a.jpg'), tooLong(null, 'текст слишком длинный для MAX')])).toBe(
      `⚠️ Не доставлено в MAX: файл «a.jpg» — ${TOO_LONG_REASON}; текст слишком длинный для MAX. `
      + 'Сократите текст или разбейте его на несколько сообщений.',
    );
  });

  it('M30: BB в именах и в причине свёрнутого пункта экранируется', () => {
    const reason = `текст слишком длинный (${EVIL})`;
    const text = sendFailureNotice([tooLong(`${EVIL}.jpg`, reason), tooLong(null, reason)]);
    expect(text).toContain(`текст слишком длинный (${escapeBbcode(EVIL)}) — файл «${escapeBbcode(`${EVIL}.jpg`)}» и подпись`);
    expect(text).not.toContain('[url=');
  });

  it('M28: длинный текст вместе с прочими сбоями — подсказки складываются', () => {
    const long = tooLong(null);
    expect(sendFailureNotice([other, long])).toBe(
      `⚠️ Не доставлено в MAX: файл «small.jpg» — MAX не принял (HTTP 500); ${TOO_LONG_REASON}. `
      + 'Сократите текст или разбейте его на несколько сообщений, остальное отправьте ещё раз.',
    );
    expect(sendFailureNotice([big, long])).toBe(
      `⚠️ Не доставлено в MAX: файл «big.mp4» — больше 1 МиБ; ${TOO_LONG_REASON}. `
      + 'Большие файлы загрузите на диск и отправьте как ссылку, текст сократите или разбейте на несколько сообщений.',
    );
    expect(sendFailureNotice([big, other, long])).toContain(
      '. Большие файлы загрузите на диск и отправьте как ссылку, текст сократите или разбейте на несколько сообщений, '
      + 'остальное отправьте ещё раз.',
    );
  });

  it('BB в имени файла и в reason экранируется', () => {
    const text = sendFailureNotice([{ name: `${EVIL}.pdf`, reason: `MAX не принял (${EVIL})` }]);
    expect(text).toContain(`«${escapeBbcode(`${EVIL}.pdf`)}»`);
    expect(text).toContain(`MAX не принял (${escapeBbcode(EVIL)})`);
    expect(text).not.toContain('[url=');
  });
});

describe('sendUncertainNotice (M28, внутренняя ошибка отправки)', () => {
  it('по умолчанию — «внутренняя ошибка моста»', () => {
    expect(sendUncertainNotice()).toBe(
      '⚠️ Сообщение могло не дойти до MAX: внутренняя ошибка моста. Проверьте и при необходимости отправьте ещё раз.',
    );
    expect(INTERNAL_FAILURE_REASON).toBe('внутренняя ошибка моста');
  });

  it('своя причина вызывающего — экранирована', () => {
    expect(sendUncertainNotice({ reason: 'передача прервана перезапуском' })).toBe(
      '⚠️ Сообщение могло не дойти до MAX: передача прервана перезапуском. '
      + 'Проверьте и при необходимости отправьте ещё раз.',
    );
    expect(sendUncertainNotice({ reason: EVIL })).toContain(escapeBbcode(EVIL));
    expect(sendUncertainNotice({ reason: EVIL })).not.toContain('[url=');
  });
});

describe('editFailureNotice (M28)', () => {
  it('сбой MAX → «Правка не доставлена…»', () => {
    expect(editFailureNotice({ reason: 'MAX не принял (proto.payload)' })).toBe(
      '⚠️ Правка не доставлена в MAX: MAX не принял (proto.payload). '
      + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.',
    );
  });

  it('uncertain → «Правка могла не дойти…»', () => {
    expect(editFailureNotice({ reason: 'MAX не ответил вовремя', uncertain: true })).toBe(
      '⚠️ Правка могла не дойти до MAX: MAX не ответил вовремя. Если важно, отредактируйте сообщение ещё раз.',
    );
  });

  it('notFound → «исходное сообщение не найдено» (reason не нужен)', () => {
    expect(editFailureNotice({ notFound: true })).toBe(
      '⚠️ Правка не доставлена в MAX: исходное сообщение не найдено в MAX '
      + '(не было доставлено или ещё доставлялось). Отправьте исправленный текст новым сообщением.',
    );
  });

  it('M28: MAX отверг текст как слишком длинный → причина с длиной и «сократите текст и отредактируйте…»', () => {
    const err = textTooLongError();
    expect(editFailureNotice({
      reason: deliveryFailureReason(err),
      uncertain: isUncertainFailure(err),
      textTooLong: isTextTooLongFailure(err),
    })).toBe(
      '⚠️ Правка не доставлена в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). '
      + 'У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.',
    );
    expect(editFailureNotice({ reason: 'текст слишком длинный для MAX', textTooLong: true })).toBe(
      '⚠️ Правка не доставлена в MAX: текст слишком длинный для MAX. '
      + 'У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.',
    );
  });

  it('M28: другой proto.payload — прежний текст без «сократите»', () => {
    const err = textTooLongError('Invalid message_id: bogus');
    expect(editFailureNotice({ reason: deliveryFailureReason(err), textTooLong: isTextTooLongFailure(err) })).toBe(
      '⚠️ Правка не доставлена в MAX: MAX не принял (proto.payload). '
      + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.',
    );
  });

  it('BB в reason экранируется', () => {
    const text = editFailureNotice({ reason: `MAX не принял (${EVIL})` });
    expect(text).toContain(escapeBbcode(EVIL));
    expect(text).not.toContain('[url=');
  });
});

describe('deleteFailureNotice (M28)', () => {
  it('все упали → «Удаление не доставлено…»', () => {
    expect(deleteFailureNotice({ reason: 'MAX не принял (HTTP 500)' })).toBe(
      '⚠️ Удаление не доставлено в MAX: MAX не принял (HTTP 500). У клиентов в MAX сообщение осталось.',
    );
  });

  it('uncertain → «Удаление могло не дойти…»', () => {
    expect(deleteFailureNotice({ reason: INTERNAL_FAILURE_REASON, uncertain: true })).toBe(
      '⚠️ Удаление могло не дойти до MAX: внутренняя ошибка моста. У клиентов в MAX сообщение могло остаться.',
    );
  });

  it('notDeleted/total → «не полностью: не удалено n из total вложений (reason)»', () => {
    expect(deleteFailureNotice({ reason: 'MAX не разрешил удалить', notDeleted: 1, total: 2 })).toBe(
      '⚠️ Удаление доставлено в MAX не полностью: не удалено 1 из 2 вложений (MAX не разрешил удалить). '
      + 'У клиентов в MAX они остались.',
    );
    expect(deleteFailureNotice({ reason: 'MAX недоступен', notDeleted: 2, total: 3 }))
      .toContain('не удалено 2 из 3 вложений (MAX недоступен)');
  });

  it('BB в reason экранируется', () => {
    expect(deleteFailureNotice({ reason: EVIL })).not.toContain('[url=');
    expect(deleteFailureNotice({ reason: EVIL, notDeleted: 1, total: 2 })).toContain(escapeBbcode(EVIL));
  });
});

describe('deleteWindowNotice (M28, max-window)', () => {
  it('ageHours ≥ 1 → «(отправлено N ч назад)», вниз до целого', () => {
    expect(deleteWindowNotice({ ageHours: 30 })).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его (отправлено 30 ч назад). '
      + 'У клиентов в MAX оно осталось.',
    );
    expect(deleteWindowNotice({ ageHours: 25.9 })).toContain('(отправлено 25 ч назад)');
  });

  it('ageHours < 1 → «(отправлено меньше часа назад)»', () => {
    expect(deleteWindowNotice({ ageHours: 0.5 })).toContain('(отправлено меньше часа назад)');
  });

  it('ageHours null (записи нет) → без скобки', () => {
    expect(deleteWindowNotice({ ageHours: null })).toBe(
      '⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его. У клиентов в MAX оно осталось.',
    );
    expect(deleteWindowNotice()).toBe(deleteWindowNotice({ ageHours: null }));
  });

  it('лимита по давности нет — в тексте нет срока («24 ч», «сутки»)', () => {
    for (const ageHours of [null, 0.5, 30]) {
      const text = deleteWindowNotice({ ageHours });
      expect(text).not.toMatch(/24 ч|сутк/);
    }
  });
});

describe('RESTART_FAILURE_REASON (M29, передача прервана рестартом)', () => {
  it('прерванная отправка: файлы по именам и текст — «мост перезапускался», хвост «Отправьте ещё раз.»', () => {
    expect(RESTART_FAILURE_REASON).toBe('мост перезапускался');
    expect(sendFailureNotice([
      { name: 'Договор.pdf', reason: RESTART_FAILURE_REASON },
      { name: 'Скан.jpg', reason: RESTART_FAILURE_REASON },
    ])).toBe('⚠️ Не доставлено в MAX: файл «Договор.pdf» — мост перезапускался; '
      + 'файл «Скан.jpg» — мост перезапускался. Отправьте ещё раз.');
    expect(sendFailureNotice([{ name: null, reason: RESTART_FAILURE_REASON }]))
      .toBe('⚠️ Не доставлено в MAX: текст сообщения — мост перезапускался. Отправьте ещё раз.');
  });

  it('прерванная правка: текст сбоя правки с причиной рестарта', () => {
    expect(editFailureNotice({ reason: RESTART_FAILURE_REASON })).toBe(
      '⚠️ Правка не доставлена в MAX: мост перезапускался. '
      + 'У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.',
    );
  });
});
