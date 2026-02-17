import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { encrypt, decrypt } from "../auth/crypto.util";

@Injectable()
export class AiEncryptionService {
  private readonly encryptionKey: string;

  constructor(private readonly configService: ConfigService) {
    this.encryptionKey = this.configService.get<string>(
      "AI_ENCRYPTION_KEY",
      "",
    );
  }

  isConfigured(): boolean {
    return this.encryptionKey.length >= 32;
  }

  encrypt(plaintext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "AI_ENCRYPTION_KEY is not configured or too short (minimum 32 characters)",
      );
    }
    return encrypt(plaintext, this.encryptionKey);
  }

  decrypt(ciphertext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "AI_ENCRYPTION_KEY is not configured or too short (minimum 32 characters)",
      );
    }
    return decrypt(ciphertext, this.encryptionKey);
  }

  maskApiKey(apiKey: string | null): string | null {
    if (!apiKey) return null;
    if (apiKey.length <= 4) return "****";
    return "****" + apiKey.slice(-4);
  }
}
