import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { BackupOffsiteSettingsService } from "./backup-offsite-settings.service";
import { BackupOffsiteSettings } from "./entities/backup-offsite-settings.entity";
import { BackupOffsiteUpload } from "./entities/backup-offsite-upload.entity";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * The user's own off-machine destinations: what the API may say about them,
 * what it must refuse, and what the dispatcher is handed
 * (`docs/specs/backup-off-machine.md` sections 4, 7 and 9).
 *
 * The secrets are deliberately recognisable strings rather than realistic ones,
 * so the masking assertions can search the whole serialized response for the
 * plaintext *and* the ciphertext and fail on either. A view that carried one
 * through would otherwise look exactly like a view that did not.
 */
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_KEY_PLAINTEXT = "PLAINTEXT-ACCESS-KEY-ID";
const SECRET_PLAINTEXT = "PLAINTEXT-SECRET-ACCESS-KEY";
const cipherOf = (plaintext: string): string => `CIPHERTEXT(${plaintext})`;

describe("BackupOffsiteSettingsService", () => {
  let service: BackupOffsiteSettingsService;
  let settingsRepo: Record<string, jest.Mock>;
  let uploadsRepo: Record<string, jest.Mock>;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let encryption: Record<string, jest.Mock>;
  let env: Record<string, string | undefined>;

  /**
   * Build the service against the environment a test wants.
   *
   * The deployment target is read once in the constructor -- the environment
   * does not change under a running process -- so a test that needs a
   * deployment bucket has to say so before the service exists.
   */
  const build = async (
    environment: Record<string, string | undefined> = {},
  ): Promise<void> => {
    env = environment;
    settingsRepo = { findOne: jest.fn(), save: jest.fn() };
    uploadsRepo = { find: jest.fn() };
    scoped = createScopedDbMocks([
      [BackupOffsiteSettings, settingsRepo],
      [BackupOffsiteUpload, uploadsRepo],
    ]);
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((plaintext: string) => cipherOf(plaintext)),
      decrypt: jest.fn((ciphertext: string) => {
        const match = /^CIPHERTEXT\((.*)\)$/.exec(ciphertext);
        if (!match)
          throw new Error("unsupported state or unable to authenticate data");
        return match[1];
      }),
    };
    // The repository's save returns the saved row, as TypeORM's does; a double
    // that returned undefined would make every "what did the caller get back"
    // assertion pass on a service that returned the seed instead.
    settingsRepo.save.mockImplementation(async (row: unknown) => row);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupOffsiteSettingsService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: EncryptionService, useValue: encryption },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((name: string) => env[name]) },
        },
      ],
    }).compile();

    service = module.get(BackupOffsiteSettingsService);
  };

  /** A stored row, with only the fields a test cares about overridden. */
  const row = (
    overrides: Partial<BackupOffsiteSettings> = {},
  ): BackupOffsiteSettings =>
    Object.assign(new BackupOffsiteSettings(), {
      userId: USER_ID,
      s3Mode: "off",
      s3Bucket: null,
      s3Region: null,
      s3Prefix: null,
      s3Endpoint: null,
      s3ForcePathStyle: false,
      s3AccessKeyId: null,
      s3SecretAccessKey: null,
      emailEnabled: false,
      emailTo: null,
      ...overrides,
    });

  beforeEach(async () => {
    await build();
  });

  describe("getView", () => {
    it("reports everything off for a user who has configured nothing", async () => {
      settingsRepo.findOne.mockResolvedValue(null);

      expect(await service.getView(USER_ID)).toEqual({
        s3Mode: "off",
        s3Bucket: null,
        s3Region: null,
        s3Prefix: null,
        s3Endpoint: null,
        s3ForcePathStyle: false,
        s3AccessKeyIdSet: false,
        s3SecretAccessKeySet: false,
        emailEnabled: false,
        emailTo: null,
        deploymentS3Available: false,
        encryptionConfigured: true,
      });
      // A read must not write a row for a user who only looked at the page.
      expect(settingsRepo.save).not.toHaveBeenCalled();
    });

    it("reports a stored credential as set, and never its value", async () => {
      settingsRepo.findOne.mockResolvedValue(
        row({
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
          s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
        }),
      );

      const view = await service.getView(USER_ID);
      const serialized = JSON.stringify(view);

      expect(view.s3AccessKeyIdSet).toBe(true);
      expect(view.s3SecretAccessKeySet).toBe(true);
      // Neither the ciphertext nor the plaintext, anywhere in the response.
      expect(serialized).not.toContain(ACCESS_KEY_PLAINTEXT);
      expect(serialized).not.toContain(SECRET_PLAINTEXT);
      expect(serialized).not.toContain("CIPHERTEXT");
      // And nothing decrypted a secret merely to answer "is one stored?".
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("says whether the deployment has a bucket of its own", async () => {
      await build({ BACKUP_S3_BUCKET: "deployment-bucket" });
      settingsRepo.findOne.mockResolvedValue(null);

      expect((await service.getView(USER_ID)).deploymentS3Available).toBe(true);
    });

    it("says whether a credential can be stored at all", async () => {
      encryption.isConfigured.mockReturnValue(false);
      settingsRepo.findOne.mockResolvedValue(null);

      expect((await service.getView(USER_ID)).encryptionConfigured).toBe(false);
    });
  });

  describe("update", () => {
    it("seeds a row for a user who has none and stores the change", async () => {
      settingsRepo.findOne.mockResolvedValue(null);

      const view = await service.update(USER_ID, {
        emailEnabled: true,
        emailTo: "me@example.com",
      });

      expect(settingsRepo.save).toHaveBeenCalledTimes(1);
      const saved = settingsRepo.save.mock.calls[0][0];
      expect(saved.userId).toBe(USER_ID);
      expect(saved.s3Mode).toBe("off");
      expect(view.emailEnabled).toBe(true);
      expect(view.emailTo).toBe("me@example.com");
    });

    it("loads, checks and saves inside one transaction", async () => {
      // Rejection before the write is only a property if the check and the
      // write share a transaction; two short ones would let a refusal follow a
      // commit (docs/backend/database-access-and-tenancy.md).
      settingsRepo.findOne.mockResolvedValue(null);

      await service.update(USER_ID, { emailEnabled: false });

      expect(scoped.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("leaves a field the request did not mention alone", async () => {
      settingsRepo.findOne.mockResolvedValue(
        row({ emailEnabled: true, emailTo: "me@example.com" }),
      );

      await service.update(USER_ID, { s3ForcePathStyle: true });

      const saved = settingsRepo.save.mock.calls[0][0];
      expect(saved.emailTo).toBe("me@example.com");
      expect(saved.s3ForcePathStyle).toBe(true);
    });

    it("clears a text column the form sent empty", async () => {
      settingsRepo.findOne.mockResolvedValue(row({ s3Region: "eu-west-1" }));

      await service.update(USER_ID, { s3Region: "" });

      expect(settingsRepo.save.mock.calls[0][0].s3Region).toBeNull();
    });

    describe("credentials", () => {
      it("encrypts a supplied key pair before it is stored", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await service.update(USER_ID, {
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
          s3SecretAccessKey: SECRET_PLAINTEXT,
        });

        const saved = settingsRepo.save.mock.calls[0][0];
        expect(encryption.encrypt).toHaveBeenCalledWith(ACCESS_KEY_PLAINTEXT);
        expect(encryption.encrypt).toHaveBeenCalledWith(SECRET_PLAINTEXT);
        expect(saved.s3AccessKeyId).toBe(cipherOf(ACCESS_KEY_PLAINTEXT));
        expect(saved.s3SecretAccessKey).toBe(cipherOf(SECRET_PLAINTEXT));
        // The plaintext is not what lands in the column.
        expect(saved.s3AccessKeyId).not.toBe(ACCESS_KEY_PLAINTEXT);
        expect(saved.s3SecretAccessKey).not.toBe(SECRET_PLAINTEXT);
      });

      it("does not echo a just-supplied credential back", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        const view = await service.update(USER_ID, {
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
          s3SecretAccessKey: SECRET_PLAINTEXT,
        });

        const serialized = JSON.stringify(view);
        expect(serialized).not.toContain(ACCESS_KEY_PLAINTEXT);
        expect(serialized).not.toContain(SECRET_PLAINTEXT);
        expect(serialized).not.toContain("CIPHERTEXT");
        expect(view.s3AccessKeyIdSet).toBe(true);
        expect(view.s3SecretAccessKeySet).toBe(true);
      });

      it("keeps a stored credential when the form resends it blank", async () => {
        // The field is never rendered back, so it is empty on every load.
        // Reading that as "forget my key" would break a working destination on
        // the next unrelated save.
        settingsRepo.findOne.mockResolvedValue(
          row({
            s3Mode: "own",
            s3Bucket: "my-bucket",
            s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
            s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
          }),
        );

        await service.update(USER_ID, {
          s3AccessKeyId: "",
          s3SecretAccessKey: "",
        });

        const saved = settingsRepo.save.mock.calls[0][0];
        expect(saved.s3AccessKeyId).toBe(cipherOf(ACCESS_KEY_PLAINTEXT));
        expect(saved.s3SecretAccessKey).toBe(cipherOf(SECRET_PLAINTEXT));
      });

      it("forgets both halves on clearS3Credentials", async () => {
        settingsRepo.findOne.mockResolvedValue(
          row({
            s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
            s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
          }),
        );

        const view = await service.update(USER_ID, {
          clearS3Credentials: true,
        });

        const saved = settingsRepo.save.mock.calls[0][0];
        expect(saved.s3AccessKeyId).toBeNull();
        expect(saved.s3SecretAccessKey).toBeNull();
        expect(view.s3AccessKeyIdSet).toBe(false);
        expect(view.s3SecretAccessKeySet).toBe(false);
      });

      it("replaces rather than forgets when a clear and a new pair arrive together", async () => {
        settingsRepo.findOne.mockResolvedValue(
          row({ s3AccessKeyId: cipherOf("old-id") }),
        );

        await service.update(USER_ID, {
          clearS3Credentials: true,
          s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
          s3SecretAccessKey: SECRET_PLAINTEXT,
        });

        const saved = settingsRepo.save.mock.calls[0][0];
        expect(saved.s3AccessKeyId).toBe(cipherOf(ACCESS_KEY_PLAINTEXT));
        expect(saved.s3SecretAccessKey).toBe(cipherOf(SECRET_PLAINTEXT));
      });
    });

    describe("refusals", () => {
      /** Every refusal must leave the row exactly as it was. */
      const expectNothingWritten = (): void => {
        expect(settingsRepo.save).not.toHaveBeenCalled();
      };

      it("refuses the deployment destination when there is no deployment bucket", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, { s3Mode: "deployment" }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.update(USER_ID, { s3Mode: "deployment" }),
        ).rejects.toThrow(/BACKUP_S3_BUCKET/);
        expectNothingWritten();
      });

      it("accepts the deployment destination once the bucket is configured", async () => {
        await build({ BACKUP_S3_BUCKET: "deployment-bucket" });
        settingsRepo.findOne.mockResolvedValue(null);

        const view = await service.update(USER_ID, { s3Mode: "deployment" });

        expect(view.s3Mode).toBe("deployment");
        expect(settingsRepo.save).toHaveBeenCalledTimes(1);
      });

      it("refuses an own destination with no bucket", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, {
            s3Mode: "own",
            s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
            s3SecretAccessKey: SECRET_PLAINTEXT,
          }),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });

      it("refuses an own destination with neither stored nor supplied credentials", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, { s3Mode: "own", s3Bucket: "my-bucket" }),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });

      it("refuses an own destination holding only half a key pair", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, {
            s3Mode: "own",
            s3Bucket: "my-bucket",
            s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
          }),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });

      it("accepts an own destination whose credentials are already stored", async () => {
        settingsRepo.findOne.mockResolvedValue(
          row({
            s3Bucket: "my-bucket",
            s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
            s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
          }),
        );

        const view = await service.update(USER_ID, { s3Mode: "own" });

        expect(view.s3Mode).toBe("own");
        expect(settingsRepo.save).toHaveBeenCalledTimes(1);
      });

      it("refuses a supplied credential when the deployment has no encryption key", async () => {
        // Storing it in the clear would put an S3 key pair in the database and
        // in every backup artifact taken afterwards.
        encryption.isConfigured.mockReturnValue(false);
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, {
            s3Mode: "own",
            s3Bucket: "my-bucket",
            s3AccessKeyId: ACCESS_KEY_PLAINTEXT,
            s3SecretAccessKey: SECRET_PLAINTEXT,
          }),
        ).rejects.toThrow(/ENCRYPTION_KEY/);
        expect(encryption.encrypt).not.toHaveBeenCalled();
        expectNothingWritten();
      });

      it("refuses email with no address", async () => {
        settingsRepo.findOne.mockResolvedValue(null);

        await expect(
          service.update(USER_ID, { emailEnabled: true }),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });

      it("refuses clearing the address of an already enabled email destination", async () => {
        settingsRepo.findOne.mockResolvedValue(
          row({ emailEnabled: true, emailTo: "me@example.com" }),
        );

        await expect(service.update(USER_ID, { emailTo: "" })).rejects.toThrow(
          BadRequestException,
        );
        expectNothingWritten();
      });
    });
  });

  describe("resolveS3Target", () => {
    it("reports off for a user who configured nothing", async () => {
      settingsRepo.findOne.mockResolvedValue(null);

      expect(await service.resolveS3Target(USER_ID)).toEqual({
        target: null,
        reason: "off",
      });
    });

    it("hands back the deployment destination", async () => {
      await build({
        BACKUP_S3_BUCKET: "deployment-bucket",
        BACKUP_S3_PREFIX: "backups",
        BACKUP_S3_REGION: "eu-west-1",
      });
      settingsRepo.findOne.mockResolvedValue(row({ s3Mode: "deployment" }));

      const resolution = await service.resolveS3Target(USER_ID);

      expect(resolution.target).toEqual(
        expect.objectContaining({
          bucket: "deployment-bucket",
          prefix: "backups/",
          region: "eu-west-1",
        }),
      );
      // The deployment's own credential chain, not the user's row.
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("reports a deployment destination the deployment never configured", async () => {
      settingsRepo.findOne.mockResolvedValue(row({ s3Mode: "deployment" }));

      expect(await service.resolveS3Target(USER_ID)).toEqual({
        target: null,
        reason: "deployment-unconfigured",
      });
    });

    it("builds an own destination from the row, decrypting both halves", async () => {
      await build({ BACKUP_S3_MULTIPART_PART_BYTES: "8388608" });
      settingsRepo.findOne.mockResolvedValue(
        row({
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3Region: "us-west-2",
          s3Prefix: "monize",
          s3Endpoint: "http://minio:9000",
          s3ForcePathStyle: true,
          s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
          s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
        }),
      );

      expect(await service.resolveS3Target(USER_ID)).toEqual({
        target: {
          bucket: "my-bucket",
          region: "us-west-2",
          prefix: "monize/",
          endpoint: "http://minio:9000",
          forcePathStyle: true,
          credentials: {
            accessKeyId: ACCESS_KEY_PLAINTEXT,
            secretAccessKey: SECRET_PLAINTEXT,
          },
          deadlineMs: 5 * 60 * 1000,
          multipartPartBytes: 8_388_608,
        },
      });
    });

    it("reports an own destination that is missing a half", async () => {
      settingsRepo.findOne.mockResolvedValue(
        row({
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
        }),
      );

      expect(await service.resolveS3Target(USER_ID)).toEqual({
        target: null,
        reason: "own-incomplete",
      });
    });

    it("reports unreadable credentials, and never falls back to the deployment bucket", async () => {
      // A rotated ENCRYPTION_KEY leaves the columns populated and undecryptable.
      // Copying the user's backup into the operator's bucket instead would put
      // their data somewhere they did not choose (spec section 7).
      await build({ BACKUP_S3_BUCKET: "deployment-bucket" });
      encryption.decrypt.mockImplementation(() => {
        throw new Error("Unsupported state or unable to authenticate data");
      });
      settingsRepo.findOne.mockResolvedValue(
        row({
          s3Mode: "own",
          s3Bucket: "my-bucket",
          s3AccessKeyId: cipherOf(ACCESS_KEY_PLAINTEXT),
          s3SecretAccessKey: cipherOf(SECRET_PLAINTEXT),
        }),
      );

      expect(await service.resolveS3Target(USER_ID)).toEqual({
        target: null,
        reason: "credentials-unreadable",
      });
    });
  });

  describe("resolveEmail", () => {
    it("is null when the destination is off", async () => {
      settingsRepo.findOne.mockResolvedValue(
        row({ emailEnabled: false, emailTo: "me@example.com" }),
      );

      expect(await service.resolveEmail(USER_ID)).toBeNull();
    });

    it("is null when there is no row at all", async () => {
      settingsRepo.findOne.mockResolvedValue(null);

      expect(await service.resolveEmail(USER_ID)).toBeNull();
    });

    it("hands back the configured address", async () => {
      settingsRepo.findOne.mockResolvedValue(
        row({ emailEnabled: true, emailTo: "me@example.com" }),
      );

      expect(await service.resolveEmail(USER_ID)).toEqual({
        to: "me@example.com",
      });
    });
  });

  describe("emailMaxBytes", () => {
    it("is the documented default when nothing is configured", () => {
      expect(service.emailMaxBytes()).toBe(20 * 1024 * 1024);
    });

    it("follows the operator's bound", async () => {
      await build({ BACKUP_EMAIL_MAX_BYTES: "1048576" });

      expect(service.emailMaxBytes()).toBe(1_048_576);
    });
  });

  describe("listUploads", () => {
    it("asks for the caller's own rows, newest first", async () => {
      uploadsRepo.find.mockResolvedValue([]);

      await service.listUploads(USER_ID);

      expect(uploadsRepo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        order: { createdAt: "DESC" },
        take: 50,
      });
    });

    it("bounds a page nobody should be able to ask for", async () => {
      uploadsRepo.find.mockResolvedValue([]);

      await service.listUploads(USER_ID, 10_000);

      expect(uploadsRepo.find.mock.calls[0][0].take).toBe(200);
    });

    it("bounds a page of zero or fewer rows", async () => {
      uploadsRepo.find.mockResolvedValue([]);

      await service.listUploads(USER_ID, 0);

      expect(uploadsRepo.find.mock.calls[0][0].take).toBe(1);
    });
  });
});
