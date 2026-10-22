// Unit-тесты M11.2 MaxService.uploadAndSend — оркестрация upload-флоу с
// readiness-retry ТОЛЬКО на шаге POST /messages (MAX готовит вложение не сразу) и только на
// attachment.not.ready / 429 (M22). Мокаем maxClient.
// Ключевая проверка: при ретрае шага 3 файл НЕ перезаливается (createUpload/
// uploadBinary зовутся ровно один раз).

import { describe, expect, it, vi } from 'vitest';

import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { MaxClient } from '../../src/modules/max/maxClient.js';
import { isMediaRejectedError, MaxService, maxUploadTypeForFile } from '../../src/modules/max/maxService.js';

function silentLogger() {
  const make = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => make(),
  });
  return make();
}

function fakeClient(overrides = {}) {
  return {
    createUpload: vi.fn(async () => ({ url: 'https://fd.oneme.ru/upload?sig=x' })),
    uploadBinary: vi.fn(async () => ({ token: 'tok-abc' })),
    // Новая сигнатура: (type, { uploadsResponse, uploadResult }).
    buildAttachmentPayload: vi.fn((type, { uploadsResponse, uploadResult } = {}) => ({
      token: uploadResult?.token ?? uploadsResponse?.token,
    })),
    sendMessage: vi.fn(async () => ({ message: { body: { mid: 'mid.OUT' }, timestamp: 1748432100000 } })),
    ...overrides,
  };
}

// Быстрые ретраи в тестах (baseMs=1) — без реальных секундных пауз.
function buildService(client) {
  return new MaxService({
    maxClient: client,
    logger: silentLogger(),
    uploadRetry: { maxRetries: 3, baseMs: 1, factor: 2 },
  });
}

