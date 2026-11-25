import { HoldingWithMarketValue } from '@/types/investment';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';
import type { ConvertedTotal } from '@/lib/currency-total';
import { foldPageSums, pageRatio, pageSum, pageSumSign } from '@/lib/page-total';

export interface ExchangeAllocation {
  exchange: string;
  country: string;
  region: string;
  count: number;
  marketValue: number;
  percentage: number;
}

export interface RegionAllocation {
  region: string;
  marketValue: number;
  percentage: number;
  count: number;
  color: string;
}

/**
 * Maps a security's listing exchange to a country and broad geographic region.
 * Shared by the Geographic Allocation report and its dashboard widget so both
 * classify holdings identically.
 *
 * **This is where a security is listed, not where its business is.** A globally
 * diversified fund bought on the NYSE is North America here, because that is
 * what its listing says; the country look-through
 * (`investmentsApi.getCountryWeightings`) is the view that sees inside it. Both
 * are offered, and the region view says which question it answers.
 */
export const EXCHANGE_TO_REGION: Record<string, { country: string; region: string }> = {
  NYSE: { country: 'United States', region: 'North America' },
  NASDAQ: { country: 'United States', region: 'North America' },
  NMS: { country: 'United States', region: 'North America' },
  NYQ: { country: 'United States', region: 'North America' },
  NYSEARCA: { country: 'United States', region: 'North America' },
  AMEX: { country: 'United States', region: 'North America' },
  BATS: { country: 'United States', region: 'North America' },
  TSX: { country: 'Canada', region: 'North America' },
  TSXV: { country: 'Canada', region: 'North America' },
  TOR: { country: 'Canada', region: 'North America' },
  NEO: { country: 'Canada', region: 'North America' },
  LSE: { country: 'United Kingdom', region: 'Europe' },
  LON: { country: 'United Kingdom', region: 'Europe' },
  FRA: { country: 'Germany', region: 'Europe' },
  XETRA: { country: 'Germany', region: 'Europe' },
  PAR: { country: 'France', region: 'Europe' },
  AMS: { country: 'Netherlands', region: 'Europe' },
  MIL: { country: 'Italy', region: 'Europe' },
  STO: { country: 'Sweden', region: 'Europe' },
  TYO: { country: 'Japan', region: 'Asia-Pacific' },
  HKG: { country: 'Hong Kong', region: 'Asia-Pacific' },
  SHA: { country: 'China', region: 'Asia-Pacific' },
  SHE: { country: 'China', region: 'Asia-Pacific' },
  ASX: { country: 'Australia', region: 'Asia-Pacific' },
  KRX: { country: 'South Korea', region: 'Asia-Pacific' },
  TAI: { country: 'Taiwan', region: 'Asia-Pacific' },
  SGX: { country: 'Singapore', region: 'Asia-Pacific' },
  BSE: { country: 'India', region: 'Asia-Pacific' },
  NSE: { country: 'India', region: 'Asia-Pacific' },
  // Further listing venues, so a holding outside the handful of majors is
  // placed on its own continent rather than falling into Other.
  OTC: { country: 'United States', region: 'North America' },
  PNK: { country: 'United States', region: 'North America' },
  IEX: { country: 'United States', region: 'North America' },
  CBOE: { country: 'United States', region: 'North America' },
  TSE: { country: 'Canada', region: 'North America' },
  CSE: { country: 'Canada', region: 'North America' },
  CNQ: { country: 'Canada', region: 'North America' },
  MEX: { country: 'Mexico', region: 'North America' },
  BMV: { country: 'Mexico', region: 'North America' },
  AIM: { country: 'United Kingdom', region: 'Europe' },
  GER: { country: 'Germany', region: 'Europe' },
  BER: { country: 'Germany', region: 'Europe' },
  MUN: { country: 'Germany', region: 'Europe' },
  STU: { country: 'Germany', region: 'Europe' },
  HAM: { country: 'Germany', region: 'Europe' },
  DUS: { country: 'Germany', region: 'Europe' },
  EBS: { country: 'Switzerland', region: 'Europe' },
  SIX: { country: 'Switzerland', region: 'Europe' },
  SWX: { country: 'Switzerland', region: 'Europe' },
  VIE: { country: 'Austria', region: 'Europe' },
  BRU: { country: 'Belgium', region: 'Europe' },
  LIS: { country: 'Portugal', region: 'Europe' },
  MCE: { country: 'Spain', region: 'Europe' },
  BME: { country: 'Spain', region: 'Europe' },
  ATH: { country: 'Greece', region: 'Europe' },
  DUB: { country: 'Ireland', region: 'Europe' },
  ISE: { country: 'Ireland', region: 'Europe' },
  HEL: { country: 'Finland', region: 'Europe' },
  CPH: { country: 'Denmark', region: 'Europe' },
  OSL: { country: 'Norway', region: 'Europe' },
  ICE: { country: 'Iceland', region: 'Europe' },
  WSE: { country: 'Poland', region: 'Europe' },
  GPW: { country: 'Poland', region: 'Europe' },
  PRA: { country: 'Czechia', region: 'Europe' },
  BUD: { country: 'Hungary', region: 'Europe' },
  IST: { country: 'Turkey', region: 'Europe' },
  MOEX: { country: 'Russia', region: 'Europe' },
  OSE: { country: 'Japan', region: 'Asia-Pacific' },
  JPX: { country: 'Japan', region: 'Asia-Pacific' },
  SHG: { country: 'China', region: 'Asia-Pacific' },
  SZ: { country: 'China', region: 'Asia-Pacific' },
  KOSDAQ: { country: 'South Korea', region: 'Asia-Pacific' },
  TWO: { country: 'Taiwan', region: 'Asia-Pacific' },
  NZE: { country: 'New Zealand', region: 'Asia-Pacific' },
  NZX: { country: 'New Zealand', region: 'Asia-Pacific' },
  IDX: { country: 'Indonesia', region: 'Asia-Pacific' },
  JKT: { country: 'Indonesia', region: 'Asia-Pacific' },
  SET: { country: 'Thailand', region: 'Asia-Pacific' },
  KLS: { country: 'Malaysia', region: 'Asia-Pacific' },
  HOSE: { country: 'Vietnam', region: 'Asia-Pacific' },
  PSE: { country: 'Philippines', region: 'Asia-Pacific' },
  KAR: { country: 'Pakistan', region: 'Asia-Pacific' },
  CSE_LK: { country: 'Sri Lanka', region: 'Asia-Pacific' },
  SAO: { country: 'Brazil', region: 'Latin America' },
  BVMF: { country: 'Brazil', region: 'Latin America' },
  BUE: { country: 'Argentina', region: 'Latin America' },
  SGO: { country: 'Chile', region: 'Latin America' },
  BVC: { country: 'Colombia', region: 'Latin America' },
  LIM: { country: 'Peru', region: 'Latin America' },
  JSE: { country: 'South Africa', region: 'Africa & Middle East' },
  CAI: { country: 'Egypt', region: 'Africa & Middle East' },
  TASE: { country: 'Israel', region: 'Africa & Middle East' },
  TLV: { country: 'Israel', region: 'Africa & Middle East' },
  SAU: { country: 'Saudi Arabia', region: 'Africa & Middle East' },
  TADAWUL: { country: 'Saudi Arabia', region: 'Africa & Middle East' },
  ADX: { country: 'United Arab Emirates', region: 'Africa & Middle East' },
  DFM: { country: 'United Arab Emirates', region: 'Africa & Middle East' },
  QSE: { country: 'Qatar', region: 'Africa & Middle East' },
};

