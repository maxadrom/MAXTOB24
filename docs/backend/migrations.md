[← Architecture](architecture.md) · [Назад к README](../../README.md) · [Environment →](env.md)

# Backend Migrations

Простой SQL-runner. Без `knex` / `umzug` — экономим зависимости, пока таблиц <10.

## Где лежат

- Runner: `backends/node/api/src/shared/db/runMigrations.js`
- Файлы: `backends/node/api/src/shared/db/migrations/*.sql`

## Имя файла

```
NNNN_<short_snake_name>.sql
```

- `NNNN` — четырёхзначный счётчик (`0001`, `0002`, …). Это `id` в `schema_migrations`.
- Имя — `snake_case`, кратко по предметной области (`0002_installations.sql`, `0005_message_log.sql`).
- Расширение строго `.sql`.

## Применённые миграции

| Файл | Что делает |
|------|-----------|
| `0001_schema_migrations.sql` | Таблица учёта применённых миграций |
| `0002_installations.sql` | Токены портала, `OL_LINE_ID`, `connector_id` |
| `0003_chat_bindings.sql` | Mapping `max_chat ↔ connector_chat` |
| `0004_participant_map.sql` | Привязка участников MAX-группы к отправителям OL |
| `0005_message_log.sql` | Журнал сообщений + идемпотентность (partial-unique индексы) |
| `0006_drop_company_id.sql` | Удаление неиспользуемого `company_id` из `chat_bindings` (CRM-привязку оператор делает вручную в UI OL) |
| `0007_add_b24_chat_id_to_chat_bindings.sql` | `b24_chat_id` — адрес OL-чата (`session.CHAT_ID`) для lifecycle-уведомлений вне активной сессии |
| `0008_installations_member_id.sql` | `b24_member_id` — идентификатор портала Б24 (из обмена `refresh_token`); сверка install-callback'а и `/webhook/b24` |
| `0009_drop_starter_tables.sql` | Удаление Doctrine-таблиц PHP-стартера (`bitrix24account`, `application_installation`) и расширения `uuid-ossp` |
| `0010_chat_bindings_ol_chat_title.sql` | `ol_chat_title` — название, поставленное в чат ОЛ (`imconnector.chat.name.set`, M24); бэкфилл `= max_chat_title` — старые чаты не переименовываются |
| `0011_chat_bindings_ol_session.sql` | `ol_session_id` / `ol_closed_session_id` (integer) — последняя известная сессия ОЛ и сессия, закрытая по `OnImConnectorDialogFinish` (опенер «группы», M25); без бэкфилла. С M27 флаг взводит и `CHAT_RENAMING_FAILED`, значение `0` — «закрыта, номер неизвестен» (без новой миграции) |
| `0012_chat_bindings_connector_not_null.sql` | `connector_chat_id` `NOT NULL` (M21): бэкфилл `'max:' \|\| max_chat_id` для привязок, оставшихся без него после сбоя двухшагового онбординга до M21 |
| `0013_installations_uninstalled_at.sql` | `installations.uninstalled_at` (timestamptz, nullable) — приложение Б24 удалено (`ONAPPUNINSTALL`, M26): закрывает `/webhook/b24` и онбординг, в т.ч. при env-fallback `B24_APPLICATION_TOKEN`; переустановка (`POST /api/install`) снимает. Без бэкфилла, аддитивная |

## Как запустить

```bash
# в контейнере
docker compose --profile node exec api-node pnpm db:migrate

# или на хосте (если есть pnpm и pg): DATABASE_URL — в env процесса
cd backends/node/api && DATABASE_URL=postgresql://appuser:apppass@localhost:5432/appdb pnpm db:migrate
```

