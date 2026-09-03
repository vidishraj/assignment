import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { CartView } from './services/cart-service.js';
import type { Order } from './domain/types.js';

/** POST a checkout with an optional Idempotency-Key header. */
async function checkout(baseUrl: string, cartId: string, key?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/carts/${cartId}/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function cartWith(baseUrl: string, productId: string, quantity: number): Promise<string> {
  const { body: cart } = await api<CartView>(baseUrl, 'POST', '/carts');
  await api(baseUrl, 'POST', `/carts/${cart.id}/items`, { productId, quantity });
  return cart.id;
}

test('same Idempotency-Key replays the same order, charged once', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-cap', 1); // inv 20
    const first = await checkout(server.baseUrl, cartId, 'key-1');
    const replay = await checkout(server.baseUrl, cartId, 'key-1');
    assert.equal(first.status, 201);
    assert.deepEqual(replay.body, first.body); // identical response
    assert.equal(replay.status, first.status); // identical status
    assert.equal(deps.repos.products.get('p-cap')!.inventory, 19); // charged once
  } finally {
    await server.close();
  }
});

test('a NEW cart reusing the key is rejected (422) — no second order is placed', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    // First order under key-2.
    const cartA = await cartWith(server.baseUrl, 'p-cap', 1);
    const first = await checkout(server.baseUrl, cartA, 'key-2');
    // Client lost the response and retried with a brand-NEW identical cart + same key.
    // With cart-scoped idempotency alone this would place a second order; the key
    // must instead return the original. (Fingerprint is cart+coupon, so this cart
    // differs — it must be rejected as reuse, which is the safe outcome.)
    const cartB = await cartWith(server.baseUrl, 'p-cap', 1);
    const retry = await checkout(server.baseUrl, cartB, 'key-2');
    assert.equal(retry.status, 422);
    assert.equal(retry.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    // Only the first order was ever placed.
    assert.equal(deps.repos.orders.count(), 1);
    assert.equal(deps.repos.orders.get(first.body.id)!.id, first.body.id);
  } finally {
    await server.close();
  }
});

test('same key with a different coupon is rejected (422), not silently replayed', async () => {
  const deps = buildDeps({ milestoneInterval: 1, discountPercent: 10 });
  const server = await startServer(deps);
  try {
    // Reach a milestone so a coupon exists.
    const seed = await cartWith(server.baseUrl, 'p-mug', 1);
    await checkout(server.baseUrl, seed);
    const { body: coupon } = await api<{ code: string }>(server.baseUrl, 'POST', '/admin/coupons');

    const cartId = await cartWith(server.baseUrl, 'p-cap', 1);
    const first = await checkout(server.baseUrl, cartId, 'key-3'); // no coupon
    assert.equal(first.status, 201);
    // Same key, same cart, but now WITH a coupon → different request → must 422.
    const reused = await checkout(server.baseUrl, cartId, 'key-3', { couponCode: coupon.code });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    // The coupon was not consumed by the rejected reuse.
    assert.equal(deps.repos.coupons.get(coupon.code)!.status, 'AVAILABLE');
  } finally {
    await server.close();
  }
});

test('concurrent requests with the same key yield exactly one order', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-cap', 1);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => checkout(server.baseUrl, cartId, 'key-race')),
    );
    const orderIds = new Set(results.map((r) => r.body.id));
    assert.equal(orderIds.size, 1, 'all same-key requests resolve to one order');
    assert.equal(deps.repos.orders.count(), 1);
    assert.equal(deps.repos.products.get('p-cap')!.inventory, 19); // charged once
  } finally {
    await server.close();
  }
});

test('the no-key path is unchanged (still cart-scoped idempotent)', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-cap', 1);
    const first = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    const retry = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200); // cart-based replay
    assert.equal(retry.body.id, first.body.id);
  } finally {
    await server.close();
  }
});
