import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { In, DataSource, EntityManager, Not } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { Cron } from "@nestjs/schedule";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";
import { NetWorthService } from "../net-worth/net-worth.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withSystemContext } from "../common/db/with-context";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { markHoldingAccountsDirty } from "./holding-accounts-dirty.util";
import { isPricedByQuoteProvider } from "./provider-priced.util";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteResult,
  HistoricalPrice,
  HistoricalSeries,
  SecurityLookupResult,
} from "./providers/quote-provider.interface";
import {
  normalizeQuoteCurrency,
  verifyProviderCurrency,
} from "./providers/quote-currency.util";
import {
  DEFAULT_QUOTE_PROVIDER,
  QuoteProviderRegistry,
} from "./providers/quote-provider.registry";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import { getMarketSessionFromQuote } from "./providers/market-session.util";
import { isSessionSettled } from "./providers/settled-bar.util";
import { assertDailySeries } from "./providers/daily-spacing.util";
import { MARKET_PRICED_TRADE_ACTIONS } from "./investment-replay.util";
import {
  invalidateAllPortfolioSummaries,
  invalidatePortfolioSummary,
} from "./portfolio-summary-memo";
import { BackfillRange } from "./dto/backfill-prices-query.dto";
import { CreateSecurityPriceDto } from "./dto/create-security-price.dto";
import { UpdateSecurityPriceDto } from "./dto/update-security-price.dto";
import {
  DEFAULT_PRICE_HISTORY_ROWS,
  MAX_PRICE_HISTORY_ROWS,
} from "./dto/price-history-query.dto";
import { formatDateYMD, todayYMD } from "../common/date-utils";
import { mapWithConcurrency } from "../common/concurrency.util";
import {
  EmptyWindowMemory,
  monthFetchWindow,
} from "../common/time-series/history-fill";
import { daysBetween } from "../common/time-series/price-boundary.util";
import { BOND_ENGINE_PRICE_SOURCE } from "../bonds/bond-price-source";
import { SecurityType } from "./security-enums";

export { SecurityLookupResult } from "./providers/quote-provider.interface";

// Lowercased action names a transaction-derived price row is stored under.
// Derived from the shared trade list so a new Money-vocabulary action cannot
// write a source this guard list does not recognize (an unlisted source would
// never be overwritten or cleaned up again). It is also the whole list of rows
// a transaction-derived price may replace: another transaction price, and
// nothing else. A bond-engine row is not among them (INV-BOND-005): a
// transaction price is one lot's trade price, not the holding's value, so for a
// linked security the engine's row replaces a transaction-derived one and never
// the reverse; the engine's own upsert replaces every non-manual row, so the
// two orders end the same.
const TRANSACTION_SOURCES = [
  ...MARKET_PRICED_TRADE_ACTIONS.map((action) => action.toLowerCase()),
  "transfer_in",
  "transfer_out",
];

/**
 * A provider write is re-checked against the link at the moment of the write,
 * not only when the security list was loaded: a refresh or backfill can hold an
 * unlinked security in memory for minutes while the user links it to a bond
 * instrument (INV-BOND-005, the engine is a linked security's only automatic
 * price source). `$1` is the security id in every statement that uses these.
 */
const BOND_LINKED_SQL = `SELECT 1 FROM securities bl
   WHERE bl.id = $1::UUID AND bl.bond_program_id IS NOT NULL`;

/** The existing rows a provider may replace: neither a manual nor a bond-engine price. */
const PROVIDER_MAY_REPLACE_SQL = `security_prices.source IS DISTINCT FROM 'manual'
         AND security_prices.source IS DISTINCT FROM '${BOND_ENGINE_PRICE_SOURCE}'`;

// Cap simultaneous external quote fetches so a large securities universe does
// not fire hundreds of concurrent Yahoo/MSN requests and trip rate limits.
const QUOTE_FETCH_CONCURRENCY = 6;

/**
 * How far back the daily settlement pass re-reads the provider's bars.
 *
 * Wide enough that a job which did not fire, a provider outage or a week of
 * intraday-only rows repairs itself without anyone noticing it needs to; short
 * enough that the response is a few dozen bars per symbol rather than the
 * several megabytes a `max` range returns. Deep history is the backfill's job.
 */
const SETTLEMENT_RANGE = "1mo";

/**
 * How long the on-demand price fill may spend before it stops starting fetches.
 *
 * It runs inside a report request over however many securities that report
 * holds, and a provider under load answers slowly rather than not at all -- so
 * without a ceiling one stale month could keep a page waiting on dozens of
 * sequential timeouts. What is not reached stays unpriced, which the report
 * already renders as a null total, and the count is logged.
 */
const PRICE_FILL_BUDGET_MS = 15_000;

/**
 * The narrowest named range that still reaches `date`, for a provider whose
 * chart API takes a timeframe rather than a window.
 *
 * Named ranges are anchored at today, so reaching further back means asking for
 * more; the point is to ask for as little more as the allowlist permits.
 */
function rangeReaching(date: string): BackfillRange {
  // A month of slack, so a range that lands within days of the date still
  // covers the lead the boundary lookup reaches over.
  const years = (daysBetween(date, todayYMD()) + 31) / 365.25;
  if (years <= 1) return "1y";
  if (years <= 2) return "2y";
  if (years <= 5) return "5y";
  if (years <= 10) return "10y";
  return "max";
}

/**
 * Price writes that were started without anybody waiting for them.
 *
 * Creating a security or an investment transaction kicks off a price fetch and
 * returns straight away -- deliberately, because the user should not wait on
 * Yahoo to see their own row. The write that lands afterwards is still a write,
 * and it arrives with no relationship to the request that caused it.
 *
 * Harmless in a running server. Not harmless against a database being torn
 * down: an integration suite that truncates `securities ... CASCADE` while one
 * of these is inserting into `security_prices` takes both sides of a lock in
 * the opposite order and deadlocks, or -- when the truncate wins -- the insert
 * comes back as a foreign key violation against a security that no longer
 * exists. Neither is a bug in the code under test, and both read as one.
 *
 * Module scope rather than instance state on purpose: the thing that needs to
 * wait is a test helper holding a `DataSource`, not a consumer of this service,
 * and giving it the whole DI graph to reach one boolean would be the larger
 * change. Nothing in `src/` waits on this; production keeps exactly the
 * fire-and-forget behaviour it had.
 */
const pendingPriceWrites = new Set<Promise<unknown>>();

/**
 * Resolves once every background price write started so far has finished, in
 * either direction. Call this before dropping or truncating price tables.
 *
 * Settled, not successful: a failed backfill has also stopped touching the
 * database, which is the only property a teardown needs.
 */
export async function settlePendingPriceWrites(): Promise<void> {
  // Snapshotted because a settling promise removes itself from the set, and a
  // backfill may start another write before it finishes.
  while (pendingPriceWrites.size > 0) {
    await Promise.allSettled([...pendingPriceWrites]);
  }
}

/** Register a background price write so `settlePendingPriceWrites` can see it. */
function trackPriceWrite<T>(work: Promise<T>): Promise<T> {
  pendingPriceWrites.add(work);
  // `finally` keeps the returned promise's own settlement untouched, so a
  // caller that does await this still sees the original result or rejection.
  return work.finally(() => pendingPriceWrites.delete(work));
}

function sourceFor(provider: QuoteProviderName | undefined): string {
  switch (provider) {
    case "msn":
      return "msn_finance";
    case "lse":
      return "lse";
    case "deutsche_boerse":
      return "deutsche_boerse";
    case "html_table":
      return "html_table";
    default:
      return "yahoo_finance";
  }
}

/**
 * The providers ordered with the user's default first, the rest in registry
 * order. Used where every provider is consulted -- lookup aggregation and the
 * authoritative-currency probe -- rather than the narrower price-refresh
 * fallback in `QuoteProviderRegistry.resolveForSecurity`.
 */
function orderProvidersByDefault(
  providers: QuoteProvider[],
  defaultName: QuoteProviderName | null | undefined,
): QuoteProvider[] {
  const primary = defaultName ?? DEFAULT_QUOTE_PROVIDER;
  return [...providers].sort(
    (a, b) => (b.name === primary ? 1 : 0) - (a.name === primary ? 1 : 0),
  );
}

/**
 * A security linked to a bond instrument is never eligible: the bond engine is
 * its only automatic price source (`isPricedByQuoteProvider`, INV-BOND-005).
 * Otherwise a security is eligible for scheduled price refresh when
 * skipPriceUpdates is false. The flag is the user's own switch (the security
 * form's "disable automatic price updates"), and imports set it on the
 * securities whose symbol they invented. A per-security provider override or
 * MSN Instrument ID does not override it: choosing one clears the flag at
 * write time (`SecuritiesService.update`), so a security that still carries
 * the flag is one the user has asked not to be fetched.
 */
function isRefreshEligible(s: {
  skipPriceUpdates: boolean;
  bondProgramId?: string | null;
}): boolean {
  if (!isPricedByQuoteProvider(s)) return false;
  return !s.skipPriceUpdates;
}

export interface PriceUpdateResult {
  symbol: string;
  success: boolean;
  price?: number;
  error?: string;
  provider?: QuoteProviderName;
}

export interface PriceRefreshSummary {
  totalSecurities: number;
  updated: number;
  failed: number;
  skipped: number;
  results: PriceUpdateResult[];
  lastUpdated: Date;
}

export interface DailySettlementSummary {
  totalSecurities: number;
  /** Securities that had at least one settled bar written. */
  securitiesSettled: number;
  /** Rows written, counting a security once per settled session. */
  barsSettled: number;
  failed: number;
}

/**
 * Narrows the active securities a deployment-wide pass (refresh, settlement)
 * selects. Omitted, the pass covers every active security.
 */
export interface SecurityPassScope {
  /**
   * Only securities of this type. Keyed on `securityType`, the discriminator a
   * person picks and the lookup maps, never on `exchange`: a coin created
   * before the lookup named `CRYPTO` still carries Yahoo's `CCC`.
   */
  readonly securityType?: SecurityType;
}

/** How a log line names the securities a pass covers. */
function describePassScope(scope: SecurityPassScope): string {
  return scope.securityType ?? "all";
}

export interface HistoricalBackfillResult {
  symbol: string;
  success: boolean;
  pricesLoaded?: number;
  error?: string;
  provider?: QuoteProviderName;
}

export interface HistoricalBackfillSummary {
  totalSecurities: number;
  successful: number;
  failed: number;
  totalPricesLoaded: number;
  results: HistoricalBackfillResult[];
}

interface UserContext {
  defaultQuoteProvider: QuoteProviderName;
  preferredExchanges: string[];
}

