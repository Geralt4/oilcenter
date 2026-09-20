import './env';
import { applySkroutzPrices } from './skroutz-prices';

/*
 * Applies catalog/skroutz-prices.json to an existing database by hand (the hosted one gets it once, through scripts/patches.ts).
 *   npm run prices:skroutz            only touches prices the owner has not confirmed yet (price_verified = 0)
 *   npm run prices:skroutz -- --force also overwrites confirmed prices
 *   npm run prices:skroutz -- --dry   prints what would change
 */

applySkroutzPrices({ force: process.argv.includes('--force'), dry: process.argv.includes('--dry') })
  .then((summary) => {
    console.log(`\n${summary}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
