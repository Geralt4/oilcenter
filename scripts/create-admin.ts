import './env';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { adminUsers } from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/auth/password';

/*
 * Create an admin, or reset an existing admin's password.
 *   npm run admin:create -- owner@example.com 'a-long-password' "Ηλίας"
 */
async function main() {
  const [emailArg, password, name = 'Διαχειριστής'] = process.argv.slice(2);
  const email = (emailArg || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) {
    console.error('Usage: npm run admin:create -- <email> <password> [name]');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email));
  if (existing) {
    await db.update(adminUsers).set({ passwordHash, name }).where(eq(adminUsers.id, existing.id));
    console.log(`Password updated for ${email}`);
  } else {
    await db.insert(adminUsers).values({ email, passwordHash, name });
    console.log(`Admin created: ${email}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
