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

export interface KmyRateLookup {
  /**
   * One unit of `from` in `to` on or before `date`, from the file's own
   * currency-to-currency prices (either direction), or null when it has none.
   */
  (from: string, to: string, date: string): Rational | null;
}

export interface KmyPriceMapping {
  readonly rawPrices: readonly MnySecurityPrice[];
  readonly rawExchangeRates: readonly MnyExchangeRate[];
  readonly currencyByHandle: ReadonlyMap<number, string>;
  readonly warnings: readonly MnyWarning[];
}

interface Dated {
  readonly date: string;
  readonly price: Rational;
}

/** The file's currency-to-currency prices as a lookup (spec 5.7.3, 5.9). */
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

  const newest = (key: string, date: string): Dated | null => {
    let best: Dated | null = null;
    for (const [when, price] of series.get(key) ?? []) {
      if (when <= date && (best === null || when > best.date)) {
        best = { date: when, price };
      }
    }
    return best;
  };

  return (from, to, date) => {
    if (from === to) {
      return ONE;
    }
    const direct = newest(`${from}|${to}`, date);
    const inverse = newest(`${to}|${from}`, date);
    if (direct && (!inverse || direct.date >= inverse.date)) {
      return direct.price;
    }
    return inverse ? div(ONE, inverse.price) : null;
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
