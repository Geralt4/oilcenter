import './env';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { db, DATABASE_URL } from '../src/lib/db';

async function main() {
  console.log(`Applying migrations → ${DATABASE_URL.replace(/\/\/.*@/, '//***@')}`);
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