describe('MaxService.uploadAndSend (M11.2)', () => {
  it('1) happy path: createUpload+uploadBinary по разу, sendMessage с attachments', async () => {
    const client = fakeClient();
    const service = buildService(client);

    const res = await service.uploadAndSend({
      chatId: -100,
      file: { path: '/tmp/m22/d.part', filename: 'd.pdf', contentType: 'application/pdf' },
      type: 'file',
      text: '',
    });

    expect(client.createUpload).toHaveBeenCalledTimes(1);
    expect(client.createUpload).toHaveBeenCalledWith('file');
    expect(client.uploadBinary).toHaveBeenCalledTimes(1);
    // M22: заливается временный файл координатора (поток с диска), не буфер.
    expect(client.uploadBinary).toHaveBeenCalledWith('https://fd.oneme.ru/upload?sig=x', {
      path: '/tmp/m22/d.part', filename: 'd.pdf', contentType: 'application/pdf',
    });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const sent = client.sendMessage.mock.calls[0][0];
    expect(sent.chatId).toBe(-100);
    expect(sent.attachments).toEqual([{ type: 'file', payload: { token: 'tok-abc' } }]);
    // M28: + фактический тип в MAX.
    expect(res).toEqual({ maxMid: 'mid.OUT', timestampMs: 1748432100000, type: 'file' });
  });

  it('1b) подпись с format: format прокидывается в sendMessage (рендер жирного)', async () => {
    const client = fakeClient();
    const service = buildService(client);

    await service.uploadAndSend({
      chatId: -100,
      file: { path: '/tmp/m22/p.part' },
      type: 'image',
      text: '**Иван:**\nфото',
      format: 'markdown',
    });

    const sent = client.sendMessage.mock.calls[0][0];
    expect(sent.text).toBe('**Иван:**\nфото');
    expect(sent.format).toBe('markdown');
  });

  it('1c) video: payload собирается из ответа /uploads (uploads.token)', async () => {
    // createUpload отдаёт { url, token }; заливка видео — пустой результат (null).
    const client = fakeClient({
      createUpload: vi.fn(async () => ({ url: 'https://vu.okcdn.ru/upload.do?sig=x', token: 'VID' })),
      uploadBinary: vi.fn(async () => null),
    });
    const service = buildService(client);

    await service.uploadAndSend({
      chatId: -100,
      file: { path: '/tmp/m22/v.part', filename: 'clip.mp4', contentType: 'video/mp4' },
      type: 'video',
    });

    const [, payloadArgs] = client.buildAttachmentPayload.mock.calls[0];
    expect(payloadArgs.uploadsResponse).toEqual({
      url: 'https://vu.okcdn.ru/upload.do?sig=x',
      token: 'VID',
    });
    const sent = client.sendMessage.mock.calls[0][0];
    expect(sent.attachments).toEqual([{ type: 'video', payload: { token: 'VID' } }]);
  });

  // M22: ошибки как их бросает maxClient (live 2026-10-08).
  const notReady = () => new MaxApiError('HTTP 400 — Key: errors.process.attachment.file.not.processed', {
    httpStatus: 400, maxCode: 'attachment.not.ready',
  });

  it('2) attachment.not.ready → ретрай, файл НЕ перезаливается', async () => {
    let calls = 0;
    const client = fakeClient({
      sendMessage: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw notReady();
        return { message: { body: { mid: 'mid.RETRY' } } };
      }),
    });
    const service = buildService(client);

    const res = await service.uploadAndSend({ chatId: -100, file: { path: '/tmp/x' }, type: 'image' });

    // upload не повторялся — токен переиспользован.
    expect(client.createUpload).toHaveBeenCalledTimes(1);
    expect(client.uploadBinary).toHaveBeenCalledTimes(1);
    // sendMessage был вызван дважды (1 фейл + 1 успех).
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ maxMid: 'mid.RETRY', timestampMs: null, type: 'image' });
  });

  it('2a) M22: 429 → ретрай', async () => {
    const client = fakeClient({
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new MaxApiError('HTTP 429', { httpStatus: 429 }))
        .mockResolvedValueOnce({ message: { body: { mid: 'mid.429' } } }),
    });
    const res = await buildService(client).uploadAndSend({ chatId: -100, file: { path: '/tmp/x' }, type: 'file' });
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(res.maxMid).toBe('mid.429');
  });

  it.each([
    ['403 chat.denied (бот не в чате)', new MaxApiError('HTTP 403 — Chat closed', { httpStatus: 403, maxCode: 'chat.denied' })],
    ['таймаут (сообщение могло уйти — повтор дал бы дубль)', new MaxApiError('timed out', { kind: 'timeout' })],
    ['сеть', new MaxApiError('network error', { kind: 'network' })],
    ['500', new MaxApiError('HTTP 500', { httpStatus: 500 })],
    ['не MaxApiError', new Error('boom')],
  ])('2b) M22: %s → одна попытка, ошибка наверх', async (_label, error) => {
    const client = fakeClient({ sendMessage: vi.fn(async () => { throw error; }) });
    await expect(
      buildService(client).uploadAndSend({ chatId: -100, file: { path: '/tmp/x' }, type: 'file' }),
    ).rejects.toBe(error);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('3) все попытки — not.ready → throw после maxRetries, upload по разу', async () => {
    const client = fakeClient({
      sendMessage: vi.fn(async () => {
        throw notReady();
      }),
    });
    const service = buildService(client);

    await expect(
      service.uploadAndSend({ chatId: -100, file: { path: '/tmp/x' }, type: 'file' }),
    ).rejects.toMatchObject({ maxCode: 'attachment.not.ready' });

    expect(client.createUpload).toHaveBeenCalledTimes(1);
    expect(client.uploadBinary).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(3); // maxRetries
  });

  it('4) /uploads без url → throw до заливки', async () => {
    const client = fakeClient({ createUpload: vi.fn(async () => ({})) });
    const service = buildService(client);

    await expect(
      service.uploadAndSend({ chatId: -100, file: { path: '/tmp/x' }, type: 'file' }),
    ).rejects.toThrow(/no url/);
    expect(client.uploadBinary).not.toHaveBeenCalled();
  });

  it('5) без chatId/file.path → throw', async () => {
    const service = buildService(fakeClient());
    await expect(service.uploadAndSend({ file: { path: '/tmp/x' }, type: 'file' })).rejects.toThrow(
      /chatId required/,
    );
    await expect(service.uploadAndSend({ chatId: -1, type: 'file' })).rejects.toThrow(
      /file.path required/,
    );
  });
});

