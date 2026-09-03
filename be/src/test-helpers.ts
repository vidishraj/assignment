/**
 * Shared test helpers: build seeded dependencies and drive the app over real
 * HTTP (so concurrency tests exercise the same path production would).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type AppDeps } from './app.js';
import type { AppConfig } from './config.js';
import { seedProducts } from './seed.js';
import { createMemoryRepositories } from './store/memory.js';

export function buildDeps(config: Partial<AppConfig> = {}): AppDeps {
  const repos = createMemoryRepositories();
  seedProducts(repos.products);
  return { config: { milestoneInterval: 3, discountPercent: 10, ...config }, repos };
}

export interface TestServer {
  baseUrl: string;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function startServer(deps: AppDeps = buildDeps()): Promise<TestServer> {
  const server: Server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    deps,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

/** Minimal JSON HTTP client for tests. */
export async function api<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}
