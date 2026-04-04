import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import { AutoBackupService } from "./auto-backup.service";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    createWriteStream: jest.fn(),
    readdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    copyFileSync: jest.fn(),
    promises: {
      stat: jest.fn(),
      writeFile: jest.fn(),
      unlink: jest.fn(),
      readdir: jest.fn(),
    },
  };
});

const fsMock = fs as jest.Mocked<typeof fs>;
const fsPromises = fs.promises as jest.Mocked<typeof fs.promises>;

jest.mock("stream/promises", () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

describe("AutoBackupService", () => {
  let service: AutoBackupService;
  let mockSettingsRepo: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;

  const userId = "test-user-id";

  function createSettings(
    overrides: Partial<AutoBackupSettings> = {},
  ): AutoBackupSettings {
    const s = new AutoBackupSettings();
    s.userId = userId;
    s.enabled = false;
    s.folderPath = "";
    s.frequency = "daily";
    s.backupTime = "02:00";
    s.timezone = "UTC";
    s.retentionDaily = 7;
    s.retentionWeekly = 4;
    s.retentionMonthly = 6;
    s.lastBackupAt = null;
    s.lastBackupStatus = null;
    s.lastBackupError = null;
    s.nextBackupAt = null;
    Object.assign(s, overrides);
    return s;
  }

  function setupFsWritableMocks() {
    (fsPromises.stat as unknown as jest.Mock).mockResolvedValue({
      isDirectory: () => true,
    });
    (fsPromises.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.unlink as unknown as jest.Mock).mockResolvedValue(undefined);
  }

  function setupExportMocks() {
    setupFsWritableMocks();
    (fsMock.createWriteStream as unknown as jest.Mock).mockReturnValue({
      on: jest.fn(),
    });
    (fsMock.readdirSync as unknown as jest.Mock).mockReturnValue([]);
  }

  beforeEach(async () => {
    mockSettingsRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data) => {
        const s = new AutoBackupSettings();
        Object.assign(s, data);
        return s;
      }),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoBackupService,
        {
          provide: getRepositoryToken(AutoBackupSettings),
          useValue: mockSettingsRepo,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<AutoBackupService>(AutoBackupService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("getSettings", () => {
    it("should return existing settings when found", async () => {
      const existing = createSettings({
        enabled: true,
        folderPath: "/backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      const result = await service.getSettings(userId);

      expect(result).toBe(existing);
      expect(mockSettingsRepo.findOne).toHaveBeenCalledWith({
        where: { userId },
      });
    });

    it("should return defaults when no settings exist", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.userId).toBe(userId);
      expect(result.enabled).toBe(false);
      expect(result.folderPath).toBe("");
      expect(result.frequency).toBe("daily");
      expect(result.backupTime).toBe("02:00");
      expect(result.retentionDaily).toBe(7);
      expect(result.retentionWeekly).toBe(4);
      expect(result.retentionMonthly).toBe(6);
    });
  });

  describe("updateSettings", () => {
    it("should create new settings if none exist", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await service.updateSettings(userId, {
        folderPath: "/backups",
        frequency: "weekly",
      });

      expect(mockSettingsRepo.create).toHaveBeenCalledWith({ userId });
      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: "/backups",
          frequency: "weekly",
        }),
      );
    });

    it("should update existing settings", async () => {
      const existing = createSettings({ folderPath: "/old" });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        folderPath: "/new-backups",
        retentionDaily: 14,
      });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: "/new-backups",
          retentionDaily: 14,
        }),
      );
    });

    it("should throw if enabling without a folder path", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(userId, { enabled: true }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should validate folder is writable when enabling", async () => {
      const existing = createSettings({ folderPath: "/backups" });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, { enabled: true });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          nextBackupAt: expect.any(Date),
        }),
      );
    });

    it("should clear nextBackupAt when disabling", async () => {
      const existing = createSettings({
        enabled: true,
        folderPath: "/backups",
        nextBackupAt: new Date(),
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, { enabled: false });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          nextBackupAt: null,
        }),
      );
    });

    it("should reject non-absolute paths", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(userId, { folderPath: "relative/path" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject paths with '..'", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(userId, { folderPath: "/backups/../etc" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should update retention values", async () => {
      const existing = createSettings();
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        retentionDaily: 30,
        retentionWeekly: 12,
        retentionMonthly: 24,
      });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          retentionDaily: 30,
          retentionWeekly: 12,
          retentionMonthly: 24,
        }),
      );
    });

    it("should update backupTime", async () => {
      const existing = createSettings();
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, { backupTime: "14:30" });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ backupTime: "14:30" }),
      );
    });
  });

  describe("validateFolder", () => {
    it("should return valid for a writable directory", async () => {
      setupFsWritableMocks();

      const result = await service.validateFolder("/backups");

      expect(result).toEqual({ valid: true });
    });

    it("should return invalid for non-existent directory", async () => {
      (fsPromises.stat as unknown as jest.Mock).mockRejectedValue({
        code: "ENOENT",
      });

      const result = await service.validateFolder("/no-such-dir");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return invalid for non-directory path", async () => {
      (fsPromises.stat as unknown as jest.Mock).mockResolvedValue({
        isDirectory: () => false,
      });

      const result = await service.validateFolder("/some/file.txt");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("not a directory");
    });

    it("should return invalid for non-writable directory", async () => {
      (fsPromises.stat as unknown as jest.Mock).mockResolvedValue({
        isDirectory: () => true,
      });
      (fsPromises.writeFile as unknown as jest.Mock).mockRejectedValue(
        new Error("EACCES"),
      );

      const result = await service.validateFolder("/read-only");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("not writable");
    });

    it("should return invalid for relative paths", async () => {
      const result = await service.validateFolder("relative/path");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("absolute path");
    });

    it("should return invalid for paths with '..'", async () => {
      const result = await service.validateFolder("/backups/../etc");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("..");
    });
  });

  describe("browseFolders", () => {
    it("should list subdirectories", async () => {
      (fsPromises.stat as unknown as jest.Mock).mockResolvedValue({
        isDirectory: () => true,
      });
      (fsPromises.readdir as unknown as jest.Mock).mockResolvedValue([
        { name: "backups", isDirectory: () => true },
        { name: "data", isDirectory: () => true },
        { name: ".hidden", isDirectory: () => true },
        { name: "file.txt", isDirectory: () => false },
      ]);

      const result = await service.browseFolders("/");

      expect(result.current).toBe("/");
      expect(result.directories).toEqual(["backups", "data"]);
    });

    it("should throw for non-existent path", async () => {
      (fsPromises.stat as unknown as jest.Mock).mockRejectedValue({
        code: "ENOENT",
      });

      await expect(service.browseFolders("/no-such")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw for relative paths", async () => {
      await expect(service.browseFolders("relative")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("runManualBackup", () => {
    it("should throw if no settings configured", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(service.runManualBackup(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw if no folder path set", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: "" }),
      );

      await expect(service.runManualBackup(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should run backup and update status on success", async () => {
      const existing = createSettings({
        enabled: true,
        folderPath: "/backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupExportMocks();

      const result = await service.runManualBackup(userId);

      expect(result.message).toBe("Backup completed successfully");
      expect(result.filename).toMatch(/^monize-backup-daily-\d{4}-\d{2}-\d{2}\.json\.gz$/);
      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "success",
          lastBackupError: null,
        }),
      );
    });
  });

  describe("handleAutoBackupCron", () => {
    it("should do nothing if no backups are due", async () => {
      mockSettingsRepo.find.mockResolvedValue([]);

      await service.handleAutoBackupCron();

      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it("should process due backups and update status", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        nextBackupAt: new Date(Date.now() - 3600000),
      });
      mockSettingsRepo.find.mockResolvedValue([settings]);
      setupExportMocks();

      await service.handleAutoBackupCron();

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "success",
          nextBackupAt: expect.any(Date),
        }),
      );
    });

    it("should mark status as failed on error and continue", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        nextBackupAt: new Date(Date.now() - 3600000),
      });
      mockSettingsRepo.find.mockResolvedValue([settings]);

      (fsPromises.stat as unknown as jest.Mock).mockRejectedValue({
        code: "ENOENT",
      });

      await service.handleAutoBackupCron();

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "failed",
          lastBackupError: expect.any(String),
          nextBackupAt: expect.any(Date),
        }),
      );
    });
  });

  describe("retention policy", () => {
    it("should keep the most recent N daily backups", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        retentionDaily: 2,
        retentionWeekly: 0,
        retentionMonthly: 0,
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);

      const files = [
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
        "monize-backup-daily-2026-04-03.json.gz",
      ];
      setupExportMocks();
      (fsMock.readdirSync as unknown as jest.Mock).mockReturnValue(files);

      await service.runManualBackup(userId);

      // Should delete the oldest file (April 1), keep April 2 and 3
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(
        "/backups/monize-backup-daily-2026-04-01.json.gz",
      );
    });

    it("should keep the most recent N weekly backups independently", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        retentionDaily: 7,
        retentionWeekly: 2,
        retentionMonthly: 0,
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);

      const files = [
        "monize-backup-weekly-2026-03-07.json.gz",
        "monize-backup-weekly-2026-03-14.json.gz",
        "monize-backup-weekly-2026-03-21.json.gz",
      ];
      setupExportMocks();
      (fsMock.readdirSync as unknown as jest.Mock).mockReturnValue(files);

      await service.runManualBackup(userId);

      // Should delete the oldest weekly (March 7), keep March 14 and 21
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(
        "/backups/monize-backup-weekly-2026-03-07.json.gz",
      );
    });

    it("should keep the most recent N monthly backups independently", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        retentionDaily: 7,
        retentionWeekly: 4,
        retentionMonthly: 1,
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);

      const files = [
        "monize-backup-monthly-26-01.json.gz",
        "monize-backup-monthly-26-02.json.gz",
      ];
      setupExportMocks();
      (fsMock.readdirSync as unknown as jest.Mock).mockReturnValue(files);

      await service.runManualBackup(userId);

      // Should delete the oldest monthly (Jan), keep Feb
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(
        "/backups/monize-backup-monthly-26-01.json.gz",
      );
    });

    it("should copy daily to weekly on days 7, 14, 21, 28", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);
      setupExportMocks();

      // Mock the date to be the 14th
      const mockDate = new Date("2026-04-14T10:00:00Z");
      jest.spyOn(global, "Date").mockImplementation((...args: unknown[]) => {
        if (args.length === 0) return mockDate;
        // @ts-expect-error -- spreading constructor args
        return new (jest.requireActual("global").Date)(...args);
      });
      // Restore Intl.DateTimeFormat since Date mock can interfere
      const origFormat = Intl.DateTimeFormat;
      jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
        (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
          new origFormat(...args),
      );

      await service.runManualBackup(userId);

      expect(fsMock.copyFileSync).toHaveBeenCalledWith(
        "/backups/monize-backup-daily-2026-04-14.json.gz",
        "/backups/monize-backup-weekly-2026-04-14.json.gz",
      );

      jest.restoreAllMocks();
    });

    it("should copy daily to monthly on day 1", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);
      setupExportMocks();

      // Mock the date to be the 1st
      const mockDate = new Date("2026-04-01T10:00:00Z");
      jest.spyOn(global, "Date").mockImplementation((...args: unknown[]) => {
        if (args.length === 0) return mockDate;
        // @ts-expect-error -- spreading constructor args
        return new (jest.requireActual("global").Date)(...args);
      });
      const origFormat = Intl.DateTimeFormat;
      jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
        (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
          new origFormat(...args),
      );

      await service.runManualBackup(userId);

      expect(fsMock.copyFileSync).toHaveBeenCalledWith(
        "/backups/monize-backup-daily-2026-04-01.json.gz",
        "/backups/monize-backup-monthly-26-04.json.gz",
      );

      jest.restoreAllMocks();
    });

    it("should not delete non-backup files", async () => {
      const settings = createSettings({
        enabled: true,
        folderPath: "/backups",
        retentionDaily: 1,
        retentionWeekly: 0,
        retentionMonthly: 0,
      });
      mockSettingsRepo.findOne.mockResolvedValue(settings);

      const files = [
        "monize-backup-daily-2026-04-01.json.gz",
        "some-other-file.txt",
        "readme.md",
      ];
      setupExportMocks();
      (fsMock.readdirSync as unknown as jest.Mock).mockReturnValue(files);

      await service.runManualBackup(userId);

      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe("frequency calculation with backup time", () => {
    it("should schedule daily backup at configured time", async () => {
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "03:30",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(3);
      // Minutes are snapped to 0 since the cron fires at minute 0 each hour
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should schedule next slot for sub-daily frequency", async () => {
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "00:00",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "every6hours",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // Should be at minute 0 (aligned to configured time)
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should schedule weekly backup at configured time", async () => {
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "23:00",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "weekly",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(23);
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should convert local timezone backup time to UTC", async () => {
      // America/New_York is UTC-5 (EST) or UTC-4 (EDT)
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "02:00",
        timezone: "America/New_York",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 02:00 EST = 07:00 UTC, or 02:00 EDT = 06:00 UTC
      expect([6, 7]).toContain(nextAt.getUTCHours());
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should handle UTC timezone without offset", async () => {
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "14:30",
        timezone: "UTC",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(14);
      // Minutes are snapped to 0 since the cron fires at minute 0 each hour
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should handle positive UTC offset timezone", async () => {
      // Europe/Berlin is UTC+1 (CET) or UTC+2 (CEST)
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "03:00",
        timezone: "Europe/Berlin",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 03:00 CET = 02:00 UTC, or 03:00 CEST = 01:00 UTC
      expect([1, 2]).toContain(nextAt.getUTCHours());
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should store timezone when updating settings", async () => {
      const existing = createSettings({ folderPath: "/backups" });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        timezone: "Asia/Tokyo",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      expect(savedCall.timezone).toBe("Asia/Tokyo");
    });

    it("should use timezone for sub-daily frequency scheduling", async () => {
      // America/Chicago is UTC-6 (CST) or UTC-5 (CDT)
      const existing = createSettings({
        folderPath: "/backups",
        backupTime: "06:00",
        timezone: "America/Chicago",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);
      setupFsWritableMocks();

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "every12hours",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 06:00 CST = 12:00 UTC, or 06:00 CDT = 11:00 UTC
      // Slots are at 06:00 and 18:00 local, so UTC equivalents vary
      expect(nextAt.getUTCMinutes()).toBe(0);
    });
  });
});
