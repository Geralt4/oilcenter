import './env';
import { pushSnapshotNow } from '../src/lib/backup-offsite';

/*
 * Fresh recovery point — creates a NEW snapshot (never reuses an existing daily file), uploads that
 * exact encrypted object and prunes old versions:
 *   npm run backup:now
 * Use it after setup changes (new accounts, MFA enablement) so the off-site copy includes them.
 */
async function main() {
  const { object } = await pushSnapshotNow();
  console.log(`Fresh encrypted snapshot uploaded: ${object}`);
  console.log('Verify a restore with: npm run backup:pull -- ' + object + ' ./restore/shop.db');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backup-now failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
