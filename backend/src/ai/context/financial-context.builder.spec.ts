import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { FinancialContextBuilder } from "./financial-context.builder";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { QUERY_SYSTEM_PROMPT } from "./prompt-templates";
import { requestContextStorage } from "../../common/request-context";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

describe("FinancialContextBuilder", () => {
  let builder: FinancialContextBuilder;
  let mockAccountsService: Record<string, jest.Mock>;
  let mockCategoriesService: Record<string, jest.Mock>;
  let mockPrefRepo: Record<string, jest.Mock>;

  const userId = "user-1";

  const mockAccounts = [
    {
      name: "Checking",
      accountType: "checking",
      currencyCode: "USD",
      currentBalance: "5000.00",
    },
    {
      name: "Credit Card",
      accountType: "credit_card",
      currencyCode: "USD",
      currentBalance: "-1200.50",
    },
    {
      name: "Savings",
      accountType: "savings",
      currencyCode: "CAD",
      currentBalance: "15000.75",
    },
  ];

  const mockCategoryTree = [
    {
      id: "cat-1",
      name: "Food",
      categoryType: "expense",
      children: [
        {
          id: "cat-1a",
          name: "Groceries",
          categoryType: "expense",
          children: [],
        },
        {
          id: "cat-1b",
          name: "Dining Out",
          categoryType: "expense",
          children: [],
        },
      ],
    },
    {
      id: "cat-2",
      name: "Salary",
      categoryType: "income",
      children: [],
    },
  ];

  beforeEach(async () => {
    mockAccountsService = {
      findAll: jest.fn().mockResolvedValue(mockAccounts),
    };

    mockCategoriesService = {
      getTree: jest.fn().mockResolvedValue(mockCategoryTree),
    };

    mockPrefRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    const scoped = createScopedDbMocks([[UserPreference, mockPrefRepo]]);
    // The user's timezone lookup behind "today": no row, so UTC.
    scoped.manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinancialContextBuilder,
        { provide: AccountsService, useValue: mockAccountsService },
        { provide: CategoriesService, useValue: mockCategoriesService },
        {
          provide: DataSource,
          useValue: scoped.dataSource,
        },
      ],
    }).compile();

    builder = module.get<FinancialContextBuilder>(FinancialContextBuilder);
  });

  describe("buildQueryContext()", () => {
    it("states today in the user's day, not the server's (#2365)", async () => {
      // 12:00 UTC on 2026-11-27 is already 2026-11-28 in Kiritimati.
      jest.useFakeTimers({ now: new Date("2026-11-27T12:00:00Z") });
      try {
        const result = await requestContextStorage.run(
          { userId, timezone: "Pacific/Kiritimati" },
          () => builder.buildQueryContext(userId),
        );
        expect(result).toContain("TODAY'S DATE: 2026-11-28");
      } finally {
        jest.useRealTimers();
      }
    });

    it("builds full context with accounts (no balances), categories, and preferences", async () => {
      const result = await builder.buildQueryContext(userId);

      expect(result).toContain(QUERY_SYSTEM_PROMPT);
      expect(result).toContain("USER'S DEFAULT CURRENCY: USD");
      // LLM06-F1: Accounts should include name and type but NOT balances
      expect(result).toContain("Checking (checking, USD)");
      expect(result).toContain("Credit Card (credit_card, USD)");
      expect(result).toContain("Savings (savings, CAD)");
      // Balances should NOT be in the system prompt
      expect(result).not.toContain("5,000.00");
      expect(result).not.toContain("-1,200.50");
      expect(result).not.toContain("15,000.75");
      expect(result).not.toContain("balance:");
      expect(result).toContain("Food [Expense]");
      expect(result).toContain("Groceries [Expense]");
      expect(result).toContain("Dining Out [Expense]");
      expect(result).toContain("Salary [Income]");
    });

    it("wraps user data in USER_DATA delimiters", async () => {
      const result = await builder.buildQueryContext(userId);
      expect(result).toContain("<USER_DATA>");
      expect(result).toContain("</USER_DATA>");
    });

    it("instructs to use list_accounts tool for balances", async () => {
      const result = await builder.buildQueryContext(userId);
      expect(result).toContain("list_accounts");
    });

    it("includes today's date", async () => {
      const result = await builder.buildQueryContext(userId);
      const today = new Date().toISOString().substring(0, 10);
      expect(result).toContain(`TODAY'S DATE: ${today}`);
    });

    it("defaults to USD when no preferences found", async () => {
      mockPrefRepo.findOne.mockResolvedValue(null);

      const result = await builder.buildQueryContext(userId);

      expect(result).toContain("USER'S DEFAULT CURRENCY: USD");
    });

    it("shows placeholder when no accounts configured", async () => {
      mockAccountsService.findAll.mockResolvedValue([]);

      const result = await builder.buildQueryContext(userId);

      expect(result).toContain("(No accounts configured)");
    });

    it("shows placeholder when no categories configured", async () => {
      mockCategoriesService.getTree.mockResolvedValue([]);

      const result = await builder.buildQueryContext(userId);

      expect(result).toContain("(No categories configured)");
    });

    it("fetches accounts, categories, and preferences in parallel", async () => {
      await builder.buildQueryContext(userId);

      expect(mockAccountsService.findAll).toHaveBeenCalledWith(userId, false);
      expect(mockCategoriesService.getTree).toHaveBeenCalledWith(userId);
      expect(mockPrefRepo.findOne).toHaveBeenCalledWith({
        where: { userId },
      });
    });

    it("formats nested categories with indentation", async () => {
      const result = await builder.buildQueryContext(userId);

      // Top-level categories have no indent
      expect(result).toMatch(/^- Food \[Expense\]/m);
      // Child categories have 2-space indent
      expect(result).toMatch(/^ {2}- Groceries \[Expense\]/m);
      expect(result).toMatch(/^ {2}- Dining Out \[Expense\]/m);
    });
  });

  describe("buildCategoryContext()", () => {
    it("returns formatted category tree", async () => {
      const result = await builder.buildCategoryContext(userId);

      expect(result).toContain("Food [Expense]");
      expect(result).toContain("Salary [Income]");
      expect(mockCategoriesService.getTree).toHaveBeenCalledWith(userId);
    });
  });

  describe("buildTransactionContext()", () => {
    it("returns formatted category tree", async () => {
      const result = await builder.buildTransactionContext(userId, "PayeeName");

      expect(result).toContain("Food [Expense]");
      expect(mockCategoriesService.getTree).toHaveBeenCalledWith(userId);
    });
  });
});
