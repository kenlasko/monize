import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { BuiltInReportsModule } from "@/built-in-reports/built-in-reports.module";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { CategoriesModule } from "@/categories/categories.module";
import { CategoryDetailService } from "@/categories/category-detail.service";
import { withUserContext } from "@/common/db/with-context";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The read surfaces of `docs/specs/transfer-categories.md` that show a transfer
 * by its category: the Monthly Category Breakdown's Transfers group (section
 * 7), the register's grouped totals and summary (sections 5 and 9) and the
 * category detail page (section 9). A transfer holding an Income or Expense
 * category is counted exactly as before (section 5); one holding a Transfer
 * category is a named flow (INV-REPORT-003).
 */
describe("Transfer categories on the read surfaces (integration)", () => {
  jest.setTimeout(90000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let breakdown: MonthlyCategoryBreakdownService;
  let analytics: TransactionAnalyticsService;
  let detail: CategoryDetailService;

  let userId: string;
  let chequing: string;
  let hisa: string;
  let mortgage: string;
  let brokerage: string;
  let savingsCat: string;
  let mortgageCat: string;
  let investmentsCat: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      CategoriesModule,
      BuiltInReportsModule,
    ]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    breakdown = module.get(MonthlyCategoryBreakdownService, { strict: false });
    analytics = module.get(TransactionAnalyticsService, { strict: false });
    detail = module.get(CategoryDetailService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "payees",
      "categories",
      "monthly_account_balances",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    const account = async (name: string) =>
      (await createTestAccount(db, userId, { name })).id;
    chequing = await account("Chequing");
    hisa = await account("HISA");
    mortgage = await account("Mortgage");
    brokerage = await account("Brokerage");
    const category = async (name: string, type: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type)
           VALUES ($1, $2, $3) RETURNING id`,
          [userId, name, type],
        )
      )[0].id as string;
    savingsCat = await category("Savings contributions", "transfer");
    mortgageCat = await category("Mortgage", "expense");
    investmentsCat = await category("Investments", "expense");
  });

  const transfer = (
    from: string,
    to: string,
    amount: number,
    categoryId: string | null,
    date = "2026-03-10",
  ) =>
    asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: from,
        toAccountId: to,
        transactionDate: date,
        amount,
        ...(categoryId ? { categoryId } : {}),
      } as never),
    );

  describe("Monthly Category Breakdown, section 7", () => {
    beforeEach(async () => {
      await transfer(chequing, hisa, 500, savingsCat);
      await transfer(hisa, chequing, 200, savingsCat);
      await transfer(chequing, hisa, 100, null);
      await transfer(chequing, mortgage, 1500, mortgageCat);
    });

    const rowsOf = async (accountIds?: string[]) => {
      const result = await asUser(() =>
        breakdown.getMonthlyCategoryBreakdown(
          userId,
          "2026-03-01",
          "2026-03-31",
          { accountIds },
        ),
      );
      const figure = (kind: string, name: string, direction: string) =>
        result.transfers.find(
          (r) =>
            !r.isSubtotal &&
            r.kind === kind &&
            r.direction === direction &&
            (kind === "category" ? r.categoryName : r.accountName) === name,
        )?.total;
      return { result, figure };
    };

    it("lists the Transfer category's rows and the rest by account, all accounts", async () => {
      const { result, figure } = await rowsOf();
      expect(figure("category", "Savings contributions", "from")).toBe(700);
      expect(figure("category", "Savings contributions", "to")).toBe(-700);
      expect(figure("account", "Chequing", "from")).toBe(1600);
      expect(figure("account", "Chequing", "to")).toBeUndefined();
      expect(figure("account", "HISA", "from")).toBeUndefined();
      expect(figure("account", "HISA", "to")).toBe(-100);
      expect(figure("account", "Mortgage", "to")).toBe(-1500);
      expect(result.summary.transfers.total).toBe(0);
      // Never income, expenses or balance (INV-REPORT-003).
      expect(result.data).toEqual([]);
      expect(result.summary.balance.total).toBe(0);
    });

    it("counts the scope's legs only, Chequing only", async () => {
      const { result, figure } = await rowsOf([chequing]);
      expect(figure("category", "Savings contributions", "from")).toBe(500);
      expect(figure("category", "Savings contributions", "to")).toBe(-200);
      expect(figure("account", "Chequing", "from")).toBe(1600);
      expect(figure("account", "Chequing", "to")).toBeUndefined();
      expect(result.summary.transfers.total).toBe(1900);
    });

    it("lists a split's transfer line under its Transfer category", async () => {
      await asUser(() =>
        transactions.create(userId, {
          accountId: chequing,
          transactionDate: "2026-03-12",
          amount: -60,
          currencyCode: "USD",
          splits: [
            { amount: -50, transferAccountId: hisa, categoryId: savingsCat },
            { amount: -10, categoryId: investmentsCat },
          ],
        } as never),
      );
      const { result, figure } = await rowsOf();
      expect(figure("category", "Savings contributions", "from")).toBe(750);
      expect(figure("category", "Savings contributions", "to")).toBe(-750);
      expect(result.summary.transfers.total).toBe(0);
      expect(result.summary.expenses.total).toBe(10);
    });
  });

  describe("section 5: a transfer holding an Expense category, as before", () => {
    beforeEach(async () => {
      await asUser(() =>
        transactions.create(userId, {
          accountId: chequing,
          transactionDate: "2026-03-05",
          amount: -20,
          currencyCode: "USD",
          categoryId: investmentsCat,
        } as never),
      );
      await transfer(chequing, brokerage, 1000, investmentsCat);
    });

    const grouped = (accountIds?: string[]) =>
      asUser(() =>
        analytics.getGroupedTotals(userId, {
          groupBy: "category",
          accountIds,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        }),
      );

    it("groups Investments -1,020 on Chequing and -20 on every account", async () => {
      const chequingOnly = await grouped([chequing]);
      expect(chequingOnly).toEqual([
        expect.objectContaining({
          id: investmentsCat,
          total: -1020,
          categoryType: "expense",
        }),
      ]);
      const all = await grouped();
      expect(all).toEqual([
        expect.objectContaining({ id: investmentsCat, total: -20 }),
      ]);
    });

    it("counts its three transactions on the category detail page", async () => {
      const result = await asUser(() =>
        detail.getDetail(userId, investmentsCat),
      );
      expect(result.stats.transactionCount).toBe(3);
    });

    it("leaves the breakdown's Investments row at 20, the transfer by account", async () => {
      const result = await asUser(() =>
        breakdown.getMonthlyCategoryBreakdown(
          userId,
          "2026-03-01",
          "2026-03-31",
        ),
      );
      expect(result.data).toEqual([
        expect.objectContaining({ categoryId: investmentsCat, total: 20 }),
      ]);
      expect(
        result.transfers.map((r) => [r.kind, r.accountName, r.total]),
      ).toEqual(
        expect.arrayContaining([
          ["account", "Chequing", 1000],
          ["account", "Brokerage", -1000],
        ]),
      );
    });
  });

  describe("a Transfer category on the register and its detail page", () => {
    it("groups its legs under it, labelled a transfer", async () => {
      await transfer(chequing, hisa, 500, savingsCat);
      const rows = await asUser(() =>
        analytics.getGroupedTotals(userId, {
          groupBy: "category",
          accountIds: [chequing],
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        }),
      );
      expect(rows).toEqual([
        expect.objectContaining({
          id: savingsCat,
          total: -500,
          categoryType: "transfer",
        }),
      ]);
    });

    it("reads a split's transfer line holding the category on the detail page", async () => {
      await asUser(() =>
        transactions.create(userId, {
          accountId: chequing,
          transactionDate: "2026-03-12",
          amount: -60,
          currencyCode: "USD",
          splits: [
            { amount: -50, transferAccountId: hisa, categoryId: savingsCat },
            { amount: -10, categoryId: investmentsCat },
          ],
        } as never),
      );
      const result = await asUser(() => detail.getDetail(userId, savingsCat));
      // The split parent (its transfer line) and the linked row in HISA.
      expect(result.stats.transactionCount).toBe(2);
      expect(result.largestTransaction?.amount).toBe(-50);
      // The other line's category does not bring the transfer line in.
      const investments = await asUser(() =>
        detail.getDetail(userId, investmentsCat),
      );
      expect(investments.largestTransaction?.amount).toBe(-10);
    });

    it("leaves a transfer line holding no category out of the detail", async () => {
      await asUser(() =>
        transactions.create(userId, {
          accountId: chequing,
          transactionDate: "2026-03-12",
          amount: -60,
          currencyCode: "USD",
          splits: [
            { amount: -50, transferAccountId: hisa },
            { amount: -10, categoryId: investmentsCat },
          ],
        } as never),
      );
      const result = await asUser(() =>
        detail.getDetail(userId, investmentsCat),
      );
      expect(result.stats.transactionCount).toBe(1);
      expect(result.largestTransaction?.amount).toBe(-10);
    });
  });
});
