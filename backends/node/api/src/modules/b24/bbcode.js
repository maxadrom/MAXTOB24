// BB-код конвертеры (M5.3):
//   bbcodeToMarkdown — outbound (Б24 BB → MAX markdown), используется в routeOutbound.
//   resolveMediaCaption — outbound-подпись к медиа без filename-ярлыка Б24.
//   markupToBbcode  — inbound (MAX body.markup offset/length → Б24 BB), применяется в routeInbound.
//                     MAX не шлёт markdown-маркеры в body.text — форматирование в body.markup[].

// M11.2: подпись оператора к медиа (outbound). Б24 при NEED_SIGNATURE добавляет авто-подпись
// "[b]Имя:[/b] [br]<контент>". Для файла БЕЗ комментария <контент> = имя файла —
// это filename-ярлык, его НЕ шлём в MAX (иначе шум «Имя: photo.jpg»). Если контент
// после [br] — реальный комментарий (не совпадает с именем файла) → подпись в markdown.
export function resolveMediaCaption(rawText, files) {
  const md = bbcodeToMarkdown(rawText ?? '');
  if (!md) return '';
  const nlIdx = md.indexOf('\n');
  const contentPart = (nlIdx >= 0 ? md.slice(nlIdx + 1) : md).trim();
  if (!contentPart) return '';
  const names = files
    .map((f) => (f?.name ? String(f.name).trim() : ''))
    .filter(Boolean);
  if (names.includes(contentPart)) return ''; // filename-ярлык — подавляем
  return md;
}

/**
 * Outbound: Б24 BB-коды → markdown для MAX.
 * [b]…[/b] → **…**, [i]…[/i] → _…_, [br]/[br/] → \n.
 * Прочие теги вырезаются. Null/non-string → ''.
 * @param {unknown} text
 * @returns {string}
 */
export function bbcodeToMarkdown(text) {
  if (text === null || text === undefined || typeof text !== 'string') return '';

  let result = text;
  // [b]…[/b] / [B]…[/B] → **…** (нежадно, регистронезависимо)
  result = result.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**');
  // [i]…[/i] / [I]…[/I] → _…_
  result = result.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '_$1_');
  // [br] / [br/] → newline (case-insensitive)
  result = result.replace(/\[br\/?]/gi, '\n');
  // вырезать все оставшиеся BB-теги: [tag], [/tag], [tag=attr]
  result = result.replace(/\[\/?[a-zA-Z][^\]]*\]/g, '');
  // пробелы/табы перед переносом
  result = result.replace(/[ \t]+\n/g, '\n');
  return result.trim();
}

// Security M13: нейтрализация литеральных BB-скобок в ПОЛЬЗОВАТЕЛЬСКОМ тексте
// MAX→OL. Без неё user-текст с `[b]`/`[url=…]`/`[/quote]` интерпретируется BB-парсером
// B24 как форматирование (инъекция). Вставляем zero-width space (U+200B) сразу за `[`:
// парсер не распознаёт `[tag]`/`[/tag]`, при этом `[` остаётся видимым, а ZWSP невидим
// (не «видимый мусор»). Достаточно нейтрализовать открывающую `[` (и `[b]`, и `[/b]`).
//
// LIVE-VERIFIED (OL, 2026-06-11, тестовая группа): без escape `[b]…[/b]`
// рендерится жирным (инъекция реальна); с ZWSP — литерально `[b]…[/b]`, не жирным и БЕЗ
// видимого артефакта (U+200B невидим в клиенте OL — «квадрата»/тофу нет). Менять способ —
// ТОЛЬКО здесь.
const BBCODE_ESCAPE_ZWSP = '​';

export function escapeBbcode(s) {
  if (s === null || s === undefined) return '';
  return String(s).split('[').join(`[${BBCODE_ESCAPE_ZWSP}`);
}

// Reply/цитирование (MAX→OL): троеточие для обрезанного текста родителя.
const QUOTE_ELLIPSIS = '…';

// Нормализация текста родителя для строки-цитаты `>>`: схлопываем переносы/пробелы
// в один пробел (цитата `>>` — одна строка: любой \n внутри прервал бы цитату и
// часть текста ушла бы НЕ в цитату), обрезаем по maxLen с многоточием. Возвращает
// безопасную однострочную выжимку (может быть пустой).
function sanitizeQuoteText(text, maxLen) {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // Усечение по ВИДИМОЙ длине, затем нейтрализация BB-скобок (ZWSP — zero-width,
  // видимую длину не меняет). Текст родителя — пользовательский, без escape мог бы
  // инъектировать BB-теги в цитату-префикс `>>`.
  const truncated =
    cleaned.length <= maxLen
      ? cleaned
      : `${cleaned.slice(0, Math.max(0, maxLen - 1)).trimEnd()}${QUOTE_ELLIPSIS}`;
  return escapeBbcode(truncated);
}

