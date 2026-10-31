/*
 * Runs once when the server process starts. The shop is a single long-lived Node process with its database on a local
 * disk, so housekeeping that would otherwise need a cron job lives here: the daily database snapshot and the release of
 * unpaid card orders.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return;
  // `next build` also loads instrumentation in some phases; production secrets are deliberately absent
  // there (hosts pass them at runtime only), so the checks below must only judge a RUNNING server.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  // Fail the boot rather than run misconfigured: a missing AUTH_SECRET or a http SITE_URL discovered by the
  // first broken e-mail link is far worse than a restart loop that says exactly what is wrong.
  const { checkProductionConfig } = await import('@/lib/startup-check');
  const problems = checkProductionConfig();
  if (problems.length) {
    for (const p of problems) console.error(`[startup] CONFIGURATION PROBLEM: ${p}`);
    process.exit(1);
  }

  const { ensureDailyBackup } = await import('@/lib/backup');
  const { ensureOffsiteBackup, offsiteConfigured, pushSnapshotNow } = await import('@/lib/backup-offsite');
  const { sweepStaging } = await import('@/lib/uploads');

  // At boot (i.e. once per deploy) force a NEW snapshot: a deploy usually follows setup changes, and the
  // day's earlier snapshot predates them. Hourly runs then keep the ordinary daily copy current.
  const run = (fresh: boolean) =>
    ensureDailyBackup()
      .then((result) => {
        if (result === 'created') console.log('[backup] daily database snapshot written');
        // Expired/abandoned admin uploads are cleaned up on the same hourly cadence.
        return sweepStaging()
          .catch((err) => console.error('[uploads] staging sweep failed', err instanceof Error ? err.message : err))
          .then(() => {
            if (!offsiteConfigured()) return;
            const offsite = fresh ? pushSnapshotNow().then(({ object }) => (object ? 'uploaded' : 'exists')) : ensureOffsiteBackup();
            return offsite
              .then((outcome) => {
                if (outcome === 'uploaded') console.log(`[backup] off-site copy uploaded to Backblaze B2${fresh ? ' (fresh boot snapshot)' : ''}`);
              })
              .catch((err) => console.error('[backup] OFFSITE upload FAILED — local snapshot is safe, the off-site copy is not current:', err instanceof Error ? err.message : err));
          });
      })
      .catch((err) => console.error('[backup] snapshot FAILED', err));

  // shortly after boot (migrations have already run), then every hour: the first check after midnight makes the new day's copy
  setTimeout(() => run(true), 30_000).unref();
  setInterval(() => run(false), 60 * 60 * 1000).unref();

  // Unpaid card orders hold stock until they are released. Doing it here as well as on the admin dashboard means it no longer
  // depends on someone opening the admin. With COMMERCE_ENABLED=false there are no card orders, so nothing runs.
  const { commerceEnabled } = await import('@/lib/commerce-flag');
  const { releaseAbandonedCardOrders } = await import('@/lib/orders');
  const releaseCardOrders = () => {
    if (!commerceEnabled()) return;
    releaseAbandonedCardOrders()
      .then((released) => released > 0 && console.log(`[orders] released ${released} unpaid card order(s)`))
      .catch((err) => console.error('[orders] release of unpaid card orders failed', err instanceof Error ? err.message : err));
  };
  setTimeout(releaseCardOrders, 60_000).unref();
  setInterval(releaseCardOrders, 60 * 60 * 1000).unref();

  // Mails that follow a payment are saved with it and sent right after; this sweep sends the ones that did not go out (the
  // process died in between, or the mail service was down) and gives up on a mail after 8 tries.
  const { deliverPendingMail } = await import('@/lib/payments/mail-delivery');
  const sweepMail = () =>
    deliverPendingMail()
      .then((sent) => sent > 0 && console.log(`[mail] sent ${sent} queued payment mail(s)`))
      .catch((err) => console.error('[mail] sweep of queued payment mail failed', err instanceof Error ? err.message : err));
  setTimeout(sweepMail, 90_000).unref();
  setInterval(sweepMail, 10 * 60 * 1000).unref();
}
