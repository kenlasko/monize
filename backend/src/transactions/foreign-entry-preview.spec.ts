import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { currencyPlacesRepoMock } from "../test-helpers/currency-places-testing";
import { loadCurrencyPlacesForRead } from "../common/currency-places.util";
import {
  CurrencyPlacesLoader,
  PreviewForeignEntryArgs,
  StoredForeignEntry,
  foreignEntryDisplayFields,
  foreignEntryWriteFields,
  previewForeignEntry,
} from "./foreign-entry-preview";

/** `currencies.decimal_places` as `loadCurrencyPlacesForRead` reads them. */
function manager(): CurrencyPlacesLoader {
  const currencies = currencyPlacesRepoMock({ USD: 2, EUR: 2, GBP: 2 });
  const m = { getRepository: () => currencies } as unknown as EntityManager;
  return (codes) => loadCurrencyPlacesForRead(m, codes);
}

const usdAccount = { currencyCode: "USD", fxFeePercent: null };

function args(
  overrides: Partial<PreviewForeignEntryArgs>,
): PreviewForeignEntryArgs {
  return {
    account: usdAccount,
    amount: undefined,
    date: "2026-11-01",
    request: {},
    ...overrides,
  };
}

/** A USD row entered as EUR 100, charged USD 110. */
const storedEur: StoredForeignEntry = {
  amount: -110,
  originalAmount: -100,
  originalCurrencyCode: "EUR",
  exchangeRate: 1.1,
};

