// verify-callback для express.json(). Кладёт сырые байты в req.rawBody — нужно
// для проверки HMAC-подписи MAX webhook.
// Без этого global express.json() парсит body и теряет оригинальные байты,
// и подпись посчитать невозможно.

export function verifyRawBody(req, _res, buf) {
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    req.rawBody = buf;
  }
}