interface HistoricalWithProvider {
  prices: HistoricalPrice[];
  provider: QuoteProviderName;
  /**
   * The currency the provider says these bars are in, normalized. Carried from
   * the provider's own answer so every write site can refuse a series that
   * belongs to another listing of the same ticker.
   */
  currencyCode: string | null;
}

/**
 * What an acceptance point came back with: the answer, or the reason there is
 * none to store. A refusal is a *reported* fact about the security -- the
 * provider answered about a different currency -- so it reaches the user as
 * that security's error rather than as "no price data available".
 */
interface QuoteAcceptance {
  quote: QuoteResult | null;
  refusal?: string;
}

interface HistoricalAcceptance {
  bundle: HistoricalWithProvider | null;
  refusal?: string;
}

@Injectable()
export class SecurityPriceService {
  private readonly logger = new Logger(SecurityPriceService.name);

  /**
   * Securities whose month a provider answered with nothing, for the on-demand
   * fill below. See `EmptyWindowMemory`.
   */
  private readonly emptyPriceWindows = new EmptyWindowMemory();

  constructor(
    private dataSource: DataSource,
    private netWorthService: NetWorthService,
    private providers: QuoteProviderRegistry,
    private readonly fetchSync: FetchSyncService,
  ) {}

  /**
   * How long one replica holds the price fetch.
   *
   * The refresh plus settlement plus the snapshot recalc is the longest of the
   * three fetch jobs, so the lease is the longest -- and still far shorter than
   * the daily interval, so a killed replica never blocks tomorrow.
   */
  private readonly FETCH_LEASE_MS = 30 * 60 * 1000;

  // ─── User preference loading ─────────────────────────────────────────────

