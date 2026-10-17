import { Secret, TOTP } from 'otpauth';

/*
 * TOTP second factor for the admin login (RFC 6238, 6 digits, 30 s), via the `otpauth` package —
 * a pure-JS implementation, no native build. The secret lives in admin_users.totp_secret; the
 * confirmed_at column says whether login must present a code.
 *
 * Scope: one admin account, so the factor protects against a stolen password (phishing, reuse,
 * a shoulder-surfed password) — not against someone who already has read access to the database.
 * There is no recovery-code list: a lost phone is recovered with `npm run admin:reset-mfa`
 * (server access required — the same trust level as creating the admin in the first place).
 */

const ISSUER = 'Oil Center';

export function totpFor(secret: string, email: string): TOTP {
  return new TOTP({ issuer: ISSUER, label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
}

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32; // 160-bit, what authenticator apps assume
}

/** The otpauth:// URI the QR code encodes. */
export function totpUri(secret: string, email: string): string {
  return totpFor(secret, email).toString();
}

/**
 * True when `token` is the code for the current 30 s step, or the one immediately before/after
 * (clock drift, and the few seconds it takes to type). The ±1 window is the standard allowance;
 * anything wider multiplies the brute-force space without helping real users.
 */
export function verifyTotp(secret: string, email: string, token: string): boolean {
  const clean = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const delta = totpFor(secret, email).validate({ token: clean, window: 1 });
  return delta !== null;
}
