/**
 * In-memory implementation of the repositories, backed by plain Maps.
 *
 * Objects are stored by reference: a `get` returns the live entity and the
 * service mutates it inside a synchronous critical section, which is atomic
 * under Node's single-threaded event loop. This is deliberate — it keeps the
 * concurrency reasoning explicit and small, and maps cleanly onto a DB
 * transaction when the store is swapped.
 */
import type { Cart, Coupon, Order, Product } from '../domain/types.js';
import type {
  CartRepository,
  CouponRepository,
  OrderRepository,
  ProductRepository,
  Repositories,
} from '../repository.js';

class MemoryProductRepository implements ProductRepository {
  private readonly byId = new Map<string, Product>();
  get(id: string) {
    return this.byId.get(id);
  }
  list() {
    return [...this.byId.values()];
  }
  save(product: Product) {
    this.byId.set(product.id, product);
  }
  reserve(productId: string, quantity: number) {
    const product = this.byId.get(productId);
    if (!product || product.inventory < quantity) return false;
    product.inventory -= quantity;
    return true;
  }
}

class MemoryCartRepository implements CartRepository {
  private readonly byId = new Map<string, Cart>();
  get(id: string) {
    return this.byId.get(id);
  }
  save(cart: Cart) {
    this.byId.set(cart.id, cart);
  }
}

class MemoryOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, Order>();
  get(id: string) {
    return this.byId.get(id);
  }
  list() {
    return [...this.byId.values()];
  }
  save(order: Order) {
    this.byId.set(order.id, order);
  }
  count() {
    return this.byId.size;
  }
}

class MemoryCouponRepository implements CouponRepository {
  private readonly byCode = new Map<string, Coupon>();
  get(code: string) {
    return this.byCode.get(code);
  }
  list() {
    return [...this.byCode.values()];
  }
  save(coupon: Coupon) {
    this.byCode.set(coupon.code, coupon);
  }
}

export function createMemoryRepositories(): Repositories {
  return {
    products: new MemoryProductRepository(),
    carts: new MemoryCartRepository(),
    orders: new MemoryOrderRepository(),
    coupons: new MemoryCouponRepository(),
    // A synchronous function is already atomic under the event loop, so the
    // in-memory "transaction" is just running it. (The SQLite store wraps this
    // in BEGIN IMMEDIATE — same call site, real transactional semantics there.)
    transaction<T>(fn: () => T): T {
      return fn();
    },
  };
}
