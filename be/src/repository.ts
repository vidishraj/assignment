/**
 * Repository interfaces — the seam between domain logic and storage.
 *
 * Today these are backed by an in-memory store. Because the services depend on
 * these interfaces (not on the Maps), the same logic runs unchanged against a
 * real database later; the invariants that we enforce with a synchronous
 * critical section here become a transaction (conditional UPDATE / row lock)
 * there. That is the multi-instance story in DECISIONS.md.
 */
import type { Cart, Coupon, Order, Product } from './domain/types.js';

export interface ProductRepository {
  get(id: string): Product | undefined;
  list(): Product[];
  save(product: Product): void;
}

export interface CartRepository {
  get(id: string): Cart | undefined;
  save(cart: Cart): void;
}

export interface OrderRepository {
  get(id: string): Order | undefined;
  list(): Order[];
  save(order: Order): void;
  /** Number of successfully placed orders — drives the coupon milestone. */
  count(): number;
}

export interface CouponRepository {
  get(code: string): Coupon | undefined;
  list(): Coupon[];
  save(coupon: Coupon): void;
  /** The coupon minted for a given order milestone, if any (≤ 1 per milestone). */
  findByMilestone(milestone: number): Coupon | undefined;
}

export interface Repositories {
  products: ProductRepository;
  carts: CartRepository;
  orders: OrderRepository;
  coupons: CouponRepository;
}
