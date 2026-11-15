import { Logger } from "@nestjs/common";
import { EncryptionService } from "../common/encryption/encryption.service";

/** The one decrypt of an emergency access message; null when unreadable, logged. */
export function decryptMessage(
  encryption: EncryptionService,
  logger: Logger,
  ciphertext: string | null,
): string | null {
  if (!ciphertext) return null;
  if (!encryption.isConfigured()) {
    logger.warn(
      "Encryption key not configured; emergency access message cannot be decrypted",
    );
    return null;
  }
  try {
    return encryption.decrypt(ciphertext);
  } catch (error) {
    logger.error(
      "Failed to decrypt emergency access message",
      error instanceof Error ? error.stack : error,
    );
    return null;
  }
}
