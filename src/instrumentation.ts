/*
 * Runs once when the server process starts. The shop is a single long-lived Node process with its database on a local
 * disk, so housekeeping that would otherwise need a cron job lives here: the daily database snapshot.
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
  const { ensureOffsiteBackup, offsiteConfigured } = await import('@/lib/backup-offsite');

  const run = () =>
    ensureDailyBackup()
      .then((result) => {
        if (result === 'created') console.log('[backup] daily database snapshot written');
        // Off-site copy rides on the same schedule: once today's snapshot exists, upload it (encrypted go B2).
        if (offsiteConfigured()) {
          return ensureOffsiteBackup()
            .then((offsite) => {
              if (offsite === 'uploaded') console.log('[backup] off-site copy uploaded to Backblaze B2');
            })
            .catch((err) => console.error('[backup] OFFSITE upload FAILED — local snapshot is safe, the off-site copy is not current:', err instanceof Error ? err.message : err));
        }
      })
      .catch((err) => console.error('[backup] snapshot FAILED', err));

  // shortly after boot (migrations have already run), then every hour: the first check after midnight makes the new day's copy
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}
