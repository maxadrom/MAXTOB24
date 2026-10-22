#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="$ROOT_DIR/reports/security"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_BIN="docker compose"

ALLOW_FAILURES=0
if [[ "${1:-}" == "--allow-fail" ]]; then
  ALLOW_FAILURES=1
  shift
fi

if [[ "${SECURITY_SCAN_ALLOW_FAILURES:-0}" == "1" ]]; then
  ALLOW_FAILURES=1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Не найден файл .env. Создайте его: cp .env.example .env."
  exit 1
fi

mkdir -p "$REPORT_DIR"

FAILED_STEPS=()

run_step() {
  local name="$1"
  local command="$2"

  echo "▶ $name"
  if eval "$command"; then
    echo "✔ $name завершён"
  else
    local exit_code=$?
    echo "✖ $name завершился с ошибкой (код $exit_code)"
    FAILED_STEPS+=("$name")
  fi
  echo ""
}

skip_step() {
  local name="$1"
  local reason="$2"
  echo "⏭ $name — пропущен: $reason"
  echo ""
}

NODE_DIR="$ROOT_DIR/backends/node/api"
if [[ -d "$NODE_DIR" && -f "$NODE_DIR/package.json" ]]; then
  run_step \
    "Node.js pnpm audit" \
    "COMPOSE_PROFILES=node $COMPOSE_BIN --env-file \"$ENV_FILE\" run --rm --workdir /app api-node \
      sh -c 'pnpm audit --prod --json' \
      | tee \"$REPORT_DIR/node-pnpm.json\""
else
  skip_step "Node.js pnpm audit" "нет каталога backends/node/api"
fi

if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
  echo "⚠ Найдены проблемы на этапах: ${FAILED_STEPS[*]}"
  if [[ "$ALLOW_FAILURES" == "1" ]]; then
    echo "ℹ️ Включён мягкий режим (allow-fail), скрипт завершается с кодом 0."
  else
    echo "ℹ️ Чтобы проигнорировать код выхода, выполните SECURITY_SCAN_ALLOW_FAILURES=1 make security-scan или ./scripts/security-scan.sh --allow-fail."
    exit 2
  fi
fi

echo "✅ Security-scan завершён; отчёты сохранены в $REPORT_DIR"

