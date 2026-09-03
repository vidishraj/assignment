/**
 * A single typed error model. Every expected failure is an AppError with a
 * stable, machine-readable `code` and a matching HTTP status, so an API client
 * can branch on the code (not on a parsed message string). Anything thrown that
 * is NOT an AppError is treated as an unexpected 500.
 */
import type { NextFunction, Request, Response } from 'express';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'MALFORMED_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'PRODUCT_NOT_FOUND'
  | 'INVALID_QUANTITY'
  | 'QUANTITY_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_INVENTORY'
  | 'CART_NOT_FOUND'
  | 'CART_EMPTY'
  | 'ITEM_NOT_IN_CART'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ORDER_NOT_FOUND'
  | 'COUPON_INVALID'
  | 'COUPON_ALREADY_REDEEMED'
  | 'COUPON_NOT_ELIGIBLE';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  MALFORMED_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  PRODUCT_NOT_FOUND: 404,
  INVALID_QUANTITY: 400,
  QUANTITY_LIMIT_EXCEEDED: 422,
  INSUFFICIENT_INVENTORY: 409,
  CART_NOT_FOUND: 404,
  CART_EMPTY: 400,
  ITEM_NOT_IN_CART: 404,
  CART_ALREADY_CHECKED_OUT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  ORDER_NOT_FOUND: 404,
  COUPON_INVALID: 400,
  COUPON_ALREADY_REDEEMED: 409,
  COUPON_NOT_ELIGIBLE: 409,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Optional structured context (e.g. which product, how much was available). */
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

/**
 * Translate a framework-level error into our typed model. body-parser rejects a
 * malformed, non-object (strict mode), or oversized JSON body by throwing BEFORE
 * our router runs, with a numeric HTTP `status`. Without this those would fall
 * through to the 500 branch and look like a server bug, when they are really a
 * client error ("Return errors that are distinguishable and useful"). Returns
 * undefined for anything that is genuinely unexpected.
 */
function translateFrameworkError(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { type?: string; status?: number; statusCode?: number };
  const status = e.status ?? e.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined;
  if (status === 413 || e.type === 'entity.too.large') {
    return new AppError('PAYLOAD_TOO_LARGE', 'request body is too large');
  }
  return new AppError('MALFORMED_REQUEST', 'request body could not be parsed as valid JSON');
}

/** Express error middleware: map AppError → its status; everything else → 500. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction, // required 4th arg so Express treats this as error middleware
): void {
  const appError = err instanceof AppError ? err : translateFrameworkError(err);
  if (appError) {
    res
      .status(appError.status)
      .json({ error: { code: appError.code, message: appError.message, details: appError.details } });
    return;
  }
  console.error('unexpected error', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
