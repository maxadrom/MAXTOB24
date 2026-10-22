[← Webhooks](webhooks.md) · [Назад к README](../../README.md) · [Connector Registration →](connector-registration.md)

# Установка приложения (install-callback `POST /api/install`)

Приложение Б24 работает в режиме «Только API»: UI внутри Б24 нет. OAuth-токены портала и
`application_token` (им подписаны все события Б24) приходят server-to-server: Б24 шлёт
событие `ONAPPINSTALL` на «Путь для первоначальной установки» при установке и **при каждом
обновлении** приложения (для приложения без UI). Как заполнить форму приложения на
портале — [vps-prod.md](../deploy/vps-prod.md), §7.

Маршрут публичный, поэтому бэкенд не верит payload на слово.

## Как проверяется подлинность

Payload `ONAPPINSTALL` (`application/x-www-form-urlencoded`, ключи вида `auth[domain]`):
`auth.domain`, `auth.member_id`, `auth.application_token` и — если событие привязано к
пользователю — `auth.access_token` / `auth.refresh_token`.

1. **Конфиг.** Нужны `B24_PORTAL`, `B24_CLIENT_ID`, `B24_CLIENT_SECRET`. Без них — `503`
   (fail-closed): проверить установку нечем.
2. **Форма.** `event` — `ONAPPINSTALL` или `ONAPPUPDATE`; все поля `auth` — строки
   (повторённый ключ превращается в массив → `400`); токены — только из `[A-Za-z0-9._-]`.
3. **Портал.** `auth.domain` (без учёта регистра и конечной точки) должен совпасть с
   `B24_PORTAL`, иначе `401`. Строка `installations` другого портала — мисконфиг, `503`.
4. **Приложение.** `refresh_token` из payload обменивается на OAuth-сервере Б24
   (`https://oauth.bitrix.info/oauth/token/`) с нашими `B24_CLIENT_ID/SECRET`. Обмен удаётся
   только для пары, выданной **нашему** приложению; хост `client_endpoint` из ответа должен
   совпасть с `B24_PORTAL`, `member_id` ответа — с payload и с сохранённым. `refresh_token`
   одноразовый, поэтому повторённый или перехваченный payload не срабатывает.
5. **Запись.** В строку single-tenant (её читают `/webhook/b24` и клиент Б24) одной записью
   уходят **новая** пара access/refresh из ответа обмена и `application_token` из payload.
   `member_id` пишется отдельно.

Если в событии только `application_token` (Б24 не привязал событие к пользователю),
подтвердить новый токен нечем: совпал с сохранённым → `200` без изменений, иначе `401`.

## Ответы

| Ответ | Когда |
|---|---|
| `200 {"message":"All success","installation":{id,portal}}` | токены проверены и сохранены; или только `application_token`, совпавший с сохранённым |
| `400 VALIDATION_ERROR` | не то событие, нет `auth`/`auth.domain`, поле-массив, мусор в токене, нет токенов, неполная комбинация (`refresh_token` без `application_token` и т.п.) |
| `401 UNAUTHORIZED` | чужой домен; OAuth отверг `refresh_token` (`invalid_grant` — чужая или уже потраченная пара); `client_endpoint` другого портала; `member_id` не совпал; одиночный `application_token` не совпал с сохранённым |
| `503 CONFIG_ERROR` | нет `B24_PORTAL`/`B24_CLIENT_ID`/`B24_CLIENT_SECRET`; OAuth не принял наши client creds (`invalid_client`); в БД строка другого портала |
| `503 INSTALL_VERIFY_UNAVAILABLE` | OAuth-сервер недоступен (сеть, таймаут, 5xx, 429, `QUERY_LIMIT_EXCEEDED`) или ответил без нужных полей |
| `429 RATE_LIMITED` | строгий лимит маршрута (`RATE_LIMIT_INSTALL_*`) |

Б24 событие не повторяет. После `401`/`503` на настоящую установку — устранить причину и
**пересохранить форму приложения** (придёт новый `ONAPPINSTALL`).

