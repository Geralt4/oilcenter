import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { adminUsers, customers } from '@/lib/db/schema';

/*
 * Stateless, signed (HS256) session cookies. Two independent cookies so that a shop customer
 * session can never be confused with an admin session.
 */

type Role = 'admin' | 'customer';
type SessionPayload = { sub: string; role: Role };

const COOKIE: Record<Role, { name: string; maxAge: number }> = {
  admin: { name: 'oc_admin', maxAge: 60 * 60 * 12 },
  customer: { name: 'oc_customer', maxAge: 60 * 60 * 24 * 30 },
};

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET is missing or too short (min 32 chars).');
    return new TextEncoder().encode('dev-only-insecure-secret-do-not-use-in-production');
  }
  return new TextEncoder().encode(secret);
}

async function sign(payload: SessionPayload, maxAge: number): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
    .sign(secretKey());
}

async function verify(token: string | undefined, role: Role): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (payload.role !== role || !payload.sub) return null;
    const id = Number(payload.sub);
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

export async function createSession(role: Role, id: number): Promise<void> {
  const { name, maxAge } = COOKIE[role];
  const store = await cookies();
  store.set(name, await sign({ sub: String(id), role }, maxAge), {
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

/** Verifies the cookie AND that the account still exists. Memoised per request. */
export const getAdmin = cache(async () => {
  const id = await verify((await cookies()).get(COOKIE.admin.name)?.value, 'admin');
  if (!id) return null;
  const [admin] = await db.select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, id));
  return admin ?? null;
});

export const getCustomer = cache(async () => {
  const id = await verify((await cookies()).get(COOKIE.customer.name)?.value, 'customer');
  if (!id) return null;
  const [customer] = await db.select().from(customers).where(eq(customers.id, id));
  if (!customer) return null;
  const { passwordHash: _p, resetTokenHash: _r, resetTokenExpires: _e, ...safe } = customer;
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
