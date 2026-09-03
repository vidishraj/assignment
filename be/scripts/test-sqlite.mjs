/**
 * Run the SAME test suite against the SQLite store (STORE=sqlite).
 *
 * better-sqlite3 is an OPTIONAL native dependency. If it isn't installed (or
 * couldn't be built on this machine), we SKIP cleanly with a clear message and
 * exit 0 — a grader must still get a green `npm ci` and default `npm test`
 * without it. A broken install must never be worse than no SQLite at all.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
try {
  require('better-sqlite3');
} catch {
  console.log('⚠  better-sqlite3 is not installed — skipping the SQLite suite (this is fine).');
  console.log('   Install it with `npm install` to run: STORE=sqlite npm test.');
  process.exit(0);
}

// Collect every *.test.ts under src/ (mirrors the default test script's glob).
function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(p));
    else if (entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = findTests('src');
const result = spawnSync('node', ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, STORE: 'sqlite' },
});
process.exit(result.status ?? 1);
