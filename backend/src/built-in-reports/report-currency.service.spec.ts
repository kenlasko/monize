import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ReportCurrencyService, RateMap } from "./report-currency.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("ReportCurrencyService", () => {
  let service: ReportCurrencyService;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "GBP", toCurrency: "USD", rate: 1.27 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportCurrencyService,
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
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
  // buildRateMap
  // ---------------------------------------------------------------------------
  describe("buildRateMap", () => {
    it("builds a rate map from exchange rates", async () => {
      const rateMap = await service.buildRateMap("USD");

      expect(rateMap).toBeInstanceOf(Map);
      expect(rateMap.get("EUR->USD")).toBe(1.1);
      expect(rateMap.get("GBP->USD")).toBe(1.27);
      expect(rateMap.get("USD->CAD")).toBe(1.36);
    });

    it("returns empty map when no exchange rates exist", async () => {
      exchangeRateService.getLatestRates.mockResolvedValue([]);

      const rateMap = await service.buildRateMap("USD");

      expect(rateMap.size).toBe(0);
    });

    it("calls getLatestRates from exchange rate service", async () => {
      await service.buildRateMap("USD");

      expect(exchangeRateService.getLatestRates).toHaveBeenCalledTimes(1);
    });

    it("converts rate values to numbers", async () => {
      exchangeRateService.getLatestRates.mockResolvedValue([
        { fromCurrency: "JPY", toCurrency: "USD", rate: "0.0067" },
      ]);

      const rateMap = await service.buildRateMap("USD");

      expect(rateMap.get("JPY->USD")).toBe(0.0067);
      expect(typeof rateMap.get("JPY->USD")).toBe("number");
    });

    it("handles multiple rates and builds correct keys", async () => {
      exchangeRateService.getLatestRates.mockResolvedValue([
        { fromCurrency: "USD", toCurrency: "EUR", rate: 0.91 },
        { fromCurrency: "USD", toCurrency: "GBP", rate: 0.79 },
        { fromCurrency: "EUR", toCurrency: "GBP", rate: 0.86 },
      ]);

      const rateMap = await service.buildRateMap("USD");

      expect(rateMap.size).toBe(3);
      expect(rateMap.get("USD->EUR")).toBe(0.91);
      expect(rateMap.get("USD->GBP")).toBe(0.79);
      expect(rateMap.get("EUR->GBP")).toBe(0.86);
    });
  });

  // ---------------------------------------------------------------------------
  // convertAmount
  // ---------------------------------------------------------------------------
  describe("convertAmount", () => {
    let rateMap: RateMap;

    beforeEach(() => {
      rateMap = new Map<string, number>();
      rateMap.set("EUR->USD", 1.1);
      rateMap.set("GBP->USD", 1.27);
      rateMap.set("USD->CAD", 1.36);
    });

    it("returns the original amount when currencies match", () => {
      const result = service.convertAmount(100, "USD", "USD", rateMap);

      expect(result).toBe(100);
    });

    it("returns the original amount when fromCurrency is empty", () => {
      const result = service.convertAmount(100, "", "USD", rateMap);

      expect(result).toBe(100);
    });

    it("converts using direct rate when available", () => {
      const result = service.convertAmount(100, "EUR", "USD", rateMap);

      // 100 EUR * 1.1 = 110 USD
      expect(result).toBeCloseTo(110, 2);
    });

    it("converts using inverse rate when direct rate is not available", () => {
      const result = service.convertAmount(136, "CAD", "USD", rateMap);

      // No CAD->USD rate, but USD->CAD = 1.36, so 136 / 1.36 = 100
      expect(result).toBeCloseTo(100, 2);
    });

    it("returns original amount when no rate is available", () => {
      const result = service.convertAmount(1000, "JPY", "USD", rateMap);

      // No JPY->USD or USD->JPY rate
      expect(result).toBe(1000);
    });

    it("handles zero amount correctly", () => {
      const result = service.convertAmount(0, "EUR", "USD", rateMap);

      expect(result).toBe(0);
    });

    it("handles negative amounts correctly", () => {
      const result = service.convertAmount(-50, "EUR", "USD", rateMap);

      // -50 * 1.1 = -55
      expect(result).toBeCloseTo(-55, 2);
    });

    it("handles large amounts", () => {
      const result = service.convertAmount(1000000, "GBP", "USD", rateMap);

      // 1000000 * 1.27 = 1270000
      expect(result).toBe(1270000);
    });

    it("handles fractional amounts", () => {
      const result = service.convertAmount(0.01, "EUR", "USD", rateMap);

      // 0.01 * 1.1 = 0.011
      expect(result).toBeCloseTo(0.011, 5);
    });

    it("does not divide by zero when inverse rate is zero", () => {
      const zeroRateMap = new Map<string, number>();
      zeroRateMap.set("USD->JPY", 0);

      const result = service.convertAmount(100, "JPY", "USD", zeroRateMap);

      // Inverse rate is 0, so it should return the original amount
      expect(result).toBe(100);
    });

    it("prefers direct rate over inverse rate", () => {
      const bothRatesMap = new Map<string, number>();
      bothRatesMap.set("EUR->USD", 1.1);
      bothRatesMap.set("USD->EUR", 0.95);

      const result = service.convertAmount(100, "EUR", "USD", bothRatesMap);

      // Should use direct rate EUR->USD = 1.1, not inverse of USD->EUR
      expect(result).toBeCloseTo(110, 2);
    });
  });
});
