import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps } from './test-helpers.js';

/**
 * Direct, store-level tests for the conditional-decrement primitive `reserve()`.
 * This pins the no-oversell guard on its own — without it, deleting the
 * `inventory >= quantity` check would leave the whole HTTP suite green (the
 * checkout path's validate-first check would still mask it). Runs against
 * whichever store STORE selects, so both memory and SQLite are covered.
 */
test('reserve() decrements only when stock suffices, and never mutates on failure', () => {
  const products = buildDeps().repos.products; // seeded: p-hoodie inventory 1
  assert.equal(products.get('p-hoodie')!.inventory, 1);

  // Over-request must fail AND leave inventory untouched (no negative, no partial).
  assert.equal(products.reserve('p-hoodie', 2), false);
  assert.equal(products.get('p-hoodie')!.inventory, 1);

  // Exact stock succeeds and decrements to 0.
  assert.equal(products.reserve('p-hoodie', 1), true);
  assert.equal(products.get('p-hoodie')!.inventory, 0);

  // Empty stock: any positive request fails, still no mutation.
  assert.equal(products.reserve('p-hoodie', 1), false);
  assert.equal(products.get('p-hoodie')!.inventory, 0);

  // Unknown product reserves nothing.
  assert.equal(products.reserve('nope', 1), false);
});

test('redeem() marks a coupon REDEEMED once and refuses a second redemption', () => {
  // Pins coupon single-use at the primitive level, deterministically, so it does
  // not depend on a rare cross-process interleaving to be exercised. (See the
  // multi-instance section of DECISIONS.md for why this matters.)
  const coupons = buildDeps().repos.coupons;
  coupons.save({
    code: 'ONCE',
    discountPercent: 10,
    milestone: 1,
    status: 'AVAILABLE',
    createdAt: new Date(0).toISOString(),
  });

  // First redemption wins and records the order.
  assert.equal(coupons.redeem('ONCE', 'order-A'), true);
  assert.equal(coupons.get('ONCE')!.status, 'REDEEMED');
  assert.equal(coupons.get('ONCE')!.redeemedByOrderId, 'order-A');

  // A second redemption (e.g. a racing checkout) loses and changes nothing.
  assert.equal(coupons.redeem('ONCE', 'order-B'), false);
  assert.equal(coupons.get('ONCE')!.redeemedByOrderId, 'order-A'); // not overwritten

  // Unknown coupon redeems nothing.
  assert.equal(coupons.redeem('nope', 'order-C'), false);
});
