import { BudgetReportsService } from "@/budgets/budget-reports.service";
import { Budget } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestAccount } from "../helpers/test-factories";
import { BuiltInReportsModule } from "@/built-in-reports/built-in-reports.module";
import { BuiltInReportsService } from "@/built-in-reports/built-in-reports.service";
import { ReportsModule } from "@/reports/reports.module";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
} from "@/reports/entities/custom-report.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { reportingQuery, reportingEntities } from "@/accruals/reporting-query";
import { McpReportsTools } from "@/mcp/tools/reports.tool";
import { ToolExecutorService } from "@/ai/query/tool-executor.service";
import { mcpTestCtx } from "@/mcp/testing/mcp-test-context";
import { Security } from "@/securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "@/securities/entities/investment-transaction.entity";
import { AccountType } from "@/accounts/entities/account.entity";

describe("Accrual source provenance, reconciliation and cross-surface basis under enforced RLS", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([
      BuiltInReportsModule,
      ReportsModule,
    ]);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const reports = () => f.h.module.get(BuiltInReportsService);
  const details = (
    input: Partial<Parameters<typeof f.accruals.reportingDetails>[1]> = {},
  ) =>
    f.as(() =>
      f.accruals.reportingDetails(f.user, {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        ...input,
      }),
    );
  it("filters recognition components by category family and uncategorized status", async () => {
    const categorized = await f.source();
    const uncategorized = await f.source({ categoryId: null });
    const income = await f.source({ categoryId: f.income });
    await f.accrue(categorized.tx.id);
    expect(
      (await details({ basis: "accrual", categoryType: "income" })).rows.map(
        (row) => row.sourceTransactionId,
      ),
    ).toEqual([income.tx.id]);
    const expense = await details({
      basis: "accrual",
      categoryType: "expense",
    });
    expect(new Set(expense.rows.map((row) => row.sourceTransactionId))).toEqual(
      new Set([categorized.tx.id, uncategorized.tx.id]),
    );
    expect(
      (await details({ uncategorized: true })).rows.map(
        (row) => row.sourceTransactionId,
      ),
    ).toEqual([uncategorized.tx.id]);
    expect(
      (await details({ uncategorized: true, categoryIds: [f.root] })).rows,
    ).toEqual([]);
    expect(
      (await details({ uncategorized: false })).rows.length,
    ).toBeGreaterThan(1);
  });
  async function preference(basis: "cash" | "accrual", currency = "USD") {
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis,default_currency) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET reporting_basis=EXCLUDED.reporting_basis,default_currency=EXCLUDED.default_currency",
      [f.user, basis, currency],
    );
  }
  async function euros() {
    await f.h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('EUR','Euro','E',2) ON CONFLICT DO NOTHING",
    );
    await preference("accrual", "EUR");
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    await f.h.owner.query(
      "INSERT INTO exchange_rates(from_currency,to_currency,rate,rate_date) VALUES('USD','EUR',0.8,'2026-06-30'),('USD','EUR',0.9,'2026-07-31')",
    );
  }
  it("returns stable read-only source/schedule identities and reconciles dated detail amounts with the built-in total", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await euros();
    const result = await details({ sourceTransactionIds: [tx.id] });
    expect(result).toMatchObject({
      basis: "accrual",
      currency: "EUR",
      total: -170,
      knownSubtotal: -170,
      fxComplete: true,
      readOnly: true,
    });
    expect(result.rows.map((row) => row.effectiveDate)).toEqual([
      "2026-06-30",
      "2026-07-31",
    ]);
    expect(
      result.rows.every(
        (row) =>
          row.sourceTransactionId === tx.id &&
          row.scheduleId &&
          row.sourceAmount === "-1200.0001" &&
          row.readOnly,
      ),
    ).toBe(true);
    expect(result.rows.map((row) => row.conversion?.observedOn)).toEqual([
      "2026-06-30",
      "2026-07-31",
    ]);
    const total = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "spending_by_category",
        startDate: "2026-06-01",
        endDate: "2026-07-31",
      }),
    );
    expect((total.result as { totalSpending: number }).totalSpending).toBe(
      -result.total!,
    );
  });
  it("resolves the preference and honors explicit cash/accrual without updating the stored default", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await preference("cash");
    expect((await details()).total).toBe(-1200.0001);
    expect((await details({ basis: "accrual" })).total).toBe(-200);
    const report = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "income_vs_expenses",
        basis: "accrual",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      }),
    );
    expect(report.basis).toBe("accrual");
    expect(
      (
        await f.h.owner.query(
          "SELECT reporting_basis AS basis FROM user_preferences WHERE user_id=$1",
          [f.user],
        )
      )[0].basis,
    ).toBe("cash");
  });
  it("keeps unscheduled split siblings on the cash date and filters split tags without leaking sibling rows", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    const tag = randomUUID();
    await f.h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'Scheduled line')",
      [tag, f.user],
    );
    await f.h.owner.query(
      "INSERT INTO transaction_split_tags(transaction_split_id,tag_id) VALUES($1,$2)",
      [lines[0].id, tag],
    );
    const all = await details();
    expect(all.total).toBe(-700.0001);
    expect(all.rows).toHaveLength(3);
    const tagged = await details({ tagIds: [tag] });
    expect(tagged.total).toBe(-100);
    expect(tagged.rows).toHaveLength(2);
    expect(
      tagged.rows.every(
        (row) => row.sourceSplitId === lines[0].id && row.scheduleId,
      ),
    ).toBe(true);
  });
  it("excludes asset-value split categories consistently from payee totals and component details", async () => {
    const asset = await createTestAccount(f.h.owner, f.user, {
      name: "Asset",
      accountType: AccountType.ASSET,
      openingBalance: 0,
      currentBalance: 0,
    });
    await f.h.owner.query(
      "UPDATE accounts SET asset_category_id=$1 WHERE id=$2",
      [f.other, asset.id],
    );
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    const detail = await details();
    expect(detail.total).toBe(-100);
    const report = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "spending_by_payee",
        startDate: "2026-06-01",
        endDate: "2026-07-31",
      }),
    );
    expect((report.result as { totalSpending: number }).totalSpending).toBe(
      100,
    );
  });
  it("expands category descendants so rolled category details reconcile with totals", async () => {
    const { tx } = await f.source({ categoryId: f.grandchild });
    await f.accrue(tx.id);
    const detail = await details({ categoryIds: [f.root] });
    expect(detail.total).toBe(-200);
    expect(detail.rows.every((row) => row.categoryId === f.grandchild)).toBe(
      true,
    );
    const report = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "spending_by_category",
        startDate: "2026-06-01",
        endDate: "2026-07-31",
      }),
    );
    expect((report.result as { totalSpending: number }).totalSpending).toBe(
      -detail.total!,
    );
  });
  it("maps split-transfer joins through virtual parents while retaining original counterpart IDs for source drilldown", async () => {
    const other = await createTestAccount(f.h.owner, f.user, {
      name: "Other",
      openingBalance: 0,
      currentBalance: 0,
    });
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        splits: [
          { amount: -600, categoryId: f.root },
          { amount: -600, transferAccountId: other.id },
        ],
      }),
    );
    const [ordinary] = await f.h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 AND category_id=$2",
      [tx.id, f.root],
    );
    await f.accrue(tx.id, ordinary.id);
    const result = await details({
      sourceTransactionIds: [tx.id],
      kind: "all",
    });
    expect(result.rows.filter((row) => row.kind === "transfer")).toHaveLength(
      1,
    );
    expect(result.rows.filter((row) => row.kind === "ordinary")).toHaveLength(
      2,
    );
    const joined = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT t.id AS parent,s.id AS split,s.source_split_id AS source_split,other.id AS counterpart FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id JOIN transactions other ON other.id=s.linked_transaction_id WHERE t.source_transaction_id=$1 AND s.transfer_account_id IS NOT NULL",
          [tx.id],
        ),
      ),
    );
    expect(joined).toHaveLength(1);
    expect(joined[0].parent).not.toBe(tx.id);
    expect(joined[0].counterpart).toBe(
      result.rows.find((row) => row.kind === "transfer")?.linkedTransactionId,
    );
    const hydrated = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingEntities(
          m,
          f.user,
          m
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .leftJoinAndSelect("t.splits", "splits")
            .where("t.user_id=:user", { user: f.user }),
        ),
      ),
    );
    const projected = hydrated.filter((row) => row.id === tx.id);
    expect(projected).toHaveLength(13);
    expect(
      projected.every(
        (row) =>
          row.reportingProvenance?.sourceTransactionId === tx.id &&
          row.reportingProvenance.readOnly,
      ),
    ).toBe(true);
    expect(
      projected
        .flatMap((row) => row.splits)
        .every(
          (line) =>
            line.transactionId === tx.id &&
            line.reportingProvenance?.sourceSplitId === line.id,
        ),
    ).toBe(true);
  });
  it("keeps embedded investment backlinks on their original cash date and excludes them from ordinary detail/totals", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    const security = await f.h.owner.getRepository(Security).save({
      userId: f.user,
      symbol: "TEST",
      name: "Test security",
      currencyCode: "USD",
    });
    const brokerage = await createTestAccount(f.h.owner, f.user, {
      name: "Brokerage",
      accountType: AccountType.INVESTMENT,
      openingBalance: 0,
      currentBalance: 0,
    });
    await f.h.owner.query(
      "UPDATE transaction_splits SET kind='investment',category_id=NULL WHERE id=$1",
      [lines[1].id],
    );
    await f.h.owner.getRepository(InvestmentTransaction).save({
      userId: f.user,
      accountId: brokerage.id,
      transactionSplitId: lines[1].id,
      securityId: security.id,
      action: InvestmentAction.BUY,
      transactionDate: "2026-06-15",
      quantity: 1,
      price: 600.0001,
      totalAmount: 600.0001,
      commission: 0,
      exchangeRate: 1,
    });
    await f.accrue(tx.id, lines[0].id);
    const ordinary = await details();
    expect(ordinary.total).toBe(-100);
    const investment = await details({ kind: "investment" });
    expect(investment.rows).toHaveLength(1);
    expect(investment.rows[0].effectiveDate).toBe("2026-06-15");
    const copies = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingEntities(
          m,
          f.user,
          m
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .leftJoinAndSelect("t.splits", "splits")
            .leftJoinAndSelect(
              "splits.investmentTransaction",
              "embeddedInvestment",
            )
            .where("t.source_transaction_id=:id", { id: tx.id }),
        ),
      ),
    );
    const embedded = copies
      .flatMap((row) => row.splits)
      .filter((line) => line.investmentTransaction);
    expect(embedded).toHaveLength(1);
    expect(embedded[0].investmentTransaction?.transactionSplitId).toBe(
      lines[1].id,
    );
    const linked = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT count(*)::text AS count FROM investment_transactions i JOIN transaction_splits s ON s.id=i.transaction_split_id WHERE s.source_split_id=$1",
          [lines[1].id],
        ),
      ),
    );
    expect(linked[0].count).toBe("1");
  });
  it("keeps exact native totals and an explicitly withheld converted total when detail FX is missing", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await euros();
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    expect(await details()).toMatchObject({
      total: null,
      knownSubtotal: 0,
      fxComplete: false,
      byCurrency: { USD: -200 },
      repair: "currency_rate_history",
      fetchAttempted: false,
    });
  });
  it("refuses truncated detail totals and excludes foreign source IDs under enforced RLS", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await expect(details({ limit: 1 })).rejects.toMatchObject({
      response: { code: "REPORTING_ROW_LIMIT" },
    });
    expect(
      (await details({ sourceTransactionIds: [randomUUID()] })).rows,
    ).toEqual([]);
  });
  it("uses source-entered conversion provenance without applying a second fee", async () => {
    await euros();
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        categoryId: f.root,
        originalCurrencyCode: "EUR",
        originalAmount: -960,
        exchangeRate: 1.25,
      }),
    );
    await f.accrue(tx.id);
    const result = await details();
    expect(result.total).toBe(-160);
    expect(
      result.rows.every((row) => row.conversion?.source === "source"),
    ).toBe(true);
  });
  it("preserves per-component four-decimal rounding when detail and category totals are folded", async () => {
    await euros();
    for (const memo of ["one", "two"])
      await f.as(() =>
        f.transactions.create(f.user, {
          accountId: f.account,
          currencyCode: "USD",
          transactionDate: "2026-06-30",
          amount: -0.0001,
          description: memo,
          categoryId: f.root,
        }),
      );
    const detail = await details();
    const report = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "spending_by_category",
        startDate: "2026-06-01",
        endDate: "2026-07-31",
      }),
    );
    expect(detail.total).toBe(-0.0002);
    expect((report.result as { totalSpending: number }).totalSpending).toBe(
      0.0002,
    );
  });
  it("exports selected-basis results with source identities and spreadsheet-safe labels", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const custom = await f.h.owner.getRepository(CustomReport).save({
      userId: f.user,
      name: "Provenance",
      timeframeType: TimeframeType.CUSTOM,
      groupBy: GroupByType.NONE,
      filters: {},
      config: {
        metric: MetricType.NONE,
        direction: DirectionFilter.EXPENSES_ONLY,
        customStartDate: "2026-06-01",
        customEndDate: "2026-07-31",
      },
    });
    const service = f.h.module.get(ReportsService);
    const output = await f.as(() =>
      service.export(f.user, custom.id, { basis: "accrual" }),
    );
    expect(output).toMatchObject({
      basis: "accrual",
      currency: "USD",
      fxComplete: true,
    });
    expect(output.report.data).toHaveLength(2);
    expect(output.csv).toContain(tx.id);
    expect(
      output.report.data.every(
        (row) => row.reportingProvenance?.sourceTransactionId === tx.id,
      ),
    ).toBe(true);
    const cash = await f.as(() =>
      service.export(f.user, custom.id, { basis: "cash" }),
    );
    expect(cash.report.data).toHaveLength(1);
    expect(cash.report.summary.total).toBe(1200.0001);
  });
  it("returns identical real-domain basis and result envelopes through assistant and MCP adapters", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await preference("cash");
    const args = {
      type: "spending_by_category" as const,
      basis: "accrual" as const,
      startDate: "2026-06-01",
      endDate: "2026-07-31",
    };
    const assistant = Object.assign(
      Object.create(ToolExecutorService.prototype),
      {
        builtInReportsService: reports(),
        logger: new Logger("Reporting acceptance"),
      },
    ) as ToolExecutorService;
    const ai = await f.as(() =>
      assistant.execute(f.user, "generate_report", args),
    );
    let handler: any;
    new McpReportsTools(reports()).register({
      registerTool: (_name: unknown, _options: unknown, fn: unknown) => {
        handler = fn;
      },
    } as any);
    const mcp = await f.as<{ isError?: boolean; structuredContent: unknown }>(
      () => handler(args, mcpTestCtx({ userId: f.user, scopes: "read" })),
    );
    expect(ai.isError).toBeUndefined();
    expect(mcp.isError).toBeUndefined();
    expect(ai.data).toEqual(mcp.structuredContent);
    expect(ai.data).toMatchObject({
      basis: "accrual",
      currency: "USD",
      fxComplete: true,
      result: { totalSpending: 200 },
    });
  });
  it("declares anomalies as cash-only and refuses an explicit incompatible basis", async () => {
    const result = await f.as(() =>
      reports().getLlmReport(f.user, { type: "spending_anomalies" }),
    );
    expect(result.basis).toBe("cash");
    await expect(
      f.as(() =>
        reports().getLlmReport(f.user, {
          type: "spending_anomalies",
          basis: "accrual",
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: "REPORTING_BASIS_UNSUPPORTED" },
    });
  });
  it("applies explicit basis to the shared budget-status reader while retaining its own currency", async () => {
    const [clock] = await f.h.owner.query(
      "SELECT TO_CHAR(date_trunc('month',CURRENT_DATE),'YYYY-MM-DD') AS first",
    );
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: clock.first,
        amount: -1200,
        categoryId: f.root,
      }),
    );
    await f.accrue(tx.id);
    await preference("cash");
    const budget = await f.h.owner.getRepository(Budget).save({
      userId: f.user,
      name: "Basis budget",
      currencyCode: "USD",
      periodStart: clock.first,
    });
    await f.h.owner
      .getRepository(BudgetCategory)
      .save({ budgetId: budget.id, categoryId: f.root, amount: 150 });
    const service = f.h.module.get(BudgetReportsService);
    const accrual = await f.as(() =>
      service.getLlmBudgetStatus(f.user, "CURRENT", undefined, "accrual"),
    );
    const cash = await f.as(() =>
      service.getLlmBudgetStatus(f.user, "CURRENT", undefined, "cash"),
    );
    expect(accrual).toMatchObject({
      basis: "accrual",
      currency: "USD",
      totalSpent: 100,
    });
    expect(cash).toMatchObject({
      basis: "cash",
      currency: "USD",
      totalSpent: 1200,
    });
  });
  it("prices cash-only anomaly statistics at each cash date and refuses missing FX", async () => {
    await euros();
    for (const index of Array.from({ length: 10 }, (_, i) => i))
      await f.as(() =>
        f.transactions.create(f.user, {
          accountId: f.account,
          currencyCode: "USD",
          transactionDate: index < 5 ? "2026-06-30" : "2026-07-31",
          amount: index < 5 ? -100 : -120,
          categoryId: f.root,
        }),
      );
    const report = await f.as(() =>
      reports().getLlmReport(f.user, {
        type: "spending_anomalies",
        months: 12,
      }),
    );
    expect(report.basis).toBe("cash");
    expect(
      (report.result as { statistics: { mean: number } }).statistics.mean,
    ).toBe(94);
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    await expect(
      f.as(() =>
        reports().getLlmReport(f.user, {
          type: "spending_anomalies",
          months: 12,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "REPORTING_FX_INCOMPLETE" } });
  });
  it("converts explicit-basis period comparisons using the reporting currency instead of mixing native units", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await euros();
    const result = await f.as(() =>
      f.h.module
        .get(TransactionAnalyticsService)
        .getLlmPeriodComparison(f.user, {
          basis: "accrual",
          period1Start: "2026-06-01",
          period1End: "2026-06-30",
          period2Start: "2026-07-01",
          period2End: "2026-07-31",
        }),
    );
    expect(result).toMatchObject({
      basis: "accrual",
      currency: "EUR",
      period1: { total: 80 },
      period2: { total: 90 },
      totalChange: 10,
      fxComplete: true,
    });
  });
});
