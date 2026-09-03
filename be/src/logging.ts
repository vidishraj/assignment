/**
 * Minimal, dependency-free observability.
 *
 * This assignment is themed on RELIABILITY, and the first thing you need when a
 * retry or a concurrent checkout misbehaves in production is the ability to
 * correlate the request with its log line. So every request carries an id (an
 * inbound `X-Request-Id` is honoured, else one is minted), the id is echoed on
 * the response and included in every error body, and exactly one structured JSON
 * line is emitted per request. We log the error CODE on failure — never the stack
 * and never the request body, because an order payload is customer data.
 *
 * The logger is injectable so tests can assert on entries instead of spewing to
 * stdout, and it stays synchronous (a callback on `finish`, no `await`).
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface LogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** The AppError code, on a failed request only. */
  code?: string;
}

export type Logger = (entry: LogEntry) => void;

/** Default logger: one JSON line per request to stdout. */
export const defaultLogger: Logger = (entry) => {
  console.log(JSON.stringify({ level: entry.code ? 'error' : 'info', ...entry }));
};

/**
 * Assigns/propagates a request id, echoes it on the response, and logs one
 * structured line when the response finishes. Runs first so it wraps everything.
 */
export function requestContext(log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = req.header('x-request-id') || randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    const startedAt = Date.now();
    res.on('finish', () => {
      const entry: LogEntry = {
        id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (res.locals.errorCode) entry.code = res.locals.errorCode as string;
      log(entry);
    });
    next();
  };
}
