/**
 * Coupon generation — the administrative rewards path.
 *
 * RULE: every `n`-th successfully placed order earns one coupon for `x`% off,
 * where n = config.milestoneInterval and x = config.discountPercent. Coupons are
 * NOT minted automatically at checkout; an administrator requests generation and
 * we mint at most one coupon per reached milestone.
 *
 * ELIGIBILITY is derived, not stored: with `orders` placed, floor(orders / n)
 * milestones have been reached; if we have already generated that many coupons,
 * nothing is eligible. This keeps generation idempotent-ish — repeatedly asking
 * when nothing new is due yields COUPON_NOT_ELIGIBLE rather than extra coupons.
 *
 * CONCURRENCY: generate() is fully synchronous, so two concurrent admin requests
 * serialize under the event loop; the second sees the incremented coupon count
 * and cannot mint a duplicate for the same milestone.
 */
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import type { Coupon } from '../domain/types.js';
import type { Repositories } from '../repository.js';

export function makeCouponService(repos: Repositories, config: AppConfig) {
  /** Mint a coupon for the next unrewarded milestone, or reject if none is due. */
  function generate(): Coupon {
    const orderCount = repos.orders.count();
    const reachedMilestones = Math.floor(orderCount / config.milestoneInterval);
    const alreadyGenerated = repos.coupons.list().length;

    if (reachedMilestones <= alreadyGenerated) {
      throw new AppError(
        'COUPON_NOT_ELIGIBLE',
        `no unrewarded milestone: ${orderCount} orders placed, ${alreadyGenerated} coupon(s) already generated (one per ${config.milestoneInterval} orders)`,
        { orderCount, milestoneInterval: config.milestoneInterval, alreadyGenerated },
      );
    }

    // Reward milestones in order: the k-th coupon rewards order k*n.
    const milestone = (alreadyGenerated + 1) * config.milestoneInterval;
    const coupon: Coupon = {
      code: `SAVE${config.discountPercent}-${milestone}`,
      discountPercent: config.discountPercent,
      milestone,
      status: 'AVAILABLE',
      createdAt: new Date().toISOString(),
    };
    repos.coupons.save(coupon);
    return coupon;
  }

  return { generate };
}

export type CouponService = ReturnType<typeof makeCouponService>;
