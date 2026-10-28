import { DataSource } from "typeorm";
import {
  ReportCurrencyService,
  type RateMap,
} from "../built-in-reports/report-currency.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("Reporting FX at recognition dates", () => {
  const service = new ReportCurrencyService(
    {} as DataSource,
    {} as ExchangeRateService,
  );
  const rates = (): RateMap =>
    Object.assign(new Map([["USD->EUR", 0.99]]), {
      history: new Map([
        [
          "USD->EUR",
          [
            { date: "2026-06-30", rate: 0.8 },
            { date: "2026-07-31", rate: 0.9 },
          ],
        ],
      ]),
    });
  it("uses recognition-day history instead of the latest rate", () => {
    expect(
      service.tryConvertAmount(100, "USD", "EUR", rates(), {
        conversion_date: "2026-06-30",
      }),
    ).toBe(80);
    expect(
      service.tryConvertAmount(100, "USD", "EUR", rates(), {
        conversion_date: "2026-07-31",
      }),
    ).toBe(90);
  });
  it("does not borrow a rate from the future or beyond the canonical age bound", () => {
    expect(
      service.tryConvertAmount(100, "USD", "EUR", rates(), {
        conversion_date: "2026-06-15",
      }),
    ).toBeNull();
    expect(
      service.tryConvertAmount(100, "USD", "EUR", rates(), {
        conversion_date: "2026-09-30",
      }),
    ).toBeNull();
  });
  it("uses an applicable source-entered rate in its stored direction without repeating a fee", () => {
    expect(
      service.tryConvertAmount(-125, "USD", "EUR", rates(), {
        conversion_date: "2026-06-15",
        original_currency_code: "EUR",
        exchange_rate: "1.25",
      }),
    ).toBe(-100);
  });
  it("preserves zero and same-currency amounts without any FX observation", () => {
    expect(
      service.tryConvertAmount(0, "USD", "EUR", new Map(), {
        conversion_date: "2026-06-15",
      }),
    ).toBe(0);
    expect(
      service.tryConvertAmount(-100.0001, "USD", "USD", new Map(), {
        conversion_date: "2026-06-15",
      }),
    ).toBe(-100.0001);
  });
  it("withholds an unsupported legacy report shape rather than mixing unconverted units", () => {
    expect(
      service.tryConvertAmount(100, "USD", "EUR", rates(), {
        conversion_date: "2026-06-15",
      }),
    ).toBeNull();
  });
});
