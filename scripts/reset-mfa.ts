import './env';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { adminUsers } from '../src/lib/db/schema';

/*
 * Turn OFF two-step verification for an admin who lost the authenticator (broken/lost phone).
 *   npm run admin:reset-mfa -- owner@example.com
 * Requires server access (Railway shell / docker exec) — the same trust level as creating the admin.
 * Sessions are signed out too, so whoever was logged in has to sign in again.
 */
async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    console.error('Usage: npm run admin:reset-mfa -- <email>');
    process.exit(1);
  }
  const [existing] = await db.select({ id: adminUsers.id, confirmed: adminUsers.totpConfirmedAt }).from(adminUsers).where(eq(adminUsers.email, email));
  if (!existing) {
    console.error(`No admin with e-mail ${email}.`);
    process.exit(1);
  }
  await db
    .update(adminUsers)
    .set({ totpSecret: null, totpConfirmedAt: null, tokenVersion: sql`${adminUsers.tokenVersion} + 1` })
    .where(eq(adminUsers.id, existing.id));
  console.log(existing.confirmed ? `Two-step verification disabled for ${email}; all sessions signed out.` : `${email} had no active two-step verification; all sessions signed out.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
