import { Test, TestingModule } from "@nestjs/testing";
import { NetWorthController } from "./net-worth.controller";
import { NetWorthService } from "./net-worth.service";

describe("NetWorthController", () => {
  let controller: NetWorthController;
  let mockNetWorthService: Partial<Record<keyof NetWorthService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockNetWorthService = {
      getMonthlyNetWorth: jest.fn(),
      getMonthlyInvestments: jest.fn(),
      recalculateAllAccounts: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NetWorthController],
      providers: [
        {
          provide: NetWorthService,
          useValue: mockNetWorthService,
        },
      ],
    }).compile();

    controller = module.get<NetWorthController>(NetWorthController);
  });

  describe("getMonthlyNetWorth()", () => {
    it("delegates to netWorthService.getMonthlyNetWorth with userId and date range", () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");

      const result = controller.getMonthlyNetWorth(
        mockReq,
        "2024-01-01",
        "2024-12-31",
      );

      expect(result).toBe("netWorth");
      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });

    it("passes undefined when no dates provided", () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");

      controller.getMonthlyNetWorth(mockReq, undefined, undefined);

      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
      );
    });
  });

  describe("getMonthlyInvestments()", () => {
    it("delegates to netWorthService.getMonthlyInvestments with userId, dates, and parsed accountIds", () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("investments");

      const result = controller.getMonthlyInvestments(
        mockReq,
        "2024-01-01",
        "2024-12-31",
        "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d,b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        undefined,
      );

      expect(result).toBe("investments");
      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        [
          "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
          "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        ],
        undefined,
      );
    });

    it("passes undefined accountIds when not provided", () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("investments");

      controller.getMonthlyInvestments(
        mockReq,
        "2024-01-01",
        "2024-12-31",
        undefined,
        undefined,
      );

      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        undefined,
        undefined,
      );
    });
  });

  describe("recalculate()", () => {
    it("delegates to netWorthService.recalculateAllAccounts and returns success", async () => {
      mockNetWorthService.recalculateAllAccounts!.mockResolvedValue(undefined);

      const result = await controller.recalculate(mockReq);

      expect(result).toEqual({ success: true });
      expect(mockNetWorthService.recalculateAllAccounts).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });
});
