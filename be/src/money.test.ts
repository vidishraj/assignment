import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCents, lineTotal, percentDiscount, sumCents } from './money.js';

test('lineTotal and sumCents stay exact in integer cents', () => {
  // Three items at 33 cents = 99, not 0.9899999… as floats might drift.
  assert.equal(lineTotal(33, 3), 99);
  assert.equal(sumCents([1999, 500, 1]), 2500);
  assert.equal(sumCents([]), 0);
});

test('percentDiscount rounds half-up and never exceeds the subtotal', () => {
  assert.equal(percentDiscount(1000, 10), 100); // 10% of $10.00
  assert.equal(percentDiscount(999, 10), 100); // 99.9 -> 100 (half-up)
  assert.equal(percentDiscount(994, 10), 99); // 99.4 -> 99
  assert.equal(percentDiscount(0, 10), 0);
  assert.equal(percentDiscount(1234, 0), 0);
  assert.equal(percentDiscount(1234, 100), 1234); // full discount, not more
});

test('percentDiscount is deterministic for the same inputs', () => {
  for (let i = 0; i < 5; i++) assert.equal(percentDiscount(1795, 15), percentDiscount(1795, 15));
});

test('assertCents rejects floats and negatives', () => {
  assert.equal(assertCents(500), 500);
  assert.throws(() => assertCents(5.5), /non-negative integer/);
  assert.throws(() => assertCents(-1), /non-negative integer/);
});
