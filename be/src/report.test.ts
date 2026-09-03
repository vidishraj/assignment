import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { CartView } from './services/cart-service.js';
import type { Report } from './services/report-service.js';
import type { Coupon, Order } from './domain/types.js';

async function cartWith(baseUrl: string, productId: string, quantity: number): Promise<string> {
  const { body: cart } = await api<CartView>(baseUrl, 'POST', '/carts');
  await api(baseUrl, 'POST', `/carts/${cart.id}/items`, { productId, quantity });
  return cart.id;
}

test('report reconciles orders, revenue, and coupons — and does not mutate', async () => {
  const server = await startServer(buildDeps({ milestoneInterval: 3, discountPercent: 10 }));
  try {
    // Three plain orders: 1 mug each (1299), reaching the first milestone.
    for (let i = 0; i < 3; i++) {
      const id = await cartWith(server.baseUrl, 'p-mug', 1);
      await api<Order>(server.baseUrl, 'POST', `/carts/${id}/checkout`);
    }
    // Mint the milestone coupon and redeem it on a 4th order (2 mugs = 2598).
    const { body: coupon } = await api<Coupon>(server.baseUrl, 'POST', '/admin/coupons');
    const discounted = await cartWith(server.baseUrl, 'p-mug', 2);
    await api<Order>(server.baseUrl, 'POST', `/carts/${discounted}/checkout`, {
      couponCode: coupon.code,
    });

    const { status, body: report } = await api<Report>(server.baseUrl, 'GET', '/admin/report');
    assert.equal(status, 200);
    assert.equal(report.totalOrders, 4);
    assert.equal(report.purchasedByProduct['p-mug'], 5); // 1+1+1+2
    assert.equal(report.grossRevenueCents, 6495); // 3×1299 + 2598
    assert.equal(report.totalDiscountsCents, 260); // 10% of 2598, round-half-up
    assert.equal(report.netRevenueCents, 6235); // 6495 − 260
    // The identity must hold exactly.
    assert.equal(report.netRevenueCents, report.grossRevenueCents - report.totalDiscountsCents);
    assert.deepEqual(report.coupons, { generated: 1, available: 0, redeemed: 1 });

    // Repeated report requests must not mutate state — same result twice.
    const { body: again } = await api<Report>(server.baseUrl, 'GET', '/admin/report');
    assert.deepEqual(again, report);
  } finally {
    await server.close();
  }
});
