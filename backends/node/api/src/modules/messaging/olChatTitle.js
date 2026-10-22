// M27: сравнение названия чата OL с названием MAX-группы так, как его делает Б24 при
// imconnector.chat.name.set (CIMChat::Rename): новое имя — PHP trim (только пробел, \t, \n,
// \r, \0, \x0B — не NBSP и не прочие Unicode-пробелы), затем первые 255 символов (кодпоинтов,
// mb_substr), и если оно равно текущему — переименования нет, ответ CHAT_RENAMING_FAILED.
// Координатор по совпадению отличает «имя уже стоит» от закрытой сессии. Нестрогое
// сравнение PHP (==) не повторяем: «числовые» названия вроде "1e3"/"1000" дадут false —
// ошибка в безопасную сторону (название подождёт, флага на открытой сессии нет).

const OL_TITLE_MAX_CODEPOINTS = 255;
const PHP_TRIM_RE = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

function normalizeOlTitle(title) {
  return Array.from(title.replace(PHP_TRIM_RE, '')).slice(0, OL_TITLE_MAX_CODEPOINTS).join('');
}

// true — Б24 считает названия одинаковыми (переименование ничего не изменит).
export function sameOlTitle(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return normalizeOlTitle(a) === normalizeOlTitle(b);
}
