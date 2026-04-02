import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { AutoBackupService } from "./auto-backup.service";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";

describe("BackupController", () => {
  let controller: BackupController;
  let mockBackupService: Record<string, jest.Mock>;
  let mockAutoBackupService: Record<string, jest.Mock>;

  const userId = "test-user-id";
  const mockReq = {
    user: { id: userId },
    body: Buffer.from("gzip-data"),
    headers: {},
  };

  beforeEach(async () => {
    mockBackupService = {
      streamExport: jest.fn().mockResolvedValue(undefined),
      restoreData: jest.fn(),
    };

    mockAutoBackupService = {
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
      validateFolder: jest.fn(),
      browseFolders: jest.fn(),
      runManualBackup: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
        {
          provide: AutoBackupService,
          useValue: mockAutoBackupService,
        },
      ],
    }).compile();

    controller = module.get<BackupController>(BackupController);
  });

  describe("exportBackup", () => {
    it("should set response headers and delegate to streamExport", async () => {
      const mockRes = {
        setHeader: jest.fn(),
      };

      await controller.exportBackup(mockReq, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/gzip",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining(".json.gz"),
      );
      expect(mockBackupService.streamExport).toHaveBeenCalledWith(
        userId,
        mockRes,
      );
    });
  });

  describe("restoreBackup", () => {
    it("should pass compressed body and auth headers to service", async () => {
      const mockResult = {
        message: "Backup restored successfully",
        restored: { categories: 5 },
      };
      mockBackupService.restoreData.mockResolvedValue(mockResult);

      const req = {
        user: { id: userId },
        body: Buffer.from("gzip-data"),
        headers: {
          "x-restore-password": "mypassword",
        },
      };

      const result = await controller.restoreBackup(req);

      expect(mockBackupService.restoreData).toHaveBeenCalledWith(userId, {
        compressedData: req.body,
        password: "mypassword",
        oidcIdToken: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it("should pass OIDC token header to service", async () => {
      mockBackupService.restoreData.mockResolvedValue({
        message: "ok",
        restored: {},
      });

      const req = {
        user: { id: userId },
        body: Buffer.from("gzip-data"),
        headers: {
          "x-restore-oidc-token": "oidc-token-value",
        },
      };

      await controller.restoreBackup(req);

      expect(mockBackupService.restoreData).toHaveBeenCalledWith(userId, {
        compressedData: req.body,
        password: undefined,
        oidcIdToken: "oidc-token-value",
      });
    });

    it("should throw BadRequestException if body is not a buffer", async () => {
      const req = {
        user: { id: userId },
        body: "not-a-buffer",
        headers: {},
      };

      await expect(controller.restoreBackup(req)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException if body is empty buffer", async () => {
      const req = {
        user: { id: userId },
        body: Buffer.alloc(0),
        headers: {},
      };

      await expect(controller.restoreBackup(req)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("getAutoBackupSettings", () => {
    it("should delegate to autoBackupService.getSettings", async () => {
      const settings = new AutoBackupSettings();
      settings.userId = userId;
      settings.enabled = false;
      mockAutoBackupService.getSettings.mockResolvedValue(settings);

      const result = await controller.getAutoBackupSettings({
        user: { id: userId },
      });

      expect(mockAutoBackupService.getSettings).toHaveBeenCalledWith(userId);
      expect(result).toBe(settings);
    });
  });

  describe("updateAutoBackupSettings", () => {
    it("should delegate to autoBackupService.updateSettings", async () => {
      const dto = { folderPath: "/backups", frequency: "daily" as const };
      const settings = new AutoBackupSettings();
      settings.userId = userId;
      settings.folderPath = "/backups";
      mockAutoBackupService.updateSettings.mockResolvedValue(settings);

      const result = await controller.updateAutoBackupSettings(
        { user: { id: userId } },
        dto,
      );

      expect(mockAutoBackupService.updateSettings).toHaveBeenCalledWith(
        userId,
        dto,
      );
      expect(result).toBe(settings);
    });
  });

  describe("validateFolder", () => {
    it("should delegate to autoBackupService.validateFolder", async () => {
      mockAutoBackupService.validateFolder.mockResolvedValue({ valid: true });

      const result = await controller.validateFolder({
        folderPath: "/backups",
      });

      expect(mockAutoBackupService.validateFolder).toHaveBeenCalledWith(
        "/backups",
      );
      expect(result).toEqual({ valid: true });
    });

    it("should return validation error for invalid folder", async () => {
      mockAutoBackupService.validateFolder.mockResolvedValue({
        valid: false,
        error: "Folder does not exist",
      });

      const result = await controller.validateFolder({
        folderPath: "/nonexistent",
      });

      expect(result).toEqual({ valid: false, error: "Folder does not exist" });
    });
  });

  describe("browseFolders", () => {
    it("should delegate to autoBackupService.browseFolders", async () => {
      const expected = {
        current: "/backups",
        directories: ["daily", "weekly"],
      };
      mockAutoBackupService.browseFolders.mockResolvedValue(expected);

      const result = await controller.browseFolders({
        folderPath: "/backups",
      });

      expect(mockAutoBackupService.browseFolders).toHaveBeenCalledWith(
        "/backups",
      );
      expect(result).toEqual(expected);
    });
  });

  describe("runAutoBackup", () => {
    it("should delegate to autoBackupService.runManualBackup", async () => {
      const expected = {
        message: "Backup completed successfully",
        filename: "monize-backup-2026-04-02T10-00-00.json.gz",
      };
      mockAutoBackupService.runManualBackup.mockResolvedValue(expected);

      const result = await controller.runAutoBackup({
        user: { id: userId },
      });

      expect(mockAutoBackupService.runManualBackup).toHaveBeenCalledWith(
        userId,
      );
      expect(result).toEqual(expected);
    });
  });
});
