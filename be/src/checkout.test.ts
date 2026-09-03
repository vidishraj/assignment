import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { CartView } from './services/cart-service.js';
import type { Order } from './domain/types.js';

/** Create a cart containing `quantity` of `productId`. Returns the cart id. */
async function cartWith(baseUrl: string, productId: string, quantity: number): Promise<string> {
  const { body: cart } = await api<CartView>(baseUrl, 'POST', '/carts');
  await api(baseUrl, 'POST', `/carts/${cart.id}/items`, { productId, quantity });
  return cart.id;
}

test('checkout places an order, snapshots lines, and decrements inventory', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-bottle', 2); // 2 × 2499, inv 8
    const res = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'PLACED');
    assert.equal(res.body.subtotalCents, 4998);
    assert.equal(res.body.totalCents, 4998);
    assert.equal(res.body.lines[0].productName, 'Steel Water Bottle');
    assert.equal(res.body.lines[0].unitPriceCents, 2499);
    // Inventory dropped 8 → 6; cart is now closed.
    assert.equal(deps.repos.products.get('p-bottle')!.inventory, 6);
    const cart = await api<CartView>(server.baseUrl, 'GET', `/carts/${cartId}`);
    assert.equal(cart.body.status, 'CHECKED_OUT');
  } finally {
    await server.close();
  }
});

test('order snapshot survives later product changes', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-mug', 1);
    const { body: order } = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    // Product renamed + repriced after the order.
    deps.repos.products.save({ id: 'p-mug', name: 'Different Mug', unitPriceCents: 9999, inventory: 0 });
    const fetched = await api<Order>(server.baseUrl, 'GET', `/orders/${order.id}`);
    assert.equal(fetched.body.lines[0].productName, 'Ceramic Mug'); // original snapshot
    assert.equal(fetched.body.lines[0].unitPriceCents, 1299);
  } finally {
    await server.close();
  }
});

test('retrying checkout is idempotent — same order, charged once', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-cap', 1); // inv 20
    const first = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    const retry = await api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200); // already placed
    assert.equal(retry.body.id, first.body.id); // same order
    assert.equal(deps.repos.products.get('p-cap')!.inventory, 19); // charged once, not twice
  } finally {
    await server.close();
  }
});

test('insufficient inventory is rejected atomically (no partial charge)', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    // Cart wants 2 hoodies but only 1 exists; also a valid mug line.
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-mug', quantity: 1 });
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-hoodie', quantity: 2 });
    const res = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/checkout`,
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_INVENTORY');
    // Nothing was charged — the mug line must not have been decremented.
    assert.equal(deps.repos.products.get('p-mug')!.inventory, 100);
    assert.equal(deps.repos.products.get('p-hoodie')!.inventory, 1);
  } finally {
    await server.close();
  }
});

test('empty cart cannot be checked out', async () => {
  const server = await startServer();
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
    const res = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/checkout`,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CART_EMPTY');
  } finally {
    await server.close();
  }
});

// --- competing operations (required) ---

test('concurrent checkouts for scarce stock never oversell', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    // 6 separate carts each want the single Limited Hoodie (inventory 1).
    const cartIds = await Promise.all(
      Array.from({ length: 6 }, () => cartWith(server.baseUrl, 'p-hoodie', 1)),
    );
    const results = await Promise.all(
      cartIds.map((id) => api<Order | { error: { code: string } }>(server.baseUrl, 'POST', `/carts/${id}/checkout`)),
    );
    const placed = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(placed.length, 1, 'exactly one order placed');
    assert.equal(rejected.length, 5, 'the rest rejected as insufficient inventory');
    assert.equal(deps.repos.products.get('p-hoodie')!.inventory, 0, 'sold exactly one');
  } finally {
    await server.close();
  }
});

test('concurrent retries of one cart yield a single order', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const cartId = await cartWith(server.baseUrl, 'p-hoodie', 1);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api<Order>(server.baseUrl, 'POST', `/carts/${cartId}/checkout`)),
    );
    const orderIds = new Set(results.map((r) => r.body.id));
    assert.equal(orderIds.size, 1, 'all retries resolve to the same order');
    assert.equal(deps.repos.products.get('p-hoodie')!.inventory, 0, 'charged exactly once');
  } finally {
    await server.close();
  }
});
