import { Test, TestingModule } from "@nestjs/testing";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

describe("ImportController", () => {
  let controller: ImportController;
  let mockImportService: Partial<Record<keyof ImportService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockImportService = {
      parseQifFile: jest.fn(),
      importQifFile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImportController],
      providers: [
        {
          provide: ImportService,
          useValue: mockImportService,
        },
      ],
    }).compile();

    controller = module.get<ImportController>(ImportController);
  });

  describe("parseQif()", () => {
    it("delegates to importService.parseQifFile with userId and content", async () => {
      const dto = { content: "!Type:Bank\nD01/15/2024\nT-100.00\n^" } as any;
      mockImportService.parseQifFile!.mockResolvedValue("parsed");

      const result = await controller.parseQif(mockReq, dto);

      expect(result).toBe("parsed");
      expect(mockImportService.parseQifFile).toHaveBeenCalledWith(
        "user-1",
        dto.content,
      );
    });
  });

  describe("importQif()", () => {
    it("delegates to importService.importQifFile with userId and dto", async () => {
      const dto = {
        content: "!Type:Bank\nD01/15/2024\nT-100.00\n^",
        accountId: "account-1",
      } as any;
      mockImportService.importQifFile!.mockResolvedValue("imported");

      const result = await controller.importQif(mockReq, dto);

      expect(result).toBe("imported");
      expect(mockImportService.importQifFile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });
});
