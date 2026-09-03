/**
 * Checkout — the correctness-critical path.
 *
 * CONCURRENCY MODEL: `checkout` is fully SYNCHRONOUS (no `await` between reading
 * inventory and committing the order). Under Node's single-threaded event loop
 * a synchronous function runs to completion without interleaving, so two
 * "concurrent" checkout requests execute one-after-another here — the second
 * only starts after the first has already decremented inventory. That is why
 * concurrent checkouts cannot oversell. With a real database and multiple
 * instances this same section becomes one transaction using a conditional
 * inventory decrement (or row lock); the repository interface is where that
 * swap happens. (See DECISIONS.md.)
 *
 * IDEMPOTENCY: the cart is the idempotency unit. A cart checks out at most once;
 * checking out an already-checked-out cart returns the SAME order instead of
 * creating a new one or charging inventory twice — which is exactly what a
 * timed-out client's retry needs.
 *
 * ATOMICITY: all items are validated BEFORE any inventory is decremented, so a
 * failed checkout leaves inventory untouched (all-or-nothing reservation).
 *
 * COUPONS: an optional coupon is validated (exists + still AVAILABLE) in the same
 * read-only phase as inventory, and only marked REDEEMED in the mutation phase
 * once everything has passed. So a checkout that fails on inventory never
 * consumes the coupon (it stays AVAILABLE for a retry), and because the whole
 * section is synchronous, two concurrent checkouts cannot both redeem it — the
 * second sees REDEEMED and is rejected.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Coupon, Order, OrderLine } from '../domain/types.js';
import { lineTotal, percentDiscount, sumCents } from '../money.js';
import { AppError } from '../errors.js';
import type { Repositories } from '../repository.js';

/** What checkout returns: the order and the HTTP status the edge should send. */
export interface CheckoutOutcome {
  order: Order;
  /** 201 first placement, 200 idempotent replay (cart- or key-based). */
  status: number;
}

/** Stable fingerprint of the checkout request, so a reused key with a different
 * request is caught rather than served the wrong stored order. */
function fingerprint(cartId: string, couponCode?: string): string {
  return createHash('sha256').update(`${cartId}\n${couponCode ?? ''}`).digest('hex');
}

