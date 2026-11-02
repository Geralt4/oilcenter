import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two secrets. Both sides are hashed first, so the comparison always runs over
 * fixed-length values: different lengths neither throw nor short-circuit. Used for the session cookie check
 * in the proxy and for an order's secret access token on the storefront.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
