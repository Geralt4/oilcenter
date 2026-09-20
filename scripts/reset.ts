import './env';
import { rmSync } from 'node:fs';
import path from 'node:path';

/* Deletes the LOCAL SQLite file so migrate + seed can rebuild it. Refuses to touch a remote database. */
const url = process.env.DATABASE_URL || 'file:./data/shop.db';
if (!url.startsWith('file:')) {
  console.error('db:reset only works with a local file: database. Refusing to continue.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database with NODE_ENV=production.');
  process.exit(1);
}
const file = path.resolve(url.slice('file:'.length));
for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
console.log(`Removed ${file}`);
