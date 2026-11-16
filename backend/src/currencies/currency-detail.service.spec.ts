import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  CurrencyDetailService,
  transactionRateOf,
} from "./currency-detail.service";
import { ExchangeRateService } from "./exchange-rate.service";
import { STORED_RATE_ROW_CAP } from "./exchange-rate-history.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Currency } from "./entities/currency.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { getRequestContext } from "../common/request-context";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/request-context", () => ({
  ...jest.requireActual("../common/request-context"),
  getRequestContext: jest.fn(),
}));

interface UsageRow {
  currency_code: string;
  tx_date: string | null;
  own_rate: string | null;
  cnt: string;
  first_date: string | null;
  last_date: string | null;
  in_code: string | null;
  in_account: string | null;
  missing_original: string;
}

const usageRow = (overrides: Partial<UsageRow>): UsageRow => ({
  currency_code: "EUR",
  tx_date: "2026-03-01",
  own_rate: null,
  cnt: "1",
  first_date: "2026-03-01",
  last_date: "2026-03-01",
  in_code: "0",
  in_account: "0",
  missing_original: "0",
  ...overrides,
});

describe("CurrencyDetailService", () => {
  let service: CurrencyDetailService;
  let manager: Record<string, jest.Mock>;
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let exchangeRateService: Record<string, jest.Mock>;
  let currencyRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    (getRequestContext as jest.Mock).mockReturnValue({ userId: "user-1" });
    currencyRepository = {
      find: jest.fn().mockResolvedValue([{ code: "EUR", decimalPlaces: 2 }]),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [
        UserPreference,
        { findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }) },
      ],
      [Currency, currencyRepository],
    ]));
    exchangeRateService = {
      getRateIndex: jest
        .fn()
        .mockResolvedValue(
          new Map([["EUR->CAD", [{ date: "2026-02-27", rate: 1.5 }]]]),
        ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrencyDetailService,
        { provide: DataSource, useValue: dataSource },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();
    service = module.get(CurrencyDetailService);
  });

  describe("getUsageSummary()", () => {
    it("counts every group and totals them gross, in the currency and in the reporting currency", async () => {
      manager.query.mockResolvedValue([
        // Posted in EUR, no rate of its own: the market rate on its date.
        usageRow({
          cnt: "3",
          first_date: "2026-02-01",
          last_date: "2026-03-01",
          in_code: "100.5",
          in_account: "100.5",
        }),
        // Posted in EUR, settled into CAD at its own rate: 2 EUR per CAD.
        usageRow({
          own_rate: "2",
          in_code: "40",
          in_account: "40",
          last_date: "2026-04-01",
        }),
        // Paid in EUR from a CAD account: the posted CAD is the fact.
        usageRow({
          currency_code: "CAD",
          tx_date: null,
          cnt: "2",
          first_date: "2025-12-31",
          in_code: "30",
          in_account: "45",
        }),
      ]);

      const summary = await service.getUsageSummary("user-1", "EUR");

      expect(summary).toEqual({
        code: "EUR",
        reportingCurrency: "CAD",
        transactionCount: 6,
        firstTransactionDate: "2025-12-31",
        lastTransactionDate: "2026-04-01",
        totalInCurrency: 170.5,
        // 100.5 * 1.5 + 40 / 2 + 45
        totalInReportingCurrency: 215.75,
        knownReportingSubtotal: 215.75,
        unconvertedCount: 0,
        missingPairs: [],
      });
      // Only the market-rate part loads history, over its own dates.
      expect(exchangeRateService.getRateIndex).toHaveBeenCalledWith(
        new Set(["EUR"]),
        "CAD",
        "2026-03-01",
        "2026-03-01",
      );
    });

    it("withholds the reporting total when a part has no rate, and says which pair and how many rows", async () => {
      exchangeRateService.getRateIndex.mockResolvedValue(new Map());
      manager.query.mockResolvedValue([
        usageRow({ cnt: "4", in_code: "10", in_account: "10" }),
        usageRow({
          currency_code: "CAD",
          tx_date: null,
          in_code: "5",
          in_account: "7",
        }),
      ]);

      const summary = await service.getUsageSummary("user-1", "EUR");

      expect(summary.totalInCurrency).toBe(15);
      expect(summary.totalInReportingCurrency).toBeNull();
      expect(summary.knownReportingSubtotal).toBe(7);
      expect(summary.unconvertedCount).toBe(4);
      expect(summary.missingPairs).toEqual(["EUR->CAD"]);
    });

    it("withholds the total in the currency when a foreign entry has no original amount", async () => {
      manager.query.mockResolvedValue([
        usageRow({
          currency_code: "CAD",
          tx_date: null,
          in_code: null,
          in_account: "7",
          missing_original: "1",
        }),
      ]);

      const summary = await service.getUsageSummary("user-1", "EUR");

      expect(summary.totalInCurrency).toBeNull();
      expect(summary.totalInReportingCurrency).toBe(7);
    });

    it("answers zero, not unknown, for a currency nothing uses", async () => {
      manager.query.mockResolvedValue([]);

      const summary = await service.getUsageSummary("user-1", "EUR");

      expect(summary).toMatchObject({
        transactionCount: 0,
        firstTransactionDate: null,
        lastTransactionDate: null,
        totalInCurrency: 0,
        totalInReportingCurrency: 0,
        unconvertedCount: 0,
      });
      expect(exchangeRateService.getRateIndex).not.toHaveBeenCalled();
    });

    it("needs no rate for the reporting currency's own page", async () => {
      manager.query.mockResolvedValue([
        usageRow({
          currency_code: "CAD",
          tx_date: null,
          in_code: "12.25",
          in_account: "12.25",
        }),
      ]);

      const summary = await service.getUsageSummary("user-1", "CAD");

      expect(summary.totalInCurrency).toBe(12.25);
      expect(summary.totalInReportingCurrency).toBe(12.25);
    });

    it("reads only the reader's own, non-void, top-level rows in the currency", async () => {
      manager.query.mockResolvedValue([]);

      await service.getUsageSummary("user-1", "EUR");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("t.user_id = $1");
      expect(sql).toContain("status != 'VOID'");
      expect(sql).toContain("parent_transaction_id IS NULL");
      expect(sql).toContain(
        "(t.currency_code = $2 OR t.original_currency_code = $2)",
      );
      // The reader's own legs read the transfer's posted amounts.
      expect(params).toEqual(["user-1", "EUR", "CAD", "user-1"]);
      expect(sql).toContain("$4");
    });

    it("keeps the market rate for a transfer leg read on somebody else's ledger", async () => {
      (getRequestContext as jest.Mock).mockReturnValue({
        userId: "owner-1",
        realUserId: "delegate-1",
      });
      manager.query.mockResolvedValue([]);

      await service.getUsageSummary("owner-1", "EUR");

      const [sql, params] = manager.query.mock.calls[0];
      expect(params).toEqual(["owner-1", "EUR", "CAD"]);
      expect(sql).not.toContain("$4");
    });
  });

  describe("getTransactionRates()", () => {
    const rateRow = (overrides: Record<string, unknown>) => ({
      id: "tx-1",
      rate_date: "2026-03-01",
      account_name: "Chequing",
      payee_name: "Hotel",
      transfer_rate: null,
      stored_rate: null,
      direct_rate: null,
      ...overrides,
    });

    it("states every rate as reporting units per unit of the currency", async () => {
      manager.query.mockResolvedValue([
        // A CAD-account payment of EUR at 1.5 CAD per EUR.
        rateRow({ id: "a", direct_rate: "1.5" }),
        // A EUR-account payment of CAD at 0.625 EUR per CAD.
        rateRow({ id: "b", stored_rate: "0.625", payee_name: null }),
        // A EUR -> CAD transfer: 100 EUR sent, 147 CAD arrived.
        rateRow({
          id: "c",
          transfer_rate: String(100 / 147),
          stored_rate: "0.5",
        }),
      ]);

      const list = await service.getTransactionRates("user-1", "EUR");

      expect(list.rates).toEqual([
        {
          transactionId: "a",
          rateDate: "2026-03-01",
          rate: 1.5,
          kind: "foreignEntry",
          accountName: "Chequing",
          payeeName: "Hotel",
          // The index's 2026-02-27 observation, carried forward to the date.
          marketRate: 1.5,
        },
        expect.objectContaining({
          transactionId: "b",
          rate: 1.6,
          kind: "foreignEntry",
          payeeName: null,
        }),
        // The posted amounts win over a stored rate.
        expect.objectContaining({
          transactionId: "c",
          rate: 1.47,
          kind: "transfer",
        }),
      ]);
      expect(list).toMatchObject({
        code: "EUR",
        reportingCurrency: "CAD",
        truncated: false,
        limit: STORED_RATE_ROW_CAP,
      });
    });

    it("sets the stored market rate for each date beside the settled one, and null where none applies", async () => {
      exchangeRateService.getRateIndex.mockResolvedValue(
        new Map([
          [
            "CAD->EUR",
            [
              { date: "2026-01-10", rate: 0.625 },
              { date: "2026-03-02", rate: 0.5 },
            ],
          ],
        ]),
      );
      manager.query.mockResolvedValue([
        rateRow({ id: "after", rate_date: "2026-03-05", direct_rate: "2.1" }),
        // Carried forward from 2026-01-10, the stored row being CAD->EUR.
        rateRow({ id: "between", rate_date: "2026-02-01", direct_rate: "1.7" }),
        // Before the first stored observation: no market rate, not the settled one.
        rateRow({ id: "before", rate_date: "2025-12-31", direct_rate: "1.4" }),
      ]);

      const list = await service.getTransactionRates("user-1", "EUR");

      expect(list.rates.map((r) => [r.transactionId, r.marketRate])).toEqual([
        ["after", 2],
        ["between", 1.6],
        ["before", null],
      ]);
      // One index over the listed dates, of the page's pair only.
      expect(exchangeRateService.getRateIndex).toHaveBeenCalledTimes(1);
      expect(exchangeRateService.getRateIndex).toHaveBeenCalledWith(
        new Set(["EUR"]),
        "CAD",
        "2025-12-31",
        "2026-03-05",
      );
    });

    it("loads no rate index when no transaction carries a rate", async () => {
      manager.query.mockResolvedValue([]);

      const list = await service.getTransactionRates("user-1", "EUR");

      expect(list.rates).toEqual([]);
      expect(exchangeRateService.getRateIndex).not.toHaveBeenCalled();
    });

    it("asks nothing for the reporting currency, whose rate is 1 by definition", async () => {
      const list = await service.getTransactionRates("user-1", "CAD");

      expect(list.rates).toEqual([]);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("lists more transaction rates than the old cap of 2000", async () => {
      // Issue #2245: the transaction dots stopped with the stored line.
      manager.query.mockResolvedValue(
        Array.from({ length: 2001 }, (_, i) =>
          rateRow({ id: `tx-${i}`, direct_rate: "1.5" }),
        ),
      );

      const list = await service.getTransactionRates("user-1", "EUR");

      expect(list.rates).toHaveLength(2001);
      expect(list.truncated).toBe(false);
    });

    it("reports a listing cut at the cap as truncated", async () => {
      manager.query.mockResolvedValue(
        Array.from({ length: STORED_RATE_ROW_CAP + 1 }, (_, i) =>
          rateRow({ id: `tx-${i}`, direct_rate: "1.5" }),
        ),
      );

      const list = await service.getTransactionRates("user-1", "EUR");

      expect(list.rates).toHaveLength(STORED_RATE_ROW_CAP);
      expect(list.truncated).toBe(true);
      expect(manager.query.mock.calls[0][1][3]).toBe(STORED_RATE_ROW_CAP + 1);
    });

    it("reads transfer legs only on the reader's own ledger", async () => {
      (getRequestContext as jest.Mock).mockReturnValue({
        userId: "owner-1",
        realUserId: "delegate-1",
      });
      manager.query.mockResolvedValue([]);

      await service.getTransactionRates("owner-1", "EUR");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("NULL::numeric AS transfer_rate");
      expect(params).toHaveLength(4);
    });
  });

  describe("transactionRateOf()", () => {
    it("skips a row with nothing usable", () => {
      expect(
        transactionRateOf({
          transfer_rate: null,
          stored_rate: "0",
          direct_rate: "-1",
        }),
      ).toBeNull();
    });
  });
});
