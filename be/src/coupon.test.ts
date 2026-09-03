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

/** Reach the first milestone (n orders) and mint the coupon; return its code. */
async function mintCoupon(baseUrl: string, n = 3): Promise<string> {
  for (let i = 0; i < n; i++) await placeOrder(baseUrl);
  const { body } = await api<Coupon>(baseUrl, 'POST', '/admin/coupons');
  return body.code;
}

/** Create a cart containing `quantity` of `productId`; return the cart id. */
async function cartWith(baseUrl: string, productId: string, quantity: number): Promise<string> {
  const { body: cart } = await api<CartView>(baseUrl, 'POST', '/carts');
  await api(baseUrl, 'POST', `/carts/${cart.id}/items`, { productId, quantity });
  return cart.id;
}

test('a valid coupon discounts the order deterministically and redeems once', async () => {
  const deps = buildDeps({ milestoneInterval: 3, discountPercent: 10 });
  const server = await startServer(deps);
  try {
    const code = await mintCoupon(server.baseUrl);
    const cartId = await cartWith(server.baseUrl, 'p-mug', 2); // 2 × 1299 = 2598
    const { status, body: order } = await api<Order>(
      server.baseUrl,
      'POST',
      `/carts/${cartId}/checkout`,
      { couponCode: code },
    );
    assert.equal(status, 201);
    assert.equal(order.subtotalCents, 2598);
    assert.equal(order.discountCents, 260); // round-half-up of 259.8
    assert.equal(order.totalCents, 2338);
    assert.equal(order.couponCode, code);
    // The coupon is now spent.
    assert.equal(deps.repos.coupons.get(code)!.status, 'REDEEMED');
    assert.equal(deps.repos.coupons.get(code)!.redeemedByOrderId, order.id);
  } finally {
    await server.close();
  }
});

test('a coupon is NOT consumed by a checkout that ultimately fails', async () => {
  const deps = buildDeps({ milestoneInterval: 3, discountPercent: 10 });
  const server = await startServer(deps);
  try {
    const code = await mintCoupon(server.baseUrl);
    // Cart asks for more hoodies than exist (inv 1) → checkout fails on inventory.
    const doomed = await cartWith(server.baseUrl, 'p-hoodie', 2);
    const failed = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${doomed}/checkout`,
      { couponCode: code },
    );
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, 'INSUFFICIENT_INVENTORY');
    // The coupon must still be available for a subsequent, valid checkout.
    assert.equal(deps.repos.coupons.get(code)!.status, 'AVAILABLE');
    const good = await cartWith(server.baseUrl, 'p-mug', 1);
    const ok = await api<Order>(server.baseUrl, 'POST', `/carts/${good}/checkout`, { couponCode: code });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.discountCents, 130); // 10% of 1299 = 129.9 → 130
    assert.equal(deps.repos.coupons.get(code)!.status, 'REDEEMED');
  } finally {
    await server.close();
  }
});

test('invalid and already-redeemed coupons are distinguishable errors', async () => {
  const server = await startServer(buildDeps({ milestoneInterval: 3, discountPercent: 10 }));
  try {
    const unknown = await cartWith(server.baseUrl, 'p-mug', 1);
    const bad = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${unknown}/checkout`,
      { couponCode: 'NOPE' },
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'COUPON_INVALID');

    const code = await mintCoupon(server.baseUrl);
    const first = await cartWith(server.baseUrl, 'p-mug', 1);
    await api(server.baseUrl, 'POST', `/carts/${first}/checkout`, { couponCode: code });
    const second = await cartWith(server.baseUrl, 'p-mug', 1);
    const reused = await api<{ error: { code: string } }>(
      server.baseUrl,
      'POST',
      `/carts/${second}/checkout`,
      { couponCode: code },
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, 'COUPON_ALREADY_REDEEMED');
  } finally {
    await server.close();
  }
});

test('one coupon cannot be redeemed by two concurrent checkouts', async () => {
  const deps = buildDeps({ milestoneInterval: 3, discountPercent: 10 });
  const server = await startServer(deps);
  try {
    const code = await mintCoupon(server.baseUrl);
    // Two independent carts race to redeem the same single coupon.
    const cartA = await cartWith(server.baseUrl, 'p-mug', 1);
    const cartB = await cartWith(server.baseUrl, 'p-tee', 1);
    const results = await Promise.all([
      api<Order | { error: { code: string } }>(server.baseUrl, 'POST', `/carts/${cartA}/checkout`, { couponCode: code }),
      api<Order | { error: { code: string } }>(server.baseUrl, 'POST', `/carts/${cartB}/checkout`, { couponCode: code }),
    ]);
    const redeemed = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(redeemed.length, 1, 'exactly one checkout redeems the coupon');
    assert.equal(rejected.length, 1, 'the other is rejected as already redeemed');
    assert.equal(deps.repos.coupons.get(code)!.status, 'REDEEMED');
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
