/**
 * Service configuration.
 *
 * `milestoneInterval` (n) and `discountPercent` (x) drive the rewards rule:
 * every n-th successfully placed order makes one coupon for x% off available.
 * They are injected (not read from a global) so tests can use small values
 * like n = 2 instead of waiting for 5 real orders.
 */
export interface AppConfig {
  /** n — a coupon becomes eligible after every n-th placed order. */
  milestoneInterval: number;
  /** x — coupon discount percentage (0–100). */
  discountPercent: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const milestoneInterval = Number(env.MILESTONE_INTERVAL ?? 5);
  const discountPercent = Number(env.DISCOUNT_PERCENT ?? 10);
  return validateConfig({ milestoneInterval, discountPercent });
}

export function validateConfig(config: AppConfig): AppConfig {
  const { milestoneInterval, discountPercent } = config;
  if (!Number.isInteger(milestoneInterval) || milestoneInterval < 1) {
    throw new Error(`milestoneInterval (n) must be a positive integer, got ${milestoneInterval}`);
  }
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error(`discountPercent (x) must be an integer in 0..100, got ${discountPercent}`);
  }
  return config;
}
