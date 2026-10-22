// Тексты системных сообщений оператору в чате ОЛ о неудаче OL → MAX: отправка (M22),
// правка и удаление (M28). Чистые функции без I/O: собирает текст координатор, шлёт —
// messagingService.notifyOperator (im.message.add SYSTEM=Y; клиенту в MAX не уходит).
// Шапку [b]MAXTOB24[/b] (имя приложения) Б24 ставит над системным сообщением сам.
// BB-экранирование: имена файлов и reason экранируют сами *Notice-функции — reason бывает
// с кодом MAX (maxCode) или своей причиной вызывающего; deliveryFailureReason отдаёт
// сырую строку.

import { B24ApiError } from '../../shared/http/domainErrors.js';
import { MediaTooLargeError } from '../../shared/media/mediaTooLargeError.js';
import { escapeBbcode } from '../b24/bbcode.js';
import { MaxApiError, textTooLongDetails } from '../max/maxApiError.js';

// Причина «исход неизвестен» для ошибок моста (БД, баг): сообщение/правка/удаление могли
// и дойти до MAX (упала, например, только запись в журнал).
export const INTERNAL_FAILURE_REASON = 'внутренняя ошибка моста';

// M29: передача прервана рестартом процесса (деплой, падение, reboot) — оповещение на
// следующем старте по строке задания очереди, оставшейся в журнале.
export const RESTART_FAILURE_REASON = 'мост перезапускался';

// M28: «1 символ», «2 символа», «5 символов» — форма слова по числу (11–14 — «символов»).
function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// M28: причина «текст слишком длинный» по разбору textTooLongDetails. size — длина вместе
// с подписью оператора (её считает MAX), отдельно не выделяем.
function textTooLongReason({ size, limit }) {
  if (size === null || limit === null) return 'текст слишком длинный для MAX';
  return `текст слишком длинный (${size} ${pluralRu(size, 'символ', 'символа', 'символов')} при лимите MAX ${limit})`;
}

// M22: размер для оператора: 256 МиБ, 1.5 МиБ, 512 КиБ.
function formatBytes(bytes) {
  const MIB = 1024 * 1024;
  if (bytes >= MIB) return `${Number((bytes / MIB).toFixed(1))} МиБ`;
  return `${Math.ceil(bytes / 1024)} КиБ`;
}

// M22: причина недоставки OL → MAX для оператора либо null — ошибка не про доставку
// (БД, баг) и должна дойти до errorHandler (500).
// M28: kind 'rejected' — MAX ответил 200 с success:false (правка); 'protocol' с maxCode —
// MAX отверг вложение кодом в error_data ответа заливки; отказ «текст длиннее лимита»
// (proto.payload, textTooLongDetails) — явной причиной вместо «MAX не принял (proto.payload)».
export function deliveryFailureReason(err) {
  if (err instanceof MediaTooLargeError) return `больше ${formatBytes(err.limit)}`;
  if (err instanceof MaxApiError) {
    if (err.kind === 'timeout') return 'MAX не ответил вовремя';
    if (err.kind === 'network') return 'MAX недоступен';
    if (err.kind === 'rejected') return 'MAX отказал';
    if (err.kind === 'protocol' && !err.maxCode) return 'MAX вернул неожиданный ответ';
    const tooLong = textTooLongDetails(err);
    if (tooLong) return textTooLongReason(tooLong);
    return `MAX не принял (${err.maxCode ?? `HTTP ${err.httpStatus}`})`;
  }
  // В медиа-пути Б24 зовётся только скачиванием файла оператора.
  if (err instanceof B24ApiError) {
    return err.b24Code === 'DOWNLOAD_TIMEOUT'
      ? 'не скачался из Битрикс24 вовремя'
      : 'не удалось скачать из Битрикс24';
  }
  return null;
}

// M28: исход неизвестен — запрос мог дойти до MAX (таймаут, сеть) либо упал сам мост
// (не MaxApiError). Такие сбои оператору — «могла/могло не дойти», а не «не доставлено».
export function isUncertainFailure(err) {
  if (!(err instanceof MaxApiError)) return true;
  return err.kind === 'timeout' || err.kind === 'network';
}

// M28: MAX отверг текст как слишком длинный — повтор того же текста не пройдёт, оператору
// подсказка «сократите», а не «отправьте/отредактируйте ещё раз».
export function isTextTooLongFailure(err) {
  return textTooLongDetails(err) !== null;
}

// Имя файла в оповещении; без имени — «файл <номер в сообщении>» (idx с нуля).
export function fileLabel(name, idx) {
  return name ?? `файл ${idx + 1}`;
}

// Пункт недоставки для sendFailureNotice: name — имя файла (null — текст сообщения). null —
// ошибка не про доставку (БД/баг): вызывающий пробрасывает её → 500.
export function sendFailureItem(err, name = null) {
  const reason = deliveryFailureReason(err);
  if (!reason) return null;
  return { name, reason, tooLarge: err instanceof MediaTooLargeError, textTooLong: isTextTooLongFailure(err) };
}

