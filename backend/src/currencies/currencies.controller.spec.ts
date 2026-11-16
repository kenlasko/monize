import { BadRequestException } from "@nestjs/common";
import { ParseCurrencyCodePipe } from "../common/pipes/parse-currency-code.pipe";
import { ParseOptionalCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";
import { Test, TestingModule } from "@nestjs/testing";
import { CurrenciesController } from "./currencies.controller";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";
import { CurrenciesService } from "./currencies.service";
import { FxProviderChain } from "./providers/fx-provider-chain";
import { CurrencyDetailService } from "./currency-detail.service";

describe("CurrenciesController", () => {
  let controller: CurrenciesController;
  let mockExchangeRateService: Partial<
    Record<keyof ExchangeRateService, jest.Mock>
  >;
  let mockExchangeRateHistoryService: Partial<
    Record<keyof ExchangeRateHistoryService, jest.Mock>
  >;
  let mockCurrenciesService: Partial<
    Record<keyof CurrenciesService, jest.Mock>
  >;
  let mockFxProviders: Partial<Record<keyof FxProviderChain, jest.Mock>>;
  let mockCurrencyDetailService: Partial<
    Record<keyof CurrencyDetailService, jest.Mock>
  >;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockExchangeRateService = {
      getCurrencies: jest.fn(),
      getLatestRates: jest.fn(),
      getRateHistory: jest.fn(),
      getRateForDate: jest.fn(),
      getLastUpdateTime: jest.fn(),
      refreshAllRates: jest.fn(),
      backfillHistoricalRates: jest.fn(),
    };

    mockExchangeRateHistoryService = {
      getCoverage: jest.fn(),
      getStoredRates: jest.fn(),
      fillRateGaps: jest.fn(),
    };

    mockCurrenciesService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deactivate: jest.fn(),
      activate: jest.fn(),
      remove: jest.fn(),
      getUsage: jest.fn(),
      lookupCurrency: jest.fn(),
      getCatalog: jest.fn(),
    };

    mockFxProviders = {
      describe: jest.fn(),
    };

    mockCurrencyDetailService = {
      getUsageSummary: jest.fn(),
      getTransactionRates: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CurrenciesController],
      providers: [
        {
          provide: ExchangeRateService,
          useValue: mockExchangeRateService,
        },
        {
          provide: ExchangeRateHistoryService,
          useValue: mockExchangeRateHistoryService,
        },
        {
          provide: CurrenciesService,
          useValue: mockCurrenciesService,
        },
        {
          provide: FxProviderChain,
          useValue: mockFxProviders,
        },
        {
          provide: CurrencyDetailService,
          useValue: mockCurrencyDetailService,
        },
      ],
    }).compile();

    controller = module.get<CurrenciesController>(CurrenciesController);
  });

  // ── Currency CRUD ──────────────────────────────────────────────

  describe("getCurrencyUsage()", () => {
    it("delegates to currencyDetailService.getUsageSummary with the JWT's userId", () => {
      mockCurrencyDetailService.getUsageSummary!.mockReturnValue("usage");

      const result = controller.getCurrencyUsage(mockReq, "EUR");

      expect(result).toBe("usage");
      expect(mockCurrencyDetailService.getUsageSummary).toHaveBeenCalledWith(
        "user-1",
        "EUR",
      );
    });
  });

  describe("getTransactionRates()", () => {
    it("delegates to currencyDetailService.getTransactionRates with the JWT's userId", () => {
      mockCurrencyDetailService.getTransactionRates!.mockReturnValue("rates");

      const result = controller.getTransactionRates(mockReq, "EUR");

      expect(result).toBe("rates");
      expect(
        mockCurrencyDetailService.getTransactionRates,
      ).toHaveBeenCalledWith("user-1", "EUR");
    });
  });

  describe("getCurrencies()", () => {
    it("delegates to currenciesService.findAll with userId and includeInactive", () => {
      mockCurrenciesService.findAll!.mockReturnValue("currencies");

      const result = controller.getCurrencies(mockReq, false);

      expect(result).toBe("currencies");
      expect(mockCurrenciesService.findAll).toHaveBeenCalledWith(
        "user-1",
        false,
      );
    });

    it("passes includeInactive=true when requested", () => {
      mockCurrenciesService.findAll!.mockReturnValue("allCurrencies");

      const result = controller.getCurrencies(mockReq, true);

      expect(result).toBe("allCurrencies");
      expect(mockCurrenciesService.findAll).toHaveBeenCalledWith(
        "user-1",
        true,
      );
    });
  });

  describe("getCatalog()", () => {
    it("delegates to currenciesService.getCatalog", () => {
      const catalog = [
        { code: "USD", name: "US Dollar", symbol: "$", decimalPlaces: 2 },
      ];
      mockCurrenciesService.getCatalog!.mockReturnValue(catalog);

      const result = controller.getCatalog();

      expect(result).toEqual(catalog);
      expect(mockCurrenciesService.getCatalog).toHaveBeenCalled();
    });
  });

  describe("lookupCurrency()", () => {
    it("delegates to currenciesService.lookupCurrency", () => {
      const lookupResult = {
        code: "EUR",
        name: "Euro",
        symbol: "€",
        decimalPlaces: 2,
      };
      mockCurrenciesService.lookupCurrency!.mockReturnValue(lookupResult);

      const result = controller.lookupCurrency("EUR");

      expect(result).toEqual(lookupResult);
      expect(mockCurrenciesService.lookupCurrency).toHaveBeenCalledWith("EUR");
    });
  });

  describe("getRateForDate()", () => {
    it("returns the rate for a valid pair and date", async () => {
      mockExchangeRateService.getRateForDate!.mockResolvedValue(1.4523);

      const result = await controller.getRateForDate(
        "EUR",
        "USD",
        "2026-07-20",
      );

      expect(result).toEqual({ rate: 1.4523 });
      expect(mockExchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "EUR",
        "USD",
        "2026-07-20",
      );
    });

    it("returns null when no rate can be determined", async () => {
      mockExchangeRateService.getRateForDate!.mockResolvedValue(null);

      const result = await controller.getRateForDate(
        "EUR",
        "USD",
        "2026-07-20",
      );

      expect(result).toEqual({ rate: null });
    });

    it("throws for a malformed date", async () => {
      await expect(
        controller.getRateForDate("EUR", "USD", "07/20/2026"),
      ).rejects.toThrow();
      expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
    });

    /**
     * Express parses a repeated key into an array, so `date` is only a `string`
     * by declaration. A regular expression `.test` coerces the array to text
     * and passes it, after which the resolver sliced an array and compared it
     * as a date (CodeQL `js/type-confusion-through-parameter-tampering`).
     */
    it("refuses a repeated date parameter rather than passing an array on", async () => {
      for (const tampered of [["2026-07-20"], ["2026-07-20", "2026-07-21"]]) {
        await expect(
          controller.getRateForDate(
            "EUR",
            "USD",
            tampered as unknown as string,
          ),
        ).rejects.toThrow(BadRequestException);
      }
      expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
    });

    it("refuses a day that does not exist", async () => {
      await expect(
        controller.getRateForDate("EUR", "USD", "2026-02-30"),
      ).rejects.toThrow(BadRequestException);
      expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
    });
  });

  describe("getUsage()", () => {
    it("delegates to currenciesService.getUsage with userId", () => {
      const usageResult = {
        CAD: { accounts: 3, securities: 5 },
        USD: { accounts: 1, securities: 2 },
      };
      mockCurrenciesService.getUsage!.mockReturnValue(usageResult);

      const result = controller.getUsage(mockReq);

      expect(result).toEqual(usageResult);
      expect(mockCurrenciesService.getUsage).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findOne()", () => {
    it("delegates to currenciesService.findOne", () => {
      const currency = { code: "CAD", name: "Canadian Dollar" };
      mockCurrenciesService.findOne!.mockReturnValue(currency);

      const result = controller.findOne("CAD");

      expect(result).toEqual(currency);
      expect(mockCurrenciesService.findOne).toHaveBeenCalledWith("CAD");
    });
  });

  describe("create()", () => {
    it("delegates to currenciesService.create with userId", () => {
      const dto = {
        code: "NZD",
        name: "New Zealand Dollar",
        symbol: "NZ$",
      };
      mockCurrenciesService.create!.mockReturnValue({
        ...dto,
        isActive: true,
        isSystem: false,
      });

      const result = controller.create(mockReq, dto as any);

      expect(result).toEqual({ ...dto, isActive: true, isSystem: false });
      expect(mockCurrenciesService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("update()", () => {
    it("delegates to currenciesService.update with userId", () => {
      const dto = { name: "New Zealand Dollar (Updated)" };
      mockCurrenciesService.update!.mockReturnValue({ code: "NZD", ...dto });

      const result = controller.update(mockReq, "NZD", dto);

      expect(result).toEqual({ code: "NZD", ...dto });
      expect(mockCurrenciesService.update).toHaveBeenCalledWith(
        "user-1",
        "NZD",
        dto,
      );
    });
  });

  describe("deactivate()", () => {
    it("delegates to currenciesService.deactivate with userId", () => {
      mockCurrenciesService.deactivate!.mockReturnValue({
        code: "NZD",
        isActive: false,
      });

      const result = controller.deactivate(mockReq, "NZD");

      expect(result).toEqual({ code: "NZD", isActive: false });
      expect(mockCurrenciesService.deactivate).toHaveBeenCalledWith(
        "user-1",
        "NZD",
      );
    });
  });

  describe("activate()", () => {
    it("delegates to currenciesService.activate with userId", () => {
      mockCurrenciesService.activate!.mockReturnValue({
        code: "NZD",
        isActive: true,
      });

      const result = controller.activate(mockReq, "NZD");

      expect(result).toEqual({ code: "NZD", isActive: true });
      expect(mockCurrenciesService.activate).toHaveBeenCalledWith(
        "user-1",
        "NZD",
      );
    });
  });

  describe("remove()", () => {
    it("delegates to currenciesService.remove with userId", () => {
      mockCurrenciesService.remove!.mockReturnValue(undefined);

      const result = controller.remove(mockReq, "NZD");

      expect(result).toBeUndefined();
      expect(mockCurrenciesService.remove).toHaveBeenCalledWith(
        "user-1",
        "NZD",
      );
    });
  });

  // ── Exchange Rates ─────────────────────────────────────────────

  describe("getLatestRates()", () => {
    it("delegates to exchangeRateService.getLatestRates", () => {
      mockExchangeRateService.getLatestRates!.mockReturnValue("rates");

      const result = controller.getLatestRates();

      expect(result).toBe("rates");
      expect(mockExchangeRateService.getLatestRates).toHaveBeenCalledWith();
    });
  });

  describe("getRateHistory()", () => {
    it("delegates to exchangeRateService.getRateHistory with date range", () => {
      mockExchangeRateService.getRateHistory!.mockReturnValue("history");

      const result = controller.getRateHistory("2024-01-01", "2024-12-31");

      expect(result).toBe("history");
      expect(mockExchangeRateService.getRateHistory).toHaveBeenCalledWith(
        "2024-01-01",
        "2024-12-31",
      );
    });

    it("passes undefined when no dates provided", () => {
      mockExchangeRateService.getRateHistory!.mockReturnValue("history");

      controller.getRateHistory(undefined, undefined);

      expect(mockExchangeRateService.getRateHistory).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
    });

    /**
     * Both bounds reach a `rate_date` comparison, and Express parses a repeated
     * key into an array, so each is validated by a pipe. Calling the method
     * directly bypasses every pipe, so the wiring is asserted against the
     * metadata Nest would hand it -- the pipe's own behaviour is
     * `parse-calendar-date.pipe.spec.ts`.
     */
    it("declares the calendar-date pipe on both bounds", () => {
      const routeArguments = Reflect.getMetadata(
        "__routeArguments__",
        CurrenciesController,
        "getRateHistory",
      ) as Record<string, { index: number; pipes?: unknown[] }> | undefined;
      const boundIndexes = Object.values(routeArguments ?? {})
        .filter((argument) =>
          (argument.pipes ?? []).some(
            (pipe) =>
              pipe === ParseOptionalCalendarDatePipe ||
              pipe instanceof ParseOptionalCalendarDatePipe,
          ),
        )
        .map((argument) => argument.index)
        .sort();

      expect(boundIndexes).toEqual([0, 1]);
    });
  });

  describe("getRateCoverage()", () => {
    it("delegates to exchangeRateHistoryService.getCoverage with the caller's id", async () => {
      const coverage = {
        from: "EUR",
        to: "PLN",
        earliestDate: "2026-01-02",
        latestDate: "2026-09-16",
        observations: 180,
      };
      mockExchangeRateHistoryService.getCoverage!.mockResolvedValue(coverage);

      await expect(controller.getRateCoverage(mockReq, "EUR")).resolves.toEqual(
        coverage,
      );
      expect(mockExchangeRateHistoryService.getCoverage).toHaveBeenCalledWith(
        "user-1",
        "EUR",
      );
    });
  });

  describe("getStoredRates()", () => {
    it("delegates to exchangeRateHistoryService.getStoredRates with the caller's id", async () => {
      const listing = {
        from: "EUR",
        to: "PLN",
        rates: [
          {
            rateDate: "2026-09-16",
            rate: 4.3,
            source: "yahoo_finance",
            inverted: false,
          },
        ],
        truncated: false,
        limit: 2000,
      };
      mockExchangeRateHistoryService.getStoredRates!.mockResolvedValue(listing);

      await expect(controller.getStoredRates(mockReq, "EUR")).resolves.toEqual(
        listing,
      );
      expect(
        mockExchangeRateHistoryService.getStoredRates,
      ).toHaveBeenCalledWith("user-1", "EUR");
    });

    /**
     * The code reaches a currency comparison, and Express parses a repeated key
     * into an array, so it is validated by a pipe rather than a bare regular
     * expression. Calling the method directly bypasses every pipe, so the
     * wiring is asserted against the metadata Nest would hand it.
     */
    it("declares the currency-code pipe on the code", () => {
      const routeArguments = Reflect.getMetadata(
        "__routeArguments__",
        CurrenciesController,
        "getStoredRates",
      ) as Record<string, { index: number; pipes?: unknown[] }> | undefined;
      const piped = Object.values(routeArguments ?? {})
        .filter((argument) =>
          (argument.pipes ?? []).some(
            (pipe) =>
              pipe === ParseCurrencyCodePipe ||
              pipe instanceof ParseCurrencyCodePipe,
          ),
        )
        .map((argument) => argument.index);

      expect(piped).toEqual([1]);
    });
  });

  describe("fillRateGaps()", () => {
    it("delegates to exchangeRateHistoryService.fillRateGaps with the DTO's code", async () => {
      const fill = {
        from: "EUR",
        to: "PLN",
        usedFrom: "2026-01-01",
        spanEnd: "2026-09-17",
        unresolvableDays: 260,
        windowsPlanned: 1,
        windowsFetched: 1,
        windowsSkipped: 0,
        windowsUnanswered: 0,
        windowsRemaining: 0,
        stored: 240,
        earliestDate: "2025-12-18",
        providerHasNothingBefore: null,
      };
      mockExchangeRateHistoryService.fillRateGaps!.mockResolvedValue(fill);

      await expect(
        controller.fillRateGaps(mockReq, { code: "EUR" }),
      ).resolves.toEqual(fill);
      expect(mockExchangeRateHistoryService.fillRateGaps).toHaveBeenCalledWith(
        "user-1",
        "EUR",
      );
    });
  });

  describe("getRateStatus()", () => {
    it("returns lastUpdated and the configured providers in chain order", async () => {
      const lastUpdated = new Date("2026-07-20T00:00:00Z");
      mockExchangeRateService.getLastUpdateTime!.mockResolvedValue(lastUpdated);
      mockFxProviders.describe!.mockReturnValue([
        { name: "frankfurter", source: "frankfurter" },
        { name: "yahoo", source: "yahoo_finance" },
      ]);

      await expect(controller.getRateStatus()).resolves.toEqual({
        lastUpdated,
        providers: [
          { name: "frankfurter", source: "frankfurter" },
          { name: "yahoo", source: "yahoo_finance" },
        ],
      });
      expect(mockFxProviders.describe).toHaveBeenCalledWith();
    });

    it("returns providers in whatever order the chain describes them", async () => {
      mockExchangeRateService.getLastUpdateTime!.mockResolvedValue(null);
      mockFxProviders.describe!.mockReturnValue([
        { name: "yahoo", source: "yahoo_finance" },
        { name: "frankfurter", source: "frankfurter" },
      ]);

      await expect(controller.getRateStatus()).resolves.toEqual({
        lastUpdated: null,
        providers: [
          { name: "yahoo", source: "yahoo_finance" },
          { name: "frankfurter", source: "frankfurter" },
        ],
      });
    });
  });
});
