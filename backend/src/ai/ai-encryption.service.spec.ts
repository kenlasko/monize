import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AiEncryptionService } from "./ai-encryption.service";

describe("AiEncryptionService", () => {
  let service: AiEncryptionService;
  let mockConfigService: Partial<Record<keyof ConfigService, jest.Mock>>;

  const VALID_KEY = "a".repeat(32);

  beforeEach(async () => {
    mockConfigService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          if (key === "AI_ENCRYPTION_KEY") return VALID_KEY;
          return defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiEncryptionService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AiEncryptionService>(AiEncryptionService);
  });

  describe("isConfigured()", () => {
    it("returns true when key is at least 32 characters", () => {
      expect(service.isConfigured()).toBe(true);
    });

    it("returns false when key is too short", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("short");

      const module = await Test.createTestingModule({
        providers: [
          AiEncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const shortKeyService =
        module.get<AiEncryptionService>(AiEncryptionService);
      expect(shortKeyService.isConfigured()).toBe(false);
    });

    it("returns false when key is empty", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("");

      const module = await Test.createTestingModule({
        providers: [
          AiEncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const emptyService = module.get<AiEncryptionService>(AiEncryptionService);
      expect(emptyService.isConfigured()).toBe(false);
    });
  });

  describe("encrypt() / decrypt()", () => {
    it("round-trips plaintext through encrypt then decrypt", () => {
      const plaintext = "sk-ant-api03-secret-key-value";
      const encrypted = service.encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(":");

      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for the same plaintext", () => {
      const plaintext = "same-key";
      const enc1 = service.encrypt(plaintext);
      const enc2 = service.encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    it("throws when encryption key is not configured", async () => {
      mockConfigService.get = jest.fn().mockReturnValue("");

      const module = await Test.createTestingModule({
        providers: [
          AiEncryptionService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const unconfiguredService =
        module.get<AiEncryptionService>(AiEncryptionService);
      expect(() => unconfiguredService.encrypt("test")).toThrow(
        "AI_ENCRYPTION_KEY is not configured",
      );
      expect(() => unconfiguredService.decrypt("test")).toThrow(
        "AI_ENCRYPTION_KEY is not configured",
      );
    });
  });

  describe("maskApiKey()", () => {
    it("returns null for null input", () => {
      expect(service.maskApiKey(null)).toBeNull();
    });

    it("masks long keys showing last 4 characters", () => {
      expect(service.maskApiKey("sk-ant-api03-secret-key-abcd")).toBe(
        "****abcd",
      );
    });

    it("masks short keys completely", () => {
      expect(service.maskApiKey("abc")).toBe("****");
    });

    it("masks exactly 4 char keys", () => {
      expect(service.maskApiKey("abcd")).toBe("****");
    });

    it("masks 5 char keys showing last 4", () => {
      expect(service.maskApiKey("xabcd")).toBe("****abcd");
    });
  });
});
