/*
 * Runs once when the server process starts. The shop is a single long-lived Node process with its database on a local
 * disk, so housekeeping that would otherwise need a cron job lives here: the daily database snapshot.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return;
  const { ensureDailyBackup } = await import('@/lib/backup');

  const run = () =>
    ensureDailyBackup()
      .then((result) => {
        if (result === 'created') console.log('[backup] daily database snapshot written');
      })
      .catch((err) => console.error('[backup] snapshot FAILED', err));

  // shortly after boot (migrations have already run), then every hour: the first check after midnight makes the new day's copy
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}
