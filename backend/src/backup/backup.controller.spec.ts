import { Test, TestingModule } from "@nestjs/testing";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";

describe("BackupController", () => {
  let controller: BackupController;
  let mockBackupService: Record<string, jest.Mock>;

  const userId = "test-user-id";
  const mockReq = { user: { id: userId } };

  beforeEach(async () => {
    mockBackupService = {
      exportData: jest.fn(),
      restoreData: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
      ],
    }).compile();

    controller = module.get<BackupController>(BackupController);
  });

  describe("exportBackup", () => {
    it("should export backup and set response headers", async () => {
      const mockBackup = { version: 1, exportedAt: "2026-01-01", categories: [] };
      mockBackupService.exportData.mockResolvedValue(mockBackup);

      const mockRes = {
        setHeader: jest.fn(),
        send: jest.fn(),
      };

      await controller.exportBackup(mockReq, mockRes as any);

      expect(mockBackupService.exportData).toHaveBeenCalledWith(userId);
      expect(mockRes.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        expect.stringContaining("monize-backup-"),
      );
      expect(mockRes.send).toHaveBeenCalled();
    });
  });

  describe("restoreBackup", () => {
    it("should call restoreData and return result", async () => {
      const mockResult = { message: "Backup restored successfully", restored: { categories: 5 } };
      mockBackupService.restoreData.mockResolvedValue(mockResult);

      const dto = { password: "test", data: { version: 1 } };
      const result = await controller.restoreBackup(mockReq, dto as any);

      expect(mockBackupService.restoreData).toHaveBeenCalledWith(userId, dto);
      expect(result).toEqual(mockResult);
    });
  });
});
