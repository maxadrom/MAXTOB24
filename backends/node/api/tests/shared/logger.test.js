import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

import { DEFAULT_REDACT_PATHS } from '../../src/shared/logger/index.js';

function collectLogs() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, lines };
}

describe('shared/logger', () => {
  it('child loggers inherit base bindings', () => {
    const { stream, lines } = collectLogs();
    const root = pino({ level: 'debug', base: { service: 'maxtob24-api' } }, stream);
    const child = root.child({ module: 'max' });
    child.info('hello');
    expect(lines.join('')).toMatch(/"module":"max"/);
    expect(lines.join('')).toMatch(/"service":"maxtob24-api"/);
  });

  it('redacts authorization, password, token, secret', () => {
    const { stream, lines } = collectLogs();
    const logger = pino(
      { level: 'debug', redact: { paths: DEFAULT_REDACT_PATHS, censor: '[redacted]' } },
      stream,
    );
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc' } },
        config: { db: { password: 'dbsecret' } },
        user: { password: 'p', token: 'tk', secret: 's' },
      },
      'event',
    );
    const out = lines.join('');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('dbsecret');
    expect(out).toContain('[redacted]');
  });
});
