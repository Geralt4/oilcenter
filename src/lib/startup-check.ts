/*
 * Production startup checks. Run once, when the server process boots (src/instrumentation.ts), so a
 * misconfigured deployment fails loudly and immediately instead of silently weakening protection and
 * being discovered by the first broken e-mail link or unaccepted cookie.
 *
 * Fails the boot when a required setting is missing; never reads secret VALUES, only their shape.
 * Things that are only worth a warning (the boot continues) come from checkProductionWarnings().
 */
import { commerceEnabled } from '@/lib/commerce-flag';
import { invalidWebhookIps } from '@/lib/payments/viva';

/**
 * Mail goes through Resend (it wins over SMTP, see src/lib/email.ts) but MAIL_FROM is unset or blank, so the sender is
 * Resend's shared test address. Same trimming as email.ts; that file is not imported here because it pulls in the database.
 */
export function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function resendWithoutSender(): boolean {
  return resendConfigured() && !process.env.MAIL_FROM?.trim();
}

/** Settings that do not stop the boot but will hurt once ordering is open. Logged by src/instrumentation.ts. */
export function checkProductionWarnings(): string[] {
  const warnings: string[] = [];
  // Fine for a catalogue site (only the shop's own notifications go out); with ordering on, customers would get no mail.
  // The ordersEnabled setting lives in the database and the owner can flip it without a restart, so only the deployment flag counts here.
  if (commerceEnabled() && resendWithoutSender()) {
    warnings.push("MAIL_FROM is not set while mail goes through Resend (RESEND_API_KEY) and commerce is on — mail is sent from Resend's test address, which delivers only to the Resend account's own mailbox, so customers get no order or payment e-mails. Set MAIL_FROM to a sender on a domain verified in Resend (e.g. Oil Center <no-reply@oilcenter.gr>).");
  }
  return warnings;
}

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

  // Viva. Anything but an explicit demo/live would silently run as demo (src/lib/payments/viva.ts): refuse a typo like "Live".
  const viva = process.env.VIVA_ENV;
  if (process.env.VIVA_CLIENT_ID && viva !== 'demo' && viva !== 'live') {
    problems.push(`VIVA_ENV is "${viva ?? ''}" — it must be exactly "demo" or "live" when the Viva keys are set (anything else would run as demo).`);
  }
  // VIVA_TEST_BASE_URL exists only so tests can point the payment code at a fake server. src/lib/payments/viva.ts ignores it
  // when VIVA_ENV=live; it is refused outright anywhere but an explicit demo setup, so a typo cannot let it through.
  if (process.env.VIVA_TEST_BASE_URL && viva !== 'demo') {
    problems.push('VIVA_TEST_BASE_URL is set but VIVA_ENV is not "demo" — it is a test-only switch and must never be set on a real server. Remove it.');
  }
  const badIps = invalidWebhookIps(process.env.VIVA_WEBHOOK_IPS);
  if (badIps.length > 0) {
    problems.push(`VIVA_WEBHOOK_IPS has entries that are not an IPv4 address, an IPv4 range like 40.127.253.112/28 or an IPv6 address: ${badIps.join(', ')} — a typo here would lock Viva's webhooks out.`);
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
