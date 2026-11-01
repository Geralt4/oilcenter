import { NextResponse } from 'next/server';
import { siteUrl } from '@/lib/site-url';

/**
 * The address the first activation mails used. It only forwards to the activation page with the same token: it reads and writes
 * nothing, so a mail scanner that opens it spends nothing either. The page decides whether the link still works.
 */
export function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const response = NextResponse.redirect(`${siteUrl()}/activate?token=${encodeURIComponent(token.slice(0, 200))}`, 303);
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
