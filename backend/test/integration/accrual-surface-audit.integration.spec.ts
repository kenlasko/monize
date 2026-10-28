import { BudgetsModule } from "@/budgets/budgets.module";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestAccount } from "../helpers/test-factories";
import { BuiltInReportsModule } from "@/built-in-reports/built-in-reports.module";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { BudgetReportsService } from "@/budgets/budget-reports.service";
import { Budget } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import {
  BudgetPeriod,
  PeriodStatus,
} from "@/budgets/entities/budget-period.entity";
import { BudgetPeriodCategory } from "@/budgets/entities/budget-period-category.entity";

describe("Final accrual reporting surface audit under enforced RLS", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([
      BuiltInReportsModule,
      BudgetsModule,
    ]);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const analytics = () => f.h.module.get(TransactionAnalyticsService);
  async function euros(basis = "accrual") {
    await f.h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('EUR','Euro','E',2) ON CONFLICT DO NOTHING",
    );
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis,default_currency) VALUES($1,$2,'EUR') ON CONFLICT(user_id) DO UPDATE SET reporting_basis=EXCLUDED.reporting_basis,default_currency='EUR'",
      [f.user, basis],
    );
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    await f.h.owner.query(
      "INSERT INTO exchange_rates(from_currency,to_currency,rate,rate_date) VALUES('USD','EUR',0.8,'2026-06-30'),('USD','EUR',0.9,'2026-07-31')",
    );
  }
  it("reconciles summary, monthly and assistant grouped totals at each recognition date", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await euros();
    const summary = await f.as(() =>
      analytics().getSummary(f.user, undefined, "2026-06-01", "2026-07-31"),
    );
    expect(summary).toMatchObject({
      basis: "accrual",
      currency: "EUR",
      fxComplete: true,
      totalExpenses: 170,
      netCashFlow: -170,
      transactionCount: 2,
      byCurrency: { USD: { totalExpenses: 200, transactionCount: 2 } },
    });
    const monthly = await f.as(() =>
      analytics().getMonthlyTotals(
        f.user,
        undefined,
        "2026-06-01",
        "2026-07-31",
      ),
    );
    expect(monthly).toEqual([
      { month: "2026-06", total: -80, count: 1 },
      { month: "2026-07", total: -90, count: 1 },
    ]);
    const grouped = await f.as(() =>
      analytics().getLlmQueryTransactions(f.user, {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        groupBy: "category",
        direction: "expenses",
      }),
    );
    expect(grouped).toMatchObject({
      currency: "EUR",
      fxComplete: true,
      totalExpenses: 170,
      breakdown: [{ categoryId: f.root, total: 170, count: 2 }],
    });
  });
  it("values mixed cash currencies before totals while retaining explicitly native breakdowns", async () => {
    await euros("cash");
    const euroAccount = await createTestAccount(f.h.owner, f.user, {
      name: "Euro cash",
      currencyCode: "EUR",
    });
    for (const [accountId, currencyCode, amount, date] of [
      [f.account, "USD", -100, "2026-06-30"],
      [euroAccount.id, "EUR", -50, "2026-07-31"],
    ] as const)
      await f.as(() =>
        f.transactions.create(f.user, {
          accountId,
          currencyCode,
          amount,
          transactionDate: date,
          categoryId: f.root,
        }),
      );
    const summary = await f.as(() => analytics().getSummary(f.user));
    expect(summary).toMatchObject({
      currency: "EUR",
      totalExpenses: 130,
      transactionCount: 2,
      byCurrency: { USD: { totalExpenses: 100 }, EUR: { totalExpenses: 50 } },
    });
    const listed = await f.as(() =>
      analytics().getLlmListTransactions(f.user, {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        groupBy: "month",
      }),
    );
    expect(listed).toMatchObject({
      basis: "cash",
      currency: "EUR",
      totalExpenses: 130,
      breakdown: [
        { month: "2026-06", total: 80 },
        { month: "2026-07", total: 50 },
      ],
    });
  });
  it("does not count several same-period split components as separate transactions", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    await f.accrue(tx.id, lines[1].id);
    await euros();
    const result = await f.as(() =>
      analytics().getSummary(f.user, undefined, "2026-06-01", "2026-07-31"),
    );
    expect(result).toMatchObject({
      transactionCount: 2,
      totalExpenses: 170,
      byCurrency: { USD: { transactionCount: 2, totalExpenses: 200 } },
    });
  });
  it("withholds summary, monthly and grouped figures with dated FX repair metadata", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await euros();
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    for (const read of [
      () =>
        analytics().getSummary(f.user, undefined, "2026-06-01", "2026-07-31"),
      () =>
        analytics().getMonthlyTotals(
          f.user,
          undefined,
          "2026-06-01",
          "2026-07-31",
        ),
      () =>
        analytics().getLlmQueryTransactions(f.user, {
          startDate: "2026-06-01",
          endDate: "2026-07-31",
          groupBy: "category",
        }),
    ])
      await expect(f.as<unknown>(read)).rejects.toMatchObject({
        response: {
          code: "REPORTING_FX_INCOMPLETE",
          fxComplete: false,
          repair: "currency_rate_history",
        },
      });
  });
  it("converts cash transfer rollup totals without relabeling native per-account balances", async () => {
    await euros("cash");
    const euroAccount = await createTestAccount(f.h.owner, f.user, {
      name: "Euro transfer",
      currencyCode: "EUR",
    });
    // Valid paired ledger identities; amounts need not be equal across currencies.
    await f.h.owner.query(
      "INSERT INTO transactions(user_id,account_id,transaction_date,amount,currency_code,is_transfer) VALUES($1,$2,'2026-06-30',-100,'USD',true),($1,$3,'2026-06-30',80,'EUR',true)",
      [f.user, f.account, euroAccount.id],
    );
    const result = await f.as(() =>
      analytics().getTransfersByAccount(f.user, "2026-06-01", "2026-07-31"),
    );
    expect(result).toMatchObject({
      basis: "cash",
      currency: "EUR",
      fxComplete: true,
      totalInbound: 80,
      totalOutbound: 80,
      transferCount: 2,
    });
    expect(result.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "USD", outbound: 100 }),
        expect.objectContaining({ currency: "EUR", inbound: 80 }),
      ]),
    );
  });
  it("uses the requested historical budget month, snapshot plan and selected recognition basis", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const budget = await f.h.owner.getRepository(Budget).save({
      userId: f.user,
      name: "Historical budget",
      currencyCode: "USD",
      periodStart: "2026-06-01",
    });
    const category = await f.h.owner
      .getRepository(BudgetCategory)
      .save({ budgetId: budget.id, categoryId: f.root, amount: 999 });
    const period = await f.h.owner.getRepository(BudgetPeriod).save({
      budgetId: budget.id,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      status: PeriodStatus.CLOSED,
      totalBudgeted: 275,
    });
    await f.h.owner.getRepository(BudgetPeriodCategory).save({
      budgetPeriodId: period.id,
      budgetCategoryId: category.id,
      categoryId: f.root,
      budgetedAmount: 250,
      effectiveBudget: 275,
      rolloverIn: 25,
    });
    const service = f.h.module.get(BudgetReportsService);
    const accrual = await f.as(() =>
      service.getLlmBudgetStatus(f.user, "2026-06", undefined, "accrual"),
    );
    const cash = await f.as(() =>
      service.getLlmBudgetStatus(f.user, "2026-06", undefined, "cash"),
    );
    expect(accrual).toMatchObject({
      period: { start: "2026-06-01", end: "2026-06-30" },
      totalBudgeted: 275,
      totalSpent: 100,
      remaining: 175,
    });
    expect(cash).toMatchObject({ totalBudgeted: 275, totalSpent: 1200.0001 });
    expect(accrual).not.toHaveProperty("velocity");
    expect(accrual).not.toHaveProperty("healthScore");
    await expect(
      f.as(() => service.getLlmBudgetStatus(f.user, "2026-13")),
    ).rejects.toMatchObject({ response: { code: "REPORTING_PERIOD_INVALID" } });
  });
  it("honors entered rates across summary, recognition groups and cash tool rows", async () => {
    await euros();
    const source = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        originalAmount: -1000,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.2,
        categoryId: f.root,
      }),
    );
    await f.accrue(source.id);
    const summary = await f.as(() =>
      analytics().getSummary(f.user, undefined, "2026-06-01", "2026-07-31"),
    );
    const grouped = await f.as(() =>
      analytics().getLlmQueryTransactions(f.user, {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        groupBy: "category",
        direction: "expenses",
      }),
    );
    expect(summary.totalExpenses).toBe(166.6666);
    expect(grouped).toMatchObject({
      currency: "EUR",
      totalExpenses: 166.6666,
      fxComplete: true,
      breakdown: [{ categoryId: f.root, total: 166.6666 }],
    });
    const cash = await f.as(() =>
      analytics().getLlmListTransactions(f.user, {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        groupBy: "month",
      }),
    );
    expect(cash).toMatchObject({
      basis: "cash",
      currency: "EUR",
      totalExpenses: 1000,
      fxComplete: true,
      breakdown: [{ month: "2026-06", total: 1000 }],
    });
  });
});