// M28: MAX отверг не-`file` тип, сообщение не создано → тот же временный файл заливается как
// `file`. Живая форма отказа (live 2026-10-08) — 200 заливки с error_data без photos:
// buildAttachmentPayload бросает MaxApiError kind 'protocol' с maxCode.
describe('MaxService.uploadAndSend — перезаливка файлом (M28)', () => {
  const FILE = { path: '/tmp/m22/7.part', filename: 'pic.png', contentType: 'image/png' };
  const imageRejected = () => new MaxApiError(
    'MaxClient.buildAttachmentPayload: image upload result has no photos — MAX rejected upload: IMAGE_INVALID_FORMAT',
    { kind: 'protocol', maxCode: 'IMAGE_INVALID_FORMAT' },
  );
  const http = (status, maxCode = null) => new MaxApiError(`HTTP ${status}`, { httpStatus: status, maxCode });

  // Как реальный клиент: image без photos → отказ, остальные типы — токен заливки.
  function rejectingImageClient(overrides = {}) {
    return fakeClient({
      buildAttachmentPayload: vi.fn((type, { uploadResult } = {}) => {
        if (type === 'image') throw imageRejected();
        return { token: uploadResult?.token ?? 'tok-file' };
      }),
      ...overrides,
    });
  }

  function serviceWithLog(client) {
    const logger = silentLogger();
    const service = new MaxService({
      maxClient: client,
      logger,
      uploadRetry: { maxRetries: 3, baseMs: 1, factor: 2 },
    });
    return { service, logger };
  }

  it('1) image: отказ в ответе заливки (IMAGE_INVALID_FORMAT) → тот же файл заливается как file', async () => {
    const client = rejectingImageClient();
    const { service, logger } = serviceWithLog(client);

    const res = await service.uploadAndSend({ chatId: -100, file: FILE, type: 'image', text: 'подпись', format: 'markdown' });

    expect(client.createUpload.mock.calls.map((c) => c[0])).toEqual(['image', 'file']);
    // Без повторного скачивания: обе заливки — тем же временным файлом.
    expect(client.uploadBinary).toHaveBeenCalledTimes(2);
    expect(client.uploadBinary.mock.calls[0][1]).toBe(FILE);
    expect(client.uploadBinary.mock.calls[1][1]).toBe(FILE);
    // Сообщение в MAX — одно, уже как file, с подписью.
    expect(client.sendMessage).toHaveBeenCalledOnce();
    const sent = client.sendMessage.mock.calls[0][0];
    expect(sent.attachments).toEqual([{ type: 'file', payload: { token: 'tok-abc' } }]);
    expect(sent).toMatchObject({ text: 'подпись', format: 'markdown' });
    expect(res).toEqual({ maxMid: 'mid.OUT', timestampMs: 1748432100000, type: 'file', fallbackFrom: 'image' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image', stage: 'payload', maxCode: 'IMAGE_INVALID_FORMAT' }),
      'uploadAndSend: MAX rejected attachment type, re-uploading as file',
    );
  });

  it('2) image: 4xx на заливке → фолбэк', async () => {
    const client = fakeClient({ uploadBinary: vi.fn().mockRejectedValueOnce(http(400)).mockResolvedValueOnce({ token: 'T2' }) });
    const res = await buildService(client).uploadAndSend({ chatId: -100, file: FILE, type: 'image' });

    expect(client.createUpload.mock.calls.map((c) => c[0])).toEqual(['image', 'file']);
    expect(client.sendMessage.mock.calls[0][0].attachments).toEqual([{ type: 'file', payload: { token: 'T2' } }]);
    expect(res).toMatchObject({ type: 'file', fallbackFrom: 'image' });
  });

  it('3) image: 400 на POST /messages (не attachment.not.ready) → фолбэк, сообщение одно', async () => {
    const client = fakeClient({
      sendMessage: vi.fn()
        .mockRejectedValueOnce(http(400, 'some.code'))
        .mockResolvedValueOnce({ message: { body: { mid: 'mid.FB' } } }),
    });
    const res = await buildService(client).uploadAndSend({ chatId: -100, file: FILE, type: 'image' });

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls.map((c) => c[0].attachments[0].type)).toEqual(['image', 'file']);
    expect(res).toEqual({ maxMid: 'mid.FB', timestampMs: null, type: 'file', fallbackFrom: 'image' });
  });

  it('4) video: 400 на заливке → фолбэк, fallbackFrom video', async () => {
    const client = fakeClient({ uploadBinary: vi.fn().mockRejectedValueOnce(http(400)).mockResolvedValueOnce({ token: 'T' }) });
    const res = await buildService(client).uploadAndSend({ chatId: -100, file: FILE, type: 'video' });

    expect(client.createUpload.mock.calls.map((c) => c[0])).toEqual(['video', 'file']);
    expect(res).toMatchObject({ type: 'file', fallbackFrom: 'video' });
  });

  it('4a) video: заливка ответила 2xx с error_data (токен — из /uploads) → фолбэк сразу, без «не готово»', async () => {
    // Реальная сборка payload клиента: у видео токен из /uploads, отказ — в ответе заливки.
    const real = new MaxClient({ baseUrl: 'https://platform-api.example' });
    const client = fakeClient({
      createUpload: vi.fn(async (type) => (type === 'video'
        ? { url: 'https://vu.okcdn.ru/upload.do?sig=x', token: 'VID' }
        : { url: 'https://fd.oneme.ru/upload?sig=y' })),
      uploadBinary: vi.fn()
        .mockResolvedValueOnce({ error_code: '503', error_data: 'VIDEO_INVALID_FORMAT' })
        .mockResolvedValueOnce({ fileId: 1, token: 'F' }),
      buildAttachmentPayload: vi.fn((...args) => real.buildAttachmentPayload(...args)),
    });
    const { service, logger } = serviceWithLog(client);

    const res = await service.uploadAndSend({ chatId: -100, file: FILE, type: 'video' });

    expect(client.createUpload.mock.calls.map((c) => c[0])).toEqual(['video', 'file']);
    // Видео в POST /messages не уходило — сразу одно сообщение файлом.
    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage.mock.calls[0][0].attachments).toEqual([{ type: 'file', payload: { token: 'F' } }]);
    expect(res).toEqual({ maxMid: 'mid.OUT', timestampMs: 1748432100000, type: 'file', fallbackFrom: 'video' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'video', stage: 'payload', maxCode: 'VIDEO_INVALID_FORMAT' }),
      'uploadAndSend: MAX rejected attachment type, re-uploading as file',
    );
  });

  it.each([
    ['attachment.not.ready до исчерпания ретраев', 'image', {
      sendMessage: vi.fn(async () => { throw http(400, 'attachment.not.ready'); }),
    }],
    ['таймаут на POST /messages (сообщение могло уйти)', 'image', {
      sendMessage: vi.fn(async () => { throw new MaxApiError('timed out', { kind: 'timeout' }); }),
    }],
    ['403 chat.denied на POST /messages', 'image', {
      sendMessage: vi.fn(async () => { throw http(403, 'chat.denied'); }),
    }],
    ['5xx на создании upload', 'image', {
      createUpload: vi.fn(async () => { throw http(502); }),
    }],
    ['/uploads без url', 'image', {
      createUpload: vi.fn(async () => ({})),
    }],
    ['500 на заливке (на этом держится smoke outbound-media, тест 4)', 'image', {
      uploadBinary: vi.fn(async () => { throw http(500); }),
    }],
    ['429 на заливке', 'image', {
      uploadBinary: vi.fn(async () => { throw http(429); }),
    }],
    ['таймаут заливки', 'image', {
      uploadBinary: vi.fn(async () => { throw new MaxApiError('timed out', { kind: 'timeout' }); }),
    }],
    ['не MaxApiError', 'image', {
      uploadBinary: vi.fn(async () => { throw new Error('boom'); }),
    }],
    ['type file отвергнут', 'file', {
      buildAttachmentPayload: vi.fn(() => { throw new MaxApiError('no token', { kind: 'protocol', maxCode: 'X' }); }),
    }],
  ])('5) без фолбэка: %s → одна заливка, ошибка наверх', async (_label, type, overrides) => {
    const client = fakeClient(overrides);
    const { service, logger } = serviceWithLog(client);

    await expect(service.uploadAndSend({ chatId: -100, file: FILE, type })).rejects.toBeInstanceOf(Error);

    expect(client.createUpload).toHaveBeenCalledTimes(1);
    expect(client.createUpload).toHaveBeenCalledWith(type);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'uploadAndSend: MAX rejected attachment type, re-uploading as file');
  });

  it('6) фолбэк тоже упал → наружу ошибка фолбэка, заливок ровно 2', async () => {
    const fallbackErr = http(500);
    const client = rejectingImageClient({
      uploadBinary: vi.fn()
        .mockResolvedValueOnce({ error_code: '503', error_data: 'IMAGE_INVALID_FORMAT' })
        .mockRejectedValueOnce(fallbackErr),
    });

    await expect(buildService(client).uploadAndSend({ chatId: -100, file: FILE, type: 'image' })).rejects.toBe(fallbackErr);
    expect(fallbackErr.stage).toBe('upload');
    expect(client.uploadBinary).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('6a) отказ file при фолбэке (тот же класс ошибки) → без третьей заливки', async () => {
    const client = fakeClient({
      buildAttachmentPayload: vi.fn(() => { throw imageRejected(); }),
    });

    await expect(buildService(client).uploadAndSend({ chatId: -100, file: FILE, type: 'image' }))
      .rejects.toMatchObject({ kind: 'protocol', stage: 'payload' });
    expect(client.createUpload.mock.calls.map((c) => c[0])).toEqual(['image', 'file']);
    expect(client.uploadBinary).toHaveBeenCalledTimes(2);
  });

  it('7) ошибка помечается шагом upload-флоу (stage)', async () => {
    const cases = [
      [{ createUpload: vi.fn(async () => { throw http(502); }) }, 'create'],
      [{ uploadBinary: vi.fn(async () => { throw http(500); }) }, 'upload'],
      [{ sendMessage: vi.fn(async () => { throw http(403, 'chat.denied'); }) }, 'send'],
    ];
    for (const [overrides, stage] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const err = await buildService(fakeClient(overrides))
        .uploadAndSend({ chatId: -100, file: FILE, type: 'file' })
        .catch((e) => e);
      expect(err.stage).toBe(stage);
    }
  });
});

