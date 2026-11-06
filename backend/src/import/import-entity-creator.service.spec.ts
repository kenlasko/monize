import { ImportEntityCreatorService } from "./import-entity-creator.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Security } from "../securities/entities/security.entity";
import { currencyKindRows } from "../test-helpers/currency-kind-testing";
import { ImportResultDto, CategoryMappingDto } from "./dto/import.dto";

describe("ImportEntityCreatorService", () => {
  /** SQL of each category insert, so a test can count creations. */
  let insertedCategories: string[];
  /** Ids the next category inserts should return, in order. */
  let categoryIdQueue: string[];
  let service: ImportEntityCreatorService;
  let manager: Record<string, jest.Mock>;
  let importResult: ImportResultDto;

  const userId = "user-123";

  function makeImportResult(): ImportResultDto {
    return {
      imported: 0,
      skipped: 0,
      skippedRows: [],
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
    manager = {
      getRepository: jest.fn(() => {
        throw new Error("unexpected repository");
      }),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((_entity, data) => ({
        ...data,
      })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || `generated-${Math.random().toString(36).slice(2, 8)}`,
      })),
      update: jest.fn().mockResolvedValue(undefined),
      // Categories are created with `INSERT ... ON CONFLICT DO NOTHING RETURNING
      // id` so a lost race adopts the existing row instead of aborting the whole
      // import transaction. Default to winning; the loser path is asserted below.
      // The `currencies` kind read (INV-CRYPTO-001) answers BTC as a coin.
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        const kindRows = currencyKindRows(sql, params);
        if (kindRows) return kindRows;
        if (
          typeof sql !== "string" ||
          !sql.includes("INSERT INTO categories")
        ) {
          return [];
        }
        insertedCategories.push(sql);
        return [
          {
            id:
              categoryIdQueue.shift() ??
              `generated-${insertedCategories.length}`,
          },
        ];
      }),
    };
    insertedCategories = [];
    categoryIdQueue = [];
    importResult = makeImportResult();
    service = new ImportEntityCreatorService();
  });

  describe("createCategories", () => {
    it("should create a new category when it does not exist", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("cat-new-1");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Groceries", createNew: "Groceries" },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(manager.findOne).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({
          where: expect.objectContaining({ userId, name: "Groceries" }),
        }),
      );
      const insert = manager.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO categories"),
      )!;
      // One guarded statement rather than create-then-save, so the values live
      // in its parameters. `ON CONFLICT DO NOTHING` is what stops a lost race
      // aborting the whole import transaction.
      expect(String(insert[0])).toContain("ON CONFLICT DO NOTHING");
      expect(insert[1]).toEqual([userId, "Groceries", null]);
      expect(categoryMap.get("Groceries")).toBe("cat-new-1");
      expect(importResult.categoriesCreated).toBe(1);
      expect(importResult.createdMappings!.categories["Groceries"]).toBe(
        "cat-new-1",
      );
    });

    it("adopts an existing category when the insert loses the race", async () => {
      // An import runs as one long transaction, so a unique violation here does
      // not merely fail this row -- it aborts the entire import. A user creating
      // "Groceries" by hand while their CSV import is running was enough to lose
      // the whole thing. The insert is allowed to lose and adopt what is there.
      manager.findOne.mockImplementation(async (_entity: unknown, opts: any) =>
        opts?.where?.name === "Groceries"
          ? null // nothing when we first looked...
          : null,
      );
      manager.query.mockImplementation(async (sql: string) =>
        typeof sql === "string" && sql.includes("INSERT INTO categories")
          ? [] // ...but somebody created it before our insert landed
          : [],
      );
      // The post-conflict read finds theirs.
      manager.findOne.mockResolvedValue({ id: "theirs", name: "Groceries" });

      const categoryMap = new Map<string, string | null>();

      await service.createCategories(
        manager as any,
        userId,
        [{ originalName: "Groceries", createNew: "Groceries" }],
        categoryMap,
        importResult,
      );

      expect(categoryMap.get("Groceries")).toBe("theirs");
      // Not counted as created -- somebody else created it.
      expect(importResult.categoriesCreated).toBe(0);
    });

    it("fails loudly if the insert conflicts and no row can be found", async () => {
      // The only way that happens is a genuine fault, and inventing a category id
      // to carry on with would attach imported transactions to nothing.
      manager.findOne.mockResolvedValue(null);
      manager.query.mockImplementation(async () => []);

      await expect(
        service.createCategories(
          manager as any,
          userId,
          [{ originalName: "Groceries", createNew: "Groceries" }],
          new Map<string, string | null>(),
          importResult,
        ),
      ).rejects.toThrow(/conflicted but no matching row exists/);
    });

    it("should reuse existing category when found in database", async () => {
      const existingCat = { id: "cat-existing", name: "Food", userId };
      manager.findOne.mockResolvedValue(existingCat);

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Food", createNew: "Food" },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(categoryMap.get("Food")).toBe("cat-existing");
      expect(importResult.categoriesCreated).toBe(0);
      expect(insertedCategories).toHaveLength(0);
    });

    it("should deduplicate categories with the same name and parent", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("cat-once");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        { originalName: "Transport-1", createNew: "Transport" },
        { originalName: "Transport-2", createNew: "Transport" },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(insertedCategories).toHaveLength(1);
      expect(categoryMap.get("Transport-1")).toBe("cat-once");
      expect(categoryMap.get("Transport-2")).toBe("cat-once");
      expect(importResult.categoriesCreated).toBe(1);
    });

    it("should create new parent category when createNewParentCategoryName is provided", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("cat-1", "cat-2");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Fees & Charges:Bank Fee",
          createNew: "Bank Fee",
          createNewParentCategoryName: "Fees & Charges",
        },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      // Should create parent first (cat-1), then child (cat-2)
      expect(insertedCategories).toHaveLength(2);
      const parentInsert = manager.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO categories"),
      )!;
      expect(parentInsert[1]).toEqual([userId, "Fees & Charges", null]);
      const inserts = manager.query.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO categories"),
      );
      // Parent first, then the child pointing at it.
      expect(inserts[0][1]).toEqual([userId, "Fees & Charges", null]);
      expect(inserts[1][1]).toEqual([userId, "Bank Fee", "cat-1"]);
      expect(categoryMap.get("Fees & Charges:Bank Fee")).toBe("cat-2");
      expect(importResult.categoriesCreated).toBe(2);
    });

    it("should reuse existing parent when createNewParentCategoryName matches", async () => {
      const existingParent = {
        id: "parent-existing",
        name: "Bills & Utilities",
        userId,
      };
      manager.findOne.mockImplementation((_entity: any, opts: any) => {
        if (
          opts?.where?.name === "Bills & Utilities" &&
          opts?.where?.parentId
        ) {
          return Promise.resolve(existingParent);
        }
        return Promise.resolve(null);
      });
      categoryIdQueue.push("child-new");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Bills & Utilities:Electricity",
          createNew: "Electricity",
          createNewParentCategoryName: "Bills & Utilities",
        },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      // Only child should be created; parent already exists
      expect(insertedCategories).toHaveLength(1);
      expect(categoryMap.get("Bills & Utilities:Electricity")).toBe(
        "child-new",
      );
      expect(importResult.categoriesCreated).toBe(1);
    });

    it("should reuse same new parent for multiple children", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("cat-1", "cat-2", "cat-3");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Taxes:Income Tax",
          createNew: "Income Tax",
          createNewParentCategoryName: "Taxes",
        },
        {
          originalName: "Taxes:CPP",
          createNew: "CPP",
          createNewParentCategoryName: "Taxes",
        },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      // Parent created once (cat-1), two children (cat-2, cat-3)
      expect(insertedCategories).toHaveLength(3);
      expect(importResult.categoriesCreated).toBe(3);
      expect(categoryMap.get("Taxes:Income Tax")).toBe("cat-2");
      expect(categoryMap.get("Taxes:CPP")).toBe("cat-3");
    });

    it("creates every level of a colon-delimited parent path", async () => {
      // A three-level QIF category ("Housing:Mortgage:Interest") used to land
      // as a top-level category literally named "Housing:Mortgage".
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("housing", "mortgage", "interest", "principal");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Housing:Mortgage:Interest",
          createNew: "Interest",
          createNewParentCategoryName: "Housing:Mortgage",
        },
        {
          originalName: "Housing:Mortgage:Principal",
          createNew: "Principal",
          createNewParentCategoryName: "Housing: Mortgage",
        },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      const inserts = manager.query.mock.calls
        .filter((call: unknown[]) =>
          String(call[0]).includes("INSERT INTO categories"),
        )
        .map((call: unknown[]) => call[1]);
      expect(inserts).toEqual([
        [userId, "Housing", null],
        [userId, "Mortgage", "housing"],
        [userId, "Interest", "mortgage"],
        [userId, "Principal", "mortgage"],
      ]);
      expect(categoryMap.get("Housing:Mortgage:Interest")).toBe("interest");
      expect(categoryMap.get("Housing:Mortgage:Principal")).toBe("principal");
      expect(importResult.categoriesCreated).toBe(4);
    });

    it("reuses the existing levels of a parent path and creates the rest", async () => {
      manager.findOne.mockImplementation((_entity: any, opts: any) => {
        const where = opts?.where ?? {};
        if (where.name === "Housing" && typeof where.parentId !== "string") {
          return Promise.resolve({ id: "housing-existing", name: "Housing" });
        }
        return Promise.resolve(null);
      });
      categoryIdQueue.push("mortgage-new", "interest-new");

      const categoryMap = new Map<string, string | null>();
      await service.createCategories(
        manager as any,
        userId,
        [
          {
            originalName: "Housing:Mortgage:Interest",
            createNew: "Interest",
            createNewParentCategoryName: "Housing:Mortgage",
          },
        ],
        categoryMap,
        importResult,
      );

      const inserts = manager.query.mock.calls
        .filter((call: unknown[]) =>
          String(call[0]).includes("INSERT INTO categories"),
        )
        .map((call: unknown[]) => call[1]);
      expect(inserts).toEqual([
        [userId, "Mortgage", "housing-existing"],
        [userId, "Interest", "mortgage-new"],
      ]);
      expect(categoryMap.get("Housing:Mortgage:Interest")).toBe("interest-new");
      expect(importResult.categoriesCreated).toBe(2);
    });

    it("should prefer parentCategoryId over createNewParentCategoryName", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("child-id");

      const categoryMap = new Map<string, string | null>();
      const categoriesToCreate: CategoryMappingDto[] = [
        {
          originalName: "Test:Sub",
          createNew: "Sub",
          parentCategoryId: "existing-parent-id",
          createNewParentCategoryName: "Test",
        },
      ];

      await service.createCategories(
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      // Should use parentCategoryId, not create a new parent
      const subInsert = manager.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO categories"),
      )!;
      expect(subInsert[1]).toEqual([userId, "Sub", "existing-parent-id"]);
      expect(insertedCategories).toHaveLength(1);
    });

    it("should create categories with different parents separately", async () => {
      manager.findOne.mockResolvedValue(null);
      categoryIdQueue.push("cat-1", "cat-2");

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
        manager as any,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );

      expect(insertedCategories).toHaveLength(2);
      expect(categoryMap.get("Gas:Auto")).toBe("cat-1");
      expect(categoryMap.get("Gas:Home")).toBe("cat-2");
      expect(importResult.categoriesCreated).toBe(2);
    });
  });

  describe("createAccounts", () => {
    const account = makeAccount();

    it.each([
      ["a CRYPTO account in CAD", "CRYPTO", "CAD"],
      ["a CHEQUING account in BTC", "CHEQUING", "BTC"],
      ["an INVESTMENT pair in BTC", "INVESTMENT", "BTC"],
    ])(
      "refuses %s before writing it (INV-CRYPTO-001)",
      async (_label, accountType, currencyCode) => {
        manager.findOne.mockResolvedValue(null);
        await expect(
          service.createAccounts(
            manager as any,
            userId,
            [
              {
                originalName: "Wallet",
                createNew: "Wallet",
                accountType,
                currencyCode,
              },
            ],
            new Map(),
            account,
            importResult,
          ),
        ).rejects.toThrow(/currency, which a .* account cannot hold/);
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it("creates a CRYPTO account in BTC", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockResolvedValue({ id: "wallet-1" });
      const accountMap = new Map<string, string | null>();
      await service.createAccounts(
        manager as any,
        userId,
        [
          {
            originalName: "Wallet",
            createNew: "Wallet",
            accountType: "CRYPTO",
            currencyCode: "BTC",
          },
        ],
        accountMap,
        account,
        importResult,
      );
      expect(accountMap.get("Wallet")).toBe("wallet-1");
    });

    it("should create a regular (non-investment) account", async () => {
      manager.findOne.mockResolvedValue(null);
      const savedAcc = { id: "acc-new-1", name: "Savings", userId };
      manager.save.mockResolvedValue(savedAcc);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Savings",
          createNew: "Savings",
          accountType: "SAVINGS",
        },
      ];

      await service.createAccounts(
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
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
      manager.findOne.mockResolvedValue(null);
      let saveCount = 0;
      manager.save.mockImplementation((data: any) => {
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
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      // Should create cash account first, then brokerage, then update cash
      expect(manager.create).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(3);
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
      manager.findOne.mockResolvedValue(existingAccount);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Checking",
          createNew: "Checking",
          accountType: "CHEQUING",
        },
      ];

      await service.createAccounts(
        manager as any,
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
      manager.findOne.mockResolvedValue(existingBrokerage);

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        {
          originalName: "Invest",
          createNew: "Invest",
          accountType: AccountType.INVESTMENT,
        },
      ];

      await service.createAccounts(
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(accountMap.get("Invest")).toBe("linked-cash-acc");
    });

    it("should deduplicate accounts with the same name", async () => {
      manager.findOne.mockResolvedValue(null);
      const savedAcc = { id: "acc-dedup", name: "Joint", userId };
      manager.save.mockResolvedValue(savedAcc);

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
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(accountMap.get("Joint-1")).toBe("acc-dedup");
      expect(accountMap.get("Joint-2")).toBe("acc-dedup");
    });

    it("should use account currencyCode when mapping has no currencyCode", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
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
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ currencyCode: "CAD" }),
      );
    });

    it("should use mapping currencyCode when provided", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
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
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ currencyCode: "USD" }),
      );
    });

    it("should default accountType to CHEQUING when not provided", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "acc-default",
      }));

      const accountMap = new Map<string, string | null>();
      const accountsToCreate = [
        { originalName: "NoType", createNew: "NoType" },
      ];

      await service.createAccounts(
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({ accountType: "CHEQUING" }),
      );
    });

    it("should try name + ' - Cash' for investment accounts not found by name", async () => {
      // First findOne (by name) returns null, second (by name + " - Cash") returns match
      manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
        manager as any,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );

      expect(manager.findOne).toHaveBeenCalledWith(Account, {
        where: { userId, name: "Invest - Cash" },
      });
      expect(accountMap.get("Invest")).toBe("cash-acc-found");
    });
  });

  describe("createLoanAccounts", () => {
    const account = makeAccount();

    it("refuses a loan created from a BTC account's import before writing it (INV-CRYPTO-001)", async () => {
      await expect(
        service.createLoanAccounts(
          manager as any,
          userId,
          [{ originalName: "Car loan", createNewLoan: "Car loan" } as any],
          new Map(),
          makeAccount({ accountType: AccountType.CRYPTO, currencyCode: "BTC" }),
          importResult,
        ),
      ).rejects.toThrow(/BTC is a CRYPTO currency, which a LOAN account/);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("should create a new loan account", async () => {
      const savedLoan = { id: "loan-1" };
      manager.save.mockResolvedValue(savedLoan);

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
        manager as any,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
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

    it("should create a mortgage account when newLoanType is MORTGAGE", async () => {
      const savedLoan = { id: "mortgage-1" };
      manager.save.mockResolvedValue(savedLoan);

      const loanCategoryMap = new Map<string, string>();
      const loanAccountsToCreate: CategoryMappingDto[] = [
        {
          originalName: "Mortgage Payment",
          createNewLoan: "Home Mortgage",
          newLoanType: "MORTGAGE",
          newLoanAmount: 350000,
          newLoanInstitution: "Bank XYZ",
        },
      ];

      await service.createLoanAccounts(
        manager as any,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({
          userId,
          name: "Home Mortgage",
          accountType: AccountType.MORTGAGE,
          currencyCode: "CAD",
          institution: "Bank XYZ",
          openingBalance: -350000,
          currentBalance: -350000,
        }),
      );
      expect(loanCategoryMap.get("Mortgage Payment")).toBe("mortgage-1");
      expect(importResult.accountsCreated).toBe(1);
    });

    it("should default to LOAN type when newLoanType is not provided", async () => {
      const savedLoan = { id: "loan-default" };
      manager.save.mockResolvedValue(savedLoan);

      const loanCategoryMap = new Map<string, string>();
      const loanAccountsToCreate: CategoryMappingDto[] = [
        {
          originalName: "Car Loan",
          createNewLoan: "Car Loan Account",
          newLoanAmount: 20000,
        },
      ];

      await service.createLoanAccounts(
        manager as any,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      expect(manager.create).toHaveBeenCalledWith(
        Account,
        expect.objectContaining({
          accountType: AccountType.LOAN,
        }),
      );
    });

    it("should default loan amount to 0 when not provided", async () => {
      const savedLoan = { id: "loan-zero" };
      manager.save.mockResolvedValue(savedLoan);

      const loanCategoryMap = new Map<string, string>();
      const loanAccountsToCreate: CategoryMappingDto[] = [
        {
          originalName: "Loan",
          createNewLoan: "No Amount Loan",
        },
      ];

      await service.createLoanAccounts(
        manager as any,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );

      // Loan amounts get negated: -undefined → NaN is not the case;
      // when loanAmount is undefined, the code uses -loanAmount which gives -0
      expect(manager.create).toHaveBeenCalledWith(
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

    it("refuses a security in a CRYPTO currency before writing it (INV-CRYPTO-001)", async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.createSecurities(
          manager as any,
          userId,
          [
            {
              originalName: "Bitcoin",
              createNew: "BTC-CAD",
              securityName: "Bitcoin",
              securityType: "CRYPTO",
              currencyCode: "BTC",
            },
          ],
          new Map(),
          account,
          importResult,
        ),
      ).rejects.toThrow(/BTC is a cryptocurrency/);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("should create a new security", async () => {
      manager.findOne.mockResolvedValue(null);
      const savedSec = { id: "sec-1" };
      manager.save.mockResolvedValue(savedSec);

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
        manager as any,
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
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-upper",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [{ originalName: "test", createNew: "msft" }];

      await service.createSecurities(
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      // The findOne should look for uppercase symbol
      expect(manager.findOne).toHaveBeenCalledWith(Security, {
        where: { symbol: "MSFT", userId },
      });
    });

    it("should reuse existing security by symbol", async () => {
      const existingSec = { id: "sec-existing", symbol: "GOOG" };
      manager.findOne.mockResolvedValue(existingSec);

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        { originalName: "Google", createNew: "GOOG" },
      ];

      await service.createSecurities(
        manager as any,
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
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      expect(manager.findOne).not.toHaveBeenCalled();
      expect(importResult.securitiesCreated).toBe(0);
    });

    it("should use exchange-derived currency when securityMapping has no currencyCode", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
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
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      const savedArg = manager.save.mock.calls[0][0];
      expect(savedArg.currencyCode).toBe("CAD");
    });

    it("should fall back to account currency when no exchange or currencyCode", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-fallback",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        { originalName: "Mystery", createNew: "MYS" },
      ];

      const usdAccount = makeAccount({ currencyCode: "USD" });

      await service.createSecurities(
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        usdAccount,
        importResult,
      );

      const savedArg = manager.save.mock.calls[0][0];
      expect(savedArg.currencyCode).toBe("USD");
    });

    it("should use exchange-derived currency over explicit currencyCode from mapping", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
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
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      const savedArg = manager.save.mock.calls[0][0];
      // NYSE maps to USD, which takes priority over the stale EUR from the mapping
      expect(savedArg.currencyCode).toBe("USD");
    });

    it("should fall back to mapping currencyCode when exchange is not in the map", async () => {
      manager.findOne.mockResolvedValue(null);
      manager.save.mockImplementation((data: any) => ({
        ...data,
        id: "sec-unknown-exchange",
      }));

      const securityMap = new Map<string, string | null>();
      const securitiesToCreate = [
        {
          originalName: "Exotic Stock",
          createNew: "EX1",
          exchange: "JSE",
          currencyCode: "ZAR",
        },
      ];

      await service.createSecurities(
        manager as any,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      const savedArg = manager.save.mock.calls[0][0];
      // JSE is not in EXCHANGE_CURRENCY_MAP, so falls back to mapping currencyCode
      expect(savedArg.currencyCode).toBe("ZAR");
    });
  });

  describe("applyOpeningBalance", () => {
    // The opening balance moves current_balance by new - old, both read under
    // the balance-write lock, as one atomic delta at 4dp; the caller's
    // `account` snapshot supplies only the owner (A26-M13).
    function lockedOpening(opening: string | null, decimalPlaces = 2) {
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT a.opening_balance")
          ? [{ opening_balance: opening, decimal_places: decimalPlaces }]
          : [],
      );
    }
    const deltaUpdate = () =>
      manager.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("SET opening_balance"),
      );

    it("moves the balance by the change from the locked opening balance, not the snapshot", async () => {
      lockedOpening("100");
      const account = makeAccount({
        userId: "user-1",
        openingBalance: 999,
        currentBalance: 999,
      } as any);

      await service.applyOpeningBalance(manager as any, "acc-1", account, 250);

      const [sql, params] = deltaUpdate();
      expect(sql).toContain(
        "current_balance = CAST(current_balance AS numeric) + $4",
      );
      expect(params).toEqual(["acc-1", "user-1", 250, 150]);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("handles a negative opening balance", async () => {
      lockedOpening("0");
      const account = makeAccount({ userId: "user-1" } as any);

      await service.applyOpeningBalance(manager as any, "acc-1", account, -500);

      expect(deltaUpdate()[1]).toEqual(["acc-1", "user-1", -500, -500]);
    });

    it("keeps four decimals", async () => {
      lockedOpening(null);
      const account = makeAccount({ userId: "user-1" } as any);

      await service.applyOpeningBalance(
        manager as any,
        "acc-1",
        account,
        100.1234,
      );

      expect(deltaUpdate()[1]).toEqual(["acc-1", "user-1", 100.1234, 100.1234]);
    });

    it("keeps a coin's eight places when the account's currency carries them", async () => {
      lockedOpening("0.00000001", 8);
      const account = makeAccount({ userId: "user-1" } as any);

      await service.applyOpeningBalance(
        manager as any,
        "acc-1",
        account,
        0.00002501,
      );

      expect(deltaUpdate()[1]).toEqual([
        "acc-1",
        "user-1",
        0.00002501,
        0.000025,
      ]);
    });
  });
});
