import { Test, TestingModule } from "@nestjs/testing";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

describe("ReportsController", () => {
  let controller: ReportsController;
  let mockReportsService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockReportsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      execute: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        {
          provide: ReportsService,
          useValue: mockReportsService,
        },
      ],
    }).compile();

    controller = module.get<ReportsController>(ReportsController);
  });

  describe("create()", () => {
    it("delegates to reportsService.create with userId and dto", async () => {
      const dto = { name: "Monthly Report", type: "bar" };
      const expected = { id: "report-1", name: "Monthly Report" };
      mockReportsService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockReportsService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to reportsService.findAll with userId", async () => {
      const expected = [{ id: "report-1", name: "Monthly Report" }];
      mockReportsService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockReportsService.findAll).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findOne()", () => {
    it("delegates to reportsService.findOne with userId and id", async () => {
      const expected = { id: "report-1", name: "Monthly Report" };
      mockReportsService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "report-1");

      expect(result).toEqual(expected);
      expect(mockReportsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "report-1",
      );
    });
  });

  describe("update()", () => {
    it("delegates to reportsService.update with userId, id, and dto", async () => {
      const dto = { name: "Updated Report" };
      const expected = { id: "report-1", name: "Updated Report" };
      mockReportsService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "report-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockReportsService.update).toHaveBeenCalledWith(
        "user-1",
        "report-1",
        dto,
      );
    });
  });

  describe("remove()", () => {
    it("delegates to reportsService.remove with userId and id", async () => {
      mockReportsService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "report-1");

      expect(result).toBeUndefined();
      expect(mockReportsService.remove).toHaveBeenCalledWith(
        "user-1",
        "report-1",
      );
    });
  });

  describe("execute()", () => {
    it("delegates to reportsService.execute with userId, id, and dto", async () => {
      const dto = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { data: [], totals: {} };
      mockReportsService.execute.mockResolvedValue(expected);

      const result = await controller.execute(mockReq, "report-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockReportsService.execute).toHaveBeenCalledWith(
        "user-1",
        "report-1",
        dto,
      );
    });
  });
});
