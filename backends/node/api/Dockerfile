# Dev stage
FROM node:24-slim AS dev
RUN apt-get update && apt-get install -y openssl
WORKDIR /app
# M20: корень Минцифры (Russian Trusted Root CA) — его требует MAX API platform-api2.max.ru.
# Node читает переменную только на старте процесса; PEM — certs/ (dev: bind-mount, prod: COPY).
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem
RUN corepack enable
# Note: Code will be mounted as volume in dev mode
# No COPY . ./ here to avoid overwriting mounted volume
EXPOSE 8000
CMD ["sh", "-c", "pnpm install --frozen-lockfile \
  && pnpm run dev"]

# Production stage
FROM node:24-alpine AS production
RUN apk add --no-cache openssl
WORKDIR /app
# corepack (pnpm по packageManager) нужен только сборке — `pnpm install` ниже; рантайм его не зовёт.
RUN corepack enable
# Security M13: --prod ставит ТОЛЬКО runtime-зависимости (без devDeps: vitest/
# supertest/nodemon/pino-pretty и их уязвимого тулинга). Это устраняет devDeps-tooling
# high из прод-образа. Слой кэшируется по lock+manifest.
COPY .npmrc package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . ./
# M20: корень Минцифры (Russian Trusted Root CA) — его требует MAX API platform-api2.max.ru.
# Node читает переменную только на старте процесса; PEM — certs/ (dev: bind-mount, prod: COPY).
# M30: ENV — после COPY: объявленный раньше, он доставался `pnpm install` выше, когда PEM в
# образе ещё нет, и сборка печатала «Warning: Ignoring extra certs». Рантайм это не меняет.
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem
# Непривилегированный пользователь (образ node:* несёт готового `node`, uid 1000).
# /app и pnpm-store отдаём ему во владение, иначе runtime-запись (логи и пр.) упадёт.
RUN chown -R node:node /app
USER node
EXPOSE 8000
# M26: node напрямую, без pnpm. Под USER node corepack не видит pnpm, скачанный под root при
# сборке, и тянул его из registry.npmjs.org на каждом старте контейнера (первая строка лога
# прод-api; старт 6,1 с против 0,95 с, замер M29). PID 1 = node: обработчики SIGTERM/SIGINT —
# в server.js, дочерних процессов нет, поэтому init не нужен.
CMD ["node", "server.js"]
