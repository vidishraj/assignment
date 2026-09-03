/**
 * Money is represented as an integer number of cents everywhere in the system.
 * We never use floating-point dollars, so there are no rounding surprises when
 * summing line items or applying a percentage discount.
 *
 * `Cents` is a plain `number` (a nominal type would be safer but adds friction);
 * the invariant is enforced by construction — prices come from seed data as
 * integers and every operation here returns an integer.
 */
export type Cents = number;

/** Assert a value is a non-negative integer count of cents. */
export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer of cents, got ${value}`);
  }
  return value;
}

/** Sum a list of cent amounts. Empty list totals 0. */
export function sumCents(amounts: Cents[]): Cents {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/** unitPrice × quantity, kept in integer cents. */
export function lineTotal(unitPriceCents: Cents, quantity: number): Cents {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`quantity must be a non-negative integer, got ${quantity}`);
  }
  return unitPriceCents * quantity;
}

/**
 * The discount (in cents) for a `percent`% coupon applied to `subtotalCents`.
 *
 * Integer arithmetic with round-half-up: `(subtotal*percent + 50) / 100` floored.
 * This is deterministic, never exceeds the subtotal for percent ≤ 100, and is
 * clamped defensively so an order total can never go negative.
 */
export function percentDiscount(subtotalCents: Cents, percent: number): Cents {
  assertCents(subtotalCents, 'subtotal');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`percent must be an integer in 0..100, got ${percent}`);
  }
  const raw = Math.floor((subtotalCents * percent + 50) / 100);
  return Math.min(subtotalCents, raw);
}

/** Render cents as a human-readable decimal string (for API/debug output). */
export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
