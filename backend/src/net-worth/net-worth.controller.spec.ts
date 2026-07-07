import { Test, TestingModule } from "@nestjs/testing";
import { NetWorthController } from "./net-worth.controller";
import { NetWorthService } from "./net-worth.service";
import { DelegationService } from "../delegation/delegation.service";

describe("NetWorthController", () => {
  let controller: NetWorthController;
  let mockNetWorthService: Partial<Record<keyof NetWorthService, jest.Mock>>;
  let delegationService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };
  const UUID_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const UUID_B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
  const NO_READABLE = "00000000-0000-0000-0000-000000000000";

  beforeEach(async () => {
    mockNetWorthService = {
      getMonthlyNetWorth: jest.fn(),
      getMonthlyInvestments: jest.fn(),
      getDailyInvestments: jest.fn(),
      getInvestmentBreakdown: jest.fn(),
      recalculateAllAccounts: jest.fn(),
    };
    delegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NetWorthController],
      providers: [
        {
          provide: NetWorthService,
          useValue: mockNetWorthService,
        },
        { provide: DelegationService, useValue: delegationService },
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
    it("delegates to netWorthService.getMonthlyInvestments with userId, dates, and parsed accountIds", async () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("investments");

      const result = await controller.getMonthlyInvestments(
        mockReq,
        "2024-01-01",
        "2024-12-31",
        `${UUID_A},${UUID_B}`,
        undefined,
      );

      expect(result).toBe("investments");
      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        [UUID_A, UUID_B],
        undefined,
      );
    });

    it("passes undefined accountIds when not provided", async () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("investments");

      await controller.getMonthlyInvestments(
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

    it("scopes accountIds to readable accounts for an acting delegate", async () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([UUID_A]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getMonthlyInvestments(
        actReq,
        undefined,
        undefined,
        `${UUID_A},${UUID_B}`,
        undefined,
      );

      expect(delegationService.readableAccountIds).toHaveBeenCalledWith("d-1");
      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "owner-1",
        undefined,
        undefined,
        [UUID_A],
        undefined,
      );
    });

    it("returns an empty result for a delegate with no readable accounts", async () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getMonthlyInvestments(actReq);

      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "owner-1",
        undefined,
        undefined,
        [NO_READABLE],
        undefined,
      );
    });
  });

  describe("getDailyInvestments()", () => {
    it("delegates to netWorthService.getDailyInvestments with userId, dates, and parsed accountIds", async () => {
      mockNetWorthService.getDailyInvestments!.mockReturnValue("daily");

      const result = await controller.getDailyInvestments(
        mockReq,
        "2025-02-01",
        "2025-03-04",
        UUID_A,
        "USD",
      );

      expect(result).toBe("daily");
      expect(mockNetWorthService.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2025-02-01",
        "2025-03-04",
        [UUID_A],
        "USD",
      );
    });

    it("passes undefined accountIds when not provided", async () => {
      mockNetWorthService.getDailyInvestments!.mockReturnValue("daily");

      await controller.getDailyInvestments(
        mockReq,
        "2025-02-01",
        "2025-03-04",
        undefined,
        undefined,
      );

      expect(mockNetWorthService.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2025-02-01",
        "2025-03-04",
        undefined,
        undefined,
      );
    });

    it("scopes accountIds to readable accounts for an acting delegate", async () => {
      mockNetWorthService.getDailyInvestments!.mockReturnValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([UUID_A]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getDailyInvestments(
        actReq,
        undefined,
        undefined,
        `${UUID_A},${UUID_B}`,
        undefined,
      );

      expect(mockNetWorthService.getDailyInvestments).toHaveBeenCalledWith(
        "owner-1",
        undefined,
        undefined,
        [UUID_A],
        undefined,
      );
    });

    it("throws BadRequestException for invalid startDate format", async () => {
      await expect(
        controller.getDailyInvestments(
          mockReq,
          "invalid",
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow("startDate must be YYYY-MM-DD");
    });

    it("throws BadRequestException for invalid accountIds", async () => {
      await expect(
        controller.getDailyInvestments(
          mockReq,
          "2025-01-01",
          "2025-03-04",
          "not-a-uuid",
          undefined,
        ),
      ).rejects.toThrow("accountIds must be comma-separated UUIDs");
    });
  });

  describe("getInvestmentBreakdown()", () => {
    it("delegates to the service with parsed granularity, dates and accountIds", async () => {
      mockNetWorthService.getInvestmentBreakdown!.mockResolvedValue("bd");

      const result = await controller.getInvestmentBreakdown(
        mockReq,
        "monthly",
        "2024-01-01",
        "2024-12-31",
        UUID_A,
        "usd",
      );

      expect(result).toBe("bd");
      expect(mockNetWorthService.getInvestmentBreakdown).toHaveBeenCalledWith(
        "user-1",
        {
          granularity: "monthly",
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          accountIds: [UUID_A],
          displayCurrency: "USD",
        },
      );
    });

    it("throws on an unknown granularity", async () => {
      await expect(
        controller.getInvestmentBreakdown(mockReq, "hourly"),
      ).rejects.toThrow(/granularity/);
    });

    it("throws when granularity is omitted", async () => {
      await expect(
        controller.getInvestmentBreakdown(mockReq, undefined),
      ).rejects.toThrow(/granularity/);
    });

    it("throws on an invalid startDate", async () => {
      await expect(
        controller.getInvestmentBreakdown(mockReq, "daily", "nope"),
      ).rejects.toThrow(/startDate/);
    });

    it("rejects malformed accountIds", async () => {
      await expect(
        controller.getInvestmentBreakdown(
          mockReq,
          "daily",
          undefined,
          undefined,
          "not-a-uuid",
        ),
      ).rejects.toThrow(/accountIds/);
    });

    it("scopes accountIds to readable accounts for an acting delegate", async () => {
      mockNetWorthService.getInvestmentBreakdown!.mockResolvedValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([UUID_A]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getInvestmentBreakdown(
        actReq,
        "monthly",
        undefined,
        undefined,
        `${UUID_A},${UUID_B}`,
      );

      expect(mockNetWorthService.getInvestmentBreakdown).toHaveBeenCalledWith(
        "owner-1",
        expect.objectContaining({ accountIds: [UUID_A] }),
      );
    });

    it("returns the no-readable-account sentinel for a delegate with no access", async () => {
      mockNetWorthService.getInvestmentBreakdown!.mockResolvedValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getInvestmentBreakdown(actReq, "daily");

      expect(mockNetWorthService.getInvestmentBreakdown).toHaveBeenCalledWith(
        "owner-1",
        expect.objectContaining({ accountIds: [NO_READABLE] }),
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

  // ─── Branch coverage extras ───────────────────────────────────────────

  describe("getMonthlyNetWorth date validation", () => {
    it("throws on invalid startDate format", () => {
      expect(() =>
        controller.getMonthlyNetWorth(mockReq, "not-a-date"),
      ).toThrow(/startDate/);
    });
    it("throws on invalid endDate format", () => {
      expect(() =>
        controller.getMonthlyNetWorth(mockReq, "2024-01-01", "bad"),
      ).toThrow(/endDate/);
    });
  });

  describe("getMonthlyInvestments edge cases", () => {
    it("uppercases and slices currency to 3 chars", async () => {
      mockNetWorthService.getMonthlyInvestments!.mockReturnValue("ok");
      await controller.getMonthlyInvestments(
        mockReq,
        undefined,
        undefined,
        undefined,
        "usdextra",
      );
      expect(mockNetWorthService.getMonthlyInvestments).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        "USD",
      );
    });

    it("throws on invalid endDate", async () => {
      await expect(
        controller.getMonthlyInvestments(mockReq, undefined, "bad-date"),
      ).rejects.toThrow(/endDate/);
    });

    it("throws on invalid startDate", async () => {
      await expect(
        controller.getMonthlyInvestments(mockReq, "x"),
      ).rejects.toThrow(/startDate/);
    });

    it("throws when accountIds contains a non-UUID", async () => {
      await expect(
        controller.getMonthlyInvestments(
          mockReq,
          undefined,
          undefined,
          "not-a-uuid",
        ),
      ).rejects.toThrow(/UUID/);
    });
  });

  describe("getDailyInvestments edge cases", () => {
    it("uppercases and slices currency to 3 chars", async () => {
      mockNetWorthService.getDailyInvestments!.mockReturnValue("ok");
      await controller.getDailyInvestments(
        mockReq,
        undefined,
        undefined,
        undefined,
        "eurmixed",
      );
      expect(mockNetWorthService.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        "EUR",
      );
    });

    it("throws on invalid endDate", async () => {
      await expect(
        controller.getDailyInvestments(mockReq, undefined, "bad-date"),
      ).rejects.toThrow(/endDate/);
    });
  });
});
