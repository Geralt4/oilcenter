import './env';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { adminUsers } from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/auth/password';

/*
 * Create an admin, or reset an existing admin's password.
 *   npm run admin:create -- owner@example.com 'a-long-password' "Ηλίας"
 *   echo "$ADMIN_PASSWORD" | npm run admin:create -- owner@example.com - "Ηλίας"   (password on stdin)
 * A reset bumps tokenVersion, so every session cookie signed before it stops working immediately.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const [emailArg, passwordArg, name = 'Διαχειριστής'] = process.argv.slice(2);
  const email = (emailArg || '').trim().toLowerCase();
  // "-" reads the password from stdin, so it can stay out of shell history and process listings.
  const password = passwordArg === '-' ? await readStdin() : passwordArg;
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) {
    console.error('Usage: npm run admin:create -- <email> <password|-> [name]');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email));
  if (existing) {
    // sql`... + 1`, not a read-then-write: a reset revokes every session even if one was minted while it ran.
    await db
      .update(adminUsers)
      .set({ passwordHash, name, tokenVersion: sql`${adminUsers.tokenVersion} + 1` })
      .where(eq(adminUsers.id, existing.id));
    console.log(`Password updated for ${email} — all previous sessions were signed out.`);
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
