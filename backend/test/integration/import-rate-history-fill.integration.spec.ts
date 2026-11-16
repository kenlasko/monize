import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ExchangeRateHistoryService } from "@/currencies/exchange-rate-history.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { ImportPostProcessingService } from "@/import/import-post-processing.service";
import { RateHistoryCatchUpService } from "@/currencies/rate-history-catch-up.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { SecuritiesService } from "@/securities/securities.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { todayYMD } from "@/common/date-utils";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * An import pulls the rate history its rows need, against real PostgreSQL
 * (issue #2186).
 *
 * `backfillHistoricalRates` fetches a pair only while it holds no row, so a
 * currency whose today's rate was stored before the import (the daily refresh
 * ran after the user added it) used to keep a history that began today, and
 * the user had to press "fill gaps" on the Currencies page. The post-import
 * step now runs that fill itself, over the span the imported rows use. Only
 * the provider call (`fillRateWindow`) is stubbed: the discovery query, the
 * planner and the coverage bookkeeping are the real ones.
 */
describe("post-import rate history fill (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  const windows: Array<{ from: string; to: string; start: string }> = [];

  const exchangeRateService = {
    // The pair already holds today's rate, so this skips it, as it did.
    backfillHistoricalRates: async () => ({ results: [] }),
    fillRateWindow: async (
      from: string,
      to: string,
      start: string,
    ): Promise<{ stored: number; answered: boolean; carried: boolean }> => {
      windows.push({ from, to, start });
      return { stored: 0, answered: true, carried: true };
    },
    forgetEmptyRateWindowsFor: () => undefined,
  } as unknown as ExchangeRateService;

  const chain = {
    describe: () => [{ name: "yahoo_finance", source: "yahoo_finance" }],
  } as unknown as FxProviderChain;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    windows.length = 0;
    await cleanTables(dataSource, [
      "transactions",
      "accounts",
      "exchange_rate_coverage",
      "exchange_rates",
      "user_preferences",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true),
              ('EUR', 'Euro', 'E', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "CAD",
      }),
    );
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, 'Euro chequing', 'CHEQUING', 'EUR', 0, 0) RETURNING id`,
      [userId],
    );
    accountId = account.id;
    // What the import wrote: rows reaching back years before today.
    await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status)
       VALUES ($1, $2, '2021-03-15', -10, 'EUR', 'UNRECONCILED'),
              ($1, $2, '2024-08-01', -20, 'EUR', 'UNRECONCILED')`,
      [userId, accountId],
    );
    // The daily refresh already stored today's rate for the new currency.
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('CAD', 'EUR', $1::DATE, 0.6700000000, 'test')`,
      [todayYMD()],
    );
  });

  /**
   * The post-import step with the real gap fill, and every round it starts
   * collected, so the test can wait for the background work to finish rather
   * than for a guessed delay.
   */
  const harness = () => {
    const history = new ExchangeRateHistoryService(
      dataSource,
      exchangeRateService,
      chain,
    );
    const fills: Promise<unknown>[] = [];
    const fill = history.fillRateGaps.bind(history);
    jest
      .spyOn(history, "fillRateGaps")
      .mockImplementation((user: string, code: string) => {
        const running = fill(user, code);
        fills.push(running);
        return running;
      });
    const service = new ImportPostProcessingService(
      dataSource,
      {
        recalculateAccount: async () => undefined,
      } as unknown as NetWorthService,
      {} as SecurityPriceService,
      exchangeRateService,
      {} as SecuritiesService,
      new RateHistoryCatchUpService(dataSource, history),
    );
    const settled = async () => {
      // A round starts only after the previous one answered.
      for (let seen = -1; seen !== fills.length;) {
        seen = fills.length;
        await Promise.allSettled(fills);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    return { service, fills, settled };
  };

  it("asks the provider for the years the imported rows reach back to, without anyone pressing a button", async () => {
    const { service, fills, settled } = harness();

    await withUserContext(userId, () =>
      service.run(userId, false, new Set([accountId])),
    );
    await settled();

    expect(fills.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(0);
    expect(
      windows.every((w) => [w.from, w.to].sort().join() === "CAD,EUR"),
    ).toBe(true);
    // The first window opens at the oldest imported row, not at today's rate.
    expect(windows.map((w) => w.start).sort()[0] <= "2021-03-15").toBe(true);
  });

  it("asks nothing for an import into the reporting currency", async () => {
    await dataSource.query(
      `UPDATE accounts SET currency_code = 'CAD' WHERE id = $1`,
      [accountId],
    );
    const { service, fills, settled } = harness();

    await withUserContext(userId, () =>
      service.run(userId, false, new Set([accountId])),
    );
    await settled();

    expect(fills).toHaveLength(0);
    expect(windows).toHaveLength(0);
  });
});
