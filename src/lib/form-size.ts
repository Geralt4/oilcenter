/*
 * Body-size guard for PUBLIC server actions.
 *
 * Next.js applies one body-size limit to ALL server actions (next.config.ts, 32 MB) because the admin
 * product form uploads phone photos. Public forms never carry files, yet without a check of their own
 * a huge submission would be buffered, parsed and walked field-by-field before zod's per-field limits
 * ever ran. This guard runs first (right after the rate limit) and refuses anything a real browser
 * form could never produce.
 */
const DEFAULT_MAX_KB = 256;

/** Rough total size of a FormData submission: file bytes plus UTF-8 length of every text field. */
export function formBytes(fd: FormData): number {
  let total = 0;
  for (const value of fd.values()) {
    if (value instanceof File) total += value.size;
    else total += Buffer.byteLength(String(value), 'utf8');
  }
  return total;
}

/** True when the submission is bigger than a public form has any business being. */
export function formTooBig(fd: FormData, maxKb = DEFAULT_MAX_KB): boolean {
  return formBytes(fd) > maxKb * 1024;
}
