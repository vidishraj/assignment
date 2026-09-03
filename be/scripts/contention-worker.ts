/**
 * One worker process in the multi-process contention test. Opens its OWN
 * connection to the SHARED SQLite file and hammers checkout against a seeded
 * catalogue, then prints a JSON tally on stdout. Run by multiprocess-contention.ts.
 */
import { createSqliteRepositories } from '../src/store/sqlite.js';
import { makeCartService } from '../src/services/cart-service.js';
import { makeCheckoutService } from '../src/services/checkout-service.js';
import { AppError } from '../src/errors.js';

const [, , file, scarceStr, couponStr] = process.argv;
const scarceAttempts = Number(scarceStr);
const couponAttempts = Number(couponStr);

const repos = createSqliteRepositories(file);
const carts = makeCartService(repos);
const checkout = makeCheckoutService(repos);

const stats = { placed: 0, insufficient: 0, couponRedeemed: 0, couponRejected: 0, busy: 0, other: 0 };

function attempt(productId: string, couponCode?: string): void {
  try {
    const cart = carts.create();
    carts.addItem(cart.id, productId, 1);
    checkout.checkout(cart.id, couponCode);
    if (couponCode) stats.couponRedeemed++;
    else stats.placed++;
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === 'INSUFFICIENT_INVENTORY') stats.insufficient++;
      else if (e.code === 'COUPON_ALREADY_REDEEMED') stats.couponRejected++;
      else stats.other++;
    } else if ((e as { code?: string })?.code === 'SQLITE_BUSY') {
      stats.busy++;
    } else {
      stats.other++;
    }
  }
}

for (let i = 0; i < scarceAttempts; i++) attempt('p-scarce');
for (let i = 0; i < couponAttempts; i++) attempt('p-abundant', 'RACE');

process.stdout.write(JSON.stringify(stats));
