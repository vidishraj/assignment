import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { CartView } from './services/cart-service.js';
import type { Order } from './domain/types.js';
import type { Coupon } from './domain/types.js';

/** Place one successful order (1 mug, always in stock) and return it. */
async function placeOrder(baseUrl: string): Promise<Order> {
  const { body: cart } = await api<CartView>(baseUrl, 'POST', '/carts');
  await api(baseUrl, 'POST', `/carts/${cart.id}/items`, { productId: 'p-mug', quantity: 1 });
  const { body: order } = await api<Order>(baseUrl, 'POST', `/carts/${cart.id}/checkout`);
  return order;
}

test('a coupon is generated only when an unrewarded milestone is reached', async () => {
  // n = 3, x = 10: a coupon becomes eligible after every 3rd placed order.
  const server = await startServer(buildDeps({ milestoneInterval: 3, discountPercent: 10 }));
  try {
    // Fewer than n orders → nothing eligible.
    await placeOrder(server.baseUrl);
    await placeOrder(server.baseUrl);
    const early = await api<{ error: { code: string } }>(server.baseUrl, 'POST', '/admin/coupons');
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'COUPON_NOT_ELIGIBLE');

    // The 3rd order reaches the first milestone → one coupon may be minted.
    await placeOrder(server.baseUrl);
    const minted = await api<Coupon>(server.baseUrl, 'POST', '/admin/coupons');
    assert.equal(minted.status, 201);
    assert.equal(minted.body.discountPercent, 10);
    assert.equal(minted.body.milestone, 3);
    assert.equal(minted.body.status, 'AVAILABLE');

    // Asking again without a new milestone must not mint a second coupon.
    const again = await api<{ error: { code: string } }>(server.baseUrl, 'POST', '/admin/coupons');
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'COUPON_NOT_ELIGIBLE');
  } finally {
    await server.close();
  }
});

test('concurrent admin generation cannot mint two coupons for one milestone', async () => {
  const server = await startServer(buildDeps({ milestoneInterval: 3, discountPercent: 10 }));
  try {
    for (let i = 0; i < 3; i++) await placeOrder(server.baseUrl); // exactly one milestone reached
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api<Coupon>(server.baseUrl, 'POST', '/admin/coupons')),
    );
    const minted = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(minted.length, 1, 'exactly one coupon minted for the single milestone');
    assert.equal(rejected.length, 4);
  } finally {
    await server.close();
  }
});
