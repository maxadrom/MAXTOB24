-- Адрес чата Open Lines (chat<ID>) для системных lifecycle-уведомлений о
-- вступлении/выходе участников MAX-группы. im.message.add требует DIALOG_ID
-- = 'chat'+<CHAT_ID>; этот CHAT_ID стабилен между сессиями одной группы
-- (проверено live), поэтому персистим его на binding'е и переиспользуем, когда
-- lifecycle-событие приходит вне активной сессии.
-- Источник значения — session.CHAT_ID из ответа уже работающего
-- imconnector.send.messages (заполняется best-effort на каждом inbound).
-- Безопасно на проде: колонка nullable, существующие строки получают NULL
-- (graceful skip уведомления, пока первый inbound не заполнит значение).
-- Индекс не нужен: резолв binding'а всегда идёт по первичному ключу id.

ALTER TABLE chat_bindings ADD COLUMN IF NOT EXISTS b24_chat_id text;
