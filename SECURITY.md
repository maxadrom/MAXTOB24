# Безопасность

## Как сообщить об уязвимости

Не открывайте публичный issue. Сообщите приватно через GitHub: вкладка **Security** → **Report a vulnerability** (private vulnerability reporting). Опишите, что затронуто, как воспроизвести и чем это грозит.

Поддерживается только ветка `main` — исправления выходят в неё.

## Что особенно важно

- обход проверки вебхуков: `X-Max-Bot-Api-Secret` на `/webhook/max`, `application_token` и `member_id` на `/webhook/b24`;
- подмена установки через `POST /api/install` (подлинность доказывает обмен `refresh_token` с ключами приложения — [App Installation](docs/backend/app-installation.md));
- SSRF при скачивании файлов по ссылке из события Б24;
- утечка токенов и содержимого сообщений в логи или ответы API.

## Эксплуатация

- Секреты (`MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`, `B24_CLIENT_SECRET`, пароль БД) — только в `.env` на сервере; `.env` в git не коммитится.
- Порт `api-node` публикуйте только на `127.0.0.1` за reverse-proxy с TLS, Postgres наружу не публикуйте — см. [docs/deploy/vps-prod.md](docs/deploy/vps-prod.md).
- Если секрет утёк — перевыпустите его: токен бота — в настройках бота MAX, `MAX_WEBHOOK_SECRET` — `make register-webhook ARGS="--unregister"`, новый секрет в `.env`, пересоздать `api-node`, `make register-webhook` ([MAX Webhook Setup](docs/backend/max-webhook-setup.md)), ключи приложения Б24 — пересозданием приложения ([переустановка](docs/backend/app-installation.md#переустановка)).
