import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, buildDeps, startServer } from './test-helpers.js';
import type { AppDeps } from './app.js';
import type { CartView } from './services/cart-service.js';

/**
 * One randomised concurrency test. Fixed-fanout tests only probe interleavings we
 * thought of; this fires a random mix of concurrent operations each round and
 * asserts the INVARIANTS hold afterwards — the thing that can catch an
 * interleaving we didn't imagine. The seed is fixed so any failure is
 * reproducible; it is printed in every assertion message.
 */

// Deterministic PRNG (mulberry32) so runs are reproducible from the seed.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xc0ffee;

test('randomised concurrent interleavings preserve every invariant', async () => {
  const rnd = mulberry32(SEED);
  const int = (n: number) => Math.floor(rnd() * n);
  const deps = buildDeps({ milestoneInterval: 4, discountPercent: 15 });
  const server = await startServer(deps);
  const productIds = deps.repos.products.list().map((p) => p.id);
  const initial = new Map(deps.repos.products.list().map((p) => [p.id, p.inventory]));

  try {
    for (let round = 0; round < 12; round++) {
      // Build a pool of carts with random items (sequential — this is setup).
      const carts: string[] = [];
      for (let i = 0; i < 3 + int(4); i++) {
        const { body: cart } = await api<CartView>(server.baseUrl, 'POST', '/carts');
        for (let j = 0; j < 1 + int(2); j++) {
          await api(server.baseUrl, 'POST', `/carts/${cart.id}/items`, {
            productId: productIds[int(productIds.length)],
            quantity: 1 + int(2),
          });
        }
        carts.push(cart.id);
      }

      // Fire a random concurrent mix: checkouts (some using an available coupon),
      // coupon generations, and report reads — all racing in one Promise.all.
      const available = deps.repos.coupons
        .list()
        .filter((c) => c.status === 'AVAILABLE')
        .map((c) => c.code);
      const ops: Promise<unknown>[] = [];
      for (const id of carts) {
        if (rnd() < 0.85) {
          const body =
            available.length && rnd() < 0.4 ? { couponCode: available[int(available.length)] } : undefined;
          ops.push(api(server.baseUrl, 'POST', `/carts/${id}/checkout`, body));
        }
      }
      for (let k = 0; k < int(4); k++) {
        ops.push(
          rnd() < 0.5
            ? api(server.baseUrl, 'POST', '/admin/coupons')
            : api(server.baseUrl, 'GET', '/admin/report'),
        );
      }
      await Promise.all(ops);

      assertInvariants(deps, initial, round, await report(server.baseUrl));
    }
  } finally {
    await server.close();
  }
});

async function report(baseUrl: string) {
  const { body } = await api<{
    totalOrders: number;
    grossRevenueCents: number;
    totalDiscountsCents: number;
    netRevenueCents: number;
  }>(baseUrl, 'GET', '/admin/report');
  return body;
}

function assertInvariants(
  deps: AppDeps,
  initial: Map<string, number>,
  round: number,
  rep: { totalOrders: number; grossRevenueCents: number; totalDiscountsCents: number; netRevenueCents: number },
): void {
  const ctx = `seed=0x${SEED.toString(16)} round=${round}`;
  const orders = deps.repos.orders.list();

  // Conservation + non-negativity for every product.
  const sold = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.quantity);
  for (const p of deps.repos.products.list()) {
    assert.ok(p.inventory >= 0, `${ctx}: inventory negative for ${p.id}`);
    assert.equal((sold.get(p.id) ?? 0) + p.inventory, initial.get(p.id), `${ctx}: conservation ${p.id}`);
  }

  // Each coupon is in exactly one valid state, and REDEEMED iff used by exactly one order.
  const uses = orders.filter((o) => o.couponCode).map((o) => o.couponCode!);
  assert.equal(new Set(uses).size, uses.length, `${ctx}: a coupon was applied to more than one order`);
  for (const c of deps.repos.coupons.list()) {
    assert.ok(c.status === 'AVAILABLE' || c.status === 'REDEEMED', `${ctx}: invalid coupon status ${c.status}`);
    assert.equal(uses.filter((u) => u === c.code).length, c.status === 'REDEEMED' ? 1 : 0, `${ctx}: ${c.code} use≠status`);
  }

  // Report reconciles with the order ledger.
  const gross = orders.reduce((s, o) => s + o.subtotalCents, 0);
  const disc = orders.reduce((s, o) => s + o.discountCents, 0);
  const net = orders.reduce((s, o) => s + o.totalCents, 0);
  assert.equal(net, gross - disc, `${ctx}: net != gross - discounts`);
  assert.equal(rep.totalOrders, orders.length, `${ctx}: report totalOrders != orders placed`);
  assert.equal(rep.grossRevenueCents, gross, `${ctx}: report gross mismatch`);
  assert.equal(rep.totalDiscountsCents, disc, `${ctx}: report discounts mismatch`);
  assert.equal(rep.netRevenueCents, net, `${ctx}: report net mismatch`);
}
