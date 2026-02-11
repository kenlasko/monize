import { Test, TestingModule } from "@nestjs/testing";
import { CurrenciesController } from "./currencies.controller";
import { ExchangeRateService } from "./exchange-rate.service";
import { CurrenciesService } from "./currencies.service";

describe("CurrenciesController", () => {
  let controller: CurrenciesController;
  let mockExchangeRateService: Partial<
    Record<keyof ExchangeRateService, jest.Mock>
  >;
  let mockCurrenciesService: Partial<
    Record<keyof CurrenciesService, jest.Mock>
  >;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockExchangeRateService = {
      getCurrencies: jest.fn(),
      getLatestRates: jest.fn(),
      getRateHistory: jest.fn(),
      getLastUpdateTime: jest.fn(),
      refreshAllRates: jest.fn(),
      backfillHistoricalRates: jest.fn(),
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CurrenciesController],
      providers: [
        {
          provide: ExchangeRateService,
          useValue: mockExchangeRateService,
        },
        {
          provide: CurrenciesService,
          useValue: mockCurrenciesService,
        },
      ],
    }).compile();

    controller = module.get<CurrenciesController>(CurrenciesController);
  });

  // ── Currency CRUD ──────────────────────────────────────────────

  describe("getCurrencies()", () => {
    it("delegates to currenciesService.findAll with includeInactive", () => {
      mockCurrenciesService.findAll!.mockReturnValue("currencies");

      const result = controller.getCurrencies(false);

      expect(result).toBe("currencies");
      expect(mockCurrenciesService.findAll).toHaveBeenCalledWith(false);
    });

    it("passes includeInactive=true when requested", () => {
      mockCurrenciesService.findAll!.mockReturnValue("allCurrencies");

      const result = controller.getCurrencies(true);

      expect(result).toBe("allCurrencies");
      expect(mockCurrenciesService.findAll).toHaveBeenCalledWith(true);
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

  describe("getUsage()", () => {
    it("delegates to currenciesService.getUsage", () => {
      const usageResult = {
        CAD: { accounts: 3, securities: 5 },
        USD: { accounts: 1, securities: 2 },
      };
      mockCurrenciesService.getUsage!.mockReturnValue(usageResult);

      const result = controller.getUsage();

      expect(result).toEqual(usageResult);
      expect(mockCurrenciesService.getUsage).toHaveBeenCalled();
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
    it("delegates to currenciesService.create", () => {
      const dto = {
        code: "NZD",
        name: "New Zealand Dollar",
        symbol: "NZ$",
      };
      mockCurrenciesService.create!.mockReturnValue({ ...dto, isActive: true });

      const result = controller.create(dto as any);

      expect(result).toEqual({ ...dto, isActive: true });
      expect(mockCurrenciesService.create).toHaveBeenCalledWith(dto);
    });
  });

  describe("update()", () => {
    it("delegates to currenciesService.update", () => {
      const dto = { name: "New Zealand Dollar (Updated)" };
      mockCurrenciesService.update!.mockReturnValue({ code: "NZD", ...dto });

      const result = controller.update("NZD", dto);

      expect(result).toEqual({ code: "NZD", ...dto });
      expect(mockCurrenciesService.update).toHaveBeenCalledWith("NZD", dto);
    });
  });

  describe("deactivate()", () => {
    it("delegates to currenciesService.deactivate", () => {
      mockCurrenciesService.deactivate!.mockReturnValue({
        code: "NZD",
        isActive: false,
      });

      const result = controller.deactivate("NZD");

      expect(result).toEqual({ code: "NZD", isActive: false });
      expect(mockCurrenciesService.deactivate).toHaveBeenCalledWith("NZD");
    });
  });

  describe("activate()", () => {
    it("delegates to currenciesService.activate", () => {
      mockCurrenciesService.activate!.mockReturnValue({
        code: "NZD",
        isActive: true,
      });

      const result = controller.activate("NZD");

      expect(result).toEqual({ code: "NZD", isActive: true });
      expect(mockCurrenciesService.activate).toHaveBeenCalledWith("NZD");
    });
  });

  describe("remove()", () => {
    it("delegates to currenciesService.remove", () => {
      mockCurrenciesService.remove!.mockReturnValue(undefined);

      const result = controller.remove("NZD");

      expect(result).toBeUndefined();
      expect(mockCurrenciesService.remove).toHaveBeenCalledWith("NZD");
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
  });

  describe("getRateStatus()", () => {
    it("delegates to exchangeRateService.getLastUpdateTime and wraps in object", async () => {
      const lastUpdated = new Date("2024-06-15");
      mockExchangeRateService.getLastUpdateTime!.mockResolvedValue(lastUpdated);

      const result = await controller.getRateStatus();

      expect(result).toEqual({ lastUpdated });
      expect(mockExchangeRateService.getLastUpdateTime).toHaveBeenCalledWith();
    });

    it("returns null lastUpdated when no rates exist", async () => {
      mockExchangeRateService.getLastUpdateTime!.mockResolvedValue(null);

      const result = await controller.getRateStatus();

      expect(result).toEqual({ lastUpdated: null });
    });
  });

  describe("refreshRates()", () => {
    it("delegates to exchangeRateService.refreshAllRates", () => {
      mockExchangeRateService.refreshAllRates!.mockReturnValue("summary");

      const result = controller.refreshRates();

      expect(result).toBe("summary");
      expect(mockExchangeRateService.refreshAllRates).toHaveBeenCalledWith();
    });
  });

  describe("backfillHistoricalRates()", () => {
    it("delegates to exchangeRateService.backfillHistoricalRates with userId", () => {
      mockExchangeRateService.backfillHistoricalRates!.mockReturnValue(
        "backfill",
      );

      const result = controller.backfillHistoricalRates(mockReq);

      expect(result).toBe("backfill");
      expect(
        mockExchangeRateService.backfillHistoricalRates,
      ).toHaveBeenCalledWith("user-1");
    });
  });
});
