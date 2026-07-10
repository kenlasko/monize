import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";
import { AccountExportService } from "./account-export.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { StatementCycleService } from "./statement-cycle.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { DelegationService } from "../delegation/delegation.service";

describe("AccountsController", () => {
  let controller: AccountsController;
  let mockAccountsService: Partial<Record<keyof AccountsService, jest.Mock>>;
  let mockExportService: Partial<Record<keyof AccountExportService, jest.Mock>>;
  let mockStatementCycleService: Record<string, jest.Mock>;
  let mockBalanceForecastService: Record<string, jest.Mock>;
  let mockDelegationService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

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

    mockDelegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([]),
      hasReadAccess: jest.fn().mockResolvedValue(true),
      getDelegateFavourites: jest.fn().mockResolvedValue(new Map()),
      setDelegateFavourite: jest.fn().mockResolvedValue(undefined),
      reorderDelegateFavourites: jest.fn().mockResolvedValue(undefined),
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
          useValue: { setupLoanPayments: jest.fn() },
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
          provide: DelegationService,
          useValue: mockDelegationService,
        },
      ],
    }).compile();

    controller = module.get<AccountsController>(AccountsController);
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
        isCanadian: true,
        isVariableRate: false,
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
        true,
        false,
      );
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
    it("delegates to accountsService.getBalance with userId and id", () => {
      mockAccountsService.getBalance!.mockReturnValue("balance");

      const result = controller.getBalance(mockReq, "account-1");

      expect(result).toBe("balance");
      expect(mockAccountsService.getBalance).toHaveBeenCalledWith(
        "user-1",
        "account-1",
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
    it("delegates to balanceForecastService with a clamped horizon", () => {
      mockBalanceForecastService.getBalanceForecast.mockReturnValue("forecast");

      const result = controller.getBalanceForecast(mockReq, "account-1", 30);

      expect(result).toBe("forecast");
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenCalledWith("user-1", "account-1", 30);
    });

    it("defaults the horizon to 90 days and clamps to 730", () => {
      controller.getBalanceForecast(mockReq, "account-1", undefined);
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenLastCalledWith("user-1", "account-1", 90);

      controller.getBalanceForecast(mockReq, "account-1", 5000);
      expect(
        mockBalanceForecastService.getBalanceForecast,
      ).toHaveBeenLastCalledWith("user-1", "account-1", 730);
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

    it("rejects non-delegate callers", async () => {
      await expect(
        controller.setDelegateFavourite(mockReq, "a1", {
          isFavourite: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDelegationService.setDelegateFavourite).not.toHaveBeenCalled();
    });
  });
});
