import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { verifyRawBody } from '../../src/shared/http/rawBody.js';

describe('shared/http/rawBody', () => {
  it('places original bytes into req.rawBody', async () => {
    const app = express();
    app.use(express.json({ verify: verifyRawBody }));
    app.post('/echo', (req, res) => {
      res.json({
        parsed: req.body,
        rawLength: req.rawBody?.length ?? 0,
        rawString: req.rawBody?.toString('utf8') ?? null,
      });
    });

    const payload = '{"a":1,"b":"x"}';
    const response = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.parsed).toEqual({ a: 1, b: 'x' });
    expect(response.body.rawString).toBe(payload);
    expect(response.body.rawLength).toBe(Buffer.byteLength(payload, 'utf8'));
  });
});
