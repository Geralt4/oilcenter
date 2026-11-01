import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Encryption of database backups: the stored copies on the volume and the copies sent to Backblaze B2 use the same format and the
 * same key, so one tool opens both (npm run backup:decrypt for a stored copy, npm run backup:pull for one in B2).
 *
 * AES-256-GCM (OpenSSL, via node:crypto), random 96-bit nonce per file. File layout:
 *
 *   "OCBK1" | 12-byte nonce | 16-byte GCM tag | ciphertext
 *
 * BACKUP_ENCRYPTION_KEY is a base64 32-byte key. It lives in the Railway variables (the app must encrypt with it) AND in two
 * offline copies (owner + developer): the app copy is lost with the platform, the offline copies are what make a restore possible.
 * The key must NOT be kept in the B2 account or on the same volume as the backups.
 */

const MAGIC = Buffer.from('OCBK1');
const NONCE = 12;
const TAG = 16;

/** A stored or uploaded backup ends in this when it is encrypted. */
export const ENCRYPTED_SUFFIX = '.enc';

/** Is a backup key set at all (a malformed one is reported by the startup check, and by encryptionKey() below)? */
export const backupKeyConfigured = () => Boolean((process.env.BACKUP_ENCRYPTION_KEY ?? '').trim());

function encryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes base64 (generate: openssl rand -base64 32)');
  return key;
}

export function encryptBackup(plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
}

export function decryptBackup(sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + NONCE + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Oil Center backup file (magic header missing).');
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE);
  const tag = sealed.subarray(MAGIC.length + NONCE, MAGIC.length + NONCE + TAG);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAuthTag(tag); // authenticated: a flipped byte anywhere fails here, never returns wrong plaintext
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + NONCE + TAG)), decipher.final()]);
}
