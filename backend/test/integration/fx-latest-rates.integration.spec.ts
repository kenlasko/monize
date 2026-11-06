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
import { createTestAccount } from "../helpers/test-factories";

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
      "transactions",
      "investment_transactions",
      "monthly_account_balances",
      "accounts",
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
