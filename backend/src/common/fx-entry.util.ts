import { BadRequestException } from "@nestjs/common";
import { FIAT_MONEY_DECIMALS, roundMoney, roundToDecimals } from "./round.util";
import { tr } from "../i18n/translate";

/**
 * Decimal places an exchange rate is stored at (`NUMERIC(20,10)` on both
 * `exchange_rates.rate` and the `exchange_rate` columns that reference it).
 *
 * Rates are kept at full stored precision rather than rounded to money
 * precision: a bank statement quotes USD/CAD to six decimals, and rounding the
 * rate to four before multiplying loses cents on a four-figure amount. Nothing
 * in the conversion path may round a rate tighter than this.
 */
export const FX_RATE_DECIMALS = 10;

/** Round an exchange rate to the precision it is stored at. */
export function roundFxRate(value: number): number {
  return roundToDecimals(value, FX_RATE_DECIMALS);
}

export interface FxEntryInput {
  originalAmount?: number | null;
  originalCurrencyCode?: string | null;
  exchangeRate?: number | null;
  amount: number;
}

export interface FxEntry {
  originalAmount: number | null;
  originalCurrencyCode: string | null;
}

/**
 * Validate and normalize the foreign-currency entry fields against the account
 * currency. Returns the values to persist:
 * - Both fields null when no foreign entry is present.
 * - Both stripped to null when the entered currency equals the account
 *   currency (tolerant: an ordinary entry, not an error).
 * - Otherwise both retained, after checking the pair is complete, the rate is
 *   positive, and the original amount matches the sign of the (account
 *   currency) amount.
 *
 * The account-currency `amount` and `currencyCode` are never modified here.
 * Shared by transactions and scheduled transactions so the two surfaces accept
 * exactly the same payloads and reject the same ones.
 */
export function normalizeFxEntry(
  input: FxEntryInput,
  accountCurrencyCode: string,
): FxEntry {
  const hasAmount =
    input.originalAmount !== undefined && input.originalAmount !== null;
  const hasCode =
    typeof input.originalCurrencyCode === "string" &&
    input.originalCurrencyCode.length > 0;

  if (!hasAmount && !hasCode) {
    return { originalAmount: null, originalCurrencyCode: null };
  }

  if (hasAmount !== hasCode) {
    throw new BadRequestException(
      tr(
        "errors.params.requiresOther",
        'A value for "originalAmount" requires one for "originalCurrencyCode" as well',
        { param: "originalAmount", other: "originalCurrencyCode" },
      ),
    );
  }

  const code = (input.originalCurrencyCode as string).toUpperCase();

  // Entered in the account currency after all -- treat as an ordinary entry and
  // strip the foreign metadata.
  if (code === accountCurrencyCode.toUpperCase()) {
    return { originalAmount: null, originalCurrencyCode: null };
  }

  const rate = input.exchangeRate;
  if (rate === undefined || rate === null || Number(rate) <= 0) {
    throw new BadRequestException(
      tr(
        "errors.transactions.fxRateRequired",
        "A positive exchange rate is required for a foreign-currency transaction",
      ),
    );
  }

  const original = Number(input.originalAmount);
  const amount = Number(input.amount);
  if (original > 0 !== amount > 0 && original !== 0 && amount !== 0) {
    throw new BadRequestException(
      tr(
        "errors.params.sameSign",
        'The values of "originalAmount" and "amount" must have the same sign',
        { param: "originalAmount", other: "amount" },
      ),
    );
  }

  return { originalAmount: original, originalCurrencyCode: code };
}

export interface FxConversion {
  /** Converted amount before the account's foreign-transaction fee. */
  base: number;
  /** The fee itself, always <= 0 (a cost), 0 when the account charges none. */
  fee: number;
  /** What the account is actually charged: base + fee. */
  amount: number;
}

/** Options for `applyFxConversion`. */
export interface FxConversionOptions {
  /**
   * The money precision of the currency converted INTO (the account's):
   * `moneyDecimalsFor(currency.decimalPlaces)`. Defaults to
   * `FIAT_MONEY_DECIMALS`, so a fiat conversion rounds exactly as before;
   * converting into a coin passes the coin's eight places, so 1,700 CAD at
   * 0.0000073529 is 0.01249993 BTC rather than 0.0125
   * (`docs/specs/money-precision.md` decision 5).
   */
  toDecimals?: number;
}

