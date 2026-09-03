import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';

test('health endpoint reports ok and the injected config', async () => {
  const app = createApp({ config: { milestoneInterval: 3, discountPercent: 10 } });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://localhost:${port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; config: { milestoneInterval: number } };
    assert.equal(body.status, 'ok');
    assert.equal(body.config.milestoneInterval, 3);
  } finally {
    server.close();
  }
});
