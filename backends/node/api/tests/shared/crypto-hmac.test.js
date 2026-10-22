import { describe, expect, it } from 'vitest';
import { signHmacSha256, verifyHmacSha256 } from '../../src/shared/crypto/hmac.js';

describe('shared/crypto/hmac', () => {
  it('signs and verifies', () => {
    const sig = signHmacSha256('secret', '{"hello":"world"}');
    expect(verifyHmacSha256('secret', '{"hello":"world"}', sig)).toBe(true);
  });

  it('rejects modified body', () => {
    const sig = signHmacSha256('secret', '{"hello":"world"}');
    expect(verifyHmacSha256('secret', '{"hello":"WORLD"}', sig)).toBe(false);
  });

  it('rejects different secret', () => {
    const sig = signHmacSha256('secret', 'payload');
    expect(verifyHmacSha256('other', 'payload', sig)).toBe(false);
  });

  it('handles Buffer payload identical to string', () => {
    const sig = signHmacSha256('secret', 'payload');
    expect(verifyHmacSha256('secret', Buffer.from('payload', 'utf8'), sig)).toBe(true);
  });

  it('returns false for empty/invalid signature', () => {
    expect(verifyHmacSha256('secret', 'payload', '')).toBe(false);
    expect(verifyHmacSha256('secret', 'payload', undefined)).toBe(false);
  });
});
