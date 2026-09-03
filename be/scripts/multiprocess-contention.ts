/**
 * Multi-PROCESS contention proof.
 *
 * The in-process suite proves the seam and the transaction shape, but it runs in
 * ONE process against `:memory:`, so it exercises event-loop serialisation, not
 * real OS-level lock contention. This script closes that gap: it spawns N SEPARATE
 * node processes, each with its own connection to ONE shared SQLite FILE, all
 * hammering checkout against a deliberately scarce product (and racing for one
 * coupon). Then, from a FRESH connection, it asserts the invariants held under
 * genuine BEGIN IMMEDIATE contention:
 *   - sold + remaining == initial (conservation across processes)
 *   - inventory never negative
 *   - order count == successful checkouts
 *   - the shared coupon was redeemed exactly once
 *
 * Optional, like test:sqlite: if better-sqlite3 isn't installed it skips cleanly.
 * Not in the default `npm test` (slower, process-spawning).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteRepositories } from '../src/store/sqlite.js';
import { seedProducts } from '../src/seed.js';

const N = 4; // worker processes
const SCARCE_STOCK = 50; // units of the scarce product
const SCARCE_ATTEMPTS = 40; // per worker → 160 attempts for 50 units
const COUPON_ATTEMPTS = 12; // per worker → 48 racers for ONE coupon
const ABUNDANT_STOCK = 1000;

interface Stats {
  placed: number;
  insufficient: number;
  couponRedeemed: number;
  couponRejected: number;
  busy: number;
  other: number;
}

function runWorker(file: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      ['--import', 'tsx', 'scripts/contention-worker.ts', file, String(SCARCE_ATTEMPTS), String(COUPON_ATTEMPTS)],
      { cwd: process.cwd() },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`));
      try {
        resolve(JSON.parse(out) as Stats);
      } catch {
        reject(new Error(`unparseable worker output: ${out}\n${err}`));
      }
    });
  });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n❌ CONTENTION INVARIANT VIOLATED: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-contention-'));
  const file = join(dir, 'shared.db');
  try {
    // Seed the shared file once (parent connection).
    const seed = createSqliteRepositories(file);
    seedProducts(seed.products, [
      { id: 'p-scarce', name: 'Scarce', unitPriceCents: 1000, inventory: SCARCE_STOCK },
      { id: 'p-abundant', name: 'Abundant', unitPriceCents: 500, inventory: ABUNDANT_STOCK },
    ]);
    seed.coupons.save({
      code: 'RACE',
      discountPercent: 10,
      milestone: 999,
      status: 'AVAILABLE',
      createdAt: new Date().toISOString(),
    });

    console.log(`Spawning ${N} processes against ${file} (scarce stock ${SCARCE_STOCK})…`);
    const tallies = await Promise.all(Array.from({ length: N }, () => runWorker(file)));

    const sum = (k: keyof Stats) => tallies.reduce((s, t) => s + t[k], 0);
    const placed = sum('placed');
    const couponRedeemed = sum('couponRedeemed');
    const busy = sum('busy');
    const other = sum('other');
    console.log('Worker tallies:', JSON.stringify(tallies));
    console.log(
      `Totals: placed=${placed} insufficient=${sum('insufficient')} couponRedeemed=${couponRedeemed} ` +
        `couponRejected=${sum('couponRejected')} SQLITE_BUSY(retried)=${busy} other=${other}`,
    );

    // Fresh connection for verification.
    const v = createSqliteRepositories(file);
    const orders = v.orders.list();
    const scarceRemaining = v.products.get('p-scarce')!.inventory;
    const scarceSold = orders
      .flatMap((o) => o.lines)
      .filter((l) => l.productId === 'p-scarce')
      .reduce((s, l) => s + l.quantity, 0);
    const coupon = v.coupons.get('RACE')!;
    const ordersWithCoupon = orders.filter((o) => o.couponCode === 'RACE').length;

    assert(other === 0, `${other} unexpected worker errors`);
    assert(scarceRemaining >= 0, `scarce inventory went negative (${scarceRemaining})`);
    assert(scarceSold + scarceRemaining === SCARCE_STOCK, `conservation: sold ${scarceSold} + remaining ${scarceRemaining} != ${SCARCE_STOCK}`);
    assert(scarceRemaining === 0 && placed === SCARCE_STOCK, `expected all ${SCARCE_STOCK} sold, placed=${placed} remaining=${scarceRemaining}`);
    assert(v.orders.count() === placed + couponRedeemed, `order count ${v.orders.count()} != successful checkouts ${placed + couponRedeemed}`);
    assert(couponRedeemed === 1, `coupon redeemed ${couponRedeemed} times (must be exactly 1)`);
    assert(coupon.status === 'REDEEMED' && ordersWithCoupon === 1, `coupon RACE status=${coupon.status}, orders using it=${ordersWithCoupon}`);

    console.log(
      `\n✅ Multi-process contention held: exactly ${SCARCE_STOCK} sold across ${N} processes, ` +
        `no oversell, no negative inventory, coupon redeemed once` +
        (busy > 0 ? ` (weathered ${busy} SQLITE_BUSY waits via busy_timeout)` : ''),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  // Fail-fast skip if the optional native module is missing.
  const { createRequire } = await import('node:module');
  createRequire(import.meta.url)('better-sqlite3');
} catch {
  console.log('⚠  better-sqlite3 is not installed — skipping the multi-process contention test (this is fine).');
  process.exit(0);
}

await main();
