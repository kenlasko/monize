import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  ConversionGaps,
  RATE_BASIS_GROUP_BY,
  ReportCurrencyService,
  ownRateSql,
  rateBasisColumnsSql,
  transactionRateBasis,
} from "./report-currency.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { FixtureRate, rateIndexOf } from "../test-helpers/report-rate-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ReportCurrencyService", () => {
  let scopedDataSource: DataSourceMock;
  let service: ReportCurrencyService;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: { getRateIndex: jest.Mock };

  const mockUserId = "user-1";

  beforeEach(async () => {
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getRateIndex: jest.fn().mockResolvedValue(new Map()),
    };

    ({ dataSource: scopedDataSource } = createScopedDbMocks([
      [UserPreference, userPreferenceRepository as never],
    ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportCurrencyService,
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        { provide: ExchangeRateService, useValue: exchangeRateService },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<ReportCurrencyService>(ReportCurrencyService);
  });

  // ---------------------------------------------------------------------------
  // getDefaultCurrency
  // ---------------------------------------------------------------------------
  describe("getDefaultCurrency", () => {
    it("returns the user default currency when preference exists", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        defaultCurrency: "EUR",
      });

      const result = await service.getDefaultCurrency(mockUserId);

      expect(result).toBe("EUR");
      expect(userPreferenceRepository.findOne).toHaveBeenCalledWith({
        where: { userId: mockUserId },
      });
    });

    it("returns USD when user preference is null", async () => {
      userPreferenceRepository.findOne.mockResolvedValue(null);

      const result = await service.getDefaultCurrency(mockUserId);

      expect(result).toBe("USD");
    });

    it("returns USD when user preference has no defaultCurrency", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        defaultCurrency: undefined,
      });

      const result = await service.getDefaultCurrency(mockUserId);

      expect(result).toBe("USD");
    });

    it("returns USD when defaultCurrency is empty string", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        defaultCurrency: "",
      });

      const result = await service.getDefaultCurrency(mockUserId);

      expect(result).toBe("USD");
    });

    it("returns the correct currency for different users", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        defaultCurrency: "GBP",
      });

      const result = await service.getDefaultCurrency("user-other");

      expect(result).toBe("GBP");
      expect(userPreferenceRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "user-other" },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // buildConverter (issue #2106: a past row converts at its own date's rate)
  // ---------------------------------------------------------------------------
  describe("buildConverter", () => {
    /** The stored observations `getRateIndex` answers with. */
    const useRates = (rates: FixtureRate[]) => {
      exchangeRateService.getRateIndex.mockResolvedValue(rateIndexOf(rates));
    };

    const EUR_HISTORY: FixtureRate[] = [
      {
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: "1.05",
        rateDate: "2025-01-10",
      },
      {
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: "1.15",
        rateDate: "2025-06-02",
      },
    ];

    it("returns a reporting-currency row unchanged and loads no rates", async () => {
      const convert = await service.buildConverter(
        [{ currency_code: "USD", tx_date: null, own_rate: null }],
        "USD",
      );

      expect(convert(100, { currency_code: "USD" })).toBe(100);
      expect(exchangeRateService.getRateIndex).not.toHaveBeenCalled();
    });

    it("converts each row at the rate on its own date, not the latest", async () => {
      useRates(EUR_HISTORY);
      const january = { currency_code: "EUR", tx_date: "2025-01-15" };
      const june = { currency_code: "EUR", tx_date: "2025-06-20" };

      const convert = await service.buildConverter([january, june], "USD");

      // 100 EUR on 2025-01-15 at 1.05, and on 2025-06-20 at 1.15.
      expect(convert(100, january)).toBeCloseTo(105, 6);
      expect(convert(100, june)).toBeCloseTo(115, 6);
    });

    it("loads the history once, for the span the foreign rows cover", async () => {
      useRates(EUR_HISTORY);

      await service.buildConverter(
        [
          { currency_code: "EUR", tx_date: "2025-06-20" },
          { currency_code: "GBP", tx_date: "2025-01-15" },
          { currency_code: "USD", tx_date: null },
          // Carries its own rate, so needs no history.
          { currency_code: "CAD", tx_date: "2024-01-01", own_rate: "1.35" },
        ],
        "USD",
      );

      expect(exchangeRateService.getRateIndex).toHaveBeenCalledTimes(1);
      const [currencies, ...window] =
        exchangeRateService.getRateIndex.mock.calls[0];
      expect([...currencies].sort()).toEqual(["EUR", "GBP"]);
      expect(window).toEqual(["USD", "2025-01-15", "2025-06-20"]);
    });

    it("answers null for a rate struck after the row's date (INV-FX-001)", async () => {
      useRates(EUR_HISTORY);
      const early = { currency_code: "EUR", tx_date: "2025-01-05" };

      const convert = await service.buildConverter([early], "USD");

      expect(convert(100, early)).toBeNull();
    });

    it("converts through a rate stored in the other direction", async () => {
      useRates([
        {
          fromCurrency: "USD",
          toCurrency: "CAD",
          rate: "1.25",
          rateDate: "2025-03-01",
        },
      ]);
      const row = { currency_code: "CAD", tx_date: "2025-03-04" };

      const convert = await service.buildConverter([row], "USD");

      // 125 CAD / 1.25 = 100 USD
      expect(convert(125, row)).toBeCloseTo(100, 6);
    });

    it("uses the row's own rate before the market's (INV-FX-002)", async () => {
      useRates([
        {
          fromCurrency: "CAD",
          toCurrency: "USD",
          rate: "0.70",
          rateDate: "2025-03-01",
        },
      ]);
      // 1,350 CAD that settled 1,000 USD at 1.35 CAD per USD.
      const row = {
        currency_code: "CAD",
        tx_date: "2025-03-04",
        own_rate: "1.35",
      };

      const convert = await service.buildConverter([row], "USD");

      expect(convert(1350, row)).toBeCloseTo(1000, 6);
      expect(exchangeRateService.getRateIndex).not.toHaveBeenCalled();
    });

    it("answers null, never the input, when no rate exists (INV-FX-001)", async () => {
      useRates([]);
      const row = { currency_code: "JPY", tx_date: "2025-03-04" };

      const convert = await service.buildConverter([row], "USD");

      expect(convert(1000, row)).toBeNull();
    });

    it("answers null for a foreign row with no date or no currency", async () => {
      useRates(EUR_HISTORY);

      const convert = await service.buildConverter([], "USD");

      expect(convert(100, { currency_code: "EUR", tx_date: null })).toBeNull();
      expect(convert(100, { currency_code: "" })).toBeNull();
    });

    it("converts zero to zero without a rate", async () => {
      useRates([]);
      const row = { currency_code: "JPY", tx_date: "2025-03-04" };

      const convert = await service.buildConverter([row], "USD");

      expect(convert(0, row)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // SQL columns and the entity form of the same rule
  // ---------------------------------------------------------------------------
  describe("rate basis", () => {
    it("selects a date only for a row outside the reporting currency", () => {
      const sql = rateBasisColumnsSql("$5");

      expect(sql).toContain("t.currency_code = $5::text THEN NULL");
      expect(sql).toContain("TO_CHAR(t.transaction_date, 'YYYY-MM-DD')");
      expect(sql).toContain("AS tx_date");
      expect(sql).toContain("AS own_rate");
      expect(RATE_BASIS_GROUP_BY).toBe("tx_date, own_rate");
    });

    it("takes the own rate only when it reaches the reporting currency", () => {
      const sql = ownRateSql("$2", "x");

      expect(sql).toContain("x.original_currency_code = $2::text");
      expect(sql).toContain("x.exchange_rate <> 1");
    });

    it("derives the same basis from a loaded transaction", () => {
      expect(
        transactionRateBasis(
          {
            currencyCode: "CAD",
            transactionDate: "2025-03-04",
            originalCurrencyCode: "USD",
            exchangeRate: 1.35,
          },
          "USD",
        ),
      ).toEqual({
        currency_code: "CAD",
        tx_date: "2025-03-04",
        own_rate: 1.35,
      });
      // A stored 1 across two codes is the column default, not a rate.
      expect(
        transactionRateBasis(
          {
            currencyCode: "CAD",
            transactionDate: "2025-03-04",
            originalCurrencyCode: "USD",
            exchangeRate: 1,
          },
          "USD",
        ).own_rate,
      ).toBeNull();
      // A rate into a third currency does not reach the reporting currency.
      expect(
        transactionRateBasis(
          {
            currencyCode: "CAD",
            transactionDate: "2025-03-04",
            originalCurrencyCode: "EUR",
            exchangeRate: 1.5,
          },
          "USD",
        ).own_rate,
      ).toBeNull();
      expect(
        transactionRateBasis(
          { currencyCode: "USD", transactionDate: "2025-03-04" },
          "USD",
        ),
      ).toEqual({ currency_code: "USD", tx_date: null, own_rate: null });
    });
  });

  // ---------------------------------------------------------------------------
  // ConversionGaps
  // ---------------------------------------------------------------------------
  describe("ConversionGaps", () => {
    it("reports a complete report as zero gaps and keeps the total", () => {
      const gaps = new ConversionGaps();

      expect(gaps.missingCurrencies).toEqual([]);
      expect(gaps.excludedCount).toBe(0);
      expect(gaps.headline(12.5)).toBe(12.5);
    });

    it("counts the day-parts of one aggregate once (issue #2106)", () => {
      const gaps = new ConversionGaps();
      gaps.record("EUR", "groceries|EUR");
      gaps.record("EUR", "groceries|EUR");
      gaps.record("EUR", "dining|EUR");

      expect(gaps.excludedCount).toBe(2);
      expect(gaps.missingCurrencies).toEqual(["EUR"]);
    });

    it("withholds the headline and lists currencies sorted and unique", () => {
      const gaps = new ConversionGaps();
      gaps.record("JPY");
      gaps.record("CHF");
      gaps.record("JPY");

      expect(gaps.missingCurrencies).toEqual(["CHF", "JPY"]);
      expect(gaps.excludedCount).toBe(3);
      expect(gaps.headline(12.5)).toBeNull();
    });
  });
});
