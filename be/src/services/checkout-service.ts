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
 */
import { randomUUID } from 'node:crypto';
import type { Order, OrderLine } from '../domain/types.js';
import { lineTotal, sumCents } from '../money.js';
import { AppError } from '../errors.js';
import type { Repositories } from '../repository.js';

export function makeCheckoutService(repos: Repositories) {
  function checkout(cartId: string): Order {
    const cart = repos.carts.get(cartId);
    if (!cart) throw new AppError('CART_NOT_FOUND', `no cart ${cartId}`, { cartId });

    // Idempotent retry: this cart already produced an order — return it.
    if (cart.status === 'CHECKED_OUT') {
      const existing = cart.orderId ? repos.orders.get(cart.orderId) : undefined;
      if (existing) return existing;
      // Shouldn't happen (checked-out carts always have an order), but fail loud.
      throw new AppError('CART_ALREADY_CHECKED_OUT', `cart ${cartId} is checked out`, { cartId });
    }

    if (cart.items.length === 0) {
      throw new AppError('CART_EMPTY', `cart ${cartId} has no items`, { cartId });
    }

    // 1) Validate everything first — no mutation yet.
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

    // 2) Reserve inventory (all items validated above → safe to commit all).
    for (const item of cart.items) {
      const product = repos.products.get(item.productId)!;
      product.inventory -= item.quantity;
      repos.products.save(product);
    }

    // 3) Create the immutable order. (Coupons/discounts arrive in a later step.)
    const subtotalCents = sumCents(lines.map((l) => l.lineTotalCents));
    const order: Order = {
      id: randomUUID(),
      cartId: cart.id,
      status: 'PLACED',
      lines,
      subtotalCents,
      discountCents: 0,
      totalCents: subtotalCents,
      createdAt: new Date().toISOString(),
    };
    repos.orders.save(order);

    // 4) Close the cart and link the order (enables the idempotent retry above).
    cart.status = 'CHECKED_OUT';
    cart.orderId = order.id;
    repos.carts.save(cart);

    return order;
  }

  return { checkout };
}

export type CheckoutService = ReturnType<typeof makeCheckoutService>;
