import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, startServer } from './test-helpers.js';

/** POST a raw (already-serialized) body with a JSON content-type. */
async function postRaw(baseUrl: string, path: string, rawBody: string) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('malformed and oversized request bodies are client errors, not 500s', async () => {
  const server = await startServer();
  try {
    // Unparseable JSON.
    const broken = await postRaw(server.baseUrl, '/carts/x/items', '{"bad"');
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'MALFORMED_REQUEST');

    // Valid JSON but not an object (strict mode rejects bare primitives).
    for (const primitive of ['"a string"', 'null', '123']) {
      const res = await postRaw(server.baseUrl, '/carts/x/items', primitive);
      assert.equal(res.status, 400, `primitive ${primitive} should be 400`);
      assert.equal(res.body.error.code, 'MALFORMED_REQUEST');
    }

    // Oversized body (default limit is 100kb) → 413, not 500.
    const huge = JSON.stringify({ blob: 'x'.repeat(200_000) });
    const tooBig = await postRaw(server.baseUrl, '/carts/x/items', huge);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await server.close();
  }
});

test('health endpoint reports ok and the injected config', async () => {
  const server = await startServer();
  try {
    const res = await api<{ status: string; config: { milestoneInterval: number } }>(
      server.baseUrl,
      'GET',
      '/health',
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.config.milestoneInterval, 3);
  } finally {
    await server.close();
  }
});
