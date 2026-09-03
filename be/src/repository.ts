/**
 * Repository interfaces — the seam between domain logic and storage.
 *
 * Today these are backed by an in-memory store. Because the services depend on
 * these interfaces (not on the Maps), the same logic runs unchanged against a
 * real database later; the invariants that we enforce with a synchronous
 * critical section here become a transaction (conditional UPDATE / row lock)
 * there. That is the multi-instance story in DECISIONS.md.
 */
import type { Cart, Coupon, IdempotencyRecord, Order, Product } from './domain/types.js';

export interface ProductRepository {
  get(id: string): Product | undefined;
  list(): Product[];
  save(product: Product): void;
  /**
   * Atomically decrement inventory iff at least `quantity` is in stock; returns
   * whether it succeeded. This is the conditional-decrement primitive the
   * multi-instance design relies on: in SQL it is
   * `UPDATE products SET inventory = inventory - :q WHERE id = :id AND inventory >= :q`
   * with "0 rows affected" meaning insufficient stock. In memory it is the same
   * check-and-decrement, made atomic by the single-threaded event loop.
   */
  reserve(productId: string, quantity: number): boolean;
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
  /**
   * Atomically mark a coupon REDEEMED iff it is currently AVAILABLE; returns
   * whether it won. This is the coupon analogue of `products.reserve` — it turns
   * redemption from a read-then-write ACROSS statements into a single conditional
   * write (`UPDATE … WHERE status = 'AVAILABLE'`, 0 rows ⇒ already redeemed), so
   * single-use is atomic per statement and does not hinge on the surrounding
   * transaction to win a cross-process race.
   */
  redeem(code: string, orderId: string): boolean;
}

export interface IdempotencyRepository {
  get(key: string): IdempotencyRecord | undefined;
  save(record: IdempotencyRecord): void;
}

export interface Repositories {
  products: ProductRepository;
  carts: CartRepository;
  orders: OrderRepository;
  coupons: CouponRepository;
  idempotency: IdempotencyRepository;
  /**
   * Run `fn` as one atomic unit. For the in-memory store this just calls `fn`
   * (a synchronous function is already atomic under Node's event loop). For a
   * real database it is a transaction — the SQLite store runs it inside
   * `BEGIN IMMEDIATE … COMMIT`, rolling back if `fn` throws. `fn` must stay
   * synchronous (no `await`), which is what keeps the checkout critical section
   * atomic in both stores.
   */
  transaction<T>(fn: () => T): T;
}
