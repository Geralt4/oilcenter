import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

/*
 * Pre-launch gate. While the SITE_PASSWORD environment variable is set, the whole site — storefront, admin, images —
 * answers 401 until the browser sends HTTP Basic credentials (user: SITE_USER, default "oilcenter"). Unset the variable
 * on launch day and the gate is gone; nothing else in the app knows about it.
 *
 * Left open on purpose (see `matcher`): /api/health, which the host polls to decide whether the app is alive, and
 * /api/payments/*, where payment gateways call back server-to-server and cannot log in.
 *
 * This is a curtain, not the lock: admin pages and every server action still do their own requireAdmin() check.
 */

const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function proxy(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();
  const user = process.env.SITE_USER || 'oilcenter';

  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    // evaluate both comparisons so the timing does not reveal which half was wrong
    const userOk = colon > -1 && same(decoded.slice(0, colon), user);
    const passwordOk = colon > -1 && same(decoded.slice(colon + 1), password);
    if (userOk && passwordOk) return NextResponse.next();
  }

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

export const config = {
  matcher: ['/((?!api/health|api/payments/).*)'],
};
