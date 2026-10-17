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

/**
 * Read a JSON body without ever buffering more than `maxBytes`. Next hands route handlers a stream,
 * so the size can be enforced while reading — a false or missing Content-Length cannot get around it.
 * Returns `{ ok: false, tooLarge: true }` once the cap is crossed.
 */
export async function readJsonLimited(request: Request, maxBytes = 64 * 1024): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: false, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}