describe('isMediaRejectedError (M28: можно ли перезалить файлом)', () => {
  const err = (stage, opts = {}) => new MaxApiError('x', { stage, ...opts });

  it.each([
    // stage, kind, httpStatus, maxCode → ожидание
    ['payload', 'protocol', null, 'IMAGE_INVALID_FORMAT', true],
    ['payload', 'protocol', null, 'IMAGE_DIMENSION_CHECK_FAIL', true],
    ['payload', 'protocol', null, null, true],
    ['upload', 'http', 400, null, true],
    ['upload', 'http', 403, null, true],
    ['upload', 'http', 413, null, true],
    ['upload', 'http', 429, null, false],
    ['upload', 'http', 500, null, false],
    ['upload', 'http', 503, null, false],
    ['upload', 'timeout', null, null, false],
    ['upload', 'network', null, null, false],
    ['send', 'http', 400, 'some.code', true],
    ['send', 'http', 400, null, true],
    ['send', 'http', 400, 'attachment.not.ready', false],
    ['send', 'http', 403, 'chat.denied', false],
    ['send', 'http', 429, null, false],
    ['send', 'http', 500, null, false],
    ['send', 'timeout', null, null, false],
    ['send', 'network', null, null, false],
    ['create', 'http', 400, null, false],
    ['create', 'protocol', null, null, false],
    [null, 'protocol', null, 'IMAGE_INVALID_FORMAT', false],
    [null, 'http', 400, null, false],
  ])('stage=%s kind=%s http=%s code=%s → %s', (stage, kind, httpStatus, maxCode, expected) => {
    expect(isMediaRejectedError(err(stage, { kind, httpStatus, maxCode }))).toBe(expected);
  });

  it('M28: 400 proto.payload «слишком длинный текст» на send → false (файлом уйдёт та же подпись)', () => {
    const tooLong = err('send', {
      kind: 'http', httpStatus: 400, maxCode: 'proto.payload', maxMessage: "Field 'text' size (4114) must be at most 4000",
    });
    expect(isMediaRejectedError(tooLong)).toBe(false);
    const otherPayload = err('send', {
      kind: 'http', httpStatus: 400, maxCode: 'proto.payload', maxMessage: 'Invalid attachment',
    });
    expect(isMediaRejectedError(otherPayload)).toBe(true);
  });

  it('не MaxApiError → false', () => {
    const plain = Object.assign(new Error('x'), { stage: 'payload', kind: 'protocol' });
    expect(isMediaRejectedError(plain)).toBe(false);
    expect(isMediaRejectedError(null)).toBe(false);
  });
});

