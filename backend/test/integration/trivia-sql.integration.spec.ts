import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { BuiltInReportsService } from "@/built-in-reports/built-in-reports.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import {
  Budget,
  BudgetStrategy,
  BudgetType,
} from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { TriviaCalendarLoader } from "@/ai/trivia/trivia-calendar.loader";
import { TriviaDailyLoader } from "@/ai/trivia/trivia-daily.loader";
import { TriviaLedgerLoader } from "@/ai/trivia/trivia-ledger.loader";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * The raw SQL the daily-varying trivia added, against a real PostgreSQL under
 * enforced row-level security (VER-001).
 *
 * The unit specs mock `manager.query`, so they pin the text and the mapping
 * but cannot say that the statements are valid, that `ORDER BY amount` resolves
 * an output alias beside a `COUNT(*) FILTER (...) OVER ()`, that `$2 || ' days'`
 * binds, or that a row Spending by Payee refuses is refused here too. The two
 * loaders swallow a failing read into `null` (each source fails on its own), so
 * "it executed" is asserted as "its logger did not warn", not as "it returned".
 *
 * The purchase predicate and net Spending by Payee share ledger exclusions
 * (`purchase-rows-sql.ts`, INV-REPORT-001); the ledger below puts a row on each
 * side of every clause, larger than any real purchase, so a clause that stopped
 * excluding it would change the biggest purchase, and the report is called on
 * the same data to hold the two readers to one answer.
 *
 * Dates are fixed: every read takes `today` as an argument, so nothing here
 * depends on the clock except `created_at`, which the recorded-rows test sets.
 */
