// Security M13: SSRF-guard для исходящих скачиваний по ссылке из вебхука B24.
// Безусловный инвариант (всегда): только https, запрет приватных/loopback/link-local/
// metadata/internal-целей по IP-литералу и спец-именам. Этого достаточно, чтобы
// блокировать классический SSRF к 169.254.169.254 и внутренним сервисам.
//
// Host-allowlist (портал + подтверждённые CDN-хосты B24) — НЕ включён жёстко: реальные
// дисковые/CDN-хосты Б24 не сняты. Публичные домены пока
// разрешены (инвариант их пропускает), что НЕ ломает легитимные скачивания. Остаточный
// риск (DNS-rebinding публичного имени в приватный IP) принят: downloadLink приходит из
// аутентифицированного по application_token вебхука B24, а редиректы валидируются
// по каждому хопу (см. b24Client.downloadFile).

import net from 'node:net';

const BLOCKED_HOST_EXACT = new Set(['localhost', '']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local'];

function ip4ToOctets(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

// Приватные/зарезервированные IPv4-диапазоны (включая loopback и link-local/metadata).
function isBlockedV4(host) {
  const o = ip4ToOctets(host);
  if (!o) return true; // не разобрали как корректный v4 — fail-closed
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true; // multicast/reserved 224+/240+
  return false;
}

function isBlockedV6(host) {
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d или нормализованный hex ::ffff:7f00:1) — блокируем
  // целиком: для легитимной download-ссылки mapped-форма не нужна и подозрительна.
  if (lower.includes('::ffff:')) return true;
  const head = lower.split(':')[0];
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 ULA
  return false;
}

/**
 * Проверяет URL для скачивания на безопасность (инвариант). Не делает сетевых вызовов.
 * @param {string} urlString
 * @returns {{ ok: boolean, reason?: string, host?: string }}
 */
export function checkDownloadUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'non-https', host: url.hostname };
  }
  // hostname в URL может быть в скобках для IPv6 — net.isIP это уже учитывает.
  // Конечная точка FQDN (`localhost.`, `metadata.google.internal.`) резолвится так же,
  // как без неё, — срезаем, иначе имя проходит мимо точного списка и суффиксов.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (BLOCKED_HOST_EXACT.has(host)) {
    return { ok: false, reason: 'blocked-hostname', host };
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'blocked-suffix', host };
  }
  const v = net.isIP(host);
  if (v === 4 && isBlockedV4(host)) return { ok: false, reason: 'private-ipv4', host };
  if (v === 6 && isBlockedV6(host)) return { ok: false, reason: 'private-ipv6', host };
  return { ok: true, host };
}
