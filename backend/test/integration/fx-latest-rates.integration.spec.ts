import { TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
// Same import order as `report-investment-cash.integration.spec.ts`: the
// securities service graph first, the report services after it.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { FX_MAX_RATE_AGE_DAYS } from "@/common/time-series/fx-rate-resolver";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { CategoryDetailService } from "@/categories/category-detail.service";
import { PayeeDetailService } from "@/payees/payee-detail.service";
import { Tag } from "@/tags/entities/tag.entity";
import { PortfolioService } from "@/securities/portfolio.service";
import { AiUsageService } from "@/ai/ai-usage.service";

/**
 * INV-FX-001 and INV-FX-003 against a real PostgreSQL database: "the rate for a
 * date" is `resolveFxRate`'s answer, whichever reader asks.
 *
 * A deployment upgraded from before 1.17 holds a frozen mirror row
 * (`USD->CAD 1.30`) beside the canonical row the refresh writes today
 * (`CAD->USD 0.7142857143`, which is 1.40). `getLatestRates` used to return the
 * newest row per STORED direction with no age bound, and every direct-first
 * reader took the frozen mirror. The trade posting path used to fall back to
 * `getLatestRate` when the dated lookup came back empty, so a 1990 trade was
 * priced at today's rate.
 */
describe("latest exchange rates and the readers that take them (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let rates: ExchangeRateService;
  let spending: SpendingReportsService;
  let investments: InvestmentTransactionsService;
  let userId: string;
  let providerSeries: jest.SpyInstance;

  const today = todayYMD();

  const insertRate = (
    from: string,
    to: string,
    date: string,
    rate: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ($1, $2, $3::DATE, $4, 'test')`,
      [from, to, date, rate],
    );

  /** The stale mirror beside the fresh canonical row, as an upgraded database holds them. */
  const seedStaleMirror = async (): Promise<void> => {
    const old = addDaysYMD(today, -80);
    await insertRate("USD", "CAD", old, "1.3000000000");
    await insertRate("CAD", "USD", old, "0.7142857143");
    await insertRate("CAD", "USD", today, "0.7142857143");
  };

  const latest = () => withUserContext(userId, () => rates.getLatestRates());

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    investments = module.get(InvestmentTransactionsService);
    rates = module.get(ExchangeRateService, { strict: false });
    spending = new SpendingReportsService(
      dataSource,
      new ReportCurrencyService(dataSource, rates),
    );
    // No call leaves the process: a provider asked for a window answers that it
    // found nothing.
    providerSeries = jest
      .spyOn(module.get(FxProviderChain, { strict: false }), "dailySeries")
      .mockResolvedValue({
        points: [],
        answered: true,
        carried: true,
        source: null,
      });
  });

  afterAll(async () => {
    providerSeries.mockRestore();
    await module.close();
  });

  beforeEach(async () => {
    providerSeries.mockClear();
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "securities",
      "transaction_splits",
      "transaction_tags",
      "transactions",
      "investment_transactions",
      "monthly_account_balances",
      "accounts",
      "tags",
      "payees",
      "categories",
      "exchange_rates",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true),
              ('EUR', 'Euro', 'E', 2, true),
              ('USD', 'US Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
  });

  it("returns one row per pair, the fresh canonical one, beside a stale mirror", async () => {
    await seedStaleMirror();

    const list = await latest();

    expect(list).toHaveLength(1);
    expect(list[0].fromCurrency).toBe("CAD");
    expect(list[0].toCurrency).toBe("USD");
    expect(Number(list[0].rate)).toBe(0.7142857143);
    expect(String(list[0].rateDate).slice(0, 10)).toBe(today);
  });

  it("omits a pair whose only row is older than the age bound", async () => {
    expect(324).toBeGreaterThan(FX_MAX_RATE_AGE_DAYS);
    await insertRate("CAD", "EUR", addDaysYMD(today, -324), "0.6800000000");
    await insertRate("CAD", "USD", today, "0.7142857143");

    const list = await latest();

    expect(list.map((r) => `${r.fromCurrency}->${r.toCurrency}`)).toEqual([
      "CAD->USD",
    ]);
  });

  it("converts a foreign report row at the fresh rate, not the frozen mirror", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const account = await createTestAccount(dataSource, userId, {
      name: "US Chequing",
      currencyCode: "USD",
      openingBalance: 5000,
      currentBalance: 4000,
    });
    await dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: account.id,
        transactionDate: today,
        amount: -1000,
        currencyCode: "USD",
        payeeName: "Shop",
        status: TransactionStatus.UNRECONCILED,
        isTransfer: false,
        isSplit: false,
      } as Partial<Transaction>),
    );
    await seedStaleMirror();

    const report = await withUserContext(userId, () =>
      spending.getSpendingByPayee(userId, addDaysYMD(today, -31), today),
    );

    // 1,000 USD at 1 / 0.7142857143 is 1,400.00 CAD; the frozen mirror said 1,300.
    expect(report.totalSpending).toBe(1400);
  });

  it("converts a past report row at the rate on its own date, not today's (issue #2106)", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const account = await createTestAccount(dataSource, userId, {
      name: "US Chequing",
      currencyCode: "USD",
      openingBalance: 5000,
      currentBalance: 3000,
    });
    const past = addDaysYMD(today, -60);
    for (const [date, amount] of [
      [past, -1000],
      [today, -1000],
    ] as const) {
      await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          accountId: account.id,
          transactionDate: date,
          amount,
          currencyCode: "USD",
          payeeName: "Shop",
          status: TransactionStatus.UNRECONCILED,
          isTransfer: false,
          isSplit: false,
        } as Partial<Transaction>),
      );
    }
    // 1.25 CAD per USD two days before the past row; 1.40 today.
    await insertRate("CAD", "USD", addDaysYMD(past, -2), "0.8000000000");
    await insertRate("CAD", "USD", today, "0.7142857143");

    const report = await withUserContext(userId, () =>
      spending.getSpendingByPayee(userId, addDaysYMD(today, -90), today),
    );

    // 1,000 USD at 1.25 plus 1,000 USD at 1.40; at today's rate it read 2,800.
    expect(report.totalSpending).toBe(2650);
    expect(report.excludedCount).toBe(0);
  });

  it("converts the analytics and detail figures at each row's own date (issue #2106)", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const account = await createTestAccount(dataSource, userId, {
      name: "US Chequing",
      currencyCode: "USD",
      openingBalance: 5000,
      currentBalance: 3000,
    });
    const category = await createTestCategory(dataSource, userId, {
      name: "Travel",
    });
    const payee = await createTestPayee(dataSource, userId, { name: "Hotel" });
    const tag = await dataSource.manager.save(
      dataSource.manager.create(Tag, { userId, name: "country:usa" }),
    );
    const past = addDaysYMD(today, -60);
    for (const date of [past, today]) {
      await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          accountId: account.id,
          transactionDate: date,
          amount: -1000,
          currencyCode: "USD",
          payeeId: payee.id,
          payeeName: "Hotel",
          categoryId: category.id,
          status: TransactionStatus.UNRECONCILED,
          isTransfer: false,
          isSplit: false,
          tags: [tag],
        } as Partial<Transaction>),
      );
    }
    await insertRate("CAD", "USD", addDaysYMD(past, -2), "0.8000000000");
    await insertRate("CAD", "USD", today, "0.7142857143");

    const analytics = new TransactionAnalyticsService(dataSource);
    const [summary, grouped, byTag, categoryDetail, payeeDetail] =
      await withUserContext(
        userId,
        async () =>
          [
            await analytics.getSummary(
              userId,
              undefined,
              undefined,
              undefined,
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
            await analytics.getGroupedTotals(userId, { groupBy: "category" }),
            await analytics.getTransactionBreakdownByTagKey(userId, "country"),
            await new CategoryDetailService(dataSource, {
              findOne: async () => category,
            } as never).getDetail(userId, category.id),
            await new PayeeDetailService(dataSource, {
              findOne: async () => payee,
            } as never).getDetail(userId, payee.id),
          ] as const,
      );

    // 1,000 USD at 1.25 plus 1,000 USD at 1.40, never 2,800 at today's rate.
    expect(summary.converted).toMatchObject({
      currency: "CAD",
      totalExpenses: 2650,
      missingCurrencies: [],
    });
    expect(grouped.map((r) => r.convertedTotal)).toEqual([-2650]);
    const byPayee = await withUserContext(userId, () =>
      analytics.getGroupedTotals(userId, { groupBy: "payee" }),
    );
    expect(byPayee.map((r) => [r.name, r.convertedTotal])).toEqual([
      ["Hotel", -2650],
    ]);
    expect(byTag.map((r) => r.convertedTotal)).toEqual([2650]);
    expect(categoryDetail.accounts.map((r) => r.convertedTotal)).toEqual([
      -2650,
    ]);
    expect(payeeDetail.accounts.map((r) => r.convertedTotal)).toEqual([-2650]);
  });

  it("converts a row at its own rate alike in the reports and the assistant (issue #2130)", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "EUR",
      }),
    );
    const usCard = await createTestAccount(dataSource, userId, {
      name: "US Card",
      currencyCode: "USD",
    });
    const euChequing = await createTestAccount(dataSource, userId, {
      name: "EU Chequing",
      currencyCode: "EUR",
    });
    const category = await createTestCategory(dataSource, userId, {
      name: "Travel",
    });
    const day = addDaysYMD(today, -30);
    // EUR 100 charged as USD 125 (1 EUR = 1.25 USD) on a day the market said
    // 1.175, beside EUR 50 already in the reporting currency.
    for (const row of [
      {
        accountId: usCard.id,
        amount: -125,
        currencyCode: "USD",
        originalCurrencyCode: "EUR",
        originalAmount: -100,
        exchangeRate: 1.25,
      },
      { accountId: euChequing.id, amount: -50, currencyCode: "EUR" },
    ]) {
      await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          transactionDate: day,
          payeeName: "Hotel",
          categoryId: category.id,
          status: TransactionStatus.UNRECONCILED,
          isTransfer: false,
          isSplit: false,
          ...row,
        } as Partial<Transaction>),
      );
    }
    await insertRate("EUR", "USD", addDaysYMD(day, -1), "1.1750000000");

    const analytics = new TransactionAnalyticsService(dataSource);
    const window = { startDate: addDaysYMD(today, -60), endDate: today };
    const [report, assistant, summary, grouped, detail] = await withUserContext(
      userId,
      async () =>
        [
          await spending.getSpendingByCategory(
            userId,
            window.startDate,
            window.endDate,
          ),
          await analytics.getLlmListTransactions(userId, {
            ...window,
            groupBy: "category",
            direction: "expenses",
          }),
          await analytics.getSummary(
            userId,
            undefined,
            window.startDate,
            window.endDate,
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
          await analytics.getGroupedTotals(userId, {
            groupBy: "category",
            ...window,
          }),
          await new CategoryDetailService(dataSource, {
            findOne: async () => category,
          } as never).getDetail(userId, category.id),
        ] as const,
    );

    // EUR 100 at its own rate plus EUR 50; the market rate read EUR 156.38.
    expect(report.totalSpending).toBe(150);
    expect(assistant.totalExpenses).toBe(150);
    expect(assistant.fxComplete).toBe(true);
    expect(assistant.breakdown).toEqual([
      expect.objectContaining({ categoryId: category.id, total: 150 }),
    ]);
    expect(summary.converted).toMatchObject({
      currency: "EUR",
      totalExpenses: 150,
      missingCurrencies: [],
    });
    expect(summary.byCurrency).toEqual({
      EUR: expect.objectContaining({ totalExpenses: 50, transactionCount: 1 }),
      USD: expect.objectContaining({ totalExpenses: 125, transactionCount: 1 }),
    });
    expect(
      grouped.map((r) => [r.currencyCode, r.total, r.convertedTotal]).sort(),
    ).toEqual([
      ["EUR", -50, -50],
      ["USD", -125, -100],
    ]);
    // The detail page's account panel, from its one read.
    expect(
      detail.accounts
        .map((r) => [r.currencyCode, r.total, r.convertedTotal])
        .sort(),
    ).toEqual([
      ["EUR", -50, -50],
      ["USD", -125, -100],
    ]);
  });

  it("states a foreign brokerage's history at each row's own date (issue #2106)", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const past = addDaysYMD(today, -60);
    // 1.25 CAD per USD around the purchase; 1.40 today.
    await insertRate("CAD", "USD", addDaysYMD(past, -2), "0.8000000000");
    await insertRate("CAD", "USD", today, "0.7142857143");
    const cash = await createTestAccount(dataSource, userId, {
      name: "US Cash",
      currencyCode: "USD",
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "US Brokerage",
      currencyCode: "USD",
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cash.id,
    });
    await dataSource.manager.update(Account, cash.id, {
      linkedAccountId: brokerage.id,
    });
    const funding = await createTestAccount(dataSource, userId, {
      name: "US Chequing",
      currencyCode: "USD",
      openingBalance: 10000,
      currentBalance: 10000,
    });
    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "MSFT",
        name: "Microsoft",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerage.id,
        action: InvestmentAction.BUY,
        transactionDate: past,
        securityId: security.id,
        fundingAccountId: funding.id,
        quantity: 10,
        price: 100,
        commission: 0,
      }),
    );

    const [page, summary, gains, usage] = await withUserContext(
      userId,
      async () =>
        [
          await investments.findAll(userId),
          await module
            .get(PortfolioService, { strict: false })
            .getPortfolioSummary(userId),
          await investments.getCapitalGainsByMonth(userId, {
            startDate: addDaysYMD(past, -1),
            endDate: today,
          }),
          await new AiUsageService(dataSource).getUsageSummary(userId, 30),
        ] as const,
    );

    // The row's factor into CAD is its own day's 1.25, not today's 1.40.
    const buy = page.data.find((row) => row.action === InvestmentAction.BUY);
    expect(buy).toMatchObject({
      reportingCurrencyCode: "CAD",
      reportingRate: 1.25,
      accountRate: 1,
    });
    // 1,000 USD invested and paid for at 1.25: 1,250 CAD, never 1,400.
    expect(summary.totalCostBasis).toBe(1250);
    expect(summary.totalNetInvested).toBe(1250);
    expect(
      gains.every((entry) => entry.inReportingCurrency.currency === "CAD"),
    ).toBe(true);
    expect(usage.reportingCurrency).toBe("CAD");
    // No usage logged: no cost to state, unknown rather than zero.
    expect(usage.totalEstimatedCostInReportingCurrency).toBeNull();
  });

  it("states a sale's gain alike in Realized Gains and the capital-gain entries (issue #2130)", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const past = addDaysYMD(today, -60);
    const sold = addDaysYMD(today, -10);
    // 1.25 CAD per USD around the purchase; 1.40 from the sale on.
    await insertRate("CAD", "USD", addDaysYMD(past, -2), "0.8000000000");
    await insertRate("CAD", "USD", addDaysYMD(sold, -1), "0.7142857143");
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "US Brokerage",
      currencyCode: "USD",
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    const funding = await createTestAccount(dataSource, userId, {
      name: "US Chequing",
      currencyCode: "USD",
      openingBalance: 10000,
      currentBalance: 10000,
    });
    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "MSFT",
        name: "Microsoft",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    for (const [action, transactionDate, price] of [
      [InvestmentAction.BUY, past, 100],
      [InvestmentAction.SELL, sold, 110],
    ] as const) {
      await withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerage.id,
          action,
          transactionDate,
          securityId: security.id,
          fundingAccountId: funding.id,
          quantity: 10,
          price,
          commission: 0,
        }),
      );
    }

    const [realized, gains] = await withUserContext(
      userId,
      async () =>
        [
          await investments.getRealizedGains(userId),
          await investments.getCapitalGainsByMonth(userId, {
            startDate: addDaysYMD(past, -1),
            endDate: today,
          }),
        ] as const,
    );

    // 1,100 USD at 1.40 less 1,000 USD at 1.25: 290 CAD, in both reports.
    expect(realized).toHaveLength(1);
    expect(realized[0].inReportingCurrency.realizedGain).toBe(290);
    const realizedInEntries = gains
      .map((entry) => entry.inReportingCurrency.realizedGain)
      .filter((gain) => gain !== 0);
    expect(realizedInEntries).toEqual([290]);
  });

  it("rejects a back-dated cross-currency trade when only today's rate is stored", async () => {
    await insertRate("CAD", "USD", today, "0.7142857143");
    const cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage Cash",
      currencyCode: "CAD",
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      currencyCode: "CAD",
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cash.id,
    });
    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      currencyCode: "CAD",
      openingBalance: 10000,
      currentBalance: 10000,
    });
    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );

    await expect(
      withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerage.id,
          action: InvestmentAction.BUY,
          transactionDate: "1990-01-02",
          securityId: security.id,
          fundingAccountId: funding.id,
          quantity: 10,
          price: 100,
          commission: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const [{ count: investmentRows }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM investment_transactions`,
    );
    const [{ count: cashRows }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM transactions`,
    );
    expect(investmentRows).toBe(0);
    expect(cashRows).toBe(0);
    const [{ current_balance: balance }] = await dataSource.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [funding.id],
    );
    expect(Number(balance)).toBe(10000);
  });
});
