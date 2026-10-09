import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

/*
 * One libSQL client per process.
 *   DATABASE_URL=file:./data/shop.db      → local SQLite file (default)
 *   DATABASE_URL=libsql://…turso.io       → hosted Turso database (serverless-friendly)
 * The same schema and migrations work for both.
 */

export const DATABASE_URL = process.env.DATABASE_URL || 'file:./data/shop.db';

function createDbClient(): Client {
  if (DATABASE_URL.startsWith('file:')) {
    const file = DATABASE_URL.slice('file:'.length);
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const client = createClient({
    url: DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    // Busy timeout for a local file: a write that meets a lock waits up to 5 s instead of failing at once with
    // SQLITE_BUSY (two containers share the volume for a moment on every deploy). It has to be set here: the client
    // keeps a POOL of connections, and a `PRAGMA busy_timeout` reaches only the one connection that happens to run it.
    timeout: 5000,
  });
  if (DATABASE_URL.startsWith('file:')) {
    // WAL is a property of the database file, so setting it once on any connection is enough.
    // Foreign keys are on by default in libSQL (every pooled connection reports foreign_keys = 1).
    void client.execute('PRAGMA journal_mode = WAL');
  }
  return client;
}

// Survive Next.js dev hot-reloads without leaking connections.
const globalForDb = globalThis as unknown as { __ocDbClient?: Client };
export const client: Client = globalForDb.__ocDbClient ?? createDbClient();
if (process.env.NODE_ENV !== 'production') globalForDb.__ocDbClient = client;

export const db = drizzle(client, { schema });
export type Db = typeof db;
export { schema };
