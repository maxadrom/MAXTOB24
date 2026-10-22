# Как внести изменения

Спасибо, что помогаете коннектору. Проект русскоязычный: комментарии в коде, сообщения коммитов и документация — на русском; issue и PR можно писать на русском или английском.

## Окружение

- Node.js 24 и pnpm 9 (`corepack enable` подхватит версию из `packageManager`);
- Docker с плагином `docker compose` — для Postgres и полного стека.

```bash
cd backends/node/api
pnpm install
pnpm test
```

## Тесты

Тесты запускаются **только из `backends/node/api/`**: из корня репозитория vitest их не найдёт.

- `pnpm test` — все тесты. Флаг `--no-file-parallelism` в скрипте обязателен: DB-тесты делят один Postgres.
- Один файл или один тест: `pnpm exec vitest run --no-file-parallelism tests/max/maxService.edit.test.js -t "<имя теста>"`.
- DB-тесты (`*.smoke.test.js`, `*.int.test.js`, `*.integration.test.js`) без доступной БД **скипаются, а не падают**. Чтобы прогнать их:
  ```bash
  docker compose --profile db-postgres up -d database-postgres   # из корня репо
  echo 'DATABASE_URL=postgresql://appuser:apppass@localhost:5432/appdb_test' > backends/node/api/.env.test
  ```
  Указывайте отдельную тестовую БД (`appdb_test`), не рабочую `appdb`: тесты очищают таблицы. Базу и миграции готовит `tests/globalSetup.js`.
- Внешние HTTP (MAX, Битрикс24) в тестах мокаются подменённым `fetch` — живых токенов тестам не нужно.
- В тестах только синтетические данные: никаких реальных `chat_id`, имён, доменов порталов и токенов.

Линтера и форматтера в проекте нет — следуйте стилю окружающего кода.

## Архитектура: что нельзя нарушать

Обзор — [docs/backend/architecture.md](docs/backend/architecture.md). Главное:

- Адаптеры `max/` и `b24/` **никогда** не вызывают друг друга напрямую — только через `messagingService`, где сосредоточены идемпотентность и журнал `message_log`.
- Поток зависимостей строго вниз: Controller → Service → Repository → БД. У таблицы один модуль-владелец; чужие таблицы — через сервис-фасад модуля, не прямым SQL.
- Новый маршрут сообщений строится на общем каркасе идемпотентности `_once`, не ручной копией. Исходящие OL → MAX идут только через очередь `routeOutboundQueued`.
- `process.env` читается только в `shared/config`. Новая переменная окружения — в `shared/config/schema.js` и в таблицу [docs/backend/env.md](docs/backend/env.md).
- HTTP-статус ответа MAX/Б24 не кладём в `err.status` (его `errorHandler` отдал бы ответом вебхука, и 4xx отключил бы ретраи) — для этого `httpStatus`.
- Вспомогательные шаги (статус доставки, reply, уведомления) — best-effort: их сбой логируется и не роняет основной поток.
- Схема БД меняется только новой SQL-миграцией `src/shared/db/migrations/NNNN_*.sql`, и только расширяющей — см. [docs/backend/migrations.md](docs/backend/migrations.md).

## Факты внешних API

Поведение MAX Bot API и REST Битрикс24 проверяйте по первоисточнику — [dev.max.ru](https://dev.max.ru/docs-api) и [apidocs.bitrix24.ru](https://apidocs.bitrix24.ru) (или MCP-сервер документации Б24) — либо живой пробой (`make probe-*`). В PR укажите источник или результат пробы.

## Коммиты и PR

- [Conventional commits](https://www.conventionalcommits.org/ru/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`; мелкие коммиты, тема — что и зачем.
- Изменилось поведение — обновите runbook функции в `docs/backend/` (файлы называются по функции, не по номеру версии) и README.
- Секреты — только в `.env`, никогда в коде, тестах, логах и issue.

Чек-лист PR:
- [ ] `pnpm test` зелёный, включая DB-тесты;
- [ ] новый код покрыт тестами (unit, а для маршрута — smoke);
- [ ] повтор вебхука не создаёт дубль, петли MAX ↔ Б24 нет;
- [ ] доки и `.env.example` обновлены, если менялись поведение или переменные.

## Уязвимости

Не открывайте публичный issue — см. [SECURITY.md](SECURITY.md).
