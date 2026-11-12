import { BadRequestException } from "@nestjs/common";
import { applyFxConversion, roundFxRate } from "./fx-entry.util";
import { roundMoney } from "./round.util";
import { tr } from "../i18n/translate";
import { MAX_STORED_RATE } from "../currencies/canonical-rate.util";

/**
 * Where the exchange rate of a foreign-currency entry came from, so the
 * confirmation can say which one it used (INV-FX-002):
 * - `supplied`: the caller gave it;
 * - `derived`: worked out from the original amount and the account-currency
 *   amount the caller gave (what the account was actually charged);
 * - `market`: the stored market rate for the date, neither figure given.
 */
export type ForeignEntryRateSource = "supplied" | "derived" | "market";

/** The foreign-currency figures a tool caller sends (any subset). */
export interface ForeignEntryRequest {
  originalAmount?: number;
  originalCurrencyCode?: string;
  exchangeRate?: number;
}

/**
 * A tool item's foreign-currency figures, as the adapters of both surfaces
 * hand them to the shared prep (`TransactionToolPrepService`): picked once, so
 * a field added here reaches every create and edit row.
 */
export function pickForeignEntryRequest(item: {
  originalAmount?: unknown;
  originalCurrencyCode?: unknown;
  exchangeRate?: unknown;
}): ForeignEntryRequest {
  return {
    originalAmount: item.originalAmount as number | undefined,
    originalCurrencyCode: item.originalCurrencyCode as string | undefined,
    exchangeRate: item.exchangeRate as number | undefined,
  };
}

/** Whether a request names any foreign-entry figure at all. */
export function hasForeignEntryRequest(request: ForeignEntryRequest): boolean {
  return (
    request.originalAmount !== undefined ||
    request.originalCurrencyCode !== undefined ||
    request.exchangeRate !== undefined
  );
}

/** The account a foreign entry is converted into. */
export interface ForeignEntryAccount {
  currencyCode: string;
  /** `moneyDecimalsFor` of the account currency: what an amount rounds at. */
  moneyDecimals: number;
  /**
   * The account currency's `decimal_places` (2 for USD, 0 for JPY): one unit
   * of it is how far a supplied rate's conversion may sit from the amount.
   */
  decimalPlaces: number;
  fxFeePercent: number | null | undefined;
}

export interface ResolveForeignEntryInput {
  /** The account-currency amount the caller gave, when it gave one. */
  amount?: number;
  originalAmount: number;
  /** Upper-cased; never the account's own currency. */
  originalCurrencyCode: string;
  exchangeRate?: number;
  /**
   * The rate to use when the caller gave neither `amount` nor `exchangeRate`
   * (or both amounts are zero, which no rate can be derived from).
   * Called only then, so a provider lookup is never made for nothing.
   */
  fallbackRate: () => Promise<{
    rate: number | null;
    source: "market";
    date: string;
  }>;
}

export interface ResolvedForeignEntry {
  /** The account-currency amount the row stores. */
  amount: number;
  originalAmount: number;
  originalCurrencyCode: string;
  exchangeRate: number;
  exchangeRateSource: ForeignEntryRateSource;
}

/**
 * The pre-fee base behind an account-currency amount that has the account's
 * foreign-transaction fee folded in: the inverse of `applyFxConversion`'s
 * `amount = base - |base| x fee%`. `handleConvertedTotalOverride` in
 * `frontend/src/components/transactions/TransactionForm.tsx` inverts the same
 * way but rounds the base to the entry places and recomputes the amount; here
 * the base keeps money precision and the amount charged is kept as given, so
 * converting back at the derived rate returns that amount.
 */
export function fxBaseFromCharged(
  amount: number,
  fxFeePercent: number | null | undefined,
  decimals: number,
): number {
  if (!fxFeePercent || fxFeePercent <= 0) return amount;
  const p = fxFeePercent / 100;
  return roundMoney(
    amount >= 0 ? amount / (1 - p) : amount / (1 + p),
    decimals,
  );
}