describe("Trivia SQL against PostgreSQL (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  /** The table owner: seeds and cleans. */
  let db: DataSource;
  /** The runtime role the loaders read through. */
  let app: DataSource;
  let spending: SpendingReportsService;
  let daily: TriviaDailyLoader;
  let calendar: TriviaCalendarLoader;
  let ledger: TriviaLedgerLoader;
  let warn: jest.SpyInstance;

  let aliceId: string;
  let bobId: string;

  // A week of CAD only, a week with one USD purchase, and a no-spend gap.
  const WEEK_ONE_TODAY = "2026-03-20";
  const WEEK_ONE_FROM = "2026-03-13";
  const WEEK_ONE_TO = "2026-03-19";
  const WEEK_TWO_TODAY = "2026-04-10";
  const NO_SPEND_TODAY = "2026-03-28";

  const YMD = /^\d{4}-\d{2}-\d{2}$/;

  async function insertTx(row: {
    userId?: string;
    accountId: string;
    date: string;
    amount: number;
    currency?: string;
    payeeId?: string | null;
    payeeName?: string | null;
    categoryId?: string | null;
    status?: string;
    isTransfer?: boolean;
    isSplit?: boolean;
    parentId?: string | null;
    description?: string;
  }): Promise<string> {
    const [created] = await db.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          payee_id, payee_name, category_id, status, is_transfer, is_split,
          parent_transaction_id, description)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        row.userId ?? aliceId,
        row.accountId,
        row.date,
        row.amount,
        row.currency ?? "CAD",
        row.payeeId ?? null,
        row.payeeName ?? null,
        row.categoryId ?? null,
        row.status ?? "UNRECONCILED",
        row.isTransfer ?? false,
        row.isSplit ?? false,
        row.parentId ?? null,
        row.description ?? "seed",
      ],
    );
    return created.id;
  }

  async function insertSplit(
    transactionId: string,
    amount: number,
    fields: {
      categoryId?: string;
      transferAccountId?: string;
      kind: "category" | "transfer";
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO transaction_splits
         (transaction_id, kind, category_id, transfer_account_id, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        transactionId,
        fields.kind,
        fields.categoryId ?? null,
        fields.transferAccountId ?? null,
        amount,
      ],
    );
  }

  const asAlice = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(aliceId, fn);

  /** What the daily loader reads for one reader's day. */
  function loadDaily(today: string) {
    return asAlice(async () => {
      const spendingByPayee = await spending.getSpendingByPayee(
        aliceId,
        "2026-01-01",
        addDays(today, -1),
      );
      return daily.load(aliceId, "CAD", today, {
        bills: false,
        spendingByPayee,
      });
    });
  }

  function addDays(ymd: string, days: number): string {
    const date = new Date(`${ymd}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    db = harness.owner;
    app = harness.app;

    // The loaders take a DataSource and the report services; the report
    // services take a DataSource and a rate source. Every row in the weeks
    // asserted on is CAD, so an empty rate index is the honest stub, as in
    // `report-investment-cash.integration.spec.ts`.
    const currency = new ReportCurrencyService(app, {
      getRateIndex: async () => new Map(),
    } as never);
    spending = new SpendingReportsService(app, currency);
    const reports = {
      getSpendingByCategory: (...args: [string, string | undefined, string]) =>
        spending.getSpendingByCategory(...args),
    } as unknown as BuiltInReportsService;
    daily = new TriviaDailyLoader(
      app,
      reports,
      {} as never,
      {} as never,
      { getTopMovers: async () => [] } as never,
    );
    calendar = new TriviaCalendarLoader(app, reports);
    ledger = new TriviaLedgerLoader(app, reports);

    await cleanTables(db, [
      "budget_categories",
      "budgets",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "payees",
      "categories",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol) VALUES
         ('CAD', 'Canadian Dollar', '$'), ('USD', 'US Dollar', '$')
       ON CONFLICT DO NOTHING`,
    );

    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    await db.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'CAD')`,
      [aliceId],
    );

    type AccountOverrides = Parameters<typeof createTestAccount>[2];
    const account = async (
      name: string,
      overrides: Record<string, unknown> = {},
    ) =>
      (
        await createTestAccount(db, aliceId, {
          name,
          currencyCode: "CAD",
          ...overrides,
        } as AccountOverrides)
      ).id;
    const chequing = await account("Chequing");
    const visa = await account("Visa", { accountType: "CREDIT_CARD" });
    const savings = await account("Savings", { accountType: "SAVINGS" });
    const usChequing = await account("US Chequing", { currencyCode: "USD" });
    const cashSleeve = await account("Retirement - Cash", {
      accountType: "INVESTMENT",
      accountSubType: "INVESTMENT_CASH",
    });
    const brokerage = await account("Retirement - Brokerage", {
      accountType: "INVESTMENT",
      accountSubType: "INVESTMENT_BROKERAGE",
    });
    const oldCard = await account("Old Card", { isClosed: true });
    await account("Unused");
    const bobAccount = (
      await createTestAccount(db, bobId, {
        name: "Bob Chequing",
        currencyCode: "CAD",
      } as AccountOverrides)
    ).id;

    const groceries = (
      await createTestCategory(db, aliceId, { name: "Groceries" })
    ).id;
    const home = (await createTestCategory(db, aliceId, { name: "Home" })).id;
    const dining = (await createTestCategory(db, aliceId, { name: "Dining" }))
      .id;
    const salary = (
      await createTestCategory(db, aliceId, {
        name: "Salary",
        isIncome: true,
      })
    ).id;
    const grocer = (await createTestPayee(db, aliceId, { name: "Grocer" })).id;
    const hardware = (await createTestPayee(db, aliceId, { name: "Hardware" }))
      .id;
    const cafe = (await createTestPayee(db, aliceId, { name: "Cafe" })).id;
    const splitShop = (
      await createTestPayee(db, aliceId, { name: "Split Shop" })
    ).id;

    // --- Account openings: the first non-VOID top-level row of each account.
    await insertTx({
      accountId: chequing,
      date: "2025-12-01",
      amount: -5,
      status: "VOID",
      payeeName: "Void Before Opening",
    });
    await insertTx({
      accountId: chequing,
      date: "2026-01-05",
      amount: 2000,
      categoryId: salary,
      payeeName: "Employer",
    });
    await insertTx({
      accountId: savings,
      date: "2026-01-20",
      amount: 300,
      payeeName: "Opening deposit",
    });
    await insertTx({
      accountId: visa,
      date: "2026-02-10",
      amount: -12,
      payeeName: "First Visa Purchase",
    });
    await insertTx({
      accountId: oldCard,
      date: "2025-06-01",
      amount: -9,
      payeeName: "Closed Account Row",
    });

    // --- The purchases. Hardware at its own earlier date, Grocer twice
    // before the week and once after it, for the payee-recency read.
    await insertTx({
      accountId: chequing,
      date: "2026-02-10",
      amount: -75,
      payeeId: hardware,
      categoryId: home,
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-05",
      amount: -30,
      payeeId: grocer,
      categoryId: groceries,
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-14",
      amount: -80,
      payeeId: grocer,
      categoryId: groceries,
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-15",
      amount: -120,
      payeeId: hardware,
      categoryId: home,
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-17",
      amount: -150,
      // No payee at all: the biggest purchase of the first week.
    });
    await insertTx({
      accountId: visa,
      date: "2026-03-18",
      amount: -25,
      payeeId: cafe,
      categoryId: dining,
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-29",
      amount: -40,
      payeeId: grocer,
      categoryId: groceries,
    });

    // A split whose parent (-160) is larger than the biggest real purchase
    // (-150) but whose ordinary cash is only -60: the other -100 moved to
    // savings and is not spending.
    const splitParent = await insertTx({
      accountId: chequing,
      date: "2026-03-16",
      amount: -160,
      payeeId: splitShop,
      isSplit: true,
    });
    await insertSplit(splitParent, -60, {
      kind: "category",
      categoryId: groceries,
    });
    await insertSplit(splitParent, -100, {
      kind: "transfer",
      transferAccountId: savings,
    });

    // --- Rows the shared predicate must refuse, each larger than any
    // purchase above, so one that leaked would become the biggest.
    await insertTx({
      accountId: chequing,
      date: "2026-03-16",
      amount: -900,
      status: "VOID",
      payeeName: "Void Vendor",
    });
    await insertTx({
      accountId: usChequing,
      date: "2026-03-16",
      amount: -300,
      currency: "USD",
      status: "VOID",
      payeeName: "Void USD",
    });
    await insertTx({
      accountId: chequing,
      date: "2026-03-19",
      amount: -800,
      isTransfer: true,
      payeeName: "Transfer Payee",
    });
    await insertTx({
      accountId: savings,
      date: "2026-03-19",
      amount: 800,
      isTransfer: true,
      payeeName: "Transfer Payee",
    });
    const buyLeg = await insertTx({
      accountId: cashSleeve,
      date: "2026-03-15",
      amount: -700,
      payeeName: "Broker",
    });
    await db.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, transaction_id, action, transaction_date,
          total_amount, status)
       VALUES ($1, $2, $3, 'BUY', DATE '2026-03-15', 700, 'UNRECONCILED')`,
      [aliceId, cashSleeve, buyLeg],
    );
    await insertTx({
      accountId: brokerage,
      date: "2026-03-15",
      amount: -650,
      payeeName: "Brokerage Fee",
    });
    await insertTx({
      accountId: savings,
      date: "2026-03-16",
      amount: -999,
      payeeName: "Child Row",
      parentId: splitParent,
    });
    await insertTx({
      userId: bobId,
      accountId: bobAccount,
      date: "2026-03-16",
      amount: -5000,
      payeeName: "Bob Spend",
    });

    // --- The second week: a USD purchase beside a CAD one.
    await insertTx({
      accountId: usChequing,
      date: "2026-04-05",
      amount: -200,
      currency: "USD",
      payeeName: "Lumber",
    });
    await insertTx({
      accountId: chequing,
      date: "2026-04-07",
      amount: -60,
      payeeId: hardware,
      categoryId: home,
    });

    // --- A budget: two expense lines and an income line.
    const budget = await db.getRepository(Budget).save(
      db.getRepository(Budget).create({
        userId: aliceId,
        name: "Household",
        budgetType: BudgetType.MONTHLY,
        periodStart: "2026-01-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "CAD",
        isActive: true,
      }),
    );
    const lines: [string, number, boolean][] = [
      [groceries, 400, false],
      [home, 150, false],
      [salary, 3000, true],
    ];
    for (const [categoryId, amount, isIncome] of lines) {
      await db.getRepository(BudgetCategory).save(
        db.getRepository(BudgetCategory).create({
          budgetId: budget.id,
          categoryId,
          amount,
          isIncome,
        }),
      );
    }
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn");
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /** A loader that swallowed a failing query warned "could not read". */
  const expectNoFailedRead = () => {
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("Trivia could not read"),
      ),
    ).toEqual([]);
  };

  it("is enforcing: the runtime role sees no rows outside an identity", async () => {
    // A floor under every assertion below: were the loaders on the owner
    // connection, a missing `user_id` predicate would still return Alice's
    // rows only because Bob's -5000 is the only foreign one.
    const bare = await app.query("SELECT id FROM transactions");
    expect(bare).toEqual([]);
  });

  describe("the daily loader", () => {
    it("runs every read it makes without one failing", async () => {
      const result = await loadDaily(WEEK_ONE_TODAY);
      expectNoFailedRead();
      expect(result.biggestPurchase).not.toBeNull();
      expect(result.lastSpendDate).not.toBeNull();
      expect(result.sincePayee).not.toBeNull();
      expect(result.budget).not.toBeNull();
    });

    it("names the biggest purchase of a one-currency week, and says so", async () => {
      const result = await loadDaily(WEEK_ONE_TODAY);
      // The payee-less -150 beats the 120 hardware row and the split's
      // reportable 60 (its parent says 160), and none of the 900 VOID, 800
      // transfer, 700 investment leg, 650 brokerage row, 999 child row, 5000
      // of another reader or the USD VOID row that would make the week
      // "foreign" had any say.
      expect(result.biggestPurchase).toEqual({
        amount: 150,
        currency: "CAD",
        payee: null,
        date: "2026-03-17",
        singleCurrency: true,
      });
      expect(typeof result.biggestPurchase?.amount).toBe("number");
      expect(result.biggestPurchase?.date).toMatch(YMD);
    });

    it("flags a week that holds a second currency", async () => {
      const result = await loadDaily(WEEK_TWO_TODAY);
      expectNoFailedRead();
      expect(result.biggestPurchase).toEqual({
        amount: 200,
        currency: "USD",
        payee: "Lumber",
        date: "2026-04-05",
        singleCurrency: false,
      });
    });

    it("excludes what Spending by Payee excludes, on the same data", async () => {
      const report = await asAlice(() =>
        spending.getSpendingByPayee(aliceId, WEEK_ONE_FROM, WEEK_ONE_TO),
      );
      const byName = Object.fromEntries(
        report.data.map((row) => [row.payeeName, row.total]),
      );
      // The report names none of the refused rows, and its split total is the
      // reportable 60, not the parent's 160.
      for (const refused of [
        "Void Vendor",
        "Void USD",
        "Transfer Payee",
        "Broker",
        "Brokerage Fee",
        "Child Row",
        "Bob Spend",
      ]) {
        expect(byName).not.toHaveProperty([refused]);
      }
      expect(byName["Split Shop"]).toBe(60);
      expect(report.data.map((row) => row.total).sort((a, b) => a - b)).toEqual(
        [25, 60, 80, 120, 150],
      );
      // So the report's largest figure IS the biggest purchase, row for row.
      const result = await loadDaily(WEEK_ONE_TODAY);
      expect(Math.max(...report.data.map((row) => row.total))).toBe(
        result.biggestPurchase?.amount,
      );
    });

    it("finds the newest purchase and a streak that agrees with the dates", async () => {
      const week = await loadDaily(WEEK_ONE_TODAY);
      // The 40 on 03-29 is after the as-of day; the 800 transfer, 900 VOID
      // and 700 investment leg on 03-15..03-19 are not purchases.
      expect(week.lastSpendDate).toBe("2026-03-18");
      expect(week.lastSpendDate).toMatch(YMD);
      // One day since: not a streak, so nothing to check.
      expect(week.streakSpent).toBeNull();

      const gap = await loadDaily(NO_SPEND_TODAY);
      expectNoFailedRead();
      // 03-18 to 03-27 is nine days; the report finds nothing spent in the
      // days after it (the transfer and VOID rows on 03-19 are not spending).
      expect(gap.lastSpendDate).toBe("2026-03-18");
      expect(gap.streakSpent).toBe(0);
    });

    it("reads days since a payee as that payee's own newest purchase", async () => {
      const result = await loadDaily(WEEK_ONE_TODAY);
      expect(result.sincePayee).not.toBeNull();
      const newest: Record<string, string> = {
        Grocer: "2026-03-14",
        Hardware: "2026-03-15",
        Cafe: "2026-03-18",
        "Split Shop": "2026-03-16",
      };
      const picked = result.sincePayee as { name: string; lastDate: string };
      expect(newest[picked.name]).toBe(picked.lastDate);
      expect(picked.lastDate).toMatch(YMD);
    });

    it("reads the budget with numbers for both sides of each expense line", async () => {
      const result = await loadDaily(WEEK_ONE_TODAY);
      expectNoFailedRead();
      expect(result.budget?.name).toBe("Household");
      expect(result.budget?.currency).toBe("CAD");
      const lines = [...(result.budget?.lines ?? [])].sort(
        (a, b) => (a.budgeted as number) - (b.budgeted as number),
      );
      // Home: the 120 hardware row. Groceries: 30 + 80 + 40 and the split's 60.
      expect(lines).toEqual([
        { budgeted: 150, spent: 120 },
        { budgeted: 400, spent: 210 },
      ]);
      for (const line of lines) {
        expect(typeof line.budgeted).toBe("number");
        expect(typeof line.spent).toBe("number");
      }
    });
  });

  describe("the calendar loader", () => {
    it("runs every read it makes without one failing", async () => {
      const result = await asAlice(() => calendar.load(aliceId, "2026-04-10"));
      expectNoFailedRead();
      expect(result.accountFirstDates).not.toBeNull();
      expect(result.transactionsRecordedBefore).not.toBeNull();
    });

    it("dates each open account by its first non-VOID top-level row", async () => {
      const result = await asAlice(() => calendar.load(aliceId, "2026-04-10"));
      // Not: US Chequing's VOID row of 03-16 (its first is the 04-05 Lumber
      // purchase), Chequing's VOID row of 2025-12-01, Savings' child row of
      // 03-16 (it is a child, and later anyway), the closed account, the
      // account with no rows, or Bob's account. The brokerage suffix is
      // stripped.
      expect(result.accountFirstDates).toEqual([
        { name: "Chequing", firstDate: "2026-01-05" },
        { name: "Retirement", firstDate: "2026-03-15" },
        { name: "Retirement - Cash", firstDate: "2026-03-15" },
        { name: "Savings", firstDate: "2026-01-20" },
        { name: "US Chequing", firstDate: "2026-04-05" },
        { name: "Visa", firstDate: "2026-02-10" },
      ]);
      for (const row of result.accountFirstDates ?? []) {
        expect(row.firstDate).toMatch(YMD);
      }
    });

    it("counts rows recorded before the last 30 days, agreeing with the ledger's own count", async () => {
      // `created_at` is the recording time, which every seed above set to
      // now; age them all so "recorded before" has something to count.
      await db.query(
        `UPDATE transactions SET created_at = now() - interval '40 days'`,
      );
      const [before, records] = await asAlice(async () => [
        (await calendar.load(aliceId, "2026-04-10")).transactionsRecordedBefore,
        await (
          ledger as unknown as {
            countRecords: (id: string) => Promise<{ transactions: number }>;
          }
        ).countRecords(aliceId),
      ]);
      expectNoFailedRead();
      expect(typeof before).toBe("number");
      // Nothing is newer than 30 days, so the two counts are one number:
      // Alice's non-VOID parent rows, her investment, transfer and payee-less
      // rows included and Bob's left out.
      expect(before).toBe((records as { transactions: number }).transactions);
      expect(before).toBeGreaterThan(0);

      // One row recorded now is in the ledger's count and not in the
      // recorded-before one: the interval parameter really is 30 days.
      const [chequing] = await db.query(
        `SELECT id FROM accounts WHERE user_id = $1 AND name = 'Chequing'`,
        [aliceId],
      );
      await insertTx({
        accountId: chequing.id,
        date: "2026-04-09",
        amount: -1,
        payeeName: "Just Recorded",
      });
      const [after, recordsAfter] = await asAlice(async () => [
        (await calendar.load(aliceId, "2026-04-10")).transactionsRecordedBefore,
        await (
          ledger as unknown as {
            countRecords: (id: string) => Promise<{ transactions: number }>;
          }
        ).countRecords(aliceId),
      ]);
      expect(after).toBe(before);
      expect((recordsAfter as { transactions: number }).transactions).toBe(
        (before as number) + 1,
      );
    });
  });
});
