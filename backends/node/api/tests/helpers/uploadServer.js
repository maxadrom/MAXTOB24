// M22: локальный HTTP-приёмник заливки MAX. uploadBinary ходит node:http(s).request, а не
// fetch, поэтому мок fetch его не видит: мок /uploads отдаёт url этого сервера.

import http from 'node:http';

// handler(entry) → { status, body, hang } — ответ на запрос; hang — не отвечать вовсе.
export async function startUploadServer(handler = () => ({ status: 200, body: { token: 'tok-upload' } })) {
  const requests = [];
  let respond = handler;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(entry);
      const out = respond(entry) ?? {};
      if (out.hang) return;
      const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: (p = '/upload') => `http://127.0.0.1:${port}${p}`,
    requests,
    setHandler(fn) {
      respond = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

// Разбор multipart с одним полем (как шлёт uploadBinary).
export function parseSingleMultipart(entry) {
  const boundary = /boundary=(.+)$/.exec(entry.headers['content-type'] ?? '')?.[1];
  const raw = entry.body;
  const headEnd = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, headEnd).toString('utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    head,
    name: /name="([^"]*)"/.exec(head)?.[1] ?? null,
    filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
    contentType: /Content-Type: (.+)/.exec(head)?.[1]?.trim() ?? null,
    data: raw.subarray(headEnd + 4, raw.length - tail.length),
    endsWithTail: raw.subarray(raw.length - tail.length).equals(tail),
  };
}
