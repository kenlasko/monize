import { Test, TestingModule } from "@nestjs/testing";
import { CurrenciesController } from "./currencies.controller";
import { ExchangeRateService } from "./exchange-rate.service";

describe("CurrenciesController", () => {
  let controller: CurrenciesController;
  let mockExchangeRateService: Partial<
    Record<keyof ExchangeRateService, jest.Mock>
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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CurrenciesController],
      providers: [
        {
          provide: ExchangeRateService,
          useValue: mockExchangeRateService,
        },
      ],
    }).compile();

    controller = module.get<CurrenciesController>(CurrenciesController);
  });

  describe("getCurrencies()", () => {
    it("delegates to exchangeRateService.getCurrencies", () => {
      mockExchangeRateService.getCurrencies!.mockReturnValue("currencies");

      const result = controller.getCurrencies();

      expect(result).toBe("currencies");
      expect(mockExchangeRateService.getCurrencies).toHaveBeenCalledWith();
    });
  });

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
      mockExchangeRateService.getLastUpdateTime!.mockResolvedValue(
        lastUpdated,
      );

      const result = await controller.getRateStatus();

      expect(result).toEqual({ lastUpdated });
      expect(
        mockExchangeRateService.getLastUpdateTime,
      ).toHaveBeenCalledWith();
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
      expect(
        mockExchangeRateService.refreshAllRates,
      ).toHaveBeenCalledWith();
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
