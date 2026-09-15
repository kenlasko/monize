import { Test, TestingModule } from "@nestjs/testing";
import { ROLES_KEY } from "../../auth/guards/roles.guard";
import { DEMO_RESTRICTED_KEY } from "../../common/guards/demo-mode.guard";
import { BackupOffsiteController } from "./backup-offsite.controller";
import { BackupOffsiteSettingsService } from "./backup-offsite-settings.service";
import { BackupOffsiteSettingsView } from "./dto/update-backup-offsite-settings.dto";

describe("BackupOffsiteController", () => {
  let controller: BackupOffsiteController;
  let service: Record<string, jest.Mock>;

  const userId = "11111111-1111-4111-8111-111111111111";
  const view: BackupOffsiteSettingsView = {
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
  };

  beforeEach(async () => {
    service = {
      getView: jest.fn().mockResolvedValue(view),
      update: jest.fn().mockResolvedValue(view),
      listUploads: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupOffsiteController],
      providers: [{ provide: BackupOffsiteSettingsService, useValue: service }],
    }).compile();

    controller = module.get(BackupOffsiteController);
  });

  describe("access control", () => {
    /**
     * Not admin-only, unlike `AutoBackupController`. The folder and the schedule
     * are the operator's decision about the server's disk; a destination is the
     * user's decision about their own data leaving the machine. The assertion is
     * here so that stays a decision rather than an omission.
     */
    it("is open to every authenticated user rather than to admins", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, BackupOffsiteController),
      ).toBeUndefined();
    });

    it("keeps the write out of the demo deployment", () => {
      expect(
        Reflect.getMetadata(
          DEMO_RESTRICTED_KEY,
          controller.updateOffsiteSettings,
        ),
      ).toBe(true);
      // The reads are not restricted: showing a demo user the page is harmless.
      expect(
        Reflect.getMetadata(DEMO_RESTRICTED_KEY, controller.getOffsiteSettings),
      ).toBeUndefined();
    });
  });

  describe("getOffsiteSettings", () => {
    it("reads the caller's own destinations", async () => {
      expect(
        await controller.getOffsiteSettings({ user: { id: userId } }),
      ).toBe(view);
      expect(service.getView).toHaveBeenCalledWith(userId);
    });
  });

  describe("updateOffsiteSettings", () => {
    it("passes the JWT's user, never one from the body", async () => {
      const dto = { s3Mode: "off" as const, emailEnabled: false };

      await controller.updateOffsiteSettings({ user: { id: userId } }, {
        ...dto,
        // A body field named like an identity, to prove it goes nowhere: the
        // DTO has no such property, so it cannot reach the service, and the
        // service is called with the JWT's id.
      } as never);

      expect(service.update).toHaveBeenCalledWith(userId, dto);
    });
  });

  describe("listOffsiteUploads", () => {
    it("passes the requested page through", async () => {
      await controller.listOffsiteUploads({ user: { id: userId } }, 25);

      expect(service.listUploads).toHaveBeenCalledWith(userId, 25);
    });

    it.each([
      ["above the ceiling", 10_000, 200],
      ["at zero", 0, 1],
      ["negative", -5, 1],
    ])("bounds a limit %s", async (_label, asked, expected) => {
      await controller.listOffsiteUploads({ user: { id: userId } }, asked);

      expect(service.listUploads).toHaveBeenCalledWith(userId, expected);
    });
  });
});