export function makeCheckoutService(repos: Repositories) {
  // The whole critical section — idempotency-key lookup, checkout, and key
  // store — runs inside ONE transaction: a no-op wrapper for the in-memory store
  // (the event loop already serialises it) and a real BEGIN IMMEDIATE for SQLite.
  // Everything stays synchronous, so there is no suspension point and two
  // concurrent same-key requests cannot both execute.
  function checkout(cartId: string, couponCode?: string, idempotencyKey?: string): CheckoutOutcome {
    return repos.transaction(() => {
      // Idempotency-Key layer: cross-cart retry safety. (The cart layer below
      // still handles same-cart replays.)
      if (idempotencyKey !== undefined) {
        const fp = fingerprint(cartId, couponCode);
        const seen = repos.idempotency.get(idempotencyKey);
        if (seen) {
          if (seen.requestFingerprint !== fp) {
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'this Idempotency-Key was already used for a different request',
              { idempotencyKey },
            );
          }
          const order = repos.orders.get(seen.orderId);
          // A replay creates nothing, so it is 200 (not 201) — the same answer the
          // cart layer gives, so both idempotency layers tell one story.
          if (order) return { order, status: 200 };
          // Record without a live order shouldn't happen; fall through to re-run.
        }
        const outcome = runCheckout(cartId, couponCode);
        repos.idempotency.save({
          key: idempotencyKey,
          orderId: outcome.order.id,
          requestFingerprint: fp,
          createdAt: new Date().toISOString(),
        });
        return outcome;
      }
      return runCheckout(cartId, couponCode);
    });
  }

  function runCheckout(cartId: string, couponCode?: string): CheckoutOutcome {
    const cart = repos.carts.get(cartId);
    if (!cart) throw new AppError('CART_NOT_FOUND', `no cart ${cartId}`, { cartId });

    // Idempotent retry: this cart already produced an order — return it (200).
    if (cart.status === 'CHECKED_OUT') {
      const existing = cart.orderId ? repos.orders.get(cart.orderId) : undefined;
      if (existing) return { order: existing, status: 200 };
      // Shouldn't happen (checked-out carts always have an order), but fail loud.
      throw new AppError('CART_ALREADY_CHECKED_OUT', `cart ${cartId} is checked out`, { cartId });
    }

    if (cart.items.length === 0) {
      throw new AppError('CART_EMPTY', `cart ${cartId} has no items`, { cartId });
    }

    // 1a) Validate the coupon (read-only). Redemption happens later, only if the
    //     whole checkout succeeds — a failed checkout must not consume it.
    let coupon: Coupon | undefined;
    if (couponCode !== undefined) {
      const found = repos.coupons.get(couponCode);
      if (!found) {
        throw new AppError('COUPON_INVALID', `no coupon ${couponCode}`, { couponCode });
      }
      if (found.status !== 'AVAILABLE') {
        throw new AppError('COUPON_ALREADY_REDEEMED', `coupon ${couponCode} was already redeemed`, {
          couponCode,
          redeemedByOrderId: found.redeemedByOrderId,
        });
      }
      coupon = found;
    }

    // 1b) Validate everything first — no mutation yet.
    const lines: OrderLine[] = cart.items.map((item) => {
      const product = repos.products.get(item.productId);
      if (!product) {
        throw new AppError('PRODUCT_NOT_FOUND', `no product ${item.productId}`, {
          productId: item.productId,
        });
      }
      if (item.quantity > product.inventory) {
        throw new AppError(
          'INSUFFICIENT_INVENTORY',
          `only ${product.inventory} of ${product.name} available, requested ${item.quantity}`,
          { productId: product.id, requested: item.quantity, available: product.inventory },
        );
      }
      // Snapshot name + unit price now, so the order self-explains later.
      return {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: lineTotal(product.unitPriceCents, item.quantity),
      };
    });

    // Everything above is read-only. From here on we mutate — all validation has
    // passed, so these steps cannot fail on business rules.

    const orderId = randomUUID();
    const subtotalCents = sumCents(lines.map((l) => l.lineTotalCents));
    const discountCents = coupon ? percentDiscount(subtotalCents, coupon.discountPercent) : 0;

    // 2) Reserve inventory via the conditional-decrement primitive
    //    (`… WHERE inventory >= qty`). Validation above guarantees success, so the
    //    guard is defensive — but under a real database it is exactly the line
    //    that turns a lost concurrent race into a clean rejection.
    for (const item of cart.items) {
      if (!repos.products.reserve(item.productId, item.quantity)) {
        throw new AppError('INSUFFICIENT_INVENTORY', `insufficient inventory for ${item.productId}`, {
          productId: item.productId,
        });
      }
    }

    // 3) Redeem the coupon via the atomic conditional primitive (mirrors
    //    `reserve()`): a single `UPDATE … WHERE status = 'AVAILABLE'`. Validation
    //    above already checked availability, so the guard is defensive in one
    //    process — but under real cross-process contention it is what makes
    //    single-use atomic per statement rather than a read-then-write race.
    if (coupon && !repos.coupons.redeem(coupon.code, orderId)) {
      throw new AppError('COUPON_ALREADY_REDEEMED', `coupon ${coupon.code} was already redeemed`, {
        couponCode: coupon.code,
      });
    }

    // 4) Create the immutable order.
    const order: Order = {
      id: orderId,
      cartId: cart.id,
      status: 'PLACED',
      lines,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      ...(coupon ? { couponCode: coupon.code } : {}),
      createdAt: new Date().toISOString(),
    };
    repos.orders.save(order);

    // 5) Close the cart and link the order (enables the idempotent retry above).
    cart.status = 'CHECKED_OUT';
    cart.orderId = order.id;
    repos.carts.save(cart);

    return { order, status: 201 };
  }

  return { checkout };
}

export type CheckoutService = ReturnType<typeof makeCheckoutService>;