На хосте runner с M26 сам читает корневой `.env`, а там `DATABASE_URL` с хостом `database`: это
имя сервиса в compose-сети, с хоста оно не резолвится. Значение из env процесса файл не
перебивает (`override: false`, см. [env.md](env.md#где-задавать-значения)).

Идемпотентно: повторный запуск логирует `no migrations to apply`.

**Прод** — `make deploy` (шаг `migrate`) и `make prod-up`/`make prod-migrate`: миграции идут в
one-off контейнере `compose run --rm` на новом образе, см. [vps-prod.md §4–5](../deploy/vps-prod.md).

## Миграция применяется до старта нового кода (M26)

Деплой применяет миграции **до** пересоздания `api`. Между шагами `migrate` и `up` прежний код
работает на новой схеме, а упавший `up` или откат образа оставляют его там надолго. Поэтому:

- **только расширяющие изменения:** новая nullable-колонка или колонка с `DEFAULT`, новая
  таблица, новый индекс. Прежний код их не замечает;
- **деструктивные — в два выката:** сначала код перестаёт читать и писать колонку или таблицу,
  следующим выкатом — миграция с `DROP`/`RENAME`/`NOT NULL`. `NOT NULL` на новую колонку, которую
  прежний код не заполняет, тоже ломает его `INSERT`;
- **бэкфилл** — в той же миграции, идемпотентно (`UPDATE … WHERE … IS NULL`).

## Параллельные прогоны: advisory lock (M26)

`runMigrations` держит сессионный `pg_advisory_lock(7262601)` (`MIGRATIONS_LOCK_KEY`) весь прогон —
от bootstrap `0001` и чтения `schema_migrations` до последней миграции. Второй прогон ждёт и
читает список применённых уже после первого, поэтому одна миграция не применяется дважды.

Зачем: после обрыва SSH на шаге `migrate` one-off контейнер `compose run --rm` дорабатывает без
клиента, и повторный `make deploy APPLY=1 FROM=migrate` или ручной `make prod-migrate` пошли бы
параллельно. Если лок занят, runner пишет `migrations lock busy — waiting for another run` и ждёт.
Лок отпускается в `finally`; если отпустить не удалось, соединение уничтожается (`release(true)`),
и лок снимается вместе с сеансом, а не уходит в пул.

## Откат

В M1 откатных миграций (down) **нет**. Если нужно откатить:

```bash
docker compose --profile db-postgres exec database-postgres \
    psql -U appuser -d appdb -c "DROP TABLE message_log CASCADE;"
docker compose --profile db-postgres exec database-postgres \
    psql -U appuser -d appdb -c "DELETE FROM schema_migrations WHERE id='0005_message_log';"
```

Лучшая практика — добавить новую миграцию `NNNN_revert_X.sql` с обратным изменением.

Откат образа на проде (`docker tag …:pre-<веха>` и `make deploy APPLY=1 FROM=up`,
[vps-prod.md §4](../deploy/vps-prod.md)) схему не откатывает: прежний код работает на новой
схеме, потому что миграции только расширяющие (см. выше).

## Особенности Postgres

### Partial-unique индексы

`CREATE TABLE ... UNIQUE (...) WHERE ...` Postgres **не поддерживает**. Делать отдельным statement:

```sql
CREATE UNIQUE INDEX message_log_inbound_dedup_idx
    ON message_log (binding_id, direction, max_mid)
    WHERE max_mid IS NOT NULL;
```

### `IF NOT EXISTS` для `CREATE DATABASE`

В Postgres нельзя сделать `CREATE DATABASE ... IF NOT EXISTS`. Перехватывайте ошибку `42P04` (database already exists), как сделано в `tests/globalSetup.js`.

## Наследие стартера удалено (M20)

До M20 Postgres-контейнер монтировал `infrastructure/database/init.sql` в `/docker-entrypoint-initdb.d/`. На пустом томе `postgres_data` он создавал Doctrine-таблицы PHP-стартера `bitrix24account` и `application_installation` и расширение `uuid-ossp`. Коннектор их не использовал.

В M20 монтирование снято, `init.sql` и `init-mysql.sql` удалены. Миграция `0009_drop_starter_tables` удаляет таблицы и расширение там, где они успели появиться (прод, старые dev-тома). На новых БД она ничего не делает (`IF EXISTS`). Схему БД теперь задают только миграции.

## Тестовая БД

Интеграционные тесты используют отдельную БД `appdb_test` в том же контейнере. `tests/globalSetup.js`:

1. подключается к default-БД (`postgres`);
2. `CREATE DATABASE appdb_test` (ловит `42P04`);
3. подключается к `appdb_test` и прогоняет миграции.

Между тестами (если нужно — на стороне теста) — `TRUNCATE ... RESTART IDENTITY CASCADE` через `tests/helpers/db.js:truncateAll(pool)`.

Защита рабочей БД: если в имени БД из `DATABASE_URL` нет `test`, `globalSetup` скипает DB-тесты, а `truncateAll` отказывается транкейтить. Это страхует от уже заданного `DATABASE_URL` (например `env_file` контейнера с `appdb`), который `dotenv` с `override:false` не перебивает.

## См. также

- [Architecture](architecture.md) — слои backend и владельцы таблиц
- [Environment](env.md) — `DATABASE_URL` и `DB_*` для подключения к Postgres
- [Membership Notifications](group-membership-notifications.md) — потребитель `b24_chat_id` из миграции 0007
