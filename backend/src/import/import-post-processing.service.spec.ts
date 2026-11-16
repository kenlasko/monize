import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Logger } from "@nestjs/common";
import { ImportPostProcessingService } from "./import-post-processing.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { SecuritiesService } from "../securities/securities.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { ExchangeRateHistoryService } from "../currencies/exchange-rate-history.service";
import {
  RATE_HISTORY_CATCH_UP_MAX_ROUNDS,
  RateHistoryCatchUpService,
  settlePendingRateHistoryFills,
} from "../currencies/rate-history-catch-up.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import { requestContextStorage } from "../common/request-context";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);
jest.mock("../common/default-currency.util", () => ({
  resolveUserDefaultCurrency: jest.fn().mockResolvedValue("CAD"),
}));
jest.mock("../loan-installments/reprice-template", () => ({
  repriceSettledLoanTemplates: jest.fn().mockResolvedValue(undefined),
}));

const lockAccounts = lockAccountsForBalanceWrite as jest.MockedFunction<
  typeof lockAccountsForBalanceWrite
>;

/**
 * Post-import processing is the step that makes an importer's balances agree
 * with the ledger it just wrote, and every step in it is individually guarded so
 * a provider outage cannot fail an import that wrote its rows correctly. The
 * distinction those guards have to keep is which failures are somebody else's
 * outage and which are ours -- a swallowed `warn` on the balance recalculation
 * hides accounts whose displayed balance no longer matches their transactions.
 */
