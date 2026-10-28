import { createTestUserDirect } from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { readAccrualSystemBalances } from "@/accruals/reporting-system-balances";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { withScopedDb } from "@/common/db/scoped-db";
import {
  reportingQuery,
  reportingRawMany,
  reportingEntities,
} from "@/accruals/reporting-query";
import { withReportingRead } from "@/accruals/reporting-basis";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { randomUUID } from "node:crypto";

describe("Reporting recognition facts (enforced PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const read = (basis: "cash" | "accrual" = "accrual") =>
    f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT to_char(transaction_date,'YYYY-MM-DD') AS date,SUM(amount)::text AS amount FROM transactions WHERE user_id=$1 AND status IS DISTINCT FROM 'VOID' AND parent_transaction_id IS NULL GROUP BY transaction_date ORDER BY date",
          [f.user],
          basis,
        ),
      ),
    );
  it("replaces one cash payment with exact month-end recognition and preserves cash", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const bank = await f.bank();
    const rows = await read();
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ date: "2026-06-30", amount: "-100.0000" });
    expect(rows[11]).toEqual({ date: "2027-05-31", amount: "-100.0001" });
    expect(await read("cash")).toEqual([
      { date: "2026-06-15", amount: "-1200.0001" },
    ]);
    expect(await f.bank()).toBe(bank);
  });
  it("keeps unscheduled sibling money only on the payment date", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    const rows = await read();
    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({ date: "2026-06-15", amount: "-600.0001" });
    expect(rows[1]).toEqual({ date: "2026-06-30", amount: "-50.0000" });
    const total = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT SUM(s.amount)::text AS amount FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.user_id=$1 AND s.category_id=$2",
          [f.user, f.root],
        ),
      ),
    );
    expect(total[0].amount).toBe("-600.0000");
  });
  it("scopes split tags to their own projected components", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    const tag = randomUUID();
    await f.h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'One split')",
      [tag, f.user],
    );
    await f.h.owner.query(
      "INSERT INTO transaction_split_tags(transaction_split_id,tag_id) VALUES($1,$2)",
      [lines[0].id, tag],
    );
    await f.accrue(tx.id, lines[0].id);
    const rows = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT SUM(s.amount)::text AS amount FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id JOIN transaction_split_tags l ON l.transaction_split_id=s.id WHERE t.user_id=$1 AND l.tag_id=$2",
          [f.user, tag],
        ),
      ),
    );
    expect(rows[0].amount).toBe("-600.0000");
  });
  it("hydrates separate recognition periods and restores original source/split drilldown IDs", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    const rows = await f.as(() =>
      withReportingRead(
        f.h.app,
        f.user,
        () =>
          withScopedDb(f.h.app, (m) =>
            reportingEntities(
              m,
              f.user,
              m
                .getRepository(Transaction)
                .createQueryBuilder("t")
                .leftJoinAndSelect("t.splits", "s")
                .where("t.userId=:userId", { userId: f.user })
                .orderBy("t.transactionDate", "ASC"),
            ),
          ),
        "accrual",
      ),
    );
    expect(rows).toHaveLength(13);
    expect(rows.every((row) => row.id === tx.id)).toBe(true);
    expect(rows[0].splits[0].id).toBe(lines[1].id);
    expect(rows[1].splits[0].id).toBe(lines[0].id);
  });
  it("applies recognition dates before aggregate date filters even outside the cash period", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const rows = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingRawMany(
          m,
          f.user,
          m
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("SUM(t.amount)::text", "amount")
            .where("t.userId=:userId", { userId: f.user })
            .andWhere("t.transactionDate BETWEEN :start AND :end", {
              start: "2027-01-01",
              end: "2027-01-31",
            }),
        ),
      ),
    );
    expect(rows[0].amount).toBe("-100.0000");
  });
  it("resolves explicit basis before the user preference", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis) VALUES($1,'cash') ON CONFLICT(user_id) DO UPDATE SET reporting_basis='cash'",
      [f.user],
    );
    const rows = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT count(*)::text AS count FROM transactions WHERE user_id=$1",
          [f.user],
        ),
      ),
    );
    expect(rows[0].count).toBe("1");
    expect(await read("accrual")).toHaveLength(12);
  });
  it("does not expose another owner when a valid foreign user ID is supplied", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const rows = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          randomUUID(),
          "SELECT id FROM transactions",
          [],
          "accrual",
        ),
      ),
    );
    expect(rows).toEqual([]);
  });
  it("actual category, payee and income-expense services agree and explicit cash still reads the payment", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const currency = new ReportCurrencyService(
      f.h.app,
      f.h.module.get(ExchangeRateService),
    );
    const spending = new SpendingReportsService(f.h.app, currency),
      income = new IncomeReportsService(f.h.app, currency);
    const category = await f.as(() =>
      spending.getSpendingByCategory(f.user, "2027-01-01", "2027-01-31"),
    );
    const payee = await f.as(() =>
      spending.getSpendingByPayee(f.user, "2027-01-01", "2027-01-31"),
    );
    const period = await f.as(() =>
      income.getIncomeVsExpenses(f.user, "2027-01-01", "2027-01-31"),
    );
    expect(category.totalSpending).toBe(100);
    expect(payee.totalSpending).toBe(100);
    expect(period.totals.expenses).toBe(100);
    const cash = await f.as(() =>
      withReportingRead(
        f.h.app,
        f.user,
        () =>
          spending.getSpendingByCategory(f.user, "2027-01-01", "2027-01-31"),
        "cash",
      ),
    );
    expect(cash.totalSpending).toBe(0);
  });
  it("converts actual recognition rows at their own dated rates and withholds an unknown cash-day rate", async () => {
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
    const currency = new ReportCurrencyService(
      f.h.app,
      f.h.module.get(ExchangeRateService),
    );
    const spending = new SpendingReportsService(f.h.app, currency);
    const report = await f.as(() =>
      spending.getSpendingByCategory(f.user, "2026-06-01", "2026-07-31"),
    );
    expect(report.totalSpending).toBe(170);
    const cash = await f.as(() =>
      withReportingRead(
        f.h.app,
        f.user,
        () =>
          spending.getSpendingByCategory(f.user, "2026-06-01", "2026-06-30"),
        "cash",
      ),
    );
    expect(cash.totalSpending).toBeNull();
  });
  it("derives signed timing balances and immediately refreshes after source edits ", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const bank = await f.bank();
    const balances = () =>
      f.as(() =>
        withScopedDb(f.h.app, (m) =>
          readAccrualSystemBalances(m, f.user, [
            "2026-06-14",
            "2026-06-15",
            "2026-06-30",
            "2027-05-31",
          ]),
        ),
      );
    expect((await balances()).map((r) => r.balance)).toEqual([
      "0.0000",
      "1200.0001",
      "1100.0001",
      "0.0000",
    ]);
    expect(await f.bank()).toBe(bank);
    // A genuine committed source change rebuilds schedules; reads must have no stale request cache.
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
    expect((await balances()).map((r) => r.balance)).toEqual([
      "0.0000",
      "2400.0001",
      "2200.0001",
      "0.0000",
    ]);
  });
  it("maintains retained schedules through source edits while disabled and restores recognition on re-enable", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const read = () =>
      f.as(() =>
        withScopedDb(f.h.app, (m) =>
          reportingQuery(
            m,
            f.user,
            "SELECT transaction_date,amount::text FROM transactions WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY transaction_date",
            [f.user, tx.id],
            "accrual",
          ),
        ),
      );
    await f.h.owner.query(
      "UPDATE user_preferences SET accrual_enabled=false WHERE user_id=$1",
      [f.user],
    );
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
    const retained = await f.states(tx.id);
    expect(retained).toHaveLength(1);
    expect(retained[0].allocations).toHaveLength(12);
    const cash = await f.as(() =>
      withScopedDb(f.h.app, (m) =>
        reportingQuery(
          m,
          f.user,
          "SELECT amount::text FROM transactions WHERE user_id=$1 AND id=$2",
          [f.user, tx.id],
          "accrual",
        ),
      ),
    );
    expect(cash).toEqual([{ amount: "-2400.0001" }]);
    await f.h.owner.query(
      "UPDATE user_preferences SET accrual_enabled=true WHERE user_id=$1",
      [f.user],
    );
    const rows = await read();
    expect(rows).toHaveLength(12);
    expect(rows[0].amount).toBe("-200.0000");
    expect(rows[11].amount).toBe("-200.0001");
  });
  it("keeps explicit read mappings in parity with source columns", () => {
    for (const name of [
      "transactions",
      "transaction_splits",
      "investment_transactions",
    ]) {
      const source = f.h.app.entityMetadatas.find(
        (metadata) => metadata.tableName === name,
      )!;
      const report = f.h.app.entityMetadatas.find(
        (metadata) => metadata.tableName === `accrual_reporting_${name}`,
      )!;
      for (const column of source.columns) {
        const projected = report.columns.find(
          (item) => item.databaseName === column.databaseName,
        );
        expect(projected).toBeDefined();
        expect(projected!.propertyName).toBe(column.propertyName);
        expect(projected!.type).toBe(column.type);
        expect(projected!.isNullable).toBe(column.isNullable);
      }
    }
  });
  it("reads authorized joint accruals, keeps writes owner-only and revokes visibility immediately", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const grantee = (await createTestUserDirect(f.h.owner)).id;
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,accrual_enabled,reporting_basis) VALUES($1,true,'accrual') ON CONFLICT(user_id) DO UPDATE SET accrual_enabled=true,reporting_basis='accrual'",
      [grantee],
    );
    const delegation = randomUUID();
    await f.h.owner.query(
      "INSERT INTO account_delegates(id,owner_user_id,delegate_user_id,status) VALUES($1,$2,$3,'active')",
      [delegation, f.user, grantee],
    );
    await f.h.owner.query(
      "INSERT INTO account_delegate_grants(delegation_id,account_id,can_read,is_joint) VALUES($1,$2,true,true)",
      [delegation, f.account],
    );
    const readJoint = () =>
      withUserContext(grantee, () =>
        withScopedDb(f.h.app, (m) =>
          reportingRawMany(
            m,
            grantee,
            m
              .getRepository(Transaction)
              .createQueryBuilder("t")
              .select("SUM(t.amount)::text", "amount")
              .where(
                "(t.user_id=:analyticsScopeUserId OR t.account_id IN (:...analyticsScopeJointIds))",
                {
                  analyticsScopeUserId: grantee,
                  analyticsScopeJointIds: [f.account],
                },
              )
              .andWhere("t.transaction_date BETWEEN :start AND :end", {
                start: "2027-01-01",
                end: "2027-01-31",
              }),
          ),
        ),
      );
    expect((await readJoint())[0].amount).toBe("-100.0000");
    const writes = await withUserContext(grantee, () =>
      withScopedDb(f.h.app, (m) =>
        m.query(
          "WITH changed AS (UPDATE accrual_schedules SET revision=revision+1 WHERE source_transaction_id=$1 RETURNING id) SELECT count(*)::text AS count FROM changed",
          [tx.id],
        ),
      ),
    );
    expect(writes[0].count).toBe("0");
    await f.h.owner.query(
      "UPDATE account_delegate_grants SET can_read=false WHERE delegation_id=$1",
      [delegation],
    );
    expect((await readJoint())[0].amount).toBeNull();
  });
});
