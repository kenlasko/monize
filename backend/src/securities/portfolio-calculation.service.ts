import { Injectable, Logger } from "@nestjs/common";
import { DataSource, FindOptionsWhere, In, LessThanOrEqual } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Holding } from "./entities/holding.entity";
import { NON_VOID_INVESTMENT_STATUS } from "./investment-row-effects.util";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  HoldingWithMarketValue,
  AccountHoldings,
  AllocationItem,
} from "./portfolio.service";
import { roundMoney } from "../common/round.util";
import { parseTag } from "../tags/tag-key-value.util";
import {
  formatDateYMD,
  formatDateYMDLocal,
  todayYMD,
} from "../common/date-utils";
import { mapWithConcurrency } from "../common/concurrency.util";
import { FxAggregate } from "../common/fx-aggregate";
import {
  BondValuationService,
  ownLotsGrossValue,
  SecurityValueByAccount,
} from "../bonds/bond-valuation.service";
import { ExactDecimal } from "../bonds/domain/exact-decimal";
import {
  FX_MAX_RATE_AGE_DAYS,
  describeFxGap,
  resolveFxRate,
} from "../common/time-series/fx-rate-resolver";
import {
  baseInvestmentAction,
  CASH_INCOME_ACTIONS,
  INVESTMENT_REPLAY_ORDER,
  orderTransferOutBeforeIn,
} from "./investment-replay.util";
import { stripBrokerageSuffix } from "../accounts/account-name.util";
import {
  ReplayedBasisGap,
  ReplayResult,
  replayPositionBasis,
  SettlementCurrencies,
} from "./position-basis-replay";

// "As of now" portfolio valuations fetch a live spot rate per foreign
// currency. Cap concurrent quote-provider fetches so a portfolio spanning
// many currencies does not burst the provider on an interactive request.
const LIVE_FX_FETCH_CONCURRENCY = 6;

/**
 * Date-indexed history of stored daily exchange rates, keyed by the raw
 * "{from}->{to}" pair as stored in the exchange_rates table. Each entry's
 * rates are sorted ascending by date so an "as of" lookup can walk to the
 * most recent rate at or before a target date. Used to value intraday chart
 * bars that fall outside the live intraday FX series (pre-market, weekend and
 * holiday gaps, or a failed FX fetch) at the rate that actually prevailed on
 * that bar's own date rather than a single near-current rate.
 */
export type { ReplayedBasisGap };

/** A position rebuilt from its transactions: what is held, and what it cost. */
export interface ReplayedLot {
  /** Units the transaction history accounts for. */
  quantity: number;
  /**
   * Their cost, commissions included, in `currencyCode`.
   *
   * Only meaningful when `basisKnown`; otherwise it is the cost of the part of
   * the position the history does price, which is a different position.
   */
  costBasis: number;
  /**
   * The currency `costBasis` is actually denominated in, or null when the
   * replay could not settle on one.
   *
   * **Not** the holding account's currency, which is what this used to be
   * assumed to be. `InvestmentTransaction.exchangeRate` converts the trade out
   * of the security's currency and into the *cash or funding* account's -- the
   * account the money came from -- and that is a different account, with its
   * own currency, whenever a brokerage settles through a linked cash account
   * or a purchase is funded from elsewhere. A PLN brokerage funded in EUR
   * produced a basis in EUR and a caller comparing it against a PLN market
   * value read the FX difference as gain, then taxed it.
   *
   * A caller that reports a gain or a tax must check this against the currency
   * it is reporting in, and treat a mismatch as unknown rather than converting
   * at today's rate: the acquisition happened at the historical rate, and
   * today's would answer a different question.
   */
  currencyCode: string | null;
  /** False when the replay met a row it could not price, or could not denominate. */
  basisKnown: boolean;
  /** Which gap made it unknown, for a caller that reports the reason. */
  basisGap: ReplayedBasisGap | null;
}

export type DailyRateIndex = Map<string, Array<{ date: string; rate: number }>>;

/**
 * Per-request spot-rate cache keyed `"FROM->TO"`. `null` is a cached *absence*:
 * the pair was looked up and has no usable rate, so later conversions in the
 * same request return unknown immediately instead of re-running the lookups
 * and re-logging the warning per holding.
 */
export type FxRateCache = Map<string, number | null>;

/**
 * Categorised investment accounts: brokerage, standalone, and cash accounts
 * with pre-computed holdings account IDs.
 */
export interface CategorisedAccounts {
  cashAccounts: Account[];
  brokerageAccounts: Account[];
  standaloneAccounts: Account[];
  holdingsAccountIds: string[];
}

/**
 * A single SELL transaction with the cost basis and realized gain derived
 * from replaying transaction history up to the sale. All monetary fields
 * are denominated in the holding account's currency.
 */
export interface RealizedGainEntry {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  /**
   * The row that realized the gain: a SELL or REDEEM disposes of `quantity`
   * shares, and a RETURN_OF_CAPITAL realizes what it paid beyond the basis
   * with no shares sold (`quantity` and `price` are 0).
   */
  action: InvestmentAction;
  quantity: number;
  price: number;
  commission: number;
  proceeds: number;
  /**
   * `null` when the position held shares whose cost the ledger cannot state
   * (ADD_SHARES with no price, an unpriced acquisition): what was relieved is
   * then a share of a subtotal, not of what the position cost.
   */
  costBasis: number | null;
  /** `null` with `costBasis`; the proceeds stay known. */
  realizedGain: number | null;
  /** Why `costBasis` and `realizedGain` are null; null when they are figures. */
  basisGap: ReplayedBasisGap | null;
}

/**
 * Per-(account, security, month) capital-gain breakdown including both the
 * realized portion (from SELLs in the month, and any return of capital
 * beyond the basis) and the unrealized mark-to-market
 * change on the position. All monetary values are denominated in the holding
 * account's currency. The decomposition uses:
 *
 *   totalCapitalGain = (endValue - startValue) + sells - buys
 *   unrealizedGain   = totalCapitalGain - realizedGain
 *
 * which is equivalent to "change in market value plus net cash withdrawn from
 * the position". Months with zero quantity and zero activity are dropped.
 */
export interface CapitalGainEntry {
  month: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  startQuantity: number;
  endQuantity: number;
  /**
   * Period-boundary market values in the account's currency, and the gains
   * derived from them.
   *
   * `null` when the security's currency could not be converted into the
   * account's -- the position's value at each boundary is then unknown, so a
   * gain measured between them is too. `sells` stays known: it comes from the
   * amounts and exchange rates stored on each transaction.
   *
   * `realizedGain` and the gains derived from `buys` are additionally `null`
   * when the position's basis carries a lot whose cost the row cannot state
   * (an unpriced acquisition): a gain measured against an unknown basis is
   * unknown, never the proceeds measured against zero. `buys` itself remains
   * the known subtotal of the priced acquisitions, which is why the gain
   * fields carry the unknown rather than the cash-movement fields.
   */
  startValue: number | null;
  endValue: number | null;
  buys: number;
  sells: number;
  realizedGain: number | null;
  /** False when a disposal this period drew on a basis of unknown cost. Read as `=== false`. */
  realizedGainComplete: boolean;
  /** The gains that are known, when `realizedGainComplete` is false; otherwise null. */
  realizedGainKnownSubtotal: number | null;
  unrealizedGain: number | null;
  totalCapitalGain: number | null;
}

/**
 * Add `days` to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Uses UTC to avoid local-timezone drift when crossing day boundaries.
 */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * How far a replayed quantity may sit from the held one and still be the same
 * position. The dust threshold the portfolio views already use for "no
 * position": below it the difference cannot move a per-share figure meaningfully.
 */
const COST_BASIS_QUANTITY_TOLERANCE = 0.0001;

interface PeriodBucket {
  key: string; // YYYY-MM for months, YYYY-MM-DD for days
  periodStart: string; // YYYY-MM-DD first day of period
  periodEnd: string; // YYYY-MM-DD last day of period
  priceLookupStart: string; // day before periodStart, used to value the position at period start
}

/**
 * Enumerate calendar months covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM key, the (clamped) start/end day-of-month, and the
 * day-before-start date used to look up the starting price for the month.
 */