/**
 * Work out a foreign-currency entry the way the transaction form does, from
 * whichever figures the caller gave, and refuse the ones that disagree:
 *
 * | amount | exchangeRate | result                                                     |
 * |--------|--------------|------------------------------------------------------------|
 * | given  | given        | both kept, when the rate converts to the amount within one unit of the account currency; refused otherwise |
 * | given  | -            | rate derived from the two amounts (fee backed out)         |
 * | -      | given        | amount = originalAmount x rate, with the account's fee     |
 * | -      | -            | `fallbackRate` (the market rate), amount from it           |
 *
 * The amount the account was charged is the fact: it is never replaced by a
 * conversion. The commit re-validates the result through `normalizeFxEntry`.
 */
export async function resolveForeignEntry(
  input: ResolveForeignEntryInput,
  account: ForeignEntryAccount,
): Promise<ResolvedForeignEntry> {
  const { originalAmount, originalCurrencyCode, amount } = input;
  const { moneyDecimals, fxFeePercent } = account;
  const currency = account.currencyCode.toUpperCase();

  if (
    amount !== undefined &&
    amount !== 0 &&
    originalAmount !== 0 &&
    amount > 0 !== originalAmount > 0
  ) {
    throw new BadRequestException(
      tr(
        "errors.params.sameSign",
        'The values of "originalAmount" and "amount" must have the same sign',
        { param: "originalAmount", other: "amount" },
      ),
    );
  }

  let rate: number;
  let source: ForeignEntryRateSource;
  if (input.exchangeRate !== undefined) {
    rate = roundFxRate(Number(input.exchangeRate));
    source = "supplied";
  } else if (amount !== undefined && !(amount === 0 && originalAmount === 0)) {
    const base = fxBaseFromCharged(amount, fxFeePercent, moneyDecimals);
    const derived = roundFxRate(base / originalAmount);
    // The exchange_rate column holds a positive rate below 1e10 at ten
    // places; amounts implying anything else (an amount of zero against a
    // non-zero original included) are refused naming both, never written.
    if (!(derived > 0) || derived >= MAX_STORED_RATE) {
      throw new BadRequestException(
        tr(
          "errors.transactions.fxDerivedRateOutOfRange",
          `${originalAmount} ${originalCurrencyCode} charged as ${amount} ${currency} implies an exchange rate that cannot be stored. Check both amounts, or give the exchangeRate.`,
          {
            original: originalAmount,
            originalCurrency: originalCurrencyCode,
            amount,
            currency,
          },
        ),
      );
    }
    return {
      amount,
      originalAmount,
      originalCurrencyCode,
      exchangeRate: derived,
      exchangeRateSource: "derived",
    };
  } else {
    const fallback = await input.fallbackRate();
    if (fallback.rate === null || !(fallback.rate > 0)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.fxEntryRateUnavailable",
          `No ${originalCurrencyCode} to ${currency} exchange rate is available for ${fallback.date}. Give the amount in ${currency} that the account was charged, or the exchangeRate.`,
          { from: originalCurrencyCode, to: currency, date: fallback.date },
        ),
      );
    }
    rate = roundFxRate(fallback.rate);
    source = fallback.source;
  }

  const converted = applyFxConversion(originalAmount, rate, fxFeePercent, {
    toDecimals: moneyDecimals,
  }).amount;
  if (amount === undefined) {
    return {
      amount: converted,
      originalAmount,
      originalCurrencyCode,
      exchangeRate: rate,
      exchangeRateSource: source,
    };
  }
  const tolerance = 10 ** -Math.max(0, account.decimalPlaces);
  if (Math.abs(roundMoney(converted - amount, moneyDecimals)) > tolerance) {
    throw new BadRequestException(
      tr(
        "errors.transactions.fxAmountsConflict",
        `${originalAmount} ${originalCurrencyCode} at an exchange rate of ${rate} converts to ${converted} ${currency} (after any foreign transaction fee on the account), not ${amount} ${currency}. Leave out exchangeRate to derive the rate from the two amounts, or leave out amount to compute it from the rate.`,
        {
          original: originalAmount,
          originalCurrency: originalCurrencyCode,
          rate,
          converted,
          amount,
          currency,
        },
      ),
    );
  }
  return {
    amount,
    originalAmount,
    originalCurrencyCode,
    exchangeRate: rate,
    exchangeRateSource: source,
  };
}
