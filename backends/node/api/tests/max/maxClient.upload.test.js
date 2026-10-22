// Unit-тесты M11.2 upload-флоу MaxClient: createUpload / uploadBinary /
// buildAttachmentPayload + расширение sendMessage поддержкой attachments.
// Мокаем fetch; проверяем auth на /uploads, ОТСУТСТВИЕ auth на абсолютном
// upload-url (url сам несёт авторизацию), поле формы `data`, сборку body /messages.
// M22: заливка — node:http(s).request потоком, её принимает локальный сервер.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxClient } from '../../src/modules/max/maxClient.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { parseSingleMultipart, startUploadServer } from '../helpers/uploadServer.js';

const BASE_URL = 'https://dev.max.ru/api';
const TOKEN = 'tok-test-max-123';

function fakeFetchResponse(body, { status = 200, ok = status < 400 } = {}) {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    async text() {
      return text;
    },
  };
}

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

describe('MaxClient — M11.2 upload flow', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new MaxClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      logger: silentLogger(),
      fetchImpl: fetchMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createUpload ────────────────────────────────────────────────────────────
  it('1) createUpload(image): POST /uploads?type=image С Authorization, возвращает {url}', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ url: 'https://fd.oneme.ru/upload?x' }));

    const res = await client.createUpload('image');

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.pathname).toBe('/api/uploads');
    expect(parsed.searchParams.get('type')).toBe('image');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(res.url).toBe('https://fd.oneme.ru/upload?x');
  });

  it('2) createUpload с неверным type → throw, fetch не зван', async () => {
    await expect(client.createUpload('gif')).rejects.toThrow(/type must be/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── uploadBinary (M22: поток с диска через node:http(s).request) ────────────
  describe('uploadBinary', () => {
    let server;
    let dir;

    beforeEach(async () => {
      server = await startUploadServer();
      dir = await mkdtemp(path.join(os.tmpdir(), 'm22-up-test-'));
    });

    afterEach(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    async function tempFile(content, name = 'f.part') {
      const p = path.join(dir, name);
      await writeFile(p, content);
      return p;
    }

    it('3) POST на АБСОЛЮТНЫЙ url, multipart с полем "data", явная Content-Length, БЕЗ Authorization', async () => {
      const filePath = await tempFile('hello-bytes');
      const uploadUrl = server.url('/upload?sig=zzz');

      const res = await client.uploadBinary(uploadUrl, {
        path: filePath,
        filename: 'd.pdf',
        contentType: 'application/pdf',
      });

      expect(res).toEqual({ token: 'tok-upload' });
      expect(fetchMock).not.toHaveBeenCalled();
      const [req] = server.requests;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/upload?sig=zzz');
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers['transfer-encoding']).toBeUndefined();
      expect(Number(req.headers['content-length'])).toBe(req.body.length);
      const part = parseSingleMultipart(req);
      expect(part.name).toBe('data');
      expect(part.filename).toBe('d.pdf');
      expect(part.contentType).toBe('application/pdf');
      expect(part.data.toString()).toBe('hello-bytes');
      expect(part.endsWithTail).toBe(true);
    });

    it('3a) имя файла: кириллица как UTF-8, кавычка и CR/LF экранируются', async () => {
      const filePath = await tempFile('x');
      await client.uploadBinary(server.url(), { path: filePath, filename: 'отчёт "Q3"\r\n.pdf' });
      const part = parseSingleMultipart(server.requests[0]);
      expect(part.filename).toBe('отчёт %22Q3%22%0D%0A.pdf');
      expect(part.contentType).toBe('application/octet-stream');
    });

    it('3b) большой файл уходит целиком (несколько чанков потока)', async () => {
      const content = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab);
      const filePath = await tempFile(content);
      await client.uploadBinary(server.url(), { path: filePath, filename: 'big.bin' });
      expect(parseSingleMultipart(server.requests[0]).data.equals(content)).toBe(true);
    });

    it('3c) ответ не JSON (video/audio: <retval>1</retval>) → null', async () => {
      server.setHandler(() => ({ status: 200, body: '<retval>1</retval>' }));
      const filePath = await tempFile('v');
      await expect(client.uploadBinary(server.url(), { path: filePath })).resolves.toBeNull();
    });

    it('4) non-2xx → MaxApiError с httpStatus и maxCode', async () => {
      server.setHandler(() => ({ status: 413, body: { code: 'too.big', message: 'too big' } }));
      const filePath = await tempFile('x');
      const err = await client.uploadBinary(server.url(), { path: filePath }).catch((e) => e);
      expect(err).toBeInstanceOf(MaxApiError);
      expect(err.message).toMatch(/HTTP 413/);
      expect(err.httpStatus).toBe(413);
      expect(err.maxCode).toBe('too.big');
      expect(err.maxMessage).toBe('too big');
    });

    it('4b) non-2xx без code в теле → maxCode null', async () => {
      server.setHandler(() => ({ status: 413, body: { message: 'too big' } }));
      const filePath = await tempFile('x');
      const err = await client.uploadBinary(server.url(), { path: filePath }).catch((e) => e);
      expect(err.httpStatus).toBe(413);
      expect(err.maxCode).toBeNull();
    });

    it('4c) сервер не отвечает → MaxApiError kind=timeout по дедлайну', async () => {
      server.setHandler(() => ({ hang: true }));
      const filePath = await tempFile('x');
      const err = await client.uploadBinary(server.url(), { path: filePath }, { timeoutMs: 100 }).catch((e) => e);
      expect(err).toBeInstanceOf(MaxApiError);
      expect(err).toMatchObject({ kind: 'timeout', httpStatus: null });
    });

    it('4d) соединение отвергнуто → MaxApiError kind=network', async () => {
      const filePath = await tempFile('x');
      const deadUrl = server.url();
      await server.close();
      server = await startUploadServer(); // для afterEach
      const err = await client.uploadBinary(deadUrl, { path: filePath }).catch((e) => e);
      expect(err).toMatchObject({ name: 'MaxApiError', kind: 'network' });
    });

    it('5) без url или file.path → TypeError', async () => {
      await expect(client.uploadBinary('', { path: '/x' })).rejects.toThrow(/uploadUrl required/);
      await expect(client.uploadBinary(server.url(), null)).rejects.toThrow(/file.path required/);
      expect(server.requests).toHaveLength(0);
    });
  });

  // ── buildAttachmentPayload ───────────────────────────────────────────────────
  it('6) buildAttachmentPayload: file → token из ответа заливки (put.token)', () => {
    expect(
      client.buildAttachmentPayload('file', { uploadResult: { fileId: 1, token: 'T' } }),
    ).toEqual({ token: 'T' });
  });

  it('6b) buildAttachmentPayload: video → token из ответа /uploads (заливка пустая)', () => {
    // live 2026-05-31: /uploads?type=video → { url, token }; заливка отдаёт
    // <retval>1</retval> (не JSON) → uploadResult=null. Токен берём из uploads.
    expect(
      client.buildAttachmentPayload('video', {
        uploadsResponse: { url: 'https://vu.okcdn.ru/upload.do?sig=x', token: 'V' },
        uploadResult: null,
      }),
    ).toEqual({ token: 'V' });
  });

  it('7) buildAttachmentPayload: image → {photos} из ответа заливки', () => {
    const photos = { a: { token: 'P' } };
    expect(client.buildAttachmentPayload('image', { uploadResult: { photos } })).toEqual({ photos });
  });

  it('8) buildAttachmentPayload: нет токена ни в /uploads, ни в заливке → throw', () => {
    expect(() =>
      client.buildAttachmentPayload('file', { uploadsResponse: {}, uploadResult: {} }),
    ).toThrow(/cannot resolve token/);
  });

  it('8b) buildAttachmentPayload: image без photos → throw', () => {
    expect(() => client.buildAttachmentPayload('image', { uploadResult: {} })).toThrow(
      /no photos/,
    );
  });

  // M28: отказ MAX принять картинку — HTTP 200 заливки с {error_code, error_data} без photos
  // (live 2026-10-08). error_data → maxCode; error_code — не HTTP-статус, не читается.
  function payloadError(type, uploadResult) {
    try {
      client.buildAttachmentPayload(type, { uploadResult });
    } catch (err) {
      return err;
    }
    throw new Error('expected buildAttachmentPayload to throw');
  }

  it('8c) M28: image + {error_code:"503", error_data:"IMAGE_INVALID_FORMAT"} → protocol, maxCode из error_data', () => {
    const err = payloadError('image', { error_code: '503', error_data: 'IMAGE_INVALID_FORMAT' });
    expect(err).toBeInstanceOf(MaxApiError);
    expect(err).toMatchObject({ kind: 'protocol', maxCode: 'IMAGE_INVALID_FORMAT', httpStatus: null });
    expect(err.message).toMatch(/no photos — MAX rejected upload: IMAGE_INVALID_FORMAT$/);
  });

  it('8d) M28: image + {error_code:"1", error_data:"IMAGE_DIMENSION_CHECK_FAIL"} → maxCode', () => {
    const err = payloadError('image', { error_code: '1', error_data: 'IMAGE_DIMENSION_CHECK_FAIL' });
    expect(err).toMatchObject({ kind: 'protocol', maxCode: 'IMAGE_DIMENSION_CHECK_FAIL', httpStatus: null });
  });

  it.each([
    ['пустой ответ', {}],
    ['error_data пустая строка', { error_data: '' }],
    ['error_data не строка', { error_data: { code: 'x' } }],
    ['ответа нет', null],
  ])('8e) M28: image без photos и без error_data (%s) → protocol, maxCode:null', (_label, uploadResult) => {
    const err = payloadError('image', uploadResult);
    expect(err).toMatchObject({ kind: 'protocol', maxCode: null });
    expect(err.message).not.toMatch(/MAX rejected upload/);
  });

  it('8f) M28: file без токена с error_data → maxCode из error_data', () => {
    const err = payloadError('file', { error_code: '503', error_data: 'FILE_REJECTED' });
    expect(err).toMatchObject({ kind: 'protocol', maxCode: 'FILE_REJECTED' });
    expect(err.message).toMatch(/cannot resolve token for type=file/);
  });

  // M28: у video/audio токен выдаёт /uploads до заливки — он не доказывает, что MAX принял
  // бинарь. Ответ заливки с error_data (без своего токена) — отказ, как у картинки.
  const VIDEO_UPLOADS = { url: 'https://vu.okcdn.ru/upload.do?sig=x', token: 'V' };

  it.each(['video', 'audio'])('8g) M28: %s — токен из /uploads, но заливка вернула error_data → protocol, maxCode', (type) => {
    let err = null;
    try {
      client.buildAttachmentPayload(type, {
        uploadsResponse: VIDEO_UPLOADS,
        uploadResult: { error_code: '503', error_data: 'VIDEO_INVALID_FORMAT' },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaxApiError);
    expect(err).toMatchObject({ kind: 'protocol', maxCode: 'VIDEO_INVALID_FORMAT', httpStatus: null });
    expect(err.message).toMatch(new RegExp(`type=${type} rejected .* — MAX rejected upload: VIDEO_INVALID_FORMAT$`));
  });

  it.each([
    ['пустой объект', {}],
    ['error_data пустая строка', { error_data: '' }],
    ['error_data не строка', { error_data: 1 }],
  ])('8h) M28: video — токен из /uploads, в ответе заливки нет кода отказа (%s) → {token}', (_label, uploadResult) => {
    expect(
      client.buildAttachmentPayload('video', { uploadsResponse: VIDEO_UPLOADS, uploadResult }),
    ).toEqual({ token: 'V' });
  });

  it('8i) M28: file — свой токен в ответе заливки важнее error_data → {token}', () => {
    expect(
      client.buildAttachmentPayload('file', { uploadResult: { fileId: 1, token: 'T', error_data: 'X' } }),
    ).toEqual({ token: 'T' });
  });

  // ── sendMessage с attachments ────────────────────────────────────────────────
  it('9) sendMessage с attachments и пустым text → body.attachments, без text', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm1' } } }));

    await client.sendMessage({
      chatId: -100,
      text: '',
      attachments: [{ type: 'file', payload: { token: 'T' } }],
    });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.searchParams.get('chat_id')).toBe('-100');
    const body = JSON.parse(init.body);
    expect(body.attachments).toEqual([{ type: 'file', payload: { token: 'T' } }]);
    expect(body).not.toHaveProperty('text');
  });

  it('10) sendMessage с attachments + подпись → body.text присутствует', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm2' } } }));

    await client.sendMessage({
      chatId: -100,
      text: 'смотри',
      attachments: [{ type: 'image', payload: { photos: {} } }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('смотри');
    expect(body.attachments).toHaveLength(1);
  });

  it('11) обратная совместимость: текст-только → body={text} (как раньше)', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm3' } } }));

    await client.sendMessage({ chatId: -100, text: 'привет', format: 'markdown' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: 'привет', format: 'markdown' });
  });

  // ── Reply/цитирование: link в body POST /messages ─────────────────────────
  it('12) sendMessage с link → body.link попадает в POST', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm.r' } } }));

    await client.sendMessage({
      chatId: -100,
      text: 'мой ответ',
      link: { type: 'reply', mid: 'parent.mid' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.link).toEqual({ type: 'reply', mid: 'parent.mid' });
    expect(body.text).toBe('мой ответ');
  });

  it('13) sendMessage без link → body.link отсутствует (регрессия)', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm.n' } } }));

    await client.sendMessage({ chatId: -100, text: 'обычный' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('link');
  });

  // ── M21: личка — адресат user_id, а не chat_id ──────────────────────────────
  it('14) sendMessage с userId → POST /messages?user_id=…, без chat_id', async () => {
    fetchMock.mockResolvedValueOnce(fakeFetchResponse({ message: { body: { mid: 'm.d' } } }));

    await client.sendMessage({ userId: 1000001, text: 'подсказка' });

    const parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.searchParams.get('user_id')).toBe('1000001');
    expect(parsed.searchParams.has('chat_id')).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'подсказка' });
  });

  it.each([
    ['ни chatId, ни userId', { text: 'x' }],
    ['и chatId, и userId', { chatId: -100, userId: 1, text: 'x' }],
  ])('15) %s → TypeError, запроса нет', async (_label, message) => {
    await expect(client.sendMessage(message)).rejects.toThrow(/exactly one of chatId\/userId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
