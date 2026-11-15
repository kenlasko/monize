import { SafeStorageLike } from "../secrets";

/**
 * A reversible stand-in for Electron `safeStorage`, for specs only. The
 * "ciphertext" is the plaintext reversed behind a marker, so a spec can tell a
 * wrapped value from a plain one and a foreign blob fails to decrypt.
 */
const MARKER = "fake-dpapi:";

export function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) =>
      Buffer.from(MARKER + [...plainText].reverse().join(""), "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith(MARKER)) {
        throw new Error(`cannot decrypt ${text}`);
      }
      return [...text.slice(MARKER.length)].reverse().join("");
    },
  };
}
