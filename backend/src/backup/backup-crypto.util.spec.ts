import {
  encryptBackup,
  decryptBackup,
  isEncryptedBackup,
  BackupDecryptionError,
} from "./backup-crypto.util";

describe("backup-crypto.util", () => {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, accounts: [{ id: "a" }] }),
    "utf-8",
  );

  describe("isEncryptedBackup", () => {
    it("returns false for plain gzip-shaped bytes", () => {
      // gzip magic: 1f 8b
      expect(isEncryptedBackup(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(
        false,
      );
    });

    it("returns false for empty buffer", () => {
      expect(isEncryptedBackup(Buffer.alloc(0))).toBe(false);
    });

    it("returns true for an encrypted envelope", () => {
      const ct = encryptBackup(payload, "correct horse battery staple");
      expect(isEncryptedBackup(ct)).toBe(true);
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("decrypts back to the original payload with the right password", () => {
      const password = "correct horse battery staple";
      const ct = encryptBackup(payload, password);
      const pt = decryptBackup(ct, password);
      expect(pt.equals(payload)).toBe(true);
    });

    it("produces different ciphertexts each call (random salt+iv)", () => {
      const password = "same-password";
      const a = encryptBackup(payload, password);
      const b = encryptBackup(payload, password);
      expect(a.equals(b)).toBe(false);
    });

    it("throws BackupDecryptionError on wrong password", () => {
      const ct = encryptBackup(payload, "right");
      expect(() => decryptBackup(ct, "wrong")).toThrow(BackupDecryptionError);
    });

    it("throws BackupDecryptionError on tampered ciphertext", () => {
      const ct = encryptBackup(payload, "p");
      ct[ct.length - 1] ^= 0xff;
      expect(() => decryptBackup(ct, "p")).toThrow(BackupDecryptionError);
    });

    it("throws on input lacking magic header", () => {
      const notEncrypted = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0]);
      expect(() => decryptBackup(notEncrypted, "p")).toThrow(
        BackupDecryptionError,
      );
    });

    it("requires a non-empty password to encrypt", () => {
      expect(() => encryptBackup(payload, "")).toThrow();
    });

    it("throws on an unsupported KDF byte", () => {
      const ct = encryptBackup(payload, "p");
      // Flip the KDF byte (index 5) to an unsupported value.
      ct[5] = 0x99;
      expect(() => decryptBackup(ct, "p")).toThrow(
        /Unsupported key derivation function/,
      );
    });
  });
});
