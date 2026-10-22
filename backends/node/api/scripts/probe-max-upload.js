#!/usr/bin/env node
// scripts/probe-max-upload.js — ad-hoc эмпирическая проверка MAX upload-флоу
// (M11.1: снять контракт заливки и задержку готовности вложения).
//
// Назначение: outbound-медиа (отправить файл в MAX) — 2-шаговый флоу, который
// ещё ни разу не звался вживую и публично не раскрыт по shape'ам:
//   (1) POST /uploads?type=image|video|audio|file → { url, token? }
//   (2) залить бинарь на выданный url (multipart) → ответ с token/photos
//   (3) POST /messages?chat_id=… + attachments:[{ type, payload:{ token } }]
// После upload файлу нужна обработка на стороне MAX → шаг (3) может вернуть
// «не готов» → нужен RETRY с растущей задержкой. Этот скрипт снимает:
//   - подтверждение 2-шагового флоу,
//   - домен(ы) выданного url по типам вложений,
//   - shape ответа upload (где лежит token: в /uploads или в ответе заливки),
//   - число retry и суммарную задержку обработки до готовности файла,
//   - поведение на лимитах/ошибках.
//
// Bootstrap БЕЗ DB (MAX stateless, зеркало probe-max-send): scripts/lib/bootstrap.js.
// /uploads и /messages — публичные maxClient.createUpload/sendMessage; заливка бинаря —
// сырым fetch: пробе нужны статус и сырое тело ответа (uploadBinary их прячет).
//
// Предусловия:
//   - MAX_BOT_TOKEN задан в .env;
//   - chat_id тестовой группы передаётся позиционным аргументом (обязательно).
//
// Запуск:
//   pnpm run probe-max-upload -- <chatId>                 — полный флоу (upload + send)
//   pnpm run probe-max-upload -- <chatId> --dry-run       — только upload, без POST /messages
//   pnpm run probe-max-upload -- <chatId> --type=file --file=./doc.pdf
//   pnpm run probe-max-upload -- --help
//   make probe-max-upload ARGS="<chatId> --dry-run"       — внутри docker-compose
//
// Гнать ТОЛЬКО против тестовой группы, где бот — участник (иначе MAX ответит 403
// chat.denied). Сообщение бота мост в OL не пересылает (эхо бота).
// Side-effect: в MAX-группу прилетит одно сообщение с вложением.

import process from 'node:process';

import { isInvokedDirectly } from '../src/shared/cli/isInvokedDirectly.js';
import { maxClientFor, runCli, scriptContext } from './lib/bootstrap.js';

// Поле формы для заливки бинаря на выданный upload-url. По конвенции MAX — `data`.
// ⚠️ Эмпирически: если MAX отвергнет, пробуем альтернативы (логируем имя поля).
const UPLOAD_FIELD_NAME = 'data';

// Тип вложения по умолчанию. MAX: image | video | audio | file.
const DEFAULT_TYPE = 'image';

// Встроенный тестовый PNG 1×1 (прозрачный) — чтобы скрипт был самодостаточным,
// когда --file не задан и --type=image. base64 декодируется в бинарь.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Retry-политика шага (3): MAX может вернуть «вложение не готово», пока идёт
// обработка загруженного файла. Снимаем, сколько ждать до готовности.
// M22: по умолчанию до ~2,5 мин ожидания готовности (большое видео); --attempts=N переопределяет.
const SEND_MAX_ATTEMPTS = 12;
const SEND_BASE_DELAY_MS = 1_000; // 1-я пауза; дальше экспоненциально, с потолком
const SEND_MAX_DELAY_MS = 15_000;