function enumerateMonths(startDate: string, endDate: string): PeriodBucket[] {
  const [sy, sm] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  const buckets: PeriodBucket[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDayNum = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastOfMonth = `${y}-${String(m).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
    const periodStart = firstOfMonth < startDate ? startDate : firstOfMonth;
    const periodEnd = lastOfMonth > endDate ? endDate : lastOfMonth;
    buckets.push({
      key: `${y}-${String(m).padStart(2, "0")}`,
      periodStart,
      periodEnd,
      priceLookupStart: addDaysIso(periodStart, -1),
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return buckets;
}

/**
 * Enumerate calendar days covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM-DD key and the day-before date for the start-of-day
 * price lookup.
 */
function enumerateDays(startDate: string, endDate: string): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  let current = startDate;
  while (current <= endDate) {
    buckets.push({
      key: current,
      periodStart: current,
      periodEnd: current,
      priceLookupStart: addDaysIso(current, -1),
    });
    current = addDaysIso(current, 1);
  }
  return buckets;
}

/**
 * Service responsible for the core portfolio value calculations:
 * holdings valuation, account grouping, allocation, and CAGR. The summary's
 * time-weighted return is not here: it is the invested measure over the whole
 * life of the portfolio, answered by `PortfolioPeriodResultService`.
 *
 * Extracted from PortfolioService to keep file sizes manageable.
 */
/** What `valueBondHoldings` needs of a holding; a `Holding` row satisfies it. */
export interface BondHoldingRef {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly quantity: number | string;
  readonly security?: { readonly bondProgramId: string | null } | null;
}

@Injectable()
export class PortfolioCalculationService {
  private readonly logger = new Logger(PortfolioCalculationService.name);

  constructor(
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
    private bondValuationService: BondValuationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Currency conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert an amount from one currency to another using the latest exchange
   * rates. Returns `null` when no rate exists for the pair.
   *
   * `null`, not the amount unchanged: this used to fall back to `rate = 1`,
   * which reported 1,000 USD as 1,000 EUR and gave a consumer no way to tell
   * that from a genuine 1:1 pair (audit P5-009). Rate 1 is now reachable only
   * when the two currency codes are equal. Callers accumulate through
   * `FxAggregate` so a missing rate makes the total unknown rather than wrong;
   * see `docs/specs/fx-conversion-completeness.md`.
   */
  async convertToDefault(
    amount: number,
    fromCurrency: string,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<number | null> {
    if (fromCurrency === defaultCurrency) return amount;

    // Zero converts to zero at any rate, so it needs none. Without this an empty
    // foreign account -- no cash, no holdings, nothing invested -- reported its
    // own currency as an unresolvable pair and made the whole portfolio's totals
    // "unknown", which is the other half of the contract's missing-data rule: a
    // settled question must not be reported as one that could not be worked out.
    if (amount === 0) return 0;

    const cacheKey = `${fromCurrency}->${defaultCurrency}`;
    let rate = rateCache.get(cacheKey);
    if (rate === undefined) {
      // One door, `live` mode: the freshest stored observation in either
      // direction, still inside the age bound. Two unbounded `getLatestRate`
      // calls plus a hand-rolled reciprocal is what let this path and the
      // report path quote different rates for one pair in one session, and let
      // either of them quote a rate from months ago as "current".
      const resolved = await this.exchangeRateService.resolveStoredRate(
        fromCurrency,
        defaultCurrency,
        todayYMD(),
        { mode: "live" },
      );
      if (resolved.rate === null) {
        // The absence is cached too (`null`), so a portfolio with many
        // holdings in one unrated currency resolves the pair once per
        // request instead of re-running the lookup and re-warning per
        // holding -- the warn below is therefore once per pair per cache.
        this.logger.warn(
          describeFxGap(
            cacheKey,
            todayYMD(),
            resolved.reason ?? "no_observation",
          ),
        );
        rateCache.set(cacheKey, null);
        return null;
      }
      rate = resolved.rate;
      rateCache.set(cacheKey, rate);
    }
    if (rate === null) return null;
    return amount * rate;
  }

  /**
   * Pre-populate the rate cache with live spot FX rates for every non-default
   * currency held across the given accounts and their holdings. The portfolio
   * summary's "as of now" valuations (holdings value, cash, allocation, net
   * invested) then convert at the current rate -- matching the live Portfolio
   * Value Over Time chart -- instead of the once-a-day stored snapshot.
   *
   * Best effort: when no rate is available for a currency the cache is left
   * unset for that pair and `convertToDefault` resolves it through the same
   * door under the same age bound. What it must not do is seed a rate the door
   * would refuse: `getLiveRate` used to fall back to an unbounded newest-row
   * read, so a 276-day-old observation was cached as "live" and every figure
   * built on it reported itself complete (issue #1390).
   */
  async primeLiveRates(
    rateCache: FxRateCache,
    accounts: Account[],
    holdingsAccountIds: string[],
    defaultCurrency: string,
  ): Promise<void> {
    const currencies = new Set<string>();
    for (const account of accounts) {
      if (account.currencyCode) currencies.add(account.currencyCode);
    }

    if (holdingsAccountIds.length > 0) {
      const rows: Array<{ currency: string | null }> = await withScopedDb(
        this.dataSource,
        (m) =>
          m
            .getRepository(Holding)
            .createQueryBuilder("h")
            .innerJoin("h.security", "s")
            .where("h.account_id IN (:...ids)", { ids: holdingsAccountIds })
            .select("DISTINCT s.currency_code", "currency")
            .getRawMany(),
      );
      for (const row of rows) {
        if (row.currency) currencies.add(row.currency);
      }
    }

    currencies.delete(defaultCurrency);

    await mapWithConcurrency(
      [...currencies],
      LIVE_FX_FETCH_CONCURRENCY,
      async (currency) => {
        const rate = await this.exchangeRateService.getLiveRate(
          currency,
          defaultCurrency,
        );
        if (rate !== null && rate > 0) {
          rateCache.set(`${currency}->${defaultCurrency}`, rate);
        }
      },
    );
  }

  /**
   * Build a date-indexed history of stored daily rates for converting each of
   * `currencies` to `defaultCurrency`, covering [startDate, endDate]. Only the
   * pairs that involve the default currency and a requested currency are kept,
   * in either direction, so `resolveDailyRate` can apply the same direct-then-
   * inverse decision used everywhere else.
   *
   * Used by the intraday Portfolio Value Over Time chart to value bars that the
   * live intraday FX series does not cover at the daily close that prevailed on
   * that bar's own date, instead of the first/latest intraday rate.
   */
  async buildDailyRateIndex(
    currencies: Iterable<string>,
    defaultCurrency: string,
    startDate: string,
    endDate: string,
  ): Promise<DailyRateIndex> {
    const needed = new Set<string>();
    for (const c of currencies) {
      if (c && c !== defaultCurrency) needed.add(c);
    }
    const index: DailyRateIndex = new Map();
    if (needed.size === 0) return index;

    // Load one age bound before the window opens, anchored at today when the
    // window opens later than that (a future bar resolves at today's rate).
    // Those are exactly the observations any date in [startDate, endDate] can
    // be priced by, so widening or narrowing the chart cannot change a bar's
    // rate -- which loading only the window itself did (issue #1390).
    const anchor = startDate < todayYMD() ? startDate : todayYMD();
    const floor = new Date(`${anchor}T00:00:00.000Z`);
    floor.setUTCDate(floor.getUTCDate() - FX_MAX_RATE_AGE_DAYS);
    const rows = await this.exchangeRateService.getRateHistory(
      floor.toISOString().slice(0, 10),
      endDate,
    );
    for (const row of rows) {
      const from = row.fromCurrency;
      const to = row.toCurrency;
      const involvesPair =
        (needed.has(from) && to === defaultCurrency) ||
        (from === defaultCurrency && needed.has(to));
      if (!involvesPair) continue;
      const key = `${from}->${to}`;
      const arr = index.get(key);
      // rate_date is normally returned as a "YYYY-MM-DD" string (DATE columns
      // are parsed as strings, see main.ts) but tolerate a Date instance too.
      const rawDate: string | Date = row.rateDate;
      const date =
        rawDate instanceof Date
          ? formatDateYMD(rawDate)
          : String(rawDate).substring(0, 10);
      const entry = { date, rate: Number(row.rate) };
      if (arr) {
        index.set(key, [...arr, entry]);
      } else {
        index.set(key, [entry]);
      }
    }

    // getRateHistory already orders by rate_date ASC, but sort defensively so
    // the as-of walk in resolveDailyRate never depends on query ordering.
    for (const [key, arr] of index) {
      index.set(
        key,
        [...arr].sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
        ),
      );
    }

    return index;
  }

  /**
   * Resolve the stored daily rate for converting 1 unit of `from` to `to` as of
   * `dateStr` (YYYY-MM-DD) from a `DailyRateIndex`, through the one door.
   *
   * Returns `undefined` when no admissible observation exists in either
   * direction, so callers report the bar as unknown. It used to end in
   * `best ?? rates[0].rate` -- the earliest stored rate, from after the bar
   * being valued (issue #1390).
   */
  resolveDailyRate(
    index: DailyRateIndex,
    from: string,
    to: string,
    dateStr: string,
  ): number | undefined {
    const resolved = resolveFxRate(from, to, dateStr, (f, t) =>
      index.get(`${f}->${t}`),
    );
    return resolved.rate === null ? undefined : resolved.rate;
  }

  // ---------------------------------------------------------------------------
  // Account categorisation
  // ---------------------------------------------------------------------------

  /**
   * Split a list of investment accounts into cash, brokerage, and standalone
   * buckets and derive the IDs of accounts that carry holdings.
   */
  categoriseAccounts(accounts: Account[]): CategorisedAccounts {
    const cashAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_CASH,
    );
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );
    const standaloneAccounts = accounts.filter(
      (a) => a.accountSubType === null || a.accountSubType === undefined,
    );
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];
    return {
      cashAccounts,
      brokerageAccounts,
      standaloneAccounts,
      holdingsAccountIds,
    };
  }

  // ---------------------------------------------------------------------------
  // Cash balance helpers
  // ---------------------------------------------------------------------------

  /**
   * Get effective cash balances (excluding future-dated transactions)
   * for the given accounts. Uses the account's currentBalance field,
   * which is already maintained to exclude future-dated transactions
   * by recalculateCurrentBalance / updateBalance.
   */
  async computeEffectiveBalances(
    accountIds: string[],
  ): Promise<Map<string, number>> {
    const effectiveBalances = new Map<string, number>();
    if (accountIds.length === 0) return effectiveBalances;

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(accountIds) },
        select: ["id", "currentBalance"],
      }),
    );
    for (const account of accounts) {
      effectiveBalances.set(
        account.id,
        roundMoney(Number(account.currentBalance)),
      );
    }
    return effectiveBalances;
  }

  /**
   * Sum cash balances across the given accounts, converting to defaultCurrency.
   */
  async computeTotalCashValue(
    accounts: Account[],
    effectiveBalances: Map<string, number>,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<{
    total: number;
    fxComplete: boolean;
    missingRatePairs: string[];
  }> {
    const cash = new FxAggregate();
    for (const a of accounts) {
      const balance = effectiveBalances.get(a.id) ?? Number(a.currentBalance);
      cash.add(
        await this.convertToDefault(
          balance,
          a.currencyCode,
          defaultCurrency,
          rateCache,
        ),
        a.currencyCode,
        defaultCurrency,
      );
    }
    // The gap is returned, not only logged. A log is invisible to the API and to
    // every consumer downstream, so a caller had no way to tell this subtotal
    // from a complete total -- which is how an incomplete cash figure reached a
    // Monte Carlo starting balance (review finding FR-005).
    if (!cash.isComplete) {
      this.logger.warn(
        `Cash total omits balances with no exchange rate (${cash.missingPairs.join(", ")})`,
      );
    }
    return {
      total: cash.knownSubtotal,
      fxComplete: cash.isComplete,
      missingRatePairs: cash.missingPairs,
    };
  }

  // ---------------------------------------------------------------------------
  // Investment flow helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute per-account investment transaction sums (BUYs, SELLs, Income)
   * for Net Invested calculation.
   *
   * `total_amount` is stored in the security's native currency, so each row
   * is multiplied by its `exchange_rate` (security currency -> cash account
   * currency) to keep the returned figures in the holding account's cash
   * currency. This matches the units of the per-account `cashBalance` used
   * by `buildHoldingsByAccount`, preventing a USD + CAD mix-up when the
   * security and the account use different currencies.
   */
  async computeInvestmentFlows(
    userId: string,
    accountIds: string[],
  ): Promise<Map<string, { buys: number; sells: number; income: number }>> {
    const investmentFlows = new Map<
      string,
      { buys: number; sells: number; income: number }
    >();
    if (accountIds.length === 0) return investmentFlows;

    const flowRows: {
      account_id: string;
      buys: string;
      sells: string;
      income: string;
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT account_id,
                COALESCE(SUM(CASE WHEN action = 'BUY' THEN total_amount * exchange_rate ELSE 0 END), 0) as buys,
                COALESCE(SUM(CASE WHEN action = ANY($3) THEN total_amount * exchange_rate ELSE 0 END), 0) as sells,
                COALESCE(SUM(CASE WHEN action = ANY($4) THEN total_amount * exchange_rate ELSE 0 END), 0) as income
         FROM investment_transactions
         WHERE user_id = $1
           AND account_id = ANY($2)
           AND transaction_date <= CURRENT_DATE
           AND status != 'VOID'
         GROUP BY account_id`,
        [
          userId,
          accountIds,
          // A CD/bond redemption's proceeds are a sale's; the term'd gain
          // distributions are income. Lists come from the shared constants so
          // a future refinement cannot fall out of this aggregate silently.
          // A return of capital is capital coming back out, as a sale's
          // proceeds are: it is cash in the sleeve that no deposit put there.
          [
            InvestmentAction.SELL,
            InvestmentAction.REDEEM,
            InvestmentAction.RETURN_OF_CAPITAL,
          ],
          CASH_INCOME_ACTIONS,
        ],
      ),
    );
    for (const row of flowRows) {
      investmentFlows.set(row.account_id, {
        buys: Number(row.buys),
        sells: Number(row.sells),
        income: Number(row.income),
      });
    }
    return investmentFlows;
  }

  // ---------------------------------------------------------------------------
  // Holdings valuation
  // ---------------------------------------------------------------------------

  /**
   * Historical cost basis per (account, security), rebuilt by walking the
   * transaction history chronologically. Average cost, not FIFO: the whole
   * application values a position at its blended average, and a second model
   * here would disagree with everything it is displayed beside.
   *
   * **Acquisition (BUY, REINVEST).** The basis grows by
   * `(quantity × price + acquisition commission) × exchange rate`. The
   * commission is inside it because it is part of what the shares cost, and
   * inside the conversion because it was charged in the currency of the trade.
   *
   * **Denomination.** `exchangeRate` converts out of the security's currency
   * and into the *settlement* account's -- the funding account when the row
   * names one, otherwise the brokerage's linked cash account, otherwise the
   * brokerage itself. That is the currency the lot reports, and it is **not**
   * necessarily the holding account's. A consumer compares `currencyCode`
   * against the currency it is reporting in; a mismatch is unknown, never a
   * conversion, because today's rate cannot answer a question about a
   * historical purchase.
   *
   * **Partial disposal (SELL, TRANSFER_OUT).** Basis is drawn down at the
   * running average, so selling a third of a position releases a third of its
   * cost and the remainder keeps the same per-share average.
   *
   * **Transfer (TRANSFER_OUT/TRANSFER_IN pair).** Not a disposal and not an
   * acquisition: the destination takes exactly the basis the source released,
   * in the source's currency, together with the share of the acquisition
   * commission already blended into it. A partial transfer therefore splits
   * the basis in the same proportion as the units, and the total across the
   * pair is conserved. The legs are matched on `linkedTransactionId`, which
   * `transferSecurity` writes on both.
   *
   * **Unknown propagates.** The basis is reported unknown -- with a
   * `basisGap` naming which of these it was -- when the history contains an
   * acquisition with no price (`unpriced_acquisition`), a quantity-only row
   * that moved units without a cost (`quantity_only_action`), acquisitions
   * that settled in two different currencies (`mixed_basis_currency`), or a
   * transfer whose source leg is unpriced or outside the accounts being
   * replayed (`transferred_basis_unknown`). Unknown never degrades to zero,
   * and it survives being carried through a transfer.
   *
   * Quantity-only actions (ADD_SHARES/REMOVE_SHARES) move units and carry no
   * price, so they leave the running cost alone and mark the lot's basis
   * **unknown** (`basisKnown: false`). They are not a zero-cost sleeve: what
   * those units cost is not in the ledger at all. `computeHoldingsMap`
   * (`HoldingsService`) is now the only writer of `quantity` and
   * `average_cost`, and it holds `totalCost` fixed across such a row, so the
   * per-share average moves with the count while the money behind it stays
   * whatever the priced rows said. That is a projection of an unknown, not a
   * measurement of one, so it is not reported as a basis here.
   *
   * SPLIT is not in that class: it scales quantity and preserves total cost,
   * which is what both live paths do, so the per-share average adjusts and the
   * basis stays known.
   *
   * Returns the **quantity as well as the money**, because the two only mean
   * anything together. A basis replayed from an incomplete history is a real
   * number for a smaller position than the one being valued: 50 of 100 shares
   * imported gives a basis for 50, and pairing it with today's 100-share market
   * value reports a gain that is mostly the missing half. A caller pairing this
   * with a current holding must compare the quantities **per (account,
   * security)** and treat a mismatch as unknown. Comparing sums instead lets a
   * surplus of 30 units in one account cancel a shortfall of 30 in another and
   * report both bases as reconciled.
   *
   * @returns Map keyed by `${accountId}:${securityId}` -> the replayed lot,
   *          each carrying the currency its basis is denominated in.
   */
  async calculateCostBasisLotsInAccountCurrency(
    userId: string,
    holdingsAccountIds: string[],
  ): Promise<Map<string, ReplayedLot>> {
    const result = new Map<string, ReplayedLot>();
    if (holdingsAccountIds.length === 0) return result;

    const today = formatDateYMDLocal(new Date());

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where: {
          userId,
          accountId: In(holdingsAccountIds),
          transactionDate: LessThanOrEqual(today),
          // Rows as effects: a VOID transaction moved no shares and no cost.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );

    // No history, no lots, and so nothing to denominate. Returning before the
    // account read keeps the common empty case at one query.
    if (transactions.length === 0) return result;

    // Where each transaction's converted amount actually landed. Resolved for
    // the whole batch up front rather than per row: the funding accounts are
    // an arbitrary set and looking each one up inside the loop would be a
    // query per transaction.
    const settlement = await this.settlementCurrencies(
      userId,
      holdingsAccountIds,
      transactions,
    );

    // The shared replay (`replayPositionBasis`); the lots read the basis as it
    // is, in the currency it settled in, and a transfer whose source leg is not
    // among these rows is unknown.
    const { positions } = replayPositionBasis(transactions, {
      settlement,
      orphanTransferIn: "unknown",
    });

    for (const [key, entry] of positions) {
      result.set(key, {
        quantity: entry.quantity,
        costBasis: roundMoney(entry.costBasis),
        currencyCode: entry.currencyCode,
        basisKnown: entry.basisGap === null,
        basisGap: entry.basisGap,
      });
    }

    return result;
  }

  /**
   * Currency each account settles a trade in, for every account the replay can
   * be pointed at -- in the two roles an account can play, because the real
   * resolution treats them differently.
   *
   * A brokerage does not hold the cash: `InvestmentTransactionsService` posts
   * the converted amount to the funding account when the row names one
   * (`accountsService.findOne(fundingAccountId)` -- that account, whatever it
   * is), and otherwise to the brokerage's linked cash account
   * (`findCashAccount`, which redirects). This mirrors that resolution rather
   * than re-deriving it, and the two must be changed together.
   *
   * One map applying the redirect to every account did not mirror it: a funding
   * account that is itself a brokerage with a linked cash account came back as
   * the linked account's currency, while the trade had settled in the funding
   * account's own -- so a basis in the right currency was reported in the wrong
   * one, or a same-currency pair was called mixed and the basis thrown away.
   *
   * A brokerage with no linked cash account settles in its own currency, which
   * is the single-account case and by far the common one, so the two maps agree
   * for almost every account.
   */
  private async settlementCurrencies(
    userId: string,
    holdingsAccountIds: string[],
    transactions: readonly InvestmentTransaction[],
  ): Promise<SettlementCurrencies> {
    const wanted = new Set<string>(holdingsAccountIds);
    for (const tx of transactions) {
      if (tx.fundingAccountId) wanted.add(tx.fundingAccountId);
    }

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId, id: In([...wanted]) },
        select: {
          id: true,
          currencyCode: true,
          accountSubType: true,
          linkedAccountId: true,
        },
      }),
    );
    const byId = new Map(accounts.map((account) => [account.id, account]));

    // A linked cash account is not necessarily one of the above -- it is not a
    // holdings account and need never have funded a row explicitly.
    const linkedIds = accounts
      .map((account) => account.linkedAccountId)
      .filter((id): id is string => Boolean(id) && !byId.has(id as string));
    if (linkedIds.length > 0) {
      const linked = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: { userId, id: In(linkedIds) },
          select: { id: true, currencyCode: true },
        }),
      );
      for (const account of linked) byId.set(account.id, account);
    }

    const own = new Map<string, string>();
    const brokerage = new Map<string, string>();
    for (const account of byId.values()) {
      if (account.currencyCode) own.set(account.id, account.currencyCode);
      const linked =
        account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
        account.linkedAccountId
          ? byId.get(account.linkedAccountId)
          : undefined;
      const currency = (linked ?? account).currencyCode;
      if (currency) brokerage.set(account.id, currency);
    }
    return { own, brokerage };
  }

  /**
   * Replayed bases that a caller may state as a figure in the account's own
   * currency, keyed the same way as the lots.
   *
   * There used to be a projection here that returned `lot.costBasis` and
   * nothing else. It threw away the two fields that say whether the number
   * means anything -- `basisKnown` and `currencyCode` -- and its caller then
   * treated whatever came back as a cost in the *account's* currency. A PLN
   * brokerage funded from EUR contributed a EUR figure to a PLN total, and a
   * position the history could not price contributed a confident partial sum.
   * A number with its qualifications stripped off is not a smaller answer, it
   * is a different one.
   *
   * So the filtering happens here rather than at the call site: an entry is
   * present only when the replay knows the basis, denominated it in the currency
   * asked for, *and* replayed the same number of units the holding actually has.
   * Everything else is absent, and a caller that finds nothing falls back to
   * whatever it does when there is no history at all. Converting the mismatch
   * instead would need today's rate to answer a question about a historical
   * purchase.
   *
   * The quantity comparison is the rule
   * `calculateCostBasisLotsInAccountCurrency` states for every caller, applied
   * here so the claim and its one call site agree. A basis replayed from an
   * incomplete history is a real cost for a smaller position: 50 of 100 shares
   * imported gives a basis for 50, and setting that against a 100-share market
   * value reports a gain that is mostly the missing half. Per (account,
   * security), never on sums -- a surplus of 30 units in one account would
   * otherwise cancel a shortfall of 30 in another and both would pass.
   */
  private async knownCostBasesIn(
    userId: string,
    holdingsAccountIds: string[],
    currencyByAccount: Map<string, string>,
    /** Units actually held, keyed `${accountId}:${securityId}`. */
    quantityByKey: Map<string, number>,
  ): Promise<Map<string, number>> {
    const lots = await this.calculateCostBasisLotsInAccountCurrency(
      userId,
      holdingsAccountIds,
    );
    const usable = new Map<string, number>();
    for (const [key, lot] of lots) {
      if (!lot.basisKnown || lot.currencyCode === null) continue;
      const accountId = key.slice(0, key.indexOf(":"));
      if (currencyByAccount.get(accountId) !== lot.currencyCode) continue;
      const held = quantityByKey.get(key);
      if (
        held === undefined ||
        Math.abs(held - lot.quantity) > COST_BASIS_QUANTITY_TOLERANCE
      ) {
        continue;
      }
      usable.set(key, lot.costBasis);
    }
    return usable;
  }

  /**
   * Replay the user's investment transaction history to compute the realized
   * gain or loss of each SELL transaction using the average-cost method.
   *
   * It reads the shared `replayPositionBasis`, the same fold as
   * `calculateCostBasisLotsInAccountCurrency` and the capital-gains-by-period
   * report, so the three cannot disagree about one position: the acquisition
   * commission is in the basis, a lot of unknown cost (ADD_SHARES with no
   * price, an unpriced acquisition) makes every sale drawn on it unknown, and
   * the figures are in the holding account's currency. A row settled in
   * another currency is converted by its own amounts where they reach the
   * account's currency and by the market rate on its own date otherwise; with
   * no rate the gain is `null` and `basisGap` is `mixed_basis_currency`
   * (`docs/specs/realized-gain-basis-and-currency.md`).
   *
   * The entire history is replayed regardless of the requested date range so
   * SELLs early in the range still see cost basis built up by prior BUYs; only
   * the returned rows are filtered to the requested window.
   */
  async calculateRealizedGains(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<RealizedGainEntry[]> {
    const { accountIds, startDate, endDate } = opts;

    // Not filtered by account: a lot transferred in from an account the caller
    // did not ask about still carries its basis (A26-M21), so the replay reads
    // every account's rows and only the RESULTS are filtered by `accountIds`.
    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    if (endDate) {
      where.transactionDate = LessThanOrEqual(endDate);
    }

    // Rows as effects: a VOID transaction moved no shares and no cost.
    where.status = NON_VOID_INVESTMENT_STATUS;

    const fetched = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where,
        relations: ["security", "account"],
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );
    const { steps } = await this.replayWithRates(userId, fetched);
    const requestedAccounts =
      accountIds && accountIds.length > 0 ? new Set(accountIds) : null;
    const results: RealizedGainEntry[] = [];

    for (const tx of orderTransferOutBeforeIn(fetched)) {
      const disposal = steps.get(tx)?.disposal;
      if (!disposal || !tx.securityId) continue;
      if (
        (startDate && tx.transactionDate < startDate) ||
        (requestedAccounts && !requestedAccounts.has(tx.accountId))
      ) {
        continue;
      }

      const isReturnOfCapital =
        baseInvestmentAction(tx.action) === InvestmentAction.RETURN_OF_CAPITAL;
      // A return of capital is a realized gain only for what the basis could
      // not absorb, on the distribution's date with no shares sold. One whose
      // amount cannot be stated (no usable rate) is skipped, as before.
      if (
        isReturnOfCapital &&
        (disposal.proceeds === null ||
          disposal.proceeds - disposal.basisRelieved <= 0)
      ) {
        continue;
      }

      const known = disposal.gap === null && disposal.proceeds !== null;
      results.push({
        transactionId: tx.id,
        transactionDate: tx.transactionDate,
        accountId: tx.accountId,
        accountName: tx.account?.name ?? null,
        accountCurrencyCode: tx.account?.currencyCode ?? null,
        securityId: tx.securityId,
        symbol: tx.security?.symbol ?? null,
        securityName: tx.security?.name ?? null,
        securityCurrencyCode: tx.security?.currencyCode ?? null,
        action: tx.action,
        quantity: isReturnOfCapital ? 0 : Math.abs(Number(tx.quantity) || 0),
        price: isReturnOfCapital ? 0 : Number(tx.price) || 0,
        commission: Number(tx.commission) || 0,
        // Unconverted proceeds stay as the row settled them; the gain is null.
        proceeds: roundMoney(disposal.proceeds ?? disposal.settledProceeds),
        costBasis: known ? roundMoney(disposal.basisRelieved) : null,
        realizedGain:
          known && disposal.realizedGain !== null
            ? roundMoney(disposal.realizedGain)
            : null,
        basisGap: disposal.gap,
      });
    }

    return results;
  }

  /**
   * Replay `transactions` with the holding account's currency as the report
   * currency. The replay is synchronous, so it runs once to learn which market
   * rates it wants (a row settled in a third currency), the rates are resolved
   * as of each row's own date (INV-FX-001), and it runs again with them. A pair
   * with no rate stays null and the replay reports the figure unknown.
   */
  private async replayWithRates(
    userId: string,
    transactions: readonly InvestmentTransaction[],
  ): Promise<ReplayResult> {
    const accountIds = [...new Set(transactions.map((tx) => tx.accountId))];
    // The account relation says when a trade can settle elsewhere: a funding
    // account, or a brokerage with a linked cash account. Without either every
    // row settles in its own account's currency and there is nothing to read.
    const settlement = transactions.some(
      (tx) => tx.fundingAccountId || tx.account?.linkedAccountId,
    )
      ? await this.settlementCurrencies(userId, accountIds, transactions)
      : {
          own: new Map<string, string>(),
          brokerage: new Map<string, string>(),
        };

    const resolved = new Map<string, number | null>();
    const wanted = new Map<
      string,
      { from: string; to: string; onDate: string }
    >();
    const run = () =>
      replayPositionBasis(transactions, {
        settlement,
        orphanTransferIn: "own_row",
        rateFor: (from, to, onDate) => {
          const key = `${from}->${to}@${onDate}`;
          const known = resolved.get(key);
          if (known !== undefined) return known;
          wanted.set(key, { from, to, onDate });
          return null;
        },
      });

    const first = run();
    if (wanted.size === 0) return first;
    for (const [key, { from, to, onDate }] of wanted) {
      const answer = await this.exchangeRateService.resolveStoredRate(
        from,
        to,
        onDate,
        { mode: "historical" },
      );
      resolved.set(key, answer.rate);
    }
    wanted.clear();
    return run();
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, month)
   * across the requested window. Replays the user's full investment history
   * to derive cost basis and quantities, then snapshots the position at each
   * month boundary using historical close prices to capture mark-to-market
   * changes alongside any realized gains from SELLs in the month.
   *
   * Quantities are snapshotted at each month boundary; market values use the
   * last available close on or before the snapshot date converted to the
   * holding account's currency at the latest exchange rate. BUYs/SELLs use
   * their stored historical exchange rate (matching `calculateRealizedGains`).
   * Months with no holding and no activity are omitted from the result.
   */
  async calculateCapitalGainsByMonth(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateMonths(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, day)
   * across the requested window. Identical to calculateCapitalGainsByMonth but
   * snapshotted at daily rather than monthly boundaries. The `month` field on
   * each returned CapitalGainEntry holds a YYYY-MM-DD key for the day.
   */
  async calculateCapitalGainsByDay(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateDays(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Core capital-gains replay loop shared by calculateCapitalGainsByMonth and
   * calculateCapitalGainsByDay. Replays transaction history and snapshots the
   * position at the boundary of each PeriodBucket. The `month` field on each
   * returned entry is set to the bucket's `key` (YYYY-MM for months, YYYY-MM-DD
   * for days).
   */
  private async calculateCapitalGainsForPeriods(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
    periods: PeriodBucket[],
  ): Promise<CapitalGainEntry[]> {
    const { accountIds, endDate } = opts;

    // Not filtered by account: a lot transferred in from an account the caller
    // did not ask about still carries its basis (A26-M21), so the carry reads
    // every account's rows and only the groups reported are filtered below.
    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    where.transactionDate = LessThanOrEqual(endDate);

    // Rows as effects: a VOID transaction moved no shares and no cost.
    where.status = NON_VOID_INVESTMENT_STATUS;

    const fetched = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where,
        relations: ["security", "account"],
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );

    // One replay over every account's rows: a transferred-in lot is priced
    // from its source whichever group is read first, and the groups below read
    // each row's outcome from it instead of folding a basis of their own.
    const { steps } = await this.replayWithRates(userId, fetched);
    const requestedAccounts =
      accountIds && accountIds.length > 0 ? new Set(accountIds) : null;
    const transactions = fetched.filter(
      (tx) => !requestedAccounts || requestedAccounts.has(tx.accountId),
    );

    if (transactions.length === 0) return [];

    const securityIds = [
      ...new Set(
        transactions.filter((t) => t.securityId).map((t) => t.securityId!),
      ),
    ];
    const allPrices = await this.getAllPricesForSecurities(securityIds);

    // Group transactions by (account, security)
    type GroupKey = string;
    const groups = new Map<
      GroupKey,
      {
        accountId: string;
        accountName: string | null;
        accountCurrencyCode: string | null;
        securityId: string;
        symbol: string | null;
        securityName: string | null;
        securityCurrencyCode: string | null;
        txs: InvestmentTransaction[];
      }
    >();
    for (const tx of transactions) {
      if (!tx.securityId) continue;
      const groupKey = `${tx.accountId}:${tx.securityId}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          accountId: tx.accountId,
          accountName: tx.account?.name ?? null,
          accountCurrencyCode: tx.account?.currencyCode ?? null,
          securityId: tx.securityId,
          symbol: tx.security?.symbol ?? null,
          securityName: tx.security?.name ?? null,
          securityCurrencyCode: tx.security?.currencyCode ?? null,
          txs: [],
        };
        groups.set(groupKey, group);
      }
      group.txs.push(tx);
    }

    // Cache FX rates: (securityCurrency -> accountCurrency, on a given date).
    const fxCache = new Map<string, number | null>();
    // `null` when the pair has no rate. This used to end `: 1`, valuing a
    // foreign security's period start and end as though its currency were the
    // account's (audit P5-009). Rate 1 only when the codes are equal -- a
    // missing code is unknown, and the lookup is the one bounded door rather
    // than two unbounded latest-rate reads with a hand-rolled reciprocal.
    //
    // The rate is resolved AT THE BOUNDARY'S OWN DATE in historical mode -- the
    // newest observation on or before that date within FX_MAX_RATE_AGE_DAYS,
    // never a future rate and never today's (INV-FX-001, docs/time-series-
    // contract.md sections 2 and 4). Resolving once at todayYMD() in `live` mode
    // priced every historical boundary of every period at one rate, so the
    // report reads a currency's move over the window as no move at all. The
    // cache is keyed by date so a portfolio holding one pair still resolves each
    // distinct boundary date once.
    const fxRate = async (
      from: string | null,
      to: string | null,
      onDate: string,
    ): Promise<number | null> => {
      if (!from || !to) return null;
      if (from === to) return 1;
      const cacheKey = `${from}->${to}@${onDate}`;
      const cached = fxCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const resolved = await this.exchangeRateService.resolveStoredRate(
        from,
        to,
        onDate,
        { mode: "historical" },
      );
      // The absence is cached too, so a portfolio holding many securities in
      // one unrated currency resolves that pair once per date instead of per
      // group.
      fxCache.set(cacheKey, resolved.rate);
      return resolved.rate;
    };

    // A boundary's market value in the account's currency. A zero position is
    // worth zero on any date and needs no rate; a held position with no accepted
    // price on or before the boundary is UNKNOWN (`null`), never zero; otherwise
    // the security-currency value is converted at the FX accepted for the
    // boundary's own date.
    const boundaryValue = async (
      quantity: number,
      rawPrice: number | null,
      onDate: string,
      securityCurrencyCode: string | null,
      accountCurrencyCode: string | null,
    ): Promise<number | null> => {
      if (Math.abs(quantity) < COST_BASIS_QUANTITY_TOLERANCE) return 0;
      if (rawPrice === null) return null;
      const fx = await fxRate(
        securityCurrencyCode,
        accountCurrencyCode,
        onDate,
      );
      return fx === null ? null : quantity * rawPrice * fx;
    };

    const results: CapitalGainEntry[] = [];

    for (const group of groups.values()) {
      const txs = group.txs;
      let quantity = 0;
      let txIdx = 0;

      // Rows strictly before the first period only seed the position.
      while (
        txIdx < txs.length &&
        txs[txIdx].transactionDate < periods[0].periodStart
      ) {
        quantity = steps.get(txs[txIdx])?.quantity ?? quantity;
        txIdx++;
      }

      for (const { key: periodKey, periodEnd, priceLookupStart } of periods) {
        const startQuantity = quantity;
        // The start value uses the FX accepted for the day BEFORE the period's
        // start (priceLookupStart), where the position was carried into the
        // period; the end value uses the FX accepted for periodEnd. A held
        // position with no price on a boundary makes that boundary unknown, and
        // an unconvertible currency does the same -- the rate is 1 only when the
        // two currencies are the same.
        const startValue = await boundaryValue(
          startQuantity,
          this.lookupPrice(group.securityId, priceLookupStart, allPrices),
          priceLookupStart,
          group.securityCurrencyCode,
          group.accountCurrencyCode,
        );

        let buys = 0;
        let sells = 0;
        let realizedGain = 0;
        // What a period's disposals realized on a known basis; with an unknown
        // one among them it is the known part of a figure that is not known.
        let knownRealized = 0;
        // The period's `buys` and `sells` (and so its total gain) are complete
        // only when every flow could state its amount in the account's currency
        // and no share arrived or left with no cost or proceeds; its realized
        // gain only when no disposal drew on an unknown basis.
        let flowsComplete = true;
        let realizedKnown = true;
        const addAcquired = (cost: number | null | undefined) => {
          if (cost === null || cost === undefined) flowsComplete = false;
          else buys += cost;
        };

        while (txIdx < txs.length && txs[txIdx].transactionDate <= periodEnd) {
          const tx = txs[txIdx];
          const step = steps.get(tx);
          txIdx++;
          if (!step) continue;
          quantity = step.quantity;

          switch (baseInvestmentAction(tx.action)) {
            case InvestmentAction.BUY:
            case InvestmentAction.REINVEST:
              // Commission included: it is money the period spent acquiring,
              // so leaving it out of `buys` also inflated the period's
              // capital gain by the same amount it understated the basis.
              addAcquired(step.acquired);
              break;
            // A transfer is not a realised event: the leg is a flow at the
            // market value on its date, so the move changes neither account's
            // capital gain. Booking carried basis on one leg only (or none)
            // read the move as a loss in the source and a gain in the
            // destination. An unpriced or unconvertible leg is an unknown flow.
            case InvestmentAction.TRANSFER_IN:
            case InvestmentAction.TRANSFER_OUT: {
              const price = this.lookupPrice(
                group.securityId,
                tx.transactionDate,
                allPrices,
              );
              const fx = await fxRate(
                group.securityCurrencyCode,
                group.accountCurrencyCode,
                tx.transactionDate,
              );
              if (price === null || fx === null) {
                flowsComplete = false;
                break;
              }
              const value = Math.abs(Number(tx.quantity) || 0) * price * fx;
              if (
                baseInvestmentAction(tx.action) === InvestmentAction.TRANSFER_IN
              )
                buys += value;
              else sells += value;
              break;
            }
            case InvestmentAction.SELL:
            case InvestmentAction.RETURN_OF_CAPITAL: {
              // A return of capital is capital coming back out, so it nets
              // against the value change as a sale's proceeds do, and only
              // what exceeds the basis is realized.
              const disposal = step.disposal;
              if (!disposal) break;
              if (disposal.proceeds === null) flowsComplete = false;
              else sells += disposal.proceeds;
              if (disposal.realizedGain === null) {
                realizedKnown = false;
              } else {
                realizedGain += disposal.realizedGain;
                knownRealized += disposal.realizedGain;
              }
              break;
            }
            case InvestmentAction.ADD_SHARES:
            case InvestmentAction.REMOVE_SHARES:
              // Shares that arrived or left with no cost or proceeds: the value
              // change is not a gain.
              if ((Number(tx.quantity) || 0) !== 0) flowsComplete = false;
              break;
            default:
              break;
          }
        }

        const endQuantity = quantity;
        const endValue = await boundaryValue(
          endQuantity,
          this.lookupPrice(group.securityId, periodEnd, allPrices),
          periodEnd,
          group.securityCurrencyCode,
          group.accountCurrencyCode,
        );

        // Unknown boundary values -- or an incomplete `buys` -- make the
        // capital gain unknown rather than equal to the known cash movements.
        const totalCapitalGain =
          startValue === null || endValue === null || !flowsComplete
            ? null
            : endValue - startValue + sells - buys;
        const periodRealizedGain = realizedKnown ? realizedGain : null;
        const unrealizedGain =
          totalCapitalGain === null || periodRealizedGain === null
            ? null
            : totalCapitalGain - periodRealizedGain;

        const hasActivity =
          buys !== 0 ||
          sells !== 0 ||
          realizedGain !== 0 ||
          !flowsComplete ||
          !realizedKnown ||
          startQuantity !== 0 ||
          endQuantity !== 0;
        if (!hasActivity) continue;

        // Suppress vanishingly small float drift to keep the chart clean.
        const round = (n: number) => (Math.abs(n) < 0.005 ? 0 : roundMoney(n));
        const roundOrNull = (n: number | null) =>
          n === null ? null : round(n);

        results.push({
          month: periodKey,
          accountId: group.accountId,
          accountName: group.accountName,
          accountCurrencyCode: group.accountCurrencyCode,
          securityId: group.securityId,
          symbol: group.symbol,
          securityName: group.securityName,
          securityCurrencyCode: group.securityCurrencyCode,
          startQuantity,
          endQuantity,
          startValue: roundOrNull(startValue),
          endValue: roundOrNull(endValue),
          buys: round(buys),
          sells: round(sells),
          realizedGain: roundOrNull(periodRealizedGain),
          realizedGainComplete: realizedKnown,
          realizedGainKnownSubtotal: realizedKnown
            ? null
            : round(knownRealized),
          unrealizedGain: roundOrNull(unrealizedGain),
          totalCapitalGain: roundOrNull(totalCapitalGain),
        });
      }
    }

    return results;
  }

  /**
   * The value of each bond-linked holding from its own account's lots, keyed
   * `accountId:securityId`; null is unpriced (see `ownLotsValue`). Only linked
   * holdings in a non-zero quantity have an entry. One `valueByAccount` call per
   * linked security, on the person's financial today unless `asOf` is given.
   * Every surface that shows a per-account value of a holding reads it here, so
   * none of them multiplies a quantity by the program-wide blend.
   */
  async valueBondHoldings(
    userId: string,
    holdings: readonly BondHoldingRef[],
    asOf?: string,
  ): Promise<Map<string, { marketValue: number; unitPrice: number } | null>> {
    const valued = await this.valueLinkedSecurities(userId, holdings, asOf);
    const values = new Map<
      string,
      { marketValue: number; unitPrice: number } | null
    >();
    for (const h of holdings) {
      const quantity = Number(h.quantity);
      if (!h.security?.bondProgramId || Math.abs(quantity) < 0.0001) continue;
      values.set(
        `${h.accountId}:${h.securityId}`,
        this.ownLotsValue(h, quantity, valued.get(h.securityId)),
      );
    }
    return values;
  }

  /**
   * The per-account lot values of every bond-linked security held in a non-zero
   * quantity, one `valueByAccount` call per security. A security whose valuation
   * throws maps to `null` (every holding of it is unpriced); the portfolio is
   * not failed for it.
   */
  private async valueLinkedSecurities(
    userId: string,
    holdings: readonly BondHoldingRef[],
    asOf?: string,
  ): Promise<Map<string, SecurityValueByAccount | null>> {
    const linked = new Set(
      holdings
        .filter(
          (h) =>
            h.security?.bondProgramId && Math.abs(Number(h.quantity)) >= 0.0001,
        )
        .map((h) => h.securityId),
    );
    const values = new Map<string, SecurityValueByAccount | null>();
    for (const securityId of linked) {
      try {
        values.set(
          securityId,
          await this.bondValuationService.valueByAccount(
            userId,
            securityId,
            asOf,
          ),
        );
      } catch (error) {
        this.logger.warn(
          `Bond valuation of security ${securityId} failed; its holdings are unpriced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        values.set(securityId, null);
      }
    }
    return values;
  }

  /**
   * One holding's value from its own account's lots, or null (unpriced) when
   * the valuation failed, the lots are unknowable, any lot has no gross value,
   * or the lots' bond count is not the holding's quantity (never price a
   * different quantity). The unit price is the account's value per bond.
   */
  private ownLotsValue(
    h: BondHoldingRef,
    quantity: number,
    valued: SecurityValueByAccount | null | undefined,
  ): { marketValue: number; unitPrice: number } | null {
    const own = ownLotsGrossValue(valued, h.accountId, quantity);
    if ("unpriced" in own) {
      if (own.unpriced === "QUANTITY_MISMATCH") {
        this.logger.warn(
          `Holding ${h.id} of bond security ${h.securityId} has quantity ${quantity} but its account's lots count a different number of bonds; left unpriced`,
        );
      }
      return null;
    }
    const lots = { grossValue: own.grossValue, quantity: own.lotQuantity };
    const value = ExactDecimal.parse(lots.grossValue);
    return {
      marketValue: Number(lots.grossValue),
      unitPrice: Number(
        value.div(ExactDecimal.fromInt(lots.quantity)).toFixed(10),
      ),
    };
  }

  /**
   * Fetch holdings for the given account IDs, compute per-holding market value,
   * gain/loss, and accumulate totals (converted to defaultCurrency).
   *
   * Each holding is also annotated with `costBasisAccountCurrency`, the
   * historical cost basis in the holding account's currency derived from the
   * exchange rates stored on the original BUY transactions. Holdings that lack
   * matching transaction history (e.g. imported positions) fall back to
   * converting the current security-currency cost basis with the latest rate.
   *
   * @param getLatestPrices - callback to fetch latest prices by security IDs
   * Returns the enriched holdings array plus the converted totals.
   */
  async calculateHoldingsWithValues(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: FxRateCache,
    getLatestPrices: (securityIds: string[]) => Promise<Map<string, number>>,
  ): Promise<{
    holdings: Holding[];
    holdingsWithValues: HoldingWithMarketValue[];
    totalCostBasis: number;
    totalHoldingsValue: number;
    /**
     * False when a holding could not be converted into the reporting currency,
     * which makes the two totals above subtotals of what did convert. A missing
     * rate used to be applied as 1:1 (audit P5-009); see
     * docs/specs/fx-conversion-completeness.md.
     */
    fxComplete: boolean;
    missingRatePairs: string[];
    /**
     * False when a held position has no current price.
     *
     * A separate dimension from `fxComplete`, and it was missing entirely: an
     * unpriced holding was skipped out of `holdingsValueTotal` without recording a
     * gap, so a portfolio holding 10 priced shares and 5 unpriced ones reported a
     * confident `totalHoldingsValue` of the priced 100 with `fxComplete: true` --
     * a subtotal under a total's name, which section 1 of the financial
     * calculation contract exists to forbid (recheck RR3-004). Unknown is not
     * absent and not zero.
     */
    pricesComplete: boolean;
    /** Securities held in a non-zero quantity with no current price. */
    unpricedSecurityIds: string[];
    /**
     * The gain's two sides, over the SAME holdings: the cost and the value of
     * each holding whose value joined `totalHoldingsValue` and whose cost
     * converted. `totalHoldingsValue - totalCostBasis` charged the cost of an
     * unpriced holding against a value that never included it (A26-M38).
     */
    gainCostBasis: number;
    gainMarketValue: number;
    /**
     * The converted cost of the holdings left out of the gain because they have
     * no value. The knownSubtotal of what converted; a holding whose cost could
     * not be converted is named by `missingRatePairs`.
     */
    unpricedCostBasis: number;
  }> {
    let holdings: Holding[] = [];
    if (holdingsAccountIds.length > 0) {
      holdings = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Holding).find({
          where: { accountId: In(holdingsAccountIds) },
          relations: ["security", "account"],
        }),
      );
    }

    // Get latest prices for all securities in holdings
    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await getLatestPrices(securityIds);

    // A bond-linked security spans a whole program, so its price is a blend over
    // the lots of every account; a holding is worth its own account's lots
    // (bond-program-securities.md 2.4). One valuation per linked security.
    const bondValues = await this.valueBondHoldings(userId, holdings);

    // Historical cost basis, but only where the replay both knows it and
    // states it in the currency the holding's account keeps its books in.
    // Anything else falls through to the stored average cost below, the same
    // way a holding with no transaction history does.
    const currencyByAccount = new Map(
      holdings
        .filter((h) => h.account?.currencyCode)
        .map((h) => [h.accountId, h.account.currencyCode] as const),
    );
    const historicalCostBasis = await this.knownCostBasesIn(
      userId,
      holdingsAccountIds,
      currencyByAccount,
      new Map(
        holdings.map(
          (h) =>
            [`${h.accountId}:${h.securityId}`, Number(h.quantity)] as const,
        ),
      ),
    );

    const costBasisTotal = new FxAggregate();
    const holdingsValueTotal = new FxAggregate();
    const gainCostTotal = new FxAggregate();
    const gainValueTotal = new FxAggregate();
    const unpricedCostTotal = new FxAggregate();
    const unpricedSecurityIds = new Set<string>();
    const holdingsWithValues: HoldingWithMarketValue[] = [];

    for (const h of holdings) {
      if (Math.abs(Number(h.quantity)) < 0.0001) continue;

      const quantity = Number(h.quantity);
      const averageCost = Number(h.averageCost || 0);
      const costBasis = quantity * averageCost;
      // A linked security is never priced from the blend or a stored close:
      // its own lots' value, or unknown.
      const own = h.security.bondProgramId
        ? (bondValues.get(`${h.accountId}:${h.securityId}`) ?? null)
        : null;
      const currentPrice = h.security.bondProgramId
        ? (own?.unitPrice ?? null)
        : (priceMap.get(h.securityId) ?? null);
      const marketValue = h.security.bondProgramId
        ? (own?.marketValue ?? null)
        : currentPrice !== null
          ? quantity * currentPrice
          : null;
      const gainLoss = marketValue !== null ? marketValue - costBasis : null;
      const gainLossPercent =
        gainLoss !== null && costBasis > 0
          ? (gainLoss / costBasis) * 100
          : null;

      const holdingCurrency = h.security.currencyCode;
      const accountCurrency = h.account?.currencyCode ?? holdingCurrency;

      // Prefer the historical cost basis derived from transaction exchange
      // rates; fall back to current-rate conversion when no *usable* one is
      // available -- no transaction history (e.g. holdings imported without
      // it), a history the replay could not price, or a basis denominated in
      // some other account's currency. The stored average cost is the
      // application's other answer for those, and it is at least an answer
      // about this holding in this currency.
      const historicalKey = `${h.accountId}:${h.securityId}`;
      // `null` when the holding's basis currency has no rate into the account
      // currency: unknown, not "the same number". The row carries the null so a
      // consumer sees an unavailable basis instead of an unconverted one.
      let costBasisAccountCurrency: number | null | undefined =
        historicalCostBasis.get(historicalKey);
      if (costBasisAccountCurrency === undefined) {
        costBasisAccountCurrency = await this.convertToDefault(
          costBasis,
          holdingCurrency,
          accountCurrency,
          rateCache,
        );
      }

      // This holding's cost in the reporting currency, or `null` when a hop has
      // no rate. Kept so the gain can take the cost of exactly the holdings
      // whose value it takes.
      let costBasisDefaultCurrency: number | null = null;
      if (costBasisAccountCurrency === null) {
        // The conversion that failed is holding -> account; record that pair.
        // Filing it under account -> default named a hop that was never
        // attempted -- possibly a pair with a perfectly good rate, or the
        // degenerate `JPY->JPY` -- so the report told the user to fix a rate
        // that was not missing while never naming the one that was.
        costBasisTotal.add(null, holdingCurrency, accountCurrency);
      } else {
        costBasisDefaultCurrency = await this.convertToDefault(
          costBasisAccountCurrency,
          accountCurrency,
          defaultCurrency,
          rateCache,
        );
        costBasisTotal.add(
          costBasisDefaultCurrency,
          accountCurrency,
          defaultCurrency,
        );
      }
      // The row's value in the account and reporting currencies, from the SAME
      // rateCache the totals use, so the row and the total it joins share one
      // FX snapshot. `null` when the pair has no rate or the value is unknown;
      // the default-currency figure is exactly this holding's contribution to
      // `holdingsValueTotal` below.
      const marketValueAccountCurrency =
        marketValue === null
          ? null
          : await this.convertToDefault(
              marketValue,
              holdingCurrency,
              accountCurrency,
              rateCache,
            );
      const marketValueDefaultCurrency =
        marketValue === null
          ? null
          : await this.convertToDefault(
              marketValue,
              holdingCurrency,
              defaultCurrency,
              rateCache,
            );
      if (marketValue !== null) {
        holdingsValueTotal.add(
          marketValueDefaultCurrency,
          holdingCurrency,
          defaultCurrency,
        );
        // The gain takes a holding only when both its value and its cost are
        // in the reporting currency; one without the other is in neither side.
        if (
          marketValueDefaultCurrency !== null &&
          costBasisDefaultCurrency !== null
        ) {
          gainValueTotal.addConverted(marketValueDefaultCurrency);
          gainCostTotal.addConverted(costBasisDefaultCurrency);
        }
      } else {
        // The position is held and its value is unknown. Recorded rather than
        // silently dropped, so the total can say it is a subtotal.
        unpricedSecurityIds.add(h.securityId);
        // Its cost is not part of the gain; it is reported apart so a reader
        // sees how much cost the gain leaves out.
        if (costBasisDefaultCurrency !== null) {
          unpricedCostTotal.addConverted(costBasisDefaultCurrency);
        }
      }

      holdingsWithValues.push({
        id: h.id,
        accountId: h.accountId,
        securityId: h.securityId,
        symbol: h.security.symbol,
        name: h.security.name,
        securityType: h.security.securityType || "STOCK",
        currencyCode: holdingCurrency,
        quantity,
        averageCost,
        costBasis,
        costBasisAccountCurrency,
        currentPrice,
        marketValue,
        marketValueAccountCurrency,
        marketValueDefaultCurrency,
        gainLoss,
        gainLossPercent,
      });
    }

    const missingRatePairs = [
      ...new Set([
        ...costBasisTotal.missingPairs,
        ...holdingsValueTotal.missingPairs,
      ]),
    ].sort();
    if (missingRatePairs.length > 0) {
      this.logger.warn(
        `Portfolio totals omit holdings with no exchange rate (${missingRatePairs.join(", ")}); the returned totals are subtotals`,
      );
    }
    if (unpricedSecurityIds.size > 0) {
      this.logger.warn(
        `Portfolio totals omit ${unpricedSecurityIds.size} held position(s) with no current price; the returned totals are subtotals`,
      );
    }

    return {
      holdings,
      holdingsWithValues,
      totalCostBasis: costBasisTotal.knownSubtotal,
      totalHoldingsValue: holdingsValueTotal.knownSubtotal,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
      pricesComplete: unpricedSecurityIds.size === 0,
      unpricedSecurityIds: [...unpricedSecurityIds].sort(),
      gainCostBasis: gainCostTotal.knownSubtotal,
      gainMarketValue: gainValueTotal.knownSubtotal,
      unpricedCostBasis: unpricedCostTotal.knownSubtotal,
    };
  }

  // ---------------------------------------------------------------------------
  // Account grouping
  // ---------------------------------------------------------------------------

  /**
   * Sort holdings by market value descending (nulls last).
   */
  private sortHoldings(
    items: HoldingWithMarketValue[],
  ): HoldingWithMarketValue[] {
    return items.sort((a, b) => {
      if (a.marketValue === null && b.marketValue === null) return 0;
      if (a.marketValue === null) return 1;
      if (b.marketValue === null) return -1;
      return b.marketValue - a.marketValue;
    });
  }

  /**
   * Group enriched holdings by account, attaching cash balances and net-invested
   * figures. Returns an array of AccountHoldings sorted by total market value.
   */
  /**
   * Cost basis, market value and gain for one account, in that account's own
   * currency, with the completeness of each component.
   *
   * Written once and called from both the brokerage and standalone loops: the two
   * had the identical fold with a different currency variable, and the account-level
   * completeness fix would otherwise have gone into one of them (recheck RR3-005,
   * and the repo's rule that a predicate deciding which row counts is written once).
   *
   * The gaps are returned rather than only logged. The top-level totals convert each
   * security straight into the user's default currency, which is a *different*
   * conversion path -- so a portfolio can be complete at the top while a JPY
   * account's own total is missing EUR->JPY entirely, and a consumer reading the
   * nested figure has no way to know from the global flag.
   */
  private async accountTotals(
    accountHoldings: HoldingWithMarketValue[],
    accountCurrency: string,
    rateCache: FxRateCache,
  ): Promise<{
    totalCostBasis: number;
    totalMarketValue: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    /** Cost of the holdings the gain is over: those with a value that converted. */
    gainCostBasis: number;
    /** Cost of the holdings left out of the gain for having no value. */
    unpricedCostBasis: number;
    fxComplete: boolean;
    missingRatePairs: string[];
    pricesComplete: boolean;
    unpricedSecurityIds: string[];
    unpricedHoldingsCount: number;
    valuationComplete: boolean;
  }> {
    const costBasisAgg = new FxAggregate();
    const marketValueAgg = new FxAggregate();
    const gainCostAgg = new FxAggregate();
    const gainValueAgg = new FxAggregate();
    const unpricedCostAgg = new FxAggregate();
    const unpriced = new Set<string>();
    let unpricedHoldingsCount = 0;

    for (const h of accountHoldings) {
      // A holding whose basis could not be denominated in this account's currency
      // is recorded as a gap, not added as though it already were.
      costBasisAgg.add(
        h.costBasisAccountCurrency,
        h.currencyCode,
        accountCurrency,
      );
      // An unpriced holding is unknown, not zero: `?? 0` folded it in as free and
      // the account total then read like a complete valuation of a position nobody
      // could value.
      if (h.marketValue === null) {
        unpriced.add(h.securityId);
        unpricedHoldingsCount += 1;
        // Its cost is not part of the gain; it is reported apart.
        if (h.costBasisAccountCurrency !== null) {
          unpricedCostAgg.addConverted(h.costBasisAccountCurrency);
        }
        continue;
      }
      const valueInAccountCurrency = await this.convertToDefault(
        h.marketValue,
        h.currencyCode,
        accountCurrency,
        rateCache,
      );
      marketValueAgg.add(
        valueInAccountCurrency,
        h.currencyCode,
        accountCurrency,
      );
      // The gain takes the value and the cost of the same holdings only.
      if (
        valueInAccountCurrency !== null &&
        h.costBasisAccountCurrency !== null
      ) {
        gainValueAgg.addConverted(valueInAccountCurrency);
        gainCostAgg.addConverted(h.costBasisAccountCurrency);
      }
    }

    const missingRatePairs = [
      ...new Set([
        ...costBasisAgg.missingPairs,
        ...marketValueAgg.missingPairs,
      ]),
    ].sort();
    if (missingRatePairs.length > 0) {
      this.logger.warn(
        `Account totals omit holdings with no exchange rate (${missingRatePairs.join(", ")}); the returned totals and gain are subtotals`,
      );
    }

    const totalCostBasis = costBasisAgg.knownSubtotal;
    const totalMarketValue = marketValueAgg.knownSubtotal;
    // Value less cost of the SAME holdings (A26-M38): the unpriced holdings' cost
    // is not charged against a value that never included them.
    const gainCostBasis = gainCostAgg.knownSubtotal;
    const totalGainLoss = gainValueAgg.knownSubtotal - gainCostBasis;

    return {
      totalCostBasis,
      totalMarketValue,
      totalGainLoss,
      totalGainLossPercent:
        gainCostBasis > 0 ? (totalGainLoss / gainCostBasis) * 100 : 0,
      gainCostBasis,
      unpricedCostBasis: unpricedCostAgg.knownSubtotal,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
      pricesComplete: unpriced.size === 0,
      unpricedSecurityIds: [...unpriced].sort(),
      unpricedHoldingsCount,
      valuationComplete: missingRatePairs.length === 0 && unpriced.size === 0,
    };
  }

  async buildHoldingsByAccount(
    categorised: CategorisedAccounts,
    holdingsWithValues: HoldingWithMarketValue[],
    effectiveBalances: Map<string, number>,
    investmentFlows: Map<
      string,
      { buys: number; sells: number; income: number }
    >,
    rateCache: FxRateCache,
  ): Promise<AccountHoldings[]> {
    // Group holdings by account
    const holdingsByAccountMap = new Map<string, HoldingWithMarketValue[]>();
    for (const holding of holdingsWithValues) {
      const existing = holdingsByAccountMap.get(holding.accountId) || [];
      existing.push(holding);
      holdingsByAccountMap.set(holding.accountId, existing);
    }

    const holdingsByAccount: AccountHoldings[] = [];

    // Process brokerage accounts (paired with cash accounts)
    for (const brokerageAccount of categorised.brokerageAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(brokerageAccount.id) || [];

      // Find the linked cash account
      const linkedCashAccount = categorised.cashAccounts.find(
        (c) =>
          c.linkedAccountId === brokerageAccount.id ||
          brokerageAccount.linkedAccountId === c.id,
      );

      // Calculate account totals. Cost basis uses the historical (stored)
      // exchange rate from each originating transaction, while market value
      // uses the current exchange rate so unrealised gains reflect today's
      // valuation vs. the price actually paid when shares were bought.
      const acctTotals = await this.accountTotals(
        accountHoldings,
        brokerageAccount.currencyCode,
        rateCache,
      );

      // Get display name (remove the localized " - Brokerage" suffix if present)
      const accountName = stripBrokerageSuffix(brokerageAccount.name);

      const cashBalance = linkedCashAccount
        ? (effectiveBalances.get(linkedCashAccount.id) ??
          Number(linkedCashAccount.currentBalance))
        : 0;
      const flows = investmentFlows.get(brokerageAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const accountNetInvested =
        cashBalance + flows.buys - flows.sells - flows.income;

      holdingsByAccount.push({
        accountId: brokerageAccount.id,
        accountName,
        currencyCode: brokerageAccount.currencyCode,
        cashAccountId: linkedCashAccount?.id ?? null,
        cashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: acctTotals.totalCostBasis,
        totalMarketValue: acctTotals.totalMarketValue,
        unpricedHoldingsCount: acctTotals.unpricedHoldingsCount,
        totalGainLoss: acctTotals.totalGainLoss,
        totalGainLossPercent: acctTotals.totalGainLossPercent,
        gainCostBasis: acctTotals.gainCostBasis,
        unpricedCostBasis: acctTotals.unpricedCostBasis,
        fxComplete: acctTotals.fxComplete,
        missingRatePairs: acctTotals.missingRatePairs,
        pricesComplete: acctTotals.pricesComplete,
        unpricedSecurityIds: acctTotals.unpricedSecurityIds,
        valuationComplete: acctTotals.valuationComplete,
        netInvested: roundMoney(accountNetInvested),
      });
    }

    // Process standalone investment accounts (not paired, cash balance is on the same account)
    for (const standaloneAccount of categorised.standaloneAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(standaloneAccount.id) || [];

      // Calculate account totals — historical cost basis + current-rate
      // market value, same treatment as brokerage accounts above.
      const acctTotals = await this.accountTotals(
        accountHoldings,
        standaloneAccount.currencyCode,
        rateCache,
      );

      const standaloneCashBalance =
        effectiveBalances.get(standaloneAccount.id) ??
        Number(standaloneAccount.currentBalance);
      const standaloneFlows = investmentFlows.get(standaloneAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const standaloneNetInvested =
        standaloneCashBalance +
        standaloneFlows.buys -
        standaloneFlows.sells -
        standaloneFlows.income;

      holdingsByAccount.push({
        accountId: standaloneAccount.id,
        accountName: standaloneAccount.name,
        currencyCode: standaloneAccount.currencyCode,
        cashAccountId: standaloneAccount.id, // Cash is on this same account
        cashBalance: standaloneCashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: acctTotals.totalCostBasis,
        totalMarketValue: acctTotals.totalMarketValue,
        unpricedHoldingsCount: acctTotals.unpricedHoldingsCount,
        totalGainLoss: acctTotals.totalGainLoss,
        totalGainLossPercent: acctTotals.totalGainLossPercent,
        gainCostBasis: acctTotals.gainCostBasis,
        unpricedCostBasis: acctTotals.unpricedCostBasis,
        fxComplete: acctTotals.fxComplete,
        missingRatePairs: acctTotals.missingRatePairs,
        pricesComplete: acctTotals.pricesComplete,
        unpricedSecurityIds: acctTotals.unpricedSecurityIds,
        valuationComplete: acctTotals.valuationComplete,
        netInvested: roundMoney(standaloneNetInvested),
      });
    }

    // Sort accounts by total market value descending
    holdingsByAccount.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    return holdingsByAccount;
  }

  // ---------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------

  /**
   * Build the portfolio allocation breakdown from sorted holdings and cash.
   */
  async buildAllocation(
    sortedHoldings: HoldingWithMarketValue[],
    holdings: Holding[],
    totalCashValue: number,
    defaultCurrency: string,
    rateCache: FxRateCache,
  ): Promise<AllocationItem[]> {
    const allocation: AllocationItem[] = [];
    const colors = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];

    // Consolidate holdings by security so the same security held across
    // multiple accounts appears as a single allocation slice.
    const consolidated = new Map<
      string,
      {
        name: string;
        symbol: string;
        currencyCode: string;
        value: number;
      }
    >();

    for (const holding of sortedHoldings) {
      if (holding.marketValue === null || holding.marketValue <= 0) continue;
      const originalHolding = holdings.find((h) => h.id === holding.id);
      const holdingCurrency =
        originalHolding?.security?.currencyCode || defaultCurrency;
      const convertedValue = await this.convertToDefault(
        holding.marketValue,
        holdingCurrency,
        defaultCurrency,
        rateCache,
      );
      // A holding with no rate into the reporting currency cannot be ranked
      // against the others; omitting it is honest, entering it at 1:1 would put
      // it in the wrong place in the list.
      if (convertedValue === null) continue;
      const existing = consolidated.get(holding.securityId);
      if (existing) {
        existing.value += convertedValue;
      } else {
        consolidated.set(holding.securityId, {
          name: holding.name,
          symbol: holding.symbol,
          currencyCode: holdingCurrency,
          value: convertedValue,
        });
      }
    }

    const consolidatedItems = [...consolidated.values()].sort(
      (a, b) => b.value - a.value,
    );

    // Percentages are measured against the sum of the slices actually drawn
    // (positive security values plus positive cash), not the net portfolio
    // value. Using the net value would let a negative cash balance (margin /
    // loan) or a short position shrink the denominator and inflate every
    // slice past 100%; the drawn total always reconciles to ~100%.
    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal =
      consolidatedItems.reduce((sum, item) => sum + item.value, 0) +
      positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: roundMoney(totalCashValue),
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    let colorIndex = 0;
    for (const item of consolidatedItems) {
      allocation.push({
        name: item.name,
        symbol: item.symbol,
        type: "security",
        value: roundMoney(item.value),
        percentage: pct(item.value),
        color: colors[colorIndex % colors.length],
        currencyCode: item.currencyCode,
      });
      colorIndex++;
    }

    allocation.sort((a, b) => b.value - a.value);
    return allocation;
  }

  /**
   * Build a portfolio "exposure by tag" breakdown from the already-consolidated
   * per-security allocation (values in the default currency) and a per-symbol
   * tag map.
   *
   * Multi-tag handling is option A (overlapping exposure): a security's full
   * value counts once under EACH of its tags, so a holding tagged both "AI" and
   * "All-World" contributes its whole value to both slices. Percentages are of
   * the total portfolio value and can therefore sum to more than 100% -- this is
   * an exposure view, not a strict partition. (Partitioning a multi-tagged
   * holding's value, or charting one tag dimension at a time, are deliberately
   * left as open follow-ups.)
   *
   * Securities with no tags fall into an "Untagged" bucket and cash into a
   * "Cash" bucket, each kept as an explicit slice. A tag's own colour is used
   * when set, otherwise a palette colour is assigned by descending value.
   */
  buildAllocationByTag(
    securityItems: AllocationItem[],
    tagsBySymbol: Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >,
    totalCashValue: number,
    defaultCurrency: string,
  ): AllocationItem[] {
    const palette = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];

    // Accumulate value per tag (overlapping) and the untagged remainder.
    const tagBuckets = new Map<
      string,
      { name: string; color: string | null; value: number }
    >();
    let untaggedValue = 0;
    // Sum of every security slice that lands on the chart (tagged or not).
    // This, plus positive cash, is the denominator so tag and Untagged slices
    // share one base and reconcile to ~100%.
    let includedSecuritiesValue = 0;

    for (const item of securityItems) {
      if (item.type !== "security" || item.value <= 0) continue;
      includedSecuritiesValue += item.value;
      const tags = item.symbol ? (tagsBySymbol.get(item.symbol) ?? []) : [];
      if (tags.length === 0) {
        untaggedValue += item.value;
        continue;
      }
      for (const tag of tags) {
        const existing = tagBuckets.get(tag.id);
        if (existing) {
          existing.value += item.value;
        } else {
          tagBuckets.set(tag.id, {
            name: tag.name,
            color: tag.color,
            value: item.value,
          });
        }
      }
    }

    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal = includedSecuritiesValue + positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    const allocation: AllocationItem[] = [];

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    const sortedTags = [...tagBuckets.values()].sort(
      (a, b) => b.value - a.value,
    );
    let colorIndex = 0;
    for (const bucket of sortedTags) {
      allocation.push({
        name: bucket.name,
        symbol: null,
        type: "tag",
        value: bucket.value,
        percentage: pct(bucket.value),
        color: bucket.color || palette[colorIndex % palette.length],
        currencyCode: defaultCurrency,
      });
      colorIndex++;
    }

    if (untaggedValue > 0) {
      allocation.push({
        name: "Untagged",
        symbol: null,
        type: "untagged",
        value: untaggedValue,
        percentage: pct(untaggedValue),
        color: "#9ca3af",
        currencyCode: defaultCurrency,
      });
    }

    return allocation;
  }

  /**
   * Portfolio allocation aggregated by the VALUE of a single KEY:VALUE tag key.
   *
   * Given a key such as `country`, every security's value is attributed to the
   * value(s) of its `country:*` tags (`country:usa` -> the "usa" slice), so a
   * `country` chart reads e.g. "50% usa, 25% poland, 25% germany". A security
   * that carries no value for the key (no `country:*` tag, or only a bare
   * `country:` with an empty value) falls into an "Untagged" slice; cash is a
   * "Cash" slice. Every slice shares one denominator -- the drawn security
   * values plus positive cash -- so percentages reconcile to ~100%.
   *
   * Multi-value handling mirrors {@link buildAllocationByTag}'s overlapping
   * exposure: a security tagged both `country:usa` and `country:poland` (a
   * mixed fund) counts its full value under each, so slices can sum past 100%.
   * Weighted splitting per value is a deliberate follow-up.
   */
  buildAllocationByTagKey(
    securityItems: AllocationItem[],
    tagsBySymbol: Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >,
    totalCashValue: number,
    defaultCurrency: string,
    key: string,
  ): AllocationItem[] {
    const palette = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];
    const normalizedKey = key.trim().toLowerCase();

    // valueKey (case-folded) -> { display value, colour, accumulated value }
    const valueBuckets = new Map<
      string,
      { name: string; color: string | null; value: number }
    >();
    let unassignedValue = 0;
    let includedSecuritiesValue = 0;

    for (const item of securityItems) {
      if (item.type !== "security" || item.value <= 0) continue;
      includedSecuritiesValue += item.value;
      const tags = item.symbol ? (tagsBySymbol.get(item.symbol) ?? []) : [];

      // Distinct concrete values this security carries under the key.
      const matched = new Map<
        string,
        { display: string; color: string | null }
      >();
      for (const tag of tags) {
        const parsed = parseTag(tag.name);
        if (parsed.key === null || parsed.key.toLowerCase() !== normalizedKey) {
          continue;
        }
        if (parsed.value === null) continue; // bare `key:` -> no concrete value
        const valueKey = parsed.value.toLowerCase();
        if (!matched.has(valueKey)) {
          matched.set(valueKey, { display: parsed.value, color: tag.color });
        }
      }

      if (matched.size === 0) {
        unassignedValue += item.value;
        continue;
      }
      for (const [valueKey, meta] of matched) {
        const existing = valueBuckets.get(valueKey);
        if (existing) {
          existing.value += item.value;
        } else {
          valueBuckets.set(valueKey, {
            name: meta.display,
            color: meta.color,
            value: item.value,
          });
        }
      }
    }

    const positiveCash = totalCashValue > 0 ? totalCashValue : 0;
    const drawnTotal = includedSecuritiesValue + positiveCash;
    const pct = (value: number) =>
      drawnTotal > 0 ? (value / drawnTotal) * 100 : 0;

    const allocation: AllocationItem[] = [];

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage: pct(totalCashValue),
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    const sortedValues = [...valueBuckets.values()].sort(
      (a, b) => b.value - a.value,
    );
    let colorIndex = 0;
    for (const bucket of sortedValues) {
      allocation.push({
        name: bucket.name,
        symbol: null,
        type: "tag",
        value: bucket.value,
        percentage: pct(bucket.value),
        color: bucket.color || palette[colorIndex % palette.length],
        currencyCode: defaultCurrency,
      });
      colorIndex++;
    }

    if (unassignedValue > 0) {
      allocation.push({
        name: "Untagged",
        symbol: null,
        type: "untagged",
        value: unassignedValue,
        percentage: pct(unassignedValue),
        color: "#9ca3af",
        currencyCode: defaultCurrency,
      });
    }

    return allocation;
  }

  // ---------------------------------------------------------------------------
  // Performance metrics
  // ---------------------------------------------------------------------------

  /**
   * Calculate CAGR (Compound Annual Growth Rate).
   * CAGR = (Portfolio Value / Net Invested) ^ (1/years) - 1
   */
  async calculateCAGR(
    userId: string,
    allInvestmentAccountIds: string[],
    totalNetInvested: number,
    totalPortfolioValue: number,
  ): Promise<number | null> {
    if (
      totalNetInvested <= 0 ||
      totalPortfolioValue <= 0 ||
      allInvestmentAccountIds.length === 0
    ) {
      return null;
    }

    const earliestRow: { earliest: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(transaction_date) as earliest
       FROM investment_transactions
       WHERE user_id = $1
         AND account_id = ANY($2)
         AND transaction_date <= CURRENT_DATE
         AND status != 'VOID'`,
          [userId, allInvestmentAccountIds],
        ),
    );
    if (!earliestRow[0]?.earliest) return null;

    const earliest = new Date(earliestRow[0].earliest);
    const now = new Date();
    const years =
      (now.getTime() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    // CAGR annualizes the total return, so for periods shorter than a year
    // it extrapolates a few days of price movement into a multi-decade
    // growth rate. The math is correct but the number is meaningless and
    // can run into the thousands of percent (or worse) for fresh accounts.
    if (years < 1) return null;

    return (
      (Math.pow(totalPortfolioValue / totalNetInvested, 1 / years) - 1) * 100
    );
  }

  // ---------------------------------------------------------------------------
  // Stored price history, for the per-period valuations the reports walk
  // ---------------------------------------------------------------------------

  /**
   * Get all historical prices for a list of security IDs, ordered by date.
   * Returns a map of securityId -> sorted array of { date, price }.
   */
  async getAllPricesForSecurities(
    securityIds: string[],
  ): Promise<Map<string, { date: string; price: number }[]>> {
    if (securityIds.length === 0) return new Map();

    const rows: {
      security_id: string;
      price_date: string;
      close_price: string;
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, price_date::text AS price_date, close_price
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date ASC`,
        [securityIds],
      ),
    );

    const result = new Map<string, { date: string; price: number }[]>();
    for (const row of rows) {
      let arr = result.get(row.security_id);
      if (!arr) {
        arr = [];
        result.set(row.security_id, arr);
      }
      arr.push({ date: row.price_date, price: Number(row.close_price) });
    }
    return result;
  }

  /**
   * Look up the price for a security on or before a given date using binary search.
   */
  lookupPrice(
    securityId: string,
    date: string,
    allPrices: Map<string, { date: string; price: number }[]>,
  ): number | null {
    const prices = allPrices.get(securityId);
    if (!prices || prices.length === 0) return null;

    let lo = 0;
    let hi = prices.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? prices[best].price : null;
  }
}