## Первая установка на новом стенде

`client_id`/`client_secret` Б24 показывает только после сохранения формы, а первый
`ONAPPINSTALL` уходит сразу — он получит `503` (creds ещё не заданы). Порядок:

1. Заполнить форму приложения (см. vps-prod §7) → **Сохранить** → скопировать
   `client_id`/`client_secret`.
2. Прописать `B24_CLIENT_ID`/`B24_CLIENT_SECRET` в `.env` →
   `docker compose --profile node up -d --force-recreate api-node` (`restart` env не перечитывает).
3. Пересохранить форму → `POST /api/install → 200`.

## Проверка

```bash
# строка установки: токены, member_id и пометка удаления (M26). psql — внутри контейнера БД:
# хост `database` из DATABASE_URL виден только в compose-сети (на VPS — из каталога стека)
docker compose exec -T database-postgres psql -U appuser -d appdb -c "select id, b24_portal, updated_at,
  uninstalled_at, b24_member_id is not null as has_member, b24_application_token is not null as app_tok,
  b24_access_token is not null as access, b24_refresh_token is not null as refresh from installations"
```

В логах api-node (секреты не логируются):
- `install request received` (`event`, `has*`-флаги) — пришёл запрос на `/api/install`.
  OAuth-рефреш его больше **не** пишет: каждая такая строка — настоящий запрос.
- `install verified: tokens saved` (`firstInstall`, `reinstalled`, `applicationTokenChanged`) —
  успех; `reinstalled: true` — установка после удаления приложения (M26).
- `install rejected: …` (warn) — отказ с причиной; `install: … OAuth …` (error) — `503`.

Негативные пробы (ни одна не должна менять строку `installations`):

```bash
U=https://<домен>/api/install
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U" -d ''                                      # 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U" \
  -d 'event=ONAPPINSTALL&auth[domain]=<портал>&auth[application_token]=0000000000000000'         # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U" \
  -d 'event=ONAPPINSTALL&auth[domain]=<портал>&auth[refresh_token]=0000000000000000&auth[application_token]=0000000000000000'  # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U" \
  -d 'event=ONAPPINSTALL&auth[domain]=evil.example&auth[refresh_token]=0000000000000000&auth[application_token]=0000000000000000'  # 401
```

## Удаление и переустановка (M26)

### Что происходит при удалении

Б24 шлёт `ONAPPUNINSTALL` (form-urlencoded) на обработчик, подписанный через `event.bind`, —
`/webhook/b24`. На URL установки Б24 сам это событие не регистрирует: подписку делает
`make register-events` (пятое событие, см. [vps-prod.md](../deploy/vps-prod.md) §8).

1. Обычные проверки `/webhook/b24`: `auth.application_token` (БД > env) и `auth.member_id`.
   Подделка → `401`, строка не меняется. Подписать `ONAPPUNINSTALL` на наш URL может и другое
   приложение портала, но его событие несёт **свой** `application_token` → `401`.
2. `installations`: `access`/`refresh`/`application_token` → `NULL` при любом `CLEAN`, ставится
   `uninstalled_at` (повтор его не сдвигает). `b24_portal`, `b24_member_id`, `connector_id`,
   `ol_line_id` остаются: `member_id` сверяет переустановку, строку держат привязки.
   Запись условная — compare-and-swap по `application_token` события (как OAuth-рефреш по
   `refresh_token`): если между проверкой токена и записью install-callback нового приложения
   успел записать свою тройку, удаление не применяется — ни токены, ни данные моста не трогаются,
   ответ `200 {"ok":true,"result":{"skipped":"stale-uninstall","installationId":…}}`.
3. `data.CLEAN = 1` («Очистить данные приложения»; **у локального приложения — всегда**) →
   удаляются привязки установки, `participant_map` и `message_log` уходят каскадом (FK
   `ON DELETE CASCADE`). Заодно уходят ПДн: имена участников и начала текстов в `payload_meta`.
   `CLEAN = 0` — данные остаются.
