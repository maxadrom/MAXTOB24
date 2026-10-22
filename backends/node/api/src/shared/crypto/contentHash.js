// Детерминированный контент-токен текста для синтетических ключей идемпотентности.
// Используется в OUTBOUND-правке (OL → MAX): editKey = edit:<b24MsgId>:<contentHash(text)>.
// НЕ зависит от полей B24-события (в OnImConnectorMessageUpdate per-message message.date
// отсутствует по доке — сверено docs MCP 2026-06-17, см. _routeOutboundEditOne).
// Один и тот же текст → один и тот же токен (ретрай вебхука корректно дедупится);
// разный текст → разные токены (повторная правка одного сообщения доходит до MAX).

import crypto from 'node:crypto';

// Усечение sha256-hex до 16 символов (64 бита) — достаточно для различения текстов
// правок одного сообщения; коллизии при таком объёме данных практически невозможны.
const CONTENT_TOKEN_LENGTH = 16;

// text может быть null/undefined/не-строкой — приводим к стабильной строке без throw.
export function contentHash(text) {
  return crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex')
    .slice(0, CONTENT_TOKEN_LENGTH);
}
