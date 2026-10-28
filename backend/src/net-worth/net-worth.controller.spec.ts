jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
jest.mock("../accruals/reporting-query", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingQueryMockModule(),
);
jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);

import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { NetWorthController } from "./net-worth.controller";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioPeriodResultsBatchService } from "./portfolio-period-results-batch.service";
import { DelegationService } from "../delegation/delegation.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";

describe("NetWorthController", () => {
  let controller: NetWorthController;
  let mockNetWorthService: Partial<Record<keyof NetWorthService, jest.Mock>>;
  let mockPeriodResult: Partial<
    Record<keyof PortfolioPeriodResultService, jest.Mock>
  >;
  let mockPeriodResults: Partial<
    Record<keyof PortfolioPeriodResultsBatchService, jest.Mock>
  >;
  let delegationService: Record<string, jest.Mock>;
  let jointAccounts: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };
  const UUID_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const UUID_B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
  const NO_READABLE = "00000000-0000-0000-0000-000000000000";

  beforeEach(async () => {
    mockNetWorthService = {
      getMonthlyNetWorth: jest.fn(),
      getMonthlyInvestments: jest.fn(),
      getDailyInvestments: jest.fn(),
      getSampledInvestments: jest.fn(),
      getInvestmentBreakdown: jest.fn(),
      recalculateAllAccounts: jest.fn(),
    };
    mockPeriodResult = { getPeriodResult: jest.fn() };
    mockPeriodResults = { getPeriodResults: jest.fn() };
    delegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([]),
    };
    jointAccounts = {
      jointGrantsFor: jest.fn().mockResolvedValue(new Map()),
      getNetWorthExclusions: jest.fn().mockResolvedValue(new Set()),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NetWorthController],
      providers: [
        {
          provide: NetWorthService,
          useValue: mockNetWorthService,
        },
        {
          provide: PortfolioPeriodResultService,
          useValue: mockPeriodResult,
        },
        {
          provide: PortfolioPeriodResultsBatchService,
          useValue: mockPeriodResults,
        },
        { provide: DelegationService, useValue: delegationService },
        { provide: JointAccountsService, useValue: jointAccounts },
      ],
    }).compile();

    controller = module.get<NetWorthController>(NetWorthController);
  });

  describe("getMonthlyNetWorth()", () => {
    it("delegates to netWorthService.getMonthlyNetWorth with userId and date range", async () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");

      const result = await controller.getMonthlyNetWorth(
        mockReq,
        "2024-01-01",
        "2024-12-31",
      );

      expect(result).toBe("netWorth");
      // No joint grants -> scope is undefined, keeping the call identical.
      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        undefined,
      );
    });

    it("passes undefined when no dates provided", async () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");

      await controller.getMonthlyNetWorth(mockReq, undefined, undefined);

      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
      );
    });

    it.each(["2026-02-30", "9999-99-99", ["2026-01-01", "2026-01-02"]])(
      "rejects a malformed or repeated monthly date before querying",
      async (value) => {
        await expect(
          controller.getMonthlyNetWorth(mockReq, value as string, undefined),
        ).rejects.toThrow(BadRequestException);
        await expect(
          controller.getMonthlyNetWorth(mockReq, undefined, value as string),
        ).rejects.toThrow(BadRequestException);
        expect(mockNetWorthService.getMonthlyNetWorth).not.toHaveBeenCalled();
      },
    );
    it("builds the joint scope from grants minus the caller's exclusions", async () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");
      const OWNER = "cccccccc-3333-4333-8333-333333333333";
      jointAccounts.jointGrantsFor.mockResolvedValue(
        new Map([
          [UUID_A, { ownerUserId: OWNER }],
          [UUID_B, { ownerUserId: OWNER }],
        ]),
      );
      jointAccounts.getNetWorthExclusions.mockResolvedValue(new Set([UUID_B]));

      await controller.getMonthlyNetWorth(mockReq, undefined, undefined);

      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        { accounts: [{ accountId: UUID_A, ownerUserId: OWNER }] },
      );
    });

    it("never builds a joint scope while acting", async () => {
      mockNetWorthService.getMonthlyNetWorth!.mockReturnValue("netWorth");
      await controller.getMonthlyNetWorth(
        { user: { id: "owner-1", realUserId: "deleg-1", isActing: true } },
        undefined,
        undefined,
      );
      expect(jointAccounts.jointGrantsFor).not.toHaveBeenCalled();
      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "owner-1",
        undefined,
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

  describe("getPeriodResult()", () => {
    it("lets the server resolve a named window, ignoring the dates beside it", async () => {
      // A chart names its range because the window it DRAWS is not the period
      // the range names. A preset plus a pair of dates is one question,
      // not two, so the dates are not passed on to be reconciled.
      mockPeriodResult.getPeriodResult!.mockReturnValue("period");

      const result = await controller.getPeriodResult(
        mockReq,
        "2026-01-02",
        undefined,
        "2026-01-01",
        undefined,
        "cad",
        "3m",
      );

      expect(result).toBe("period");
      expect(mockPeriodResult.getPeriodResult).toHaveBeenCalledWith("user-1", {
        period: "3m",
        endDate: undefined,
        accountIds: undefined,
        displayCurrency: "CAD",
      });
    });

    it("needs no startDate when the window is named", async () => {
      // `all` is the window no client arithmetic answers: it has no start date
      // to send, and requiring one left both its figures unreported.
      mockPeriodResult.getPeriodResult!.mockReturnValue("period");

      await controller.getPeriodResult(
        mockReq,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "all",
      );

      expect(mockPeriodResult.getPeriodResult).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ period: "all" }),
      );
    });

    it("still requires a startDate when no window is named", async () => {
      await expect(controller.getPeriodResult(mockReq)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPeriodResult.getPeriodResult).not.toHaveBeenCalled();
    });

    it("rejects a window name the presets have no arithmetic for", async () => {
      await expect(
        controller.getPeriodResult(
          mockReq,
          "2026-01-02",
          undefined,
          undefined,
          undefined,
          undefined,
          "6m",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPeriodResult.getPeriodResult).not.toHaveBeenCalled();
    });
  });

  describe("getPeriodResults()", () => {
    it("passes the presets and the scope through", async () => {
      mockPeriodResults.getPeriodResults!.mockReturnValue("results");

      const result = await controller.getPeriodResults(
        mockReq,
        "1d,1w,ytd",
        UUID_A,
        "usdx",
      );

      expect(result).toBe("results");
      expect(mockPeriodResults.getPeriodResults).toHaveBeenCalledWith(
        "user-1",
        {
          periods: ["1d", "1w", "ytd"],
          accountIds: [UUID_A],
          displayCurrency: "USD",
        },
      );
    });

    it("asks for every preset when none is named", async () => {
      mockPeriodResults.getPeriodResults!.mockReturnValue("results");

      await controller.getPeriodResults(mockReq);

      expect(mockPeriodResults.getPeriodResults).toHaveBeenCalledWith(
        "user-1",
        {
          periods: [],
          accountIds: undefined,
          displayCurrency: undefined,
        },
      );
    });

    it("rejects a period that is not a preset", async () => {
      // `6m` is a range the client's own date picker offers and this route
      // does not: a window the server has no arithmetic for is a 400, never a
      // silently dropped member of a list whose other windows still answer.
      await expect(
        controller.getPeriodResults(mockReq, "1d,6m"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPeriodResults.getPeriodResults).not.toHaveBeenCalled();
    });

    it("rejects an accountId that is not a UUID", async () => {
      await expect(
        controller.getPeriodResults(mockReq, "1m", "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("scopes the accounts to what an acting delegate may read", async () => {
      mockPeriodResults.getPeriodResults!.mockReturnValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([UUID_A]);

      await controller.getPeriodResults(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        "1m",
        `${UUID_A},${UUID_B}`,
      );

      expect(mockPeriodResults.getPeriodResults).toHaveBeenCalledWith(
        "owner-1",
        expect.objectContaining({ accountIds: [UUID_A] }),
      );
    });
  });

  describe("getPeriodResult()", () => {
    it("passes the window, the baseline and the scope through", async () => {
      mockPeriodResult.getPeriodResult!.mockReturnValue("result");

      const result = await controller.getPeriodResult(
        mockReq,
        "2026-01-02",
        "2026-09-17",
        "2026-01-01",
        UUID_A,
        "usdx",
      );

      expect(result).toBe("result");
      expect(mockPeriodResult.getPeriodResult).toHaveBeenCalledWith("user-1", {
        startDate: "2026-01-02",
        endDate: "2026-09-17",
        baselineDate: "2026-01-01",
        accountIds: [UUID_A],
        displayCurrency: "USD",
      });
    });

    it("requires a startDate", async () => {
      await expect(
        controller.getPeriodResult(mockReq, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a malformed baselineDate", async () => {
      await expect(
        controller.getPeriodResult(
          mockReq,
          "2026-01-02",
          undefined,
          "01/01/2026",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a malformed endDate", async () => {
      await expect(
        controller.getPeriodResult(mockReq, "2026-01-02", "nope"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an accountId that is not a UUID", async () => {
      await expect(
        controller.getPeriodResult(
          mockReq,
          "2026-01-02",
          undefined,
          undefined,
          "not-a-uuid",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("scopes the accounts to what an acting delegate may read", async () => {
      mockPeriodResult.getPeriodResult!.mockReturnValue("ok");
      delegationService.readableAccountIds.mockResolvedValue([UUID_A]);

      await controller.getPeriodResult(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        "2026-01-02",
        undefined,
        undefined,
        `${UUID_A},${UUID_B}`,
      );

      expect(mockPeriodResult.getPeriodResult).toHaveBeenCalledWith(
        "owner-1",
        expect.objectContaining({ accountIds: [UUID_A] }),
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
        // The parameter the caller has to fix is what the message must name;
        // the sentence around it is copy, and pinning that made a wording
        // change break a validation test.
      ).rejects.toThrow(/"startDate".*YYYY-MM-DD/);
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
      ).rejects.toThrow(/"accountIds".*UUID/);
    });

    it("routes sampling=monthEnd to the sampled series with the scoped ids", async () => {
      mockNetWorthService.getSampledInvestments!.mockResolvedValue("sampled");

      const result = await controller.getDailyInvestments(
        mockReq,
        undefined,
        "2026-09-28",
        UUID_A,
        "cad",
        "monthEnd",
      );

      expect(result).toBe("sampled");
      expect(mockNetWorthService.getSampledInvestments).toHaveBeenCalledWith(
        "user-1",
        {
          startDate: undefined,
          endDate: "2026-09-28",
          accountIds: [UUID_A],
          displayCurrency: "CAD",
        },
      );
      expect(mockNetWorthService.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("throws on an unknown sampling", async () => {
      await expect(
        controller.getDailyInvestments(
          mockReq,
          "2025-01-01",
          undefined,
          undefined,
          undefined,
          "weekly",
        ),
      ).rejects.toThrow(/"sampling"/);
      expect(mockNetWorthService.getSampledInvestments).not.toHaveBeenCalled();
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

    it("accepts the monthEnd granularity", async () => {
      mockNetWorthService.getInvestmentBreakdown!.mockResolvedValue("bd");

      await controller.getInvestmentBreakdown(mockReq, "monthEnd");

      expect(mockNetWorthService.getInvestmentBreakdown).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ granularity: "monthEnd" }),
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
    it("throws on invalid startDate format", async () => {
      await expect(
        controller.getMonthlyNetWorth(mockReq, "not-a-date"),
      ).rejects.toThrow(/real YYYY-MM-DD calendar date/);
    });
    it("throws on invalid endDate format", async () => {
      await expect(
        controller.getMonthlyNetWorth(mockReq, "2024-01-01", "bad"),
      ).rejects.toThrow(/real YYYY-MM-DD calendar date/);
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
