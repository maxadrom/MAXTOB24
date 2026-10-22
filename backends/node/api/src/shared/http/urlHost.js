// Хост url для лаконичного debug-лога (без path/query: там SIGN/токены).
// Неразбираемый url → null (лог не должен падать на битой ссылке).

export function urlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
