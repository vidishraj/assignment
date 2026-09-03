import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps, startServer } from './test-helpers.js';

test('mutating routes are rate limited: 429 with Retry-After past the window limit', async () => {
  // Opt in to a tiny limit; the default test config disables rate limiting.
  const deps = buildDeps({ rateLimit: { limit: 2, windowMs: 60_000 } });
  const server = await startServer(deps);
  try {
    const post = () => fetch(`${server.baseUrl}/admin/coupons`, { method: 'POST' });
    const r1 = await post();
    const r2 = await post();
    const r3 = await post();

    // The first two are allowed through (they 409 as not-eligible, not 429).
    assert.notEqual(r1.status, 429);
    assert.notEqual(r2.status, 429);

    // The third exceeds the window and is throttled.
    assert.equal(r3.status, 429);
    const body = (await r3.json()) as { error: { code: string; details: { retryAfterSeconds: number } } };
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.ok(Number(r3.headers.get('retry-after')) > 0, 'Retry-After header is set');
    assert.ok(body.error.details.retryAfterSeconds > 0);
  } finally {
    await server.close();
  }
});

test('rate limiting does not touch non-mutating routes', async () => {
  const deps = buildDeps({ rateLimit: { limit: 1, windowMs: 60_000 } });
  const server = await startServer(deps);
  try {
    // Many GETs to a read route stay 200 even past the mutating-route limit.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.baseUrl}/products`);
      assert.equal(res.status, 200);
    }
  } finally {
    await server.close();
  }
});
