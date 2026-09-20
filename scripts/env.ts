/*
 * Scripts run outside Next.js, so nothing loads .env files for them.
 * Import this first:  import './env';
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

for (const file of ['.env.local', '.env']) {
  const full = path.resolve(process.cwd(), file);
  if (existsSync(full)) process.loadEnvFile(full);
}
