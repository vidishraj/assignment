/**
 * Core domain entities. Money fields are integer cents (see money.ts).
 *
 * The important design point is the order snapshot: an Order copies the product
 * name and unit price into its lines at checkout time, so an order still
 * explains exactly what was bought and how the total was computed even after a
 * product's price or name later changes.
 */
import type { Cents } from '../money.js';

export interface Product {
  id: string;
  name: string;
  unitPriceCents: Cents;
  /** Units available to sell. Decremented atomically at checkout. */
  inventory: number;
}

export type CartStatus = 'OPEN' | 'CHECKED_OUT';

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  id: string;
  status: CartStatus;
  items: CartItem[];
  createdAt: string;
  /** Set once the cart is checked out — links to the resulting order (idempotency). */
  orderId?: string;
}

/**
 * A line on a placed order: an IMMUTABLE snapshot of what was purchased. It
 * copies the product's name and unit price at checkout so the order is
 * self-explanatory regardless of later product changes.
 */
export interface OrderLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitPriceCents: Cents;
  readonly quantity: number;
  readonly lineTotalCents: Cents;
}

export type OrderStatus = 'PLACED';

export interface Order {
  readonly id: string;
  readonly cartId: string;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLine[];
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly totalCents: Cents;
  /** The coupon code redeemed on this order, if any. */
  readonly couponCode?: string;
  readonly createdAt: string;
}

/**
 * A stored idempotency-key result. The key lets a client that lost the response
 * and started a NEW cart safely retry: the same key returns the same order rather
 * than placing a second one. We store the order id (the order itself is immutable,
 * so re-fetching it yields an identical response) plus a fingerprint of the
 * request, so the same key with a DIFFERENT request is rejected rather than
 * silently returning the wrong order.
 */
export interface IdempotencyRecord {
  key: string;
  orderId: string;
  requestFingerprint: string;
  httpStatus: number;
  createdAt: string;
}

export type CouponStatus = 'AVAILABLE' | 'REDEEMED';

export interface Coupon {
  code: string;
  discountPercent: number;
  /**
   * The order milestone this coupon rewards (e.g. the 5th order → milestone 5).
   * At most one coupon exists per milestone: the coupon service only mints when
   * the number of reached milestones exceeds the number already generated.
   */
  milestone: number;
  status: CouponStatus;
  /** The order that redeemed it, once redeemed. */
  redeemedByOrderId?: string;
  createdAt: string;
}
