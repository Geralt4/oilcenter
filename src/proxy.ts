import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { resolveAuthSecret } from '@/lib/auth/secret';

/*
 * Four gates run before any page is rendered:
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
 * 3. Content-Security-Policy with a per-request nonce (see contentSecurityPolicy below). script-src drops
 *    'unsafe-inline' — the one directive that would let an injected <script> run — so only scripts carrying this
 *    request's nonce, and whatever they load ('strict-dynamic'), may execute. The site is rendered per request
 *    already (the root layout is force-dynamic), so minting a nonce costs nothing.
 *
 * Left open on purpose (see `matcher`): /api/health, which the host polls to decide whether the app is alive, and
 * /api/payments/*, where payment gateways call back server-to-server and cannot log in. Neither serves HTML, so
 * neither needs a CSP.
 */

const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// Must match COOKIE.admin.name in src/lib/auth/session.ts.
const ADMIN_COOKIE = 'oc_admin';

// The same helper as the session code (lib/auth/secret.ts): no secret, no admin session, in every environment.
const authSecret = () => resolveAuthSecret(process.env);

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

/**
 * The Content-Security-Policy for one response. script-src carries this request's nonce and 'strict-dynamic'
 * instead of 'unsafe-inline': a <script> injected into the page without the nonce is refused outright, and a
 * script that does run may only load what it loads itself. Next stamps the nonce on every script it renders
 * (the x-nonce request header below). 'unsafe-eval' stays only in development, where React's dev overlay needs
 * it. style-src keeps 'unsafe-inline' on purpose: the components use inline style={{…}} attributes, which a
 * nonce does not cover — and styles are a far weaker injection vector than scripts.
 */
function contentSecurityPolicy(nonce: string): string {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  if (process.env.NODE_ENV === 'development') scriptSrc.push(`'unsafe-eval'`);
  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'self'`,
    `form-action 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    // the store-location map is an embedded Google Maps iframe
    `frame-src https://www.google.com`,
    `worker-src 'self'`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`,
  ].join('; ');
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

  // Gate 3: mint a nonce, hand it to Next on the request (Next stamps it on its own scripts) and send the
  // policy back on the response. Every request gets its own nonce, so one leaked in a response is worthless
  // in the next.
  const nonce = Buffer.from(randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // /api/admin/upload is deliberately outside the proxy: it authenticates itself, and the proxy would
  // otherwise buffer the whole photo/PDF body a second time. /api/health and payment callbacks are
  // server-to-server and need no CSP or gate.
  matcher: ['/((?!api/health|api/payments/|api/admin/upload).*)'],
};