4. Ответ `200 {"ok":true,"result":{"ok":true,"clean":…,"installationId":…,"purged":{"bindings":N}}}`
   (`purged` — только при `CLEAN=1`). В `message_log` событие не пишется: внешнего эффекта нет.

Путь в коде — через координатор `messaging/`, владельца журнала: `b24Service.handleAppUninstall` →
`installationsService.markUninstalled` → при `CLEAN=1` `messagingService.purgeBridgeData` →
`bindingsService.purgeAll`.

**После удаления:**
- `/webhook/b24` на **любое** событие отвечает `503 B24_APP_UNINSTALLED` ещё до проверки токена;
  env-fallback `B24_APPLICATION_TOKEN` не действует. Б24 после удаления сюда событий не шлёт
  (подписки сняты);
- входящие из MAX: новая группа (а при `CLEAN=1` все группы новые) → `503 CONFIG_ERROR`,
  привязка не создаётся; старая привязка (`CLEAN=0`) → `502 B24_NO_AUTH`. MAX ретраит с паузами
  60 → 150 → 375 с (× 2,5), а после 8 ч без успешного ответа сам отписывает вебхук. Последний
  ретрай в этом окне — через ≈6,8 ч, поэтому после переустановки дойдут сообщения не старше
  ≈6,8 ч (дока MAX `POST /subscriptions`, 2026-10-09); старшие потеряны;
- скрипты, которым нужна установка Б24 (`register-connector`, `register-events`,
  `probe-imconnector-send`), падают с `Bitrix24 app was uninstalled at <ts> — reinstall it …`.

Цена очистки — журнал и привязки после переустановки пустые:
- на первом сообщении каждой группы привязка создаётся заново, и в её старый чат ОЛ повторно
  уходят интро группы (M24) и системное сообщение со ссылкой на группу (M27): записи
  `group-link:` ушли каскадом;
- правка и удаление старых сообщений в MAX (MAX → ОЛ) дают `no-original`: записи оригинала нет;
- правка и удаление старых сообщений в ОЛ (ОЛ → MAX) берут id сообщения MAX из события Б24 и
  проходят. Без id в событии — `no-maxmid`: удаление молча пропускается, правка — с оповещением
  оператора «исходное сообщение не найдено в MAX» (M28);
- ответ оператора на старое сообщение получает ссылку на него по `CONNECTOR_MID` родителя в Б24;
  без него (запасной путь по журналу) ответ уходит в MAX без ссылки. Цитата в ответе клиента
  (MAX → ОЛ) строится из события MAX и от журнала не зависит.

### Переустановка

«Переустановить» в Б24 приложение **не удаляет** (live M19: `application_token` тот же, подписки
целы) — это обычный `ONAPPINSTALL`. После настоящего удаления локальное приложение создаётся
заново, с **новыми** `client_id`/`client_secret`. Перед первой переустановкой после M26 —
`make prod-db-backup`.

1. Создать новое локальное приложение с теми же настройками ([vps-prod.md](../deploy/vps-prod.md)
   §7): «Только API», путь установки `/api/install`, те же права (scope).
2. Новые `client_id`/`client_secret` → prod-`.env` → пересоздать `api` на VPS (`restart` env не
   перечитывает; prod-compose — с профилями и обоими файлами, как в `make deploy`):
   ```bash
   COMPOSE_PROFILES=node,db-postgres BUILD_TARGET=production docker compose \
     -f docker-compose.yml -f docker-compose.server.yml up -d --no-deps --no-build --force-recreate api-node
   ```
   Затем с локали — `make pull-prod-env` (бэкап нового `.env`).
3. Пересохранить форму. `ONAPPINSTALL` проходит обмен `refresh_token`, токены пишутся в ту же
   строку, `uninstalled_at` снимается (лог `install verified: tokens saved`, `reinstalled: true`).
   До этого шага env-fallback не поможет: гейт `uninstalled_at` стоит раньше него.
