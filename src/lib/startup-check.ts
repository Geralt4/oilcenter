/*
 * Production startup checks. Run once, when the server process boots (src/instrumentation.ts), so a
 * misconfigured deployment fails loudly and immediately instead of silently weakening protection and
 * being discovered by the first broken e-mail link or unaccepted cookie.
 *
 * Fails the boot when a required setting is missing; never reads secret VALUES, only their shape.
 */
export function checkProductionConfig(): string[] {
  const problems: string[] = [];

  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    problems.push('AUTH_SECRET is missing or shorter than 32 characters — session cookies cannot be signed securely. Generate one with: openssl rand -base64 48');
  }

  const site = process.env.SITE_URL?.trim();
  if (!site) {
    // site-url.ts would fall back to platform-injected variables or localhost; payments, e-mails and the
    // sitemap would then point somewhere else than the browser. Deployment configs name the origin.
    problems.push('SITE_URL is not set — e-mail links, the sitemap, canonical URLs and payment return URLs must not be left to platform guesses.');
  } else {
    let host = '';
    try {
      host = new URL(site).hostname;
    } catch {
      problems.push(`SITE_URL "${site}" is not a valid absolute URL (e.g. https://www.oilcenter.gr).`);
    }
    // http is only acceptable on a developer's machine; anything public must terminate TLS.
    if (host && !/^https:\/\//i.test(site) && host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.') && !host.startsWith('10.')) {
      problems.push(`SITE_URL "${site}" is not https:// — cookies would not be marked Secure and payment return URLs would be insecure.`);
    }
  }

  const commerce = process.env.COMMERCE_ENABLED;
  if (commerce !== undefined && commerce !== 'false' && commerce !== 'true') {
    problems.push(`COMMERCE_ENABLED is "${commerce}" — the only meaningful values are "true" and "false" (false = website only, see src/lib/commerce-flag.ts).`);
  }

  // VIVA_TEST_BASE_URL exists only so tests can point the payment code at a fake server; with VIVA_ENV=live it is ignored by
  // src/lib/payments/viva.ts, and having it set at all on a live deployment means something is badly misconfigured.
  if (process.env.VIVA_ENV === 'live' && process.env.VIVA_TEST_BASE_URL) {
    problems.push('VIVA_TEST_BASE_URL is set while VIVA_ENV=live — it is a test-only switch. Remove it.');
  }

  // Off-site backups: either fully configured or not at all — a half-configured uploader that silently
  // skips every night is worse than one that was never switched on.
  const b2 = ['B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET', 'BACKUP_ENCRYPTION_KEY'].filter((name) => process.env[name]);
  if (b2.length > 0 && b2.length < 4) {
    problems.push(`Off-site backups are partially configured (set: ${b2.join(', ')}). Set all of B2_KEY_ID, B2_APP_KEY, B2_BUCKET, BACKUP_ENCRYPTION_KEY — or none.`);
  }
  const backupKey = process.env.BACKUP_ENCRYPTION_KEY;
  if (backupKey && Buffer.from(backupKey, 'base64').length !== 32) {
    problems.push('BACKUP_ENCRYPTION_KEY is not a base64 32-byte key — generate one with: openssl rand -base64 32');
  }

  return problems;
}
