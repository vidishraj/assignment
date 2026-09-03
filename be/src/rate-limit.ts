/**
 * A deliberately small, in-memory fixed-window rate limiter for the mutating
 * routes (checkout, admin coupon generation). Synchronous, no dependencies.
 *
 * Its LIMITATIONS are the point, and they are stated plainly in DECISIONS.md:
 * with no auth model there is no principal to key on, so it keys on IP — which is
 * trivially spoofed/shared behind a proxy and would be a per-account limit in
 * production; and being in-process it does not hold across instances (each node
 * has its own window). It is a coarse abuse-dampener, not a production control.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors.js';

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export function makeRateLimiter(cfg: RateLimitConfig, now: () => number = () => Date.now()) {
  const windows = new Map<string, { count: number; windowStart: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const t = now();
    const rec = windows.get(key);
    if (!rec || t - rec.windowStart >= cfg.windowMs) {
      windows.set(key, { count: 1, windowStart: t });
      return next();
    }
    if (rec.count < cfg.limit) {
      rec.count += 1;
      return next();
    }
    const retryAfterSeconds = Math.ceil((rec.windowStart + cfg.windowMs - t) / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new AppError('RATE_LIMITED', 'too many requests — slow down', { retryAfterSeconds });
  };
}
