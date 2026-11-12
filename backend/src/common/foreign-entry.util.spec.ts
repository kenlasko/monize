import { BadRequestException } from "@nestjs/common";
import {
  ForeignEntryAccount,
  ResolveForeignEntryInput,
  fxBaseFromCharged,
  resolveForeignEntry,
} from "./foreign-entry.util";
import { applyFxConversion } from "./fx-entry.util";

const usd: ForeignEntryAccount = {
  currencyCode: "USD",
  moneyDecimals: 4,
  decimalPlaces: 2,
  fxFeePercent: null,
};

function input(
  overrides: Partial<ResolveForeignEntryInput>,
): ResolveForeignEntryInput {
  return {
    originalAmount: -100,
    originalCurrencyCode: "EUR",
    fallbackRate: jest.fn(async () => ({
      rate: 1.05,
      source: "market" as const,
      date: "2026-11-01",
    })),
    ...overrides,
  };
}

describe("resolveForeignEntry", () => {
  it("derives the rate from the amount charged and keeps that amount", async () => {
    const req = input({ amount: -110 });
    await expect(resolveForeignEntry(req, usd)).resolves.toEqual({
      amount: -110,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.1,
      exchangeRateSource: "derived",
    });
    expect(req.fallbackRate).not.toHaveBeenCalled();
  });

  it("backs the account's fee out of the amount charged before deriving the rate", async () => {
    const result = await resolveForeignEntry(input({ amount: -110 }), {
      ...usd,
      fxFeePercent: 2.5,
    });
    // -110 / 1.025 = -107.3171 before the fee; 1.073171 per euro.
    expect(result.exchangeRate).toBe(1.073171);
    expect(result.amount).toBe(-110);
    // The conversion at that rate, fee folded in, is the amount charged.
    expect(applyFxConversion(-100, result.exchangeRate, 2.5).amount).toBe(-110);
  });

  it("computes the amount from a supplied rate, with the account's fee", async () => {
    await expect(
      resolveForeignEntry(input({ exchangeRate: 1.0987 }), usd),
    ).resolves.toMatchObject({
      amount: -109.87,
      exchangeRate: 1.0987,
      exchangeRateSource: "supplied",
    });
    await expect(
      resolveForeignEntry(input({ exchangeRate: 1.1 }), {
        ...usd,
        fxFeePercent: 2.5,
      }),
    ).resolves.toMatchObject({ amount: -112.75 });
  });

  it("keeps both figures when the supplied rate converts to the amount within one cent", async () => {
    // 1,234.56 x 1.098654 = 1,356.3542; the bank charged 1,356.36.
    await expect(
      resolveForeignEntry(
        input({
          originalAmount: -1234.56,
          exchangeRate: 1.098654,
          amount: -1356.36,
        }),
        usd,
      ),
    ).resolves.toMatchObject({
      amount: -1356.36,
      exchangeRate: 1.098654,
      exchangeRateSource: "supplied",
    });
  });

  it("refuses a supplied rate that disagrees with the amount charged, rewriting neither", async () => {
    const result = resolveForeignEntry(
      input({ exchangeRate: 1.2, amount: -110 }),
      usd,
    );
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toThrow(/converts to -120 USD.*not -110 USD/);
  });

  it("holds a zero-decimal currency to one unit", async () => {
    const jpy = { ...usd, currencyCode: "JPY", decimalPlaces: 0 };
    // 100 EUR at 163.456 = 16,345.6 JPY; 16,346 charged is within one yen.
    await expect(
      resolveForeignEntry(
        input({ exchangeRate: 163.456, amount: -16346 }),
        jpy,
      ),
    ).resolves.toMatchObject({ amount: -16346 });
    await expect(
      resolveForeignEntry(
        input({ exchangeRate: 163.456, amount: -16348 }),
        jpy,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uses the fallback rate when neither figure is given, and says so", async () => {
    const req = input({});
    await expect(resolveForeignEntry(req, usd)).resolves.toEqual({
      amount: -105,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.05,
      exchangeRateSource: "market",
    });
    expect(req.fallbackRate).toHaveBeenCalledTimes(1);
  });

  it("names the pair and the date when no fallback rate exists", async () => {
    const result = resolveForeignEntry(
      input({
        fallbackRate: async () => ({
          rate: null,
          source: "market",
          date: "2026-11-01",
        }),
      }),
      usd,
    );
    await expect(result).rejects.toThrow(
      /No EUR to USD exchange rate is available for 2026-11-01/,
    );
  });

  it("refuses amounts that imply a rate the column cannot store, naming both", async () => {
    // 1,000,000 USD for 0.0001 of a coin is a rate of 1e10.
    await expect(
      resolveForeignEntry(
        input({
          originalAmount: -0.0001,
          originalCurrencyCode: "XBT",
          amount: -1000000,
        }),
        usd,
      ),
    ).rejects.toThrow(/-0.0001 XBT charged as -1000000 USD implies/);
    // Something charged for nothing paid, and no rate asked for.
    const zero = input({ originalAmount: 0, amount: -5 });
    await expect(resolveForeignEntry(zero, usd)).rejects.toThrow(
      /0 EUR charged as -5 USD implies/,
    );
    expect(zero.fallbackRate).not.toHaveBeenCalled();
    // Nothing charged for something paid has no positive rate.
    await expect(
      resolveForeignEntry(input({ amount: 0 }), usd),
    ).rejects.toThrow(/cannot be stored/);
  });

  it("refuses an amount whose sign differs from the original amount's", async () => {
    await expect(
      resolveForeignEntry(input({ amount: 110 }), usd),
    ).rejects.toThrow(/same sign/);
  });

  it("takes the fallback rate for a zero original amount, which no rate derives from", async () => {
    const req = input({ originalAmount: 0, amount: 0 });
    await expect(resolveForeignEntry(req, usd)).resolves.toMatchObject({
      amount: 0,
      exchangeRate: 1.05,
      exchangeRateSource: "market",
    });
  });
});

describe("fxBaseFromCharged", () => {
  it("is the amount itself without a fee", () => {
    expect(fxBaseFromCharged(-110, null, 4)).toBe(-110);
    expect(fxBaseFromCharged(-110, 0, 4)).toBe(-110);
  });

  it("inverts the fee for a charge and for a refund", () => {
    expect(fxBaseFromCharged(-102.5, 2.5, 4)).toBe(-100);
    expect(fxBaseFromCharged(97.5, 2.5, 4)).toBe(100);
  });
});
