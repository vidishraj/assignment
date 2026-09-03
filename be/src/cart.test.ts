import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { CartView } from './services/cart-service.js';

test('create → add → view computes totals in integer cents', async () => {
  const server = await startServer();
  try {
    const created = await api<CartView>(server.baseUrl, 'POST', '/carts');
    assert.equal(created.status, 201);
    assert.equal(created.body.subtotalCents, 0);
    const cartId = created.body.id;

    // 2 mugs @ 1299 + 3 stickers @ 499 = 2598 + 1497 = 4095.
    await api(server.baseUrl, 'POST', `/carts/${cartId}/items`, { productId: 'p-mug', quantity: 2 });
    const view = await api<CartView>(server.baseUrl, 'POST', `/carts/${cartId}/items`, {
      productId: 'p-sticker',
      quantity: 3,
    });
    assert.equal(view.status, 200);
    assert.equal(view.body.items.length, 2);
    assert.equal(view.body.subtotalCents, 4095);
    const mug = view.body.items.find((i) => i.productId === 'p-mug')!;
    assert.equal(mug.lineTotalCents, 2598);
  } finally {
    await server.close();
  }
});

test('adding the same product accumulates quantity', async () => {
  const server = await startServer();
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-mug', quantity: 1 });
    const view = await api<CartView>(server.baseUrl, 'POST', `/carts/${cart.id}/items`, {
      productId: 'p-mug',
      quantity: 2,
    });
    assert.equal(view.body.items[0].quantity, 3);
  } finally {
    await server.close();
  }
});

test('cart prices track live product price (not frozen until checkout)', async () => {
  const deps = buildDeps();
  const server = await startServer(deps);
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-mug', quantity: 1 });
    // Price changes after the item was added but before checkout.
    const mug = deps.repos.products.get('p-mug')!;
    deps.repos.products.save({ ...mug, unitPriceCents: 1500 });
    const view = await api<CartView>(server.baseUrl, 'GET', `/carts/${cart.id}`);
    assert.equal(view.body.items[0].unitPriceCents, 1500);
    assert.equal(view.body.subtotalCents, 1500);
  } finally {
    await server.close();
  }
});

test('update quantity and remove item', async () => {
  const server = await startServer();
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-cap', quantity: 1 });
    const updated = await api<CartView>(server.baseUrl, 'PUT', `/carts/${cart.id}/items/p-cap`, {
      quantity: 4,
    });
    assert.equal(updated.body.items[0].quantity, 4);
    const removed = await api<CartView>(server.baseUrl, 'DELETE', `/carts/${cart.id}/items/p-cap`);
    assert.equal(removed.body.items.length, 0);
  } finally {
    await server.close();
  }
});

test('quantity is bounded so a cart line total stays a safe integer', async () => {
  const server = await startServer();
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');

    // One absurd request: passes the positive-integer check but must be capped,
    // otherwise the line total exceeds 2^53 and the integer-cents invariant breaks.
    const huge = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/items`,
      { productId: 'p-mug', quantity: 1e15 },
    );
    assert.equal(huge.status, 422);
    assert.equal(huge.body.error.code, 'QUANTITY_LIMIT_EXCEEDED');

    // The cap applies to the ACCUMULATED quantity, not just a single request:
    // 600 then another 600 = 1200 > 1000 must be rejected, and the earlier 600
    // must remain intact (rejected add is a no-op).
    await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-mug', quantity: 600 });
    const overflow = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/items`,
      { productId: 'p-mug', quantity: 600 },
    );
    assert.equal(overflow.status, 422);
    assert.equal(overflow.body.error.code, 'QUANTITY_LIMIT_EXCEEDED');
    const view = await api<CartView>(server.baseUrl, 'GET', `/carts/${cart.id}`);
    assert.equal(view.body.items[0].quantity, 600);
    assert.equal(Number.isSafeInteger(view.body.subtotalCents), true);
  } finally {
    await server.close();
  }
});

test('validation: bad quantity, unknown product, unknown cart, item not in cart', async () => {
  const server = await startServer();
  try {
    const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');

    const badQty = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/items`,
      { productId: 'p-mug', quantity: 0 },
    );
    assert.equal(badQty.status, 400);
    assert.equal(badQty.body.error.code, 'INVALID_QUANTITY');

    const noProduct = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${cart.id}/items`,
      { productId: 'nope', quantity: 1 },
    );
    assert.equal(noProduct.status, 404);
    assert.equal(noProduct.body.error.code, 'PRODUCT_NOT_FOUND');

    const noCart = await api<{ error: { code: string } }>(server.baseUrl, 'GET', '/carts/missing');
    assert.equal(noCart.status, 404);
    assert.equal(noCart.body.error.code, 'CART_NOT_FOUND');

    const notInCart = await api<{ error: { code: string } }>(
      server.baseUrl,
      'DELETE',
      `/carts/${cart.id}/items/p-mug`,
    );
    assert.equal(notInCart.status, 404);
    assert.equal(notInCart.body.error.code, 'ITEM_NOT_IN_CART');
  } finally {
    await server.close();
  }
});
