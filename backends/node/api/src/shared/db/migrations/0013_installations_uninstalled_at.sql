-- Удаление приложения Б24 (ONAPPUNINSTALL, M26). Б24 снимает права приложения, его
-- подписки и коннекторы; токены портала мертвы (APPLICATION_NOT_FOUND). Строку не
-- удаляем: на неё ссылаются привязки, а member_id сверяет переустановку. Токены
-- обнуляются, uninstalled_at отличает «приложение удалено» от «install-callback ещё
-- не пришёл» (env-fallback B24_APPLICATION_TOKEN, M9): после удаления /webhook/b24
-- не принимает события и по env. Переустановка (install-callback) сбрасывает в NULL.
-- С M26 deploy.sh применяет миграции до старта нового кода.

ALTER TABLE installations ADD COLUMN IF NOT EXISTS uninstalled_at timestamptz;
