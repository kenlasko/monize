import {
  DatedRate,
  FxObservationLookup,
  FxRateGapReason,
  resolveFxRate,
} from "../../../common/time-series/fx-rate-resolver";
import { MnyExchangeRate, MnySecurityPrice } from "../../mny/model/mny-rows";
import { MnyImportOptions } from "../../mny/model/mny-import-options";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyRawFile } from "../model/kmy-raw";
import { Rational, ONE, div, sign } from "../model/kmy-rational";
import { rateNumber } from "./kmy-amounts";
import { KmySecurityMapping } from "./kmy-map-securities";

/**
 * Spec 5.9: price history and exchange rates. Security prices become
 * `MnySecurityPrice` rows keyed by the security's ordinal; currency pairs become
 * `MnyExchangeRate` rows keyed by 1-based positions in the sorted list of codes
 * the written rates use (the rate writer's handle map). A later duplicate of a
 * `(security, date)` or an unordered pair and date wins, as in KMyMoney.
 */

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The file's own rate for a pair on a date. `rate` is one unit of `from` in
 * `to`, exact, or null when the file has no admissible rate; `observedOn` is
 * the date of the observation used, or of the newest one that was too old;
 * `reason` is `resolveFxRate`'s cause for an unknown answer.
 */
export interface KmyRateAnswer {
  readonly rate: Rational | null;
  readonly observedOn: string | null;
  readonly reason: FxRateGapReason | null;
}

export interface KmyRateLookup {
  (from: string, to: string, date: string): KmyRateAnswer;
}

export interface KmyPriceMapping {
  readonly rawPrices: readonly MnySecurityPrice[];
  readonly rawExchangeRates: readonly MnyExchangeRate[];
  readonly currencyByHandle: ReadonlyMap<number, string>;
  readonly warnings: readonly MnyWarning[];
}

/**
 * The file's currency-to-currency prices as a lookup (spec 5.7.3, 5.9), under
 * Monize's own rule for "the rate for a date" (INV-FX-001): `resolveFxRate`
 * picks the observation -- the newest on or before the date, within
 * `FX_MAX_RATE_AGE_DAYS`, either direction, a tie to the direct pair -- and the
 * exact rational stored for that direction and date is the answer. The
 * resolver sees one observation per direction and date (the later duplicate,
 * as in KMyMoney) with a placeholder rate: its policy reads only dates and
 * direction, and the number it would compute is a float this mapper never uses.
 */
export function buildRateLookup(raw: KmyRawFile): KmyRateLookup {
  const securityIds = new Set(raw.securities.map((security) => security.id));
  const series = new Map<string, Map<string, Rational>>();
  for (const price of raw.prices) {
    if (
      securityIds.has(price.from) ||
      securityIds.has(price.to) ||
      sign(price.price) <= 0
    ) {
      continue;
    }
    const key = `${price.from}|${price.to}`;
    const dates = series.get(key) ?? new Map<string, Rational>();
    dates.set(price.date, price.price);
    series.set(key, dates);
  }
  const observations = new Map<string, DatedRate[]>(
    [...series].map(([key, dates]) => [
      key,
      [...dates.keys()].map((date) => ({ date, rate: 1 })),
    ]),
  );
  const observed: FxObservationLookup = (from, to) =>
    observations.get(`${from}|${to}`);
  // The date being priced is the transaction's own, never clamped to a clock.
  const resolve = (
    from: string,
    to: string,
    date: string,
    maxAgeDays?: number,
  ) => resolveFxRate(from, to, date, observed, { today: date, maxAgeDays });

  return (from, to, date) => {
    const answer = resolve(from, to, date);
    if (answer.status === "same_currency") {
      return { rate: ONE, observedOn: null, reason: null };
    }
    if (answer.status === "unknown" || answer.observedOn === null) {
      const stale =
        answer.reason === "stale_observation"
          ? resolve(from, to, date, Number.POSITIVE_INFINITY).observedOn
          : null;
      return { rate: null, observedOn: stale, reason: answer.reason };
    }
    const direct = answer.direction === "direct";
    const stored = series
      .get(direct ? `${from}|${to}` : `${to}|${from}`)
      ?.get(answer.observedOn) as Rational;
    return {
      rate: direct ? stored : div(ONE, stored),
      observedOn: answer.observedOn,
      reason: null,
    };
  };
}

export interface MapKmyPricesInput {
  readonly raw: KmyRawFile;
  readonly securities: KmySecurityMapping;
  readonly options: MnyImportOptions;
  /** Currencies an imported account or security uses, and the base currency. */
  readonly usedCurrencies: ReadonlySet<string>;
}

export function mapKmyPrices(input: MapKmyPricesInput): KmyPriceMapping {
  const { raw, securities, options, usedCurrencies } = input;
  const warnings: MnyWarning[] = [];
  const securityIds = new Set(raw.securities.map((security) => security.id));
  const currencyIds = new Set(raw.currencies.map((currency) => currency.id));
  const isCurrency = (id: string): boolean =>
    !securityIds.has(id) && (currencyIds.has(id) || CURRENCY_CODE.test(id));

  const prices = new Map<string, MnySecurityPrice>();
  const rates = new Map<
    string,
    { from: string; to: string; rate: number; date: string }
  >();

  for (const price of raw.prices) {
    if (securityIds.has(price.from)) {
      const security = securities.byId.get(price.from);
      if (!security || !options.importPrices || !isCurrency(price.to)) {
        continue;
      }
      if (price.to !== security.currencyCode) {
        warnings.push({
          code: "priceCurrencyMismatch",
          subject: security.symbol,
          detail: price.to,
        });
        continue;
      }
      if (sign(price.price) <= 0) {
        continue;
      }
      prices.set(`${security.handle}|${price.date}`, {
        handle: price.ordinal,
        security: security.handle,
        date: price.date,
        price: rateNumber(price.price),
        split: null,
      });
      continue;
    }

    if (!isCurrency(price.from) || !isCurrency(price.to)) {
      continue;
    }
    if (!options.importExchangeRates) {
      continue;
    }
    if (!usedCurrencies.has(price.from) || !usedCurrencies.has(price.to)) {
      warnings.push({
        code: "unusedCurrencyRatesSkipped",
        subject: `${price.from}/${price.to}`,
        detail: price.date,
      });
      continue;
    }
    const rate = rateNumber(price.price);
    if (price.from === price.to || sign(price.price) <= 0 || rate <= 0) {
      continue;
    }
    const pair = [price.from, price.to].sort().join("|");
    rates.set(`${pair}|${price.date}`, {
      from: price.from,
      to: price.to,
      rate,
      date: price.date,
    });
  }

  const codes = [
    ...new Set([...rates.values()].flatMap((row) => [row.from, row.to])),
  ].sort();
  const handleByCode = new Map(codes.map((code, index) => [code, index + 1]));

  return {
    rawPrices: [...prices.values()],
    rawExchangeRates: [...rates.values()].map((row) => ({
      fromCurrency: handleByCode.get(row.from) as number,
      toCurrency: handleByCode.get(row.to) as number,
      rate: row.rate,
      date: row.date,
      historical: true,
    })),
    currencyByHandle: new Map(codes.map((code, index) => [index + 1, code])),
    warnings,
  };
}
