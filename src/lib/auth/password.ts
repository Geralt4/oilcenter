import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';

/*
 * scrypt from node:crypto — no native add-on to compile, and memory-hard.
 * Stored format:  scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: 128 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** For single-use tokens (password reset): only the hash is stored, the raw token travels by e-mail. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
