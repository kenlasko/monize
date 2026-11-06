import {
  BenchmarkFetchError,
  BondAdapter,
  BondFetch,
  BondProgramDefinition,
} from "../../bond-adapter";
import { registerCalendar } from "../../domain/calendar-registry";
import type { CalendarRegistry } from "../../domain/calendar-registry";
import { programOf } from "./cusip";
import { fetchBlsCpi } from "./us-bls-cpi";
import { US_CPI_U_NSA, US_TBILL_13W_MMY, usBenchmarks } from "./us-benchmarks";
import { fetchTbill13w } from "./us-tbill-13w";
import { todayInTimezone } from "../../../common/date-utils";
import { auctionsNear } from "./series/auctions-near";
import { fetchSeries } from "./series/fetch-series";
import { SERIES_PROVIDER } from "./series/series-source";
import { SERIES_TEMPLATES } from "./series/templates";
import { usCalendar } from "./us-calendar";

export { usCalendar } from "./us-calendar";

const US_TIMEZONE = "America/New_York";

/** The registry plus the US calendar, for the caller to pass to the engine. */
export function registerUsCalendars(
  registry: CalendarRegistry,
): CalendarRegistry {
  return registerCalendar(registry, usCalendar);
}

/** One program per product template: the structure is the template's, the series are a person's. */
const programs: readonly BondProgramDefinition[] = Object.values(
  SERIES_TEMPLATES,
).map(({ structure: { instrument, rateRule, rest }, infoUrl }) => ({
  issuerCountryCode: instrument.issuerCountryCode as string,
  issuerCode: instrument.issuerCode as string,
  programCode: instrument.programCode as string,
  currency: instrument.currency as string,
  faceValue: instrument.faceValue as string,
  cashPriced:
    instrument.marketability === "MARKETABLE" &&
    rateRule.type !== "ZERO_COUPON_DISCOUNT",
  indexedPrincipal:
    (rest.principalRule as { type?: string } | undefined)?.type ===
    "INDEX_RATIO",
  infoUrl,
}));

export const UNITED_STATES_BOND_ADAPTER: BondAdapter = {
  countryCode: "US",
  specDoc: "docs/specs/us-treasury-securities.md",
  timezone: US_TIMEZONE,
  registerCalendars: registerUsCalendars,
  benchmarks: usBenchmarks,
  programs,
  fetchSeries: (seriesCode: string, fetch: BondFetch) =>
    fetchSeries(seriesCode, fetch),
  seriesProviderId: SERIES_PROVIDER,
  programOf,
  auctionsNear: (programCode: string, date: string, fetch: BondFetch) =>
    auctionsNear(programCode, date, fetch),
  async fetchBenchmark(code: string, fetch: BondFetch) {
    switch (code) {
      case US_CPI_U_NSA:
        return fetchBlsCpi(fetch, todayInTimezone(US_TIMEZONE) as string);
      case US_TBILL_13W_MMY:
        return fetchTbill13w(fetch, todayInTimezone(US_TIMEZONE) as string);
      default:
        throw new BenchmarkFetchError(
          `The US adapter has no benchmark ${code}`,
        );
    }
  },
};
