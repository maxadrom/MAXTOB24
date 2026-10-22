// Имя пользователя коннектора для imconnector.send/update/delete.messages (M23).
//
// Б24 переписывает профиль пользователя коннектора (NAME/LAST_NAME) на КАЖДОМ из этих
// вызовов: пустое имя → «Гость» до следующего сообщения с именем (live P4 2026-10-07).
// Поэтому имя шлём всегда, в т.ч. на delete, и никогда не пустое. Ограничения поля
// NAME (live P9 2026-10-07):
//   • ≤ 50 символов — хвост Б24 молча отбрасывает;
//   • на первом символе вне BMP (4 байта в UTF-8: 🚀, 🌸, флаги) имя обрывается, а имя,
//     начинающееся с такого символа, становится «Гостем». BMP (❤️ ☕, кавычки, &, <b>) — как есть.
// Санитизация: вырезаем символы вне BMP (и одиночные суррогаты) вместе с прилегающими
// ZWJ/VS15/VS16 — иначе от «👨‍👩‍👧» остались бы невидимые склейки; схлопываем пробелы;
// длиннее лимита → 49 символов + «…». Пусто → fallbackName, по умолчанию `MAX user <id>`
// (тот же fallback, что MaxUpdate.deriveSenderName). Псевдо-пользователь «группа» (M24)
// передаёт свой fallback: название из одних эмодзи не должно дать `MAX user group:…`.

export const B24_USER_NAME_MAX = 50;

const NON_BMP_WITH_JOINERS = /\u200D*[\u{10000}-\u{10FFFF}\uD800-\uDFFF][\u200D\uFE0E\uFE0F]*/gu;
const EMOJI_JOINERS = /[\u200D\uFE0E\uFE0F]/g;
const ELLIPSIS = '…';

// author: { id, name, fallbackName? } → непустая строка ≤ B24_USER_NAME_MAX символов.
export function connectorUserName({ id, name, fallbackName } = {}) {
  const clean = typeof name === 'string'
    ? name.replace(NON_BMP_WITH_JOINERS, '').replace(/\s+/g, ' ').trim()
    : '';
  // Остались одни склейки (ZWJ/VS без видимых символов) — тоже пусто.
  if (!clean.replace(EMOJI_JOINERS, '')) return fallbackName || `MAX user ${id}`;
  if (clean.length <= B24_USER_NAME_MAX) return clean;
  // После чистки все символы в BMP → length считает символы, а не UTF-16-половинки.
  return `${clean.slice(0, B24_USER_NAME_MAX - 1).trimEnd()}${ELLIPSIS}`;
}
