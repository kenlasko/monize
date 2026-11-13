import { BadRequestException, NotFoundException } from "@nestjs/common";
import { assertAmountPrecision } from "../common/amount-precision.util";
import { precisionCurrencyFor } from "../common/currency-places.util";
import {
  ForeignEntryRateSource,
  ForeignEntryRequest,
  resolveForeignEntry,
} from "../common/foreign-entry.util";
import { normalizeFxEntry, roundFxRate } from "../common/fx-entry.util";
import { moneyDecimalsFor, roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";

/** A tool caller's foreign-currency figures plus the market-rate lookup. */
export interface ForeignEntryPreviewRequest extends ForeignEntryRequest {
  /** The stored market rate for `from -> to` on `date`, or null when none. */
  lookupRate?: (
    from: string,
    to: string,
    date: string,
  ) => Promise<number | null>;
}

/**
 * The foreign-currency entry a create or edit preview carries, by the field
 * names the row stores. On a create it is present only for a foreign entry; on
 * an edit only when the edit changes the entry, `originalCurrencyCode: null`
 * meaning it is cleared (the row becomes an ordinary account-currency entry).
 */
export interface ForeignEntryFields {
  originalAmount?: number | null;
  originalCurrencyCode?: string | null;
  exchangeRate?: number;
  /** Display only, never signed: where the rate came from. */
  exchangeRateSource?: ForeignEntryRateSource;
}

/**
 * The foreign-entry fields a signed descriptor carries and a commit writes:
 * `ForeignEntryFields` without the display-only rate source.
 */
export type ForeignEntryWrite = Omit<ForeignEntryFields, "exchangeRateSource">;

/**
 * The signed (and committed) half of a preview's foreign entry, or nothing
 * when it carries none. Written once for every descriptor builder and every
 * commit path, so none can drop a field the card showed.
 */
export function foreignEntryWriteFields(
  src: ForeignEntryWrite,
): ForeignEntryWrite {
  if (src.originalCurrencyCode === undefined) return {};
  // `previewForeignEntry` always sets the rate beside the code; an absent one
  // stays absent (the commit then keeps the row's own), never a guessed 1.
  return {
    originalAmount: src.originalAmount ?? null,
    originalCurrencyCode: src.originalCurrencyCode,
    ...(src.exchangeRate === undefined
      ? {}
      : { exchangeRate: src.exchangeRate }),
  };
}

/** The confirmation card's copy of a preview's foreign entry, source included. */
export function foreignEntryDisplayFields(
  src: ForeignEntryFields,
): ForeignEntryFields {
  if (src.originalCurrencyCode === undefined) return {};
  return {
    ...foreignEntryWriteFields(src),
    ...(src.exchangeRateSource
      ? { exchangeRateSource: src.exchangeRateSource }
      : {}),
  };
}

/** The entry a stored row already holds (an edit's defaults). */
export interface StoredForeignEntry {
  amount: number;
  originalAmount: number | null;
  originalCurrencyCode: string | null;
  exchangeRate: number;
}

export interface PreviewForeignEntryArgs {
  account: { currencyCode: string; fxFeePercent?: number | null };
  /** The account-currency amount the caller gave, if any. */
  amount: number | undefined;
  /** The date a market rate is looked up for. */
  date: string;
  request: ForeignEntryPreviewRequest;
  /**
   * Edit only: the row's own entry, which the request's fields override. Its
   * amount is what the account was charged, so it stays the fact unless the
   * edit moves it or gives a new rate (which then computes it); the market
   * rate is never consulted for an existing row.
   */
  stored?: StoredForeignEntry;
}

function requiresOther(param: string, other: string): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.params.requiresOther",
      `A value for "${param}" requires one for "${other}" as well`,
      { param, other },
    ),
  );
}

/** `currencies.decimal_places` of `codes`, read outside any open transaction. */
export type CurrencyPlacesLoader = (
  codes: readonly string[],
) => Promise<ReadonlyMap<string, number>>;

/**
 * Resolve a tool caller's foreign-currency figures against the account, for
 * `TransactionsService.previewCreate` / `previewUpdate`: name checks, the
 * original currency's existence and precision, then `resolveForeignEntry`,
 * then the commit's own `normalizeFxEntry` so the preview refuses what the
 * commit would. Returns the amount the row will store (on an edit, the
 * row's own when nothing moves it; `undefined` on a create that gave none and
 * names no entry), the fields to carry (`null` when the entry does not
 * change) and the places it loaded, account currency included.
 *
 * Called outside any database transaction: the market-rate lookup may ask a
 * provider over HTTP and store what it answers, which must neither hold a
 * transaction open nor abort the caller's.
 */
