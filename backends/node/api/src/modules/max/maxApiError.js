// Ошибка MAX Bot API на non-2xx (maxClient._fetchJson / uploadBinary).
//
// HTTP-статус апстрима — в `httpStatus`, НЕ в `status`: errorHandler берёт err.status
// как статус ответа нашего вебхука, и 4xx от MAX превратился бы в 4xx для MAX/Б24
// (те перестали бы ретраить). По той же причине класс не наследует DomainError.
// maxCode — поле `code` JSON-тела ошибки, если есть (формат тела в доке MAX не описан);
// у 'protocol' заливки (M28) — error_data 2xx-ответа (IMAGE_INVALID_FORMAT и т.п.).
// maxMessage (M28) — текст ошибки из тела не-2xx ответа: message/error JSON либо начало
// сырого тела (как в message ошибки); вне kind 'http' — null.
// kind (M22): 'http' — ответ не-2xx; 'timeout' / 'network' — ответа нет, httpStatus=null;
// 'protocol' — 2xx, но в ответе нет нужного (url заливки, токен вложения, photos);
// 'rejected' (M28) — HTTP 200 с success:false: MAX отказал (PUT /messages, live 2026-10-08:
// «Error on message edit», «Invalid chatId: 0»), причина — в тексте ошибки.
// stage (M28) — шаг upload-флоу, на котором упало: 'create' | 'upload' | 'payload' | 'send'
// (заполняет maxService.uploadAndSend; вне него null).
// Один класс на все сбои транспорта: координатор отличает «MAX не принял» от ошибок БД.

export class MaxApiError extends Error {
  constructor(message, {
    httpStatus = null,
    maxCode = null,
    maxMessage = null,
    method = null,
    path = null,
    kind = 'http',
    stage = null,
  } = {}) {
    super(message);
    this.name = 'MaxApiError';
    this.httpStatus = httpStatus;
    this.maxCode = maxCode;
    this.maxMessage = maxMessage;
    this.method = method;
    this.path = path;
    this.kind = kind;
    this.stage = stage;
  }
}

// M28: MAX отверг текст сообщения как слишком длинный. Live 2026-10-09 (PUT /messages, правка
// на 4300 символов): HTTP 400 {code:'proto.payload', message:"Field 'text' size (4321) must be at
// most 4000"}. Лимит — схема MAX: NewMessageBody.text maxLength 4000, одно тело у POST и PUT
// /messages (api-schema 1a4a502); точная граница live не снималась. Размер — вместе с подписью
// оператора.
// Возвращает { size, limit } — числа из сообщения MAX (оба null, если хоть одного нет) —
// либо null: отказ не про длину текста.
const TEXT_SIZE_RE = /field\s+['"]?text['"]?\s+size\b/i;
const TEXT_SIZE_NUMBERS_RE = /size\s*\((\d+)\)\s*must be at most\s+(\d+)/i;

export function textTooLongDetails(err) {
  if (!(err instanceof MaxApiError) || err.kind !== 'http' || err.maxCode !== 'proto.payload') return null;
  const message = typeof err.maxMessage === 'string' ? err.maxMessage : '';
  // Нижняя граница («must be at least 1») — не «слишком длинный»: такой отказ — как прочие proto.payload.
  if (!TEXT_SIZE_RE.test(message) || /\bat\s+least\b/i.test(message)) return null;
  const numbers = message.match(TEXT_SIZE_NUMBERS_RE);
  return numbers
    ? { size: Number(numbers[1]), limit: Number(numbers[2]) }
    : { size: null, limit: null };
}
