import * as crypto from "crypto";

// Backup file envelope format (binary, prepended to ciphertext):
//
//   bytes  0..3   magic        "MZBE"  (Monize Backup Encrypted)
//   byte   4      version      0x01
//   byte   5      kdf          0x01 = scrypt
//   bytes  6..21  salt         16 bytes
//   bytes 22..33  iv           12 bytes (GCM standard)
//   bytes 34..49  authTag      16 bytes
//   bytes 50..    ciphertext   = gzip(JSON)
//
// scrypt parameters are deliberately written into the format-version byte so
// future cost increases can be rolled out without breaking old backups.
const MAGIC = Buffer.from("MZBE", "ascii");
const VERSION = 0x01;
const KDF_SCRYPT = 0x01;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
const KEY_LENGTH = 32;
const SCRYPT_N = 1 << 15; // 32768; tuned for ~100ms on modern hardware
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * True if `buf` carries the Monize encrypted-backup magic header. Used so
 * restore can tell whether the upload is a raw gzip backup (legacy) or an
 * encrypted envelope, without trying both code paths.
 */
export function isEncryptedBackup(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_LENGTH &&
    buf.subarray(0, MAGIC.length).equals(MAGIC) &&
    buf[MAGIC.length] === VERSION
  );
}

/**
 * Encrypt the gzipped-JSON payload under a password-derived AES-256-GCM key.
 * Returns the full envelope: magic + version + kdf + salt + iv + tag + ct.
 */
export function encryptBackup(payload: Buffer, password: string): Buffer {
  if (!password) {
    throw new Error("Backup encryption requires a non-empty password");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, KDF_SCRYPT]),
    salt,
    iv,
    authTag,
    ciphertext,
  ]);
}

export class BackupDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupDecryptionError";
  }
}

/**
 * Decrypt a Monize encrypted-backup envelope. A wrong password (or any
 * tampering) surfaces as a BackupDecryptionError -- callers map this to a
 * prompt-for-password response instead of a transaction failure.
 */
export function decryptBackup(envelope: Buffer, password: string): Buffer {
  // isEncryptedBackup already enforces length >= HEADER_LENGTH, so we don't
  // re-check it here.
  if (!isEncryptedBackup(envelope)) {
    throw new BackupDecryptionError(
      "Backup file is not in the encrypted Monize format",
    );
  }

  const kdf = envelope[MAGIC.length + 1];
  if (kdf !== KDF_SCRYPT) {
    throw new BackupDecryptionError(
      `Unsupported key derivation function: ${kdf}`,
    );
  }

  let offset = MAGIC.length + 2;
  const salt = envelope.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = envelope.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = envelope.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = envelope.subarray(offset);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth-tag mismatch -- almost always a wrong password.
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the password is incorrect or the file is corrupt",
    );
  }
}
