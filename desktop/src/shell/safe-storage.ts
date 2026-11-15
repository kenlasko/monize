import { SafeStorageLike } from "../secrets";

/** The slice of Electron's `safeStorage` the shell reads. */
export interface ElectronSafeStorageLike extends SafeStorageLike {
  /** Linux only in Electron; absent elsewhere. */
  getSelectedStorageBackend?: () => string;
}

/**
 * Electron's `safeStorage` as the secrets module should see it. On Linux
 * without a keyring Electron falls back to `basic_text`, which "encrypts" with
 * a key hard-coded in Chromium: that is plain text with extra steps, so it is
 * reported as unavailable and the secrets module applies its own rule
 * (refuse, unless `MONIZE_INSECURE_SECRETS=1`). Windows uses DPAPI and is
 * passed through unchanged.
 */
export function effectiveSafeStorage(
  safeStorage: ElectronSafeStorageLike,
  platform: NodeJS.Platform,
): SafeStorageLike {
  const weak =
    platform === "linux" &&
    typeof safeStorage.getSelectedStorageBackend === "function" &&
    safeStorage.getSelectedStorageBackend() === "basic_text";
  return {
    isEncryptionAvailable: () => !weak && safeStorage.isEncryptionAvailable(),
    encryptString: (text) => safeStorage.encryptString(text),
    decryptString: (data) => safeStorage.decryptString(data),
  };
}