describe("ImportPostProcessingService", () => {
  const userId = "11111111-1111-1111-1111-111111111111";
  const accountA = "aaaaaaaa-1111-1111-1111-111111111111";
  const accountB = "bbbbbbbb-1111-1111-1111-111111111111";

  let service: ImportPostProcessingService;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let netWorth: { recalculateAccount: jest.Mock };
  let prices: {
    backfillHistoricalPrices: jest.Mock;
    backfillTransactionPrices: jest.Mock;
  };
  let rates: { backfillHistoricalRates: jest.Mock };
  let securities: { recomputeBondPricesOfAccounts: jest.Mock };
  let rateHistory: { fillRateGaps: jest.Mock };
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    lockAccounts.mockResolvedValue(undefined);

    scoped = createScopedDbMocks([]);
    scoped.manager.query.mockResolvedValue([]);

    netWorth = { recalculateAccount: jest.fn().mockResolvedValue(undefined) };
    prices = {
      backfillHistoricalPrices: jest.fn().mockResolvedValue(undefined),
      backfillTransactionPrices: jest.fn().mockResolvedValue(undefined),
    };
    rates = { backfillHistoricalRates: jest.fn().mockResolvedValue(undefined) };
    securities = {
      recomputeBondPricesOfAccounts: jest.fn().mockResolvedValue(undefined),
    };
    rateHistory = { fillRateGaps: jest.fn() };

    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportPostProcessingService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: SecurityPriceService, useValue: prices },
        { provide: ExchangeRateService, useValue: rates },
        { provide: SecuritiesService, useValue: securities },
        // The real catch-up, so the rounds below are the import's own.
        RateHistoryCatchUpService,
        { provide: ExchangeRateHistoryService, useValue: rateHistory },
      ],
    }).compile();

    service = module.get(ImportPostProcessingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("balance recalculation", () => {
    it("locks the accounts before reading the ledger they are recomputed from", async () => {
      // Under READ COMMITTED the SELECT and the UPDATE take separate statement
      // snapshots, so a transaction committing between them is overwritten by an
      // absolute total that never saw it (P4-005). The lock has to come first for
      // "computed from rows that cannot change" to be true.
      const order: string[] = [];
      lockAccounts.mockImplementation(async () => {
        order.push("lock");
      });
      scoped.manager.query.mockImplementation(async (sql: string) => {
        order.push(sql.includes("SELECT") ? "read" : "write");
        return [];
      });

      await service.run(userId, false, new Set([accountA]));

      expect(order[0]).toBe("lock");
      expect(order[1]).toBe("read");
      // Owner-scoped: the importer's id reaches the balance-write lock (PR #1095).
      expect(lockAccounts).toHaveBeenCalledWith(
        scoped.manager,
        [accountA],
        userId,
      );
    });

    it("reads and writes in the same transaction as the lock", async () => {
      // The background rate-history fill opens its own transaction; hold it
      // at its first step so only the balance write's is counted.
      let release: (code: string) => void = () => undefined;
      (resolveUserDefaultCurrency as jest.Mock).mockReturnValueOnce(
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      );
      await service.run(userId, false, new Set([accountA, accountB]));

      // One transaction: the lock is only worth anything for as long as it is
      // held, and it dies with the transaction that took it.
      const balanceTransactions = scoped.dataSource.transaction.mock.calls;
      expect(balanceTransactions).toHaveLength(1);

      // Let the held fill finish, so it leaves the pending set.
      release("CAD");
      await settlePendingRateHistoryFills();
    });

    it("writes back one bulk UPDATE keyed by account", async () => {
      scoped.manager.query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT")
          ? [
              { account_id: accountA, balance: "100.005" },
              { account_id: accountB, balance: "-50.1" },
            ]
          : [],
      );

      await service.run(userId, false, new Set([accountA, accountB]));

      const [sql, params] = scoped.manager.query.mock.calls.find(
        (call: string[]) => call[0].includes("UPDATE accounts"),
      )!;
      expect(sql).toContain("FROM (VALUES");
      // Rounded to the 4dp the column stores, not passed through as a float.
      expect(params).toEqual([accountA, 100.005, accountB, -50.1]);
    });

    it("keeps a coin account's eight places and rounds a fiat one at four", async () => {
      scoped.manager.query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT")
          ? [
              {
                account_id: accountA,
                balance: "0.00002501",
                decimal_places: 8,
              },
              {
                account_id: accountB,
                balance: "0.00002501",
                decimal_places: 2,
              },
            ]
          : [],
      );

      await service.run(userId, false, new Set([accountA, accountB]));

      const [sql, params] = scoped.manager.query.mock.calls.find(
        (call: string[]) => call[0].includes("UPDATE accounts"),
      )!;
      expect(params).toEqual([accountA, 0.00002501, accountB, 0]);
      const select = scoped.manager.query.mock.calls.find((call: string[]) =>
        call[0].includes("SELECT"),
      )![0] as string;
      expect(select).toContain("c.decimal_places");
      expect(sql).toContain("FROM (VALUES");
    });

    it("recomputes from the non-VOID ledger, so a voided import row moves nothing", async () => {
      // The importers add each row's amount incrementally as they write, VOID
      // rows included, and this absolute recomputation is what takes a voided
      // row's contribution back out. That mattered less when a VOID cash leg
      // was unreachable on the investment import path -- it hard-coded CLEARED
      // -- and matters now that an imported trade carries the source's own
      // status: a voided Money trade or a QIF row marked void writes a VOID
      // cash leg, and its amount must not survive into current_balance.
      await service.run(userId, false, new Set([accountA]));

      const [sql] = scoped.manager.query.mock.calls.find((call: string[]) =>
        call[0].includes("SELECT"),
      )!;
      expect(sql).toContain("t.status != 'VOID'");
      // Guarded on the same two exclusions the live balance uses, so the
      // import's answer and recalculateCurrentBalance's cannot disagree.
      expect(sql).toContain("t.parent_transaction_id IS NULL");
      expect(sql).toContain("t.transaction_date <= $2");
    });

    it("bounds the recompute by the user's day, not the database server's (issue #2070)", async () => {
      // 21:00 in Toronto on Jan 1 is already 02:00 UTC on Jan 2: the database
      // server's CURRENT_DATE would be a day ahead of the user's, counting a
      // transaction dated the user's tomorrow into today's balance.
      jest.useFakeTimers({ now: new Date("2026-01-02T02:00:00Z") });
      try {
        await requestContextStorage.run({ timezone: "America/Toronto" }, () =>
          service.run(userId, false, new Set([accountA])),
        );
      } finally {
        jest.useRealTimers();
      }

      const [sql, params] = scoped.manager.query.mock.calls.find(
        (call: string[]) => call[0].includes("SELECT"),
      )!;
      expect(sql).toContain("t.transaction_date <= $2");
      expect(params).toEqual([[accountA], "2026-01-01"]);
    });

    it("does nothing at all when no account was touched", async () => {
      await service.run(userId, false, new Set());

      expect(lockAccounts).not.toHaveBeenCalled();
      expect(scoped.dataSource.transaction).not.toHaveBeenCalled();
    });

    it("reports a failure as an error naming the accounts, not as a warning", async () => {
      // This step is pure database work: unlike the backfills there is no
      // provider to blame, and until it succeeds every affected account shows a
      // balance that disagrees with its own ledger (the `.mny` writer sets the
      // balance absolutely from the file, counting future-dated rows this query
      // excludes). Logged at `warn` it reads as a tolerable hiccup.
      scoped.manager.query.mockRejectedValue(new Error("deadlock detected"));

      await service.run(userId, false, new Set([accountA, accountB]));

      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain("balance recalculation failed");
      expect(message).toContain(accountA);
      expect(message).toContain(accountB);
      expect(message).toContain("deadlock detected");
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes("balance recalculation"),
        ),
      ).toBe(false);
    });

    it("still runs the remaining steps after a balance failure", async () => {
      scoped.manager.query.mockRejectedValue(new Error("deadlock detected"));

      await service.run(userId, false, new Set([accountA]));

      expect(rates.backfillHistoricalRates).toHaveBeenCalled();
      expect(netWorth.recalculateAccount).toHaveBeenCalledWith(
        userId,
        accountA,
      );
    });
  });

  describe("provider backfills", () => {
    it("runs the security backfills only for an investment import", async () => {
      await service.run(userId, false, new Set([accountA]));
      expect(prices.backfillHistoricalPrices).not.toHaveBeenCalled();

      await service.run(userId, true, new Set([accountA]));
      expect(prices.backfillHistoricalPrices).toHaveBeenCalled();
      expect(prices.backfillTransactionPrices).toHaveBeenCalled();
    });

    it("recomputes the bond-engine prices of the imported accounts' linked securities, after the price backfills, for an investment import only", async () => {
      await service.run(userId, false, new Set([accountA]));
      expect(securities.recomputeBondPricesOfAccounts).not.toHaveBeenCalled();

      await service.run(userId, true, new Set([accountA]));
      expect(securities.recomputeBondPricesOfAccounts).toHaveBeenCalledWith(
        userId,
        [accountA],
      );
      expect(
        prices.backfillTransactionPrices.mock.invocationCallOrder[0],
      ).toBeLessThan(
        securities.recomputeBondPricesOfAccounts.mock.invocationCallOrder[0],
      );
    });

    it("a failing bond recompute is a warning, never a failed import", async () => {
      securities.recomputeBondPricesOfAccounts.mockRejectedValue(
        new Error("boom"),
      );
      await expect(
        service.run(userId, true, new Set([accountA])),
      ).resolves.toBeUndefined();
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("bond price recompute failed"),
        ),
      ).toBe(true);
    });

    it("warns rather than errors when a provider is down", async () => {
      // The opposite half of the distinction above: the rows this import wrote
      // are correct, so a quote provider outage must not read as data damage.
      prices.backfillHistoricalPrices.mockRejectedValue(new Error("502"));
      rates.backfillHistoricalRates.mockRejectedValue(new Error("timeout"));

      await service.run(userId, true, new Set([accountA]));

      const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnings.some((m) => m.includes("price backfill failed"))).toBe(
        true,
      );
      expect(warnings.some((m) => m.includes("rate backfill failed"))).toBe(
        true,
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("does not let a net-worth recalculation failure reject the import", async () => {
      netWorth.recalculateAccount.mockRejectedValue(new Error("nope"));

      await expect(
        service.run(userId, false, new Set([accountA])),
      ).resolves.toBeUndefined();
    });
  });

  describe("rate history of the imported currencies (#2186)", () => {
    // The fill runs in the background; let its promise chain settle.
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const usedCurrencies = (codes: string[]) =>
      scoped.manager.query.mockImplementation(async (sql: string) =>
        sql.includes("SELECT DISTINCT code")
          ? codes.map((code) => ({ code }))
          : [],
      );
    const fill = (over: Record<string, number>) => ({
      stored: 0,
      windowsFetched: 0,
      windowsUnanswered: 0,
      windowsRemaining: 0,
      ...over,
    });

    it("fills each foreign currency the imported accounts use, round after round while windows remain", async () => {
      // backfillHistoricalRates skips a pair that holds any row, so a currency
      // whose today's rate was stored before the import never got the years
      // the imported rows reach back to.
      usedCurrencies(["EUR"]);
      rateHistory.fillRateGaps
        .mockResolvedValueOnce(
          fill({ stored: 2000, windowsFetched: 8, windowsRemaining: 4 }),
        )
        .mockResolvedValueOnce(fill({ stored: 900, windowsFetched: 4 }));

      await service.run(userId, false, new Set([accountA]));
      await settle();

      expect(rateHistory.fillRateGaps).toHaveBeenCalledTimes(2);
      expect(rateHistory.fillRateGaps).toHaveBeenCalledWith(userId, "EUR");
      const discovery = scoped.manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("SELECT DISTINCT code"),
      );
      // The reporting currency is excluded: it has no rate history.
      expect(discovery?.[1]).toEqual([[accountA], userId, "CAD"]);
      // Rates were stored, so the snapshots are recomputed after the fill
      // as well as straight after the import.
      expect(netWorth.recalculateAccount).toHaveBeenCalledTimes(2);
    });

    it("does not hold the import for the fill", async () => {
      usedCurrencies(["EUR"]);
      let finish: (value: unknown) => void = () => undefined;
      rateHistory.fillRateGaps.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );

      await expect(
        service.run(userId, false, new Set([accountA])),
      ).resolves.toBeUndefined();

      // Released afterwards, so the fill leaves the pending set for the
      // cases after this one.
      await settle();
      finish(fill({}));
      await settlePendingRateHistoryFills();
    });

    it("stops a currency when a round got no answer, and recomputes nothing more when nothing was stored", async () => {
      usedCurrencies(["EUR"]);
      rateHistory.fillRateGaps.mockResolvedValue(
        fill({ windowsFetched: 3, windowsUnanswered: 3, windowsRemaining: 3 }),
      );

      await service.run(userId, false, new Set([accountA]));
      await settle();

      expect(rateHistory.fillRateGaps).toHaveBeenCalledTimes(1);
      expect(netWorth.recalculateAccount).toHaveBeenCalledTimes(1);
    });

    it("spends at most the round cap on one currency", async () => {
      usedCurrencies(["EUR"]);
      rateHistory.fillRateGaps.mockResolvedValue(
        fill({ stored: 10, windowsFetched: 8, windowsRemaining: 8 }),
      );

      await service.run(userId, false, new Set([accountA]));
      await settle();

      expect(rateHistory.fillRateGaps).toHaveBeenCalledTimes(
        RATE_HISTORY_CATCH_UP_MAX_ROUNDS,
      );
    });

    it("warns about a currency the fill refuses and still fills the others", async () => {
      usedCurrencies(["PTS", "USD"]);
      rateHistory.fillRateGaps
        .mockRejectedValueOnce(new Error("no provider carries PTS->CAD"))
        .mockResolvedValueOnce(fill({ stored: 5, windowsFetched: 1 }));

      await service.run(userId, false, new Set([accountA]));
      await settle();

      expect(rateHistory.fillRateGaps.mock.calls).toEqual([
        [userId, "PTS"],
        [userId, "USD"],
      ]);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            "Post-import rate history fill for PTS->CAD stopped",
          ),
        ),
      ).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("stays visible to settlePendingRateHistoryFills until the fill has finished", async () => {
      // The integration helper truncates tables only once this settles; a
      // fill still reading `accounts` under the truncate deadlocked it.
      usedCurrencies(["EUR"]);
      let finish: (value: unknown) => void = () => undefined;
      rateHistory.fillRateGaps.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );

      await service.run(userId, false, new Set([accountA]));
      let settled = false;
      const settling = settlePendingRateHistoryFills().then(() => {
        settled = true;
      });
      await settle();
      expect(rateHistory.fillRateGaps).toHaveBeenCalled();
      expect(settled).toBe(false);

      finish(fill({ stored: 0 }));
      await settling;
      expect(settled).toBe(true);
    });

    it("asks nothing when the import touched no account", async () => {
      await service.run(userId, false, new Set());
      await settle();

      expect(rateHistory.fillRateGaps).not.toHaveBeenCalled();
    });
  });

  describe("settled loan schedules", () => {
    it("reprices each schedule a settlement rule claimed on, after the net-worth dispatch (INV-CACHE-001)", async () => {
      const order: string[] = [];
      netWorth.recalculateAccount.mockImplementation(async () => {
        order.push("net-worth");
      });
      (repriceSettledLoanTemplates as jest.Mock).mockImplementation(
        async () => {
          order.push("reprice");
        },
      );

      await service.run(
        userId,
        false,
        new Set([accountA]),
        new Set(["st-loan"]),
      );

      expect(repriceSettledLoanTemplates).toHaveBeenCalledWith(
        expect.anything(),
        new Set(["st-loan"]),
      );
      expect(order).toEqual(["net-worth", "reprice"]);
    });

    it("reprices nothing by default", async () => {
      await service.run(userId, false, new Set([accountA]));
      expect(repriceSettledLoanTemplates).toHaveBeenCalledWith(
        expect.anything(),
        new Set(),
      );
    });
  });
});
