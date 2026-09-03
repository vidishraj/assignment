/**
 * SQLite implementation of the repository interfaces, backed by better-sqlite3.
 *
 * The point of this store is to make the multi-instance claims in DECISIONS.md
 * EXECUTABLE rather than aspirational: the checkout critical section runs inside
 * a real `BEGIN IMMEDIATE` transaction, inventory is taken with the documented
 * conditional decrement (`… WHERE inventory >= :qty`), and the one-order-per-cart
 * and one-coupon-per-milestone invariants are backed by real `UNIQUE` constraints.
 * The SAME service code and the SAME test suite run against this store.
 *
 * better-sqlite3 is a SYNCHRONOUS, native module. It is an OPTIONAL dependency:
 * we load it lazily via `createRequire` so the default (in-memory) path never
 * imports it, `npm ci` still succeeds when the native module can't be built, and
 * `npm run typecheck`/`build` do not depend on its types. `createSqliteRepositories`
 * throws if the module is absent; the SQLite test runner turns that into a skip.
 */
import { createRequire } from 'node:module';
import type { Coupon, Order, OrderLine, Product } from '../domain/types.js';
import type {
  CartRepository,
  CouponRepository,
  OrderRepository,
  ProductRepository,
  Repositories,
} from '../repository.js';

const SCHEMA = `
CREATE TABLE products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, inventory INTEGER NOT NULL
);
CREATE TABLE carts (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, order_id TEXT
);
CREATE TABLE cart_items (
  cart_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity INTEGER NOT NULL,
  PRIMARY KEY (cart_id, product_id)
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, cart_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
  coupon_code TEXT, created_at TEXT NOT NULL
);
CREATE TABLE order_lines (
  order_id TEXT NOT NULL, seq INTEGER NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, line_total_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, seq)
);
CREATE TABLE coupons (
  code TEXT PRIMARY KEY, discount_percent INTEGER NOT NULL, milestone INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL, redeemed_by_order_id TEXT, created_at TEXT NOT NULL
);
`;

/**
 * Open an in-memory SQLite database and return repositories over it. In-memory
 * (`:memory:`) keeps tests isolated and dependency-free at rest; a file path
 * would be a one-line change.
 */