describe("previewForeignEntry", () => {
  it("carries nothing when the row names no foreign entry", async () => {
    await expect(
      previewForeignEntry(manager(), args({ amount: -10 })),
    ).resolves.toEqual({ amount: -10, fields: null, places: null });
  });

  it("refuses an original amount or a rate without a currency", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({ request: { originalAmount: -100 } }),
      ),
    ).rejects.toThrow(
      /"originalAmount" requires one for "originalCurrencyCode"/,
    );
    await expect(
      previewForeignEntry(
        manager(),
        args({ amount: -10, request: { exchangeRate: 1.1 } }),
      ),
    ).rejects.toThrow(/"exchangeRate" requires one for "originalCurrencyCode"/);
  });

  it("refuses a currency without an original amount", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({ amount: -10, request: { originalCurrencyCode: "EUR" } }),
      ),
    ).rejects.toThrow(
      /"originalCurrencyCode" requires one for "originalAmount"/,
    );
  });

  it("refuses a currency the database does not know", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({
          amount: -10,
          request: { originalAmount: -10, originalCurrencyCode: "XYZ" },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("derives the rate from the two amounts, upper-casing the code", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({
          amount: -110,
          request: { originalAmount: -100, originalCurrencyCode: "eur" },
        }),
      ),
    ).resolves.toMatchObject({
      amount: -110,
      fields: {
        originalAmount: -100,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.1,
        exchangeRateSource: "derived",
      },
    });
  });

  it("looks up the market rate for the date only when neither figure is given", async () => {
    const lookupRate = jest.fn().mockResolvedValue(1.0987);
    await expect(
      previewForeignEntry(
        manager(),
        args({
          request: {
            originalAmount: -100,
            originalCurrencyCode: "EUR",
            lookupRate,
          },
        }),
      ),
    ).resolves.toMatchObject({
      amount: -109.87,
      fields: { exchangeRate: 1.0987, exchangeRateSource: "market" },
    });
    expect(lookupRate).toHaveBeenCalledWith("EUR", "USD", "2026-11-01");

    lookupRate.mockClear();
    await previewForeignEntry(
      manager(),
      args({
        amount: -110,
        request: {
          originalAmount: -100,
          originalCurrencyCode: "EUR",
          lookupRate,
        },
      }),
    );
    expect(lookupRate).not.toHaveBeenCalled();
  });

  it("refuses an original amount with more places than its currency carries", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({
          amount: -10,
          // Four places for every fiat currency (`moneyDecimalsFor`).
          request: { originalAmount: -100.12345, originalCurrencyCode: "EUR" },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a rate of zero, as the commit would", async () => {
    await expect(
      previewForeignEntry(
        manager(),
        args({
          request: {
            originalAmount: -100,
            originalCurrencyCode: "EUR",
            exchangeRate: 0,
          },
        }),
      ),
    ).rejects.toThrow(/positive exchange rate/);
  });

  describe("the account's own currency", () => {
    it("is an ordinary entry, the original amount standing in for amount", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalAmount: -100, originalCurrencyCode: "USD" },
          }),
        ),
      ).resolves.toMatchObject({ amount: -100, fields: null });
    });

    it("refuses two different amounts in the one currency", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            amount: -110,
            request: { originalAmount: -100, originalCurrencyCode: "USD" },
          }),
        ),
      ).rejects.toThrow(
        /originalAmount \(-100\) and amount \(-110\) must be the same/,
      );
    });

    it("refuses a rate, which the account's own currency does not take", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: {
              originalAmount: -100,
              originalCurrencyCode: "USD",
              exchangeRate: 1.1,
            },
          }),
        ),
      ).rejects.toThrow(/takes no exchangeRate/);
    });

    it("refuses clearing an entry with an original amount other than the amount charged", async () => {
      // Resending the row's euros as dollars would move the balance by 10.
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalCurrencyCode: "USD", originalAmount: -100 },
            stored: storedEur,
          }),
        ),
      ).rejects.toThrow(/originalAmount \(-100\) and amount \(-110\)/);
    });

    it("clears a stored entry, the row keeping the amount it was charged", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalCurrencyCode: "USD" },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({
        amount: -110,
        fields: {
          originalAmount: null,
          originalCurrencyCode: null,
          exchangeRate: 1,
        },
      });
    });
  });

  describe("an edit of a row entered in another currency", () => {
    it("derives the rate from the amount charged when only the original amount changes", async () => {
      const lookupRate = jest.fn();
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalAmount: -120, lookupRate },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({
        amount: -110,
        fields: {
          originalAmount: -120,
          originalCurrencyCode: "EUR",
          exchangeRate: 0.9166666667,
          exchangeRateSource: "derived",
        },
      });
      expect(lookupRate).not.toHaveBeenCalled();
    });

    it("changes nothing when a figure is resent as the row holds it", async () => {
      // A rate derived again from the same amounts can differ in its tenth
      // place; resent figures are not a change, so nothing is re-derived.
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalCurrencyCode: "eur", originalAmount: -100 },
            stored: { ...storedEur, exchangeRate: 1.0999999999 },
          }),
        ),
      ).resolves.toMatchObject({ amount: -110, fields: null });
    });

    it("computes the amount from the rate sent beside a new original amount, even the row's own", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalAmount: -120, exchangeRate: 1.1 },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({
        amount: -132,
        fields: { exchangeRate: 1.1, exchangeRateSource: "supplied" },
      });
    });

    it("derives the rate from a new amount beside the row's own rate resent", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            amount: -112,
            request: { exchangeRate: 1.1 },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({
        amount: -112,
        fields: { exchangeRate: 1.12, exchangeRateSource: "derived" },
      });
    });

    it("refuses a new rate that disagrees with the amount sent, even the row's own", async () => {
      // The amount charged is never rewritten from a rate beside it.
      await expect(
        previewForeignEntry(
          manager(),
          args({
            amount: -110,
            request: { exchangeRate: 1.2 },
            stored: storedEur,
          }),
        ),
      ).rejects.toThrow(/converts to -120 USD.*not -110 USD/);
    });

    it("computes the amount from a new rate when no amount is sent", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({ request: { exchangeRate: 1.2 }, stored: storedEur }),
        ),
      ).resolves.toMatchObject({
        amount: -120,
        fields: { exchangeRate: 1.2, exchangeRateSource: "supplied" },
      });
    });

    it("refuses turning an ordinary row into an entry whose rate disagrees with its amount", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            amount: -110,
            request: {
              originalAmount: -100,
              originalCurrencyCode: "EUR",
              exchangeRate: 1.05,
            },
            stored: {
              amount: -110,
              originalAmount: null,
              originalCurrencyCode: null,
              exchangeRate: 1,
            },
          }),
        ),
      ).rejects.toThrow(/converts to -105 USD.*not -110 USD/);
    });

    it("re-derives the rate when only the amount charged changes", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({ amount: -112, stored: storedEur }),
        ),
      ).resolves.toMatchObject({
        amount: -112,
        fields: { exchangeRate: 1.12, exchangeRateSource: "derived" },
      });
    });

    it("refuses a currency change without the amount in that currency", async () => {
      // The row's -100 is euros; read as pounds it would move the balance by
      // a conversion nobody entered.
      const lookupRate = jest.fn();
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: { originalCurrencyCode: "GBP", lookupRate },
            stored: storedEur,
          }),
        ),
      ).rejects.toThrow(
        /"originalCurrencyCode" requires one for "originalAmount"/,
      );
      expect(lookupRate).not.toHaveBeenCalled();
    });

    it("derives the rate from the amount charged when the currency changes with its amount", async () => {
      const lookupRate = jest.fn();
      await expect(
        previewForeignEntry(
          manager(),
          args({
            request: {
              originalAmount: -100,
              originalCurrencyCode: "GBP",
              lookupRate,
            },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({
        amount: -110,
        fields: {
          originalCurrencyCode: "GBP",
          exchangeRate: 1.1,
          exchangeRateSource: "derived",
        },
      });
      expect(lookupRate).not.toHaveBeenCalled();
    });

    it("changes nothing when the figures resolve to the row's own", async () => {
      await expect(
        previewForeignEntry(
          manager(),
          args({
            amount: -110,
            request: { originalAmount: -100, exchangeRate: 1.1 },
            stored: storedEur,
          }),
        ),
      ).resolves.toMatchObject({ amount: -110, fields: null });
    });
  });
});

describe("foreignEntryWriteFields / foreignEntryDisplayFields", () => {
  it("carry nothing for a preview without an entry", () => {
    expect(foreignEntryWriteFields({})).toEqual({});
    expect(foreignEntryDisplayFields({})).toEqual({});
  });

  it("sign the figures and show the source only on the card", () => {
    const preview = {
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.1,
      exchangeRateSource: "derived" as const,
    };
    expect(foreignEntryWriteFields(preview)).toEqual({
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.1,
    });
    expect(foreignEntryDisplayFields(preview)).toEqual(preview);
  });

  it("carry a cleared entry as nulls", () => {
    expect(
      foreignEntryWriteFields({
        originalAmount: null,
        originalCurrencyCode: null,
        exchangeRate: 1,
      }),
    ).toEqual({
      originalAmount: null,
      originalCurrencyCode: null,
      exchangeRate: 1,
    });
  });
});
