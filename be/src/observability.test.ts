import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps, startServer } from './test-helpers.js';
import type { LogEntry } from './logging.js';

async function waitFor(pred: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pred(), 'condition not met in time');
}

test('an error response carries the same request id as its structured log line', async () => {
  const logs: LogEntry[] = [];
  const deps = buildDeps();
  deps.log = (e) => logs.push(e);
  const server = await startServer(deps);
  try {
    const res = await fetch(`${server.baseUrl}/carts/does-not-exist`);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    assert.equal(res.status, 404);

    const headerId = res.headers.get('x-request-id');
    assert.ok(headerId, 'response echoes an X-Request-Id header');
    assert.equal(body.error.requestId, headerId, 'error body carries the request id');

    await waitFor(() => logs.some((l) => l.id === headerId));
    const entry = logs.find((l) => l.id === headerId)!;
    assert.equal(entry.status, 404);
    assert.equal(entry.code, 'CART_NOT_FOUND'); // failure logs the error CODE
    assert.equal(entry.path, '/carts/does-not-exist');
    assert.equal(typeof entry.durationMs, 'number');
  } finally {
    await server.close();
  }
});

test('an inbound X-Request-Id is honoured for correlation', async () => {
  const logs: LogEntry[] = [];
  const deps = buildDeps();
  deps.log = (e) => logs.push(e);
  const server = await startServer(deps);
  try {
    const res = await fetch(`${server.baseUrl}/health`, { headers: { 'X-Request-Id': 'trace-abc-123' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-abc-123');
    await waitFor(() => logs.some((l) => l.id === 'trace-abc-123' && l.path === '/health'));
  } finally {
    await server.close();
  }
});