const HELP = `
probe-max-upload — пробует MAX upload-флоу (POST /uploads → залить бинарь → POST /messages с attachments)

Использование:
  pnpm run probe-max-upload -- <chatId> [опции]

Аргументы:
  <chatId>            Обязательный: chat_id тестовой группы MAX (обычно отрицательное число).

Опции:
  --type=<t>          Тип вложения: image|video|audio|file. По умолчанию ${DEFAULT_TYPE}.
  --file=<path>       Путь к файлу для заливки. Если не задан и type=image —
                      используется встроенный тестовый PNG 1×1.
  --dry-run           Выполнить upload (шаги 1-2), но НЕ слать POST /messages (шаг 3).
  --attempts=<n>      Попыток POST /messages (по умолчанию ${SEND_MAX_ATTEMPTS}).
  --help              Эта справка.

Цель: подтвердить 2-шаговый флоу, снять домен(ы) url, shape token,
число retry и задержку обработки файла. Все ответы MAX печатаются сырыми.

Side-effect: на успешном live-вызове (без --dry-run) в MAX-группу будет
отправлено сообщение с тестовым вложением.
`.trim();

function printSection(title) {
  // eslint-disable-next-line no-console
  console.log(`\n========== ${title} ==========`);
}

function printRaw(label, value) {
  // eslint-disable-next-line no-console
  console.log(`\n--- ${label} (raw) ---`);
  // eslint-disable-next-line no-console
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

// Достать домен из url для лаконичного лога (у разных типов вложений — разные домены).
function urlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '<неразбираемый url>';
  }
}

// Best-effort поиск upload-токена в произвольном shape ответа (publicly не раскрыт).
// MAX по типам кладёт token либо в ответ /uploads ({url, token}), либо в ответ
// заливки бинаря (для image — часто вложенный объект photos:{<key>:{token}}).
// Возвращаем { token, payload } — payload это то, что класть в attachments[].payload.
function extractAttachmentPayload({ uploadsResponse, putResponse, type }) {
  // 1) Прямой token из ответа /uploads (типично для file/video/audio).
  if (uploadsResponse && typeof uploadsResponse.token === 'string') {
    return { token: uploadsResponse.token, payload: { token: uploadsResponse.token }, source: 'uploads.token' };
  }
  // 2) Прямой token из ответа заливки.
  if (putResponse && typeof putResponse.token === 'string') {
    return { token: putResponse.token, payload: { token: putResponse.token }, source: 'put.token' };
  }
  // 3) image: вложенный photos:{<key>:{token}} — payload передаём как { photos }.
  if (type === 'image' && putResponse && putResponse.photos && typeof putResponse.photos === 'object') {
    const firstKey = Object.keys(putResponse.photos)[0];
    const tok = firstKey ? putResponse.photos[firstKey]?.token : undefined;
    return {
      token: tok ?? null,
      payload: { photos: putResponse.photos },
      source: 'put.photos',
    };
  }
  // 4) Ничего знакомого — отдаём null, печатаем сырьё выше по стеку.
  return { token: null, payload: null, source: 'unknown' };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Загрузить бинарь файла: либо из --file, либо встроенный тестовый PNG.
async function loadFileBytes({ filePath, type }) {
  if (filePath) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(filePath);
    const name = filePath.split(/[/\\]/).pop() || 'upload.bin';
    return { bytes: buf, filename: name, contentType: 'application/octet-stream' };
  }
  if (type === 'image') {
    return {
      bytes: Buffer.from(TINY_PNG_BASE64, 'base64'),
      filename: 'probe-1x1.png',
      contentType: 'image/png',
    };
  }
  throw new Error(
    `--file обязателен для type=${type} (встроенный тестовый файл есть только для type=image)`,
  );
}

