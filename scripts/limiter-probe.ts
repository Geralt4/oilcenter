import { rateLimit } from '../src/lib/rate-limit';

/*
 * Internal probe used by scripts/test-security.ts. Runs in a fresh process against the same database,
 * so a limit written by one process must still be exhausted in the next (a simulated restart).
 *   tsx scripts/limiter-probe.ts exhaust <key> <limit>
 *   tsx scripts/limiter-probe.ts check   <key> <limit>
 */
async function main() {
  const [mode, key, limitArg] = process.argv.slice(2);
  const limit = Number(limitArg);
  if (!key || !Number.isInteger(limit)) throw new Error('usage: limiter-probe <exhaust|check> <key> <limit>');
  if (mode === 'exhaust') for (let i = 0; i < limit; i++) await rateLimit(key, limit, 60_000);
  process.stdout.write(JSON.stringify(await rateLimit(key, limit, 60_000)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
