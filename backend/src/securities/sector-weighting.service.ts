import { Injectable, Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { YahooFinanceService } from "./yahoo-finance.service";
import {
  PortfolioCalculationService,
  FxRateCache,
} from "./portfolio-calculation.service";
import { roundMoney, sumMoney } from "../common/round.util";
import { FxAggregate } from "../common/fx-aggregate";
import {
  ASSET_CLASS_LABELS,
  AssetClassKey,
  EXCHANGE_TO_COUNTRY,
  assetClassForSecurityType,
  canonicalAssetClassKey,
  isOtherAllocationName,
} from "./security-enums";

export interface SectorWeightingItem {
  sector: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

/**
 * What the weightings' total could and could not be worked out from. Same
 * field names as `PortfolioSummary`, so a consumer reads one vocabulary.
 */
export interface WeightingCompleteness {
  /**
   * The value of the holdings that were priced and converted: the base every
   * percentage is a share of. Safe beside the gaps, never under a "total" caption.
   */
  knownSubtotal: number;
  /** True when every held position was priced AND converted. */
  valuationComplete: boolean;
  pricesComplete: boolean;
  fxComplete: boolean;
  unpricedSecurityIds: string[];
  unpricedSymbols: string[];
  /** "SEC->REPORTING" pairs with no rate. */
  missingRatePairs: string[];
}

const COMPLETE_EMPTY: WeightingCompleteness = {
  knownSubtotal: 0,
  valuationComplete: true,
  pricesComplete: true,
  fxComplete: true,
  unpricedSecurityIds: [],
  unpricedSymbols: [],
  missingRatePairs: [],
};

function completenessOf(
  agg: FxAggregate,
  unpriced: Map<string, string>,
): WeightingCompleteness {
  const missingRatePairs = agg.missingPairs;
  const pricesComplete = unpriced.size === 0;
  const fxComplete = missingRatePairs.length === 0;
  return {
    knownSubtotal: roundMoney(agg.knownSubtotal),
    valuationComplete: pricesComplete && fxComplete,
    pricesComplete,
    fxComplete,
    unpricedSecurityIds: [...unpriced.keys()].sort(),
    unpricedSymbols: [...unpriced.values()].sort(),
    missingRatePairs,
  };
}

export interface SectorWeightingResult extends WeightingCompleteness {
  items: SectorWeightingItem[];
  /** null while any holding is unpriced or unconvertible; see `knownSubtotal`. */
  totalPortfolioValue: number | null;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

export interface CountryWeightingItem {
  country: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface CountryWeightingResult extends WeightingCompleteness {
  items: CountryWeightingItem[];
  totalPortfolioValue: number | null;
  totalDirectValue: number;
  totalEtfValue: number;
  /**
   * Value with no country classification: ETF/fund value beyond the manual
   * weightings (the "Other" remainder) plus stocks on exchanges we can't map.
   * The frontend renders this as an "Other" slice.
   */
  unclassifiedValue: number;
}

export interface AssetClassWeightingItem {
  /**
   * The class's display name: the English name of a canonical class, or the
   * user's own spelling of a class that maps to none.
   */
  assetClass: string;
  /**
   * The canonical class this bucket is, for the UI to translate; null for a
   * name the user typed that maps to no canonical class.
   */
  assetClassKey: AssetClassKey | null;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface AssetClassWeightingResult extends WeightingCompleteness {
  items: AssetClassWeightingItem[];
  totalPortfolioValue: number | null;
  totalDirectValue: number;
  totalEtfValue: number;
  /**
   * Value with no asset-class classification: fund value beyond the manual
   * weightings (the "Other" remainder) plus securities whose type says nothing
   * definite (a fund with no breakdown, options, GICs).
   */
  unclassifiedValue: number;
}

/** One bucket of a look-through rollup, before it is named country/assetClass. */
interface LookThroughItem<K extends string> {
  name: string;
  /** The canonical bucket this is, when the dimension has a vocabulary. */
  key: K | null;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

interface LookThroughResult<K extends string> extends WeightingCompleteness {
  items: LookThroughItem<K>[];
  totalPortfolioValue: number | null;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

/** One slice of a look-through breakdown as returned to the LLM tools. */
export interface LlmAllocationSlice {
  name: string;
  value: number;
  percentage: number;
}

export interface LlmAllocationBreakdown {
  items: LlmAllocationSlice[];
  /** Value not attributed to any named bucket, shown in the UI as "Other". */
  unclassifiedValue: number;
  unclassifiedPercentage: number;
}

/** Both portfolio look-through breakdowns in one LLM-friendly payload. */
export interface LlmLookThrough extends WeightingCompleteness {
  /** null while `valuationComplete` is false; percentages are over `knownSubtotal`. */
  totalPortfolioValue: number | null;
  byCountry: LlmAllocationBreakdown;
  byAssetClass: LlmAllocationBreakdown;
}

/**
 * Cap on the buckets listed per breakdown for the LLM. Beyond this the tail is
 * folded into the unclassified "Other" value so a long-tail portfolio cannot
 * blow out the tool result.
 */
const MAX_LLM_LOOK_THROUGH_ITEMS = 25;

/**
 * Trim a rollup to its largest buckets and fold the tail into the unclassified
 * value, so the parts always add up to the portfolio total.
 */
function toLlmBreakdown(
  items: { name: string; totalValue: number; percentage: number }[],
  unclassifiedValue: number,
  totalPortfolioValue: number,
): LlmAllocationBreakdown {
  const kept = items.slice(0, MAX_LLM_LOOK_THROUGH_ITEMS);
  const tail = items.slice(MAX_LLM_LOOK_THROUGH_ITEMS);
  const other = sumMoney([unclassifiedValue, ...tail.map((i) => i.totalValue)]);
  return {
    items: kept.map((i) => ({
      name: i.name,
      value: i.totalValue,
      percentage: i.percentage,
    })),
    unclassifiedValue: roundMoney(other),
    unclassifiedPercentage:
      totalPortfolioValue > 0
        ? Math.round((other / totalPortfolioValue) * 10000) / 100
        : 0,
  };
}

@Injectable()
export class SectorWeightingService {
  private readonly logger = new Logger(SectorWeightingService.name);

  constructor(
    private dataSource: DataSource,
    private yahooFinanceService: YahooFinanceService,
    private portfolioCalculationService: PortfolioCalculationService,
  ) {}

  /**
   * Fetch and cache sector data from Yahoo Finance for securities that
   * are missing it or have stale data (> 7 days old).
   */
  async ensureSectorData(securities: Security[]): Promise<void> {
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toUpdate: Security[] = [];

    for (const sec of securities) {
      if (sec.skipPriceUpdates) continue;

      const isFresh =
        sec.sectorDataUpdatedAt &&
        now - new Date(sec.sectorDataUpdatedAt).getTime() < STALE_MS;
      if (isFresh) continue;

      const isStock =
        sec.securityType === "STOCK" || sec.securityType === "Equity";
      const isEtf = sec.securityType === "ETF";

      if (isStock && !sec.sector) {
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        const info =
          await this.yahooFinanceService.fetchStockSectorInfo(yahooSymbol);
        if (info) {
          sec.sector = info.sector;
          sec.industry = info.industry;
        }
        sec.sectorDataUpdatedAt = new Date();
        toUpdate.push(sec);
      } else if (isEtf && !sec.sectorWeightings) {
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        // Only a request that reached the provider makes the row fresh.
        if (await this.fillEtfBreakdowns(sec, yahooSymbol)) {
          sec.sectorDataUpdatedAt = new Date();
          toUpdate.push(sec);
        }
      } else if (sec.sectorDataUpdatedAt && !isFresh && (isStock || isEtf)) {
        // Re-fetch stale data
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        if (isStock) {
          const info =
            await this.yahooFinanceService.fetchStockSectorInfo(yahooSymbol);
          if (info) {
            sec.sector = info.sector;
            sec.industry = info.industry;
          }
        } else if (!(await this.fillEtfBreakdowns(sec, yahooSymbol))) {
          // The refresh never happened, so the row is exactly as stale as it
          // was and stays eligible for the next sweep.
          continue;
        }
        sec.sectorDataUpdatedAt = new Date();
        toUpdate.push(sec);
      }
    }

    if (toUpdate.length > 0) {
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).save(toUpdate),
      );
    }
  }

  /**
   * Fill a fund's sector weightings and asset-class split from the provider.
   *
   * Both come out of the same `topHoldings` response, so they are fetched
   * together -- asking twice was two identical requests per fund.
   *
   * The asset-class column is documented as manual and the allocation editor
   * writes it, so a fetched value must never overwrite a typed one: the
   * provider's split is a convenience for funds nobody has described, not a
   * source of truth that outranks the owner. It matters to the GEM report,
   * whose defensive roles are compared on exactly this breakdown.
   *
   * Returns whether the request actually reached the provider, which is what
   * decides freshness. The two are not the same question: the provider
   * distinguishes `null` (the request failed) from `[]` (it answered, and the
   * fund has no breakdown to give), and only the second is knowledge. Stamping
   * `sectorDataUpdatedAt` on a failure suppressed the retry for a week behind a
   * row that looked up to date, which is how a transient outage turned into a
   * fund with no asset-class data and no way back.
   */
  private async fillEtfBreakdowns(
    sec: Security,
    yahooSymbol: string,
  ): Promise<boolean> {
    const { sectors, assets } =
      await this.yahooFinanceService.fetchEtfBreakdowns(yahooSymbol);
    if (sectors === null && assets === null) return false;
    if (sectors) sec.sectorWeightings = sectors;
    if (!sec.assetWeightings?.length && assets?.length) {
      sec.assetWeightings = assets;
    }
    // One half missing is still an answer: the fund was described, just not in
    // both dimensions, and re-asking every sweep would not change that.
    return true;
  }
  /**
   * Get the latest price per security from security_prices table.
   */
  private async getLatestPrices(
    securityIds: string[],
  ): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    if (securityIds.length === 0) return priceMap;

    const rows: { security_id: string; close_price: string }[] =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT DISTINCT ON (security_id) security_id, close_price
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date DESC`,
          [securityIds],
        ),
      );

    for (const row of rows) {
      priceMap.set(row.security_id, Number(row.close_price));
    }
    return priceMap;
  }

  /**
   * Convenience method: load securities by IDs and ensure sector data is cached.
   * Used by the price refresh flow to populate sector data alongside prices.
   */
  async ensureSectorDataByIds(securityIds: string[]): Promise<void> {
    if (securityIds.length === 0) return;
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { id: In(securityIds) },
      }),
    );
    await this.ensureSectorData(securities);
  }

  /**
   * Compute sector weightings for a user's investment portfolio.
   */
  async getSectorWeightings(
    userId: string,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<SectorWeightingResult> {
    // 1. Resolve investment accounts
    let investmentAccounts: Account[];
    if (accountIds && accountIds.length > 0) {
      investmentAccounts = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: {
            userId,
            id: In(accountIds),
            accountType: AccountType.INVESTMENT,
          },
        }),
      );
    } else {
      investmentAccounts = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: { userId, accountType: AccountType.INVESTMENT },
        }),
      );
    }

    const categorised =
      this.portfolioCalculationService.categoriseAccounts(investmentAccounts);

    // 2. Get holdings for those accounts
    let holdings: Holding[];
    if (categorised.holdingsAccountIds.length > 0) {
      holdings = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Holding).find({
          where: { accountId: In(categorised.holdingsAccountIds) },
          relations: ["security"],
        }),
      );
    } else {
      holdings = [];
    }

    // Filter by securityIds if provided
    if (securityIds && securityIds.length > 0) {
      holdings = holdings.filter((h) => securityIds.includes(h.securityId));
    }

    // Filter out zero-quantity holdings
    holdings = holdings.filter((h) => Math.abs(Number(h.quantity)) >= 0.0001);

    if (holdings.length === 0) {
      return {
        items: [],
        totalPortfolioValue: 0,
        totalDirectValue: 0,
        totalEtfValue: 0,
        unclassifiedValue: 0,
        ...COMPLETE_EMPTY,
      };
    }

    // 3. Get latest prices
    const uniqueSecurityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(uniqueSecurityIds);
    // A bond-linked holding is its own account's lots, not quantity x the
    // program-wide blend (bond-program-securities.md 2.4).
    const bondValues = await this.portfolioCalculationService.valueBondHoldings(
      userId,
      holdings,
      priceMap,
    );

    // 4. Ensure sector data is cached
    const securities = holdings.map((h) => h.security);
    const uniqueSecurities = Array.from(
      new Map(securities.map((s) => [s.id, s])).values(),
    );
    await this.ensureSectorData(uniqueSecurities);

    // 5. Build sector maps
    const rateCache: FxRateCache = new Map();
    const agg = new FxAggregate();
    const unpriced = new Map<string, string>();
    // Totals are shown in the reader's reporting currency, not whichever
    // account sorts first.
    const defaultCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );

    const directMap = new Map<string, number>(); // sector -> value
    const etfMap = new Map<string, number>(); // sector -> value
    let unclassifiedValue = 0;

    for (const holding of holdings) {
      const quantity = Number(holding.quantity);
      const price = priceMap.get(holding.securityId);
      const own = holding.security.bondProgramId
        ? bondValues.get(`${holding.accountId}:${holding.securityId}`)
        : undefined;
      // Unpriced is unknown, not zero: it is left out of the weights and the
      // total is withheld; a linked one never falls back to the blend.
      if (holding.security.bondProgramId ? !own : price == null) {
        agg.addUnknown();
        unpriced.set(holding.securityId, holding.security.symbol);
        continue;
      }
      const nativeValue = own ? own.marketValue : quantity * (price as number);

      // `null` means no rate exists for the pair. A sector weighting is a share
      // of a total, so counting an unconverted foreign value would misstate
      // this sector's share and every other sector's with it (audit P5-009).
      // Skipping is the honest option; the conversion logs the missing pair.
      const converted = await this.portfolioCalculationService.convertToDefault(
        nativeValue,
        holding.security.currencyCode,
        defaultCurrency,
        rateCache,
      );
      agg.add(converted, holding.security.currencyCode, defaultCurrency);
      if (converted === null) continue;
      const marketValue = converted;

      const sec = holding.security;
      const isStock =
        sec.securityType === "STOCK" || sec.securityType === "Equity";
      const isEtf = sec.securityType === "ETF";

      if (isStock && sec.sector) {
        directMap.set(
          sec.sector,
          (directMap.get(sec.sector) || 0) + marketValue,
        );
      } else if (isEtf && sec.sectorWeightings?.length) {
        for (const sw of sec.sectorWeightings) {
          const allocated = marketValue * sw.weight;
          etfMap.set(sw.sector, (etfMap.get(sw.sector) || 0) + allocated);
        }
      } else {
        unclassifiedValue += marketValue;
      }
    }

    // 6. Merge maps and compute percentages
    const allSectors = new Set([...directMap.keys(), ...etfMap.keys()]);

    const items: SectorWeightingItem[] = [];
    for (const sector of allSectors) {
      const dv = directMap.get(sector) || 0;
      const ev = etfMap.get(sector) || 0;
      items.push({
        sector,
        directValue: roundMoney(dv),
        etfValue: roundMoney(ev),
        totalValue: roundMoney(dv + ev),
        percentage: 0, // computed below
      });
    }

    const totalDirectValue = sumMoney([...directMap.values()]);
    const totalEtfValue = sumMoney([...etfMap.values()]);
    const totalPortfolioValue = sumMoney([
      totalDirectValue,
      totalEtfValue,
      unclassifiedValue,
    ]);

    // Compute percentages
    for (const item of items) {
      item.percentage =
        totalPortfolioValue > 0
          ? Math.round((item.totalValue / totalPortfolioValue) * 10000) / 100
          : 0;
    }

    // Sort by totalValue descending
    items.sort((a, b) => b.totalValue - a.totalValue);

    return {
      items,
      // Withheld while a holding was left out; weights are over the known part.
      totalPortfolioValue: agg.isComplete
        ? roundMoney(totalPortfolioValue)
        : null,
      totalDirectValue: roundMoney(totalDirectValue),
      totalEtfValue: roundMoney(totalEtfValue),
      unclassifiedValue: roundMoney(unclassifiedValue),
      ...completenessOf(agg, unpriced),
    };
  }

  /**
   * Compute a country (geographic look-through) breakdown for the portfolio.
   *
   * Unlike sector data, country exposure is entered manually on each ETF/fund
   * (`security.countryWeightings`, decimal 0-1) because the providers don't
   * supply it. Individual stocks are placed by their listing exchange via
   * `EXCHANGE_TO_COUNTRY`. ETF/fund value beyond the manual weightings, and
   * stocks we can't map, fall into `unclassifiedValue` ("Other").
   */
  async getCountryWeightings(
    userId: string,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<CountryWeightingResult> {
    const result = await this.computeLookThrough(
      userId,
      accountIds,
      securityIds,
      (sec) => {
        const isStock =
          sec.securityType === "STOCK" || sec.securityType === "Equity";
        const isFund =
          sec.securityType === "ETF" || sec.securityType === "MUTUAL_FUND";
        if (isFund && sec.countryWeightings?.length) {
          return { slices: sec.countryWeightings };
        }
        if (isStock && sec.exchange && EXCHANGE_TO_COUNTRY[sec.exchange]) {
          return { direct: EXCHANGE_TO_COUNTRY[sec.exchange] };
        }
        return {};
      },
    );
    return {
      ...result,
      items: result.items.map(({ name, key, ...rest }) => ({
        country: name,
        ...rest,
      })),
    };
  }

  /**
   * Compute an asset-class look-through breakdown for the portfolio.
   *
   * The asset-class counterpart of `getCountryWeightings`: ETFs/funds are split
   * by their manual `assetWeightings` (decimal 0-1), and anything without a
   * breakdown is placed by security type via `assetClassForSecurityType` (a
   * stock is equity, a bond is fixed income). Fund value beyond the manual
   * weightings, and securities whose type says nothing definite (a fund with no
   * breakdown, options, GICs), fall into `unclassifiedValue` ("Other").
   *
   * Every name is read through `canonicalAssetClassKey` before buckets merge,
   * so a stock's type default and a fund's "Stocks" slice are one `equity`
   * bucket. A name that maps to no canonical class is the user's own and is
   * merged case-insensitively under the first spelling seen.
   */
  async getAssetClassWeightings(
    userId: string,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<AssetClassWeightingResult> {
    const result = await this.computeLookThrough(
      userId,
      accountIds,
      securityIds,
      (sec) => {
        const isFund =
          sec.securityType === "ETF" || sec.securityType === "MUTUAL_FUND";
        if (isFund && sec.assetWeightings?.length) {
          return { slices: sec.assetWeightings };
        }
        return { direct: assetClassForSecurityType(sec.securityType) };
      },
      (name) => {
        const key = canonicalAssetClassKey(name);
        return key ? { key, label: ASSET_CLASS_LABELS[key] } : null;
      },
    );
    return {
      ...result,
      items: result.items.map(({ name, key, ...rest }) => ({
        assetClass: name,
        assetClassKey: key,
        ...rest,
      })),
    };
  }

  /**
   * Shared look-through rollup behind the country and asset-class breakdowns.
   *
   * `classify` decides, per security, either a manual `slices` breakdown
   * (weights are decimals 0-1; the shortfall under 1.0 is unclassified) or a
   * single `direct` bucket inferred from the security itself. Returning neither
   * -- or a null `direct` -- sends the whole position to `unclassifiedValue`.
   *
   * `canonical`, when the dimension has a vocabulary, names the canonical
   * bucket a name stands for; every name it recognises merges into that one
   * bucket under its label, whatever the spelling. Any other name is keyed
   * case-insensitively and reported under the first spelling seen, so
   * free-text names that differ only in case are one row.
   */
  private async computeLookThrough<K extends string = never>(
    userId: string,
    accountIds: string[] | undefined,
    securityIds: string[] | undefined,
    classify: (security: Security) => {
      slices?: { name: string; weight: number }[];
      direct?: string | null;
    },
    canonical?: (name: string) => { key: K; label: string } | null,
  ): Promise<LookThroughResult<K>> {
    let investmentAccounts: Account[];
    if (accountIds && accountIds.length > 0) {
      investmentAccounts = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: {
            userId,
            id: In(accountIds),
            accountType: AccountType.INVESTMENT,
          },
        }),
      );
    } else {
      investmentAccounts = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: { userId, accountType: AccountType.INVESTMENT },
        }),
      );
    }

    const categorised =
      this.portfolioCalculationService.categoriseAccounts(investmentAccounts);

    let holdings: Holding[];
    if (categorised.holdingsAccountIds.length > 0) {
      holdings = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Holding).find({
          where: { accountId: In(categorised.holdingsAccountIds) },
          relations: ["security"],
        }),
      );
    } else {
      holdings = [];
    }

    if (securityIds && securityIds.length > 0) {
      holdings = holdings.filter((h) => securityIds.includes(h.securityId));
    }
    holdings = holdings.filter((h) => Math.abs(Number(h.quantity)) >= 0.0001);

    if (holdings.length === 0) {
      return {
        items: [],
        totalPortfolioValue: 0,
        totalDirectValue: 0,
        totalEtfValue: 0,
        unclassifiedValue: 0,
        ...COMPLETE_EMPTY,
      };
    }

    const uniqueSecurityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(uniqueSecurityIds);
    // A bond-linked holding is its own account's lots, not quantity x the
    // program-wide blend (bond-program-securities.md 2.4).
    const bondValues = await this.portfolioCalculationService.valueBondHoldings(
      userId,
      holdings,
      priceMap,
    );

    const rateCache: FxRateCache = new Map();
    const agg = new FxAggregate();
    const unpriced = new Map<string, string>();
    // Totals are shown in the reader's reporting currency, not whichever
    // account sorts first.
    const defaultCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );

    type Bucket = { name: string; key: K | null; value: number };
    // "canonical:<key>" for a recognised name, "text:<lower-cased name>" for
    // any other, so a typed name can never collide with a canonical bucket.
    const directMap = new Map<string, Bucket>();
    const etfMap = new Map<string, Bucket>();
    let unclassifiedValue = 0;

    const add = (map: Map<string, Bucket>, name: string, value: number) => {
      const match = canonical?.(name) ?? null;
      const mapKey = match
        ? `canonical:${match.key}`
        : `text:${name.trim().toLowerCase()}`;
      const existing = map.get(mapKey);
      map.set(mapKey, {
        name: match?.label ?? existing?.name ?? name.trim(),
        key: match?.key ?? null,
        value: (existing?.value ?? 0) + value,
      });
    };

    for (const holding of holdings) {
      const quantity = Number(holding.quantity);
      const price = priceMap.get(holding.securityId);
      const own = holding.security.bondProgramId
        ? bondValues.get(`${holding.accountId}:${holding.securityId}`)
        : undefined;
      // Unpriced is unknown, not zero: it is left out of the weights and the
      // total is withheld; a linked one never falls back to the blend.
      if (holding.security.bondProgramId ? !own : price == null) {
        agg.addUnknown();
        unpriced.set(holding.securityId, holding.security.symbol);
        continue;
      }
      const nativeValue = own ? own.marketValue : quantity * (price as number);

      // See the note above: an unconvertible holding is skipped, not counted
      // at its face value in the wrong currency.
      const converted = await this.portfolioCalculationService.convertToDefault(
        nativeValue,
        holding.security.currencyCode,
        defaultCurrency,
        rateCache,
      );
      agg.add(converted, holding.security.currencyCode, defaultCurrency);
      if (converted === null) continue;
      const marketValue = converted;

      const classification = classify(holding.security);

      if (classification.slices?.length) {
        let allocatedWeight = 0;
        for (const slice of classification.slices) {
          const weight = Number(slice.weight);
          if (!Number.isFinite(weight) || weight <= 0) continue;
          // An "Other" slice isn't a real bucket: leave its weight in the
          // remainder so it merges with the computed "Other" (unclassified).
          if (isOtherAllocationName(slice.name)) continue;
          add(etfMap, slice.name, marketValue * weight);
          allocatedWeight += weight;
        }
        // Anything not allocated by the manual weightings is "Other".
        const remainder = Math.max(0, 1 - allocatedWeight);
        unclassifiedValue += marketValue * remainder;
      } else if (classification.direct) {
        add(directMap, classification.direct, marketValue);
      } else {
        unclassifiedValue += marketValue;
      }
    }

    const allKeys = new Set([...directMap.keys(), ...etfMap.keys()]);
    const items: LookThroughItem<K>[] = [];
    for (const mapKey of allKeys) {
      const direct = directMap.get(mapKey);
      const etf = etfMap.get(mapKey);
      const dv = direct?.value || 0;
      const ev = etf?.value || 0;
      items.push({
        // For a typed name, the manual breakdown's spelling wins over an
        // inferred default's; a canonical bucket carries its label either way.
        name: etf?.name ?? direct?.name ?? mapKey,
        key: etf?.key ?? direct?.key ?? null,
        directValue: roundMoney(dv),
        etfValue: roundMoney(ev),
        totalValue: roundMoney(dv + ev),
        percentage: 0,
      });
    }

    const totalDirectValue = sumMoney(
      [...directMap.values()].map((v) => v.value),
    );
    const totalEtfValue = sumMoney([...etfMap.values()].map((v) => v.value));
    const totalPortfolioValue = sumMoney([
      totalDirectValue,
      totalEtfValue,
      unclassifiedValue,
    ]);

    for (const item of items) {
      item.percentage =
        totalPortfolioValue > 0
          ? Math.round((item.totalValue / totalPortfolioValue) * 10000) / 100
          : 0;
    }

    items.sort((a, b) => b.totalValue - a.totalValue);

    return {
      items,
      // Withheld while a holding was left out; weights are over the known part.
      totalPortfolioValue: agg.isComplete
        ? roundMoney(totalPortfolioValue)
        : null,
      totalDirectValue: roundMoney(totalDirectValue),
      totalEtfValue: roundMoney(totalEtfValue),
      unclassifiedValue: roundMoney(unclassifiedValue),
      ...completenessOf(agg, unpriced),
    };
  }

  /**
   * Both look-through breakdowns in the compact shape the AI Assistant and MCP
   * `get_portfolio_summary` tools return. Shared by the two surfaces (CLAUDE.md
   * repo rule) so they can never drift.
   *
   * Only the largest `MAX_LLM_LOOK_THROUGH_ITEMS` buckets are listed; the tail
   * is folded into `unclassifiedValue` alongside the genuinely unclassified
   * value, which is exactly how the UI renders its "Other" slice.
   */
  async getLlmLookThrough(
    userId: string,
    accountIds?: string[],
  ): Promise<LlmLookThrough> {
    const [countries, assetClasses] = await Promise.all([
      this.getCountryWeightings(userId, accountIds),
      this.getAssetClassWeightings(userId, accountIds),
    ]);

    // Both rollups value the same holdings, so one carries the completeness.
    const {
      totalPortfolioValue,
      knownSubtotal,
      valuationComplete,
      pricesComplete,
      fxComplete,
      unpricedSecurityIds,
      unpricedSymbols,
      missingRatePairs,
    } = countries;
    return {
      totalPortfolioValue,
      knownSubtotal,
      valuationComplete,
      pricesComplete,
      fxComplete,
      unpricedSecurityIds,
      unpricedSymbols,
      missingRatePairs,
      byCountry: toLlmBreakdown(
        countries.items.map((i) => ({
          name: i.country,
          totalValue: i.totalValue,
          percentage: i.percentage,
        })),
        countries.unclassifiedValue,
        countries.knownSubtotal,
      ),
      byAssetClass: toLlmBreakdown(
        assetClasses.items.map((i) => ({
          name: i.assetClass,
          totalValue: i.totalValue,
          percentage: i.percentage,
        })),
        assetClasses.unclassifiedValue,
        assetClasses.knownSubtotal,
      ),
    };
  }
}
