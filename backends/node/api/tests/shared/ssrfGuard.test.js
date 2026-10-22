// Security M13: инвариант SSRF-guard для download-ссылок.

import { describe, expect, it } from 'vitest';

import { checkDownloadUrl } from '../../src/shared/http/ssrfGuard.js';

describe('checkDownloadUrl (SSRF invariant)', () => {
  it('пропускает публичный https-хост', () => {
    expect(checkDownloadUrl('https://portal.bitrix24.ru/pub/im.file.php?SIGN=x').ok).toBe(true);
    expect(checkDownloadUrl('https://cdn.bitrix24.com/a/b.jpg').ok).toBe(true);
  });

  it('блокирует не-https', () => {
    expect(checkDownloadUrl('http://portal.bitrix24.ru/x')).toMatchObject({ ok: false, reason: 'non-https' });
    expect(checkDownloadUrl('ftp://host/x').ok).toBe(false);
    expect(checkDownloadUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('блокирует cloud metadata 169.254.169.254', () => {
    expect(checkDownloadUrl('https://169.254.169.254/latest/meta-data/')).toMatchObject({
      ok: false,
      reason: 'private-ipv4',
    });
  });

  it('блокирует loopback и localhost', () => {
    expect(checkDownloadUrl('https://127.0.0.1/x').ok).toBe(false);
    expect(checkDownloadUrl('https://localhost/x')).toMatchObject({ ok: false, reason: 'blocked-hostname' });
    expect(checkDownloadUrl('https://[::1]/x').ok).toBe(false);
  });

  it('блокирует приватные IPv4-диапазоны', () => {
    expect(checkDownloadUrl('https://10.0.0.5/x').ok).toBe(false);
    expect(checkDownloadUrl('https://172.16.0.1/x').ok).toBe(false);
    expect(checkDownloadUrl('https://192.168.1.1/x').ok).toBe(false);
    expect(checkDownloadUrl('https://100.64.0.1/x').ok).toBe(false); // CGNAT
  });

  it('блокирует internal/local-суффиксы и IPv6 ULA/link-local', () => {
    expect(checkDownloadUrl('https://db.internal/x')).toMatchObject({ ok: false, reason: 'blocked-suffix' });
    expect(checkDownloadUrl('https://svc.local/x').ok).toBe(false);
    expect(checkDownloadUrl('https://[fd00::1]/x').ok).toBe(false);
    expect(checkDownloadUrl('https://[fe80::1]/x').ok).toBe(false);
  });

  it('FQDN с точкой на конце не обходит блок-лист', () => {
    expect(checkDownloadUrl('https://localhost./x')).toMatchObject({ ok: false, reason: 'blocked-hostname' });
    expect(checkDownloadUrl('https://metadata.google.internal./x')).toMatchObject({ ok: false, reason: 'blocked-suffix' });
    expect(checkDownloadUrl('https://svc.local../x').ok).toBe(false);
    expect(checkDownloadUrl('https://127.0.0.1./x').ok).toBe(false);
    expect(checkDownloadUrl('https://portal.bitrix24.ru./x')).toMatchObject({ ok: true, host: 'portal.bitrix24.ru' });
  });

  it('блокирует IPv4-mapped IPv6 на приватный адрес', () => {
    expect(checkDownloadUrl('https://[::ffff:127.0.0.1]/x').ok).toBe(false);
  });

  it('битый URL → ok:false', () => {
    expect(checkDownloadUrl('not a url').ok).toBe(false);
    expect(checkDownloadUrl('').ok).toBe(false);
  });
});