/**
 * Convert a foreign amount into the account currency at `rate`, folding in the
 * account's foreign-transaction fee the same way the transaction form does:
 *
 *   base   = round(originalAmount x rate)
 *   fee    = -round(|base| x feePercent / 100)
 *   amount = base + fee
 *
 * All three are in the account currency, so all three round at
 * `options.toDecimals`; the source amount is used as given, never rounded.
 *
 * No split is created for the fee -- it is part of what the account is charged,
 * and the Foreign Currency Fees report derives it back out of
 * (originalAmount, exchangeRate, amount). Keep this in step with
 * `recomputeFx` in `frontend/src/components/transactions/TransactionForm.tsx`.
 */
export function applyFxConversion(
  originalAmount: number,
  rate: number,
  fxFeePercent?: number | null,
  options: FxConversionOptions = {},
): FxConversion {
  const decimals = options.toDecimals ?? FIAT_MONEY_DECIMALS;
  const base = roundMoney(originalAmount * rate, decimals);
  const fee =
    fxFeePercent && fxFeePercent > 0
      ? -roundMoney((Math.abs(base) * fxFeePercent) / 100, decimals)
      : 0;
  return { base, fee, amount: roundMoney(base + fee, decimals) };
}

/**
 * The primary `currencyCode` a transaction row must carry: its account's.
 *
 * `amount` and `currencyCode` are the account-currency pair -- the schema and
 * entity model a foreign entry separately, in `originalAmount` /
 * `originalCurrencyCode` / `exchangeRate`, which is what shows that a mismatched
 * primary currency is not an alternative supported shape.
 *
 * Nothing checked it. Creation spread the client's `currencyCode` straight into
 * the entity and incremented the balance by the numeric `amount`, so a request
 * of `amount=100, currencyCode=USD` against a EUR account moved the balance by
 * 100 EUR and left a row reporting 100 USD. Both fields persist, so the error
 * survives backups and every later report (audit P5-003).
 *
 * Case-insensitive, because a correct client always sends the account's own
 * code and only its casing is worth tolerating. Returns the canonical value to
 * store.
 */
/**
 * The one market-rate ladder: the rate for `from -> to` at `date`, rounded to
 * FX_RATE_DECIMALS, or `null` when no usable rate exists anywhere. Zero and
 * negative rates are absent, not applicable.
 *
 * `ExchangeRateService.getRateForDate` already consults both stored directions
 * and, failing those, a provider window, so callers must not chase a `null`
 * from this helper with their own `getLatestRate` -- four hand-rolled copies of
 * this sequence existed and three carried exactly that dead trailing call, and
 * an unbounded latest-rate chase is what the age policy exists to stop
 * (`docs/time-series-contract.md` section 2.2). Copies are how resolvers
 * drift; this is the only one.
 */
export async function resolveFxRateOrNull(
  rates: {
    getRateForDate(
      from: string,
      to: string,
      date: string,
    ): Promise<number | null>;
    getLatestRate(from: string, to: string): Promise<number | null>;
  },
  from: string,
  to: string,
  /** `null` when the caller has no date: the latest stored rate is asked directly. */
  date: string | null,
): Promise<number | null> {
  const rate = date
    ? await rates.getRateForDate(from, to, date)
    : await rates.getLatestRate(from, to);
  if (rate === null || !(Number(rate) > 0)) return null;
  return roundFxRate(Number(rate));
}

export function assertTransactionCurrencyMatchesAccount(
  suppliedCurrencyCode: string | null | undefined,
  accountCurrencyCode: string,
): string {
  const account = accountCurrencyCode.toUpperCase();
  if (suppliedCurrencyCode === null || suppliedCurrencyCode === undefined) {
    return account;
  }

  const supplied = String(suppliedCurrencyCode).toUpperCase();
  if (supplied !== account) {
    throw new BadRequestException(
      tr(
        "errors.transactions.currencyMustMatchAccount",
        `Transaction currency ${supplied} must match the account currency ${account}. Use originalAmount and originalCurrencyCode for a foreign-currency entry.`,
        { supplied, account },
      ),
    );
  }
  return account;
}
