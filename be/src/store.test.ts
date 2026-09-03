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
