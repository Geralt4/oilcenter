import { NextResponse } from 'next/server';
import { activateByToken } from '@/lib/auth/activation';
import { createSession } from '@/lib/auth/session';
import { accountsAvailable } from '@/lib/catalogue-mode';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { siteUrl } from '@/lib/site-url';

/**
 * The link in the activation mail. Following it activates the account and signs the customer in (a page cannot set the session
 * cookie, a route handler can). A link that is unknown, used or expired leads to the page that sends a new one.
 *
 * A mail scanner that opens links before the customer does spends the link: the account is then active and the customer
 * simply signs in with the password; only the automatic sign-in is lost.
 */
export async function GET(request: Request) {
  if (!(await accountsAvailable())) return NextResponse.redirect(`${siteUrl()}/`);
  // the token is 32 random bytes, so guessing is hopeless; the limit only keeps the endpoint from being a free database ping
  if (!(await rateLimit(`activate:${await clientIp()}`, 30, 10 * 60 * 1000)).ok) return NextResponse.redirect(`${siteUrl()}/resend-activation?link=invalid`);
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const account = await activateByToken(token);
  if (!account) return NextResponse.redirect(`${siteUrl()}/resend-activation?link=invalid`);
  await createSession('customer', account.id, account.tokenVersion);
  return NextResponse.redirect(`${siteUrl()}/account?activated=1`);
}
