/*
 * The key that signs login cookies, chosen in ONE place for the session code (lib/auth/session.ts) and for the proxy
 * (src/proxy.ts), so that the two can never disagree.
 *
 * AUTH_SECRET must be at least 32 characters. There is no built-in fallback: a missing or short secret is an error in
 * every environment, so a published default can never sign a real session by accident (a staging copy, a missed
 * variable). A developer who really wants one on a throwaway machine sets ALLOW_DEV_AUTH_SECRET=1; it is ignored when
 * NODE_ENV is production.
 *
 * No Node imports: the proxy loads this too.
 */

export const MIN_AUTH_SECRET_LENGTH = 32;
export const AUTH_SECRET_PROBLEM = 'AUTH_SECRET is missing or too short (min 32 chars). On a throwaway development machine ALLOW_DEV_AUTH_SECRET=1 allows a fixed development secret.';
const DEV_ONLY_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

type SecretEnv = { AUTH_SECRET?: string; NODE_ENV?: string; ALLOW_DEV_AUTH_SECRET?: string };

/** The signing key, or null when there is none to use (the caller decides how loudly to fail). */
export function resolveAuthSecret(env: SecretEnv): Uint8Array | null {
  const secret = env.AUTH_SECRET;
  if (secret && secret.length >= MIN_AUTH_SECRET_LENGTH) return new TextEncoder().encode(secret);
  if (env.NODE_ENV !== 'production' && env.ALLOW_DEV_AUTH_SECRET === '1') return new TextEncoder().encode(DEV_ONLY_SECRET);
  return null;
}