export function createSqliteRepositories(filename = ':memory:'): Repositories {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as new (f: string) => SqliteDb;
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const products: ProductRepository = {
    get(id) {
      return toProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    },
    list() {
      return db.prepare('SELECT * FROM products').all().map(toProduct) as Product[];
    },
    save(product) {
      db.prepare(
        `INSERT INTO products (id, name, unit_price_cents, inventory) VALUES (@id, @name, @unitPriceCents, @inventory)
         ON CONFLICT(id) DO UPDATE SET name=@name, unit_price_cents=@unitPriceCents, inventory=@inventory`,
      ).run(product);
    },
    reserve(productId, quantity) {
      const info = db
        .prepare('UPDATE products SET inventory = inventory - ? WHERE id = ? AND inventory >= ?')
        .run(quantity, productId, quantity);
      return info.changes > 0;
    },
  };

  const carts: CartRepository = {
    get(id) {
      const row = db.prepare('SELECT * FROM carts WHERE id = ?').get(id);
      if (!row) return undefined;
      const items = db
        .prepare('SELECT product_id, quantity FROM cart_items WHERE cart_id = ?')
        .all(id)
        .map((r: SqliteRow) => ({ productId: r.product_id, quantity: r.quantity }));
      return {
        id: row.id,
        status: row.status,
        items,
        createdAt: row.created_at,
        ...(row.order_id ? { orderId: row.order_id } : {}),
      };
    },
    save(cart) {
      db.prepare(
        `INSERT INTO carts (id, status, created_at, order_id) VALUES (@id, @status, @createdAt, @orderId)
         ON CONFLICT(id) DO UPDATE SET status=@status, order_id=@orderId`,
      ).run({ id: cart.id, status: cart.status, createdAt: cart.createdAt, orderId: cart.orderId ?? null });
      // Replace the item set so the row state matches the domain object exactly.
      db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);
      const insert = db.prepare(
        'INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)',
      );
      for (const item of cart.items) insert.run(cart.id, item.productId, item.quantity);
    },
  };

  const orders: OrderRepository = {
    get(id) {
      return loadOrder(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
    },
    list() {
      return db
        .prepare('SELECT * FROM orders')
        .all()
        .map((row: SqliteRow) => loadOrder(db, row)!);
    },
    save(order) {
      db.prepare(
        `INSERT INTO orders (id, cart_id, status, subtotal_cents, discount_cents, total_cents, coupon_code, created_at)
         VALUES (@id, @cartId, @status, @subtotalCents, @discountCents, @totalCents, @couponCode, @createdAt)`,
      ).run({
        id: order.id,
        cartId: order.cartId,
        status: order.status,
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        couponCode: order.couponCode ?? null,
        createdAt: order.createdAt,
      });
      const insert = db.prepare(
        `INSERT INTO order_lines (order_id, seq, product_id, product_name, unit_price_cents, quantity, line_total_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      order.lines.forEach((l, seq) =>
        insert.run(order.id, seq, l.productId, l.productName, l.unitPriceCents, l.quantity, l.lineTotalCents),
      );
    },
    count() {
      return (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as SqliteRow).n;
    },
  };

  const coupons: CouponRepository = {
    get(code) {
      return toCoupon(db.prepare('SELECT * FROM coupons WHERE code = ?').get(code));
    },
    list() {
      return db.prepare('SELECT * FROM coupons').all().map(toCoupon) as Coupon[];
    },
    save(coupon) {
      db.prepare(
        `INSERT INTO coupons (code, discount_percent, milestone, status, redeemed_by_order_id, created_at)
         VALUES (@code, @discountPercent, @milestone, @status, @redeemedByOrderId, @createdAt)
         ON CONFLICT(code) DO UPDATE SET status=@status, redeemed_by_order_id=@redeemedByOrderId`,
      ).run({
        code: coupon.code,
        discountPercent: coupon.discountPercent,
        milestone: coupon.milestone,
        status: coupon.status,
        redeemedByOrderId: coupon.redeemedByOrderId ?? null,
        createdAt: coupon.createdAt,
      });
    },
  };

  return {
    products,
    carts,
    orders,
    coupons,
    // Real transaction: BEGIN IMMEDIATE takes the write lock up front, so the
    // synchronous critical section runs with no interleaving and rolls back if
    // it throws. Same call site as the in-memory no-op wrapper.
    transaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate() as T;
    },
  };
}

// --- row → domain mappers -------------------------------------------------

function toProduct(row: SqliteRow | undefined): Product | undefined {
  if (!row) return undefined;
  return { id: row.id, name: row.name, unitPriceCents: row.unit_price_cents, inventory: row.inventory };
}

function toCoupon(row: SqliteRow | undefined): Coupon | undefined {
  if (!row) return undefined;
  return {
    code: row.code,
    discountPercent: row.discount_percent,
    milestone: row.milestone,
    status: row.status,
    ...(row.redeemed_by_order_id ? { redeemedByOrderId: row.redeemed_by_order_id } : {}),
    createdAt: row.created_at,
  };
}

function loadOrder(db: SqliteDb, row: SqliteRow | undefined): Order | undefined {
  if (!row) return undefined;
  const lines: OrderLine[] = db
    .prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY seq')
    .all(row.id)
    .map((l: SqliteRow) => ({
      productId: l.product_id,
      productName: l.product_name,
      unitPriceCents: l.unit_price_cents,
      quantity: l.quantity,
      lineTotalCents: l.line_total_cents,
    }));
  return {
    id: row.id,
    cartId: row.cart_id,
    status: row.status,
    lines,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    ...(row.coupon_code ? { couponCode: row.coupon_code } : {}),
    createdAt: row.created_at,
  };
}

// Minimal structural types for the parts of better-sqlite3 we use, so this file
// typechecks without the module's `@types` present.
type SqliteRow = Record<string, string | number | null> & { [k: string]: any };
interface SqliteStatement {
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
  run(...params: unknown[]): { changes: number };
}
interface SqliteTransaction<T> {
  immediate(...args: unknown[]): T;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<T>(fn: () => T): SqliteTransaction<T>;
}
