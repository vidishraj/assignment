import express, { type Express } from 'express';
import type { AppConfig } from './config.js';
import { validateConfig } from './config.js';
import type { Repositories } from './repository.js';
import { errorHandler } from './errors.js';
import { defaultLogger, requestContext, type Logger } from './logging.js';
import { makeRouter } from './routes.js';

/**
 * Dependencies an app instance needs. Passing them in (rather than importing a
 * singleton) keeps the app testable and makes the repository swap explicit —
 * the same routes run against the in-memory store today or a real database
 * later.
 */
export interface AppDeps {
  config: AppConfig;
  repos: Repositories;
  /** Structured-log sink; defaults to one JSON line per request on stdout. */
  log?: Logger;
}

/** Build an Express app. No side effects (no listen) so tests can drive it. */
export function createApp(deps: AppDeps): Express {
  // Fail fast on a bad config (e.g. discountPercent 150) at construction rather
  // than minting an invalid coupon and 500-ing later at checkout.
  validateConfig(deps.config);

  const app = express();
  // First: assign a request id, echo it, and log one structured line per request.
  app.use(requestContext(deps.log ?? defaultLogger));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', config: deps.config });
  });

  app.use(makeRouter(deps));

  // Must be last: turns thrown AppErrors into typed JSON responses.
  app.use(errorHandler);

  return app;
}
