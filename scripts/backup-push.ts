import './env';
import { ensureOffsiteBackup, offsiteConfigured } from '../src/lib/backup-offsite';
import { ensureDailyBackup } from '../src/lib/backup';

/*
 * Manual off-site push — the runbook's "did it really work?" step.
 *   npm run backup:push
 * Creates today's local snapshot if missing, then uploads/prunes on B2 exactly as the hourly job does.
 */
async function main() {
  if (!offsiteConfigured()) {
    console.error('Off-site backups are not configured. Set B2_KEY_ID, B2_APP_KEY, B2_BUCKET and BACKUP_ENCRYPTION_KEY.');
    process.exit(1);
  }
  console.log('Local snapshot:', await ensureDailyBackup());
  console.log('Off-site:', await ensureOffsiteBackup());
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Off-site push failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
