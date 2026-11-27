import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { BudgetGeneratorService } from "@/budgets/budget-generator.service";
import { BudgetPeriodService } from "@/budgets/budget-period.service";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { getCurrentMonthPeriodDates } from "@/budgets/budget-date.utils";
import {
  queryCategorySpending,
  resolveCategoryProvisionalCount,
  resolveCategorySpentOrNull,
  resolveOutsideTransferIncome,
} from "@/budgets/budget-spending.util";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A budget line on a Transfer category and the overlap rule against
 * PostgreSQL (`docs/specs/transfer-categories.md` section 6): the line counts
 * the signed net of its legs in the budget's accounts, and a leg holding a
 * Transfer category that has a line is left out of every per-account transfer
 * line and of the `transfersInAsIncome` toggle. A line on an Income or Expense
 * category takes nothing from them (section 5). Budget accounts are Chequing
 * and Credit card; HISA, Mortgage, Brokerage and Reserve are excluded.
 */
describe("budget lines on a Transfer category (integration)", () => {
  jest.setTimeout(90000);

  let module: TestingModule;
  let db: DataSource;
  let budgets: BudgetsService;
  let generator: BudgetGeneratorService;
  let periodsService: BudgetPeriodService;
  let userId: string;
  const accounts: Record<string, string> = {};
  const categories: Record<string, string> = {};
  let budget: Budget;

  const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule, BudgetsModule]);
    db = module.get(DataSource);
    budgets = module.get(BudgetsService);
    generator = module.get(BudgetGeneratorService, { strict: false });
    periodsService = module.get(BudgetPeriodService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    for (const name of [
      "Chequing",
      "Credit card",
      "HISA",
      "Mortgage",
      "Brokerage",
      "Reserve",
    ]) {
      accounts[name] = (
        await createTestAccount(db, userId, { name, currencyCode: "CAD" })
      ).id;
    }
    for (const [name, type] of [
      ["Salary", "income"],
      ["Groceries", "expense"],
      ["Mortgage", "expense"],
      ["Savings contributions", "transfer"],
      ["Reserve draws", "transfer"],
      ["Card payments", "transfer"],
    ]) {
      categories[name] = (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type)
           VALUES ($1, $2, $3) RETURNING id`,
          [userId, name, type],
        )
      )[0].id;
    }
    budget = await db.manager.save(
      db.manager.create(Budget, {
        userId,
        name: "This month",
        budgetType: BudgetType.MONTHLY,
        periodStart,
        currencyCode: "CAD",
        config: {
          excludedAccountIds: ["HISA", "Mortgage", "Brokerage", "Reserve"].map(
            (name) => accounts[name],
          ),
          transfersInAsIncome: true,
        },
      } as Partial<Budget>),
    );
  });

  const line = (overrides: Partial<BudgetCategory>) =>
    db.manager.save(
      db.manager.create(BudgetCategory, {
        budgetId: budget.id,
        isIncome: false,
        isTransfer: false,
        categoryId: null,
        ...overrides,
      } as Partial<BudgetCategory>),
    );
  const categoryLine = (name: string, amount: number, isIncome = false) =>
    line({ categoryId: categories[name], amount, isIncome });
  const accountLine = (name: string, amount: number, isIncome = false) =>
    line({
      isTransfer: true,
      transferAccountId: accounts[name],
      amount,
      isIncome,
    });

  const row = (overrides: Partial<Transaction>) =>
    db.manager.save(
      db.manager.create(Transaction, {
        userId,
        transactionDate: periodStart,
        currencyCode: "CAD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );

  /** A whole-row transfer, both legs holding `category` (or none). */
  async function transfer(
    from: string,
    to: string,
    amount: number,
    category: string | null,
    status = TransactionStatus.UNRECONCILED,
  ): Promise<void> {
    const categoryId = category ? categories[category] : null;
    const inbound = await row({
      accountId: accounts[to],
      amount,
      isTransfer: true,
      categoryId,
      status,
    });
    const outbound = await row({
      accountId: accounts[from],
      amount: -amount,
      isTransfer: true,
      categoryId,
      linkedTransactionId: inbound.id,
      status,
    });
    await db.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [inbound.id, outbound.id],
    );
  }

  const read = (lines: BudgetCategory[]) =>
    withUserContext(userId, () =>
      withScopedDb(db, (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          lines,
          periodStart,
          periodEnd,
        ),
      ),
    );

  describe("section 6.4", () => {
    it("counts a Transfer category's transfer on its line, not the account's", async () => {
      const own = await categoryLine("Savings contributions", 500);
      const hisa = await accountLine("HISA", 300);
      await transfer("Chequing", "HISA", 500, "Savings contributions");
      const spending = await read([own, hisa]);
      expect(resolveCategorySpentOrNull(own, spending)).toBe(500);
      expect(resolveCategorySpentOrNull(hisa, spending)).toBe(0);
    });

    it("discloses an estimate the rule moves onto the category line", async () => {
      const own = await categoryLine("Savings contributions", 500);
      const hisa = await accountLine("HISA", 300);
      await transfer("Chequing", "HISA", 500, "Savings contributions");
      await db.query(
        `UPDATE transactions SET amount_is_provisional = true
          WHERE user_id = $1 AND account_id = $2`,
        [userId, accounts.Chequing],
      );
      const spending = await read([own, hisa]);
      expect(resolveCategoryProvisionalCount(own, spending)).toBe(1);
      expect(resolveCategoryProvisionalCount(hisa, spending)).toBe(0);
      expect(spending.provisionalCount).toBe(1);
    });

    it("leaves an estimate on an Expense category's line untracked, as before", async () => {
      const own = await categoryLine("Mortgage", 1500);
      await transfer("Chequing", "Mortgage", 1500, "Mortgage");
      await db.query(
        `UPDATE transactions SET amount_is_provisional = true
          WHERE user_id = $1 AND account_id = $2`,
        [userId, accounts.Chequing],
      );
      const spending = await read([own]);
      // The line takes nothing from the per-account figures (section 5), so
      // it names no estimate; the toggle, which nets this leg, still does.
      expect(resolveCategoryProvisionalCount(own, spending)).toBe(0);
      expect(spending.outsideTransferIncomeProvisionalCount).toBe(1);
    });

    it("converts a cross-currency leg at its own transfer rate, as the account's line did (INV-FX-002)", async () => {
      await db.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
         VALUES ('USD', 'US Dollar', '$', 2, true)
         ON CONFLICT (code) DO NOTHING`,
      );
      const usd = (
        await createTestAccount(db, userId, {
          name: "USD chequing",
          currencyCode: "USD",
        })
      ).id;
      const own = await categoryLine("Savings contributions", 500);
      const hisa = await accountLine("HISA", 300);
      // 100 USD left the budget and 137 CAD arrived in HISA; no market rate
      // is stored, so only the transfer's own rate can convert it.
      const inbound = await row({
        accountId: accounts.HISA,
        amount: 137,
        isTransfer: true,
        categoryId: categories["Savings contributions"],
      });
      const outbound = await row({
        accountId: usd,
        currencyCode: "USD",
        amount: -100,
        isTransfer: true,
        categoryId: categories["Savings contributions"],
        linkedTransactionId: inbound.id,
      });
      await db.query(
        `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
        [inbound.id, outbound.id],
      );
      const spending = await read([own, hisa]);
      expect(resolveCategorySpentOrNull(own, spending)).toBe(137);
      expect(resolveCategorySpentOrNull(hisa, spending)).toBe(0);
    });

    it("leaves the account's line counting it when the category has no line", async () => {
      const hisa = await accountLine("HISA", 300);
      await transfer("Chequing", "HISA", 500, "Savings contributions");
      expect(resolveCategorySpentOrNull(hisa, await read([hisa]))).toBe(500);
    });

    it("nets a withdrawal back against the contributions on the category line", async () => {
      const own = await categoryLine("Savings contributions", 500);
      const fromHisa = await accountLine("HISA", 1000, true);
      await transfer("Chequing", "HISA", 500, "Savings contributions");
      await transfer("HISA", "Chequing", 300, "Savings contributions");
      const spending = await read([own, fromHisa]);
      expect(resolveCategorySpentOrNull(own, spending)).toBe(200);
      expect(resolveCategorySpentOrNull(fromHisa, spending)).toBe(0);
    });

    it("reads zero for a transfer between two budget accounts", async () => {
      const own = await categoryLine("Card payments", 800);
      await transfer("Chequing", "Credit card", 800, "Card payments");
      expect(resolveCategorySpentOrNull(own, await read([own]))).toBe(0);
    });

    it("counts an Expense category's transfer on both lines, as before", async () => {
      const mortgage = await categoryLine("Mortgage", 1600);
      const toMortgage = await accountLine("Mortgage", 1600);
      await transfer("Chequing", "Mortgage", 1500, "Mortgage");
      const spending = await read([mortgage, toMortgage]);
      expect(resolveCategorySpentOrNull(mortgage, spending)).toBe(1500);
      expect(resolveCategorySpentOrNull(toMortgage, spending)).toBe(1500);
    });

    it("takes a Transfer category's income from the toggle when it has a line", async () => {
      const draws = await categoryLine("Reserve draws", 400, true);
      await transfer("Brokerage", "Chequing", 400, "Reserve draws");
      await transfer("Brokerage", "Chequing", 250, null);
      const spending = await read([draws]);
      expect(resolveCategorySpentOrNull(draws, spending)).toBe(400);
      expect(resolveOutsideTransferIncome(spending)).toBe(250);
    });

    it("counts nothing for a VOID transfer", async () => {
      const own = await categoryLine("Savings contributions", 500);
      const hisa = await accountLine("HISA", 300);
      await transfer(
        "Chequing",
        "HISA",
        500,
        "Savings contributions",
        TransactionStatus.VOID,
      );
      const spending = await read([own, hisa]);
      expect(resolveCategorySpentOrNull(own, spending)).toBe(0);
      expect(resolveCategorySpentOrNull(hisa, spending)).toBe(0);
    });

    it("applies the rule to a split's transfer line by the line's own category", async () => {
      const own = await categoryLine("Savings contributions", 500);
      const hisa = await accountLine("HISA", 300);
      const parent = await row({
        accountId: accounts.Chequing,
        amount: -560,
        isSplit: true,
      });
      const linked = await row({
        accountId: accounts.HISA,
        amount: 500,
        isTransfer: true,
        categoryId: categories["Savings contributions"],
        linkedTransactionId: parent.id,
      });
      await db.query(
        `INSERT INTO transaction_splits
           (transaction_id, amount, kind, transfer_account_id,
            linked_transaction_id, category_id)
         VALUES ($1, -500, 'transfer', $2, $3, $4),
                ($1, -60, 'category', NULL, NULL, $5)`,
        [
          parent.id,
          accounts.HISA,
          linked.id,
          categories["Savings contributions"],
          categories.Groceries,
        ],
      );
      const spending = await read([own, hisa]);
      expect(resolveCategorySpentOrNull(own, spending)).toBe(500);
      expect(resolveCategorySpentOrNull(hisa, spending)).toBe(0);
    });
  });

  describe("the budget generator", () => {
    it("suggests a Transfer category's outgoing legs as its line, never another transfer", async () => {
      const lastMonth = new Date();
      lastMonth.setUTCDate(1);
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      const date = lastMonth.toISOString().slice(0, 10);
      const at = async (fn: () => Promise<void>) => {
        await fn();
        await db.query(
          `UPDATE transactions SET transaction_date = $2 WHERE user_id = $1`,
          [userId, date],
        );
      };
      await at(() =>
        transfer("Chequing", "HISA", 500, "Savings contributions"),
      );
      await at(() => transfer("Chequing", "Mortgage", 1500, "Mortgage"));
      // A withdrawal on the same category nets on its line once applied, so
      // HISA is not suggested as a source of income for it either.
      await at(() =>
        transfer("HISA", "Chequing", 200, "Savings contributions"),
      );
      const result = await withUserContext(userId, () =>
        generator.generate(userId, { analysisMonths: 3 }),
      );
      const suggested = result.categories.map((c) => [
        c.categoryId,
        c.isIncome,
        c.categoryType,
      ]);
      // Typed, so the wizard files it with the transfers, not the expenses.
      expect(suggested).toContainEqual([
        categories["Savings contributions"],
        false,
        "transfer",
      ]);
      // An Expense category on a transfer is no spending suggestion, as before.
      expect(suggested.map(([id]) => id)).not.toContain(categories.Mortgage);
      // The categorized leg is planned once, on its category's line: not on
      // HISA's account line too. The Mortgage leg stays on its account's.
      const destinations = result.transfers.map((t) => t.accountId);
      expect(destinations).not.toContain(accounts.HISA);
      expect(destinations).toContain(accounts.Mortgage);
      const savings = result.categories.find(
        (c) => c.categoryId === categories["Savings contributions"],
      );
      const mortgage = result.transfers.find(
        (t) => t.accountId === accounts.Mortgage,
      );
      expect(result.incomeTransfers.map((t) => t.accountId)).not.toContain(
        accounts.HISA,
      );
      // Spending holds no transfer; the transfers hold both legs' lines.
      expect(result.totalBudgeted).toBe(0);
      expect(result.totalTransfers).toBe(
        (savings?.suggested ?? NaN) + (mortgage?.suggested ?? NaN),
      );
    });
  });

  describe("section 6.5", () => {
    let lines: Record<string, BudgetCategory>;

    /**
     * The example's rows. Row c (Chequing -> the excluded Mortgage) is a
     * transfer to an account the toggle sweeps, and the toggle nets both
     * directions (`docs/specs/budget-transfer-income.md` section 2), so with
     * it the toggle reads max(250 - 1,500, 0) = 0, before and after this
     * work. The example's toggle figure of 250 leaves that out; `withRowC`
     * false reproduces it.
     */
    const seed = async (withRowC: boolean) => {
      lines = {
        L1: await categoryLine("Salary", 5000, true),
        L2: await categoryLine("Groceries", 600),
        L3: await categoryLine("Mortgage", 1600),
        L4: await categoryLine("Savings contributions", 500),
        L5: await accountLine("HISA", 300),
        L6: await accountLine("Reserve", 1000, true),
        L7: await categoryLine("Reserve draws", 400, true),
      };
      await row({
        accountId: accounts.Chequing,
        amount: 5000,
        categoryId: categories.Salary,
      });
      await row({
        accountId: accounts["Credit card"],
        amount: -450,
        categoryId: categories.Groceries,
      });
      if (withRowC) await transfer("Chequing", "Mortgage", 1500, "Mortgage");
      await transfer("Chequing", "HISA", 500, "Savings contributions");
      await transfer("Chequing", "HISA", 200, null);
      await transfer("Reserve", "Chequing", 1000, null);
      await transfer("Brokerage", "Chequing", 250, null);
      await transfer("Brokerage", "Chequing", 400, "Reserve draws");
      await transfer("Chequing", "Credit card", 800, "Card payments");
    };
    const summary = () =>
      withUserContext(userId, () => budgets.getSummary(userId, budget.id));

    it("counts each row on one line, with the overlap rule", async () => {
      await seed(true);
      const spending = await read(Object.values(lines));
      const figure = (key: string) =>
        resolveCategorySpentOrNull(lines[key], spending);
      expect(figure("L1")).toBe(5000);
      expect(figure("L2")).toBe(450);
      expect(figure("L3")).toBe(1500);
      expect(figure("L4")).toBe(500);
      expect(figure("L5")).toBe(200);
      expect(figure("L6")).toBe(1000);
      expect(figure("L7")).toBe(400);
      // Row c nets the toggle to zero (see `seed`).
      expect(resolveOutsideTransferIncome(spending)).toBe(0);
      const totals = await summary();
      expect(totals.totalSpent).toBe(2650);
      expect(totals.totalBudgeted).toBe(3000);
      expect(totals.totalIncome).toBe(6400);
      expect(totals.categoryIncome).toBe(5000);
      expect(totals.transferFunding).toBe(1400);
    });

    it("reads the example's toggle and totals without row c", async () => {
      await seed(false);
      const spending = await read(Object.values(lines));
      expect(resolveOutsideTransferIncome(spending)).toBe(250);
      expect(resolveCategorySpentOrNull(lines.L5, spending)).toBe(200);
      const totals = await summary();
      expect(totals.totalIncome).toBe(6650);
      // Actual Income 5,000; Transfer Funding 1,000 + 400 + 250 = 1,650.
      expect(totals.categoryIncome).toBe(5000);
      expect(totals.transferFunding).toBe(1650);
      expect(totals.totalSpent).toBe(1150);
      expect(totals.totalBudgeted).toBe(3000);
    });

    it("freezes the Transfer Funding part at the close (section 6.6)", async () => {
      await seed(false);
      await withUserContext(userId, () =>
        periodsService.getOrCreateCurrentPeriod(userId, budget.id),
      );
      const closed = await withUserContext(userId, () =>
        periodsService.closePeriod(userId, budget.id),
      );
      expect(Number(closed.actualIncome)).toBe(6650);
      expect(Number(closed.transferFunding)).toBe(1650);
      expect(closed.categoryIncome).toBe(5000);

      const [stored] = await db.query(
        `SELECT actual_income, transfer_funding FROM budget_periods
          WHERE id = $1`,
        [closed.id],
      );
      expect(Number(stored.actual_income)).toBe(6650);
      expect(Number(stored.transfer_funding)).toBe(1650);
    });

    it("shows one figure for a period closed before the split was stored (section 10)", async () => {
      await db.query(
        `INSERT INTO budget_periods
           (budget_id, period_start, period_end, actual_income, status)
         VALUES ($1, '2020-01-01', '2020-01-31', 6650, 'CLOSED')`,
        [budget.id],
      );
      const periods = await withUserContext(userId, () =>
        periodsService.findAll(userId, budget.id),
      );
      const legacy = periods.find((p) => p.periodStart === "2020-01-01");
      expect(Number(legacy?.actualIncome)).toBe(6650);
      expect(legacy?.transferFunding).toBeNull();
      expect(legacy?.categoryIncome).toBeNull();
    });

    it("applies the rule from the budget's lines when a caller reads a subset", async () => {
      await seed(false);
      const spending = await read([lines.L5]);
      expect(resolveCategorySpentOrNull(lines.L5, spending)).toBe(200);
      expect(resolveOutsideTransferIncome(spending)).toBe(250);
    });
  });
});
