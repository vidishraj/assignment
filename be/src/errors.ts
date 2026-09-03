/**
 * A single typed error model. Every expected failure is an AppError with a
 * stable, machine-readable `code` and a matching HTTP status, so an API client
 * can branch on the code (not on a parsed message string). Anything thrown that
 * is NOT an AppError is treated as an unexpected 500.
 */
import type { NextFunction, Request, Response } from 'express';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PRODUCT_NOT_FOUND'
  | 'INVALID_QUANTITY'
  | 'QUANTITY_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_INVENTORY'
  | 'CART_NOT_FOUND'
  | 'CART_EMPTY'
  | 'ITEM_NOT_IN_CART'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'ORDER_NOT_FOUND'
  | 'COUPON_INVALID'
  | 'COUPON_ALREADY_REDEEMED'
  | 'COUPON_NOT_ELIGIBLE';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  PRODUCT_NOT_FOUND: 404,
  INVALID_QUANTITY: 400,
  QUANTITY_LIMIT_EXCEEDED: 422,
  INSUFFICIENT_INVENTORY: 409,
  CART_NOT_FOUND: 404,
  CART_EMPTY: 400,
  ITEM_NOT_IN_CART: 404,
  CART_ALREADY_CHECKED_OUT: 409,
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

/** Express error middleware: map AppError → its status; everything else → 500. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction, // required 4th arg so Express treats this as error middleware
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  console.error('unexpected error', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
