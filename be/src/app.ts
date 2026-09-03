import express, { type Express } from 'express';
import type { AppConfig } from './config.js';
import { errorHandler } from './errors.js';

/**
 * Dependencies an app instance needs. Passing them in (rather than importing a
 * singleton) keeps the app testable and makes the repository swap explicit —
 * the same routes run against the in-memory store today or a real database
 * later.
 */
export interface AppDeps {
  config: AppConfig;
}

/** Build an Express app. No side effects (no listen) so tests can drive it. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', config: deps.config });
  });

  // Routers (carts, checkout, …) are registered here as they are built.

  // Must be last: turns thrown AppErrors into typed JSON responses.
  app.use(errorHandler);

  return app;
}
