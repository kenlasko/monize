import { BadRequestException } from "@nestjs/common";
import {
  applyFxConversion,
  resolveFxRateOrNull,
  normalizeFxEntry,
  roundFxRate,
  FX_RATE_DECIMALS,
} from "./fx-entry.util";

describe("fx-entry.util", () => {
  describe("normalizeFxEntry", () => {
    it("returns nulls when neither field is present", () => {
      expect(normalizeFxEntry({ amount: -50 }, "CAD")).toEqual({
        originalAmount: null,
        originalCurrencyCode: null,
      });
    });

    it("rejects a half-supplied pair", () => {
      expect(() =>
        normalizeFxEntry({ amount: -50, originalAmount: -40 }, "CAD"),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeFxEntry({ amount: -50, originalCurrencyCode: "USD" }, "CAD"),
      ).toThrow(BadRequestException);
    });

    it("strips the pair when the entry currency is the account currency", () => {
      expect(
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: -50,
            originalCurrencyCode: "cad",
            exchangeRate: 1,
          },
          "CAD",
        ),
      ).toEqual({ originalAmount: null, originalCurrencyCode: null });
    });

    it("requires a positive rate", () => {
      expect(() =>
        normalizeFxEntry(
          { amount: -50, originalAmount: -40, originalCurrencyCode: "USD" },
          "CAD",
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: -40,
            originalCurrencyCode: "USD",
            exchangeRate: 0,
          },
          "CAD",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects a sign mismatch between the two amounts", () => {
      expect(() =>
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: 40,
            originalCurrencyCode: "USD",
            exchangeRate: 1.37,
          },
          "CAD",
        ),
      ).toThrow(BadRequestException);
    });

    it("uppercases and keeps a valid pair", () => {
      expect(
        normalizeFxEntry(
          {
            amount: -54.8,
            originalAmount: -40,
            originalCurrencyCode: "usd",
            exchangeRate: 1.37,
          },
          "CAD",
        ),
      ).toEqual({ originalAmount: -40, originalCurrencyCode: "USD" });
    });
  });

  describe("roundFxRate", () => {
    it("keeps a rate at the column's ten decimal places", () => {
      expect(FX_RATE_DECIMALS).toBe(10);
      expect(roundFxRate(1 / 1.3652)).toBeCloseTo(0.7324934076, 10);
    });

    it("does not collapse a six-decimal rate to four", () => {
      // The regression this replaced: roundMoney(1/1.3652) gave 0.7325, which
      // inverts back to 1.36519... -> 1.3661 at four decimals.
      const inverse = roundFxRate(1 / 1.3652);
      expect(inverse).not.toBe(0.7325);
      expect(roundFxRate(1 / inverse)).toBeCloseTo(1.3652, 6);
    });
  });

  describe("applyFxConversion", () => {
    it("converts without a fee", () => {
      expect(applyFxConversion(-40, 1.3652, null)).toEqual({
        base: -54.608,
        fee: 0,
        amount: -54.608,
      });
    });

    it("folds a foreign transaction fee into the amount", () => {
      const { base, fee, amount } = applyFxConversion(-40, 1.3652, 2.5);
      expect(base).toBe(-54.608);
      expect(fee).toBe(-1.3652);
      expect(amount).toBe(-55.9732);
    });

    it("charges the fee as a cost on an inbound amount too", () => {
      const { fee, amount } = applyFxConversion(40, 1.3652, 2.5);
      expect(fee).toBe(-1.3652);
      expect(amount).toBe(53.2428);
    });

    it("uses the full rate precision rather than a rounded one", () => {
      // A six-decimal rate on a four-figure amount: rounding the rate to four
      // decimals first would lose cents.
      const precise = applyFxConversion(1000, 1.365234, null).amount;
      const rounded = applyFxConversion(1000, 1.3652, null).amount;
      expect(precise).toBe(1365.234);
      expect(precise).not.toBe(rounded);
    });

    it("rounds a fiat conversion at four places by default, as before", () => {
      // docs/specs/money-precision.md section 6: 100.00 USD at 1.3652.
      expect(applyFxConversion(100, 1.3652, null)).toEqual({
        base: 136.52,
        fee: 0,
        amount: 136.52,
      });
      expect(applyFxConversion(1700, 0.0000073529, null).amount).toBe(0.0125);
      expect(
        applyFxConversion(1700, 0.0000073529, null, { toDecimals: 4 }),
      ).toEqual(applyFxConversion(1700, 0.0000073529, null));
    });

    it("rounds a conversion into a coin at the coin's precision", () => {
      // 1,700 CAD into BTC at 0.0000073529 BTC per CAD.
      expect(
        applyFxConversion(1700, 0.0000073529, null, { toDecimals: 8 }),
      ).toEqual({ base: 0.01249993, fee: 0, amount: 0.01249993 });
      // 1700 / 136000.1234567890 at eight places, not 0.0125.
      expect(
        applyFxConversion(1700, 1 / 136000.123456789, null, { toDecimals: 8 })
          .amount,
      ).toBe(0.01249999);
    });

    it("rounds the fee and the total at the target precision too", () => {
      const { base, fee, amount } = applyFxConversion(
        -1700,
        0.0000073529,
        2.5,
        {
          toDecimals: 8,
        },
      );
      expect(base).toBe(-0.01249993);
      expect(fee).toBe(-0.0003125);
      expect(amount).toBe(-0.01281243);
    });
  });

  describe("resolveFxRateOrNull", () => {
    it("resolves and rounds the dated rate, without a dead getLatestRate chase", async () => {
      const rates = {
        getRateForDate: jest.fn().mockResolvedValue(1.36523449999),
        getLatestRate: jest.fn(),
      };
      await expect(
        resolveFxRateOrNull(rates, "USD", "CAD", "2026-01-15"),
      ).resolves.toBe(1.3652345);
      // getRateForDate already falls back to the latest stored rate internally
      // (its documented step 3); a caller-side chase is the dead call four
      // hand-rolled copies of this ladder used to carry.
      expect(rates.getLatestRate).not.toHaveBeenCalled();
    });

    it("asks for the latest stored rate directly when there is no date", async () => {
      const rates = {
        getRateForDate: jest.fn(),
        getLatestRate: jest.fn().mockResolvedValue(0.8),
      };
      await expect(
        resolveFxRateOrNull(rates, "USD", "EUR", null),
      ).resolves.toBe(0.8);
      expect(rates.getRateForDate).not.toHaveBeenCalled();
    });

    it("treats zero, negative and missing rates as absent", async () => {
      for (const bad of [0, -1, null]) {
        const rates = {
          getRateForDate: jest.fn().mockResolvedValue(bad),
          getLatestRate: jest.fn(),
        };
        await expect(
          resolveFxRateOrNull(rates, "USD", "THB", "2026-01-15"),
        ).resolves.toBeNull();
      }
    });
  });
});