export async function runScript({ argv = process.argv, deps = {} } = {}) {
  if (argv.includes('--help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return { ok: true, mode: 'help' };
  }

  const dryRun = argv.includes('--dry-run');
  const typeArg = argv.find((a) => a.startsWith('--type='));
  const fileArg = argv.find((a) => a.startsWith('--file='));
  const attemptsArg = argv.find((a) => a.startsWith('--attempts='));
  const maxAttempts = attemptsArg ? Number(attemptsArg.slice('--attempts='.length)) : SEND_MAX_ATTEMPTS;
  const type = typeArg ? typeArg.slice('--type='.length) : DEFAULT_TYPE;
  const filePath = fileArg ? fileArg.slice('--file='.length) : null;

  const positional = argv.slice(2).filter((a) => !a.startsWith('--'));
  const chatId = positional[0] ?? null;
  if (chatId === null || String(chatId).trim() === '') {
    throw new Error(
      'chat_id is required — pass it as a positional argument: pnpm run probe-max-upload -- <chatId>',
    );
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`--attempts must be a positive integer (got: ${attemptsArg})`);
  }
  if (!['image', 'video', 'audio', 'file'].includes(type)) {
    throw new Error(`--type must be one of image|video|audio|file (got: ${type})`);
  }

  const ctx = scriptContext('probe-max-upload', deps);
  const { logger } = ctx;

  const { botToken } = ctx.config.max;
  if (!botToken) {
    throw new Error('MAX_BOT_TOKEN is not set in .env');
  }

  const fetchImpl = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  const maxClient = maxClientFor(ctx, deps);

  logger.debug({ chatId, type, filePath: filePath ?? '<builtin>', dryRun }, 'probe-max-upload: start');

  // ── Шаг 0: подготовить бинарь ──────────────────────────────────────────────
  const { bytes, filename, contentType } = await loadFileBytes({ filePath, type });
  printSection(`Файл к заливке [type=${type}]`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ filename, contentType, sizeBytes: bytes.length }, null, 2));

  // ── Шаг 1: POST /uploads?type=… → { url, token? } ─────────────────────────
  printSection(`Шаг 1 — POST /uploads?type=${type}`);
  let uploadsResponse;
  try {
    uploadsResponse = await maxClient.createUpload(type);
  } catch (err) {
    printSection('BLOCKED — POST /uploads провалился');
    // eslint-disable-next-line no-console
    console.error(`message: ${err?.message ?? String(err)}`);
    return { ok: false, step: 'uploads', error: err?.message ?? String(err) };
  }
  printRaw('Ответ /uploads', uploadsResponse);
  const uploadUrl = uploadsResponse?.url;
  if (!uploadUrl || typeof uploadUrl !== 'string') {
    printSection('BLOCKED — в ответе /uploads нет поля url');
    return { ok: false, step: 'uploads', uploadsResponse, error: 'no url in /uploads response' };
  }
  logger.debug({ uploadHost: urlHost(uploadUrl), hasTopLevelToken: typeof uploadsResponse?.token === 'string' },
    'probe-max-upload: /uploads ok');
  // eslint-disable-next-line no-console
  console.log(`\nupload url host: ${urlHost(uploadUrl)}`);

  // ── Шаг 2: залить бинарь на выданный url (multipart) ───────────────────────
  printSection('Шаг 2 — залить бинарь (multipart) на выданный url');
  const form = new FormData();
  const blob = new Blob([bytes], { type: contentType });
  form.append(UPLOAD_FIELD_NAME, blob, filename);
  // ВАЖНО: на upload-url НЕ шлём Authorization — url сам несёт авторизацию.
  let putResponse = null;
  let putStatus = null;
  let putRawText = '';
  const putStartedAt = Date.now();
  try {
    const resp = await fetchImpl(uploadUrl, { method: 'POST', body: form });
    putStatus = resp.status;
    putRawText = await resp.text();
    try {
      putResponse = putRawText ? JSON.parse(putRawText) : null;
    } catch {
      putResponse = null; // оставляем как текст
    }
  } catch (err) {
    printSection('BLOCKED — заливка бинаря на upload-url провалилась');
    // eslint-disable-next-line no-console
    console.error(`message: ${err?.message ?? String(err)}`);
    return { ok: false, step: 'put', uploadsResponse, error: err?.message ?? String(err) };
  }
  const putDurationMs = Date.now() - putStartedAt;
  // M22: скорость заливки — для дедлайна MEDIA_TRANSFER_TIMEOUT_MS.
  const putMbPerSec = putDurationMs > 0 ? (bytes.length / 1e6 / (putDurationMs / 1000)).toFixed(2) : 'n/a';
  // eslint-disable-next-line no-console
  console.log(
    `\nupload status: ${putStatus}, длительность: ${putDurationMs}ms (${putMbPerSec} МБ/с), поле формы: "${UPLOAD_FIELD_NAME}"`,
  );
  printRaw('Ответ заливки', putResponse ?? putRawText);
  logger.debug({ putStatus, putDurationMs }, 'probe-max-upload: binary upload done');

  // ── Собрать attachments[].payload из доступных shape'ов ────────────────────
  const { token, payload, source } = extractAttachmentPayload({ uploadsResponse, putResponse, type });
  printSection('Извлечённый attachment payload');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ source, hasToken: Boolean(token), payload }, null, 2));

  if (dryRun) {
    printSection('--dry-run: пропускаем POST /messages (шаг 3)');
    return {
      ok: true,
      mode: 'dry-run',
      type,
      uploadHost: urlHost(uploadUrl),
      uploadsResponse,
      putResponse: putResponse ?? putRawText,
      payload,
      tokenSource: source,
    };
  }

  if (!payload) {
    printSection('BLOCKED — не удалось собрать payload для attachments (shape незнаком)');
    // eslint-disable-next-line no-console
    console.error('Сырьё выше (Ответ /uploads + Ответ заливки) — разобрать вручную и поправить extractAttachmentPayload.');
    return {
      ok: false,
      step: 'payload',
      uploadsResponse,
      putResponse: putResponse ?? putRawText,
      error: 'cannot build attachment payload',
    };
  }

  // ── Шаг 3: POST /messages с attachments + RETRY (задержка обработки файла) ──
  printSection(`Шаг 3 — POST /messages?chat_id=${chatId} (attachments, до ${maxAttempts} попыток)`);
  const messageBody = { attachments: [{ type, payload }] };
  printRaw('Тело /messages', { query: { chat_id: chatId }, body: messageBody });

  const sendStartedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await maxClient.sendMessage({ chatId, text: '', ...messageBody });
      const totalDelayMs = Date.now() - sendStartedAt;
      printSection(`OK — отправлено с ${attempt}-й попытки (суммарная задержка ${totalDelayMs}ms)`);
      printRaw('Ответ /messages', response);
      // eslint-disable-next-line no-console
      console.log(
        `\nЗадержка обработки: retry=${attempt - 1}, totalDelayMs=${totalDelayMs}, uploadHost=${urlHost(uploadUrl)}`,
      );
      return {
        ok: true,
        mode: 'sent',
        type,
        attempts: attempt,
        retries: attempt - 1,
        totalDelayMs,
        uploadHost: urlHost(uploadUrl),
        tokenSource: source,
        uploadsResponse,
        putResponse: putResponse ?? putRawText,
        response,
      };
    } catch (err) {
      lastError = err?.message ?? String(err);
      const delay = Math.min(SEND_BASE_DELAY_MS * 2 ** (attempt - 1), SEND_MAX_DELAY_MS);
      // M22: HTTP-статус и code ошибки — для классификации ретраев (MaxApiError).
      const httpStatus = err?.httpStatus ?? null;
      const maxCode = err?.maxCode ?? null;
      const elapsedMs = Date.now() - sendStartedAt;
      // eslint-disable-next-line no-console
      console.log(
        `попытка ${attempt}/${maxAttempts} не прошла (+${elapsedMs}ms): httpStatus=${httpStatus} maxCode=${maxCode} — ${lastError} → пауза ${delay}ms`,
      );
      logger.debug({ attempt, delay, httpStatus, maxCode, err: lastError }, 'probe-max-upload: send retry');
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
      }
    }
  }

  const totalDelayMs = Date.now() - sendStartedAt;
  printSection(`BLOCKED — /messages не прошёл за ${maxAttempts} попыток (${totalDelayMs}ms)`);
  // eslint-disable-next-line no-console
  console.error(`последняя ошибка: ${lastError}`);
  return {
    ok: false,
    step: 'messages',
    type,
    attempts: attempt,
    totalDelayMs,
    uploadHost: urlHost(uploadUrl),
    uploadsResponse,
    putResponse: putResponse ?? putRawText,
    error: lastError,
  };
}

if (isInvokedDirectly(import.meta.url)) runCli('probe-max-upload', runScript, { notOkExitCode: 2 });
