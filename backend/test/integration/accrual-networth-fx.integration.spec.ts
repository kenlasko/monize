import { randomUUID } from "node:crypto";
import { withUserContext } from "@/common/db/with-context";
import { createTestUserDirect } from "../helpers/integration-setup";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { BudgetsModule } from "@/budgets/budgets.module";
import { ReportsModule } from "@/reports/reports.module";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { Budget } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import {
  BudgetPeriod,
  PeriodStatus,
} from "@/budgets/entities/budget-period.entity";
import { BudgetTrendReportsService } from "@/budgets/budget-trend-reports.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
} from "@/reports/entities/custom-report.entity";
import { withReportingRead } from "@/accruals/reporting-basis";
import { withScopedDb } from "@/common/db/scoped-db";
import { accrualNetWorthSnapshots } from "@/accruals/reporting-net-worth";

describe("Accrual net-worth and dated budget/custom-report FX, enforced PostgreSQL", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([BudgetsModule, ReportsModule]);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const worth = () => f.h.module.get(NetWorthService);
  const readWorth = () =>
    f.as(() =>
      worth().getMonthlyNetWorth(
        f.user,
        "2026-06-01",
        "2026-07-31",
        undefined,
        { fetchMissing: false },
      ),
    );
  async function schedule(
    id: string,
    preset: "LTM" | "NTM",
    family: "expense" | "income",
  ) {
    const input = { sourceTransactionId: id, preset, family };
    const preview = await f.as(() => f.accruals.preview(f.user, input));
    await f.as(() =>
      f.accruals.save(f.user, {
        ...input,
        fingerprint: preview.fingerprint,
        expectedScheduleId: preview.expectedScheduleId,
        expectedRevision: preview.expectedRevision,
      }),
    );
  }
  it("overlays prepaid balances, preserves four decimals and immediately follows reviewed source edits", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const bank = await f.bank();
    const initial = await readWorth();
    expect(initial.map((m) => m.netWorth)).toEqual([900, 800]);
    expect(await f.bank()).toBe(bank);
    const cash = await f.as(() =>
      withReportingRead(
        f.h.app,
        f.user,
        () =>
          worth().getMonthlyNetWorth(
            f.user,
            "2026-06-01",
            "2026-06-30",
            undefined,
            { fetchMissing: false },
          ),
        "cash",
      ),
    );
    expect(cash[0].netWorth).toBe(-200.0001);
    const patch = { amount: -2400.0001 };
    const preview = await f.as(() =>
      f.accruals.previewSourceEdit(f.user, tx.id, patch),
    );
    await f.as(() =>
      f.transactions.update(f.user, tx.id, {
        ...patch,
        accrualImpactFingerprint: preview.fingerprint!,
      }),
    );
    expect((await readWorth()).map((m) => m.netWorth)).toEqual([800, 600]);
  });
  it("latest accrual net worth follows today's recognition even when the newest cached cash month is old", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await readWorth();
    await f.h.owner.query(
      "DELETE FROM monthly_account_balances WHERE user_id=$1 AND month>'2026-06-01'",
      [f.user],
    );
    const [today] = await f.h.owner.query(
      "SELECT TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS date",
    );
    const monthly = await f.as(() =>
      worth().getMonthlyNetWorth(f.user, today.date, today.date, undefined, {
        fetchMissing: false,
      }),
    );
    const latest = await f.as(() => worth().getLatestNetWorth(f.user));
    expect(latest).toMatchObject({
      assets: monthly[0].assets,
      liabilities: monthly[0].liabilities,
      netWorth: monthly[0].netWorth,
      fxComplete: true,
      missingRatePairs: [],
    });
  });
  it("backward expense recognition extends history and nets the timing balance to zero by payment month", async () => {
    const { tx } = await f.source();
    await schedule(tx.id, "LTM", "expense");
    const rows = await f.as(() =>
      worth().getMonthlyNetWorth(
        f.user,
        "2025-07-01",
        "2026-06-30",
        undefined,
        { fetchMissing: false },
      ),
    );
    expect(rows).toHaveLength(12);
    expect(rows[0].netWorth).toBe(900);
    expect(rows[11].netWorth).toBe(-200.0001);
  });
  it("forward income is an unearned liability", async () => {
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: 1200,
        categoryId: f.income,
      }),
    );
    await schedule(tx.id, "NTM", "income");
    const rows = await readWorth();
    expect(rows[0]).toMatchObject({
      assets: 2200,
      liabilities: 1100,
      netWorth: 1100,
    });
  });
  it("backward income preserves a negative liability until payment clears it", async () => {
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: 1200,
        categoryId: f.income,
      }),
    );
    await schedule(tx.id, "LTM", "income");
    const rows = await f.as(() =>
      worth().getMonthlyNetWorth(
        f.user,
        "2025-07-01",
        "2026-06-30",
        undefined,
        { fetchMissing: false },
      ),
    );
    expect(rows[0]).toMatchObject({
      assets: 1000,
      liabilities: -100,
      netWorth: 1100,
    });
    expect(rows[11]).toMatchObject({
      assets: 2200,
      liabilities: 0,
      netWorth: 2200,
    });
  });
  it("removing an accrual clears its timing overlay without changing the bank entry", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    expect((await readWorth())[0].netWorth).toBe(900);
    const [{ id }] = await f.states(tx.id);
    const detail = await f.as(() => f.accruals.detail(f.user, id));
    const bank = await f.bank();
    await f.as(() =>
      f.accruals.remove(f.user, id, {
        fingerprint: detail.fingerprint,
        expectedRevision: detail.schedule.revision,
      }),
    );
    expect((await readWorth())[0].netWorth).toBe(-200.0001);
    expect(await f.bank()).toBe(bank);
  });
  it("excluded originating accounts contribute neither cash nor timing balances", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.h.owner.query(
      "UPDATE accounts SET exclude_from_net_worth=true WHERE id=$1",
      [f.account],
    );
    expect(await readWorth()).toEqual([]);
  });
  it("joint timing follows authorized scope, including exclusions and immediate grant revocation", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const grantee = (await createTestUserDirect(f.h.owner)).id,
      delegation = randomUUID();
    await f.h.owner.query(
      "INSERT INTO account_delegates(id,owner_user_id,delegate_user_id,status) VALUES($1,$2,$3,'active')",
      [delegation, f.user, grantee],
    );
    await f.h.owner.query(
      "INSERT INTO account_delegate_grants(delegation_id,account_id,can_read,is_joint) VALUES($1,$2,true,true)",
      [delegation, f.account],
    );
    await f.h.owner.query(
      "UPDATE accounts SET exclude_from_net_worth=true WHERE id=$1",
      [f.account],
    );
    const read = () =>
      withUserContext(grantee, () =>
        withScopedDb(f.h.app, (m) =>
          accrualNetWorthSnapshots(m, grantee, [], "2026-06-01", "2026-06-30", [
            f.account,
          ]),
        ),
      );
    const rows = await read();
    expect(rows.find((row) => row.timing_family === "expense")?.balance).toBe(
      "1100.0001",
    );
    expect(rows.find((row) => row.account_id === f.account)?.balance).toBe(
      "-200.0001",
    );
    await f.h.owner.query(
      "UPDATE account_delegate_grants SET can_read=false WHERE delegation_id=$1",
      [delegation],
    );
    expect(await read()).toEqual([]);
  });
  it("does not invent missing historical investment valuations", async () => {
    const { tx } = await f.source();
    await schedule(tx.id, "LTM", "expense");
    await f.h.owner.query(
      "UPDATE accounts SET account_type='INVESTMENT' WHERE id=$1",
      [f.account],
    );
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, (m) =>
          accrualNetWorthSnapshots(m, f.user, [], "2025-07-01", "2026-06-30"),
        ),
      ),
    ).rejects.toMatchObject({
      response: {
        code: "REPORTING_BALANCE_HISTORY_INCOMPLETE",
        accountId: f.account,
      },
    });
  });
  it("clamps the current monthly point to today and never recognizes a future month-end early", async () => {
    const [clock] = await f.h.owner.query(
      "SELECT TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS today,TO_CHAR(date_trunc('month',CURRENT_DATE),'YYYY-MM-DD') AS first,TO_CHAR((date_trunc('month',CURRENT_DATE)+INTERVAL '1 month - 1 day')::date,'YYYY-MM-DD') AS last,TO_CHAR((CURRENT_DATE+INTERVAL '2 months')::date,'YYYY-MM-DD') AS future",
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
    const rows = await f.as(() =>
      worth().getMonthlyNetWorth(f.user, clock.first, clock.future, undefined, {
        fetchMissing: false,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].netWorth).toBe(clock.today === clock.last ? 900 : 1000);
  });
  it("converts native cash and timing balances at the same historical valuation date", async () => {
    await fxSetup();
    const rows = await readWorth();
    expect(rows.map((row) => row.netWorth)).toEqual([720, 720]);
    expect(rows.every((row) => row.fxComplete)).toBe(true);
  });
  it("withholds accrual net worth with dated repair metadata when valuation FX is missing", async () => {
    await fxSetup();
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    await expect(readWorth()).rejects.toMatchObject({
      response: {
        code: "REPORTING_FX_INCOMPLETE",
        fxComplete: false,
        repair: "currency_rate_history",
        missingRatePairs: expect.arrayContaining([
          expect.objectContaining({ date: "2026-06-30" }),
        ]),
      },
    });
  });
  async function fxSetup() {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('EUR','Euro','E',2) ON CONFLICT DO NOTHING",
    );
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,default_currency) VALUES($1,'EUR') ON CONFLICT(user_id) DO UPDATE SET default_currency='EUR'",
      [f.user],
    );
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE (from_currency='USD' AND to_currency='EUR') OR (from_currency='EUR' AND to_currency='USD')",
    );
    await f.h.owner.query(
      "INSERT INTO exchange_rates(from_currency,to_currency,rate,rate_date) VALUES('USD','EUR',0.8,'2026-06-30'),('USD','EUR',0.9,'2026-07-31')",
    );
    const budget = await f.h.owner.getRepository(Budget).save({
      userId: f.user,
      name: "EUR budget",
      currencyCode: "EUR",
      periodStart: "2026-06-01",
    });
    await f.h.owner
      .getRepository(BudgetCategory)
      .save({ budgetId: budget.id, categoryId: f.root, amount: 150 });
    for (const [start, end] of [
      ["2026-06-01", "2026-06-30"],
      ["2026-07-01", "2026-07-31"],
    ])
      await f.h.owner.getRepository(BudgetPeriod).save({
        budgetId: budget.id,
        periodStart: start,
        periodEnd: end,
        status: PeriodStatus.CLOSED,
        actualExpenses: 999,
      });
    const report = await f.h.owner.getRepository(CustomReport).save({
      userId: f.user,
      name: "Dated EUR",
      timeframeType: TimeframeType.CUSTOM,
      groupBy: GroupByType.CATEGORY,
      filters: {},
      config: {
        metric: MetricType.TOTAL_AMOUNT,
        direction: DirectionFilter.EXPENSES_ONLY,
        includeTransfers: false,
        customStartDate: "2026-06-01",
        customEndDate: "2026-07-31",
      },
    });
    return { budget, report };
  }
  it("budgets and custom reports convert recognition components at their own dates", async () => {
    const { budget, report } = await fxSetup();
    const trend = await f.as(() =>
      f.h.module.get(BudgetTrendReportsService).getTrend(f.user, budget.id, 12),
    );
    expect(trend.map((p) => p.actual)).toEqual([80, 90]);
    const custom = await f.as(() =>
      f.h.module.get(ReportsService).execute(f.user, report.id),
    );
    expect(custom.currency).toBe("EUR");
    expect(custom.data.reduce((sum, row) => sum + row.value, 0)).toBe(170);
  });
  it("nets direct expenses with split refunds after conversion and keeps custom source values unchanged", async () => {
    const { budget, report } = await fxSetup();
    await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-30",
        amount: 50,
        splits: [
          { amount: 25, categoryId: f.root },
          { amount: 25, categoryId: f.other },
        ],
      }),
    );
    const closed = await f.as(() =>
      f.h.module.get(BudgetTrendReportsService).getTrend(f.user, budget.id, 12),
    );
    expect(closed[0].actual).toBe(60);
    await f.h.owner.query("DELETE FROM budget_periods WHERE budget_id=$1", [
      budget.id,
    ]);
    await f.h.owner.query(
      "INSERT INTO exchange_rates(from_currency,to_currency,rate,rate_date) SELECT 'USD','EUR',0.9,LEAST((m+INTERVAL '1 month - 1 day')::date,CURRENT_DATE) FROM generate_series('2026-08-01'::date,date_trunc('month',CURRENT_DATE),INTERVAL '1 month') m ON CONFLICT DO NOTHING",
    );
    const live = await f.as(() =>
      f.h.module.get(BudgetTrendReportsService).getTrend(f.user, budget.id, 12),
    );
    expect(live.find((row) => row.monthKey === "2026-06")?.actual).toBe(60);
    const trend = await f.as(() =>
      f.h.module
        .get(BudgetTrendReportsService)
        .getCategoryTrend(f.user, budget.id, 12),
    );
    expect(
      trend[0].data.find((row) => row.monthKey === "2026-06")?.actual,
    ).toBe(60);
    const result = await f.as(() =>
      f.h.module.get(ReportsService).execute(f.user, report.id),
    );
    // The refunded category nets 20 EUR against 170 EUR of expense; the other credit is not spending.
    expect(result.data.reduce((total, row) => total + row.value, 0)).toBe(150);
    const [{ amount }] = await f.h.owner.query(
      "SELECT amount::text AS amount FROM transactions WHERE user_id=$1 AND amount<0",
      [f.user],
    );
    expect(amount).toBe("-1200.0001");
  });
  it("withholds missing FX instead of returning a mixed-unit budget or custom report; COUNT remains available", async () => {
    const { budget, report } = await fxSetup();
    await f.h.owner.query(
      "DELETE FROM exchange_rates WHERE from_currency IN ('USD','EUR') AND to_currency IN ('USD','EUR')",
    );
    await expect(
      f.as(() =>
        f.h.module
          .get(BudgetTrendReportsService)
          .getTrend(f.user, budget.id, 12),
      ),
    ).rejects.toMatchObject({ response: { code: "REPORTING_FX_INCOMPLETE" } });
    await expect(
      f.as(() => f.h.module.get(ReportsService).execute(f.user, report.id)),
    ).rejects.toMatchObject({ response: { code: "REPORTING_FX_INCOMPLETE" } });
    await f.h.owner.getRepository(CustomReport).update(report.id, {
      config: { ...report.config, metric: MetricType.COUNT },
    });
    const count = await f.as(() =>
      f.h.module.get(ReportsService).execute(f.user, report.id),
    );
    expect(count.data.reduce((sum, row) => sum + row.value, 0)).toBe(2);
    expect(count.data[0].percentage).toBe(100);
    expect(count.fxComplete).toBe(true);
    expect(count.missingCurrencies).toEqual([]);
  });
});