export async function previewForeignEntry(
  loadPlaces: CurrencyPlacesLoader,
  args: PreviewForeignEntryArgs,
): Promise<{
  amount: number | undefined;
  fields: ForeignEntryFields | null;
  places: ReadonlyMap<string, number> | null;
}> {
  const { request, stored } = args;
  const accountCode = args.account.currencyCode.toUpperCase();
  const code =
    request.originalCurrencyCode !== undefined
      ? request.originalCurrencyCode.toUpperCase()
      : (stored?.originalCurrencyCode?.toUpperCase() ?? null);
  const originalAmount =
    request.originalAmount ?? stored?.originalAmount ?? undefined;

  if (code === null) {
    if (request.originalAmount !== undefined)
      throw requiresOther("originalAmount", "originalCurrencyCode");
    if (request.exchangeRate !== undefined)
      throw requiresOther("exchangeRate", "originalCurrencyCode");
    return {
      amount: args.amount ?? stored?.amount,
      fields: null,
      places: null,
    };
  }
  const places = await loadPlaces([accountCode, code]);
  if (!places.has(code)) {
    throw new NotFoundException(
      tr("errors.currencies.notFound", `Currency "${code}" not found`, {
        code,
      }),
    );
  }
  const accountPlaces = places.get(accountCode) ?? null;
  const moneyDecimals = moneyDecimalsFor(accountPlaces);

  // The account's own currency: an ordinary entry after all, as
  // `normalizeFxEntry` treats it. A stored foreign entry is cleared.
  if (code === accountCode) {
    if (request.exchangeRate !== undefined) {
      throw new BadRequestException(
        tr(
          "errors.transactions.fxSameCurrencyRate",
          `${code} is the account's own currency, which takes no exchangeRate. Leave out exchangeRate, or give the currency that was actually paid in.`,
          { currency: code },
        ),
      );
    }
    const given = request.originalAmount;
    // On an edit the row's own amount stands in for one not sent: clearing an
    // entry never turns its original amount into the amount charged.
    const charged = args.amount ?? stored?.amount;
    if (
      given !== undefined &&
      charged !== undefined &&
      roundMoney(charged, moneyDecimals) !== roundMoney(given, moneyDecimals)
    ) {
      throw new BadRequestException(
        tr(
          "errors.transactions.fxSameCurrencyAmounts",
          `${code} is the account's own currency, so originalAmount (${given}) and amount (${charged}) must be the same. Leave out originalAmount, or give the currency that was actually paid in.`,
          { currency: code, original: given, amount: charged },
        ),
      );
    }
    // Cleared without new figures, the row keeps the amount it was charged.
    return {
      amount: args.amount ?? given ?? stored?.amount,
      fields: stored?.originalCurrencyCode
        ? { originalAmount: null, originalCurrencyCode: null, exchangeRate: 1 }
        : null,
      places,
    };
  }

  // A different currency is a different original amount: the row's own is in
  // the currency it replaces, and reading it as the new one would move the
  // balance by a conversion nobody entered.
  const storedCode = stored?.originalCurrencyCode?.toUpperCase() ?? null;
  if (
    storedCode !== null &&
    storedCode !== code &&
    request.originalAmount === undefined
  ) {
    throw requiresOther("originalCurrencyCode", "originalAmount");
  }
  if (originalAmount === undefined || originalAmount === null)
    throw requiresOther("originalCurrencyCode", "originalAmount");
  assertAmountPrecision(
    originalAmount,
    precisionCurrencyFor(places, code),
    "originalAmount",
  );

  // A value difference, not a field being present: a figure resent as the row
  // holds it is not given. On an edit the row's amount is the default, so a
  // changed original amount or currency re-derives the rate from what the
  // account was charged rather than converting over it.
  let amount = args.amount;
  let exchangeRate = request.exchangeRate;
  if (stored !== undefined) {
    const rateResent =
      exchangeRate !== undefined &&
      storedCode === code &&
      roundFxRate(Number(exchangeRate)) ===
        roundFxRate(Number(stored.exchangeRate));
    const amountMoved =
      amount !== undefined &&
      roundMoney(amount, moneyDecimals) !==
        roundMoney(stored.amount, moneyDecimals);
    if (
      !amountMoved &&
      (exchangeRate === undefined || rateResent) &&
      storedCode === code &&
      Number(stored.originalAmount) === originalAmount
    ) {
      return { amount: stored.amount, fields: null, places };
    }
    // A new amount beside the row's own rate resent: the amount is the
    // change, and the rate is derived from it rather than refused against it.
    if (amountMoved && rateResent) exchangeRate = undefined;
    // An amount the caller sent stays given, moved or not: beside a new rate
    // the two must agree, never the amount charged rewritten from the rate.
    // Only an amount not sent defaults: a rate sent (even the row's own,
    // beside a new original amount) computes it; otherwise the row's stands.
    if (amount === undefined)
      amount = exchangeRate === undefined ? stored.amount : undefined;
  }

  const resolved = await resolveForeignEntry(
    {
      amount,
      originalAmount,
      originalCurrencyCode: code,
      exchangeRate,
      fallbackRate: async () => {
        const rate = request.lookupRate
          ? await request.lookupRate(code, accountCode, args.date)
          : null;
        return { rate, source: "market" as const, date: args.date };
      },
    },
    {
      currencyCode: accountCode,
      moneyDecimals,
      decimalPlaces: accountPlaces ?? 2,
      fxFeePercent: args.account.fxFeePercent,
    },
  );
  // The commit's own validation: a positive rate, matching signs.
  normalizeFxEntry(
    {
      originalAmount: resolved.originalAmount,
      originalCurrencyCode: resolved.originalCurrencyCode,
      exchangeRate: resolved.exchangeRate,
      amount: resolved.amount,
    },
    accountCode,
  );

  // A value difference, not a field being present: an edit that resolves to
  // the row's own entry changes nothing.
  const unchanged =
    stored !== undefined &&
    storedCode === code &&
    Number(stored.originalAmount) === resolved.originalAmount &&
    roundFxRate(Number(stored.exchangeRate)) === resolved.exchangeRate &&
    roundMoney(stored.amount, moneyDecimals) ===
      roundMoney(resolved.amount, moneyDecimals);
  return {
    amount: resolved.amount,
    fields: unchanged
      ? null
      : {
          originalAmount: resolved.originalAmount,
          originalCurrencyCode: resolved.originalCurrencyCode,
          exchangeRate: resolved.exchangeRate,
          exchangeRateSource: resolved.exchangeRateSource,
        },
    places,
  };
}
