import {
  indexRateRows,
  RateIndex,
} from "../common/time-series/rate-index.util";

/**
 * The day a report fixture's foreign rows are struck on, and the day its rates
 * are observed on unless a fixture says otherwise.
 *
 * A report converts each foreign row at the rate on its own date (issue
 * #2106), so a fixture row in a currency other than the reporting one carries
 * `tx_date`, as the query's `rateBasisColumnsSql` columns do.
 */
export const FIXTURE_TX_DATE = "2026-01-15";

/** One stored rate, in the shape the report specs have always listed them. */
export interface FixtureRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number | string;
  rateDate?: string;
}

/**
 * The pair index `ExchangeRateService.getRateIndex` answers, built from a list
 * of rates, each observed on its own `rateDate` or on {@link FIXTURE_TX_DATE}.
 */
export function rateIndexOf(rates: readonly FixtureRate[]): RateIndex {
  return indexRateRows(
    [...rates]
      .map((rate) => ({
        from_currency: rate.fromCurrency,
        to_currency: rate.toCurrency,
        rate: rate.rate,
        rate_date: rate.rateDate ?? FIXTURE_TX_DATE,
      }))
      .sort((a, b) => a.rate_date.localeCompare(b.rate_date)),
  );
}
