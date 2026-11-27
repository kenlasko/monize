import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { CashFlowSankeyService } from "@/built-in-reports/cash-flow-sankey.service";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { PayeeDetailService } from "@/payees/payee-detail.service";
import { CurrencyDetailService } from "@/currencies/currency-detail.service";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { buildRateIndex } from "@/common/time-series/rate-index.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withDelegateContext, withUserContext } from "@/common/db/with-context";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { queryCategorySpending } from "@/budgets/budget-spending.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * A transfer leg converts at the two amounts its transfer moved on every
 * report, chart and analytics read that counts transfers, not only in a custom
 * report (issue #2153, after #2150): the SQL reads of the built-in reports, the
 * Cash Flow Sankey and the assistant's and MCP tools' analytics, against real
 * PostgreSQL.
 *
 * The market says 1 EUR = 1.25 USD. On 10 March:
 *
 *   a plain transfer: 100 USD from US Chequing arrived as 90 EUR in Euro
 *     Savings (the incoming leg stores 0.85, deliberately not 90 / 100);
 *   a split: -160 USD on US Chequing, 60 USD of groceries and a 100 USD line
 *     to Euro Savings that arrived as 90 EUR.
 *
 * In EUR each 100 USD transfer is 90, not the market's 80, and the groceries
 * line is the market's 48. In USD each 90 EUR leg is 100, not the market's
 * 112.50.
 */
describe("a transfer leg at the amounts moved, on every report (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let analytics: TransactionAnalyticsService;
  let transactionsService: TransactionsService;
  let sankey: CashFlowSankeyService;
  let breakdown: MonthlyCategoryBreakdownService;
  let income: IncomeReportsService;

  let userId: string;
  let usId: string;
  let euId: string;
  let plainOutId: string;
  let payeeId: string;
  let transferLineId: string;

  const START = "2026-03-01";
  const END = "2026-03-31";
  const DAY = "2026-03-10";

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    analytics = module.get(TransactionAnalyticsService);
    transactionsService = module.get(TransactionsService);
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: (
        currencies: ReadonlySet<string>,
        to: string,
        start: string,
        end: string,
      ) =>
        buildRateIndex(
          (sql, params) =>
            withScopedDb(dataSource, (m) => m.query(sql, params)),
          new Set(currencies),
          to,
          start,
          end,
        ),
    } as never);
    sankey = new CashFlowSankeyService(dataSource, currency);
    breakdown = new MonthlyCategoryBreakdownService(dataSource, currency);
    income = new IncomeReportsService(dataSource, currency);
  });

  afterAll(async () => {
    await module.close();
  });

  const insertRow = (overrides: Partial<Transaction>): Promise<Transaction> =>
    dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        transactionDate: DAY,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: true,
        exchangeRate: 1,
        ...overrides,
      } as Partial<Transaction>),
    );

  const tag = async (column: string, id: string): Promise<void> => {
    const [existing] = await dataSource.query(
      `SELECT id FROM tags WHERE user_id = $1 AND name = 'scope:home'`,
      [userId],
    );
    const tagId =
      existing?.id ??
      (
        await dataSource.query(
          `INSERT INTO tags (user_id, name) VALUES ($1, 'scope:home') RETURNING id`,
          [userId],
        )
      )[0].id;
    const table =
      column === "transaction_id"
        ? "transaction_tags"
        : "transaction_split_tags";
    await dataSource.query(
      `INSERT INTO ${table} (${column}, tag_id) VALUES ($1, $2)`,
      [id, tagId],
    );
  };

  async function seed(reporting: "EUR" | "USD"): Promise<void> {
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, $2)`,
      [userId, reporting],
    );

    const payee = await createTestPayee(dataSource, userId, {
      name: "Exchange",
    });
    payeeId = payee.id;
    const out = await insertRow({
      accountId: usId,
      amount: -100,
      currencyCode: "USD",
      payeeId,
      payeeName: payee.name,
    });
    const into = await insertRow({
      accountId: euId,
      amount: 90,
      currencyCode: "EUR",
      exchangeRate: 0.85,
      linkedTransactionId: out.id,
    });
    await dataSource.manager.update(
      Transaction,
      { id: out.id },
      { linkedTransactionId: into.id },
    );
    plainOutId = out.id;

    const groceries = await createTestCategory(dataSource, userId, {
      name: "Groceries",
    });
    const parent = await insertRow({
      accountId: usId,
      amount: -160,
      currencyCode: "USD",
      isSplit: true,
      isTransfer: false,
    });
    const counterpart = await insertRow({
      accountId: euId,
      amount: 90,
      currencyCode: "EUR",
      exchangeRate: 0.9,
      linkedTransactionId: parent.id,
    });
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -60,
        categoryId: groceries.id,
      }),
    );
    const line = await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -100,
        kind: SplitKind.TRANSFER,
        transferAccountId: euId,
        linkedTransactionId: counterpart.id,
      }),
    );
    transferLineId = line.id;

    // EUR->USD, the canonical orientation (`EUR` sorts before `USD`).
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('EUR', 'USD', '2026-03-01'::DATE, 1.2500000000, 'test')`,
    );
  }

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "budgets",
      "transaction_split_tags",
      "transaction_tags",
      "tags",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('EUR', 'Euro', 'E', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    usId = (
      await createTestAccount(dataSource, userId, {
        name: "US Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    euId = (
      await createTestAccount(dataSource, userId, {
        name: "Euro Savings",
        accountType: "SAVINGS",
        currencyCode: "EUR",
      })
    ).id;
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  const summaryOf = (accountIds: string[]) =>
    asUser(() =>
      analytics.getSummary(
        userId,
        accountIds,
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { inReportingCurrency: true },
      ),
    );

  it("reads both outgoing transfers at 90 EUR in the Cash Flow Sankey", async () => {
    await seed("EUR");

    const result = await asUser(() =>
      sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
    );

    // The plain leg and the split's transfer line, each 90 EUR, not 80.
    expect(result.nodes.find((n) => n.id === "class:savings")?.total).toBe(180);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("keeps the market rate while the EUR legs are provisional (issue #2338)", async () => {
    await seed("EUR");
    await dataSource.query(
      `UPDATE transactions
          SET amount_is_provisional = true
        WHERE user_id = $1 AND account_id = $2`,
      [userId, euId],
    );

    const flows = await asUser(() =>
      sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
    );
    const summary = await summaryOf([usId]);

    // The plain leg and the split's transfer line, each the market's 80 EUR:
    // the 90 EUR the counterparts hold is not yet what arrived. The summary
    // counts both beside the groceries line's 48 (issue #2337).
    expect(flows.nodes.find((n) => n.id === "class:savings")?.total).toBe(160);
    expect(summary.converted).toMatchObject({
      totalExpenses: 208,
      missingCurrencies: [],
    });
    // Only the confirmed side is in the figure, so nothing is an estimate
    // (design section 13, question 2).
    expect(flows.provisionalCount).toBe(0);
  });

  it("reads confirmed EUR legs at 90 EUR whatever their description says (design P4)", async () => {
    await seed("EUR");
    await dataSource.query(
      `UPDATE transactions
          SET description = $3, amount_is_provisional = false
        WHERE user_id = $1 AND account_id = $2`,
      [
        userId,
        euId,
        "⚠️ PENDING IMPORT: Amount may need adjustment when importing the other account.",
      ],
    );

    const flows = await asUser(() =>
      sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
    );
    const summary = await summaryOf([usId]);

    // The column is the only signal: the old note's text decides nothing.
    expect(flows.nodes.find((n) => n.id === "class:savings")?.total).toBe(180);
    expect(summary.converted).toMatchObject({
      totalExpenses: 228,
      missingCurrencies: [],
    });
  });

  it("reads the plain leg and the split transfer line at 90 EUR each (180) in the monthly category breakdown", async () => {
    await seed("EUR");

    const result = await asUser(() =>
      breakdown.getMonthlyCategoryBreakdown(userId, START, END, {
        accountIds: [usId],
      }),
    );

    expect(result.transfers).toEqual([
      {
        // An uncategorized leg stays on its account's row
        // (docs/specs/transfer-categories.md section 7).
        kind: "account",
        accountId: usId,
        accountName: "US Chequing",
        categoryId: null,
        categoryName: null,
        parentId: null,
        parentName: null,
        isSubtotal: false,
        direction: "from",
        valuesByMonth: { "2026-03": 180 },
        // Issue #2413: the server folds the row's total and its average over
        // the one-month window from the same unrounded leg.
        total: 180,
        average: 180,
      },
    ]);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("counts a split's transfer line like a whole transfer: breakdown equals the Sankey (INV-REPORT-006)", async () => {
    await seed("EUR");

    const flows = await asUser(() =>
      sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
    );
    const result = await asUser(() =>
      breakdown.getMonthlyCategoryBreakdown(userId, START, END, {
        accountIds: [usId],
      }),
    );

    expect(result.transfers[0].valuesByMonth["2026-03"]).toBe(
      flows.nodes.find((n) => n.id === "class:savings")?.total,
    );
  });

  it("reads the split transfer line in the per-account transfer totals", async () => {
    await seed("EUR");

    const result = await asUser(() =>
      analytics.getTransfersByAccount(userId, START, END, [usId]),
    );

    expect(result.accounts).toEqual([
      expect.objectContaining({
        accountId: usId,
        currency: "USD",
        inbound: 0,
        outbound: 200,
        net: -200,
        transferCount: 2,
      }),
    ]);
    expect(result.totalOutbound).toBe(200);
  });

  it("reads tagged transfer flows at 90 EUR each in Income vs Expenses", async () => {
    await seed("EUR");
    await tag("transaction_id", plainOutId);
    await tag("transaction_split_id", transferLineId);

    const result = await asUser(() =>
      income.getIncomeVsExpenses(userId, START, END, {
        tagKey: "scope",
        accountIds: [usId],
      }),
    );

    const home = result.buckets?.find((b) => b.value === "home");
    expect(home?.taggedOutflows).toBe(180);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("reads both outgoing legs at 90 EUR in the transaction summary and grouped totals", async () => {
    await seed("EUR");
    await tag("transaction_id", plainOutId);

    const summary = await summaryOf([usId]);
    const byPayee = await asUser(() =>
      analytics.getGroupedTotals(userId, {
        groupBy: "payee",
        accountIds: [usId],
        startDate: START,
        endDate: END,
      }),
    );
    const byTag = await asUser(() =>
      analytics.getTransactionBreakdownByTagKey(userId, "scope", {
        accountIds: [usId],
        startDate: START,
        endDate: END,
      }),
    );

    // The plain leg's 90, the groceries line's 60 / 1.25 and the split's
    // transfer line at its 90 (issue #2337).
    expect(summary.converted).toMatchObject({
      currency: "EUR",
      totalExpenses: 228,
      missingCurrencies: [],
    });
    const payeeTotal = byPayee.reduce(
      (sum, row) => sum + (row.convertedTotal as number),
      0,
    );
    expect(payeeTotal).toBe(-228);
    expect(byTag).toEqual([
      expect.objectContaining({ name: "home", total: 100, convertedTotal: 90 }),
    ]);
  });

  it("reads the outgoing leg at 90 EUR in a payee's account panel", async () => {
    await seed("EUR");

    const detail = await asUser(() =>
      new PayeeDetailService(dataSource, {
        findOne: async () => ({ id: payeeId }),
      } as never).getDetail(userId, payeeId),
    );

    expect(
      detail.accounts.map((r) => [r.accountName, r.total, r.convertedTotal]),
    ).toEqual([["US Chequing", -100, -90]]);
  });

  it("reads every leg at the amounts moved in the monthly totals and the MCP flow totals", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, undefined, START, END),
    );
    const flows = await asUser(() =>
      analytics.getLlmFlowTotals(userId, {
        startDate: START,
        endDate: END,
        excludeTransfers: false,
      }),
    );

    // Both sides of each transfer, each at 90: -90 + 90 for the plain one,
    // the split's -90 line against its +90 row, and the groceries line's -48
    // (issue #2337). The market rate would read -80 - 80 - 48 + 180.
    expect(monthly).toEqual([
      expect.objectContaining({
        month: "2026-03",
        currency: "EUR",
        total: -48,
        // Two plain legs, the split parent once and its counterpart row.
        count: 4,
      }),
    ]);
    expect(flows).toMatchObject({
      fxComplete: true,
      totalExpenses: 228,
      totalIncome: 180,
    });
  });

  it("leaves the split's transfer line out of the MCP flow totals without transfers", async () => {
    await seed("EUR");

    const flows = await asUser(() =>
      analytics.getLlmFlowTotals(userId, {
        startDate: START,
        endDate: END,
      }),
    );

    // Only the groceries line is spending or income.
    expect(flows).toMatchObject({
      fxComplete: true,
      totalExpenses: 48,
      totalIncome: 0,
    });
  });

  it("reads the split's transfer line in the monthly totals of the sending account", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, [usId], START, END),
    );

    // USD only, so no conversion: -100 plain, -60 groceries, -100 line.
    expect(monthly).toEqual([
      expect.objectContaining({
        month: "2026-03",
        currency: "USD",
        total: -260,
        count: 2,
      }),
    ]);
  });

  it("reads the rows the register lists under the transfer filter in the monthly totals", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, undefined, START, END, ["transfer"]),
    );

    // The register lists the plain transfer's two rows, the split parent
    // (only its transfer line hydrated) and the split's counterpart; the chart
    // adds up to it at line grain: -90 + 90 plain, the line's -90 against its
    // +90 counterpart. The groceries line is not a transfer, so it is out.
    expect(monthly).toEqual([
      expect.objectContaining({
        month: "2026-03",
        currency: "EUR",
        total: 0,
        // One row per line: plain out, plain in, the split's transfer line
        // (the parent counts through that line only) and its counterpart.
        count: 4,
      }),
    ]);
  });

  it("reads only the outgoing amounts under the transfer filter of the sending account", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, [usId], START, END, ["transfer"]),
    );

    // USD only: -100 plain, -100 transfer line; the -60 groceries line stays out.
    expect(monthly).toEqual([
      expect.objectContaining({ currency: "USD", total: -200, count: 2 }),
    ]);
  });

  it("reads only the incoming amounts under the transfer filter of the receiving account", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, [euId], START, END, ["transfer"]),
    );

    expect(monthly).toEqual([
      expect.objectContaining({ currency: "EUR", total: 180, count: 2 }),
    ]);
  });

  it("lists a split under the register's transfer filter with only its transfer line", async () => {
    await seed("EUR");

    const page = await asUser(() =>
      transactionsService.findAll(userId, [usId], undefined, undefined, [
        "transfer",
      ]),
    );

    const split = page.data.find((t) => t.isSplit);
    expect(page.data).toHaveLength(2);
    expect(split?.splits?.map((l) => l.id)).toEqual([transferLineId]);
    // The filtered balance is the two transfer amounts, not the parent's -160.
    expect(page.startingBalance).toBe(-200);
  });

  it("walks the register's later pages under the transfer filter at the line's amount", async () => {
    await seed("EUR");

    const pageAt = (page: number) =>
      asUser(() =>
        transactionsService.findAll(
          userId,
          [usId],
          undefined,
          undefined,
          ["transfer"],
          undefined,
          page,
          1,
        ),
      );
    const first = await pageAt(1);
    const second = await pageAt(2);

    // The split row counts only its hydrated transfer line, as the register
    // draws it; a plain row counts its own amount.
    const [row] = first.data;
    const shown = row.isSplit
      ? row.splits!.reduce((sum, l) => sum + Number(l.amount), 0)
      : Number(row.amount);
    expect(shown).toBe(-100);
    expect(first.startingBalance).toBe(-200);
    expect(second.startingBalance).toBe(first.startingBalance! - shown);
  });

  it("agrees on a payee's split transfer in the summary and the monthly totals", async () => {
    await seed("EUR");
    // The split and its counterpart row share a payee, as the split service
    // writes them; the plain transfer's payee is another.
    const shop = await createTestPayee(dataSource, userId, { name: "Shop" });
    await dataSource.query(
      `UPDATE transactions SET payee_id = $1, payee_name = 'Shop'
        WHERE user_id = $2 AND (is_split OR id IN (
          SELECT linked_transaction_id FROM transaction_splits
           WHERE transfer_account_id IS NOT NULL))`,
      [shop.id, userId],
    );

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, undefined, START, END, undefined, [
        shop.id,
      ]),
    );
    const summary = await asUser(() =>
      analytics.getSummary(
        userId,
        undefined,
        START,
        END,
        undefined,
        [shop.id],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { inReportingCurrency: true },
      ),
    );

    // The -90 line against its +90 row, and the groceries line's -48.
    expect(monthly).toEqual([
      expect.objectContaining({
        month: "2026-03",
        currency: "EUR",
        total: -48,
        count: 2,
      }),
    ]);
    expect(summary.converted).toMatchObject({
      totalIncome: 90,
      totalExpenses: 138,
      netCashFlow: -48,
      missingCurrencies: [],
    });
    expect(summary.transactionCount).toBe(2);
  });

  it("matches the MCP totals with the summary's own buckets", async () => {
    await seed("EUR");

    const [summary, flows] = await asUser(() =>
      Promise.all([
        analytics.getSummary(
          userId,
          undefined,
          START,
          END,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
        analytics.getLlmFlowTotals(userId, {
          startDate: START,
          endDate: END,
          excludeTransfers: false,
        }),
      ]),
    );

    // The resources show both side by side: 260 USD out (the plain leg, the
    // groceries line and the transfer line) is the converted 90 + 48 + 90.
    expect(summary.byCurrency).toEqual({
      USD: expect.objectContaining({ totalExpenses: 260, transactionCount: 2 }),
      EUR: expect.objectContaining({ totalIncome: 180, transactionCount: 2 }),
    });
    expect(flows).toMatchObject({ totalExpenses: 228, totalIncome: 180 });
  });

  it("pulls a split's transfer line in under a tag on its parent", async () => {
    await seed("EUR");
    const [parent] = await dataSource.query(
      `SELECT id FROM transactions WHERE user_id = $1 AND is_split`,
      [userId],
    );
    await tag("transaction_id", parent.id);
    const [{ id: tagId }] = await dataSource.query(
      `SELECT id FROM tags WHERE user_id = $1 AND name = 'scope:home'`,
      [userId],
    );

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(
        userId,
        undefined,
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [tagId],
      ),
    );

    // The tagged split is the -60 groceries line and the -100 transfer line,
    // all USD; the counterpart row carries no tag, so it is not in this read.
    expect(monthly).toEqual([
      expect.objectContaining({ currency: "USD", total: -160, count: 1 }),
    ]);
  });

  it("does not count the split's transfer line as uncategorised in the monthly totals", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, [usId], START, END, ["uncategorized"]),
    );

    // The groceries line has a category, the plain leg is a transfer and the
    // transfer line has no category but is not uncategorised spending.
    expect(monthly).toEqual([]);
  });

  it("reads both outgoing transfers at 90 EUR in a budget's transfer actuals", async () => {
    await seed("EUR");
    const budget = await dataSource.manager.save(
      dataSource.manager.create(Budget, {
        userId,
        name: "March",
        budgetType: BudgetType.MONTHLY,
        periodStart: START,
        currencyCode: "EUR",
        config: {},
      } as Partial<Budget>),
    );
    const line = {
      id: "bc-savings",
      budgetId: budget.id,
      categoryId: null,
      isTransfer: true,
      transferAccountId: euId,
    } as unknown as BudgetCategory;

    const spending = await asUser(() =>
      withScopedDb(dataSource, (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          [line],
          START,
          END,
        ),
      ),
    );

    expect(spending.currency).toBe("EUR");
    expect(spending.transferSpendingMap.get(euId)).toBe(180);
    expect(spending.missingRatePairs).toEqual([]);
  });

  it("keeps the market rate for a delegate reading the owner's ledger", async () => {
    await seed("EUR");
    const delegateId = (
      await createTestUserDirect(dataSource, { email: "delegate@example.com" })
    ).id;

    const summary = await withDelegateContext(userId, delegateId, () =>
      analytics.getSummary(
        userId,
        [usId],
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { inReportingCurrency: true },
      ),
    );

    // The counterpart sits in an account a delegate may not read, so each
    // leg, the plain one and the split's line, is the market's 80, beside the
    // groceries line's 48.
    expect(summary.converted).toMatchObject({
      totalExpenses: 208,
      missingCurrencies: [],
    });
  });

  it("reads each incoming EUR leg at the 100 USD sent, a split's counterpart at its own line", async () => {
    await seed("USD");

    const summary = await summaryOf([euId]);

    // 100 each, not 90 x 1.25 = 112.50, and the split counterpart at its line's
    // 100, not the parent's 160.
    expect(summary.converted).toMatchObject({
      currency: "USD",
      totalIncome: 200,
      missingCurrencies: [],
    });
  });
  /**
   * Each surface above whose rows can be transfer legs says how many
   * provisional amounts its figures hold (design section 6, P5, of
   * `docs/specs/provisional-amounts.md`): the count is over the
   * provisional legs inside the figure, so the confirmed USD side alone
   * counts none (section 13, question 2), and it is 0 once the legs are
   * confirmed. The figures themselves do not change with the flag.
   */
  describe("the provisional count on each surface (design P5)", () => {
    /** Flags or confirms both incoming EUR legs, as the USD file's import left them. */
    const setEuroLegsProvisional = (provisional: boolean) =>
      dataSource.query(
        `UPDATE transactions SET amount_is_provisional = $3
          WHERE user_id = $1 AND account_id = $2`,
        [userId, euId, provisional],
      );

    /** The plain transfer's incoming EUR leg. */
    const plainInId = async (): Promise<string> =>
      (
        await dataSource.query(
          `SELECT linked_transaction_id AS id FROM transactions WHERE id = $1`,
          [plainOutId],
        )
      )[0].id;

    it("counts both EUR legs in the Cash Flow Sankey of Euro Savings, and none once confirmed", async () => {
      await seed("EUR");
      const read = () =>
        asUser(() =>
          sankey.getCashFlowSankey(userId, START, END, { accountIds: [euId] }),
        );

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      // The plain leg and the split's counterpart row, each 90 in.
      expect(provisional.totals.inflows).toBe(180);
      expect(provisional.provisionalCount).toBe(2);
      expect(confirmed.totals.inflows).toBe(180);
      expect(confirmed.provisionalCount).toBe(0);
    });

    it("counts nothing in the Sankey of the confirmed US side", async () => {
      await seed("EUR");
      await setEuroLegsProvisional(true);

      const flows = await asUser(() =>
        sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
      );

      expect(flows.provisionalCount).toBe(0);
    });

    it("counts both EUR legs in the monthly category breakdown, and none once confirmed", async () => {
      await seed("EUR");
      const read = () =>
        asUser(() =>
          breakdown.getMonthlyCategoryBreakdown(userId, START, END, {
            accountIds: [euId],
          }),
        );

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      expect(provisional.transfers).toEqual([
        expect.objectContaining({ direction: "to", total: -180 }),
      ]);
      expect(provisional.provisionalCount).toBe(2);
      expect(confirmed.provisionalCount).toBe(0);
      // Both sides together: the US legs are confirmed, so still two.
      await setEuroLegsProvisional(true);
      const both = await asUser(() =>
        breakdown.getMonthlyCategoryBreakdown(userId, START, END),
      );
      expect(both.provisionalCount).toBe(2);
    });

    it("counts the tagged EUR leg in its Income vs Expenses bucket, and none once confirmed", async () => {
      await seed("EUR");
      await tag("transaction_id", await plainInId());
      const read = () =>
        asUser(() =>
          income.getIncomeVsExpenses(userId, START, END, {
            tagKey: "scope",
            accountIds: [euId],
          }),
        );

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      const home = provisional.buckets?.find((b) => b.value === "home");
      expect(home?.taggedInflows).toBe(90);
      expect(home?.provisionalCount).toBe(1);
      expect(
        confirmed.buckets?.find((b) => b.value === "home")?.provisionalCount,
      ).toBe(0);
    });

    it("counts the EUR leg in its account's row of a payee's panel, and none once confirmed", async () => {
      await seed("EUR");
      // The incoming leg carries the payee too, as a recorded transfer's do.
      await dataSource.query(
        `UPDATE transactions SET payee_id = $1, payee_name = 'Exchange' WHERE id = $2`,
        [payeeId, await plainInId()],
      );
      const read = async () =>
        (
          await asUser(() =>
            new PayeeDetailService(dataSource, {
              findOne: async () => ({ id: payeeId }),
            } as never).getDetail(userId, payeeId),
          )
        ).accounts
          .map((r) => [r.accountName, r.total, r.provisionalCount])
          // The panel ranks accounts by transaction count, and these two hold
          // one row each: their order is the GROUP BY's, which PostgreSQL does
          // not fix. This spec is about the count, so it reads them by name.
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      expect(provisional).toEqual([
        ["Euro Savings", 90, 1],
        ["US Chequing", -100, 0],
      ]);
      expect(confirmed).toEqual([
        ["Euro Savings", 90, 0],
        ["US Chequing", -100, 0],
      ]);
    });

    it("counts both EUR legs in a budget's transfer income from US Chequing, and none once confirmed", async () => {
      await seed("EUR");
      const budget = await dataSource.manager.save(
        dataSource.manager.create(Budget, {
          userId,
          name: "March",
          budgetType: BudgetType.MONTHLY,
          periodStart: START,
          currencyCode: "EUR",
          config: {},
        } as Partial<Budget>),
      );
      const line = {
        id: "bc-from-us",
        budgetId: budget.id,
        categoryId: null,
        isTransfer: true,
        isIncome: true,
        transferAccountId: usId,
      } as unknown as BudgetCategory;
      const read = () =>
        asUser(() =>
          withScopedDb(dataSource, (m) =>
            queryCategorySpending(
              m.getRepository(Transaction),
              m.getRepository(TransactionSplit),
              userId,
              [line],
              START,
              END,
            ),
          ),
        );

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      expect(provisional.transferIncomeMap.get(usId)).toBe(180);
      expect(provisional.transferIncomeProvisionalCounts.get(usId)).toBe(2);
      expect(provisional.provisionalCount).toBe(2);
      expect(confirmed.transferIncomeProvisionalCounts.get(usId)).toBe(
        undefined,
      );
      expect(confirmed.provisionalCount).toBe(0);
    });

    it("counts the outgoing USD estimate in a budget's transfer actuals when the EUR file came first", async () => {
      await seed("EUR");
      // The EUR file's import estimated the plain transfer's USD leg.
      await dataSource.query(
        `UPDATE transactions SET amount_is_provisional = $2 WHERE id = $1`,
        [plainOutId, true],
      );
      const budget = await dataSource.manager.save(
        dataSource.manager.create(Budget, {
          userId,
          name: "March",
          budgetType: BudgetType.MONTHLY,
          periodStart: START,
          currencyCode: "EUR",
          config: {},
        } as Partial<Budget>),
      );
      const line = {
        id: "bc-savings",
        budgetId: budget.id,
        categoryId: null,
        isTransfer: true,
        transferAccountId: euId,
      } as unknown as BudgetCategory;
      const read = () =>
        asUser(() =>
          withScopedDb(dataSource, (m) =>
            queryCategorySpending(
              m.getRepository(Transaction),
              m.getRepository(TransactionSplit),
              userId,
              [line],
              START,
              END,
            ),
          ),
        );

      const provisional = await read();
      await dataSource.query(
        `UPDATE transactions SET amount_is_provisional = $2 WHERE id = $1`,
        [plainOutId, false],
      );
      const confirmed = await read();

      // The plain leg and the split's transfer line, each at what arrived.
      expect(provisional.transferSpendingMap.get(euId)).toBe(180);
      expect(provisional.transferProvisionalCounts.get(euId)).toBe(1);
      expect(provisional.provisionalCount).toBe(1);
      expect(confirmed.transferProvisionalCounts.get(euId)).toBe(undefined);
      expect(confirmed.provisionalCount).toBe(0);
    });

    it("counts both EUR legs in the euro's usage summary, and none once confirmed", async () => {
      await seed("EUR");
      const currencyDetail = new CurrencyDetailService(dataSource, {
        getRateIndex: () => Promise.resolve(new Map()),
      } as never);
      const read = () =>
        asUser(() => currencyDetail.getUsageSummary(userId, "EUR"));

      await setEuroLegsProvisional(true);
      const provisional = await read();
      await setEuroLegsProvisional(false);
      const confirmed = await read();

      expect(provisional).toMatchObject({
        transactionCount: 2,
        totalInCurrency: 180,
        provisionalCount: 2,
      });
      expect(confirmed.provisionalCount).toBe(0);
    });
  });
});