/**
 * Inbound reply/цитирование: replyContext → BB-префикс цитаты для OL.
 * Коннектор Б24 не переносит нативный reply (поля reply нет в imconnector.send.messages),
 * поэтому связь «ответ» эмулируем визуальной цитатой в начале текста.
 *
 * ВАЖНО (verified docs MCP 2026-06-10, «Форматирование текста (BB-коды)»): в чатах/ОЛ
 * Б24 тега `[quote]` НЕТ — он рендерится литерально. Цитата строки — префикс `>>текст`
 * в начале строки (рендерится как серый цитат-блок). Поддерживаемые теги: b/i/u/s/
 * size/color/url/code/br; Markdown не поддерживается.
 *   reply   → ">><Имя>: <текст>\n"
 *   forward → ">>↪ Переслано (<Имя>): <текст>\n" (помеченная цитата, не reply)
 * Родитель-медиа без текста → цитируем только имя автора. Нет ни имени, ни текста → '' (без префикса).
 * @param {object|null} replyContext  — { type:'reply'|'forward', parentText, parentSenderName }
 * @param {{ maxLen?: number }} [opts] — макс. длина текста родителя в цитате
 * @returns {string} BB-префикс (с завершающим \n) либо '' если цитировать нечего
 */
export function buildReplyQuoteBbcode(replyContext, { maxLen = 200 } = {}) {
  if (!replyContext || typeof replyContext !== 'object') return '';
  const { type, parentText, parentSenderName } = replyContext;
  // Имя автора-родителя тоже пользовательское — нейтрализуем BB-скобки. body
  // экранируется внутри sanitizeQuoteText.
  const trimmedName =
    typeof parentSenderName === 'string' && parentSenderName.trim()
      ? parentSenderName.trim()
      : null;
  const name = trimmedName ? escapeBbcode(trimmedName) : null;
  const body = sanitizeQuoteText(parentText, maxLen);

  let inner;
  if (type === 'forward') {
    const who = name ? ` (${name})` : '';
    inner = body ? `↪ Переслано${who}: ${body}` : `↪ Переслано${who}`;
  } else {
    if (name && body) inner = `${name}: ${body}`;
    else if (name) inner = name;
    else inner = body; // только текст, либо '' если и текста нет
  }

  if (!inner) return '';
  return `>>${inner}\n`;
}

// MAX markup type → BB-код открытие/закрытие
const MARKUP_BB = {
  strong: ['[b]', '[/b]'],
  emphasized: ['[i]', '[/i]'],
};

/**
 * Inbound: MAX body.markup (offset/length/type) → Б24 BB-коды.
 * MAX шлёт форматирование как массив аннотаций, НЕ как markdown-маркеры в тексте.
 * Поддерживаемые типы: strong→[b], emphasized→[i].
 * Null/non-string text → ''. Пустой/отсутствующий markup → text as-is (pass-through).
 * @param {unknown} text   — plain text из body.text
 * @param {unknown} markup — массив { from, length, type } из body.markup
 * @returns {string}
 */
export function markupToBbcode(text, markup) {
  if (text === null || text === undefined || typeof text !== 'string') return '';
  // Pass-through (нет markup) тоже экранируем — иначе литеральные `[b]…[/b]`
  // в user-тексте без markup инъектировали бы BB-форматирование в OL.
  if (!Array.isArray(markup) || markup.length === 0) return escapeBbcode(text);

  const spans = markup
    .filter(m => MARKUP_BB[m.type] && typeof m.from === 'number' && typeof m.length === 'number' && m.length > 0)
    .sort((a, b) => a.from - b.from);

  if (spans.length === 0) return escapeBbcode(text);

  // Пользовательские сегменты экранируем (нейтрализуем их `[…]`), а наши открытие/
  // закрытие (`[b]`/`[i]`) клеим как РЕАЛЬНЫЕ теги — поэтому escape ДО конкатенации.
  let result = '';
  let pos = 0;
  for (const m of spans) {
    const [open, close] = MARKUP_BB[m.type];
    const start = m.from;
    const end = m.from + m.length;
    if (start < pos) continue; // перекрывающиеся spans — пропустить
    result += escapeBbcode(text.slice(pos, start)) + open + escapeBbcode(text.slice(start, end)) + close;
    pos = end;
  }
  result += escapeBbcode(text.slice(pos));
  return result;
}

