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
      parseOfxFile: jest.fn(),
      importOfxFile: jest.fn(),
      parseCsvHeaders: jest.fn(),
      parseCsvFile: jest.fn(),
      importCsvFile: jest.fn(),
      getColumnMappings: jest.fn(),
      createColumnMapping: jest.fn(),
      updateColumnMapping: jest.fn(),
      deleteColumnMapping: jest.fn(),
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

  describe("parseOfx()", () => {
    it("delegates to importService.parseOfxFile with userId and content", async () => {
      const dto = { content: "<OFX>...</OFX>" } as any;
      mockImportService.parseOfxFile!.mockResolvedValue("parsed-ofx");

      const result = await controller.parseOfx(mockReq, dto);

      expect(result).toBe("parsed-ofx");
      expect(mockImportService.parseOfxFile).toHaveBeenCalledWith(
        "user-1",
        dto.content,
      );
    });
  });

  describe("importOfx()", () => {
    it("delegates to importService.importOfxFile with userId and dto", async () => {
      const dto = {
        content: "<OFX>...</OFX>",
        accountId: "account-1",
      } as any;
      mockImportService.importOfxFile!.mockResolvedValue("imported-ofx");

      const result = await controller.importOfx(mockReq, dto);

      expect(result).toBe("imported-ofx");
      expect(mockImportService.importOfxFile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("parseCsvHeaders()", () => {
    it("delegates to importService.parseCsvHeaders with userId, content, and delimiter", async () => {
      const dto = {
        content: "Date,Amount,Description\n2024-01-15,-100,Grocery",
        delimiter: ",",
      } as any;
      mockImportService.parseCsvHeaders!.mockResolvedValue("csv-headers");

      const result = await controller.parseCsvHeaders(mockReq, dto);

      expect(result).toBe("csv-headers");
      expect(mockImportService.parseCsvHeaders).toHaveBeenCalledWith(
        "user-1",
        dto.content,
        dto.delimiter,
      );
    });

    it("passes undefined delimiter when not provided", async () => {
      const dto = {
        content: "Date,Amount,Description\n2024-01-15,-100,Grocery",
      } as any;
      mockImportService.parseCsvHeaders!.mockResolvedValue("csv-headers");

      await controller.parseCsvHeaders(mockReq, dto);

      expect(mockImportService.parseCsvHeaders).toHaveBeenCalledWith(
        "user-1",
        dto.content,
        undefined,
      );
    });
  });

  describe("parseCsv()", () => {
    it("delegates to importService.parseCsvFile with userId, content, columnMapping, and transferRules", async () => {
      const dto = {
        content: "Date,Amount,Description\n2024-01-15,-100,Grocery",
        columnMapping: { date: 0, amount: 1, payee: 2 },
        transferRules: [{ pattern: "Transfer", accountId: "acc-2" }],
      } as any;
      mockImportService.parseCsvFile!.mockResolvedValue("parsed-csv");

      const result = await controller.parseCsv(mockReq, dto);

      expect(result).toBe("parsed-csv");
      expect(mockImportService.parseCsvFile).toHaveBeenCalledWith(
        "user-1",
        dto.content,
        dto.columnMapping,
        dto.transferRules,
      );
    });
  });

  describe("importCsv()", () => {
    it("delegates to importService.importCsvFile with userId and dto", async () => {
      const dto = {
        content: "Date,Amount,Description\n2024-01-15,-100,Grocery",
        accountId: "account-1",
        columnMapping: { date: 0, amount: 1, payee: 2 },
      } as any;
      mockImportService.importCsvFile!.mockResolvedValue("imported-csv");

      const result = await controller.importCsv(mockReq, dto);

      expect(result).toBe("imported-csv");
      expect(mockImportService.importCsvFile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("getColumnMappings()", () => {
    it("delegates to importService.getColumnMappings with userId", async () => {
      mockImportService.getColumnMappings!.mockResolvedValue([
        { id: "mapping-1", name: "My Bank" },
      ]);

      const result = await controller.getColumnMappings(mockReq);

      expect(result).toEqual([{ id: "mapping-1", name: "My Bank" }]);
      expect(mockImportService.getColumnMappings).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });

  describe("createColumnMapping()", () => {
    it("delegates to importService.createColumnMapping with userId and dto", async () => {
      const dto = {
        name: "My Bank",
        mapping: { date: 0, amount: 1, payee: 2 },
      } as any;
      mockImportService.createColumnMapping!.mockResolvedValue("created");

      const result = await controller.createColumnMapping(mockReq, dto);

      expect(result).toBe("created");
      expect(mockImportService.createColumnMapping).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("updateColumnMapping()", () => {
    it("delegates to importService.updateColumnMapping with userId, id, and dto", async () => {
      const dto = { name: "Updated Bank" } as any;
      mockImportService.updateColumnMapping!.mockResolvedValue("updated");

      const result = await controller.updateColumnMapping(
        mockReq,
        "mapping-1",
        dto,
      );

      expect(result).toBe("updated");
      expect(mockImportService.updateColumnMapping).toHaveBeenCalledWith(
        "user-1",
        "mapping-1",
        dto,
      );
    });
  });

  describe("deleteColumnMapping()", () => {
    it("delegates to importService.deleteColumnMapping with userId and id", async () => {
      mockImportService.deleteColumnMapping!.mockResolvedValue(undefined);

      await controller.deleteColumnMapping(mockReq, "mapping-1");

      expect(mockImportService.deleteColumnMapping).toHaveBeenCalledWith(
        "user-1",
        "mapping-1",
      );
    });
  });
});
