import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, startServer } from './test-helpers.js';

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
