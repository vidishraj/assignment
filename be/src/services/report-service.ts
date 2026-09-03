/**
 * Administrative reporting.
 *
 * The report is a pure projection over the current orders and coupons — it reads
 * state and computes totals, and never mutates anything, so repeated report
 * requests are safe and always reconcile with the orders/coupons the API returns.
 *
 * Revenue identities (all in integer cents):
 *   grossRevenue   = Σ order.subtotalCents      (before discounts)
 *   totalDiscounts = Σ order.discountCents
 *   netRevenue     = Σ order.totalCents          (= gross − discounts)
 */
import type { Cents } from '../money.js';
import type { Repositories } from '../repository.js';

export interface Report {
  totalOrders: number;
  /** Successfully purchased quantity, keyed by product id. */
  purchasedByProduct: Record<string, number>;
  grossRevenueCents: Cents;
  totalDiscountsCents: Cents;
  netRevenueCents: Cents;
  coupons: {
    generated: number;
    available: number;
    redeemed: number;
  };
}

export function makeReportService(repos: Repositories) {
  function report(): Report {
    const orders = repos.orders.list();
    const purchasedByProduct: Record<string, number> = {};
    let grossRevenueCents = 0;
    let totalDiscountsCents = 0;
    let netRevenueCents = 0;

    for (const order of orders) {
      grossRevenueCents += order.subtotalCents;
      totalDiscountsCents += order.discountCents;
      netRevenueCents += order.totalCents;
      for (const line of order.lines) {
        purchasedByProduct[line.productId] =
          (purchasedByProduct[line.productId] ?? 0) + line.quantity;
      }
    }

    const coupons = repos.coupons.list();
    return {
      totalOrders: orders.length,
      purchasedByProduct,
      grossRevenueCents,
      totalDiscountsCents,
      netRevenueCents,
      coupons: {
        generated: coupons.length,
        available: coupons.filter((c) => c.status === 'AVAILABLE').length,
        redeemed: coupons.filter((c) => c.status === 'REDEEMED').length,
      },
    };
  }

  return { report };
}

export type ReportService = ReturnType<typeof makeReportService>;
