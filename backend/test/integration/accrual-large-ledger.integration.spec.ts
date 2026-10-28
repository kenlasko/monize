import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { readReportingDetails } from "@/accruals/reporting-details";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestAccount } from "../helpers/test-factories";
import { withScopedDb } from "@/common/db/scoped-db";
import type { TransactionsService } from "@/transactions/transactions.service";

describe("accrual register on a realistic ledger (PostgreSQL, enforced RLS)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  let sourceId: string;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
    await f.reset();
    await f.h.owner.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    // Entity synchronization omits ordinary production indexes. Apply the
    // canonical schema's indexes so this measures the shipping query shape.
    const schema = readFileSync(
      join(__dirname, "../../../database/schema.sql"),
      "utf8",
    );
    for (const match of schema.matchAll(
      /^CREATE INDEX(?: IF NOT EXISTS)? \w+ ON (?:transactions|transaction_splits|transaction_tags|transaction_split_tags|investment_transactions|accrual_allocations|accrual_schedules)\b[\s\S]*?;/gm,
    ))
      await f.h.owner.query(
        match[0].replace(
          /^CREATE INDEX(?: IF NOT EXISTS)?/,
          "CREATE INDEX IF NOT EXISTS",
        ),
      );

    const background = await createTestAccount(f.h.owner, f.user, {
      name: "Background ledger",
    });
    await f.h.owner.query(
      `INSERT INTO transactions(user_id,account_id,transaction_date,amount,currency_code,category_id,description)
      SELECT $1,$2,'2026-06-15',-10,'USD',$3,'Register '||g FROM generate_series(1,641) g`,
      [f.user, f.account, f.root],
    );
    await f.h.owner.query(
      `WITH seeded AS (
      INSERT INTO transactions(user_id,account_id,transaction_date,amount,currency_code,category_id,is_split,description)
      SELECT $1,$2,DATE '2025-01-01'+(g%365),-10,'USD',$3,g<=5141,'Background '||g
      FROM generate_series(1,35097) g RETURNING id,is_split,description
    ) INSERT INTO transaction_splits(transaction_id,category_id,amount)
      SELECT t.id,$3,CASE WHEN t.description='Background 5141' THEN -10 ELSE -5 END
      FROM seeded t CROSS JOIN LATERAL generate_series(1,CASE WHEN t.description='Background 5141' THEN 1 ELSE 2 END) leg
      WHERE t.is_split`,
      [f.user, background.id, f.root],
    );
    const [source] = await f.h.owner.query(
      "SELECT id FROM transactions WHERE account_id=$1 ORDER BY id LIMIT 1",
      [f.account],
    );
    sourceId = source.id;
    await f.h.owner.query("ANALYZE transactions");
    await f.h.owner.query("ANALYZE transaction_splits");
  });
  afterAll(async () => f?.close());

  async function page(
    enabled: boolean,
    scheduleCount: number,
    expectedTotal = scheduleCount ? 652 : 641,
    basis: "cash" | "accrual" = "accrual",
  ) {
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis,accrual_enabled) VALUES($1,'accrual',$2) ON CONFLICT(user_id) DO UPDATE SET reporting_basis='accrual',accrual_enabled=$2",
      [f.user, enabled],
    );
    if (scheduleCount) await f.accrue(sourceId);
    const args: Parameters<TransactionsService["findAll"]> = [
      f.user,
      [f.account],
    ];
    args[22] = basis;
    return f.as(() =>
      withScopedDb(f.h.app, async (manager) => {
        await manager.query("SET LOCAL statement_timeout = '8s'");
        const [setting] = await manager.query(
          "SELECT current_setting('jit') AS jit",
        );
        const began = performance.now();
        const result = await f.transactions.findAll(...args);
        const elapsed = performance.now() - began;
        expect(result.data).toHaveLength(50);
        expect(result.pagination.total).toBe(expectedTotal);
        expect(elapsed).toBeLessThan(5000);
        expect(
          await manager.query("SELECT current_setting('jit') AS jit"),
        ).toEqual([setting]);
      }),
    );
  }
  it("uses native queries when the feature is disabled despite a stored accrual preference", async () =>
    page(false, 0));
  it("does not rebuild the ledger when enabled with no schedules", async () =>
    page(true, 0));
  it("stays bounded after the first schedule is added", async () =>
    page(true, 1));
  it("uses native cash queries with an existing schedule when disabled", async () =>
    page(false, 0, 641));
  it("keeps the explicit cash view native with schedules enabled", async () =>
    page(true, 0, 641, "cash"));
  it("stays bounded when a visible transaction has accrued splits", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.child],
    });
    await f.accrue(tx.id, lines[0].id);
    await page(true, 0, 665);
  });
  it("stays bounded with one hundred additional schedules", async () => {
    await f.h.owner.query(
      `WITH targets AS (
        SELECT id FROM transactions WHERE account_id=$1 AND NOT is_split AND id<>$2 ORDER BY id LIMIT 100
      ), added AS (
        INSERT INTO accrual_schedules(user_id,source_transaction_id,family,currency_code,preset,recognition_date_rule,start_month,month_count,source_fingerprint)
        SELECT s.user_id,t.id,s.family,s.currency_code,s.preset,s.recognition_date_rule,s.start_month,s.month_count,s.source_fingerprint
        FROM targets t CROSS JOIN accrual_schedules s WHERE s.source_transaction_id=$2 AND s.source_split_id IS NULL
        RETURNING id,user_id
      ) INSERT INTO accrual_allocations(user_id,schedule_id,period_index,recognition_date,amount)
        SELECT n.user_id,n.id,a.period_index,a.recognition_date,a.amount FROM added n
        CROSS JOIN accrual_schedules s JOIN accrual_allocations a ON a.schedule_id=s.id
        WHERE s.source_transaction_id=$2 AND s.source_split_id IS NULL`,
      [f.account, sourceId],
    );
    await page(true, 0, 1765);
  });
  it("keeps category reporting and source-linked exports bounded with many schedules", async () => {
    const currency = new ReportCurrencyService(
      f.h.app,
      f.h.module.get(ExchangeRateService),
    );
    const spending = new SpendingReportsService(f.h.app, currency);
    await f.as(() =>
      withScopedDb(f.h.app, async (manager) => {
        await manager.query("SET LOCAL statement_timeout='8s'");
        const [setting] = await manager.query(
          "SELECT current_setting('jit') AS jit",
        );
        const began = performance.now();
        const report = await spending.getSpendingByCategory(
          f.user,
          "2027-01-01",
          "2027-01-31",
        );
        expect(report.totalSpending).toBeGreaterThan(0);
        const detail = await readReportingDetails(manager, f.user, {
          startDate: "2027-01-01",
          endDate: "2027-01-31",
          basis: "accrual",
          accountIds: [f.account],
        });
        expect(detail.rows.length).toBeGreaterThan(100);
        expect(detail.basis).toBe("accrual");
        expect(performance.now() - began).toBeLessThan(5000);
        expect(
          await manager.query("SELECT current_setting('jit') AS jit"),
        ).toEqual([setting]);
      }),
    );
  });
});
