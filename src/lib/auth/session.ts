import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { adminUsers, customers } from '@/lib/db/schema';

/*
 * Stateless, signed (HS256) session cookies. Two independent cookies so that a shop customer
 * session can never be confused with an admin session.
 */

type Role = 'admin' | 'customer';
type SessionPayload = { sub: string; role: Role; ver: number; sid?: string };

const COOKIE: Record<Role, { name: string; maxAge: number }> = {
  admin: { name: 'oc_admin', maxAge: 60 * 60 * 12 },
  customer: { name: 'oc_customer', maxAge: 60 * 60 * 24 * 30 },
};

/** Short-lived proof that the administrator re-entered their password + authenticator code. */
const SUDO_COOKIE = 'oc_admin_sudo';
const SUDO_MAX_AGE = 5 * 60;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET is missing or too short (min 32 chars).');
    return new TextEncoder().encode('dev-only-insecure-secret-do-not-use-in-production');
  }
  return new TextEncoder().encode(secret);
}

async function sign(payload: SessionPayload, maxAge: number): Promise<string> {
  return new SignJWT({ role: payload.role, ver: payload.ver, ...(payload.sid ? { sid: payload.sid } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
    .sign(secretKey());
}

async function verify(token: string | undefined, role: Role): Promise<{ id: number; ver: number; sid: string | null } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (payload.role !== role || !payload.sub) return null;
    const id = Number(payload.sub);
    // Tokens minted before token versioning carry no `ver`; treat that as 0 (the column default).
    const ver = Number(payload.ver ?? 0);
    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    return Number.isInteger(id) && Number.isInteger(ver) ? { id, ver, sid } : null;
  } catch {
    return null;
  }
}

export async function createSession(role: Role, id: number, tokenVersion: number): Promise<void> {
  const { name, maxAge } = COOKIE[role];
  const store = await cookies();
  // Every login gets its own session id. The sudo proof is bound to it, so a proof from an older
  // session (stolen cookie, another tab after re-login) cannot authorize sensitive actions.
  store.set(name, await sign({ sub: String(id), role, ver: tokenVersion, sid: randomUUID() }, maxAge), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
}

export async function destroySession(role: Role): Promise<void> {
  (await cookies()).delete(COOKIE[role].name);
}

// ─── Re-authentication ("sudo mode") ────────────────────────────────────────
/*
 * Changing who can administer the shop is more sensitive than editing a product, so those actions
 * require the acting administrator to have proved BOTH factors within the last five minutes. The
 * proof lives in its own HttpOnly cookie, signed like the session and bound to the account id, so
 * a stolen session cookie alone is not enough. The password/code themselves are never stored.
 */
export async function createSudoSession(): Promise<boolean> {
  const session = await verify((await cookies()).get(COOKIE.admin.name)?.value, 'admin');
  // A session minted before session ids existed cannot anchor a confirmation proof; signing in again fixes it.
  if (!session?.sid) return false;
  const store = await cookies();
  store.set(
    SUDO_COOKIE,
    await new SignJWT({ role: 'sudo', ver: session.ver, sid: session.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(session.id))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + SUDO_MAX_AGE)
      .sign(secretKey()),
    { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SUDO_MAX_AGE },
  );
  return true;
}

export async function destroySudoSession(): Promise<void> {
  (await cookies()).delete(SUDO_COOKIE);
}

/**
 * Valid for five minutes, and only for the CURRENT admin session: same account, same session id,
 * same token version. Re-login, password change and MFA changes therefore invalidate it at once.
 */
export async function hasSudoSession(): Promise<boolean> {
  const session = await verify((await cookies()).get(COOKIE.admin.name)?.value, 'admin');
  if (!session?.sid) return false;
  const token = (await cookies()).get(SUDO_COOKIE)?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    return (
      payload.role === 'sudo' &&
      Number(payload.sub) === session.id &&
      payload.sid === session.sid &&
      Number(payload.ver) === session.ver
    );
  } catch {
    return false;
  }
}

/**
 * Signs one account out everywhere at once (logout): bumping tokenVersion makes every cookie minted so far
 * fail the version check in getAdmin/getCustomer — on this device and on any other.
 */
export async function revokeAllSessions(role: Role, id: number): Promise<void> {
  if (role === 'admin') await db.update(adminUsers).set({ tokenVersion: sql`${adminUsers.tokenVersion} + 1` }).where(eq(adminUsers.id, id));
  else await db.update(customers).set({ tokenVersion: sql`${customers.tokenVersion} + 1` }).where(eq(customers.id, id));
}

/** Verifies the cookie, that the account still exists, AND that the session has not been revoked. Memoised per request. */
export const getAdmin = cache(async () => {
  const session = await verify((await cookies()).get(COOKIE.admin.name)?.value, 'admin');
  if (!session) return null;
  const [admin] = await db.select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, tokenVersion: adminUsers.tokenVersion }).from(adminUsers).where(eq(adminUsers.id, session.id));
  if (!admin || admin.tokenVersion !== session.ver) return null;
  const { tokenVersion: _v, ...safe } = admin;
  return safe;
});

export const getCustomer = cache(async () => {
  const session = await verify((await cookies()).get(COOKIE.customer.name)?.value, 'customer');
  if (!session) return null;
  const [customer] = await db.select().from(customers).where(eq(customers.id, session.id));
  // an account that was never activated has no business holding a session (none is issued for it; this is the second lock)
  if (!customer || customer.tokenVersion !== session.ver || !customer.emailVerifiedAt) return null;
  const { passwordHash: _p, resetTokenHash: _r, resetTokenExpires: _e, verifyTokenHash: _vh, verifyTokenExpires: _ve, tokenVersion: _v, ...safe } = customer;
  return safe;
});

/** Call at the top of every admin page and admin server action. Proxy-level checks are only a convenience. */
export async function requireAdmin() {
  const admin = await getAdmin();
  if (!admin) redirect('/admin/login');
  return admin;
}

export async function requireCustomer(next = '/account') {
  const customer = await getCustomer();
  if (!customer) redirect(`/login?next=${encodeURIComponent(next)}`);
  return customer;
}

export const ADMIN_COOKIE = COOKIE.admin.name;