4. `make register-connector`, `make register-events`, `make register-webhook ARGS="--list"`.
   Повторная подписка MAX — только с согласия: бот общий с продом. Ретраи MAX, пришедшие между
   шагами 3 и 4, падают на отправке в Б24 (коннектор ещё не зарегистрирован) и повторяются.

Не проверено live (тестового портала нет): переиспользует ли Б24 старые чаты ОЛ после
переустановки и `register-connector` с тем же `max_b24` и линией.

### Логи

- `b24 app uninstall received` (`clean`, `languageId`) → `app uninstalled: tokens cleared`
  (`installationId`, `alreadyUninstalled`) → при `CLEAN=1` `bindings purged (app uninstall)` и
  `app uninstall: bridge data purged` (`bindings`), при `CLEAN=0` —
  `app uninstalled: CLEAN=0, bridge data kept`.
- error `app uninstall: tokens cleared, bridge data NOT purged — see app-installation.md` —
  очистка упала после сброса токенов (ответ `500`, Б24 не повторит) → ручная очистка ниже.
- warn `b24 webhook rejected: app uninstalled — reinstall the Bitrix24 app` — событие пришло
  после удаления (`503 B24_APP_UNINSTALLED`).
- warn `app uninstall not applied: installation changed concurrently (reinstalled or removed) —
  tokens kept` — `ONAPPUNINSTALL` старого приложения разминулся с переустановкой (ответ
  `skipped: 'stale-uninstall'`): новая установка цела, делать ничего не нужно.

### Проверки и ручная очистка

Все команды — на VPS из каталога стека, `psql` внутри контейнера БД (как негативная проба ниже):
хост `database` из `DATABASE_URL` снаружи compose-сети не резолвится.

```bash
# пометка и остаток данных моста
docker compose exec -T database-postgres psql -U appuser -d appdb -c "select id, uninstalled_at,
  b24_member_id is not null as has_member, b24_application_token is not null as app_tok from installations"
docker compose exec -T database-postgres psql -U appuser -d appdb -c "select count(*) as bindings from chat_bindings"
```

Привязки после удаления с `CLEAN=1` остаются в двух случаях: очистка упала после сброса
токенов (error-лог выше) или входящее MAX, прочитавшее установку до удаления, создало привязку
уже после очистки (гонка, строка без журнала). Лечение — тот же `DELETE`, что делает код
(участники и журнал — каскадом), только для помеченной строки:

```bash
# перед этим — make prod-db-backup
docker compose exec -T database-postgres psql -U appuser -d appdb -c "DELETE FROM chat_bindings b
  USING installations i WHERE b.installation_id = i.id AND i.uninstalled_at IS NOT NULL"
```

Негативная проба (на VPS, после `make register-events`): поддельный `ONAPPUNINSTALL` не меняет
строку.

```bash
Q="select md5(concat(b24_access_token, b24_refresh_token, b24_application_token)), updated_at from installations"
docker compose exec -T database-postgres psql -U appuser -d appdb -c "$Q"
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<домен>/webhook/b24 \
  -d 'event=ONAPPUNINSTALL&data[CLEAN]=1&auth[application_token]=0000000000000000&auth[member_id]=<member_id>'  # 401
docker compose exec -T database-postgres psql -U appuser -d appdb -c "$Q"   # то же, что до curl
```

## Связанное

- **OAuth-рефреш.** На `expired_token` клиент Б24 обменивает сохранённый `refresh_token`
  тем же кодом (`b24/b24OAuth.js`) и пишет пару compare-and-swap по старому
  `refresh_token`: более свежую пару из install-callback'а или процесса скрипта не затирает.
  `member_id` из ответа рефреша заполняет колонку на уже установленных порталах.
- **`/webhook/b24`.** После `application_token` сверяется `auth.member_id` с сохранённым
  (`401 B24_MEMBER_MISMATCH`), см. [webhooks.md](webhooks.md), «Application token для Б24».
- **Удаление приложения** (`ONAPPUNINSTALL`, M26) — раздел «Удаление и переустановка» выше;
  гейт `503 B24_APP_UNINSTALLED` — [webhooks.md](webhooks.md), «Application token для Б24».