  /**
   * Build a per-user context map (default provider + preferred exchanges) for
   * the given set of user IDs, in a single query. Missing rows fall back to
   * the defaults.
   */
  private async loadUserContexts(
    userIds: string[],
  ): Promise<Map<string, UserContext>> {
    const ctx = new Map<string, UserContext>();
    if (userIds.length === 0) return ctx;

    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).find({
        where: { userId: In([...new Set(userIds)]) },
      }),
    );

    for (const p of prefs) {
      ctx.set(p.userId, {
        defaultQuoteProvider:
          (p.defaultQuoteProvider as QuoteProviderName) ||
          DEFAULT_QUOTE_PROVIDER,
        preferredExchanges: p.preferredExchanges || [],
      });
    }

    for (const id of userIds) {
      if (!ctx.has(id)) {
        ctx.set(id, {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        });
      }
    }
    return ctx;
  }

  // ─── Quote fetch with provider fallback ──────────────────────────────────

  /**
   * Try each provider in registry order. Both "throws" and "returns null"
   * trigger the fallback. Returns the first quote that has a usable price.
   *
   * `group` is every security the caller will write this answer to -- the
   * symbol/exchange group the fetch is made for, defaulting to `security`
   * alone. The fetch-time currency check passes the answer on when *any*
   * member could store it (see `acceptedBySomeMember`); the refusal that
   * decides what is written is still made per security at the write.
   */
  private async fetchQuoteWithFallback(
    security: Security,
    ctx: UserContext,
    group: readonly Security[] = [security],
  ): Promise<QuoteAcceptance> {
    const ordered = this.providers.resolveForSecurity(
      security,
      ctx.defaultQuoteProvider,
    );

    this.logger.log(
      `Refresh ${security.symbol}: override=${security.quoteProvider ?? "(none)"} default=${ctx.defaultQuoteProvider} → trying [${ordered.map((p) => p.name).join(", ")}]`,
    );

    let refusal: string | undefined;
    for (const provider of ordered) {
      try {
        const quote = await provider.fetchQuote(
          security.symbol,
          security.exchange,
          this.optsFor(provider, security, ctx),
        );
        if (quote && quote.regularMarketPrice !== undefined) {
          // A price is a number in a currency, and the row it would be written
          // to carries only the number. So the answer is checked here, before
          // anybody can store it, and a provider quoting another listing of
          // this ticker is passed over rather than accepted -- the next
          // provider gets its turn and faces the same check.
          const mismatch = this.acceptedBySomeMember(
            group,
            quote.currencyCode,
            provider.name,
          );
          if (mismatch) {
            refusal = mismatch;
            continue;
          }
          this.logger.log(
            `Refresh ${security.symbol}: ${provider.name} returned price=${quote.regularMarketPrice}`,
          );
          return { quote: { ...quote, provider: provider.name } };
        }
        this.logger.log(
          `Refresh ${security.symbol}: ${provider.name} returned no usable price`,
        );
      } catch (err) {
        this.logger.warn(
          `${provider.name} fetchQuote failed for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn(
      `Refresh ${security.symbol}: no provider returned a price`,
    );
    return { quote: null, refusal };
  }

  /** Same group semantics as `fetchQuoteWithFallback`. */
  private async fetchHistoricalWithFallback(
    security: Security,
    range: string,
    ctx: UserContext,
    group: readonly Security[] = [security],
  ): Promise<HistoricalAcceptance> {
    const ordered = this.providers.resolveForSecurity(
      security,
      ctx.defaultQuoteProvider,
    );

    let refusal: string | undefined;
    for (const provider of ordered) {
      try {
        const series = await provider.fetchHistoricalSeries(
          security.symbol,
          security.exchange,
          range,
          this.optsFor(provider, security, ctx),
        );
        if (series && series.prices.length > 0) {
          const mismatch = this.acceptedBySomeMember(
            group,
            series.currencyCode,
            provider.name,
          );
          if (mismatch) {
            refusal = mismatch;
            continue;
          }
          return {
            bundle: {
              prices: series.prices,
              provider: provider.name,
              currencyCode: series.currencyCode,
            },
          };
        }
      } catch (err) {
        this.logger.warn(
          `${provider.name} fetchHistorical failed for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { bundle: null, refusal };
  }

  /**
   * The one comparison every price acceptance point makes: does the currency
   * the provider reported match the one the security is recorded in.
   *
   * Returns the message to report when it does not, and `null` when the answer
   * may be stored. A provider that reports no currency at all (MSN's chart
   * series) is accepted as unverified rather than refused, because refusing it
   * would leave those securities with no prices; the decision is logged.
   *
   * At a *write* this is called per security, never per group: the refresh and
   * backfill passes fetch once for a representative and write for every
   * security sharing its symbol and exchange, and those securities can be
   * recorded in different currencies. At a *fetch* the group form
   * `acceptedBySomeMember` asks it of the whole group instead.
   */
  private refuseForeignCurrency(
    security: Pick<Security, "symbol" | "currencyCode">,
    reported: string | null | undefined,
    provider: QuoteProviderName,
    opts: { warnUnverified?: boolean } = {},
  ): string | null {
    const verdict = verifyProviderCurrency(security.currencyCode, reported);
    if (verdict.accepted) {
      if (!verdict.verified && opts.warnUnverified !== false) {
        this.logger.warn(
          `Storing ${provider} prices for ${security.symbol} unverified: ` +
            (verdict.reason === "provider-silent"
              ? "the provider reported no trading currency"
              : "the security has no recorded currency"),
        );
      }
      return null;
    }
    const message = tr(
      "errors.securities.providerCurrencyMismatch",
      `Price update refused for ${security.symbol}: ${provider} quotes it in ${verdict.reported}, but the security is recorded in ${verdict.configured}. Correct the security's currency, symbol or exchange, then refresh.`,
      {
        symbol: security.symbol,
        provider,
        reported: verdict.reported,
        configured: verdict.configured,
      },
    );
    // The log is the operator's, in English; `message` is the reader's, in
    // the request's locale, and a translated line among English ones made the
    // server log read in whichever language the last caller used.
    this.logger.warn(
      `Price update refused for ${security.symbol}: ${provider} quotes it in ${verdict.reported}, but the security is recorded in ${verdict.configured}`,
    );
    return message;
  }

  /**
   * The fetch-time form of `refuseForeignCurrency`, asked of a whole
   * symbol/exchange group at once.
   *
   * A group is keyed on symbol and exchange, never on currency, so its members
   * can be recorded in different currencies and at most some of them are right
   * about any one provider answer. Judging the fetch on the representative
   * alone let one user's mis-recorded currency stop the fetch for every other
   * holder of that ticker: the whole group was marked failed although the
   * answer was storable for all but one of them. So the fetch passes the answer
   * on as soon as *one* member could store it, and the per-security check at
   * the write (the only refusal point that matters) decides who actually gets
   * it. Returns `null` to accept, or the refusal message when no member can.
   */
  private acceptedBySomeMember(
    group: readonly Security[],
    reported: string | null | undefined,
    provider: QuoteProviderName,
  ): string | null {
    const accepting = group.find(
      (member) =>
        verifyProviderCurrency(member.currencyCode, reported).accepted,
    );
    // Either way this delegates, so the unverified-storage warning and the
    // refusal message are written in exactly one place.
    return this.refuseForeignCurrency(
      accepting ?? group[0],
      reported,
      provider,
    );
  }

  private optsFor(
    provider: QuoteProvider,
    security: Security,
    ctx: UserContext,
  ) {
    return {
      instrumentId:
        provider.name === "msn"
          ? (security.msnInstrumentId ?? undefined)
          : undefined,
      currencyCode: security.currencyCode,
      preferredExchanges: ctx.preferredExchanges,
      quoteUrl:
        provider.name === "html_table"
          ? (security.quoteUrl ?? undefined)
          : undefined,
    };
  }

  /**
   * If the quote came back with a different SecId than the stored one
   * (because we upgraded a legacy FullInstrument), persist the upgrade.
   */
  private async persistMsnIdUpgrade(
    security: Security,
    upgradedId: string,
  ): Promise<void> {
    if (!upgradedId || upgradedId === security.msnInstrumentId) return;
    try {
      this.logger.log(
        `Persisting upgraded MSN instrumentId for ${security.symbol}: ${security.msnInstrumentId ?? "(none)"} → ${upgradedId}`,
      );
      security.msnInstrumentId = upgradedId;
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).update(security.id, {
          msnInstrumentId: upgradedId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist upgraded MSN id for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cache the instrument's trading session on the Security row, so the UI can
   * say whether its market is open right now without a provider round trip.
   *
   * Only written when it changes, which is almost never -- an exchange moves
   * its hours rarely, and the daylight-saving shift is already handled by
   * storing local times against a zone rather than fixed offsets.
   */
  private async persistMarketSession(
    security: Security,
    quote: QuoteResult,
  ): Promise<void> {
    const session = getMarketSessionFromQuote(quote);
    if (!session) return;
    if (
      session.timezone === security.marketTimezone &&
      session.openTime === security.marketOpenTime &&
      session.closeTime === security.marketCloseTime
    ) {
      return;
    }
    try {
      security.marketTimezone = session.timezone;
      security.marketOpenTime = session.openTime;
      security.marketCloseTime = session.closeTime;
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).update(security.id, {
          marketTimezone: session.timezone,
          marketOpenTime: session.openTime,
          marketCloseTime: session.closeTime,
        }),
      );
    } catch (err) {
      // A price refresh that worked must not fail over its metadata.
      this.logger.warn(
        `Failed to persist market session for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * After MSN resolves a SecId on behalf of a security, cache it on the
   * Security row so subsequent refreshes skip the autosuggest hop.
   */
  private async persistMsnInstrumentIdIfResolved(
    security: Security,
    providerName: QuoteProviderName,
    ctx: UserContext,
  ): Promise<void> {
    if (providerName !== "msn" || security.msnInstrumentId) return;
    const msn = this.providers.getByName("msn");
    if (!msn.resolveInstrumentId) return;
    try {
      const id = await msn.resolveInstrumentId(
        security.symbol,
        security.exchange,
        ctx.preferredExchanges,
      );
      if (id) {
        security.msnInstrumentId = id;
        await withScopedDb(this.dataSource, (m) =>
          m.getRepository(Security).update(security.id, {
            msnInstrumentId: id,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cache MSN instrument id for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Grouping ────────────────────────────────────────────────────────────

  /**
   * One fetch is made per group and its answer is written to every member, so
   * two securities may share a group only when they would ask the provider the
   * same question. A web page's address is part of that question: the symbol of
   * an `html_table` security is whatever its owner typed, so two users' "ACME"
   * on different pages must never be priced from one of the pages.
   */
  private groupKey(security: Security): string {
    return [
      security.symbol,
      security.exchange || "",
      security.quoteProvider || "",
      security.msnInstrumentId || "",
      security.quoteProvider === "html_table" ? (security.quoteUrl ?? "") : "",
    ].join("|");
  }

  /**
   * The active securities a deployment-wide pass reads, narrowed by `scope`.
   * The refresh and the settlement both select through here, so a scoped run
   * settles exactly the securities it refreshed. Callers apply
   * `isRefreshEligible` themselves.
   */
  private loadActiveSecurities(scope: SecurityPassScope): Promise<Security[]> {
    const where = scope.securityType
      ? { isActive: true, securityType: scope.securityType }
      : { isActive: true };
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({ where }),
    );
  }

  // ─── Refresh (current price) ─────────────────────────────────────────────

  /**
   * Refresh prices for EVERY user's active securities.
   *
   * Global by definition -- prices are keyed by symbol, not by owner, and one
   * fetch serves every holder -- so the system context belongs here rather than at
   * the call sites. It used to live only in the cron, which left the admin
   * maintenance endpoint reading `securities` in the requesting admin's own scope:
   * identical to global at RLS_MODE=off, and silently narrowed to "the admin's own
   * holdings" the moment enforcement is switched on. A maintenance operation whose
   * reach depends on which caller reached it is the trap; naming the scope in the
   * method closes it. A nested system context from the cron is the same identity,
   * so it joins rather than conflicting (see scoped-db's DR-01 check).
   *
   * `refreshPricesForSecurities` is the per-user counterpart: its controller
   * verifies ownership of every id before calling it.
   *
   * **Every eligible security is fetched, including ones already priced
   * today.** The closing run used to skip a security that had any
   * provider-written row for the day, on the reasoning that the row was the
   * quote it had just stored. It was not: the frontend auto-refreshes prices
   * through the trading session (`usePriceRefresh`), so on any day the user had
   * the app open there was already a row -- struck at 14:42, with a running
   * volume and a high that was only the highest so far -- and the closing job
   * skipped the one fetch that would have replaced it with the close. The
   * stored "close" was then whichever mid-session quote happened to be last,
   * for as long as that row existed. A duplicate fetch costs one request; the
   * skip cost a wrong closing price on every day the user watched the market.
   */
  async refreshAllPrices(
    scope: SecurityPassScope = {},
  ): Promise<PriceRefreshSummary> {
    return withSystemContext(() => this.refreshAllPricesGlobally(scope));
  }

  private async refreshAllPricesGlobally(
    scope: SecurityPassScope,
  ): Promise<PriceRefreshSummary> {
    const startTime = Date.now();
    this.logger.log(
      `Starting price refresh for ${describePassScope(scope)} securities`,
    );

    const allActive = await this.loadActiveSecurities(scope);
    const securities = allActive.filter((s) => isRefreshEligible(s));

    if (securities.length === 0) {
      return {
        totalSecurities: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
    }

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const key = this.groupKey(security);
      const group = symbolGroups.get(key) || [];
      group.push(security);
      symbolGroups.set(key, group);
    }

    const groups = [...symbolGroups.values()];
    const quotes = await mapWithConcurrency(
      groups,
      QUOTE_FETCH_CONCURRENCY,
      (group) => {
        const rep = group[0];
        const ctx = userContexts.get(rep.userId) || {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        };
        return this.fetchQuoteWithFallback(rep, ctx, group);
      },
    );

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const { quote, refusal } = quotes[i];

      if (!quote || quote.regularMarketPrice === undefined) {
        for (const security of group) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: refusal ?? "No price data available",
          });
          failed++;
        }
        continue;
      }

      // Cache the MSN instrument id on securities that had none resolved yet,
      // and persist any FullInstrument → SecId upgrade.
      if (quote.provider === "msn") {
        for (const security of group) {
          await this.persistMsnInstrumentIdIfResolved(
            security,
            "msn",
            userContexts.get(security.userId) || {
              defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
              preferredExchanges: [],
            },
          );
          if (quote.msnResolvedInstrumentId) {
            await this.persistMsnIdUpgrade(
              security,
              quote.msnResolvedInstrumentId,
            );
          }
        }
      }

      const tradingDate = formatDateYMD(getTradingDateFromQuote(quote));
      for (const security of group) {
        // Per security, although the quote was fetched once for the group: the
        // group is keyed on symbol and exchange, not on currency, so two users
        // holding the same ticker can have recorded it differently and only one
        // of them may be right about this answer.
        const mismatch = this.refuseForeignCurrency(
          security,
          quote.currencyCode,
          quote.provider ?? DEFAULT_QUOTE_PROVIDER,
          { warnUnverified: false },
        );
        if (mismatch) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: mismatch,
          });
          failed++;
          continue;
        }
        try {
          await this.savePriceData(security, tradingDate, quote);
          await this.persistMarketSession(security, quote);
          results.push({
            symbol: security.symbol,
            success: true,
            price: quote.regularMarketPrice,
            provider: quote.provider,
          });
          updated++;
        } catch (error) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Price refresh completed in ${duration}ms: ${updated} updated, ${failed} failed`,
    );

    return {
      totalSecurities: securities.length,
      updated,
      failed,
      skipped: 0,
      results,
      lastUpdated: new Date(),
    };
  }

  async refreshPricesForSecurities(
    securityIds: string[],
  ): Promise<PriceRefreshSummary> {
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { id: In(securityIds), isActive: true },
      }),
    );
    const eligible = securities.filter((s) => isRefreshEligible(s));
    const skipped = securities.length - eligible.length;
    if (skipped > 0) {
      const skippedSymbols = securities
        .filter((s) => !isRefreshEligible(s))
        .map((s) => s.symbol)
        .join(", ");
      this.logger.log(
        `Skipping ${skipped} security/securities with price updates disabled: ${skippedSymbols}`,
      );
    }
    securities.length = 0;
    securities.push(...eligible);

    if (securities.length === 0) {
      return {
        totalSecurities: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
    }

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    const quotes = await mapWithConcurrency(
      securities,
      QUOTE_FETCH_CONCURRENCY,
      (security) => {
        const ctx = userContexts.get(security.userId) || {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        };
        return this.fetchQuoteWithFallback(security, ctx);
      },
    );

    for (let i = 0; i < securities.length; i++) {
      const security = securities[i];
      const { quote, refusal } = quotes[i];

      if (!quote || quote.regularMarketPrice === undefined) {
        results.push({
          symbol: security.symbol,
          success: false,
          error: refusal ?? "No price data available",
        });
        failed++;
        continue;
      }

      if (quote.provider === "msn") {
        await this.persistMsnInstrumentIdIfResolved(
          security,
          "msn",
          userContexts.get(security.userId) || {
            defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
            preferredExchanges: [],
          },
        );
        if (quote.msnResolvedInstrumentId) {
          await this.persistMsnIdUpgrade(
            security,
            quote.msnResolvedInstrumentId,
          );
        }
      }

      try {
        const tradingDate = formatDateYMD(getTradingDateFromQuote(quote));
        await this.savePriceData(security, tradingDate, quote);
        await this.persistMarketSession(security, quote);
        results.push({
          symbol: security.symbol,
          success: true,
          price: quote.regularMarketPrice,
          provider: quote.provider,
        });
        updated++;
      } catch (error) {
        results.push({
          symbol: security.symbol,
          success: false,
          error: error.message,
        });
        failed++;
      }
    }

    return {
      totalSecurities: securities.length,
      updated,
      failed,
      skipped: 0,
      results,
      lastUpdated: new Date(),
    };
  }

  /**
   * Save price data to the database. Source is derived from the quote's
   * provider tag, defaulting to yahoo_finance for back-compat.
   */
  private async savePriceData(
    security: Security,
    priceDate: string,
    quote: QuoteResult,
  ): Promise<SecurityPrice> {
    const securityId = security.id;
    const source = sourceFor(quote.provider);
    // The instant the quote was struck, which `priceDate` cannot carry and
    // `createdAt` does not track: a same-day refresh updates the row in place,
    // leaving createdAt at whatever time the row was first written today.
    const quotedAt = quote.regularMarketTime
      ? new Date(quote.regularMarketTime * 1000)
      : null;

    // One statement, arbitrated by `UNIQUE(security_id, price_date)`. This used
    // to read the row, then in one branch save a mutated copy and in the other
    // insert a new one -- a check-then-act on a path the 5 PM ET cron runs on
    // every replica at once, so two processes routinely fetch the same quote for
    // the same security and day, both find no row, and both insert. The loser
    // got a unique violation and that security had no price for the day.
    //
    // `COALESCE(EXCLUDED.x, security_prices.x)` keeps the previous value where
    // the quote does not supply one, which is what the `?? existing.x` in the old
    // update branch meant -- except it now reads the stored value rather than a
    // copy fetched before another writer touched it.
    //
    // `adjusted_close` takes the close, under two conditions that the `CASE`
    // states in SQL so no caller can forget either:
    //
    //   1. A quote is always for the newest session, and the adjustment factor
    //      of the newest session is 1 -- nothing has gone ex after it yet. So
    //      "adjusted close = close" is not a guess here, it is the definition,
    //      and it is what the provider itself reports for its last bar. Without
    //      it today's row is the one row in the window carrying no adjusted
    //      close, and `loadPriceSeries` -- which keeps only the adjusted rows
    //      once any row has one -- drops today from every return series until
    //      the evening's settlement writes the official bar.
    //   2. Only where the series already holds an adjusted close. A provider
    //      that supplies none (MSN) leaves a series that is raw throughout,
    //      which is consistent and complete; adding a single adjusted row to it
    //      would flip `bool_or(adjusted_close IS NOT NULL)` to true and collapse
    //      that whole series to this one row. The `EXISTS` is what keeps a
    //      basis-completing write from becoming a basis-changing one.
    //
    // The settlement pass overwrites both with the provider's own numbers once
    // the session ends, so an inferred value survives at most until 5 PM.
    return withScopedDb(this.dataSource, async (m) => {
      const rows: unknown = await m.query(
        `INSERT INTO security_prices
           (security_id, price_date, open_price, high_price, low_price,
            close_price, adjusted_close, volume, source, quoted_at)
         SELECT $1::UUID, $2::DATE, $3::NUMERIC, $4::NUMERIC, $5::NUMERIC,
                $6::NUMERIC,
                CASE WHEN EXISTS (
                       SELECT 1 FROM security_prices adj
                        WHERE adj.security_id = $1::UUID
                          AND adj.adjusted_close IS NOT NULL
                     ) THEN $6::NUMERIC ELSE NULL END,
                $7::BIGINT, $8::VARCHAR, $9::TIMESTAMPTZ
          WHERE NOT EXISTS (${BOND_LINKED_SQL})
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price    = EXCLUDED.close_price,
           adjusted_close = EXCLUDED.adjusted_close,
           open_price  = COALESCE(EXCLUDED.open_price,  security_prices.open_price),
           high_price  = COALESCE(EXCLUDED.high_price,  security_prices.high_price),
           low_price   = COALESCE(EXCLUDED.low_price,   security_prices.low_price),
           volume      = COALESCE(EXCLUDED.volume,      security_prices.volume),
           source      = EXCLUDED.source,
           quoted_at   = COALESCE(EXCLUDED.quoted_at,   security_prices.quoted_at)
         WHERE ${PROVIDER_MAY_REPLACE_SQL}
         RETURNING id`,
        [
          securityId,
          priceDate,
          quote.regularMarketOpen ?? null,
          quote.regularMarketDayHigh ?? null,
          quote.regularMarketDayLow ?? null,
          quote.regularMarketPrice!,
          quote.regularMarketVolume ?? null,
          source,
          quotedAt,
        ],
      );

      const id = returnedRows<{ id: number }>(rows)[0]?.id;
      // No id means the `DO UPDATE` was refused, which happens for exactly one
      // reason: the stored row is a manual correction the user typed, and a
      // provider quote does not get to overwrite it. That is a successful
      // no-op, not a fault -- so read the row that won and return it. Only a
      // genuinely absent row after all that is an error.
      const saved = await (id
        ? m.getRepository(SecurityPrice).findOne({ where: { id } })
        : m
            .getRepository(SecurityPrice)
            .findOne({ where: { securityId, priceDate } }));
      if (!saved) {
        throw new Error(
          `Failed to persist price for security ${securityId} on ${priceDate}`,
        );
      }
      // A stored price changes what the portfolio is worth, so the memoized
      // valuation for this security's owner is dropped here rather than in each
      // of the refresh entry points -- the same argument `bulkUpsertPrices`
      // makes for holding its guard once instead of in four callers.
      invalidatePortfolioSummary(security.userId);
      return saved;
    });
  }

  // ─── Read helpers ────────────────────────────────────────────────────────

  async getLatestPrice(securityId: string): Promise<SecurityPrice | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { securityId },
        order: { priceDate: "DESC" },
      }),
    );
  }

  /**
   * Stored closes for one security, newest first.
   *
   * **`limit` truncates the oldest end, so a window is not a limit.** The rows
   * are ordered descending and `take(n)` keeps the first `n` of them, which
   * means a cap shorter than the history silently drops the beginning of it --
   * the opposite of what a caller asking for "the last five years" wants, and
   * invisible in the response because the array it gets back is a perfectly
   * well-formed shorter one. So a request that names a window gets the whole
   * window: `limit` defaults to `MAX_PRICE_HISTORY_ROWS` rather than to 365
   * whenever `startDate` is supplied, and the cap is then a memory bound rather
   * than a filter.
   *
   * A caller that supplies neither keeps the historical default.
   *
   * **Either bound counts as a window.** Keying this on `startDate` alone left
   * the trap open in the direction that matters most: "all time" is a request
   * with no start date, so a chart asking for the whole history sent only an
   * `endDate` and got the newest 365 rows back -- about one year, presented as
   * everything there is.
   */
  async getPriceHistory(
    securityId: string,
    startDate?: Date | string,
    endDate?: Date | string,
    limit?: number,
  ): Promise<SecurityPrice[]> {
    const effectiveLimit =
      limit ??
      (startDate || endDate
        ? MAX_PRICE_HISTORY_ROWS
        : DEFAULT_PRICE_HISTORY_ROWS);

    return withScopedDb(this.dataSource, (m) => {
      const query = m
        .getRepository(SecurityPrice)
        .createQueryBuilder("sp")
        .where("sp.securityId = :securityId", { securityId })
        .orderBy("sp.priceDate", "DESC")
        .take(effectiveLimit);

      if (startDate) {
        query.andWhere("sp.priceDate >= :startDate", { startDate });
      }

      if (endDate) {
        query.andWhere("sp.priceDate <= :endDate", { endDate });
      }

      return query.getMany();
    });
  }

  /**
   * Lookup a security via the user's configured provider(s). With provider
   * "auto" (the default), try the user's default provider first then fall back
   * to the other.
   */
  async lookupSecurity(
    userId: string,
    query: string,
    preferredExchanges?: string[],
    provider?: "yahoo" | "msn" | "auto",
  ): Promise<SecurityLookupResult | null> {
    const all = await this.lookupSecurityCandidates(
      userId,
      query,
      preferredExchanges,
      provider,
    );
    return all[0] || null;
  }

  /**
   * Return every plausible candidate for the query so the UI can show a
   * picker when more than one match exists.
   */
  async lookupSecurityCandidates(
    userId: string,
    query: string,
    preferredExchanges?: string[],
    provider?: "yahoo" | "msn" | "lse" | "deutsche_boerse" | "auto",
  ): Promise<SecurityLookupResult[]> {
    const contexts = await this.loadUserContexts([userId]);
    const ctx = contexts.get(userId) || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };
    const exchanges =
      preferredExchanges && preferredExchanges.length > 0
        ? preferredExchanges
        : ctx.preferredExchanges;

    const fetchFromProvider = async (
      p: QuoteProvider,
    ): Promise<SecurityLookupResult[]> => {
      try {
        if (p.lookupSecurityMany) {
          return await p.lookupSecurityMany(query, exchanges);
        }
        const single = await p.lookupSecurity(query, exchanges);
        return single ? [single] : [];
      } catch (err) {
        this.logger.warn(
          `${p.name} lookup failed for ${query}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    };

    if (provider && provider !== "auto") {
      return fetchFromProvider(this.providers.getByName(provider));
    }

    // auto: aggregate candidates from every provider, the user's default first,
    // so a security's own exchange surfaces alongside the ticker providers -- an
    // LSE line searched by its TIDM, a Börse Frankfurt line searched by ISIN --
    // and the user picks the listing they actually hold. Search is where the
    // exchange-specific providers earn their place; price refresh keeps the
    // narrower general-provider fallback (resolveForSecurity).
    const aggregated: SecurityLookupResult[] = [];
    const seen = new Set<string>();
    for (const p of orderProvidersByDefault(
      this.providers.listAll(),
      ctx.defaultQuoteProvider,
    )) {
      for (const result of await fetchFromProvider(p)) {
        const key = `${result.symbol}|${result.exchange ?? ""}`.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        aggregated.push(result);
      }
    }
    return aggregated;
  }

  /**
   * Fetch the instrument's authoritative trading currency from a live quote
   * (provider `meta.currency`, GBX-normalized to GBP). Used at security-create
   * time to correct the exchange-guessed currency from the lookup, which is
   * wrong for non-local-currency listings (e.g. a USD ETF on the LSE). Returns
   * null if no provider reports a currency, so callers keep their fallback.
   */
  async fetchAuthoritativeCurrency(
    userId: string,
    symbol: string,
    exchange: string | null,
  ): Promise<string | null> {
    const contexts = await this.loadUserContexts([userId]);
    const ctx = contexts.get(userId) || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };
    const ordered = orderProvidersByDefault(
      this.providers.listAll(),
      ctx.defaultQuoteProvider,
    );
    for (const p of ordered) {
      try {
        const quote = await p.fetchQuote(symbol, exchange);
        // Through the same normalization the acceptance check applies, so the
        // currency a security is created with is comparable -- letter for
        // letter -- with the one every later price answer is measured against.
        const currency = normalizeQuoteCurrency(quote?.currencyCode);
        if (currency) return currency;
      } catch (err) {
        this.logger.warn(
          `${p.name} currency lookup failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  /**
   * When a quote provider last wrote a price. A bond-engine row is written every
   * day by accrual, whatever the providers are doing, so it does not move this
   * marker: an outage of the quote providers must stay visible.
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { source: Not(BOND_ENGINE_PRICE_SOURCE) },
        order: { createdAt: "DESC" },
      }),
    );
    return latest?.createdAt ?? null;
  }

  // ─── Historical backfill ─────────────────────────────────────────────────

  private mergePrices(
    maxPrices: HistoricalPrice[],
    dailyPrices: HistoricalPrice[],
    oneYearAgo: Date,
  ): HistoricalPrice[] {
    const olderPrices = maxPrices.filter((p) => p.date < oneYearAgo);
    const merged = [...olderPrices, ...dailyPrices];

    const byDate = new Map<string, HistoricalPrice>();
    for (const p of merged) {
      byDate.set(p.date.toISOString().substring(0, 10), p);
    }

    return [...byDate.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  async backfillHistoricalPrices(
    range?: BackfillRange,
  ): Promise<HistoricalBackfillSummary> {
    const startTime = Date.now();
    this.logger.log("Starting historical price backfill");

    const earliestTxRows: Array<{ security_id: string; earliest: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT security_id, MIN(transaction_date)::TEXT as earliest
         FROM investment_transactions
         WHERE security_id IS NOT NULL
           AND status != 'VOID'
         GROUP BY security_id`,
        ),
      );
    const earliestTxDate = new Map(
      earliestTxRows.map((r) => [r.security_id, r.earliest]),
    );

    // Active securities, plus every security the user has ever held.
    //
    // `SecuritiesService.deactivate` refuses while any holding is non-zero, so
    // an INACTIVE security is by definition one that was bought, held, and sold
    // out completely -- and the days it was held are days the portfolio series
    // still has to value. Filtering this backfill by `isActive` meant the one
    // operation whose whole purpose is price HISTORY could never fill the
    // history of the position a reader is looking at, so its holding period
    // read as an unpriced gap forever (#1389). The daily quote refresh is a
    // different question and is deliberately left alone: today's quote for
    // something nobody holds buys nothing.
    const allSecurities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find(),
    );
    const securities = allSecurities.filter(
      (s) => (s.isActive || earliestTxDate.has(s.id)) && isRefreshEligible(s),
    );

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    const oneYearAgoStr = oneYearAgo.toISOString().substring(0, 10);

    const results: HistoricalBackfillResult[] = [];
    let successful = 0;
    let failed = 0;
    let totalPricesLoaded = 0;

    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const groupKey = this.groupKey(security);
      const group = symbolGroups.get(groupKey) || [];
      group.push(security);
      symbolGroups.set(groupKey, group);
    }

    for (const group of symbolGroups.values()) {
      const representative = group[0];
      const ctx = userContexts.get(representative.userId) || {
        defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
        preferredExchanges: [],
      };

      const groupEarliestDates = group
        .map((s) => earliestTxDate.get(s.id))
        .filter(Boolean) as string[];

      const needsOlderData =
        groupEarliestDates.length > 0 &&
        groupEarliestDates.some((d) => d < oneYearAgoStr);

      const dailyAttempt = await this.fetchHistoricalWithFallback(
        representative,
        range ?? "1y",
        ctx,
        group,
      );
      const daily = dailyAttempt.bundle;

      let maxBundle: HistoricalWithProvider | null = null;
      let maxRefusal: string | undefined;
      if (!range && needsOlderData) {
        const maxAttempt = await this.fetchHistoricalWithFallback(
          representative,
          "max",
          ctx,
          group,
        );
        maxBundle = maxAttempt.bundle;
        maxRefusal = maxAttempt.refusal;
      }

      if (!daily && !maxBundle) {
        const refusal = dailyAttempt.refusal ?? maxRefusal;
        for (const security of group) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: refusal ?? "No historical data available",
          });
          failed++;
        }
        continue;
      }

      const winner = daily || maxBundle!;
      if (winner.provider === "msn") {
        for (const security of group) {
          await this.persistMsnInstrumentIdIfResolved(
            security,
            "msn",
            userContexts.get(security.userId) || ctx,
          );
        }
      }

      let allPrices =
        maxBundle && daily
          ? this.mergePrices(maxBundle.prices, daily.prices, oneYearAgo)
          : (daily?.prices ?? maxBundle!.prices);

      const seen = new Set<string>();
      allPrices = allPrices.filter((p) => {
        const key = p.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const source = sourceFor(winner.provider);

      for (const security of group) {
        const secEarliest = earliestTxDate.get(security.id);
        // An explicit range asks for history as such, so nothing is clipped:
        // see `BackfillPricesQueryDto.range`. Without one, the window is the
        // *earlier* of a year ago and the first transaction -- never less than
        // a year, and as far back as the security has been held.
        const secCutoffStr = range
          ? null
          : secEarliest
            ? [oneYearAgoStr, secEarliest].sort()[0]
            : oneYearAgoStr;
        const prices = secCutoffStr
          ? allPrices.filter(
              (p) => p.date >= new Date(`${secCutoffStr}T00:00:00Z`),
            )
          : allPrices;

        if (prices.length === 0) {
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: 0,
            provider: winner.provider,
          });
          successful++;
          continue;
        }

        // The series was fetched for the representative; this security only
        // shares its symbol and exchange, not necessarily its currency.
        const mismatch = this.refuseForeignCurrency(
          security,
          winner.currencyCode,
          winner.provider,
          { warnUnverified: false },
        );
        if (mismatch) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: mismatch,
          });
          failed++;
          continue;
        }

        try {
          await this.bulkUpsertPrices(security, prices, source);

          this.logger.log(
            `Backfilled ${prices.length} prices for ${security.symbol} via ${winner.provider} ` +
              `(${secCutoffStr ? `from ${secCutoffStr}` : `full ${range} range`})`,
          );
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: prices.length,
            provider: winner.provider,
          });
          successful++;
          totalPricesLoaded += prices.length;
        } catch (error) {
          this.logger.error(
            `Failed to save historical prices for ${security.symbol}: ${error.message}`,
          );
          results.push({
            symbol: security.symbol,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Historical backfill completed in ${duration}ms: ${successful} successful, ${failed} failed, ${totalPricesLoaded} total prices`,
    );

    return {
      totalSecurities: securities.length,
      successful,
      failed,
      totalPricesLoaded,
      results,
    };
  }

  /**
   * Bulk upsert historical prices via raw SQL. Accepts the source tag so
   * MSN-sourced data can be stored with source='msn_finance'.
   */
  private async bulkUpsertPrices(
    security: Security,
    prices: HistoricalPrice[],
    source: string,
  ): Promise<void> {
    const securityId = security.id;
    // Before anything is written, and over the whole payload rather than per
    // batch: a provider asked for a long range may answer with weekly or
    // monthly bars, and stored into a daily table those rows are
    // indistinguishable from daily ones -- while overwriting the real daily
    // rows that sat on those dates. `market_index_prices` has refused this
    // since it was written; `security_prices` did not, and a monthly series
    // spliced through six years of daily history is what that cost.
    //
    // Here rather than in each caller because there are four of them (the
    // catalog backfill, the per-security backfill, the holding-period
    // backfill, and settlement) and a guard one of them forgets is not a
    // guard. Every caller already wraps this in a try/catch that reports the
    // failure, so the throw surfaces as "this security did not update" rather
    // than as a crash.
    assertDailySeries(
      securityId,
      prices.map((p) => p.date),
    );

    const batchSize = 500;
    for (let i = 0; i < prices.length; i += batchSize) {
      const batch = prices.slice(i, i + batchSize);
      // Typed so the rows can be a subquery (a bare VALUES list types a
      // parameter as text), which is what lets the link predicate gate them.
      const values = batch
        .map((_, idx) => {
          const offset = idx * 9;
          return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}::NUMERIC, $${offset + 4}::NUMERIC, $${offset + 5}::NUMERIC, $${offset + 6}::NUMERIC, $${offset + 7}::NUMERIC, $${offset + 8}::BIGINT, $${offset + 9}::VARCHAR)`;
        })
        .join(", ");

      const params: any[] = [];
      for (const p of batch) {
        params.push(
          securityId,
          // As a `YYYY-MM-DD` string rather than a `Date`: the driver
          // serialises a Date with the *server's* offset, so which day a bar
          // lands on would depend on where the container runs. The Date is
          // already UTC midnight of the exchange's calendar day (`barDate`).
          formatDateYMD(p.date),
          p.open,
          p.high,
          p.low,
          p.close,
          p.adjClose,
          p.volume,
          source,
        );
      }

      // Only overwrite adjusted_close on conflict when the new payload has a
      // non-null value, so providers without adjclose support (MSN today)
      // don't blow away a previously-stored Yahoo value.
      //
      // `quoted_at` is cleared because the row no longer holds a quote: a daily
      // bar is a whole session, not an instant, and leaving the timestamp of the
      // 14:42 quote these numbers just replaced would describe the row as
      // something it is not. The column's contract already says so -- NULL for
      // rows that are not a struck quote.
      //
      // A `manual` row is a correction the user typed, and a `bond_engine` row
      // is a linked security's own price, so the provider overwrites neither;
      // and a security linked since the list was loaded gets no row at all.
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO security_prices (security_id, price_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source)
         SELECT v.* FROM (VALUES ${values}) AS v
          WHERE NOT EXISTS (${BOND_LINKED_SQL})
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price = EXCLUDED.open_price,
           high_price = EXCLUDED.high_price,
           low_price = EXCLUDED.low_price,
           adjusted_close = COALESCE(EXCLUDED.adjusted_close, security_prices.adjusted_close),
           volume = EXCLUDED.volume,
           source = EXCLUDED.source,
           quoted_at = NULL
         WHERE ${PROVIDER_MAY_REPLACE_SQL}`,
          params,
        ),
      );
    }
    // Every historical write path (catalog backfill, per-security backfill,
    // holding-period backfill, settlement) ends here, so the owner's memoized
    // valuation is forgotten here too.
    invalidatePortfolioSummary(security.userId);
  }

  // ─── Daily settlement ────────────────────────────────────────────────────

  /**
   * Replace the day's provisional quotes with the provider's official daily
   * bars, for every session that has ended.
   *
   * A quote and a daily bar are different claims, and only one of them is the
   * thing `security_prices` is supposed to hold. `regularMarketPrice` is the
   * last print at the moment it was asked for; the daily bar is the session --
   * its official close, its full-day volume, its high and low over the whole
   * session, and its **adjusted close**, which no quote carries at all. Storing
   * quotes and never coming back for the bar is what left `adjusted_close`
   * empty on every row the closing job wrote, and left a close that was only
   * the last quote of whatever minute the user last looked at the app.
   *
   * Re-running over a window rather than only the current day is deliberate: it
   * repairs whatever the previous runs got wrong (a day the job did not fire, a
   * provider outage, a row written intraday and never settled) without anyone
   * having to notice and ask. A bar whose session is still open is left alone,
   * because settling it would store the same half-day the quote already did.
   */
  async settleDailyBars(
    scope: SecurityPassScope = {},
  ): Promise<DailySettlementSummary> {
    return withSystemContext(() => this.settleDailyBarsGlobally(scope));
  }

  private async settleDailyBarsGlobally(
    scope: SecurityPassScope,
  ): Promise<DailySettlementSummary> {
    const startTime = Date.now();
    const now = new Date();

    const allActive = await this.loadActiveSecurities(scope);
    const securities = allActive.filter((s) => isRefreshEligible(s));
    if (securities.length === 0) {
      return {
        totalSecurities: 0,
        securitiesSettled: 0,
        barsSettled: 0,
        failed: 0,
      };
    }

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const key = this.groupKey(security);
      symbolGroups.set(key, [...(symbolGroups.get(key) ?? []), security]);
    }

    const groups = [...symbolGroups.values()];
    const bundles = await mapWithConcurrency(
      groups,
      QUOTE_FETCH_CONCURRENCY,
      (group) => {
        const rep = group[0];
        const ctx = userContexts.get(rep.userId) || {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        };
        return this.fetchHistoricalWithFallback(
          rep,
          SETTLEMENT_RANGE,
          ctx,
          group,
        );
      },
    );

    let securitiesSettled = 0;
    let barsSettled = 0;
    let failed = 0;

    for (const [i, group] of groups.entries()) {
      const bundle = bundles[i].bundle;
      if (!bundle || bundle.prices.length === 0) {
        failed += group.length;
        continue;
      }
      const source = sourceFor(bundle.provider);

      for (const security of group) {
        // Settlement writes the official bars over the day's quotes, so it is
        // a price write like any other and faces the same check -- per
        // security, because the group shares a symbol rather than a currency.
        if (
          this.refuseForeignCurrency(
            security,
            bundle.currencyCode,
            bundle.provider,
            { warnUnverified: false },
          )
        ) {
          failed++;
          continue;
        }
        // Per security rather than per group: the session lives on the row, and
        // a symbol nothing has quoted yet has none, which is a different answer
        // from a symbol whose exchange is known.
        const settled = bundle.prices.filter((p) =>
          isSessionSettled(formatDateYMD(p.date), security, now),
        );
        if (settled.length === 0) continue;

        try {
          await this.bulkUpsertPrices(security, settled, source);
          securitiesSettled++;
          barsSettled += settled.length;
        } catch (error) {
          this.logger.error(
            `Failed to settle daily bars for ${security.symbol}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          failed++;
        }
      }
    }

    this.logger.log(
      `Daily settlement completed in ${Date.now() - startTime}ms: ` +
        `${barsSettled} bars over ${securitiesSettled} securities, ${failed} failed`,
    );

    return {
      totalSecurities: securities.length,
      securitiesSettled,
      barsSettled,
      failed,
    };
  }

  /**
   * The closing job: every active security, after the US close on a weekday.
   */
  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledPriceRefresh(): Promise<void> {
    await this.runScheduledPriceRefresh({});
  }

  /**
   * The weekend tick, for cryptocurrency only. A coin trades every day and its
   * Yahoo session is the UTC day, still open at 17:00 New York, so each run
   * settles the previous UTC day's bar and stores the current day's quote as
   * provisional: Saturday's run settles Friday, Sunday's settles Saturday, and
   * Monday's weekday run settles Sunday. Without it all three waited for
   * Monday, and no cron stored a weekend quote. Every other security is closed
   * and is left alone: asking for it would only spend quota on a bar that
   * cannot have changed.
   */
  @Cron("0 17 * * 0,6", { timeZone: "America/New_York" })
  async scheduledWeekendCryptoRefresh(): Promise<void> {
    await this.runScheduledPriceRefresh({ securityType: "CRYPTO" });
  }

  /** The body both closing crons share, over the securities `scope` selects. */
  private async runScheduledPriceRefresh(
    scope: SecurityPassScope,
  ): Promise<void> {
    this.logger.log(
      `Running scheduled price refresh for ${describePassScope(scope)} securities`,
    );
    try {
      // RLS (task C2): the price refresh groups securities across users by
      // symbol (irreducibly cross-user), and the snapshot recalc fans out over
      // every investment account, so the whole job runs under a system context.
      // One replica per tick calls the provider (task C2). The price upserts are
      // idempotent, so this is a cost control: N replicas is N times the quota
      // and N chances to trip the breaker on a provider that is merely slow.
      // The settlement and the snapshot recalc ride inside the lease because
      // they are what this run's fetch is for.
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.SecurityPrices,
          this.FETCH_LEASE_MS,
          async () => {
            const result = await this.refreshAllPrices(scope);
            // Settlement runs *after* the quote refresh, and its writes are the
            // ones that survive: the quote is what the security is worth right now
            // (and is all a still-open market can offer), the bar is what the
            // finished session actually did. Ordering them the other way round
            // would leave the day holding a 17:00 quote again.
            const settlement = await this.settleDailyBars(scope);
            if (result.updated > 0 || settlement.barsSettled > 0) {
              this.logger.log(
                "Recalculating investment snapshots after price refresh",
              );
              await this.netWorthService.recalculateAllInvestmentSnapshots();
            }
          },
        ),
      );
    } catch (error) {
      this.logger.error(`Scheduled price refresh failed: ${error.message}`);
    }
  }

  /**
   * Backfill 1 year of daily prices for a single security. Called when a
   * security is newly created (manually or via import). Honors per-security
   * provider override + user default + preferredExchanges.
   */
  async backfillSecurity(security: Security): Promise<void> {
    // Registered rather than merely started. `SecuritiesService.create` does
    // not await this, so without a record of it the write is invisible to
    // anything that needs the database to be quiet.
    await trackPriceWrite(this.backfillSecurityRange(security, "1y"));
  }

  /**
   * Backfill historical prices for a single security over a configurable
   * range ("1y", "5y", "10y", "max", etc.). Returns the number of price rows
   * upserted. Used by callers that need deeper history than the daily-1y
   * default (e.g. Monte Carlo's per-holding stats).
   */
  async backfillSecurityRange(
    security: Security,
    range: string,
    opts: { force?: boolean } = {},
  ): Promise<number> {
    try {
      return await this.fetchAndStoreRange(security, range, opts);
    } catch (error) {
      this.logger.error(
        `Failed to upsert backfilled prices for ${security.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * The body of `backfillSecurityRange`, which **throws** instead of reporting
   * zero.
   *
   * The two exist separately because zero rows and a refused payload are
   * different facts, and only one caller can act on the difference. The
   * background callers (Monte Carlo, GEM, the comparison chart) are enriching a
   * report and want a number; a user who explicitly asked for ten years of
   * history needs to be told *why* they got nothing -- "the provider answered
   * with monthly bars" is a different problem from "the symbol has no data",
   * and a swallowed error makes them the same non-answer.
   *
   * @param opts.force Ignore `skipPriceUpdates`. Imports set that flag on
   *   securities whose symbol was auto-generated, so it is exactly the set a
   *   user is most likely to be correcting by hand.
   */
  private async fetchAndStoreRange(
    security: Security,
    range: string,
    opts: { force?: boolean } = {},
  ): Promise<number> {
    // A forced backfill ignores skipPriceUpdates, never the bond link.
    if (!isPricedByQuoteProvider(security)) return 0;
    if (security.skipPriceUpdates && !opts.force) return 0;

    const [ctx] =
      (await this.loadUserContexts([security.userId])).values() || [];
    const userCtx = ctx || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };

    const { bundle, refusal } = await this.fetchHistoricalWithFallback(
      security,
      range,
      userCtx,
    );
    // A refused series is a reported fault, not an absence: this method throws
    // so the user who asked for the history is told why they got none, while
    // `backfillSecurityRange` keeps turning it into a zero for the background
    // callers that only want a count.
    if (refusal) throw new Error(refusal);
    if (!bundle || bundle.prices.length === 0) {
      this.logger.warn(`No historical prices available for ${security.symbol}`);
      return 0;
    }

    if (bundle.provider === "msn") {
      await this.persistMsnInstrumentIdIfResolved(security, "msn", userCtx);
    }

    await this.bulkUpsertPrices(
      security,
      bundle.prices,
      sourceFor(bundle.provider),
    );
    this.logger.log(
      `Backfilled ${bundle.prices.length} ${range} prices for ${security.symbol} via ${bundle.provider}`,
    );
    return bundle.prices.length;
  }

  /**
   * Make sure `security_prices` can price each security at `date`, fetching
   * from the provider the ones it cannot.
   *
   * The counterpart to `ExchangeRateService.ensureRatesForDate`, and the same
   * problem: the daily refresh writes today, `backfillSecurity` fetches a year
   * from the day the security was created, and nothing ever goes back further
   * on its own -- so a point-in-time report asked about 2017 finds no close
   * within the boundary window, reports the position unpriced, and the
   * account's market value is null. That is the report being honest about an
   * absence, not a number to guess at; the absence is what this closes.
   *
   * **The unit is a calendar month** (`monthFetchWindow`), for the reason given
   * there: one provider call covers the whole month, so the other days in it
   * are database reads.
   *
   * Provider order is the user's own (`resolveForSecurity`), and a provider
   * whose chart API takes only a named timeframe -- MSN -- gets the narrowest
   * range that reaches `date` instead of a window. That range is anchored at
   * today, so it returns more than the month asked for; all of it is stored,
   * because throwing away bars already downloaded to honour a window nobody
   * needs enforced would be the more expensive choice.
   *
   * Best-effort by construction, exactly as the rate fill is: this runs inside
   * a read, so a provider that is down, rate-limited or has no history for a
   * symbol leaves the report where it already was -- the position unpriced and
   * the total null -- rather than failing the request. Nothing here invents a
   * price.
   *
   * `skipPriceUpdates` is honoured (via `isRefreshEligible`): the user turned
   * updates off for the security, or an import that auto-generated a symbol
   * marked it precisely because fetching against it is pointless.
   *
   * Returns the number of daily bars persisted.
   */
  async ensurePricesForDate(
    securityIds: string[],
    date: string,
  ): Promise<number> {
    const month = date.slice(0, 7);
    const due = [...new Set(securityIds)].filter(
      (id) => !this.emptyPriceWindows.has(id, month),
    );
    if (due.length === 0) return 0;

    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({ where: { id: In(due) } }),
    );
    const eligible = securities.filter((s) => isRefreshEligible(s));
    if (eligible.length === 0) return 0;

    const contexts = await this.loadUserContexts(eligible.map((s) => s.userId));
    const [start, end] = monthFetchWindow(date);
    // A report can hold dozens of securities and this runs inside a request, so
    // the fill is bounded by wall clock rather than by a count: whatever is not
    // reached stays unpriced, which is a state the report already renders. The
    // remainder is named in the log rather than dropped quietly -- a fill that
    // silently covers half the portfolio reads as a fill that covered it.
    const deadline = Date.now() + PRICE_FILL_BUDGET_MS;
    let unattempted = 0;

    this.logger.log(
      `Filling ${eligible.length} securities' prices over ${start} to ${end}`,
    );

    const loaded = await mapWithConcurrency(
      eligible,
      QUOTE_FETCH_CONCURRENCY,
      async (security) => {
        if (Date.now() > deadline) {
          unattempted += 1;
          return 0;
        }
        try {
          // `answered` is the fill's own report of whether a provider replied
          // at all, which is the only precise version of the question: it knows
          // which providers this security routes to and which of them it
          // actually reached. Asking the breakers instead was either too narrow
          // (Yahoo only, while the fill falls back to MSN) or too broad (any
          // provider down anywhere disables the cache for everyone).
          const { stored, answered } = await this.fillPriceWindow(
            security,
            contexts.get(security.userId),
            start,
            end,
            date,
          );
          if (stored === 0 && answered) {
            // No history for this symbol in this era -- an instrument that did
            // not trade yet, or one the provider does not carry. Note it, so a
            // report reloaded on the same date does not re-ask.
            //
            // Only when a provider actually answered: a refusal and a transport
            // failure produce the same zero, and this memory holds for 30
            // minutes across every security in the report -- so caching one
            // would leave a whole portfolio unpriced long after a two-minute
            // outage ended.
            this.emptyPriceWindows.remember(security.id, month);
            this.logger.warn(
              `No historical prices available for ${security.symbol} over ${start} to ${end}`,
            );
          }
          return stored;
        } catch (error) {
          this.logger.warn(
            `Historical price fill for ${security.symbol} over ${start} to ${end} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return 0;
        }
      },
    );

    if (unattempted > 0) {
      this.logger.warn(
        `Price fill for ${date} ran out of time with ${unattempted} of ${eligible.length} securities unattempted; they stay unpriced for this report`,
      );
    }

    return loaded.reduce((sum, count) => sum + count, 0);
  }

  /**
   * One security, one month, through whichever provider answers first.
   *
   * The window path and the range path both hand their whole payload to
   * `bulkUpsertPrices`, which is where the daily-granularity check lives -- a
   * provider that answers a long range with weekly or monthly bars is refused
   * there rather than spliced through the daily table.
   */
  private async fillPriceWindow(
    security: Security,
    ctx: UserContext | undefined,
    start: string,
    end: string,
    date: string,
  ): Promise<{ stored: number; answered: boolean }> {
    const userCtx = ctx || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };
    const fromDate = new Date(`${start}T00:00:00.000Z`);
    const toDate = new Date(`${end}T23:59:59.999Z`);
    // Whether any provider gave an answer, as opposed to failing or being
    // refused by its breaker -- and whether EVERY routed provider did. A month
    // is "empty" only when all of them were heard from: one answering [] for a
    // window it lacks says nothing while the next one failed (A26-L20).
    let answered = false;
    let allAnswered = true;

    for (const provider of this.providers.resolveForSecurity(
      security,
      userCtx.defaultQuoteProvider,
    )) {
      const opts = this.optsFor(provider, security, userCtx);
      let series: HistoricalSeries | null;
      try {
        series = provider.fetchHistoricalWindowSeries
          ? await provider.fetchHistoricalWindowSeries(
              security.symbol,
              security.exchange,
              fromDate,
              toDate,
              opts,
            )
          : await provider.fetchHistoricalSeries(
              security.symbol,
              security.exchange,
              rangeReaching(date),
              opts,
            );
      } catch (err) {
        this.logger.warn(
          `${provider.name} historical fill failed for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
        allAnswered = false;
        continue;
      }
      // `[]` is an answer -- the provider has no bars in this window -- while
      // `null` is no answer at all. The difference is what decides whether the
      // caller may remember the window as empty, so it is tracked rather than
      // collapsed into "nothing came back".
      if (series !== null) answered = true;
      else allAnswered = false;
      if (!series || series.prices.length === 0) continue;

      // This path reaches `bulkUpsertPrices` without going through either
      // fallback helper, so it is an acceptance point of its own and makes the
      // same comparison. A refused provider gives this security's next one its
      // turn; the fill stays best-effort and stores nothing it cannot vouch for.
      if (
        this.refuseForeignCurrency(security, series.currencyCode, provider.name)
      ) {
        // Bars about another listing are not "no bars": not an empty month.
        allAnswered = false;
        continue;
      }

      await this.bulkUpsertPrices(
        security,
        series.prices,
        sourceFor(provider.name),
      );
      this.logger.log(
        `Filled ${series.prices.length} prices for ${security.symbol} around ${date} via ${provider.name}`,
      );
      return { stored: series.prices.length, answered: true };
    }

    return { stored: 0, answered: answered && allAnswered };
  }

  /**
   * Force-refresh historical prices for a single security across the full
   * period the user has held it (earliest investment transaction through the
   * latest available price), overwriting any existing rows. Unlike the
   * scheduled backfill this bypasses the skipPriceUpdates eligibility check:
   * the user has explicitly requested the update, and imports flag securities
   * with skipPriceUpdates=true, so this is how a user opts a single corrected
   * symbol back in. Scoped by userId for multi-tenancy.
   */
  async backfillSecurityHoldingPeriod(
    userId: string,
    securityId: string,
    range?: BackfillRange,
  ): Promise<HistoricalBackfillResult> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { id: securityId, userId },
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundBySecurityId",
          `Security ${securityId} not found`,
          { securityId },
        ),
      );
    }

    // The user asked for it explicitly, so say why nothing will be fetched.
    if (!isPricedByQuoteProvider(security)) {
      return {
        symbol: security.symbol,
        success: false,
        error: tr(
          "errors.securities.bondPricedByEngine",
          "This security is linked to a bond instrument and is priced by the bond engine, not by a quote provider. Use Recompute prices instead.",
        ),
      };
    }

    const ctx = (await this.loadUserContexts([userId])).get(userId) ?? {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };

    // An explicit range is a request for history as such, so it takes the
    // whole payload: fetch that range and store all of it. The clip below
    // exists to avoid hoarding prices from before the user owned anything,
    // which is right for a position valuation and wrong for every calculation
    // that needs a return series longer than the holding.
    if (range) {
      try {
        const loaded = await this.fetchAndStoreRange(security, range, {
          force: true,
        });
        return { symbol: security.symbol, success: true, pricesLoaded: loaded };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to backfill ${range} of prices for ${security.symbol}: ${message}`,
        );
        return { symbol: security.symbol, success: false, error: message };
      }
    }

    // Earliest date the user has held the security. Null when there are no
    // transactions yet (e.g. a watchlist-only security) -- fall back to 1y.
    const earliestRows: Array<{ earliest: string | null }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(transaction_date)::TEXT as earliest
         FROM investment_transactions
         WHERE security_id = $1
           AND status != 'VOID'`,
          [securityId],
        ),
    );
    const earliestTx = earliestRows[0]?.earliest ?? null;

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    const oneYearAgoStr = oneYearAgo.toISOString().substring(0, 10);

    const needsOlderData = !!earliestTx && earliestTx < oneYearAgoStr;

    const dailyAttempt = await this.fetchHistoricalWithFallback(
      security,
      "1y",
      ctx,
    );
    const maxAttempt = needsOlderData
      ? await this.fetchHistoricalWithFallback(security, "max", ctx)
      : null;
    const daily = dailyAttempt.bundle;
    const maxBundle = maxAttempt?.bundle ?? null;

    if (!daily && !maxBundle) {
      return {
        symbol: security.symbol,
        success: false,
        error:
          dailyAttempt.refusal ??
          maxAttempt?.refusal ??
          "No historical data available",
      };
    }

    const winner = daily || maxBundle!;
    if (winner.provider === "msn") {
      await this.persistMsnInstrumentIdIfResolved(security, "msn", ctx);
    }

    let allPrices =
      maxBundle && daily
        ? this.mergePrices(maxBundle.prices, daily.prices, oneYearAgo)
        : (daily?.prices ?? maxBundle!.prices);

    const seen = new Set<string>();
    allPrices = allPrices.filter((p) => {
      const key = p.date.toISOString().substring(0, 10);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Clip to the holding period: from the first transaction date (or 1y ago
    // when the security has never been transacted) through the latest price.
    // Never later than 1y ago, though -- a security bought last month is a
    // holding period the user can already see on the register; what a force
    // update exists to fill in is the price *history* behind it, and clipping
    // to the purchase date threw away the 1y of daily bars already fetched
    // above for exactly this security.
    const cutoffStr =
      earliestTx && earliestTx < oneYearAgoStr ? earliestTx : oneYearAgoStr;
    // UTC midnight, matching the UTC-midnight dates `barDate` produces. The
    // old `setHours(0, 0, 0, 0)` made this local midnight, so the cutoff moved
    // by a day depending on where the container runs.
    const cutoff = new Date(`${cutoffStr}T00:00:00Z`);
    const prices = allPrices.filter((p) => p.date >= cutoff);

    if (prices.length === 0) {
      return {
        symbol: security.symbol,
        success: true,
        pricesLoaded: 0,
        provider: winner.provider,
      };
    }

    const source = sourceFor(winner.provider);
    try {
      await this.bulkUpsertPrices(security, prices, source);
    } catch (error) {
      this.logger.error(
        `Failed to force-backfill prices for ${security.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        symbol: security.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.logger.log(
      `Force-backfilled ${prices.length} prices for ${security.symbol} via ${winner.provider} (from ${cutoffStr})`,
    );

    return {
      symbol: security.symbol,
      success: true,
      pricesLoaded: prices.length,
      provider: winner.provider,
    };
  }

  /**
   * Upsert a transaction-derived price for a security on a given date.
   * Computes average price from all price-relevant transactions on that date.
   * Never overwrites provider-sourced (yahoo_finance, msn_finance) or manual
   * prices or bond-engine prices — the ON CONFLICT WHERE clause restricts
   * updates to rows whose existing source is itself a transaction action (the
   * engine's value of a linked security replaces a trade price of its day, never
   * the reverse).
   */
  async upsertTransactionPrice(
    securityId: string,
    transactionDate: string,
  ): Promise<void> {
    return trackPriceWrite(
      this.upsertTransactionPriceInner(securityId, transactionDate),
    );
  }

  private async upsertTransactionPriceInner(
    securityId: string,
    transactionDate: string,
  ): Promise<void> {
    // Only actual trades (BUY/SELL/REINVEST) imply a market price. TRANSFER_IN/
    // TRANSFER_OUT legs carry the carried cost basis, not the market price on
    // the transfer date, so they are excluded from the derived price.
    const rows: Array<{
      avg_price: string;
      latest_action: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT AVG(price::numeric) as avg_price,
              (SELECT action FROM investment_transactions
               WHERE security_id = $1 AND transaction_date = $2
                 AND action = ANY($3)
                 AND price IS NOT NULL
                 AND status != 'VOID'
               ORDER BY created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions
       WHERE security_id = $1
         AND transaction_date = $2
         AND action = ANY($3)
         AND price IS NOT NULL
         AND status != 'VOID'`,
        [securityId, transactionDate, MARKET_PRICED_TRADE_ACTIONS],
      ),
    );

    const avgPrice = rows[0]?.avg_price
      ? Math.round(Number(rows[0].avg_price) * 1000000) / 1000000
      : null;
    const latestAction = rows[0]?.latest_action;

    if (avgPrice === null || latestAction === null) {
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `DELETE FROM security_prices
         WHERE security_id = $1 AND price_date = $2
           AND source = ANY($3)`,
          [securityId, transactionDate, TRANSACTION_SOURCES],
        ),
      );
      return;
    }

    const source = latestAction.toLowerCase();

    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (security_id, price_date)
       DO UPDATE SET close_price = $3, source = $4
       WHERE security_prices.source = ANY($5)`,
        [securityId, transactionDate, avgPrice, source, TRANSACTION_SOURCES],
      ),
    );
  }

  async backfillTransactionPrices(): Promise<{
    processed: number;
    created: number;
    skipped: number;
  }> {
    this.logger.log("Starting transaction price backfill");

    const pairs: Array<{
      security_id: string;
      transaction_date: string;
      avg_price: string;
      latest_action: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT it.security_id, it.transaction_date,
              AVG(it.price::numeric) as avg_price,
              (SELECT it2.action FROM investment_transactions it2
               WHERE it2.security_id = it.security_id
                 AND it2.transaction_date = it.transaction_date
                 AND it2.action = ANY($1)
                 AND it2.price IS NOT NULL
                 AND it2.status != 'VOID'
               ORDER BY it2.created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions it
       WHERE it.security_id IS NOT NULL
         AND it.price IS NOT NULL
         AND it.action = ANY($1)
         AND it.status != 'VOID'
       GROUP BY it.security_id, it.transaction_date`,
        [MARKET_PRICED_TRADE_ACTIONS],
      ),
    );

    let created = 0;
    const batchSize = 500;

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const values = batch
        .map((_, idx) => {
          const offset = idx * 4;
          return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}, $${offset + 4})`;
        })
        .join(", ");

      const params: any[] = [];
      for (const pair of batch) {
        const price = Math.round(Number(pair.avg_price) * 1000000) / 1000000;
        params.push(
          pair.security_id,
          pair.transaction_date,
          price,
          pair.latest_action.toLowerCase(),
        );
      }

      const result = await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ${values}
         ON CONFLICT (security_id, price_date)
         DO UPDATE SET close_price = EXCLUDED.close_price, source = EXCLUDED.source
         WHERE security_prices.source = ANY($${params.length + 1})`,
          [...params, TRANSACTION_SOURCES],
        ),
      );

      const affected = Array.isArray(result)
        ? result.length
        : (result?.rowCount ?? 0);
      created += affected;
    }

    const skipped = pairs.length - created;

    this.logger.log(
      `Transaction price backfill completed: ${pairs.length} processed, ${created} created/updated, ${skipped} skipped`,
    );

    // A maintenance pass over every user's transaction-derived prices; there is
    // no single owner to invalidate, so the whole memo goes.
    if (created > 0) invalidateAllPortfolioSummaries();

    return { processed: pairs.length, created, skipped };
  }

  /**
   * A manual price create/update/delete changes the accepted close for a
   * security, so every `monthly_account_balances` snapshot for an account
   * holding it now carries a stale `market_value`. This is the shared
   * invalidation path (#1242): before it, provider refresh and backfill
   * recomputed snapshots but the HTTP manual-price routes did not, so a
   * corrected price left the charts stale.
   *
   * Invalidation is recovered from the data, not just debounced.
   * `sweepStaleSnapshots` recovers a lost recompute by finding accounts whose
   * `updated_at` is newer than their snapshots -- but that only works if the
   * mutation advances `accounts.updated_at`. A manual price moves no balance,
   * so nothing touched the account row and the sweep had no signal: a crash
   * between the price commit and the two-second debounce timer left the
   * snapshot stale (review MZ-1242-R2). So this runs **inside the same
   * transaction as the price write**, advancing `updated_at` on every holding
   * account atomically with the price change -- the same marker an
   * investment-transaction edit leaves via its balance write. The security is
   * per-user, so every holder is an account of the same `userId`.
   *
   * The marker's one residual window, and the account row lock that narrows it
   * (`lockAccountsForBalanceWrite`, taken inside the helper), are explained on
   * `markHoldingAccountsDirty` in `holding-accounts-dirty.util.ts`.
   *
   * Returns the affected account ids so the caller can, after commit, schedule
   * the debounced recompute as a latency optimization on top of the marker.
   * The statement itself is `markHoldingAccountsDirty`
   * (`holding-accounts-dirty.util.ts`), shared with the bond-engine price writer.
   */
  private async markHoldingAccountsDirty(
    manager: EntityManager,
    securityId: string,
    userId: string,
  ): Promise<string[]> {
    return markHoldingAccountsDirty(manager, securityId, userId);
  }

  /**
   * Schedule the debounced net-worth recompute for the given accounts, after
   * the `updated_at` marker has committed. Best-effort latency optimization: a
   * timer lost to a crash is recovered by `sweepStaleSnapshots` off the
   * `updated_at` marker `markHoldingAccountsDirty` wrote (subject to the
   * residual transaction-start-timestamp window documented there). Runs in the
   * caller's identity context (the manual-price routes are authenticated),
   * which the debounced timer captures.
   */
  private scheduleSnapshotRecalc(accountIds: string[], userId: string): void {
    // Also when no account holds the security: the manual price still changed
    // what a future valuation will say, and the per-account loop below would
    // invalidate nothing.
    invalidatePortfolioSummary(userId);
    for (const accountId of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
  }

  async createManualPrice(
    securityId: string,
    dto: CreateSecurityPriceDto,
    userId: string,
  ): Promise<SecurityPrice> {
    // Same shape as the quote path, and the same reason: read-then-insert on a
    // uniquely-keyed row turns a second submission -- a double-clicked Save, or a
    // manual entry landing on the same day the price cron just wrote -- into a
    // unique violation instead of an update.
    const { saved, accountIds } = await withScopedDb(
      this.dataSource,
      async (m) => {
        const rows: unknown = await m.query(
          `INSERT INTO security_prices
           (security_id, price_date, open_price, high_price, low_price,
            close_price, volume, source)
         VALUES ($1, $2::DATE, $3, $4, $5, $6, $7, 'manual')
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price  = COALESCE(EXCLUDED.open_price,  security_prices.open_price),
           high_price  = COALESCE(EXCLUDED.high_price,  security_prices.high_price),
           low_price   = COALESCE(EXCLUDED.low_price,   security_prices.low_price),
           volume      = COALESCE(EXCLUDED.volume,      security_prices.volume),
           -- A manual close written over the engine's row must not carry the
           -- engine's adjusted close along: its own input has none.
           adjusted_close = CASE WHEN security_prices.source = '${BOND_ENGINE_PRICE_SOURCE}'
                                 THEN NULL ELSE security_prices.adjusted_close END,
           source      = 'manual'
         RETURNING id`,
          [
            securityId,
            dto.priceDate,
            dto.openPrice ?? null,
            dto.highPrice ?? null,
            dto.lowPrice ?? null,
            dto.closePrice,
            dto.volume ?? null,
          ],
        );

        const id = returnedRows<{ id: number }>(rows)[0]?.id;
        const saved = id
          ? await m.getRepository(SecurityPrice).findOne({ where: { id } })
          : null;
        if (!saved) {
          throw new Error(
            `Failed to persist manual price for security ${securityId} on ${dto.priceDate}`,
          );
        }
        // Stale marker in the same transaction as the price write (see markHoldingAccountsDirty).
        const accountIds = await this.markHoldingAccountsDirty(
          m,
          securityId,
          userId,
        );
        return { saved, accountIds };
      },
    );

    this.scheduleSnapshotRecalc(accountIds, userId);
    return saved;
  }

  async updatePrice(
    securityId: string,
    priceId: number,
    dto: UpdateSecurityPriceDto,
    userId: string,
  ): Promise<SecurityPrice> {
    const price = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { id: priceId, securityId },
      }),
    );

    if (!price) {
      throw new NotFoundException(
        tr("errors.securities.priceNotFound", "Security price not found"),
      );
    }

    if (dto.closePrice !== undefined) price.closePrice = dto.closePrice;
    if (dto.openPrice !== undefined) price.openPrice = dto.openPrice;
    if (dto.highPrice !== undefined) price.highPrice = dto.highPrice;
    if (dto.lowPrice !== undefined) price.lowPrice = dto.lowPrice;
    if (dto.volume !== undefined) price.volume = dto.volume;
    if (dto.priceDate !== undefined) price.priceDate = dto.priceDate;
    // A manual correction of the engine's row keeps no adjusted close of its own.
    if (price.source === BOND_ENGINE_PRICE_SOURCE) price.adjustedClose = null;
    price.source = "manual";

    const { saved, accountIds } = await withScopedDb(
      this.dataSource,
      async (m) => {
        const saved = await m.getRepository(SecurityPrice).save(price);
        // Stale marker in the same transaction as the price write (see markHoldingAccountsDirty).
        const accountIds = await this.markHoldingAccountsDirty(
          m,
          securityId,
          userId,
        );
        return { saved, accountIds };
      },
    );
    this.scheduleSnapshotRecalc(accountIds, userId);
    return saved;
  }

  async deletePrice(
    securityId: string,
    priceId: number,
    userId: string,
  ): Promise<void> {
    const price = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { id: priceId, securityId },
      }),
    );

    if (!price) {
      throw new NotFoundException(
        tr("errors.securities.priceNotFound", "Security price not found"),
      );
    }

    const priceDate = price.priceDate;

    const accountIds = await withScopedDb(this.dataSource, async (m) => {
      await m.getRepository(SecurityPrice).remove(price);
      // Stale marker in the same transaction as the removal (see markHoldingAccountsDirty).
      return this.markHoldingAccountsDirty(m, securityId, userId);
    });

    // Restore a transaction-derived row for the freed date where one applies.
    // Its own write commits separately; the updated_at marker above already
    // covers the recompute, so a failure here only loses the fallback row.
    await this.upsertTransactionPrice(securityId, priceDate).catch((err) =>
      this.logger.warn(
        `Failed to backfill transaction price after deletion: ${err.message}`,
      ),
    );

    // Both the removed manual row and any transaction-derived row restored in
    // its place change the accepted close, so recompute the holding accounts.
    this.scheduleSnapshotRecalc(accountIds, userId);
  }
}
