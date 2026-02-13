import { ImportEntityCreatorService } from "./import-entity-creator.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Security } from "../securities/entities/security.entity";
import { ImportResultDto, CategoryMappingDto } from "./dto/import.dto";

describe("ImportEntityCreatorService", () => {
  let service: ImportEntityCreatorService;
  let queryRunner: {
    manager: Record<string, jest.Mock>;
  };
  let importResult: ImportResultDto;

  const userId = "user-123";

  function makeImportResult(): ImportResultDto {
    return {
      imported: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      createdMappings: {
        categories: {},
        accounts: {},
        loans: {},
        securities: {},
      },
    };
  }

  function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
      id: "acc-1",
      accountType: AccountType.CHEQUING,
      name: "Test Account",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 0,
      ...overrides,
    } as Account;
  }

  beforeEach(() => {
    queryRunner = {
      manager: {
        findOne: jest.fn(),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
        })),
        save: jest.fn().mockImplementation((data) => ({
          ...data,
          id: data.id || `generated-${Math.random().toString(36).slice(2, 8)}`,
        })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    importResult = makeImportResult();
    service = new ImportEntityCreatorService();
  });

  describe("createCategories", () => {
    it("should create a new category when it does not exist", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      const savedCat = { id: "cat-new-1", name: "Groceries", userId };
      queryRunner.manager.save.mockResolvedValue(savedCat);

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Groceries", createNew: "Groceries" },
      ];

      await service.createCategories(
        queryRunner,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(queryRunner.manager.findOne).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({
          where: expect.objectContaining({ userId, name: "Groceries" }),
        }),
      );
      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({
          userId,
          name: "Groceries",
          parentId: null,
          isIncome: false,
        }),
      );
      expect(categoryMap.get("Groceries")).toBe("cat-new-1");
      expect(importResult.categoriesCreated).toBe(1);
      expect(importResult.createdMappings!.categories["Groceries"]).toBe(
        "cat-new-1",
      );
    });

    it("should reuse existing category when found in database", async () => {
      const existingCat = { id: "cat-existing", name: "Food", userId };
      queryRunner.manager.findOne.mockResolvedValue(existingCat);

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Food", createNew: "Food" },
      ];

      await service.createCategories(
        queryRunner,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(categoryMap.get("Food")).toBe("cat-existing");
      expect(importResult.categoriesCreated).toBe(0);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("should deduplicate categories with the same name and parent", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      const savedCat = { id: "cat-once", name: "Transport", userId };
      queryRunner.manager.save.mockResolvedValue(savedCat);

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Transport-1", createNew: "Transport" },
        { originalName: "Transport-2", createNew: "Transport" },
      ];

      await service.createCategories(
        queryRunner,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(categoryMap.get("Transport-1")).toBe("cat-once");
      expect(categoryMap.get("Transport-2")).toBe("cat-once");
      expect(importResult.categoriesCreated).toBe(1);
    });

    it("should create categories with different parents separately", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      let callCount = 0;
      queryRunner.manager.save.mockImplementation((data: any) => {
        callCount++;
        return { ...data, id: `cat-${callCount}` };
      });

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Gas:Auto",
          createNew: "Gas",
          parentCategoryId: "parent-auto",
        },
        {
          originalName: "Gas:Home",
          createNew: "Gas",
          parentCategoryId: "parent-home",
        },
      ];

      await service.createCategories(
        queryRunner,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(queryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(categoryMap.get("Gas:Auto")).toBe("cat-1");
      expect(categoryMap.get("Gas:Home")).toBe("cat-2");
      expect(importResult.categoriesCreated).toBe(2);
    });
  });

  describe("createAccounts", () => {
    const account = makeAccount();

    it("should create a regular (non-investment) account", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      const savedAcc = { id: "acc-new-1", name: "Savings", userId };
      queryRunner.manager.save.mockResolvedValue(savedAcc);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Savings",
          createNew: "Savings",
          accountType: "SAVINGS",
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({
          userId,
          name: "Savings",
          accountType: "SAVINGS",
          currencyCode: "CAD",
          openingBalance: 0,
          currentBalance: 0,
        }),
      );
      expect(accountMap.get("Savings")).toBe("acc-new-1");
      expect(importResult.accountsCreated).toBe(1);
    });

    it("should create investment account pair (cash + brokerage)", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      let saveCount = 0;
      queryRunner.manager.save.mockImplementation((data: any) => {
        saveCount++;
        return { ...data, id: `inv-${saveCount}` };
      });

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "MyBrokerage",
          createNew: "MyBrokerage",
          accountType: AccountType.INVESTMENT,
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      // Should create cash account first, then brokerage, then update cash
      expect(queryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(3);
      expect(importResult.accountsCreated).toBe(2);
      // accountMap should point to the cash account id
      expect(accountMap.get("MyBrokerage")).toBe("inv-1");
    });

    it("should reuse existing account by name", async () => {
      const existingAccount = {
        id: "existing-acc",
        name: "Checking",
        accountSubType: null,
      };
      queryRunner.manager.findOne.mockResolvedValue(existingAccount);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Checking",
          createNew: "Checking",
          accountType: "CHEQUING",
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(accountMap.get("Checking")).toBe("existing-acc");
      expect(importResult.accountsCreated).toBe(0);
    });

    it("should use linkedAccountId when existing account is INVESTMENT_BROKERAGE", async () => {
      const existingBrokerage = {
        id: "brokerage-acc",
        name: "Invest - Brokerage",
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: "linked-cash-acc",
      };
      queryRunner.manager.findOne.mockResolvedValue(existingBrokerage);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Invest",
          createNew: "Invest",
          accountType: AccountType.INVESTMENT,
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(accountMap.get("Invest")).toBe("linked-cash-acc");
    });

    it("should deduplicate accounts with the same name", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      const savedAcc = { id: "acc-dedup", name: "Joint", userId };
      queryRunner.manager.save.mockResolvedValue(savedAcc);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Joint-1",
          createNew: "Joint",
          accountType: "CHEQUING",
        },
        {
          originalName: "Joint-2",
          createNew: "Joint",
          accountType: "CHEQUING",
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(accountMap.get("Joint-1")).toBe("acc-dedup");
      expect(accountMap.get("Joint-2")).toBe("acc-dedup");
    });

    it("should use account currencyCode when mapping has no currencyCode", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "acc-curr",
      }));

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "NoCurrency",
          createNew: "NoCurrency",
          accountType: "SAVINGS",
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ currencyCode: "CAD" }),
      );
    });

    it("should use mapping currencyCode when provided", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "acc-usd",
      }));

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "USDAccount",
          createNew: "USDAccount",
          accountType: "SAVINGS",
          currencyCode: "USD",
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ currencyCode: "USD" }),
      );
    });

    it("should default accountType to CHEQUING when not provided", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "acc-default",
      }));

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        { originalName: "NoType", createNew: "NoType" },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ accountType: "CHEQUING" }),
      );
    });

    it("should try name + ' - Cash' for investment accounts not found by name", async () => {
      // First findOne (by name) returns null, second (by name + " - Cash") returns match
      queryRunner.manager.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "cash-acc-found",
          name: "Invest - Cash",
          accountSubType: AccountSubType.INVESTMENT_CASH,
        });

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Invest",
          createNew: "Invest",
          accountType: AccountType.INVESTMENT,
        },
      ];

      await service.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.findOne).toHaveBeenCalledWith(Account, {
        where: { userId, name: "Invest - Cash" },
      });
      expect(accountMap.get("Invest")).toBe("cash-acc-found");
    });
  });

  describe("createLoanAccounts", () => {
    const account = makeAccount();

    it("should create a new loan account", async () => {
      const savedLoan = { id: "loan-1" };
      queryRunner.manager.save.mockResolvedValue(savedLoan);

      const loanCategoryMap = new Map<string, string>();
      const loanAccountsToCreate: CategoryMappingDto[] = [
        {
          originalName: "Car Loan",
          createNewLoan: "Car Loan Account",
          newLoanAmount: 25000,
          newLoanInstitution: "Bank ABC",
        },
      ];

      await service.createLoanAccounts(
        queryRunner,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({
          userId,
          name: "Car Loan Account",
          accountType: AccountType.LOAN,
          currencyCode: "CAD",
          institution: "Bank ABC",
          openingBalance: -25000,
          currentBalance: -25000,
        }),
      );
      expect(loanCategoryMap.get("Car Loan")).toBe("loan-1");
      expect(importResult.accountsCreated).toBe(1);
      expect(importResult.createdMappings!.loans["Car Loan"]).toBe("loan-1");
    });

    it("should default loan amount to 0 when not provided", async () => {
      const savedLoan = { id: "loan-zero" };
      queryRunner.manager.save.mockResolvedValue(savedLoan);

      const loanCategoryMap = new Map<string, string>();
      const loanAccountsToCreate: CategoryMappingDto[] = [
        {
          originalName: "Loan",
          createNewLoan: "No Amount Loan",
        },
      ];

      await service.createLoanAccounts(
        queryRunner,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      // Loan amounts get negated: -undefined → NaN is not the case;
      // when loanAmount is undefined, the code uses -loanAmount which gives -0
      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({
          openingBalance: -0,
          currentBalance: -0,
          institution: null,
        }),
      );
    });
  });

  describe("createSecurities", () => {
    const account = makeAccount();

    it("should create a new security", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      const savedSec = { id: "sec-1" };
      queryRunner.manager.save.mockResolvedValue(savedSec);

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        {
          originalName: "Apple Inc",
          createNew: "aapl",
          securityName: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
        },
      ];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      expect(securityMap.get("Apple Inc")).toBe("sec-1");
      expect(importResult.securitiesCreated).toBe(1);
      expect(importResult.createdMappings!.securities["Apple Inc"]).toBe(
        "sec-1",
      );
    });

    it("should uppercase the symbol on creation", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-upper",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [{ originalName: "test", createNew: "msft" }];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      // The findOne should look for uppercase symbol
      expect(queryRunner.manager.findOne).toHaveBeenCalledWith(Security, {
        where: { symbol: "MSFT", userId },
      });
    });

    it("should reuse existing security by symbol", async () => {
      const existingSec = { id: "sec-existing", symbol: "GOOG" };
      queryRunner.manager.findOne.mockResolvedValue(existingSec);

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        { originalName: "Google", createNew: "GOOG" },
      ];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      expect(securityMap.get("Google")).toBe("sec-existing");
      expect(importResult.securitiesCreated).toBe(0);
    });

    it("should skip when createNew is falsy", async () => {
      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [{ originalName: "Nothing", createNew: "" }];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      expect(queryRunner.manager.findOne).not.toHaveBeenCalled();
      expect(importResult.securitiesCreated).toBe(0);
    });

    it("should use exchange-derived currency when securityMapping has no currencyCode", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-tsx",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        {
          originalName: "Royal Bank",
          createNew: "RY",
          exchange: "TSX",
        },
      ];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      const savedArg = queryRunner.manager.save.mock.calls[0][0];
      expect(savedArg.currencyCode).toBe("CAD");
    });

    it("should fall back to account currency when no exchange or currencyCode", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-fallback",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        { originalName: "Mystery", createNew: "MYS" },
      ];

      const usdAccount = makeAccount({ currencyCode: "USD" });

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        usdAccount,
        importResult,
      );

      const savedArg = queryRunner.manager.save.mock.calls[0][0];
      expect(savedArg.currencyCode).toBe("USD");
    });

    it("should use explicit currencyCode from mapping over exchange-derived", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      queryRunner.manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-explicit",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        {
          originalName: "Euro Stock",
          createNew: "EU1",
          exchange: "NYSE",
          currencyCode: "EUR",
        },
      ];

      await service.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      const savedArg = queryRunner.manager.save.mock.calls[0][0];
      expect(savedArg.currencyCode).toBe("EUR");
    });
  });

  describe("applyOpeningBalance", () => {
    it("should update account balances correctly", async () => {
      const account = makeAccount({
        openingBalance: 100,
        currentBalance: 500,
      } as any);

      await service.applyOpeningBalance(queryRunner, "acc-1", account, 250);

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        Account,
        "acc-1",
        {
          openingBalance: 250,
          currentBalance: 650,
        },
      );
    });

    it("should handle zero opening balance", async () => {
      const account = makeAccount({
        openingBalance: 0,
        currentBalance: 300,
      } as any);

      await service.applyOpeningBalance(queryRunner, "acc-1", account, 100);

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        Account,
        "acc-1",
        {
          openingBalance: 100,
          currentBalance: 400,
        },
      );
    });

    it("should handle negative opening balance", async () => {
      const account = makeAccount({
        openingBalance: 0,
        currentBalance: 1000,
      } as any);

      await service.applyOpeningBalance(queryRunner, "acc-1", account, -500);

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        Account,
        "acc-1",
        {
          openingBalance: -500,
          currentBalance: 500,
        },
      );
    });

    it("should round to two decimal places", async () => {
      const account = makeAccount({
        openingBalance: 0,
        currentBalance: 0,
      } as any);

      await service.applyOpeningBalance(queryRunner, "acc-1", account, 100.555);

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        Account,
        "acc-1",
        {
          openingBalance: 100.56,
          currentBalance: 100.56,
        },
      );
    });
  });
});