export const REGION_COLOURS: Record<string, string> = {
  'North America': CHART_SERIES[0],
  Europe: CHART_SERIES[1],
  'Asia-Pacific': CHART_SERIES[2],
  'Latin America': CHART_SERIES[4],
  'Africa & Middle East': CHART_SERIES[5],
  Other: CHART_SERIES[3],
};

export const COUNTRY_COLOURS = CHART_SERIES;

/**
 * Roll holdings up into per-exchange and per-region allocations, all converted
 * into the user's display currency via `convertToDefault`. `securityExchangeMap`
 * maps securityId -> exchange code (from the securities list).
 *
 * The groupings exist only on the page, so each exchange's value is the exact
 * sum of its converted holdings read once at `places` (the display currency's),
 * a region and the total fold the exchanges' exact sums rather than their
 * readings, and each share is divided from the exact sums
 * (`docs/specs/report-rounding-and-aggregation.md` rules 2 and 8, section 7).
 */
export function computeGeographicAllocation(
  holdings: HoldingWithMarketValue[],
  securityExchangeMap: Map<string, string>,
  convertToDefault: (value: number, currency: string) => number | null,
  places: number,
): {
  exchangeData: ExchangeAllocation[];
  regionData: RegionAllocation[];
  totalValue: number;
  /** Currencies with no rate into the display currency, so their holdings could not be placed. */
  missingCurrencies: string[];
  /** Holdings left out of `totalValue` because they could not be priced or converted. */
  excludedCount: number;
} {
  const exchangeMap = new Map<
    string,
    { country: string; region: string; values: number[] }
  >();
  // A missing price or rate leaves a holding out of every figure below, so
  // `totalValue` is a subtotal whenever either happens -- tracked here so the
  // report can mark it instead of presenting the smaller number as the whole.
  const missing = new Set<string>();
  let excludedCount = 0;

  holdings.forEach((h) => {
    const exchange = securityExchangeMap.get(h.securityId) || 'Unknown';
    const info = EXCHANGE_TO_REGION[exchange] || { country: 'Other', region: 'Other' };
    // Two ways this holding cannot be placed: the server could not price it
    // (`marketValue` null) or there is no rate into the display currency. `?? 0`
    // used to include it as a zero, which re-weighted every other region.
    if (h.marketValue === null || h.marketValue === undefined) {
      excludedCount += 1;
      return;
    }
    const marketValue = convertToDefault(h.marketValue, h.currencyCode);
    if (marketValue === null) {
      missing.add(h.currencyCode);
      excludedCount += 1;
      return;
    }

    const existing =
      exchangeMap.get(exchange) || {
        country: info.country,
        region: info.region,
        values: [],
      };
    exchangeMap.set(exchange, {
      ...existing,
      values: [...existing.values, marketValue],
    });
  });

  const exchanges = Array.from(exchangeMap.entries()).map(([exchange, data]) => ({
    exchange,
    country: data.country,
    region: data.region,
    count: data.values.length,
    sum: pageSum(data.values, places),
  }));
  const total = foldPageSums(exchanges.map((e) => e.sum), places);
  const shareOf = (sum: ConvertedTotal): number =>
    pageSumSign(total) > 0 ? (pageRatio(sum, total) ?? 0) * 100 : 0;

  const exchangeData: ExchangeAllocation[] = exchanges
    .map((e) => ({
      exchange: e.exchange,
      country: e.country,
      region: e.region,
      count: e.count,
      marketValue: e.sum.value,
      percentage: shareOf(e.sum),
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const regionMap = new Map<string, { sums: ConvertedTotal[]; count: number }>();
  exchanges.forEach((e) => {
    const existing = regionMap.get(e.region) || { sums: [], count: 0 };
    regionMap.set(e.region, {
      sums: [...existing.sums, e.sum],
      count: existing.count + e.count,
    });
  });

  const regionData: RegionAllocation[] = Array.from(regionMap.entries())
    .map(([region, data]) => {
      const sum = foldPageSums(data.sums, places);
      return {
        region,
        marketValue: sum.value,
        percentage: shareOf(sum),
        count: data.count,
        color: REGION_COLOURS[region] || chartColors.axis,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  return {
    exchangeData,
    regionData,
    totalValue: total.value,
    missingCurrencies: [...missing],
    excludedCount,
  };
}
