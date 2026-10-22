// M22: ответы fetch для тестов транспорта — настоящий Response со стримом.

// Тело, которое не приходит до abort сигнала запроса: так ведёт себя undici, когда
// сигнал fetch срабатывает посреди чтения тела (ошибка = signal.reason, TimeoutError).
export function hangingBodyResponse(signal, { status = 200, headers = {} } = {}) {
  const body = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(body, { status, headers });
}

// Бинарный ответ скачивания: Content-Type и (по умолчанию) Content-Length.
export function binaryResponse(bytes, { contentType = 'application/octet-stream', contentLength = true, status = 200 } = {}) {
  const buf = Buffer.from(bytes);
  const headers = { 'content-type': contentType };
  if (contentLength) headers['content-length'] = String(buf.length);
  return new Response(buf, { status, headers });
}
