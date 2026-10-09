import { createHash, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';

/*
 * Three gates run before any page is rendered:
 *
 * 0. Canonical host. Once SITE_URL names the public origin (https://www.oilcenter.gr), a request that arrives under
 *    any other host — the bare oilcenter.gr, the *.up.railway.app preview address — is redirected there with the
 *    same path and query, so browsers and search engines see a single origin. Nothing happens while SITE_URL is
 *    unset (the temporary preview) or outside production, and the platform's health probe is not matched at all.
 *
 * 1. Pre-launch curtain. While the SITE_PASSWORD environment variable is set, the whole site — storefront, admin,
 *    images — answers 401 until the browser sends HTTP Basic credentials (user: SITE_USER, default "oilcenter").
 *    Unset the variable on launch day and the curtain is gone.
 *
 * 2. Admin gate (defense in depth). A request for /admin/* is turned away to /admin/login unless it carries a
 *    validly signed admin session cookie. This only checks the signature — no database — because middleware runs on
 *    every request; the authoritative check (the account still exists, the token is current) stays in requireAdmin()
 *    at the top of every admin page and server action. The gate matters because a client-side (RSC) navigation can
 *    render a page without its layout, so a page must never depend on the layout alone to keep intruders out.
 *
 * Left open on purpose (see `matcher`): /api/health, which the host polls to decide whether the app is alive, and
 * /api/payments/*, where payment gateways call back server-to-server and cannot log in.
 */

const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// Must match COOKIE.admin.name in src/lib/auth/session.ts.
const ADMIN_COOKIE = 'oc_admin';

function authSecret(): Uint8Array | null {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  // Mirrors src/lib/auth/session.ts: a fixed dev secret off production, nothing in production.
  if (process.env.NODE_ENV !== 'production') return new TextEncoder().encode('dev-only-insecure-secret-do-not-use-in-production');
  return null;
}

/** Signature-only check that a request carries an admin session cookie. Not authoritative — see requireAdmin(). */
async function hasAdminSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(ADMIN_COOKIE)?.value;
  const secret = authSecret();
  if (!token || !secret) return false;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return payload.role === 'admin' && typeof payload.sub === 'string';
  } catch {
    return false;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Redirect to the canonical origin when the request came in under another host. Only the hostname is compared —
 * the scheme is the platform's business (Railway terminates TLS and forwards plain HTTP) and the port never appears
 * in a public host header. The destination is always SITE_URL, so a forged X-Forwarded-Host cannot turn this into
 * an open redirect.
 */
function canonicalHostRedirect(request: NextRequest): NextResponse | null {
  const explicit = process.env.SITE_URL?.trim();
  if (!explicit || process.env.NODE_ENV !== 'production') return null;
  let canonical: URL;
  try {
    canonical = new URL(explicit);
  } catch {
    return null;
  }
  const forwarded = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const hostname = forwarded.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (!hostname || hostname === canonical.hostname || LOCAL_HOSTS.has(hostname)) return null;
  // Built from the canonical origin and filled in piece by piece: a path such as //other.example/x must stay a path
  // on OUR host, never become the host.
  const target = new URL(canonical.origin);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  // 301 for GET/HEAD; 308 keeps the method and body for anything else (a form posted to the wrong host).
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  const response = NextResponse.redirect(target, status);
  // A browser keeps a permanent redirect indefinitely unless told otherwise. One hour saves the repeat visits and
  // still lets a mistaken or rolled-back SITE_URL heal by itself, instead of stranding people on a dead address.
  response.headers.set('Cache-Control', 'public, max-age=3600');
  return response;
}

export async function proxy(request: NextRequest) {
  const canonical = canonicalHostRedirect(request);
  if (canonical) return canonical;

  const password = process.env.SITE_PASSWORD;
  if (password) {
    const user = process.env.SITE_USER || 'oilcenter';
    const header = request.headers.get('authorization') ?? '';
    let authed = false;
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      // evaluate both comparisons so the timing does not reveal which half was wrong
      const userOk = colon > -1 && same(decoded.slice(0, colon), user);
      const passwordOk = colon > -1 && same(decoded.slice(colon + 1), password);
      authed = userOk && passwordOk;
    }
    if (!authed) {
      return new NextResponse('Το site δεν είναι ακόμη δημόσιο. Χρειάζεται όνομα χρήστη και κωδικός.', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Oil Center - preview", charset="UTF-8"',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      });
    }
  }

  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/admin') && pathname !== '/admin/login' && !(await hasAdminSession(request))) {
    return NextResponse.redirect(new URL('/admin/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/health|api/payments/).*)'],
};
