import { Test, TestingModule } from "@nestjs/testing";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";

describe("AccountsController", () => {
  let controller: AccountsController;
  let mockAccountsService: Partial<Record<keyof AccountsService, jest.Mock>>;
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [
        {
          provide: AccountsService,
          useValue: mockAccountsService,
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
    it("delegates to accountsService.findAll with userId and includeInactive", () => {
      mockAccountsService.findAll!.mockReturnValue("accounts");

      const result = controller.findAll(mockReq, true);

      expect(result).toBe("accounts");
      expect(mockAccountsService.findAll).toHaveBeenCalledWith("user-1", true);
    });

    it("defaults includeInactive to false when undefined", () => {
      mockAccountsService.findAll!.mockReturnValue("accounts");

      controller.findAll(mockReq, undefined);

      expect(mockAccountsService.findAll).toHaveBeenCalledWith("user-1", false);
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
    it("delegates to accountsService.findOne with userId and id", () => {
      mockAccountsService.findOne!.mockReturnValue("account");

      const result = controller.findOne(mockReq, "account-1");

      expect(result).toBe("account");
      expect(mockAccountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
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
    it("delegates to accountsService.getDailyBalances with parsed accountIds", () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");

      const result = controller.getDailyBalances(
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

    it("passes undefined accountIds when not provided", () => {
      mockAccountsService.getDailyBalances!.mockReturnValue("balances");

      controller.getDailyBalances(
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
});
