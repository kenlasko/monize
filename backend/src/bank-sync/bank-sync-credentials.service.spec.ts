import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { EncryptionService } from "../common/encryption/encryption.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncCredentialsUnavailableException } from "./bank-sync-errors";
import {
  fakeProvider,
  fakeRegistry,
  testEncryption,
  testRsaPem,
  USER_ID,
} from "./bank-sync-testing";
import { BankSyncCredential } from "./entities/bank-sync-credential.entity";
import { BankSyncProviderError } from "./providers/bank-sync-provider.errors";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BankSyncCredentialsService", () => {
  const provider = fakeProvider();
  const registry = fakeRegistry(provider);
  const encryption = testEncryption();
  const repo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [BankSyncCredential, repo],
  ]);
  const configGet = jest.fn();

  async function build(enc: EncryptionService = encryption) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncCredentialsService,
        { provide: DataSource, useValue: dataSource },
        { provide: EncryptionService, useValue: enc },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: BankSyncProviderRegistry, useValue: registry },
      ],
    }).compile();
    return module.get(BankSyncCredentialsService);
  }

  function storedRow(privateKeyEnc: string): BankSyncCredential {
    return {
      id: "cred-1",
      userId: USER_ID,
      provider: "enable_banking",
      applicationId: "app-1",
      privateKeyEnc,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    configGet.mockImplementation(
      (_name: string, fallback?: string) => fallback,
    );
    repo.save.mockImplementation(async (row: BankSyncCredential) => row);
    manager.query.mockResolvedValue([]);
  });

  describe("redirectUrl", () => {
    it("is PUBLIC_APP_URL without trailing slashes plus the callback page", async () => {
      configGet.mockReturnValue("https://money.example.com///");
      const service = await build();
      expect(service.redirectUrl()).toBe(
        "https://money.example.com/settings/bank-sync/callback",
      );
    });

    it("falls back to the dev default when the variable is unset", async () => {
      const service = await build();
      expect(service.redirectUrl()).toBe(
        "http://localhost:3000/settings/bank-sync/callback",
      );
    });
  });

  describe("getStatus", () => {
    it("reports no credentials and the providers", async () => {
      repo.findOne.mockResolvedValue(null);
      const service = await build();
      await expect(service.getStatus(USER_ID)).resolves.toEqual({
        encryptionAvailable: true,
        providers: ["enable_banking"],
        credentials: null,
        redirectUrl: "http://localhost:3000/settings/bank-sync/callback",
      });
    });

    it("reports encryption as unavailable when no key is configured", async () => {
      repo.findOne.mockResolvedValue(null);
      const service = await build(testEncryption(false));
      expect((await service.getStatus(USER_ID)).encryptionAvailable).toBe(
        false,
      );
    });

    it("never carries the key or its ciphertext (INV-BANKSYNC-002)", async () => {
      const pem = testRsaPem();
      const ciphertext = encryption.encrypt(pem);
      repo.findOne.mockResolvedValue(storedRow(ciphertext));
      const service = await build();

      const status = await service.getStatus(USER_ID);

      expect(status.credentials).toEqual({
        provider: "enable_banking",
        applicationId: "app-1",
        privateKeySet: true,
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain("PRIVATE KEY");
      expect(serialized).not.toContain(ciphertext);
      expect(serialized).not.toMatch(/privateKeyEnc|privateKeyPem/);
    });
  });

  describe("save", () => {
    it("encrypts a valid key before storing it and answers without it", async () => {
      const pem = testRsaPem();
      repo.findOne.mockResolvedValueOnce(null);
      repo.findOneOrFail.mockImplementation(async () => {
        const insert = manager.query.mock.calls.find((call) =>
          String(call[0]).includes("INSERT INTO bank_sync_credentials"),
        );
        return storedRow(insert![1][3] as string);
      });
      const service = await build();

      const status = await service.save(USER_ID, {
        applicationId: "  app-1  ",
        privateKey: pem,
      });

      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO bank_sync_credentials"),
      )!;
      expect(String(insert[0])).toContain("ON CONFLICT (user_id, provider)");
      const [userId, provider, applicationId, stored] = insert[1] as string[];
      expect([userId, provider, applicationId]).toEqual([
        USER_ID,
        "enable_banking",
        "app-1",
      ]);
      expect(stored).not.toContain("PRIVATE KEY");
      expect(encryption.decrypt(stored)).toBe(pem.trim());
      expect(status.credentials?.privateKeySet).toBe(true);
      expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    });

    it("keeps the stored key when none is supplied", async () => {
      const existing = storedRow("stored-ciphertext");
      repo.findOne.mockResolvedValueOnce(existing);
      const service = await build();

      const status = await service.save(USER_ID, { applicationId: "app-2" });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationId: "app-2",
          privateKeyEnc: "stored-ciphertext",
        }),
      );
      expect(status.credentials).toEqual({
        provider: "enable_banking",
        applicationId: "app-2",
        privateKeySet: true,
      });
    });

    it("treats a blank key as not supplied", async () => {
      repo.findOne.mockResolvedValueOnce(storedRow("stored-ciphertext"));
      const service = await build();
      await service.save(USER_ID, { applicationId: "app-2", privateKey: "  " });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ privateKeyEnc: "stored-ciphertext" }),
      );
    });

    it("replaces the stored key when a new one is supplied", async () => {
      repo.findOne.mockResolvedValueOnce(storedRow("old-ciphertext"));
      const service = await build();
      await service.save(USER_ID, {
        applicationId: "app-1",
        privateKey: testRsaPem(),
      });
      const saved = repo.save.mock.calls[0][0] as BankSyncCredential;
      expect(saved.privateKeyEnc).not.toBe("old-ciphertext");
      expect(encryption.decrypt(saved.privateKeyEnc)).toBe(testRsaPem().trim());
    });

    it("refuses inside the transaction when no key is stored and none supplied", async () => {
      repo.findOne.mockResolvedValueOnce(null);
      const service = await build();
      await expect(
        service.save(USER_ID, { applicationId: "app-1" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
      expect(
        manager.query.mock.calls.some((call) =>
          String(call[0]).includes("INSERT INTO bank_sync_credentials"),
        ),
      ).toBe(false);
    });

    it("refuses a key that is not a PEM RSA key, without echoing it", async () => {
      const service = await build();
      const secret =
        "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----";
      const error = await service
        .save(USER_ID, { applicationId: "app-1", privateKey: secret })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain("not-a-key");
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("refuses to store a key when the server has no encryption key", async () => {
      const service = await build(testEncryption(false));
      await expect(
        service.save(USER_ID, {
          applicationId: "app-1",
          privateKey: testRsaPem(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes the user's row for the provider", async () => {
      const service = await build();
      await service.remove(USER_ID);
      expect(repo.delete).toHaveBeenCalledWith({
        userId: USER_ID,
        provider: "enable_banking",
      });
    });
  });

  describe("resolveCredentials", () => {
    it("decrypts the stored key for a provider call", async () => {
      const pem = testRsaPem();
      repo.findOne.mockResolvedValue(storedRow(encryption.encrypt(pem)));
      const service = await build();
      await expect(
        service.resolveCredentials(USER_ID, "enable_banking"),
      ).resolves.toEqual({ applicationId: "app-1", privateKeyPem: pem });
    });

    it("refuses when nothing is stored", async () => {
      repo.findOne.mockResolvedValue(null);
      const service = await build();
      await expect(
        service.resolveCredentials(USER_ID, "enable_banking"),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Its own class: the daily sync reports it as data under 'credentials'.
      await expect(
        service.resolveCredentials(USER_ID, "enable_banking"),
      ).rejects.toBeInstanceOf(BankSyncCredentialsUnavailableException);
    });

    it("refuses an unreadable ciphertext and logs no content", async () => {
      repo.findOne.mockResolvedValue(storedRow("garbage-ciphertext"));
      const service = await build();
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await expect(
        service.resolveCredentials(USER_ID, "enable_banking"),
      ).rejects.toBeInstanceOf(BankSyncCredentialsUnavailableException);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("garbage-ciphertext");
    });
  });

  describe("test", () => {
    it("reports the application the provider names", async () => {
      repo.findOne.mockResolvedValue(
        storedRow(encryption.encrypt(testRsaPem())),
      );
      provider.testCredentials.mockResolvedValue({
        applicationName: "Monize",
        redirectUrls: ["https://x/callback"],
      });
      const service = await build();
      await expect(service.test(USER_ID)).resolves.toEqual({
        ok: true,
        applicationName: "Monize",
        redirectUrls: ["https://x/callback"],
      });
    });

    it("answers an empty name when the provider named none", async () => {
      repo.findOne.mockResolvedValue(
        storedRow(encryption.encrypt(testRsaPem())),
      );
      provider.testCredentials.mockResolvedValue({
        applicationName: null,
        redirectUrls: [],
      });
      const service = await build();
      expect((await service.test(USER_ID)).applicationName).toBe("");
    });

    it("maps a rejected application to a 400", async () => {
      repo.findOne.mockResolvedValue(
        storedRow(encryption.encrypt(testRsaPem())),
      );
      provider.testCredentials.mockRejectedValue(
        new BankSyncProviderError("unauthorized", "HTTP 401", 401),
      );
      const service = await build();
      await expect(service.test(USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
