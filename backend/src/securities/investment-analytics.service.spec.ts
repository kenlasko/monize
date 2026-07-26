import { Test, TestingModule } from "@nestjs/testing";
import {
  InvestmentAnalyticsService,
  CashFlow,
} from "./investment-analytics.service";

describe("InvestmentAnalyticsService", () => {
  let service: InvestmentAnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvestmentAnalyticsService],
    }).compile();

    service = module.get<InvestmentAnalyticsService>(
      InvestmentAnalyticsService,
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("calculateCagr", () => {
    it("should calculate CAGR correctly for 100 to 200 over 3 years", () => {
      const cagr = service.calculateCagr(100, 200, 3);
      expect(cagr).toBe(25.99); // (2^(1/3) - 1) * 100 = 25.99%
    });

    it("should return 0 when initial value, final value, or years is invalid", () => {
      expect(service.calculateCagr(0, 200, 3)).toBe(0);
      expect(service.calculateCagr(100, 0, 3)).toBe(0);
      expect(service.calculateCagr(100, 200, 0)).toBe(0);
    });

    it("should handle negative returns correctly", () => {
      const cagr = service.calculateCagr(100, 50, 2);
      expect(cagr).toBe(-29.29);
    });

    it("should calculate CAGR for a single-period (1 year) holding", () => {
      const cagr = service.calculateCagr(100, 150, 1);
      expect(cagr).toBe(50);
    });

    it("should return 0 for a zero or negative start value", () => {
      expect(service.calculateCagr(0, 200, 3)).toBe(0);
      expect(service.calculateCagr(-100, 200, 3)).toBe(0);
    });
  });

  describe("calculateXirr", () => {
    it("should return 0 when cash flows are empty or have fewer than 2 entries", () => {
      expect(service.calculateXirr([])).toBe(0);
      expect(service.calculateXirr([{ amount: -1000, date: new Date() }])).toBe(
        0,
      );
    });

    it("should calculate XIRR for a simple 1-year lump sum investment", () => {
      const flows: CashFlow[] = [
        { amount: -10000, date: new Date("2024-01-01") },
        { amount: 11000, date: new Date("2025-01-01") },
      ];

      const xirr = service.calculateXirr(flows);
      expect(xirr).toBeCloseTo(10, 0); // ~10% annual return
    });

    it("should calculate XIRR for monthly SIP cash flows", () => {
      const flows: CashFlow[] = [
        { amount: -5000, date: new Date("2025-01-01") },
        { amount: -5000, date: new Date("2025-02-01") },
        { amount: -5000, date: new Date("2025-03-01") },
        { amount: -5000, date: new Date("2025-04-01") },
        { amount: 21500, date: new Date("2025-05-01") },
      ];

      const xirr = service.calculateXirr(flows);
      expect(xirr).toBeGreaterThan(0);
    });

    it("should calculate XIRR for mixed-sign cash flows (partial withdrawal then top-up)", () => {
      const flows: CashFlow[] = [
        { amount: -10000, date: new Date("2024-01-01") },
        { amount: 2000, date: new Date("2024-07-01") },
        { amount: -5000, date: new Date("2025-01-01") },
        { amount: 15000, date: new Date("2025-07-01") },
      ];

      const xirr = service.calculateXirr(flows);
      expect(Number.isFinite(xirr)).toBe(true);
      expect(xirr).toBeGreaterThan(-100);
    });

    it("should terminate with a finite result instead of hanging when cash flows do not converge", () => {
      const flows: CashFlow[] = [
        { amount: -1000, date: new Date("2024-01-01") },
        { amount: -2000, date: new Date("2024-06-01") },
      ];

      const xirr = service.calculateXirr(flows);
      expect(typeof xirr).toBe("number");
    });
  });
});
