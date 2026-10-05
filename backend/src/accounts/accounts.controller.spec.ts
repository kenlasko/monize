import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";
import { AccountExportService } from "./account-export.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { StatementCycleService } from "./statement-cycle.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { DailyBalanceTotalsService } from "./daily-balance-totals.service";
import { DailyBalanceTotalsQueryDto } from "./dto/daily-balance-totals-query.dto";
import { AccountBalancesReportService } from "./account-balances-report.service";
import { DelegationService } from "../delegation/delegation.service";

describe("AccountsController", () => {
  let controller: AccountsController;
  let mockAccountsService: Partial<Record<keyof AccountsService, jest.Mock>>;
  let mockExportService: Partial<Record<keyof AccountExportService, jest.Mock>>;
  let mockStatementCycleService: Record<string, jest.Mock>;
  let mockBalanceForecastService: Record<string, jest.Mock>;
  let mockDailyBalanceTotals: Record<string, jest.Mock>;
  let mockBalancesReport: Record<string, jest.Mock>;
  let mockDelegationService: Record<string, jest.Mock>;
  let mockCrossOwnerAccess: Record<string, jest.Mock>;
  let mockLoanPaymentSetup: Record<string, jest.Mock>;
  let mockJointAccounts: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1", realUserId: "user-1" } };

  beforeEach(async () => {
    mockAccountsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      getSummary: jest.fn(),
      previewLoanAmortization: jest.fn(),
      previewMortgageAmortization: jest.fn(),
      findOne: jest.fn(),
      getBalance: jest.fn(),
      getInvestmentAccountPair: jest.fn(),
      update: jest.fn(),
      updateMortgageRate: jest.fn(),
      detectMortgageTypeFromSamples: jest.fn(),
      detectMortgageTypeFromHistory: jest.fn(),
      close: jest.fn(),
      reopen: jest.fn(),
      getTransactionCount: jest.fn(),
      delete: jest.fn(),
      getDailyBalances: jest.fn(),
      reorderFavourites: jest.fn(),
    };

    mockExportService = {
      exportCsv: jest.fn(),
      exportQif: jest.fn(),
    };

    mockStatementCycleService = {
      getStatementCycle: jest.fn(),
      getInterestPaid: jest.fn(),
    };

    mockBalanceForecastService = {
      getBalanceForecast: jest.fn(),
    };

    mockDailyBalanceTotals = {
      getDailyBalanceTotals: jest.fn(),
    };

    mockBalancesReport = {
      getBalancesAsOf: jest.fn(),
    };

    mockDelegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([]),
      hasReadAccess: jest.fn().mockResolvedValue(true),
      getDelegateFavourites: jest.fn().mockResolvedValue(new Map()),
      setDelegateFavourite: jest.fn().mockResolvedValue(undefined),
      reorderDelegateFavourites: jest.fn().mockResolvedValue(undefined),
    };

    mockCrossOwnerAccess = {
      transferCandidatesFor: jest.fn().mockResolvedValue([]),
    };

    mockLoanPaymentSetup = {
      setupLoanPayments: jest.fn(),
      previewFirstInstallment: jest.fn(),
    };

    mockJointAccounts = {
      jointShareCountsForOwner: jest.fn().mockResolvedValue(new Map()),
      jointAccountsFor: jest.fn().mockResolvedValue([]),
      jointAccountIdSetFor: jest.fn().mockResolvedValue(new Set()),
      jointAccessFor: jest.fn(),
      setNetWorthExclusion: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [
        {
          provide: AccountsService,
          useValue: mockAccountsService,
        },
        {
          provide: AccountExportService,
          useValue: mockExportService,
        },
        {
          provide: LoanPaymentDetectorService,
          useValue: { detectPaymentPattern: jest.fn() },
        },
        {
          provide: LoanPaymentSetupService,
          useValue: mockLoanPaymentSetup,
        },
        {
          provide: StatementCycleService,
          useValue: mockStatementCycleService,
        },
        {
          provide: BalanceForecastService,
          useValue: mockBalanceForecastService,
        },
        {
          provide: DailyBalanceTotalsService,
          useValue: mockDailyBalanceTotals,
        },
        {
          provide: AccountBalancesReportService,
          useValue: mockBalancesReport,
        },
        {
          provide: DelegationService,
          useValue: mockDelegationService,
        },
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          provide: require("../delegation/cross-owner-access.service")
            .CrossOwnerAccessService,
          useValue: mockCrossOwnerAccess,
        },
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          provide: require("../delegation/joint-accounts.service")
            .JointAccountsService,
          useValue: mockJointAccounts,
        },
      ],
    }).compile();

    controller = module.get<AccountsController>(AccountsController);
  });

  describe("previewLoanPaymentSetup()", () => {
    it("prices the setup for the JWT's user, never one from the request", async () => {
      const preview = {
        derivesInstallment: true,
        principalPayment: 833.3333,
        interestPayment: 500,
        paymentAmount: 1333.3333,
      };
      mockLoanPaymentSetup.previewFirstInstallment.mockResolvedValue(preview);
      const dto = { paymentFrequency: "MONTHLY", nextDueDate: "2024-01-01" };

      await expect(
        controller.previewLoanPaymentSetup(
          { user: { id: "user-1" } },
          "mortgage-1",
          dto,
        ),
      ).resolves.toBe(preview);
      expect(mockLoanPaymentSetup.previewFirstInstallment).toHaveBeenCalledWith(
        "user-1",
        "mortgage-1",
        dto,
      );
    });
  });

  describe("getTransferCandidates()", () => {
    it("own context: passes the same id as real and effective user", async () => {
      const candidates = [{ id: "acc-1", name: "Shared", canCreate: true }];
      mockCrossOwnerAccess.transferCandidatesFor.mockResolvedValue(candidates);

      const result = await controller.getTransferCandidates({
        user: { id: "user-1", realUserId: "user-1" },
      });

      expect(result).toBe(candidates);
      expect(mockCrossOwnerAccess.transferCandidatesFor).toHaveBeenCalledWith(
        "user-1",
        "user-1",
      );
    });

    it("acting context: passes the delegate as real user and the owner as effective", async () => {
      await controller.getTransferCandidates({
        user: { id: "owner-1", realUserId: "delegate-1", isActing: true },
      });

      expect(mockCrossOwnerAccess.transferCandidatesFor).toHaveBeenCalledWith(
        "delegate-1",
        "owner-1",
      );
    });

    it("returns empty results untouched", async () => {
      await expect(
        controller.getTransferCandidates({ user: { id: "user-1" } }),
      ).resolves.toEqual([]);
    });
  });

  describe("create()", () => {
    it("delegates to accountsService.create with userId and dto", () => {
      const dto = { name: "Checking" } as any;
      mockAccountsService.create!.mockReturnValue("created");

      const result = controller.create(mockReq, dto);

      expect(result).toBe("created");
      expect(mockAccountsService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to accountsService.findAll with userId and includeInactive", async () => {
      mockAccountsService.findAll!.mockResolvedValue("accounts");

      const result = await controller.findAll(mockReq, true);

      expect(result).toBe("accounts");
      expect(mockAccountsService.findAll).toHaveBeenCalledWith("user-1", true);
    });

    it("defaults includeInactive to false when undefined", async () => {
      mockAccountsService.findAll!.mockResolvedValue("accounts");

      await controller.findAll(mockReq, undefined);

      expect(mockAccountsService.findAll).toHaveBeenCalledWith("user-1", false);
    });

    it("filters to READ-granted accounts when acting as a delegate", async () => {
      mockAccountsService.findAll!.mockResolvedValue([
        { id: "a1", isFavourite: false, favouriteSortOrder: 0 },
        { id: "a2", isFavourite: false, favouriteSortOrder: 0 },
      ]);
      mockDelegationService.readableAccountIds.mockResolvedValue(["a1"]);
      const actingReq = {
        user: {
          id: "owner-1",
          realUserId: "deleg-1",
          isActing: true,
          delegationId: "g1",
        },
      };

      const result = await controller.findAll(actingReq as never, false);

      expect(result).toEqual([
        { id: "a1", isFavourite: false, favouriteSortOrder: 0 },
      ]);
    });

    it("overlays the delegate's own favourites, not the owner's", async () => {
      mockAccountsService.findAll!.mockResolvedValue([
        { id: "a1", isFavourite: true, favouriteSortOrder: 5 },
        { id: "a2", isFavourite: false, favouriteSortOrder: 0 },
      ]);
      mockDelegationService.readableAccountIds.mockResolvedValue(["a1", "a2"]);
      // Owner has a1 favourite; delegate instead favourites only a2.
      mockDelegationService.getDelegateFavourites.mockResolvedValue(
        new Map([["a2", 3]]),
      );
      const actingReq = {
        user: {
          id: "owner-1",
          realUserId: "deleg-1",
          isActing: true,
          delegationId: "g1",
        },
      };

      const result = await controller.findAll(actingReq as never, false);

      expect(result).toEqual([
        { id: "a1", isFavourite: false, favouriteSortOrder: 0 },
        { id: "a2", isFavourite: true, favouriteSortOrder: 3 },
      ]);
      expect(mockDelegationService.getDelegateFavourites).toHaveBeenCalledWith(
        "deleg-1",
      );
    });
  });

  describe("getSummary()", () => {
    it("delegates to accountsService.getSummary with userId", () => {
      mockAccountsService.getSummary!.mockReturnValue("summary");

      const result = controller.getSummary(mockReq);

      expect(result).toBe("summary");
      expect(mockAccountsService.getSummary).toHaveBeenCalledWith("user-1");
    });
  });

  describe("previewLoanAmortization()", () => {
    it("delegates to accountsService.previewLoanAmortization with dto fields", () => {
      const dto = {
        loanAmount: 10000,
        interestRate: 5,
        paymentAmount: 500,
        paymentFrequency: "monthly",
        paymentStartDate: "2024-01-01",
      };
      mockAccountsService.previewLoanAmortization!.mockReturnValue("preview");

      const result = controller.previewLoanAmortization(dto as any);

      expect(result).toBe("preview");
      expect(mockAccountsService.previewLoanAmortization).toHaveBeenCalledWith(
        10000,
        5,
        500,
        "monthly",
        new Date("2024-01-01"),
      );
    });
  });

  describe("previewMortgageAmortization()", () => {
    it("delegates to accountsService.previewMortgageAmortization with dto fields", () => {
      const dto = {
        mortgageAmount: 300000,
        interestRate: 4.5,
        amortizationMonths: 300,
        paymentFrequency: "monthly",
        paymentStartDate: "2024-01-01",
        mortgageType: "CANADIAN_FIXED",
      };
      mockAccountsService.previewMortgageAmortization!.mockReturnValue({
        paymentAmount: 1500,
        endDate: new Date("2049-01-01"),
      });

      const result = controller.previewMortgageAmortization(dto as any);

      expect(result.paymentAmount).toBe(1500);
      expect(result.endDate).toBe("2049-01-01");
      expect(
        mockAccountsService.previewMortgageAmortization,
      ).toHaveBeenCalledWith(
        300000,
        4.5,
        300,
        "monthly",
        new Date("2024-01-01"),
        "CANADIAN_FIXED",
      );
    });

    it("passes the requested type, else the default type", () => {
      mockAccountsService.previewMortgageAmortization!.mockReturnValue({
        paymentAmount: 1500,
        endDate: new Date("2049-01-01"),
      });
      const base = {
        mortgageAmount: 300000,
        interestRate: 4.5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
      };
      const typeArg = () => {
        const calls =
          mockAccountsService.previewMortgageAmortization!.mock.calls;
        return calls[calls.length - 1][5];
      };

      controller.previewMortgageAmortization({
        ...base,
        mortgageType: "ANNUITY",
      } as any);
      expect(typeArg()).toBe("ANNUITY");

      controller.previewMortgageAmortization({
        ...base,
        mortgageType: "CANADIAN_FIXED",
      } as any);
      expect(typeArg()).toBe("CANADIAN_FIXED");

      // No type: the default type.
      controller.previewMortgageAmortization(base as any);
      expect(typeArg()).toBe("ANNUITY");
    });
  });

  describe("findOne()", () => {
    it("delegates to accountsService.findOne with userId and id", async () => {
      mockAccountsService.findOne!.mockResolvedValue("account");

      const result = await controller.findOne(mockReq, "account-1");

      expect(result).toBe("account");
      expect(mockAccountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("overlays the delegate's own favourite when acting", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        id: "a1",
        isFavourite: true,
        favouriteSortOrder: 9,
      });
      mockDelegationService.getDelegateFavourites.mockResolvedValue(
        new Map([["a1", 2]]),
      );
      const actingReq = {
        user: {
          id: "owner-1",
          realUserId: "deleg-1",
          isActing: true,
          delegationId: "g1",
        },
      };

      const result = await controller.findOne(actingReq as never, "a1");

      expect(result).toEqual({
        id: "a1",
        isFavourite: true,
        favouriteSortOrder: 2,
      });
    });
  });

  describe("getBalance()", () => {
    it("delegates to accountsService.getBalance with userId and id", async () => {
      mockAccountsService.getBalance!.mockResolvedValue("balance");

      const result = await controller.getBalance(mockReq, "account-1");

      expect(result).toBe("balance");
      expect(mockAccountsService.getBalance).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("falls back to the owner's scope for a joint account after authorization", async () => {
      const { NotFoundException } = jest.requireActual("@nestjs/common");
      mockAccountsService
        .getBalance!.mockRejectedValueOnce(new NotFoundException())
        .mockResolvedValueOnce({ balance: 42 });
      mockJointAccounts.jointAccessFor.mockResolvedValue({
        ownerUserId: "owner-9",
        via: "delegation",
      });

      const result = await controller.getBalance(mockReq, "joint-1");

      expect(result).toEqual({ balance: 42 });
      expect(mockJointAccounts.jointAccessFor).toHaveBeenCalledWith(
        "user-1",
        "joint-1",
        "read",
      );
      expect(mockAccountsService.getBalance).toHaveBeenLastCalledWith(
        "owner-9",
        "joint-1",
      );
    });
  });

  describe("getInvestmentPair()", () => {
    it("delegates to accountsService.getInvestmentAccountPair with userId and id", () => {
      mockAccountsService.getInvestmentAccountPair!.mockReturnValue("pair");

      const result = controller.getInvestmentPair(mockReq, "account-1");

      expect(result).toBe("pair");
      expect(mockAccountsService.getInvestmentAccountPair).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("getStatementCycle()", () => {
    it("delegates to statementCycleService.getStatementCycle with userId and id", () => {
      mockStatementCycleService.getStatementCycle.mockReturnValue("cycle");

      const result = controller.getStatementCycle(mockReq, "account-1");

      expect(result).toBe("cycle");
      expect(mockStatementCycleService.getStatementCycle).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("getBalanceForecast()", () => {
    it("delegates to balanceForecastService with a clamped horizon", async () => {
      mockBalanceForecastService.getBalanceForecast.mockReturnValue("forecast");

      const result = await controller.getBalanceForecast(
        mockReq,
        "account-1",
        30,
      );

      expect(result).toBe("forecast");
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenCalledWith("user-1", "account-1", 30);
    });

    it("defaults the horizon to 90 days and clamps to 730", async () => {
      await controller.getBalanceForecast(mockReq, "account-1", undefined);
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenLastCalledWith("user-1", "account-1", 90);

      await controller.getBalanceForecast(mockReq, "account-1", 5000);
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenLastCalledWith("user-1", "account-1", 730);
    });

    it("falls back to the owner's scope for a joint account after authorization", async () => {
      // Without this the grantee's balance chart stops at today while the
      // owner's carries a forward line, and the projected-balance card
      // silently reports today's balance as the projection.
      const { NotFoundException } = jest.requireActual("@nestjs/common");
      mockBalanceForecastService.getBalanceForecast
        .mockRejectedValueOnce(new NotFoundException())
        .mockResolvedValueOnce({ points: [] });
      mockJointAccounts.jointAccessFor.mockResolvedValue({
        ownerUserId: "owner-9",
        via: "delegation",
      });

      const result = await controller.getBalanceForecast(mockReq, "joint-1");

      expect(result).toEqual({ points: [] });
      expect(mockJointAccounts.jointAccessFor).toHaveBeenCalledWith(
        "user-1",
        "joint-1",
        "read",
      );
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenLastCalledWith("owner-9", "joint-1", 90);
    });

    it("re-raises the 404 while acting, never taking the joint path", async () => {
      const { NotFoundException } = jest.requireActual("@nestjs/common");
      mockBalanceForecastService.getBalanceForecast.mockRejectedValueOnce(
        new NotFoundException(),
      );

      await expect(
        controller.getBalanceForecast(
          { user: { id: "owner-1", realUserId: "d1", isActing: true } },
          "joint-1",
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockJointAccounts.jointAccessFor).not.toHaveBeenCalled();
    });
  });

  describe("getInterestPaid()", () => {
    it("delegates to statementCycleService.getInterestPaid with validated dates", () => {
      mockStatementCycleService.getInterestPaid.mockReturnValue("interest");

      const result = controller.getInterestPaid(
        mockReq,
        "account-1",
        "2026-01-01",
        "2026-12-31",
      );

      expect(result).toBe("interest");
      expect(mockStatementCycleService.getInterestPaid).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        "2026-01-01",
        "2026-12-31",
      );
    });

    it("rejects a missing or malformed startDate", () => {
      expect(() =>
        controller.getInterestPaid(
          mockReq,
          "account-1",
          undefined,
          "2026-12-31",
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.getInterestPaid(
          mockReq,
          "account-1",
          "2026/01/01",
          "2026-12-31",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects a missing or malformed endDate", () => {
      expect(() =>
        controller.getInterestPaid(
          mockReq,
          "account-1",
          "2026-01-01",
          undefined,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        controller.getInterestPaid(mockReq, "account-1", "2026-01-01", "bad"),
      ).toThrow(BadRequestException);
    });
  });

  describe("update()", () => {
    it("delegates to accountsService.update with userId, id, and dto", () => {
      const dto = { name: "Updated" } as any;
      mockAccountsService.update!.mockReturnValue("updated");

      const result = controller.update(mockReq, "account-1", dto);

      expect(result).toBe("updated");
      expect(mockAccountsService.update).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        dto,
      );
    });
  });

  describe("detectMortgageType()", () => {
    it("delegates the request's samples to accountsService", () => {
      const dto = {
        samples: [
          { principal: 432.9, interest: 1500, balanceBefore: 300000 },
          { principal: 435.06, interest: 1497.84, balanceBefore: 299567.1 },
        ],
        interestRate: 6,
        paymentFrequency: "MONTHLY" as const,
      };
      const suggestion = {
        type: "ANNUITY",
        confidence: "high",
        reason: "CONSTANT_INSTALLMENT_NOMINAL",
      };
      mockAccountsService.detectMortgageTypeFromSamples!.mockReturnValue(
        suggestion,
      );

      expect(controller.detectMortgageType(dto)).toBe(suggestion);
      expect(
        mockAccountsService.detectMortgageTypeFromSamples,
      ).toHaveBeenCalledWith(dto);
    });
  });

  describe("detectMortgageTypeFromHistory()", () => {
    it("delegates with the userId from the JWT and the account id", async () => {
      mockAccountsService.detectMortgageTypeFromHistory!.mockResolvedValue(
        "suggestion",
      );

      await expect(
        controller.detectMortgageTypeFromHistory(mockReq, "account-1"),
      ).resolves.toBe("suggestion");
      expect(
        mockAccountsService.detectMortgageTypeFromHistory,
      ).toHaveBeenCalledWith("user-1", "account-1");
    });
  });

  describe("updateMortgageRate()", () => {
    it("delegates to accountsService.updateMortgageRate with userId, id, and dto fields", () => {
      const dto = {
        newRate: 3.5,
        effectiveDate: "2024-06-01",
        newPaymentAmount: 1400,
      };
      mockAccountsService.updateMortgageRate!.mockReturnValue("updated");

      const result = controller.updateMortgageRate(
        mockReq,
        "account-1",
        dto as any,
      );

      expect(result).toBe("updated");
      expect(mockAccountsService.updateMortgageRate).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        3.5,
        new Date("2024-06-01"),
        1400,
      );
    });
  });

  describe("close()", () => {
    it("delegates to accountsService.close with userId and id", () => {
      mockAccountsService.close!.mockReturnValue("closed");

      const result = controller.close(mockReq, "account-1");

      expect(result).toBe("closed");
      expect(mockAccountsService.close).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("reopen()", () => {
    it("delegates to accountsService.reopen with userId and id", () => {
      mockAccountsService.reopen!.mockReturnValue("reopened");

      const result = controller.reopen(mockReq, "account-1");

      expect(result).toBe("reopened");
      expect(mockAccountsService.reopen).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("canDelete()", () => {
    it("delegates to accountsService.getTransactionCount with userId and id", () => {
      mockAccountsService.getTransactionCount!.mockReturnValue("count");

      const result = controller.canDelete(mockReq, "account-1");

      expect(result).toBe("count");
      expect(mockAccountsService.getTransactionCount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("getBalancesAsOf()", () => {
    const payload = (asOfDate: string, accounts: any[] = []) => ({
      asOfDate,
      accounts,
    });

    it("defaults to today when no date is supplied", async () => {
      mockBalancesReport.getBalancesAsOf.mockResolvedValue(payload("today"));

      await controller.getBalancesAsOf(mockReq);

      const [, date] = mockBalancesReport.getBalancesAsOf.mock.calls[0];
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("passes the requested date through", async () => {
      mockBalancesReport.getBalancesAsOf.mockResolvedValue(
        payload("2020-01-01"),
      );

      const result = await controller.getBalancesAsOf(mockReq, "2020-01-01");

      expect(result).toEqual(payload("2020-01-01"));
      expect(mockBalancesReport.getBalancesAsOf).toHaveBeenCalledWith(
        "user-1",
        "2020-01-01",
        [],
      );
    });

    // The refusal comes before any read: a malformed date must not reach a
    // query at all.
    it("rejects a date that is not YYYY-MM-DD without reading anything", async () => {
      await expect(
        controller.getBalancesAsOf(mockReq, "01/01/2020"),
      ).rejects.toThrow(BadRequestException);
      expect(mockBalancesReport.getBalancesAsOf).not.toHaveBeenCalled();
    });

    it("includes the caller's jointly shared accounts in own context", async () => {
      mockJointAccounts.jointAccountIdSetFor.mockResolvedValue(
        new Set(["joint-1"]),
      );
      mockBalancesReport.getBalancesAsOf.mockResolvedValue(
        payload("2020-01-01"),
      );

      await controller.getBalancesAsOf(mockReq, "2020-01-01");

      expect(mockBalancesReport.getBalancesAsOf).toHaveBeenCalledWith(
        "user-1",
        "2020-01-01",
        ["joint-1"],
      );
    });

    // A delegate sees the accounts their grant names and nothing else, and the
    // grant restricts the query rather than filtering its result -- an
    // owner-wide read narrowed afterwards has still read the other balances.
    it("restricts an acting delegate's query to their readable accounts", async () => {
      mockDelegationService.readableAccountIds.mockResolvedValue(["acc-1"]);
      mockBalancesReport.getBalancesAsOf.mockResolvedValue(
        payload("2020-01-01", [{ accountId: "acc-1" }]),
      );

      const result = await controller.getBalancesAsOf(
        { user: { id: "owner-1", isActing: true, delegationId: "del-1" } },
        "2020-01-01",
      );

      expect(result.accounts).toEqual([{ accountId: "acc-1" }]);
      expect(mockBalancesReport.getBalancesAsOf).toHaveBeenCalledWith(
        "owner-1",
        "2020-01-01",
        [],
        ["acc-1"],
      );
    });

    // An empty grant is "no accounts", never "no restriction".
    it("passes an empty grant through as an empty restriction", async () => {
      mockDelegationService.readableAccountIds.mockResolvedValue([]);
      mockBalancesReport.getBalancesAsOf.mockResolvedValue(
        payload("2020-01-01", []),
      );

      const result = await controller.getBalancesAsOf(
        { user: { id: "owner-1", isActing: true, delegationId: "del-1" } },
        "2020-01-01",
      );

      expect(result).toEqual({ asOfDate: "2020-01-01", accounts: [] });
      expect(mockBalancesReport.getBalancesAsOf).toHaveBeenCalledWith(
        "owner-1",
        "2020-01-01",
        [],
        [],
      );
    });
  });

  describe("getDailyBalanceTotals()", () => {
    const query = {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    } as DailyBalanceTotalsQueryDto;

    it("passes the requested scope through for an owner", async () => {
      mockDailyBalanceTotals.getDailyBalanceTotals.mockResolvedValue("totals");

      const result = await controller.getDailyBalanceTotals(mockReq, {
        ...query,
        accountIds: ["acc-1"],
        displayCurrency: "CAD",
      } as DailyBalanceTotalsQueryDto);

      expect(result).toBe("totals");
      expect(mockDailyBalanceTotals.getDailyBalanceTotals).toHaveBeenCalledWith(
        "user-1",
        "2026-06-01",
        "2026-06-30",
        ["acc-1"],
        "CAD",
        [],
      );
    });

    it("widens an owner's scope with the joint accounts they were granted", async () => {
      mockJointAccounts.jointAccountIdSetFor.mockResolvedValue(
        new Set(["joint-1"]),
      );
      mockDailyBalanceTotals.getDailyBalanceTotals.mockResolvedValue("totals");

      await controller.getDailyBalanceTotals(mockReq, query);

      expect(mockDailyBalanceTotals.getDailyBalanceTotals).toHaveBeenCalledWith(
        "user-1",
        "2026-06-01",
        "2026-06-30",
        undefined,
        undefined,
        ["joint-1"],
      );
    });

    it("narrows an acting delegate to their readable accounts", async () => {
      mockDelegationService.readableAccountIds.mockResolvedValue([
        "acc-1",
        "acc-2",
      ]);
      mockDailyBalanceTotals.getDailyBalanceTotals.mockResolvedValue("totals");

      await controller.getDailyBalanceTotals(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        {
          ...query,
          accountIds: ["acc-2", "acc-9"],
        } as DailyBalanceTotalsQueryDto,
      );

      expect(mockDailyBalanceTotals.getDailyBalanceTotals).toHaveBeenCalledWith(
        "owner-1",
        "2026-06-01",
        "2026-06-30",
        ["acc-2"],
        undefined,
        [],
      );
    });

    it("gives a delegate with no readable accounts an empty scope, never every account", async () => {
      mockDelegationService.readableAccountIds.mockResolvedValue([]);
      mockDailyBalanceTotals.getDailyBalanceTotals.mockResolvedValue("totals");

      await controller.getDailyBalanceTotals(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        query,
      );

      const ids = mockDailyBalanceTotals.getDailyBalanceTotals.mock.calls[0][3];
      expect(ids).toEqual(["00000000-0000-0000-0000-000000000000"]);
    });
  });

  describe("getDailyBalances()", () => {
    it("delegates to accountsService.getDailyBalances with parsed accountIds", async () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");

      const result = await controller.getDailyBalances(
        mockReq,
        "2025-01-01",
        "2025-12-31",
        "acc-1,acc-2",
      );

      expect(result).toBe("balances");
      expect(mockAccountsService.getDailyBalances).toHaveBeenCalledWith(
        "user-1",
        "2025-01-01",
        "2025-12-31",
        ["acc-1", "acc-2"],
        false,
        [],
      );
    });

    it("passes undefined accountIds when not provided", async () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");

      await controller.getDailyBalances(
        mockReq,
        "2025-01-01",
        "2025-12-31",
        undefined,
      );

      expect(mockAccountsService.getDailyBalances).toHaveBeenCalledWith(
        "user-1",
        "2025-01-01",
        "2025-12-31",
        undefined,
        false,
        [],
      );
    });

    it("forwards allTime=true as a boolean flag", async () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");

      await controller.getDailyBalances(
        mockReq,
        undefined,
        undefined,
        "acc-1",
        "true",
      );

      expect(mockAccountsService.getDailyBalances).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
        ["acc-1"],
        true,
        [],
      );
    });

    it("passes the authorized joint ids in own context", async () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");
      mockJointAccounts.jointAccountIdSetFor.mockResolvedValue(
        new Set(["joint-1", "joint-2"]),
      );

      // Unfiltered request: every joint id participates.
      await controller.getDailyBalances(mockReq);
      expect(mockAccountsService.getDailyBalances).toHaveBeenLastCalledWith(
        "user-1",
        undefined,
        undefined,
        undefined,
        false,
        ["joint-1", "joint-2"],
      );

      // Filtered request: only requested ids that are actually joint pass.
      await controller.getDailyBalances(
        mockReq,
        undefined,
        undefined,
        "joint-2,own-1,stranger-1",
      );
      expect(mockAccountsService.getDailyBalances).toHaveBeenLastCalledWith(
        "user-1",
        undefined,
        undefined,
        ["joint-2", "own-1", "stranger-1"],
        false,
        ["joint-2"],
      );
    });
  });

  describe("delete()", () => {
    it("delegates to accountsService.delete with userId and id", () => {
      mockAccountsService.delete!.mockReturnValue("deleted");

      const result = controller.delete(mockReq, "account-1");

      expect(result).toBe("deleted");
      expect(mockAccountsService.delete).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("exportAccount()", () => {
    const mockRes = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as any;

    it("exports CSV format with expandSplits defaulting to true", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Chequing",
      });
      mockExportService.exportCsv!.mockResolvedValue("csv-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "csv",
        undefined,
        undefined,
        mockRes,
      );

      expect(mockExportService.exportCsv).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { expandSplits: true, dateFormat: undefined },
        "user-1",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/csv; charset=utf-8",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="Chequing.csv"',
      );
      expect(mockRes.send).toHaveBeenCalledWith(
        Buffer.from("csv-content", "utf-8"),
      );
    });

    it("passes expandSplits false to CSV export (string)", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Chequing",
      });
      mockExportService.exportCsv!.mockResolvedValue("csv-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "csv",
        "false",
        undefined,
        mockRes,
      );

      expect(mockExportService.exportCsv).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { expandSplits: false, dateFormat: undefined },
        "user-1",
      );
    });

    it("passes expandSplits false to CSV export (boolean from transform)", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Chequing",
      });
      mockExportService.exportCsv!.mockResolvedValue("csv-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "csv",
        false as any,
        undefined,
        mockRes,
      );

      expect(mockExportService.exportCsv).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { expandSplits: false, dateFormat: undefined },
        "user-1",
      );
    });

    it("exports QIF format", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Savings",
      });
      mockExportService.exportQif!.mockResolvedValue("qif-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "qif",
        undefined,
        undefined,
        mockRes,
      );

      expect(mockExportService.exportQif).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { dateFormat: undefined },
        "user-1",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/x-qif; charset=utf-8",
      );
      expect(mockRes.send).toHaveBeenCalledWith(
        Buffer.from("qif-content", "utf-8"),
      );
    });

    it("passes dateFormat to CSV export", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Chequing",
      });
      mockExportService.exportCsv!.mockResolvedValue("csv-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "csv",
        undefined,
        "DD/MM/YYYY",
        mockRes,
      );

      expect(mockExportService.exportCsv).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { expandSplits: true, dateFormat: "DD/MM/YYYY" },
        "user-1",
      );
    });

    it("passes dateFormat to QIF export", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "Chequing",
      });
      mockExportService.exportQif!.mockResolvedValue("qif-content");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "qif",
        undefined,
        "YYYY-MM-DD",
        mockRes,
      );

      expect(mockExportService.exportQif).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        { dateFormat: "YYYY-MM-DD" },
        "user-1",
      );
    });

    it("throws BadRequestException for invalid dateFormat characters", async () => {
      await expect(
        controller.exportAccount(
          mockReq,
          "account-1",
          "csv",
          undefined,
          "YYYY<script>",
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for dateFormat exceeding max length", async () => {
      await expect(
        controller.exportAccount(
          mockReq,
          "account-1",
          "csv",
          undefined,
          "YYYY-MM-DD-YYYY-MM-DD-X",
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for invalid format", async () => {
      await expect(
        controller.exportAccount(
          mockReq,
          "account-1",
          "xml",
          undefined,
          undefined,
          mockRes,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("sanitizes account name in filename", async () => {
      mockAccountsService.findOne!.mockResolvedValue({
        name: "My Account / Special",
      });
      mockExportService.exportCsv!.mockResolvedValue("csv");

      await controller.exportAccount(
        mockReq,
        "account-1",
        "csv",
        undefined,
        undefined,
        mockRes,
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="My_Account___Special.csv"',
      );
    });
  });

  describe("reorderFavourites()", () => {
    it("delegates to accountsService.reorderFavourites with userId and accountIds", () => {
      const dto = { accountIds: ["id-1", "id-2", "id-3"] };
      mockAccountsService.reorderFavourites!.mockResolvedValue(undefined);

      controller.reorderFavourites(mockReq, dto);

      expect(mockAccountsService.reorderFavourites).toHaveBeenCalledWith(
        "user-1",
        ["id-1", "id-2", "id-3"],
      );
    });

    it("reorders the delegate's own overlay when acting", () => {
      const dto = { accountIds: ["a1", "a2"] };
      const actingReq = {
        user: { id: "owner-1", realUserId: "deleg-1", isActing: true },
      };

      controller.reorderFavourites(actingReq as never, dto);

      expect(
        mockDelegationService.reorderDelegateFavourites,
      ).toHaveBeenCalledWith("deleg-1", ["a1", "a2"]);
      expect(mockAccountsService.reorderFavourites).not.toHaveBeenCalled();
    });
  });

  describe("setDelegateFavourite()", () => {
    it("stores the favourite on the delegate overlay when acting", async () => {
      const actingReq = {
        user: { id: "owner-1", realUserId: "deleg-1", isActing: true },
      };

      const result = await controller.setDelegateFavourite(
        actingReq as never,
        "a1",
        { isFavourite: true },
      );

      expect(result).toEqual({ isFavourite: true });
      expect(mockDelegationService.setDelegateFavourite).toHaveBeenCalledWith(
        "deleg-1",
        "a1",
        true,
      );
    });

    it("rejects own-context callers whose account is not jointly shared", async () => {
      // jointAccessFor 400s own accounts and 404s everything not shared;
      // either way nothing is stored.
      mockJointAccounts.jointAccessFor.mockRejectedValue(
        new BadRequestException(),
      );
      await expect(
        controller.setDelegateFavourite(mockReq, "a1", {
          isFavourite: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDelegationService.setDelegateFavourite).not.toHaveBeenCalled();
    });

    it("stores the overlay natively for a joint account in own context", async () => {
      mockJointAccounts.jointAccessFor.mockResolvedValue({
        ownerUserId: "owner-1",
        via: "delegation",
      });
      const result = await controller.setDelegateFavourite(mockReq, "a1", {
        isFavourite: true,
      });
      expect(result).toEqual({ isFavourite: true });
      expect(mockJointAccounts.jointAccessFor).toHaveBeenCalledWith(
        "user-1",
        "a1",
        "read",
      );
      expect(mockDelegationService.setDelegateFavourite).toHaveBeenCalledWith(
        "user-1",
        "a1",
        true,
      );
    });
  });

  describe("setNetWorthExclusion()", () => {
    it("delegates to the joint service with the caller's id", async () => {
      const result = await controller.setNetWorthExclusion(mockReq, "a1", {
        excluded: true,
      });
      expect(result).toEqual({ excluded: true });
      expect(mockJointAccounts.setNetWorthExclusion).toHaveBeenCalledWith(
        "user-1",
        "a1",
        true,
      );
    });
  });

  describe("findAll() union list", () => {
    const own = [
      { id: "own-1", isFavourite: false, favouriteSortOrder: 0 },
      { id: "own-2", isFavourite: false, favouriteSortOrder: 0 },
    ];

    it("appends joint rows with the caller's favourites overlay in own context", async () => {
      mockAccountsService.findAll!.mockResolvedValue(own);
      mockJointAccounts.jointAccountsFor.mockResolvedValue([
        {
          id: "joint-1",
          isJoint: true,
          isClosed: false,
          isFavourite: true, // the owner's flag -- must be replaced
          favouriteSortOrder: 7,
        },
      ]);
      mockDelegationService.getDelegateFavourites.mockResolvedValue(
        new Map([["joint-1", 3]]),
      );

      const result = await controller.findAll(mockReq, false);

      expect(result.map((a: { id: string }) => a.id)).toEqual([
        "own-1",
        "own-2",
        "joint-1",
      ]);
      const joint = result.find((a: { id: string }) => a.id === "joint-1");
      expect(joint).toMatchObject({
        isJoint: true,
        isFavourite: true,
        favouriteSortOrder: 3,
      });
      // Own rows pass through untouched (no overlay applied to them).
      expect(result[0]).toBe(own[0]);
    });

    it("filters closed joint rows unless includeInactive", async () => {
      mockAccountsService.findAll!.mockResolvedValue(own);
      mockJointAccounts.jointAccountsFor.mockResolvedValue([
        { id: "joint-closed", isJoint: true, isClosed: true },
      ]);

      const active = await controller.findAll(mockReq, false);
      expect(active.some((a: { id: string }) => a.id === "joint-closed")).toBe(
        false,
      );

      const all = await controller.findAll(mockReq, true);
      expect(all.some((a: { id: string }) => a.id === "joint-closed")).toBe(
        true,
      );
    });

    it("marks owner rows with jointGranteeCount and leaves unshared rows unmarked", async () => {
      mockAccountsService.findAll!.mockResolvedValue(own);
      mockJointAccounts.jointShareCountsForOwner.mockResolvedValue(
        new Map([["own-1", 2]]),
      );

      const result = await controller.findAll(mockReq, false);

      expect(result[0]).toMatchObject({ id: "own-1", jointGranteeCount: 2 });
      expect(
        Object.prototype.hasOwnProperty.call(result[1], "jointGranteeCount"),
      ).toBe(false);
    });

    it("does not consult the joint services while acting", async () => {
      mockAccountsService.findAll!.mockResolvedValue([
        { id: "a1", isFavourite: false, favouriteSortOrder: 0 },
      ]);
      mockDelegationService.readableAccountIds.mockResolvedValue(["a1"]);

      await controller.findAll(
        {
          user: {
            id: "owner-1",
            realUserId: "deleg-1",
            isActing: true,
            delegationId: "del-1",
          },
        } as never,
        false,
      );

      expect(mockJointAccounts.jointAccountsFor).not.toHaveBeenCalled();
      expect(mockJointAccounts.jointShareCountsForOwner).not.toHaveBeenCalled();
    });
  });
});
