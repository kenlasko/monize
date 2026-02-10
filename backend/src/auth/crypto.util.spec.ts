import { encrypt, decrypt } from "./crypto.util";

describe("crypto.util", () => {
  const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

  describe("encrypt and decrypt round-trip", () => {
    it("encrypts and decrypts text correctly", () => {
      const plaintext = "my-secret-totp-key";
      const encrypted = encrypt(plaintext, jwtSecret);
      const decrypted = decrypt(encrypted, jwtSecret);
      expect(decrypted).toBe(plaintext);
    });

    it("handles empty string", () => {
      const plaintext = "";
      const encrypted = encrypt(plaintext, jwtSecret);
      const decrypted = decrypt(encrypted, jwtSecret);
      expect(decrypted).toBe(plaintext);
    });

    it("handles special characters", () => {
      const plaintext = "secret!@#$%^&*()_+-=[]{}|;':\",./<>?";
      const encrypted = encrypt(plaintext, jwtSecret);
      const decrypted = decrypt(encrypted, jwtSecret);
      expect(decrypted).toBe(plaintext);
    });

    it("handles unicode text", () => {
      const plaintext = "secret-with-unicode-\u00e9\u00e0\u00fc\u00f1";
      const encrypted = encrypt(plaintext, jwtSecret);
      const decrypted = decrypt(encrypted, jwtSecret);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("random salt produces different ciphertext", () => {
    it("different encryptions produce different ciphertext", () => {
      const plaintext = "same-secret-value";
      const encrypted1 = encrypt(plaintext, jwtSecret);
      const encrypted2 = encrypt(plaintext, jwtSecret);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("both different ciphertexts decrypt to the same plaintext", () => {
      const plaintext = "same-secret-value";
      const encrypted1 = encrypt(plaintext, jwtSecret);
      const encrypted2 = encrypt(plaintext, jwtSecret);

      expect(decrypt(encrypted1, jwtSecret)).toBe(plaintext);
      expect(decrypt(encrypted2, jwtSecret)).toBe(plaintext);
    });
  });

  describe("output format", () => {
    it("produces 4-part format (salt:iv:authTag:ciphertext)", () => {
      const encrypted = encrypt("test", jwtSecret);
      const parts = encrypted.split(":");
      expect(parts).toHaveLength(4);
    });

    it("salt is 32 hex characters (16 bytes)", () => {
      const encrypted = encrypt("test", jwtSecret);
      const salt = encrypted.split(":")[0];
      expect(salt).toHaveLength(32);
      expect(salt).toMatch(/^[0-9a-f]{32}$/);
    });

    it("iv is 32 hex characters (16 bytes)", () => {
      const encrypted = encrypt("test", jwtSecret);
      const iv = encrypted.split(":")[1];
      expect(iv).toHaveLength(32);
      expect(iv).toMatch(/^[0-9a-f]{32}$/);
    });

    it("authTag is 32 hex characters (16 bytes)", () => {
      const encrypted = encrypt("test", jwtSecret);
      const authTag = encrypted.split(":")[2];
      expect(authTag).toHaveLength(32);
      expect(authTag).toMatch(/^[0-9a-f]{32}$/);
    });

    it("ciphertext is a hex string", () => {
      const encrypted = encrypt("test", jwtSecret);
      const ciphertext = encrypted.split(":")[3];
      expect(ciphertext).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("decrypt error handling", () => {
    it("throws for invalid format (too few parts)", () => {
      expect(() => decrypt("invalid-no-colons", jwtSecret)).toThrow(
        "Invalid encrypted text format",
      );
    });

    it("throws for invalid format (only 2 parts)", () => {
      expect(() => decrypt("part1:part2", jwtSecret)).toThrow(
        "Invalid encrypted text format",
      );
    });

    it("throws for invalid format (5 parts)", () => {
      expect(() =>
        decrypt("part1:part2:part3:part4:part5", jwtSecret),
      ).toThrow("Invalid encrypted text format");
    });

    it("throws for tampered ciphertext", () => {
      const encrypted = encrypt("test", jwtSecret);
      const parts = encrypted.split(":");
      // Tamper with the ciphertext
      parts[3] = "0000000000000000";
      const tampered = parts.join(":");
      expect(() => decrypt(tampered, jwtSecret)).toThrow();
    });

    it("throws when using wrong secret to decrypt", () => {
      const encrypted = encrypt("test", jwtSecret);
      expect(() => decrypt(encrypted, "wrong-secret-that-is-also-32-chars")).toThrow();
    });
  });

  describe("legacy 3-part format support", () => {
    it("accepts 3-part format (iv:authTag:ciphertext)", () => {
      // We can only test that the function doesn't throw "Invalid encrypted text format"
      // for 3-part strings. It will fail at decryption since we can't easily produce
      // valid legacy ciphertext in tests, but we can verify format validation passes.
      const encrypted = encrypt("test", jwtSecret);
      const parts = encrypted.split(":");
      // Remove salt to create a legacy-style 3-part format
      const legacyFormat = `${parts[1]}:${parts[2]}:${parts[3]}`;
      // This won't decrypt correctly (different key derivation), but it should not throw
      // "Invalid encrypted text format" - it will throw a decryption error instead
      expect(() => decrypt(legacyFormat, jwtSecret)).not.toThrow(
        "Invalid encrypted text format",
      );
    });
  });
});
