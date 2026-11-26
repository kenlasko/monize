import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountBalancesReportService } from "@/accounts/account-balances-report.service";
import { DailyBalanceTotalsService } from "@/accounts/daily-balance-totals.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The provisional count on balances and net worth against real PostgreSQL
 * (`docs/specs/provisional-amounts.md` section 6 "Figure shape", P5,
 * and the balances line of section 10).
 *
 * One USD chequing account opens at 1,000.00 and holds a provisional leg of
 * +80.00 forty days ago, a confirmed -30.00 yesterday, and three provisional
 * rows that must count nowhere today: a VOID one, a split child (its parent
 * carries the amount) and one dated ten days ahead. Every balance surface
 * reports the same 1,030.00 it would without the flag, and a count of 1.
 */
describe("Provisional count on balances and net worth (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let balancesReport: AccountBalancesReportService;
  let dailyTotals: DailyBalanceTotalsService;
  let netWorth: NetWorthService;
  let userId: string;
  let accountId: string;
  let today: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
    balancesReport = module.get(AccountBalancesReportService);
    dailyTotals = module.get(DailyBalanceTotalsService);
    netWorth = module.get(NetWorthService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  /** `CURRENT_DATE + days` as the database states it. */
  async function dayOffset(days: number): Promise<string> {
    const [row] = await db.query(
      `SELECT TO_CHAR(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d`,
      [days],
    );
    return row.d;
  }

  async function addRow(
    days: number,
    amount: number,
    opts: {
      provisional?: boolean;
      status?: string;
      parentId?: string | null;
      isSplit?: boolean;
    } = {},
  ): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status, amount_is_provisional,
                                 parent_transaction_id, is_split)
       VALUES ($1, $2, CURRENT_DATE + $3::int, $4, 'USD', $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        accountId,
        days,
        amount,
        opts.status ?? "UNRECONCILED",
        opts.provisional ?? false,
        opts.parentId ?? null,
        opts.isSplit ?? false,
      ],
    );
    return row.id;
  }

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    await db.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'USD')`,
      [userId],
    );
    accountId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    today = await dayOffset(0);

    await addRow(-40, 80, { provisional: true });
    await addRow(-1, -30);
    // Counted nowhere: a VOID leg moved no balance.
    await addRow(-1, 500, { provisional: true, status: "VOID" });
    // Counted nowhere: a split child; its parent carries the amount.
    const parent = await addRow(-1, -20, { isSplit: true });
    await addRow(-1, -20, { provisional: true, parentId: parent });
    // Counted nowhere today: dated after it.
    await addRow(10, 45, { provisional: true });

    await asUser(() => netWorth.recalculateAllAccounts(userId));
  });

  it("gives the account its count and leaves its balance unchanged", async () => {
    const [account] = await asUser(() => accounts.findAll(userId));

    expect(Number(account.currentBalance)).toBe(1030);
    expect(account.futureTransactionsSum).toBe(45);
    expect(account.provisionalCount).toBe(1);
  });

  it("gives the summary's totals and net worth the sum over their accounts", async () => {
    const summary = await asUser(() => accounts.getSummary(userId));

    expect(summary).toMatchObject({
      totalBalance: 1030,
      totalBalanceProvisionalCount: 1,
      netWorth: 1030,
      totalAssets: 1030,
      provisionalCount: 1,
      assetsProvisionalCount: 1,
      liabilitiesProvisionalCount: 0,
    });
  });

  it("counts the balances-as-of report at its own date", async () => {
    const before = await dayOffset(-41);
    const ahead = await dayOffset(10);
    const at = async (date: string) =>
      (await asUser(() => balancesReport.getBalancesAsOf(userId, date)))
        .accounts[0];

    expect(await at(before)).toMatchObject({ provisionalCount: 0 });
    expect(await at(today)).toMatchObject({
      balance: 1030,
      provisionalCount: 1,
    });
    // The future-dated leg is inside the balance from its own date.
    expect(await at(ahead)).toMatchObject({
      balance: 1075,
      provisionalCount: 2,
    });
  });

  it("counts each day of the daily totals as of that day", async () => {
    const yesterday = await dayOffset(-1);
    const ahead = await dayOffset(10);

    const res = await asUser(() =>
      dailyTotals.getDailyBalanceTotals(userId, yesterday, ahead),
    );
    const byDate = new Map(res.days.map((d) => [d.date, d]));

    expect(byDate.get(today)).toMatchObject({
      total: 1030,
      provisionalCount: 1,
    });
    expect(byDate.get(ahead)).toMatchObject({
      total: 1075,
      provisionalCount: 2,
    });
  });

  it("counts each month of the net worth history as of its end", async () => {
    const legDate = await dayOffset(-40);
    const start = await dayOffset(-120);
    const months = await asUser(() =>
      netWorth.getMonthlyNetWorth(userId, start, today),
    );

    expect(months.length).toBeGreaterThan(1);
    const latest = months[months.length - 1];
    expect(latest).toMatchObject({ netWorth: 1030, provisionalCount: 1 });
    for (const month of months) {
      const [y, m] = month.month.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      // A month that ended before the leg's date does not hold it.
      expect([month.month, month.provisionalCount]).toEqual([
        month.month,
        lastDay < legDate ? 0 : 1,
      ]);
    }
  });

  it("counts nothing once the leg is confirmed", async () => {
    await db.query(
      `UPDATE transactions SET amount_is_provisional = false
        WHERE account_id = $1 AND status <> 'VOID'
          AND parent_transaction_id IS NULL AND transaction_date <= CURRENT_DATE`,
      [accountId],
    );

    const [account] = await asUser(() => accounts.findAll(userId));
    const summary = await asUser(() => accounts.getSummary(userId));

    expect(account.provisionalCount).toBe(0);
    expect(Number(account.currentBalance)).toBe(1030);
    expect(summary).toMatchObject({ netWorth: 1030, provisionalCount: 0 });
  });
});
