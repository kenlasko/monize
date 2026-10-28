import type { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: `securities.module` sits in a require cycle with the
// accounts/currencies graphs (see `report-investment-cash.integration.spec.ts`),
// so the service comes before the module and both come before the report
// service, which reaches `currencies/exchange-rate.service` through
// `report-currency.service`.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import {
  IncomeExpenseTagBucket,
  UNTAGGED_TAG_BUCKET_ID,
} from "@/built-in-reports/dto";
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
 * `docs/specs/report-tag-key-breakdown.md` against a real PostgreSQL database.
 *
 * The unit spec (`income-reports.service.spec.ts`) mocks `manager.query`, so it
 * can only assert the text of the SQL. This suite runs it: the UNNEST value
 * fan-out, the key/value parsing, the transaction- vs split-level UNION
 * de-dupe, the two transfer-flow queries and the VOID/investment exclusions are
 * all evaluated by the real planner here.
 */
describe("Income vs Expenses tag-key breakdown (integration)", () => {
  let module: TestingModule;
  let income: IncomeReportsService;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;

  let userId: string;
  let checkingId: string;
  let savingsId: string;
  let cashSleeveId: string;
  let brokerageId: string;
  let incomeCategoryId: string;
  let expenseCategoryId: string;
  let securityId: string;

  const START = "2026-03-01";
  const END = "2026-03-31";
  const DATE = "2026-03-10";

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);

    // Every fixture is USD, save for the one deliberately-missing-rate JPY row
    // in the FX-completeness case, so an empty rate list is the honest stub:
    // the report's own same-currency short circuit handles USD, and JPY simply
    // never resolves.
    const currency = new ReportCurrencyService(dataSource, {
      getLatestRates: async () => [],
      getRateHistory: async () => [],
    } satisfies Pick<
      ExchangeRateService,
      "getLatestRates" | "getRateHistory"
    > as unknown as ExchangeRateService);
    income = new IncomeReportsService(dataSource, currency);
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
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('JPY', 'Japanese Yen', '¥', 0) ON CONFLICT DO NOTHING`,
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

    incomeCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Salary",
        isIncome: true,
      })
    ).id;
    expenseCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Household Expenses",
        isIncome: false,
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
    lines: Array<{
      amount: number;
      categoryId?: string | null;
      kind?: SplitKind;
      transferAccountId?: string | null;
    }>,
  ): Promise<{ parent: Transaction; splits: TransactionSplit[] }> {
    const totalAmount = lines.reduce((sum, l) => sum + l.amount, 0);
    const parent = await insertTransaction({
      isSplit: true,
      categoryId: null,
      amount: totalAmount,
      ...parentOverrides,
    });
    const rows = lines.map((l) =>
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: l.kind ?? SplitKind.CATEGORY,
        categoryId: l.categoryId ?? null,
        transferAccountId: l.transferAccountId ?? null,
        amount: l.amount,
      } as Partial<TransactionSplit>),
    );
    const splits = await dataSource.manager.save(rows);
    return { parent, splits };
  }

  /** A whole (non-split), linked transfer pair -- two rows, one per leg. */
  async function insertTransferPair(opts: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    date?: string;
    status?: TransactionStatus;
  }): Promise<{ outLeg: Transaction; inLeg: Transaction }> {
    const date = opts.date ?? DATE;
    const status = opts.status ?? TransactionStatus.UNRECONCILED;
    const outLeg = await insertTransaction({
      accountId: opts.fromAccountId,
      amount: -opts.amount,
      isTransfer: true,
      categoryId: null,
      status,
      transactionDate: date,
    });
    const inLeg = await insertTransaction({
      accountId: opts.toAccountId,
      amount: opts.amount,
      isTransfer: true,
      categoryId: null,
      status,
      transactionDate: date,
    });
    await dataSource.manager.update(Transaction, outLeg.id, {
      linkedTransactionId: inLeg.id,
    });
    await dataSource.manager.update(Transaction, inLeg.id, {
      linkedTransactionId: outLeg.id,
    });
    return { outLeg, inLeg };
  }

  /**
   * One tag per name, as production keeps it (`idx_tags_user_name` is unique
   * on the user and the lower-cased name): a second transaction tagged with
   * the same name shares the first one's tag.
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

  async function tagTransaction(
    transactionId: string,
    tagName: string,
  ): Promise<void> {
    const tagId = await seedTag(tagName);
    await dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [transactionId, tagId],
    );
  }

  async function tagSplit(splitId: string, tagName: string): Promise<void> {
    const tagId = await seedTag(tagName);
    await dataSource.query(
      `INSERT INTO transaction_split_tags (transaction_split_id, tag_id) VALUES ($1, $2)`,
      [splitId, tagId],
    );
  }

  async function createBuy(): Promise<Transaction> {
    const trade = await withUserContext(userId, () =>
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
    return dataSource.manager.findOneOrFail(Transaction, {
      where: { id: trade.transactionId as string },
    });
  }

  function bucketByValue(
    buckets: IncomeExpenseTagBucket[] | undefined,
    value: string,
  ): IncomeExpenseTagBucket | undefined {
    return buckets?.find((b) => b.value === value);
  }

  async function getReport(tagKey?: string) {
    return withUserContext(userId, () =>
      income.getIncomeVsExpenses(userId, START, END, tagKey ? { tagKey } : {}),
    );
  }

  describe("parity (I1)", () => {
    it("adds no tagKey/buckets fields with no tagKey, and leaves the plain fields unchanged", async () => {
      const salary = await insertTransaction({
        amount: 1000,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(salary.id, "scope:household");
      await insertTransaction({
        amount: -200,
        categoryId: expenseCategoryId,
        payeeName: "Groceries",
      });

      const withoutTagKey = await getReport();
      const withTagKey = await getReport("scope");

      expect(withoutTagKey).not.toHaveProperty("tagKey");
      expect(withoutTagKey).not.toHaveProperty("buckets");

      expect(withTagKey.tagKey).toBe("scope");
      expect(withTagKey.buckets).toBeDefined();

      const { tagKey, buckets, ...baseFromTagged } = withTagKey;
      expect(baseFromTagged).toEqual(withoutTagKey);
      expect(withoutTagKey.totals.income).toBe(1000);
      expect(withoutTagKey.totals.expenses).toBe(200);
    });
  });

  describe("value partition (B1-B4)", () => {
    it("attributes a row to every value it carries, splits attribute per line, and All stays un-partitioned", async () => {
      const salary = await insertTransaction({
        amount: 1000,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(salary.id, "scope:household");

      const stallExpense = await insertTransaction({
        amount: -200,
        categoryId: expenseCategoryId,
        payeeName: "Stall supplies",
      });
      await tagTransaction(stallExpense.id, "scope:stall");

      const bothExpense = await insertTransaction({
        amount: -150,
        categoryId: expenseCategoryId,
        payeeName: "Shared utility",
      });
      await tagTransaction(bothExpense.id, "scope:household");
      await tagTransaction(bothExpense.id, "scope:stall");

      await insertTransaction({
        amount: -50,
        categoryId: expenseCategoryId,
        payeeName: "Unrelated",
      });

      // A split transaction whose two lines carry different scope:* tags.
      const { splits } = await insertSplitTransaction(
        { payeeName: "Mixed split" },
        [
          { amount: -80, categoryId: expenseCategoryId },
          { amount: -120, categoryId: expenseCategoryId },
        ],
      );
      await tagSplit(splits[0].id, "scope:household");
      await tagSplit(splits[1].id, "scope:stall");

      const result = await getReport("scope");

      // B3: All equals today's report, computed over the same base rows with no
      // tag partition -- 1000 income, 600 expenses (200+150+50+80+120).
      expect(result.totals.income).toBe(1000);
      expect(result.totals.expenses).toBe(600);

      const household = bucketByValue(result.buckets, "household");
      expect(household?.totals.income).toBe(1000);
      // B1: the multi-valued row (150) counts in BOTH buckets; B4: the split
      // line (80) attributes only its own amount.
      expect(household?.totals.expenses).toBe(230); // 150 + 80

      const stall = bucketByValue(result.buckets, "stall");
      expect(stall?.totals.income).toBe(0);
      // B1: the multi-valued row (150) counts here too; the split line (120).
      expect(stall?.totals.expenses).toBe(470); // 200 + 150 + 120

      const untagged = bucketByValue(result.buckets, UNTAGGED_TAG_BUCKET_ID);
      expect(untagged?.isUntagged).toBe(true);
      expect(untagged?.totals.expenses).toBe(50);
      expect(untagged?.totals.income).toBe(0);
    });

    it("counts a value tagged at both transaction- and split-level once (B4, I7)", async () => {
      const { parent, splits } = await insertSplitTransaction(
        { payeeName: "Doubly tagged" },
        [{ amount: -300, categoryId: expenseCategoryId }],
      );
      // The same value, once on the parent transaction and once on the split.
      await tagTransaction(parent.id, "scope:household");
      await tagSplit(splits[0].id, "scope:household");

      const result = await getReport("scope");

      const household = bucketByValue(result.buckets, "household");
      // Not 600: the UNION de-dupes the value before UNNEST fans it out, so the
      // -300 line counts once.
      expect(household?.totals.expenses).toBe(300);
      expect(result.totals.expenses).toBe(300);
    });
  });

  describe("transfer visibility (I2/I3, truth tables 3.1 & 3.2)", () => {
    it("shows a self-transfer as flows only, adding nothing to income/expenses/net", async () => {
      const { outLeg, inLeg } = await insertTransferPair({
        fromAccountId: checkingId,
        toAccountId: savingsId,
        amount: 1000,
      });
      await tagTransaction(outLeg.id, "scope:household");
      await tagTransaction(inLeg.id, "scope:household");

      const result = await getReport("scope");

      expect(result.totals.income).toBe(0);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.net).toBe(0);

      const household = bucketByValue(result.buckets, "household");
      expect(household?.totals.income).toBe(0);
      expect(household?.totals.expenses).toBe(0);
      expect(household?.taggedInflows).toBe(1000);
      expect(household?.taggedOutflows).toBe(1000);
    });

    it("gives income 100, not 200, in the maintainer's double-count case", async () => {
      const salary = await insertTransaction({
        amount: 100,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(salary.id, "scope:household");

      const toBrokerage = await insertTransferPair({
        fromAccountId: checkingId,
        toAccountId: brokerageId,
        amount: 100,
        date: "2026-03-15",
      });
      await tagTransaction(toBrokerage.outLeg.id, "scope:household");
      await tagTransaction(toBrokerage.inLeg.id, "scope:household");

      const withdrawal = await insertTransferPair({
        fromAccountId: brokerageId,
        toAccountId: checkingId,
        amount: 100,
        date: "2026-03-20",
      });
      await tagTransaction(withdrawal.outLeg.id, "scope:household");
      await tagTransaction(withdrawal.inLeg.id, "scope:household");

      const result = await getReport("scope");

      const household = bucketByValue(result.buckets, "household");
      expect(household?.totals.income).toBe(100);
      expect(result.totals.income).toBe(100);
    });

    it("puts an untagged transfer in no bucket and no flow", async () => {
      await insertTransferPair({
        fromAccountId: checkingId,
        toAccountId: savingsId,
        amount: 500,
      });

      const result = await getReport("scope");

      // Nothing tagged anywhere: only the reserved untagged bucket appears,
      // and it carries no flow (a transfer leg with no K:* tag matches no
      // value, so it is dropped rather than filed as untagged).
      expect(result.buckets?.map((b) => b.value)).toEqual([
        UNTAGGED_TAG_BUCKET_ID,
      ]);
      const untagged = bucketByValue(result.buckets, UNTAGGED_TAG_BUCKET_ID);
      expect(untagged?.taggedInflows).toBe(0);
      expect(untagged?.taggedOutflows).toBe(0);
    });
  });

  describe("VOID (I6)", () => {
    it("contributes nowhere for a VOID tagged transfer", async () => {
      const salary = await insertTransaction({
        amount: 500,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(salary.id, "scope:household");

      const { outLeg, inLeg } = await insertTransferPair({
        fromAccountId: checkingId,
        toAccountId: savingsId,
        amount: 1000,
        status: TransactionStatus.VOID,
      });
      await tagTransaction(outLeg.id, "scope:household");
      await tagTransaction(inLeg.id, "scope:household");

      const result = await getReport("scope");

      const household = bucketByValue(result.buckets, "household");
      expect(household?.totals.income).toBe(500);
      expect(household?.taggedInflows).toBe(0);
      expect(household?.taggedOutflows).toBe(0);
    });
  });

  describe("investment linkage (I5)", () => {
    it("excludes a tagged investment cash leg but still counts a tagged sleeve salary", async () => {
      const buyLeg = await createBuy();
      await tagTransaction(buyLeg.id, "scope:household");

      const sleeveSalary = await insertTransaction({
        accountId: cashSleeveId,
        amount: 750,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(sleeveSalary.id, "scope:household");

      const result = await getReport("scope");

      const household = bucketByValue(result.buckets, "household");
      // Only the sleeve salary counts; the trade's own cash leg -- tagged or
      // not -- is excluded before the tag dimension ever sees it.
      expect(household?.totals.income).toBe(750);
      expect(household?.totals.expenses).toBe(0);
      expect(result.totals.income).toBe(750);
    });
  });

  describe("FX completeness per bucket (I4)", () => {
    it("blanks one bucket's totals on a missing rate while another stays complete", async () => {
      const householdRow = await insertTransaction({
        amount: 500,
        currencyCode: "USD",
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
      await tagTransaction(householdRow.id, "scope:household");

      const travelRow = await insertTransaction({
        amount: 10000,
        currencyCode: "JPY",
        categoryId: incomeCategoryId,
        payeeName: "Overseas gig",
      });
      await tagTransaction(travelRow.id, "scope:travel");

      const result = await getReport("scope");

      const household = bucketByValue(result.buckets, "household");
      expect(household?.totals.income).toBe(500);
      expect(household?.totals.expenses).toBe(0);
      expect(household?.missingCurrencies).toEqual([]);
      expect(household?.excludedCount).toBe(0);

      const travel = bucketByValue(result.buckets, "travel");
      expect(travel?.totals.income).toBeNull();
      expect(travel?.totals.expenses).toBeNull();
      expect(travel?.totals.net).toBeNull();
      expect(travel?.totals.knownIncome).toBe(0);
      expect(travel?.missingCurrencies).toEqual(["JPY"]);
      expect(travel?.excludedCount).toBeGreaterThan(0);
    });
  });

  describe("per-period tagged flows and the account scope", () => {
    async function twoMonthTransfers() {
      const feb = await insertTransferPair({
        fromAccountId: savingsId,
        toAccountId: checkingId,
        amount: 700,
        date: "2026-02-10",
      });
      const mar = await insertTransferPair({
        fromAccountId: savingsId,
        toAccountId: checkingId,
        amount: 300.25,
        date: "2026-03-10",
      });
      for (const leg of [feb.outLeg, feb.inLeg, mar.outLeg, mar.inLeg]) {
        await tagTransaction(leg.id, "scope:household");
      }
    }

    function report(accountIds?: string[]) {
      return withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, "2026-01-01", "2026-03-31", {
          tagKey: "scope",
          accountIds,
        }),
      );
    }

    it("lands each transfer in its own month, with a zero month between, and the totals are the sum", async () => {
      await twoMonthTransfers();

      const household = bucketByValue((await report()).buckets, "household");

      expect(
        household?.data.map((d) => [
          d.period,
          d.taggedInflows,
          d.taggedOutflows,
        ]),
      ).toEqual([
        ["2026-01", 0, 0],
        ["2026-02", 700, 700],
        ["2026-03", 300.25, 300.25],
      ]);
      expect(household?.taggedInflows).toBe(1000.25);
      expect(household?.taggedOutflows).toBe(1000.25);
      expect(household?.totals.income).toBe(0);
    });

    it("with accountIds = the destination only, counts the inflow and no outflow, and income stays 0", async () => {
      await twoMonthTransfers();

      const result = await report([checkingId]);
      const household = bucketByValue(result.buckets, "household");

      expect(household?.taggedInflows).toBe(1000.25);
      expect(household?.taggedOutflows).toBe(0);
      expect(household?.data.map((d) => d.taggedInflows)).toEqual([
        0, 700, 300.25,
      ]);
      expect(result.totals.income).toBe(0);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.net).toBe(0);
    });
  });

  describe("the default 'All Accounts' boundary (spec 10.8.1)", () => {
    // The reporter's case: the picker offers the non-investment accounts
    // (here Savings and Checking); "All Accounts" sent no ids, so both legs of
    // every tagged transfer counted, while selecting every offered account
    // counted only what came in from outside them.
    const offered = () => [savingsId, checkingId];

    async function reporterLedger() {
      // From the investment cash sleeve, which the picker does not offer.
      const fromSleeve = await insertTransferPair({
        fromAccountId: cashSleeveId,
        toAccountId: checkingId,
        amount: 7066,
      });
      // Between two offered accounts: internal to the default scope.
      const internal = await insertTransferPair({
        fromAccountId: savingsId,
        toAccountId: checkingId,
        amount: 500,
      });
      for (const leg of [
        fromSleeve.outLeg,
        fromSleeve.inLeg,
        internal.outLeg,
        internal.inLeg,
      ]) {
        await tagTransaction(leg.id, "scope:household");
      }
      // Ordinary income in the sleeve: real money the unfiltered report counts.
      await insertTransaction({
        accountId: cashSleeveId,
        amount: 750,
        categoryId: incomeCategoryId,
        payeeName: "Acme Payroll",
      });
    }

    function run(options: {
      accountIds?: string[];
      transferScopeAccountIds?: string[];
    }) {
      return withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END, {
          tagKey: "scope",
          ...options,
        }),
      );
    }

    it("reads the same tagged flows as selecting every offered account", async () => {
      await reporterLedger();

      const byDefault = bucketByValue(
        (await run({ transferScopeAccountIds: offered() })).buckets,
        "household",
      );
      const explicit = bucketByValue(
        (await run({ accountIds: offered() })).buckets,
        "household",
      );

      expect(byDefault?.taggedInflows).toBe(7066);
      expect(byDefault?.taggedOutflows).toBe(0);
      expect(byDefault?.taggedInflows).toBe(explicit?.taggedInflows);
      expect(byDefault?.taggedOutflows).toBe(explicit?.taggedOutflows);
    });

    it("leaves income unfiltered: the sleeve's income still counts", async () => {
      await reporterLedger();

      const unfiltered = await run({});
      const byDefault = await run({ transferScopeAccountIds: offered() });

      expect(byDefault.totals.income).toBe(750);
      expect(byDefault.totals).toEqual(unfiltered.totals);
      expect(byDefault.data).toEqual(unfiltered.data);
    });
  });

  describe("internal transfers under an account filter (spec 10.8)", () => {
    function flows(accountIds: string[]) {
      return withUserContext(userId, async () => {
        const result = await income.getIncomeVsExpenses(userId, START, END, {
          tagKey: "scope",
          accountIds,
        });
        const household = bucketByValue(result.buckets, "household");
        return [household?.taggedInflows ?? 0, household?.taggedOutflows ?? 0];
      });
    }

    async function savingsToChecking() {
      const pair = await insertTransferPair({
        fromAccountId: savingsId,
        toAccountId: checkingId,
        amount: 500,
      });
      await tagTransaction(pair.outLeg.id, "scope:household");
      await tagTransaction(pair.inLeg.id, "scope:household");
    }

    it("whole transfer: no filter in 500 / out 500; one side counts; both sides count nothing", async () => {
      await savingsToChecking();

      expect(await flows([])).toEqual([500, 500]);
      expect(await flows([checkingId])).toEqual([500, 0]);
      expect(await flows([savingsId, checkingId])).toEqual([0, 0]);
      expect(await flows([savingsId])).toEqual([0, 500]);
    });

    it("split transfer leg: counted from one side, not when both accounts are selected", async () => {
      const { parent } = await insertSplitTransaction(
        { accountId: savingsId },
        [
          {
            amount: -500,
            kind: SplitKind.TRANSFER,
            transferAccountId: checkingId,
          },
        ],
      );
      await tagTransaction(parent.id, "scope:household");

      expect(await flows([])).toEqual([0, 500]);
      expect(await flows([savingsId])).toEqual([0, 500]);
      expect(await flows([savingsId, checkingId])).toEqual([0, 0]);
    });

    it("an unlinked transfer leg has no counterpart to exclude and still counts", async () => {
      const leg = await insertTransaction({
        accountId: checkingId,
        amount: 500,
        isTransfer: true,
        categoryId: null,
      });
      await tagTransaction(leg.id, "scope:household");

      expect(await flows([savingsId, checkingId])).toEqual([500, 0]);
    });
  });

  describe("income by source and the account scope (Cash Flow page)", () => {
    function bySource(accountIds?: string[]) {
      return withUserContext(userId, () =>
        income.getIncomeBySource(userId, START, END, { accountIds }),
      );
    }

    async function seedIncome() {
      await insertTransaction({
        accountId: checkingId,
        amount: 1000,
        categoryId: incomeCategoryId,
      });
      await insertTransaction({
        accountId: savingsId,
        amount: 400,
        categoryId: incomeCategoryId,
      });
      // A VOID row in the filtered account never counts.
      await insertTransaction({
        accountId: checkingId,
        amount: 99,
        categoryId: incomeCategoryId,
        status: TransactionStatus.VOID,
      });
    }

    it("absent or empty accountIds is the unscoped report", async () => {
      await seedIncome();

      const unscoped = await bySource();
      expect(unscoped.totalIncome).toBe(1400);
      expect(await bySource([])).toEqual(unscoped);
    });

    it("restricts the totals to the chosen accounts", async () => {
      await seedIncome();

      expect((await bySource([checkingId])).totalIncome).toBe(1000);
      expect((await bySource([savingsId])).totalIncome).toBe(400);
      expect((await bySource([checkingId, savingsId])).totalIncome).toBe(1400);
    });
  });
});
