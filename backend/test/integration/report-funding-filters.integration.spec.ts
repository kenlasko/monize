import type { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see `report-tag-key-breakdown.integration.spec.ts`.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * `docs/specs/report-tag-key-breakdown.md` section 11 against a real
 * PostgreSQL database: the tag key + value filter of Spending by Category and
 * the account filter of Monthly Breakdown. The unit specs assert the text of
 * the SQL; this runs it.
 */
describe("Funding view report filters (integration)", () => {
  let module: TestingModule;
  let spending: SpendingReportsService;
  let monthly: MonthlyCategoryBreakdownService;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;

  let userId: string;
  let checkingId: string;
  let savingsId: string;
  let cashSleeveId: string;
  let brokerageId: string;
  let groceriesId: string;
  let funId: string;
  let salaryId: string;
  let securityId: string;

  const START = "2026-03-01";
  const END = "2026-03-31";
  const DATE = "2026-03-10";

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
    const currency = new ReportCurrencyService(dataSource, {
      getLatestRates: async () => [],
      getRateHistory: async () => [],
    } satisfies Pick<
      ExchangeRateService,
      "getLatestRates" | "getRateHistory"
    > as unknown as ExchangeRateService);
    spending = new SpendingReportsService(dataSource, currency);
    monthly = new MonthlyCategoryBreakdownService(dataSource, currency);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_split_tags",
      "transaction_tags",
      "tags",
      "action_history",
      "holdings",
      "security_prices",
      "securities",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    checkingId = (
      await createTestAccount(dataSource, userId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, {
        name: "Groceries",
        isIncome: false,
      })
    ).id;
    funId = (
      await createTestCategory(dataSource, userId, {
        name: "Fun",
        isIncome: false,
      })
    ).id;

    salaryId = (
      await createTestCategory(dataSource, userId, {
        name: "Salary",
        isIncome: true,
      })
    ).id;

    const cash = await createTestAccount(dataSource, userId, {
      name: "TFSA - Cash",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    cashSleeveId = cash.id;
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "TFSA - Investments",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashSleeveId,
    });
    brokerageId = brokerage.id;
    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId: checkingId,
      transactionDate: DATE,
      amount: -50,
      currencyCode: "USD",
      status: TransactionStatus.UNRECONCILED,
      isTransfer: false,
      isSplit: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  async function insertSplitTransaction(
    parentOverrides: Partial<Transaction>,
    lines: Array<{ amount: number; categoryId: string }>,
  ): Promise<{ parent: Transaction; splits: TransactionSplit[] }> {
    const parent = await insertTransaction({
      isSplit: true,
      categoryId: null,
      amount: lines.reduce((sum, l) => sum + l.amount, 0),
      ...parentOverrides,
    });
    const splits = await dataSource.manager.save(
      lines.map((l) =>
        dataSource.manager.create(TransactionSplit, {
          transactionId: parent.id,
          kind: SplitKind.CATEGORY,
          categoryId: l.categoryId,
          amount: l.amount,
        } as Partial<TransactionSplit>),
      ),
    );
    return { parent, splits };
  }

  /**
   * One tag per name, as production keeps it (`idx_tags_user_name` is unique
   * on the user and the lower-cased name): a second row tagged with the same
   * name shares the first one's tag.
   */
  async function seedTag(name: string): Promise<string> {
    const [existing] = await dataSource.query(
      `SELECT id FROM tags WHERE user_id = $1 AND LOWER(name) = LOWER($2)`,
      [userId, name],
    );
    if (existing) return existing.id;
    const [row] = await dataSource.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, name],
    );
    return row.id;
  }

  async function tagTransaction(id: string, tagName: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [id, await seedTag(tagName)],
    );
  }

  async function tagSplit(id: string, tagName: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO transaction_split_tags (transaction_split_id, tag_id) VALUES ($1, $2)`,
      [id, await seedTag(tagName)],
    );
  }

  async function getSpending(options: {
    accountIds?: string[];
    tagKey?: string;
    tagValue?: string;
  }) {
    return withUserContext(userId, () =>
      spending.getSpendingByCategory(userId, START, END, options),
    );
  }

  const byName = (data: Array<{ categoryName: string; total: number }>) =>
    Object.fromEntries(data.map((d) => [d.categoryName, d.total]));

  describe("Spending by Category tag key + value filter", () => {
    beforeEach(async () => {
      const groceries = await insertTransaction({
        amount: -100,
        categoryId: groceriesId,
      });
      await tagTransaction(groceries.id, "scope:household");
      const fun = await insertTransaction({ amount: -40, categoryId: funId });
      await tagTransaction(fun.id, "scope:stall");
      await insertTransaction({ amount: -10, categoryId: funId });
    });

    it("is today's answer with no tag filter", async () => {
      const result = await getSpending({});
      expect(byName(result.data)).toEqual({ Groceries: 100, Fun: 50 });
      expect(result.totalSpending).toBe(150);
    });

    it("keeps only the rows carrying the chosen value", async () => {
      const household = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(household.data)).toEqual({ Groceries: 100 });
      expect(household.totalSpending).toBe(100);

      const stall = await getSpending({ tagKey: "scope", tagValue: "stall" });
      expect(byName(stall.data)).toEqual({ Fun: 40 });
    });

    it("matches the key case-insensitively and the value exactly", async () => {
      const upperKey = await getSpending({
        tagKey: "SCOPE",
        tagValue: "household",
      });
      expect(upperKey.totalSpending).toBe(100);

      const wrongCase = await getSpending({
        tagKey: "scope",
        tagValue: "Household",
      });
      expect(wrongCase.data).toEqual([]);
      const unknown = await getSpending({ tagKey: "scope", tagValue: "nope" });
      expect(unknown.data).toEqual([]);
      const otherKey = await getSpending({
        tagKey: "country",
        tagValue: "household",
      });
      expect(otherKey.data).toEqual([]);
    });

    it("attributes a split-level tag to its own line only", async () => {
      const { splits } = await insertSplitTransaction({}, [
        { amount: -60, categoryId: groceriesId },
        { amount: -30, categoryId: funId },
      ]);
      await tagSplit(splits[0].id, "scope:household");

      const result = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      // 100 from the whole transaction plus 60 from the tagged split line;
      // the 30 untagged line of the same transaction stays out.
      expect(byName(result.data)).toEqual({ Groceries: 160 });
    });

    it("counts every line of a split transaction tagged at the transaction level", async () => {
      const { parent } = await insertSplitTransaction({}, [
        { amount: -60, categoryId: groceriesId },
        { amount: -30, categoryId: funId },
      ]);
      await tagTransaction(parent.id, "scope:household");

      const result = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(result.data)).toEqual({ Groceries: 160, Fun: 30 });
    });

    it("sums a row once when the value sits at both levels and when a line holds two values (no fan-out)", async () => {
      const { parent, splits } = await insertSplitTransaction({}, [
        { amount: -60, categoryId: groceriesId },
        { amount: -30, categoryId: funId },
      ]);
      await tagTransaction(parent.id, "scope:household");
      await tagSplit(splits[0].id, "scope:household");
      await tagSplit(splits[0].id, "scope:stall");

      const household = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(household.data)).toEqual({ Groceries: 160, Fun: 30 });
      const stall = await getSpending({ tagKey: "scope", tagValue: "stall" });
      // The 40 whole-transaction stall row, the two-valued line (60) and the
      // other line of the stall-less transaction tagged household only.
      expect(byName(stall.data)).toEqual({ Fun: 40, Groceries: 60 });
    });

    it("still excludes VOID rows, transfers and investment cash legs", async () => {
      const voided = await insertTransaction({
        amount: -500,
        categoryId: groceriesId,
        status: TransactionStatus.VOID,
      });
      await tagTransaction(voided.id, "scope:household");

      const transfer = await insertTransaction({
        accountId: checkingId,
        amount: -700,
        isTransfer: true,
        categoryId: null,
      });
      await tagTransaction(transfer.id, "scope:household");

      await withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerageId,
          action: InvestmentAction.BUY,
          transactionDate: DATE,
          securityId,
          quantity: 10,
          price: 50,
          commission: 0,
        } as any),
      );
      const buyLeg = await dataSource.manager.findOneOrFail(Transaction, {
        where: { accountId: cashSleeveId },
      });
      await tagTransaction(buyLeg.id, "scope:household");

      const result = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(result.data)).toEqual({ Groceries: 100 });
      expect(result.totalSpending).toBe(100);
    });

    it("composes with the account filter", async () => {
      const savingsSpend = await insertTransaction({
        accountId: savingsId,
        amount: -25,
        categoryId: groceriesId,
      });
      await tagTransaction(savingsSpend.id, "scope:household");

      const both = await getSpending({
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(both.data)).toEqual({ Groceries: 125 });
      const savingsOnly = await getSpending({
        accountIds: [savingsId],
        tagKey: "scope",
        tagValue: "household",
      });
      expect(byName(savingsOnly.data)).toEqual({ Groceries: 25 });
    });
  });

  describe("Monthly Breakdown account filter", () => {
    async function getMonthly(accountIds?: string[]) {
      return withUserContext(userId, () =>
        monthly.getMonthlyCategoryBreakdown(
          userId,
          START,
          END,
          accountIds ? { accountIds } : undefined,
        ),
      );
    }

    const month = "2026-03";
    const categoryRow = (
      result: Awaited<ReturnType<typeof getMonthly>>,
      name: string,
    ) => result.data.find((r) => r.categoryName === name);
    const transferLabels = (result: Awaited<ReturnType<typeof getMonthly>>) =>
      result.transfers
        .map((t) => `${t.direction}:${t.accountName}:${t.valuesByMonth[month]}`)
        .sort();

    beforeEach(async () => {
      await insertTransaction({ amount: -100, categoryId: groceriesId });
      await insertTransaction({
        accountId: savingsId,
        amount: -25,
        categoryId: groceriesId,
      });
      // An uncategorized transfer Checking -> Savings: one leg per account.
      const out = await insertTransaction({
        accountId: checkingId,
        amount: -500,
        isTransfer: true,
        categoryId: null,
      });
      const inn = await insertTransaction({
        accountId: savingsId,
        amount: 500,
        isTransfer: true,
        categoryId: null,
      });
      await dataSource.manager.update(Transaction, out.id, {
        linkedTransactionId: inn.id,
      });
      await dataSource.manager.update(Transaction, inn.id, {
        linkedTransactionId: out.id,
      });
    });

    it("is today's answer with no selection, and an empty selection means every account", async () => {
      const none = await getMonthly();
      expect(categoryRow(none, "Groceries")?.withdrawalTotal).toBe(125);
      expect(transferLabels(none)).toEqual([
        "from:Checking:500",
        "to:Savings:-500",
      ]);
      expect(await getMonthly([])).toEqual(none);
    });

    it("scopes the category rows and the transfer rows to the selected accounts", async () => {
      const savings = await getMonthly([savingsId]);
      expect(categoryRow(savings, "Groceries")?.withdrawalTotal).toBe(25);
      expect(transferLabels(savings)).toEqual(["to:Savings:-500"]);

      const checking = await getMonthly([checkingId]);
      expect(categoryRow(checking, "Groceries")?.withdrawalTotal).toBe(100);
      expect(transferLabels(checking)).toEqual(["from:Checking:500"]);

      const both = await getMonthly([checkingId, savingsId]);
      expect(categoryRow(both, "Groceries")?.withdrawalTotal).toBe(125);
      expect(transferLabels(both)).toEqual([
        "from:Checking:500",
        "to:Savings:-500",
      ]);
    });

    it("an account with no rows leaves the report empty rather than unfiltered", async () => {
      const other = (
        await createTestAccount(dataSource, userId, {
          name: "Unused",
          currencyCode: "USD",
        })
      ).id;
      const result = await getMonthly([other]);
      expect(result.data).toEqual([]);
      expect(result.transfers).toEqual([]);
    });

    it("keeps VOID and investment exclusion under the filter", async () => {
      await insertTransaction({
        amount: -999,
        categoryId: groceriesId,
        status: TransactionStatus.VOID,
      });
      await withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerageId,
          action: InvestmentAction.BUY,
          transactionDate: DATE,
          securityId,
          quantity: 10,
          price: 50,
          commission: 0,
        } as any),
      );
      // Ordinary salary landing in the cash sleeve still counts (issue #1257).
      await insertTransaction({
        accountId: cashSleeveId,
        amount: 750,
        categoryId: salaryId,
      });

      const checking = await getMonthly([checkingId]);
      expect(categoryRow(checking, "Groceries")?.withdrawalTotal).toBe(100);

      const sleeve = await getMonthly([cashSleeveId]);
      expect(sleeve.data.map((r) => r.categoryName)).toEqual(["Salary"]);
      expect(categoryRow(sleeve, "Salary")?.depositTotal).toBe(750);
    });
  });
});