// M22: недоставка отправки. failures — [{ name|null, reason, tooLarge, textTooLong }]:
// name — имя файла (null — текст сообщения), reason — строка (своя причина вызывающего или
// deliveryFailureReason). Хвост — что делать: файл больше лимита повтор не пропустит, его —
// на диск и ссылкой; слишком длинный текст (M28; у файла — подпись) — сократить или разбить.
// Причина «текст слишком длинный» сама называет текст — без префикса «текст сообщения —».
// M30: длинную подпись MAX отвергает у каждого файла и у неё самой текстом (name: null) —
// одинаковая причина повторялась по пункту на файл. Такие пункты сворачиваются в один на месте
// первого: «<причина> — файлы «a», «b» и подпись». Одиночный текст без файлов — как был.
export function sendFailureNotice(failures) {
  const items = failures.flatMap((f, i) => {
    const reason = escapeBbcode(f.reason);
    const same = f.textTooLong ? failures.filter((x) => x.textTooLong && x.reason === f.reason) : [f];
    const files = same.filter((x) => x.name != null);
    if (same.length > 1 && files.length > 0) {
      // свёрнут в пункт первого (по индексу: тот же объект в списке дважды — одна строка)
      if (failures.indexOf(same[0]) !== i) return [];
      const names = files.map((x) => `«${escapeBbcode(x.name)}»`).join(', ');
      const caption = same.length > files.length ? ' и подпись' : '';
      return `${reason} — ${files.length === 1 ? 'файл' : 'файлы'} ${names}${caption}`;
    }
    if (f.name != null) return `файл «${escapeBbcode(f.name)}» — ${reason}`;
    return f.textTooLong ? reason : `текст сообщения — ${reason}`;
  });
  const tooLarge = failures.filter((f) => f.tooLarge).length;
  const textTooLong = failures.filter((f) => f.textTooLong).length;
  const rest = failures.length - tooLarge - textTooLong;
  const steps = [];
  if (tooLarge > 0) {
    steps.push(tooLarge === failures.length
      ? 'загрузите на диск и отправьте как ссылку'
      : 'большие файлы загрузите на диск и отправьте как ссылку');
  }
  if (textTooLong > 0) {
    steps.push(steps.length === 0
      ? 'сократите текст или разбейте его на несколько сообщений'
      : 'текст сократите или разбейте на несколько сообщений');
  }
  if (rest > 0) steps.push(steps.length === 0 ? 'отправьте ещё раз' : 'остальное отправьте ещё раз');
  const hint = steps.length > 0 ? steps.join(', ') : 'отправьте ещё раз';
  return `⚠️ Не доставлено в MAX: ${items.join('; ')}. ${hint[0].toUpperCase()}${hint.slice(1)}.`;
}

// M28: внутренняя ошибка отправки (БД/баг; ответ вебхука — 500). Сообщение могло и уйти
// в MAX — отсюда «могло». reason — своя причина вызывающего; маршрут берёт умолчание.
export function sendUncertainNotice({ reason = INTERNAL_FAILURE_REASON } = {}) {
  return `⚠️ Сообщение могло не дойти до MAX: ${escapeBbcode(reason)}. `
    + 'Проверьте и при необходимости отправьте ещё раз.';
}

// M28: правка OL → MAX не применилась. notFound — сообщения нет в MAX (не доходило, старше
// журнала или ещё доставляется); uncertain — исход неизвестен (таймаут, сеть, ошибка моста);
// textTooLong — MAX отверг текст как слишком длинный: тот же текст не пройдёт, его сократить.
export function editFailureNotice({ reason, notFound = false, uncertain = false, textTooLong = false } = {}) {
  if (notFound) {
    return '⚠️ Правка не доставлена в MAX: исходное сообщение не найдено в MAX '
      + '(не было доставлено или ещё доставлялось). Отправьте исправленный текст новым сообщением.';
  }
  if (uncertain) {
    return `⚠️ Правка могла не дойти до MAX: ${escapeBbcode(reason)}. `
      + 'Если важно, отредактируйте сообщение ещё раз.';
  }
  const retry = textTooLong
    ? 'сократите текст и отредактируйте сообщение ещё раз'
    : 'отредактируйте сообщение ещё раз';
  return `⚠️ Правка не доставлена в MAX: ${escapeBbcode(reason)}. `
    + `У клиентов осталась прежняя версия — ${retry}.`;
}

// M28: удаление OL → MAX не применилось. notDeleted/total (оба заданы) — удалено не
// полностью: часть сообщений MAX (по одному на файл) осталась; uncertain — исход
// неизвестен. Иначе — не удалено ничего.
export function deleteFailureNotice({ reason, uncertain = false, notDeleted = null, total = null } = {}) {
  if (notDeleted !== null && total !== null) {
    return `⚠️ Удаление доставлено в MAX не полностью: не удалено ${notDeleted} из ${total} вложений `
      + `(${escapeBbcode(reason)}). У клиентов в MAX они остались.`;
  }
  if (uncertain) {
    return `⚠️ Удаление могло не дойти до MAX: ${escapeBbcode(reason)}. `
      + 'У клиентов в MAX сообщение могло остаться.';
  }
  return `⚠️ Удаление не доставлено в MAX: ${escapeBbcode(reason)}. У клиентов в MAX сообщение осталось.`;
}

// M28: MAX ответил success:false на удаление всех сообщений (вердикт max-window). Лимита по
// давности в доке MAX нет и live не видно (сообщение бота удалилось и через 63 ч), причина
// отказа неизвестна — поэтому без срока: только возраст сообщения по записи оригинала в
// журнале (ageHours; null — записи нет → без скобки).
export function deleteWindowNotice({ ageHours = null } = {}) {
  let age = '';
  if (typeof ageHours === 'number' && Number.isFinite(ageHours)) {
    age = ageHours >= 1
      ? ` (отправлено ${Math.floor(ageHours)} ч назад)`
      : ' (отправлено меньше часа назад)';
  }
  return `⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его${age}. `
    + 'У клиентов в MAX оно осталось.';
}
