/**
 * HTTP routes. Handlers are thin: parse input, call a service, send JSON.
 *
 * The services are synchronous and throw AppError on failure; Express catches a
 * synchronous throw from a handler and forwards it to the error middleware, so
 * we don't need try/catch in every route.
 */
import { Router } from 'express';
import type { AppDeps } from './app.js';
import { AppError } from './errors.js';
import { makeCartService } from './services/cart-service.js';
import { makeCheckoutService } from './services/checkout-service.js';
import { makeCouponService } from './services/coupon-service.js';
import { makeReportService } from './services/report-service.js';
import { makeRateLimiter } from './rate-limit.js';

export function makeRouter(deps: AppDeps): Router {
  const carts = makeCartService(deps.repos);
  const checkout = makeCheckoutService(deps.repos);
  const coupons = makeCouponService(deps.repos, deps.config);
  const reports = makeReportService(deps.repos);
  const router = Router();

  // Rate-limit the mutating routes only. One shared limiter instance so its
  // window persists across requests; empty (no-op) when disabled in config.
  const mutating = deps.config.rateLimit ? [makeRateLimiter(deps.config.rateLimit)] : [];

  // --- catalogue (handy for evaluators to see stock) ---
  router.get('/products', (_req, res) => {
    res.json({ products: deps.repos.products.list() });
  });

  // --- carts ---
  router.post('/carts', (_req, res) => {
    res.status(201).json(carts.create());
  });

  router.get('/carts/:id', (req, res) => {
    res.json(carts.view(req.params.id));
  });

  router.post('/carts/:id/items', (req, res) => {
    const { productId, quantity } = req.body ?? {};
    if (typeof productId !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'productId (string) is required');
    }
    res.json(carts.addItem(req.params.id, productId, quantity));
  });

  router.put('/carts/:id/items/:productId', (req, res) => {
    res.json(carts.setQuantity(req.params.id, req.params.productId, req.body?.quantity));
  });

  router.delete('/carts/:id/items/:productId', (req, res) => {
    res.json(carts.removeItem(req.params.id, req.params.productId));
  });

  // --- checkout ---
  router.post('/carts/:id/checkout', ...mutating, (req, res) => {
    const couponCode = req.body?.couponCode;
    if (couponCode !== undefined && typeof couponCode !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'couponCode must be a string when provided');
    }
    // Optional Idempotency-Key: lets a client that lost the response retry
    // (even with a new cart) without placing a second order. The service returns
    // the HTTP status to send (201 first placement, 200 replay).
    const idempotencyKey = req.header('Idempotency-Key') || undefined;
    const { order, status } = checkout.checkout(req.params.id, couponCode, idempotencyKey);
    res.status(status).json(order);
  });

  // --- administration ---
  // Mint a coupon for the next unrewarded milestone (409 if none is due).
  router.post('/admin/coupons', ...mutating, (_req, res) => {
    res.status(201).json(coupons.generate());
  });

  // Read-only reconciliation summary. Does not mutate; safe to call repeatedly.
  router.get('/admin/report', (_req, res) => {
    res.json(reports.report());
  });

  // --- orders ---
  router.get('/orders/:id', (req, res) => {
    const order = deps.repos.orders.get(req.params.id);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', `no order ${req.params.id}`, { id: req.params.id });
    }
    res.json(order);
  });

  return router;
}