describe('maxUploadTypeForFile (файл Б24 → MAX upload type)', () => {
  it.each([
    [{ type: 'image', mime: '' }, 'image'],
    [{ type: 'file', mime: 'image/png' }, 'image'],
    [{ type: 'file', mime: 'VIDEO/mp4' }, 'video'],
    [{ type: 'file', mime: 'audio/ogg' }, 'audio'],
    [{ type: 'file', mime: 'application/pdf' }, 'file'],
    [{}, 'file'],
    [null, 'file'],
  ])('%j → %s', (file, expected) => {
    expect(maxUploadTypeForFile(file)).toBe(expected);
  });

  // M22: больше лимита MAX своего типа → `file` (лимиты в десятичных МБ).
  it.each([
    [{ mime: 'image/jpeg' }, 50e6, 'image'],
    [{ mime: 'image/jpeg' }, 50e6 + 1, 'file'],
    [{ mime: 'video/mp4' }, 250e6, 'video'],
    [{ mime: 'video/mp4' }, 250e6 + 1, 'file'],
    [{ mime: 'audio/mpeg' }, 256e6 + 1, 'file'],
    [{ mime: 'application/pdf' }, 1e9, 'file'],
    [{ mime: 'video/mp4' }, null, 'video'],
  ])('%j, size=%s → %s', (file, size, expected) => {
    expect(maxUploadTypeForFile(file, size)).toBe(expected);
  });

  // M28: allowlist картинок MAX (дока + live-пробы 2026-10-08: WEBP принят, HEIC и SVG
  // отвергнуты) и лимит 7680 px по каждой стороне из width/height события Б24.
  it.each([
    [{ type: 'image', mime: 'image/svg+xml' }, 'file'],
    [{ type: 'file', mime: 'image/svg+xml' }, 'file'],
    [{ mime: 'image/x-icon' }, 'file'],
    [{ mime: 'image/vnd.microsoft.icon' }, 'file'],
    [{ type: 'image', mime: 'image/heic' }, 'file'],
    [{ type: 'image', mime: 'image/heif' }, 'file'],
    [{ mime: 'image/avif' }, 'file'],
    [{ mime: 'image/webp' }, 'image'],
    [{ mime: 'image/jpeg' }, 'image'],
    [{ mime: 'image/jpg' }, 'image'],
    [{ mime: 'image/pjpeg' }, 'image'],
    [{ mime: 'IMAGE/PNG' }, 'image'],
    [{ mime: 'image/gif' }, 'image'],
    [{ mime: 'image/tiff' }, 'image'],
    [{ mime: 'image/bmp' }, 'image'],
    [{ mime: 'image/x-ms-bmp' }, 'image'],
    [{ mime: 'image/png; charset=binary' }, 'image'],
    [{ type: 'image', mime: null }, 'image'],
    [{ type: 'image' }, 'image'],
  ])('M28 allowlist: %j → %s', (file, expected) => {
    expect(maxUploadTypeForFile(file)).toBe(expected);
  });

  it.each([
    [{ mime: 'image/png', width: 8000, height: 100 }, 'file'],
    [{ mime: 'image/png', width: 7700, height: 300 }, 'file'],
    [{ mime: 'image/png', width: 300, height: 7700 }, 'file'],
    [{ mime: 'image/png', width: 8000, height: 8000 }, 'file'],
    [{ mime: 'image/png', width: 7680, height: 7680 }, 'image'],
    [{ mime: 'image/png', width: '8000', height: '300' }, 'file'],
    [{ mime: 'image/png', width: '7680', height: '7680' }, 'image'],
    [{ type: 'image', width: 9000, height: 10 }, 'file'],
    [{ mime: 'image/png', width: null, height: null }, 'image'],
    [{ mime: 'image/png', width: 'abc' }, 'image'],
    // Размеры у не-картинки не смотрим.
    [{ mime: 'video/mp4', width: 9000, height: 9000 }, 'video'],
  ])('M28 стороны: %j → %s', (file, expected) => {
    expect(maxUploadTypeForFile(file)).toBe(expected);
  });

  it('M28: картинка в пределах сторон, но больше 50 МБ → file (лимит размера прежний)', () => {
    expect(maxUploadTypeForFile({ mime: 'image/webp', width: 100, height: 100 }, 50e6 + 1)).toBe('file');
  });
});
